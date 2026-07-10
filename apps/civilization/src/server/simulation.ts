import type {
  AgentAction,
  AgentProfile,
  AmendmentProposal,
  ConstitutionVersion,
  Election,
  Governance,
  GovernanceParamKey,
  GovernanceParams,
  Law,
  LawSpecInput,
  PolicyChange,
  Position,
  ProfileRevision,
  Simulation,
  SimulationEvent,
  Tile,
  Violation,
  WorldSnapshot
} from "../shared/types.js";
import type { AiProvider } from "./aiProvider.js";
import type { AppConfig } from "./config.js";
import type { EventBus } from "./eventBus.js";
import { newId, nowIso } from "./id.js";
import { createInitialGovernance, createSeedSimulation, isProductiveTerrain } from "./seed.js";
import type { SimulationStore } from "./store.js";
import { trackActionMetric } from "./telemetry.js";

export interface AgentCreateInput {
  id?: string;
  name: string;
  model: string;
  active?: boolean;
  position?: Position;
  voice?: string;
  corePrinciples?: string[];
  personalityTraits?: string[];
  beliefs?: string[];
  goals?: string[];
  memorySummaries?: string[];
}

export interface AgentUpdateInput {
  name?: string;
  model?: string;
  active?: boolean;
  position?: Position;
  voice?: string;
  corePrinciples?: string[];
  personalityTraits?: string[];
  beliefs?: string[];
  goals?: string[];
  memorySummaries?: string[];
}

export class SimulationEngine {
  private timer: NodeJS.Timeout | undefined;
  private advancing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SimulationStore,
    private readonly aiProvider: AiProvider,
    private readonly eventBus: EventBus
  ) {}

  async ensureSeeded(): Promise<void> {
    const existing = await this.store.getSimulation(this.config.simulationId);
    if (existing) {
      let dirty = false;
      if (JSON.stringify(existing.config) !== JSON.stringify(this.config.simulation)) {
        existing.config = this.config.simulation;
        dirty = true;
      }
      // Migration/safety guard: older sims (pre-governance) may lack governance state.
      if (!existing.governance) {
        existing.governance = createInitialGovernance(this.config.governanceDefaults);
        dirty = true;
      }
      if (dirty) {
        existing.updatedAt = nowIso();
        await this.store.upsertSimulation(existing);
      }
      return;
    }

    const seed = createSeedSimulation(this.config.simulationId, this.config.simulation, this.config.governanceDefaults);
    await this.store.upsertSimulation(seed.simulation);
    await this.store.upsertTiles(seed.tiles);
    await Promise.all(seed.agents.map((agent) => this.store.upsertAgent(agent)));
    await this.store.upsertConstitution(seed.constitution);
    await this.recordEvent(seed.simulation.id, 0, "simulationSeeded", "The civilization sandbox has been seeded.");
  }

  async start(): Promise<void> {
    await this.ensureSeeded();
    const simulation = await this.requiredSimulation();
    simulation.running = true;
    simulation.updatedAt = nowIso();
    await this.store.upsertSimulation(simulation);

    if (!this.timer) {
      this.timer = setInterval(() => {
        this.advanceTurn().catch((error: unknown) => {
          console.error("Turn advancement failed", error);
        });
      }, this.config.simulation.turnIntervalMs);
    }
  }

  async pause(): Promise<void> {
    const simulation = await this.requiredSimulation();
    simulation.running = false;
    simulation.updatedAt = nowIso();
    await this.store.upsertSimulation(simulation);
  }

  async reset(): Promise<void> {
    if (this.advancing) {
      throw new Error("Cannot reset while a turn is advancing. Try again after the current turn completes.");
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.store.deleteSimulationData(this.config.simulationId);

    const seed = createSeedSimulation(this.config.simulationId, this.config.simulation, this.config.governanceDefaults);
    await this.store.upsertSimulation(seed.simulation);
    await this.store.upsertTiles(seed.tiles);
    await Promise.all(seed.agents.map((agent) => this.store.upsertAgent(agent)));
    await this.store.upsertConstitution(seed.constitution);
    await this.recordEvent(seed.simulation.id, 0, "simulationSeeded", "The civilization sandbox has been reset and reseeded.");
  }

  async snapshot(): Promise<WorldSnapshot> {
    await this.ensureSeeded();
    const simulation = await this.requiredSimulation();
    const [tiles, agents, constitutions, proposals, recentEvents] = await Promise.all([
      this.store.listTiles(simulation.id),
      this.store.listAgents(simulation.id),
      this.store.listConstitutions(simulation.id),
      this.store.listProposals(simulation.id),
      this.store.listRecentEvents(simulation.id, 80)
    ]);

    const currentConstitution = constitutions[0];
    if (!currentConstitution) {
      throw new Error("Simulation has no constitution.");
    }

    return {
      simulation,
      tiles,
      agents,
      currentConstitution,
      constitutionHistory: constitutions,
      proposals,
      recentEvents
    };
  }

  supportedModels(): Record<string, string> {
    return this.config.ai.deployments;
  }

  async addAgent(input: AgentCreateInput): Promise<AgentProfile> {
    await this.ensureSeeded();
    const simulation = await this.requiredSimulation();
    const agents = await this.store.listAgents(simulation.id);
    const id = input.id?.trim() || newId("agent");
    if (agents.some((agent) => agent.id === id)) {
      throw new Error(`Agent id '${id}' already exists.`);
    }

    if (agents.some((agent) => agent.name.toLowerCase() === input.name.trim().toLowerCase())) {
      throw new Error(`Agent name '${input.name}' already exists.`);
    }

    const position = input.position ?? firstOpenPosition(simulation.config.worldSize, agents);
    validatePosition(simulation, position);

    const createdAt = nowIso();
    const agent: AgentProfile = {
      id,
      simulationId: simulation.id,
      name: input.name.trim(),
      model: input.model.trim(),
      active: input.active ?? true,
      position,
      resources: simulation.config.startResources,
      corePrinciples: input.corePrinciples ?? ["Learn before judging", "Preserve civic continuity"],
      personalityTraits: input.personalityTraits ?? ["newcomer", "curious"],
      beliefs: input.beliefs ?? ["I joined an existing society and should understand its history before changing it."],
      goals: input.goals ?? ["Understand the current constitution", "Build useful relationships"],
      memorySummaries: input.memorySummaries ?? [`I joined the civilization on turn ${simulation.turn}.`],
      voice: input.voice?.trim() || undefined,
      relationships: [],
      createdAt,
      updatedAt: createdAt
    };

    await this.store.upsertAgent(agent);
    await this.recordEvent(simulation.id, simulation.turn, "agentUpdated", `${agent.name} joined the civilization using ${agent.model}.`, agent.id);
    return agent;
  }

  async updateAgent(agentId: string, input: AgentUpdateInput): Promise<AgentProfile> {
    await this.ensureSeeded();
    const simulation = await this.requiredSimulation();
    const agents = await this.store.listAgents(simulation.id);
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' does not exist.`);
    }

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (agents.some((candidate) => candidate.id !== agentId && candidate.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Agent name '${name}' already exists.`);
      }
      agent.name = name;
    }

    if (input.model !== undefined) {
      agent.model = input.model.trim();
    }
    if (input.active !== undefined) {
      agent.active = input.active;
    }
    if (input.position !== undefined) {
      validatePosition(simulation, input.position);
      agent.position = input.position;
    }

    agent.corePrinciples = input.corePrinciples ?? agent.corePrinciples;
    agent.personalityTraits = input.personalityTraits ?? agent.personalityTraits;
    agent.beliefs = input.beliefs ?? agent.beliefs;
    agent.goals = input.goals ?? agent.goals;
    agent.memorySummaries = input.memorySummaries ?? agent.memorySummaries;
    if (input.voice !== undefined) {
      agent.voice = input.voice.trim() || undefined;
    }
    agent.updatedAt = nowIso();

    await this.store.upsertAgent(agent);
    await this.recordEvent(simulation.id, simulation.turn, "agentUpdated", `${agent.name} was updated by an administrator.`, agent.id, undefined, undefined, {
      model: agent.model,
      active: agent.active
    });
    return agent;
  }

  async advanceTurn(): Promise<void> {
    if (this.advancing) {
      return;
    }

    this.advancing = true;
    try {
      const simulation = await this.requiredSimulation();
      if (!simulation.running) {
        return;
      }

      const [agents, tiles, constitutions, proposals, recentEvents] = await Promise.all([
        this.store.listAgents(simulation.id),
        this.store.listTiles(simulation.id),
        this.store.listConstitutions(simulation.id),
        this.store.listProposals(simulation.id),
        this.store.listRecentEvents(simulation.id, 20)
      ]);

      const currentConstitution = constitutions[0];
      if (!currentConstitution) {
        throw new Error("Simulation has no constitution.");
      }

      const activeAgents = agents.filter((agent) => agent.active).sort((a, b) => a.id.localeCompare(b.id));

      // Governance housekeeping runs once per turn before agents act: regrow productive
      // tiles and open/resolve elections so the executive office is never inert.
      await this.regenerateTiles(simulation, tiles);
      await this.manageElections(simulation, activeAgents);

      const actors = selectActors(activeAgents, simulation.turn, simulation.config.actorsPerTurn);
      const openProposals = proposals.filter((proposal) => proposal.status === "open");

      for (const actor of actors) {
        await this.applyUpkeep(simulation, actor);

        const action = await this.decideActionWithFallback(
          simulation,
          actor,
          activeAgents,
          tiles,
          currentConstitution,
          openProposals,
          recentEvents.map((event) => event.message)
        );

        await this.applyAction(simulation, actor, action, activeAgents, tiles, openProposals, currentConstitution);
      }

      await this.resolveExpiredProposals(simulation, activeAgents, currentConstitution);

      simulation.turn += 1;
      simulation.updatedAt = nowIso();
      await this.store.upsertSimulation(simulation);
      await this.recordEvent(simulation.id, simulation.turn, "turnAdvanced", `Turn ${simulation.turn} advanced.`);
    } finally {
      this.advancing = false;
    }
  }

  private async decideActionWithFallback(
    simulation: Simulation,
    actor: AgentProfile,
    activeAgents: AgentProfile[],
    tiles: Tile[],
    currentConstitution: ConstitutionVersion,
    openProposals: AmendmentProposal[],
    recentEvents: string[]
  ): Promise<AgentAction> {
    try {
      return await withTimeout(
        this.aiProvider.decideAction({
          simulation,
          agent: actor,
          agents: activeAgents,
          tiles,
          currentConstitution,
          openProposals,
          recentEvents,
          turnsSinceConversation:
            simulation.lastConversationTurn === undefined ? simulation.turn : simulation.turn - simulation.lastConversationTurn
        }),
        25_000,
        `Timed out waiting for ${actor.name} (${actor.model}) to choose an action.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown AI decision failure.";
      await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} could not decide: ${message}`, actor.id, undefined, undefined, {
        model: actor.model
      });
      return {
        type: "noop",
        rationale: `AI decision failed for ${actor.model}; preserving turn progress.`
      };
    }
  }

  private async requiredSimulation(): Promise<Simulation> {
    const simulation = await this.store.getSimulation(this.config.simulationId);
    if (!simulation) {
      throw new Error(`Simulation ${this.config.simulationId} does not exist.`);
    }
    return simulation;
  }

  private async applyAction(
    simulation: Simulation,
    actor: AgentProfile,
    action: AgentAction,
    agents: AgentProfile[],
    tiles: Tile[],
    openProposals: AmendmentProposal[],
    currentConstitution: ConstitutionVersion
  ): Promise<void> {
    const rejection = validateAction(simulation, actor, action, agents, tiles, openProposals);
    if (rejection) {
      trackActionMetric(`rejected:${action.type}`);
      await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name}: ${rejection}`, actor.id, undefined, undefined, {
        action
      });
      return;
    }

    trackActionMetric(action.type);

    // Maintain converse-throttling state so pure talk loops break.
    if (action.type === "converse") {
      actor.consecutiveConverses = (actor.consecutiveConverses ?? 0) + 1;
      actor.lastConversedWith = action.targetAgentId;
      simulation.lastConversationTurn = simulation.turn;
    } else {
      actor.consecutiveConverses = 0;
      actor.lastConversedWith = undefined;
    }
    actor.lastActionType = action.type;

    switch (action.type) {
      case "move": {
        actor.position = {
          x: actor.position.x + action.dx,
          y: actor.position.y + action.dy
        };
        await this.touchAgent(simulation, actor, `Moved to (${actor.position.x}, ${actor.position.y}).`);
        break;
      }
      case "converse": {
        const target = agents.find((agent) => agent.id === action.targetAgentId);
        await this.recordEvent(
          simulation.id,
          simulation.turn,
          "conversation",
          `${actor.name} to ${target?.name ?? action.targetAgentId}: ${action.message}`,
          actor.id,
          action.targetAgentId
        );
        actor.memorySummaries = capList([...actor.memorySummaries, `I told ${target?.name ?? "another citizen"}: ${action.message}`], 12);
        await this.touchAgent(simulation, actor, "Conversation recorded.");
        break;
      }
      case "reflect": {
        actor.memorySummaries = capList([...actor.memorySummaries, action.memory], 12);
        await this.touchAgent(simulation, actor, action.memory);
        break;
      }
      case "proposeAmendment": {
        actor.resources = Math.max(0, actor.resources - simulation.governance.params.proposalCost);
        const proposal: AmendmentProposal = {
          id: newId("proposal"),
          simulationId: simulation.id,
          title: action.title,
          proposedText: action.proposedText,
          rationale: action.rationale,
          proposerAgentId: actor.id,
          status: "open",
          changeType: action.changeType ?? "add",
          targetReference: action.targetReference,
          policyChange: action.policyChange,
          enactLaw: action.enactLaw,
          openedTurn: simulation.turn,
          closesTurn: simulation.turn + simulation.config.proposalVotingWindowTurns,
          votes: [],
          createdAt: nowIso()
        };
        await this.store.upsertProposal(proposal);
        openProposals.push(proposal);
        const kindLabel = (action.changeType ?? "add") === "add" ? "proposed" : `proposed to ${action.changeType}${action.targetReference ? ` ${action.targetReference}` : ""} via`;
        await this.recordEvent(simulation.id, simulation.turn, "proposalOpened", `${actor.name} ${kindLabel}: ${proposal.title}`, actor.id, undefined, proposal.id);
        break;
      }
      case "vote": {
        const proposal = openProposals.find((candidate) => candidate.id === action.proposalId);
        if (!proposal) {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to vote on a missing proposal.`, actor.id);
          return;
        }
        proposal.votes.push({
          agentId: actor.id,
          choice: action.choice,
          rationale: action.rationale,
          turn: simulation.turn
        });
        await this.store.upsertProposal(proposal);
        await this.recordEvent(simulation.id, simulation.turn, "voteCast", `${actor.name} voted ${action.choice} on ${proposal.title}.`, actor.id, undefined, proposal.id);
        break;
      }
      case "changeTile": {
        const tile = tiles.find((candidate) => candidate.position.x === action.x && candidate.position.y === action.y);
        if (!tile) {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to change a missing tile.`, actor.id);
          return;
        }
        actor.resources = Math.max(0, actor.resources - simulation.governance.params.changeTileCost);
        tile.terrain = action.terrain;
        tile.label = action.label;
        tile.changedByAgentId = actor.id;
        tile.changedAtTurn = simulation.turn;
        if (isProductiveTerrain(action.terrain)) {
          tile.maxProductivity = simulation.config.tileMaxProductivity;
          tile.productivity = simulation.config.tileMaxProductivity;
        } else {
          tile.maxProductivity = 0;
          tile.productivity = 0;
        }
        await this.store.upsertTiles([tile]);
        await this.recordEvent(simulation.id, simulation.turn, "tileChanged", `${actor.name} changed tile (${action.x}, ${action.y}) to ${action.terrain}.`, actor.id);
        break;
      }
      case "gather": {
        const tile = tiles.find((candidate) => candidate.position.x === actor.position.x && candidate.position.y === actor.position.y);
        const hasYield = tile !== undefined && isProductiveTerrain(tile.terrain) && (tile.productivity ?? 0) > 0;
        const yieldAmount = hasYield ? simulation.config.gatherYield : simulation.config.gatherBase;
        actor.resources += yieldAmount;
        if (hasYield && tile) {
          tile.productivity = Math.max(0, (tile.productivity ?? 0) - simulation.config.gatherYield);
          await this.store.upsertTiles([tile]);
        }
        const where = tile && isProductiveTerrain(tile.terrain) ? tile.terrain : "the land";
        await this.recordEvent(simulation.id, simulation.turn, "resourcesGathered", `${actor.name} gathered ${yieldAmount} from ${where} (now ${actor.resources}).`, actor.id);
        break;
      }
      case "transfer": {
        const target = agents.find((agent) => agent.id === action.targetAgentId);
        if (!target) {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to transfer to a missing citizen.`, actor.id);
          return;
        }
        const amount = Math.min(action.amount, actor.resources);
        actor.resources -= amount;
        target.resources += amount;
        target.updatedAt = nowIso();
        await this.store.upsertAgent(target);
        await this.recordEvent(simulation.id, simulation.turn, "resourcesTransferred", `${actor.name} gave ${amount} to ${target.name}.`, actor.id, target.id);
        break;
      }
      case "runForOffice": {
        const election = simulation.governance.election;
        if (!election || election.status !== "open") {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to run with no election open.`, actor.id);
          return;
        }
        election.candidates.push({ agentId: actor.id, platform: action.platform, declaredTurn: simulation.turn });
        await this.recordEvent(simulation.id, simulation.turn, "candidacyDeclared", `${actor.name} is running for President: ${action.platform}`, actor.id);
        break;
      }
      case "voteForPresident": {
        const election = simulation.governance.election;
        if (!election || election.status !== "open") {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to cast a ballot with no election open.`, actor.id);
          return;
        }
        const candidate = agents.find((agent) => agent.id === action.candidateAgentId);
        election.ballots.push({ voterId: actor.id, candidateId: action.candidateAgentId, turn: simulation.turn });
        await this.recordEvent(simulation.id, simulation.turn, "ballotCast", `${actor.name} cast a presidential ballot for ${candidate?.name ?? action.candidateAgentId}.`, actor.id, action.candidateAgentId);
        break;
      }
      case "tax": {
        const perAgent = Math.min(action.amount, simulation.governance.params.taxCapPerAction);
        let collected = 0;
        for (const citizen of agents) {
          if (citizen.id === actor.id) {
            continue;
          }
          const paid = Math.min(perAgent, citizen.resources);
          if (paid > 0) {
            citizen.resources -= paid;
            citizen.updatedAt = nowIso();
            await this.store.upsertAgent(citizen);
            collected += paid;
          }
        }
        simulation.governance.treasury += collected;
        await this.recordEvent(simulation.id, simulation.turn, "taxCollected", `President ${actor.name} taxed ${perAgent}/citizen, collecting ${collected} (treasury ${simulation.governance.treasury}).`, actor.id);
        break;
      }
      case "spend": {
        const amount = Math.min(action.amount, simulation.governance.treasury);
        if (amount <= 0) {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to spend from an empty treasury.`, actor.id);
          return;
        }
        if (action.targetAgentId) {
          const target = agents.find((agent) => agent.id === action.targetAgentId);
          if (!target) {
            await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to fund a missing citizen.`, actor.id);
            return;
          }
          simulation.governance.treasury -= amount;
          target.resources += amount;
          target.updatedAt = nowIso();
          await this.store.upsertAgent(target);
          await this.recordEvent(simulation.id, simulation.turn, "treasurySpent", `President ${actor.name} granted ${amount} from the treasury to ${target.name}.`, actor.id, target.id);
        } else {
          const tile = tiles.find((candidate) => candidate.position.x === action.x && candidate.position.y === action.y);
          if (!tile || !isProductiveTerrain(tile.terrain)) {
            await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried a public work on a non-productive tile.`, actor.id);
            return;
          }
          simulation.governance.treasury -= amount;
          const newMax = (tile.maxProductivity ?? simulation.config.tileMaxProductivity) + amount;
          tile.maxProductivity = newMax;
          tile.productivity = Math.min(newMax, (tile.productivity ?? 0) + amount);
          await this.store.upsertTiles([tile]);
          await this.recordEvent(simulation.id, simulation.turn, "treasurySpent", `President ${actor.name} funded public works on (${tile.position.x}, ${tile.position.y}), spending ${amount}.`, actor.id);
        }
        break;
      }
      case "fine": {
        const target = agents.find((agent) => agent.id === action.targetAgentId);
        if (!target) {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to fine a missing citizen.`, actor.id);
          return;
        }
        const amount = Math.min(action.amount, simulation.governance.params.fineMax, target.resources);
        target.resources = Math.max(0, target.resources - amount);
        target.updatedAt = nowIso();
        await this.store.upsertAgent(target);
        simulation.governance.treasury += amount;
        if (action.violationId) {
          const violation = simulation.governance.violations.find((candidate) => candidate.id === action.violationId);
          if (violation && violation.status === "pending") {
            violation.status = "fined";
            violation.resolvedTurn = simulation.turn;
            violation.resolvedByAgentId = actor.id;
            violation.fineAmount = amount;
          }
        }
        await this.recordEvent(simulation.id, simulation.turn, "fineIssued", `President ${actor.name} fined ${target.name} ${amount}: ${action.reason}`, actor.id, target.id);
        break;
      }
      case "pardon": {
        const violation = simulation.governance.violations.find((candidate) => candidate.id === action.violationId);
        if (!violation || violation.status !== "pending") {
          await this.recordEvent(simulation.id, simulation.turn, "actionRejected", `${actor.name} tried to pardon a resolved or missing violation.`, actor.id);
          return;
        }
        violation.status = "pardoned";
        violation.resolvedTurn = simulation.turn;
        violation.resolvedByAgentId = actor.id;
        const offender = agents.find((agent) => agent.id === violation.agentId);
        await this.recordEvent(simulation.id, simulation.turn, "pardonIssued", `President ${actor.name} pardoned ${offender?.name ?? violation.agentId} for breaking "${violation.lawTitle}".`, actor.id, violation.agentId);
        break;
      }
      case "decree": {
        const law = this.buildLaw(action.law, "decree", actor.id, simulation.turn);
        simulation.governance.laws.push(law);
        await this.recordEvent(simulation.id, simulation.turn, "decreeIssued", `President ${actor.name} decreed "${law.title}": ${law.description}`, actor.id);
        break;
      }
      case "noop": {
        await this.recordEvent(simulation.id, simulation.turn, "agentActed", `${actor.name} waited: ${action.rationale}`, actor.id);
        break;
      }
    }

    await this.detectViolations(simulation, actor, action);

    if (action.selfRevision) {
      await this.applySelfRevision(simulation, actor, action.selfRevision);
    }

    if (action.type !== "move" && action.type !== "reflect" && action.type !== "converse") {
      actor.memorySummaries = capList([...actor.memorySummaries, `Turn ${simulation.turn}: ${action.rationale}`], 12);
      await this.touchAgent(simulation, actor, `${actor.name} acted under the current constitution v${currentConstitution.version}.`);
    }
  }

  private async applySelfRevision(simulation: Simulation, agent: AgentProfile, revision: ProfileRevision): Promise<void> {
    const changes: string[] = [];

    changes.push(...reviseList(agent.corePrinciples, revision.principlesToAdd, revision.principlesToRetire, 8, "principle"));
    changes.push(...reviseList(agent.personalityTraits, revision.traitsToAdd, revision.traitsToRetire, 10, "trait"));
    changes.push(...reviseList(agent.beliefs, revision.beliefsToAdd, revision.beliefsToRetire, 10, "belief"));
    changes.push(...reviseList(agent.goals, revision.goalsToAdd, revision.goalsToRetire, 8, "goal"));

    if (revision.memoryToAdd) {
      agent.memorySummaries = capList([...agent.memorySummaries, revision.memoryToAdd], 12);
      changes.push("added a memory");
    }

    if (changes.length === 0) {
      return;
    }

    agent.updatedAt = nowIso();
    await this.store.upsertAgent(agent);
    await this.recordEvent(
      simulation.id,
      simulation.turn,
      "agentUpdated",
      `${agent.name} revised ${joinHuman(changes)}${revision.rationale ? `: ${revision.rationale}` : "."}`,
      agent.id,
      undefined,
      undefined,
      {
        selfRevision: revision
      }
    );
  }

  private async resolveExpiredProposals(simulation: Simulation, activeAgents: AgentProfile[], currentConstitution: ConstitutionVersion): Promise<void> {
    const proposals = await this.store.listProposals(simulation.id);
    for (const proposal of proposals.filter((candidate) => candidate.status === "open" && candidate.closesTurn <= simulation.turn)) {
      const votesCast = proposal.votes.filter((vote) => vote.choice !== "abstain").length;
      const yesVotes = proposal.votes.filter((vote) => vote.choice === "yes").length;
      const quorumMet = proposal.votes.length >= Math.ceil(activeAgents.length * simulation.config.quorumRatio);
      const supermajorityMet = votesCast > 0 && yesVotes / votesCast >= simulation.config.supermajorityRatio;

      if (quorumMet && supermajorityMet) {
        proposal.status = "passed";
        proposal.resolvedAt = nowIso();
        const nextVersion: ConstitutionVersion = {
          id: newId("constitution"),
          simulationId: simulation.id,
          version: currentConstitution.version + 1,
          amendmentProposalId: proposal.id,
          text: `${currentConstitution.text}\n\n${formatAmendmentEntry(currentConstitution.version, proposal)}`,
          createdAtTurn: simulation.turn,
          createdAt: nowIso()
        };
        await this.store.upsertConstitution(nextVersion);
        await this.recordEvent(simulation.id, simulation.turn, "constitutionAmended", `Amendment passed: ${proposal.title}`, proposal.proposerAgentId, undefined, proposal.id);

        // Constitution with teeth: a passed amendment can alter governable parameters
        // (President term/powers, economic costs) and/or enact a structured law.
        if (proposal.policyChange) {
          const applied = applyPolicyChange(simulation.governance.params, proposal.policyChange);
          if (applied) {
            await this.recordEvent(simulation.id, simulation.turn, "policyChanged", `Amendment set ${applied.param} to ${applied.value}.`, proposal.proposerAgentId, undefined, proposal.id);
          }
        }
        if (proposal.enactLaw) {
          const law = this.buildLaw(proposal.enactLaw, "amendment", proposal.proposerAgentId, simulation.turn, proposal.id);
          simulation.governance.laws.push(law);
          await this.recordEvent(simulation.id, simulation.turn, "lawEnacted", `Amendment enacted law "${law.title}": ${law.description}`, proposal.proposerAgentId, undefined, proposal.id);
        }
      } else {
        proposal.status = "failed";
        proposal.resolvedAt = nowIso();
        await this.recordEvent(simulation.id, simulation.turn, "proposalFailed", `Amendment failed: ${proposal.title}`, proposal.proposerAgentId, undefined, proposal.id);
      }

      await this.store.upsertProposal(proposal);
    }
  }

  private async applyUpkeep(simulation: Simulation, actor: AgentProfile): Promise<void> {
    const upkeep = simulation.config.upkeepPerAction;
    if (upkeep <= 0) {
      return;
    }
    const next = Math.max(0, actor.resources - upkeep);
    if (next !== actor.resources) {
      actor.resources = next;
      actor.updatedAt = nowIso();
      await this.store.upsertAgent(actor);
    }
  }

  private async regenerateTiles(simulation: Simulation, tiles: Tile[]): Promise<void> {
    if (simulation.config.tileRegenInterval <= 0 || simulation.turn % simulation.config.tileRegenInterval !== 0) {
      return;
    }
    const changed: Tile[] = [];
    for (const tile of tiles) {
      if (!isProductiveTerrain(tile.terrain)) {
        continue;
      }
      const max = tile.maxProductivity ?? simulation.config.tileMaxProductivity;
      const current = tile.productivity ?? 0;
      if (current < max) {
        tile.productivity = Math.min(max, current + 1);
        changed.push(tile);
      }
    }
    if (changed.length > 0) {
      await this.store.upsertTiles(changed);
    }
  }

  private async manageElections(simulation: Simulation, activeAgents: AgentProfile[]): Promise<void> {
    const governance = simulation.governance;
    const election = governance.election;

    if (election && election.status === "open") {
      if (simulation.turn >= election.closesTurn) {
        await this.resolveElection(simulation, activeAgents, election);
      }
      return;
    }

    const president = governance.president;
    const termExpired = president !== undefined && simulation.turn - president.termStartedTurn >= governance.params.presidentTermTurns;
    if (activeAgents.length > 0 && (president === undefined || termExpired)) {
      governance.election = {
        id: newId("election"),
        openedTurn: simulation.turn,
        closesTurn: simulation.turn + simulation.config.electionWindowTurns,
        candidates: [],
        ballots: [],
        status: "open"
      };
      const reason = president === undefined ? "The office is vacant." : `${president.agentId}'s term has ended.`;
      await this.recordEvent(simulation.id, simulation.turn, "electionOpened", `A presidential election has opened. ${reason} Citizens may run for office and cast ballots before turn ${governance.election.closesTurn}.`);
    }
  }

  private async resolveElection(simulation: Simulation, activeAgents: AgentProfile[], election: Election): Promise<void> {
    const governance = simulation.governance;
    const activeIds = new Set(activeAgents.map((agent) => agent.id));

    const tally = new Map<string, number>();
    for (const ballot of election.ballots) {
      if (!activeIds.has(ballot.candidateId)) {
        continue;
      }
      tally.set(ballot.candidateId, (tally.get(ballot.candidateId) ?? 0) + 1);
    }

    const candidateIds = election.candidates.map((candidate) => candidate.agentId).filter((id) => activeIds.has(id));
    const incumbentId = governance.president?.agentId;

    // Winner selection with caretaker fallbacks so the office is never left inert.
    let winnerId: string | undefined;
    const pool = candidateIds.length > 0 ? candidateIds : [...tally.keys()];
    if (pool.length > 0) {
      winnerId = pool
        .slice()
        .sort((a, b) => {
          const diff = (tally.get(b) ?? 0) - (tally.get(a) ?? 0);
          if (diff !== 0) {
            return diff;
          }
          if (a === incumbentId) {
            return -1;
          }
          if (b === incumbentId) {
            return 1;
          }
          return a.localeCompare(b);
        })[0];
    }
    if (!winnerId) {
      winnerId = incumbentId && activeIds.has(incumbentId)
        ? incumbentId
        : activeAgents.slice().sort((a, b) => b.resources - a.resources || a.id.localeCompare(b.id))[0]?.id;
    }

    election.status = "closed";
    election.winnerAgentId = winnerId;

    if (winnerId) {
      const platform = election.candidates.find((candidate) => candidate.agentId === winnerId)?.platform;
      governance.president = {
        agentId: winnerId,
        termStartedTurn: simulation.turn,
        termNumber: (governance.president?.termNumber ?? 0) + 1,
        platform
      };
      const winner = activeAgents.find((agent) => agent.id === winnerId);
      const votes = tally.get(winnerId) ?? 0;
      await this.recordEvent(simulation.id, simulation.turn, "presidentElected", `${winner?.name ?? winnerId} is President (term ${governance.president.termNumber}, ${votes} ballots).`, winnerId);
    }
  }

  private async detectViolations(simulation: Simulation, actor: AgentProfile, action: AgentAction): Promise<void> {
    const prohibitions = simulation.governance.laws.filter((law) => law.active && law.type === "prohibition" && law.forbiddenAction === action.type);
    for (const law of prohibitions) {
      const violation: Violation = {
        id: newId("violation"),
        agentId: actor.id,
        lawId: law.id,
        lawTitle: law.title,
        turn: simulation.turn,
        status: "pending"
      };
      simulation.governance.violations.push(violation);
      simulation.governance.violations = capList(simulation.governance.violations, 60);
      await this.recordEvent(simulation.id, simulation.turn, "violationRecorded", `${actor.name} broke "${law.title}" by choosing ${action.type}.`, actor.id, undefined, undefined, { lawId: law.id });
    }
  }

  private buildLaw(spec: LawSpecInput, source: Law["source"], enactedByAgentId: string, turn: number, sourceRef?: string): Law {
    return {
      id: newId("law"),
      type: spec.lawType,
      title: spec.title,
      description: spec.description,
      forbiddenAction: spec.forbiddenAction,
      amount: spec.amount,
      source,
      sourceRef,
      enactedByAgentId,
      createdTurn: turn,
      active: true
    };
  }

  private async touchAgent(simulation: Simulation, agent: AgentProfile, message: string): Promise<void> {
    agent.lastActedTurn = simulation.turn;
    agent.updatedAt = nowIso();
    agent.memorySummaries = capList(agent.memorySummaries, 12);
    await this.store.upsertAgent(agent);
    await this.recordEvent(simulation.id, simulation.turn, "agentUpdated", `${agent.name}: ${message}`, agent.id);
  }

  private async recordEvent(
    simulationId: string,
    turn: number,
    type: SimulationEvent["type"],
    message: string,
    agentId?: string,
    targetAgentId?: string,
    proposalId?: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    const event: SimulationEvent = {
      id: newId("event"),
      simulationId,
      turn,
      type,
      message,
      agentId,
      targetAgentId,
      proposalId,
      payload,
      createdAt: nowIso()
    };
    await this.store.appendEvent(event);
    this.eventBus.publish(event);
  }
}

function formatAmendmentEntry(priorVersion: number, proposal: AmendmentProposal): string {
  const changeType = proposal.changeType ?? "add";
  const target = proposal.targetReference ? ` ${proposal.targetReference}` : "";
  if (changeType === "repeal") {
    return `Amendment ${priorVersion} (repeal of${target || " a prior provision"}): ${proposal.proposedText}`;
  }
  if (changeType === "revise") {
    return `Amendment ${priorVersion} (revision of${target || " a prior provision"}): ${proposal.proposedText}`;
  }
  return `Amendment ${priorVersion}: ${proposal.proposedText}`;
}

function selectActors(agents: AgentProfile[], turn: number, count: number): AgentProfile[] {
  if (agents.length === 0) {
    return [];
  }
  if (count === 1) {
    const lastActor = agents
      .filter((agent) => agent.lastActedTurn !== undefined)
      .sort((a, b) => (b.lastActedTurn ?? -1) - (a.lastActedTurn ?? -1))[0];

    for (let offset = 0; offset < agents.length; offset += 1) {
      const actor = agents[(turn + offset) % agents.length];
      if (actor && (!lastActor || actor.model !== lastActor.model)) {
        return [actor];
      }
    }
  }

  const actors: AgentProfile[] = [];
  for (let i = 0; i < Math.min(count, agents.length); i += 1) {
    const actor = agents[(turn * count + i) % agents.length];
    if (actor) {
      actors.push(actor);
    }
  }
  return actors;
}

export function validateAction(
  simulation: Simulation,
  actor: AgentProfile,
  action: AgentAction,
  agents: AgentProfile[],
  tiles: Tile[],
  openProposals: AmendmentProposal[]
): string | undefined {
  switch (action.type) {
    case "move": {
      if (action.dx === 0 && action.dy === 0) {
        return "move action must change position";
      }
      const x = actor.position.x + action.dx;
      const y = actor.position.y + action.dy;
      if (!isInside(simulation.config.worldSize, x, y)) {
        return "move would leave the world bounds";
      }
      return undefined;
    }
    case "converse": {
      if (action.targetAgentId === actor.id) {
        return "agent cannot converse with itself";
      }
      const target = agents.find((agent) => agent.id === action.targetAgentId && agent.active);
      if (!target) {
        return "target agent is not active";
      }
      if (distance(actor.position, target.position) > 4) {
        return "target agent is too far away to converse";
      }
      if (actor.lastActionType === "converse" && actor.lastConversedWith === action.targetAgentId) {
        return "cannot converse with the same agent on consecutive actions";
      }
      if ((actor.consecutiveConverses ?? 0) >= simulation.config.maxConsecutiveConverses) {
        return "must take a non-conversation action after repeated talking";
      }
      return undefined;
    }
    case "proposeAmendment": {
      if (openProposals.length >= 3) {
        return "too many open proposals";
      }
      if (actor.resources < simulation.governance.params.proposalCost) {
        return "cannot afford the proposal cost";
      }
      if (action.enactLaw?.lawType === "prohibition" && !action.enactLaw.forbiddenAction) {
        return "a prohibition law must name a forbiddenAction";
      }
      return undefined;
    }
    case "vote": {
      const proposal = openProposals.find((candidate) => candidate.id === action.proposalId);
      if (!proposal) {
        return "proposal is not open";
      }
      if (proposal.votes.some((vote) => vote.agentId === actor.id)) {
        return "agent has already voted on this proposal";
      }
      return undefined;
    }
    case "changeTile": {
      if (!isInside(simulation.config.worldSize, action.x, action.y)) {
        return "tile is outside world bounds";
      }
      if (Math.abs(actor.position.x - action.x) > 1 || Math.abs(actor.position.y - action.y) > 1) {
        return "agent can only change adjacent or current tiles";
      }
      if (!tiles.some((tile) => tile.position.x === action.x && tile.position.y === action.y)) {
        return "tile does not exist";
      }
      if (actor.resources < simulation.governance.params.changeTileCost) {
        return "cannot afford to change a tile";
      }
      return undefined;
    }
    case "gather": {
      return undefined;
    }
    case "transfer": {
      if (action.targetAgentId === actor.id) {
        return "cannot transfer to yourself";
      }
      const target = agents.find((agent) => agent.id === action.targetAgentId && agent.active);
      if (!target) {
        return "transfer target is not active";
      }
      if (actor.resources < action.amount) {
        return "insufficient resources to transfer";
      }
      return undefined;
    }
    case "runForOffice": {
      const election = simulation.governance.election;
      if (!election || election.status !== "open") {
        return "no election is currently open";
      }
      if (election.candidates.some((candidate) => candidate.agentId === actor.id)) {
        return "already a declared candidate";
      }
      return undefined;
    }
    case "voteForPresident": {
      const election = simulation.governance.election;
      if (!election || election.status !== "open") {
        return "no election is currently open";
      }
      if (!agents.some((agent) => agent.id === action.candidateAgentId && agent.active)) {
        return "candidate is not an active citizen";
      }
      if (election.ballots.some((ballot) => ballot.voterId === actor.id)) {
        return "already cast a presidential ballot this election";
      }
      return undefined;
    }
    case "tax": {
      const gate = requirePresidentPower(simulation, actor, "presidentCanTax", "tax");
      if (gate) {
        return gate;
      }
      return undefined;
    }
    case "spend": {
      const gate = requirePresidentPower(simulation, actor, "presidentCanSpend", "spend from the treasury");
      if (gate) {
        return gate;
      }
      if (simulation.governance.treasury <= 0) {
        return "the treasury is empty";
      }
      if (!action.targetAgentId && (action.x === undefined || action.y === undefined)) {
        return "spend must target a citizen or a tile";
      }
      return undefined;
    }
    case "fine": {
      const gate = requirePresidentPower(simulation, actor, "presidentCanFine", "issue fines");
      if (gate) {
        return gate;
      }
      if (!agents.some((agent) => agent.id === action.targetAgentId)) {
        return "cannot fine a missing citizen";
      }
      return undefined;
    }
    case "pardon": {
      const gate = requirePresidentPower(simulation, actor, "presidentCanPardon", "issue pardons");
      if (gate) {
        return gate;
      }
      if (!simulation.governance.violations.some((violation) => violation.id === action.violationId && violation.status === "pending")) {
        return "no pending violation with that id";
      }
      return undefined;
    }
    case "decree": {
      const gate = requirePresidentPower(simulation, actor, "presidentCanDecree", "issue decrees");
      if (gate) {
        return gate;
      }
      if (action.law.lawType === "prohibition" && !action.law.forbiddenAction) {
        return "a prohibition decree must name a forbiddenAction";
      }
      return undefined;
    }
    case "reflect":
    case "noop":
      return undefined;
  }
}

function requirePresidentPower(
  simulation: Simulation,
  actor: AgentProfile,
  power: "presidentCanTax" | "presidentCanSpend" | "presidentCanFine" | "presidentCanPardon" | "presidentCanDecree",
  label: string
): string | undefined {
  if (simulation.governance.president?.agentId !== actor.id) {
    return `only the President may ${label}`;
  }
  if (!simulation.governance.params[power]) {
    return `the constitution does not grant the President power to ${label}`;
  }
  return undefined;
}

const NUMERIC_PARAM_BOUNDS: Partial<Record<GovernanceParamKey, { min: number; max: number }>> = {
  presidentTermTurns: { min: 10, max: 200 },
  taxCapPerAction: { min: 0, max: 30 },
  fineMax: { min: 0, max: 50 },
  proposalCost: { min: 0, max: 20 },
  changeTileCost: { min: 0, max: 20 }
};

const BOOLEAN_PARAMS = new Set<GovernanceParamKey>([
  "presidentCanTax",
  "presidentCanSpend",
  "presidentCanFine",
  "presidentCanPardon",
  "presidentCanDecree"
]);

function applyPolicyChange(params: GovernanceParams, change: PolicyChange): { param: GovernanceParamKey; value: number | boolean } | undefined {
  const { param, value } = change;
  const target = params as Record<GovernanceParamKey, number | boolean>;

  if (BOOLEAN_PARAMS.has(param)) {
    const boolValue = typeof value === "boolean" ? value : value !== 0;
    target[param] = boolValue;
    return { param, value: boolValue };
  }

  const bounds = NUMERIC_PARAM_BOUNDS[param];
  if (!bounds) {
    return undefined;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  const clamped = Math.round(Math.min(bounds.max, Math.max(bounds.min, num)));
  target[param] = clamped;
  return { param, value: clamped };
}

function isInside(worldSize: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < worldSize && y < worldSize;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function capList<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function reviseList(target: string[], additions: string[] | undefined, retirements: string[] | undefined, limit: number, label: string): string[] {
  const changes: string[] = [];

  for (const retired of retirements ?? []) {
    const index = target.findIndex((item) => item.localeCompare(retired, undefined, { sensitivity: "accent" }) === 0);
    if (index >= 0) {
      target.splice(index, 1);
      changes.push(`retired ${label} "${retired}"`);
    }
  }

  for (const addition of additions ?? []) {
    const normalizedAddition = addition.trim();
    if (!normalizedAddition || target.some((item) => item.localeCompare(normalizedAddition, undefined, { sensitivity: "accent" }) === 0)) {
      continue;
    }

    target.push(normalizedAddition);
    changes.push(`added ${label} "${normalizedAddition}"`);
  }

  while (target.length > limit) {
    const removed = target.shift();
    if (removed) {
      changes.push(`outgrew older ${label} "${removed}"`);
    }
  }

  return changes;
}

function joinHuman(items: string[]): string {
  if (items.length === 1) {
    return items[0]!;
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function validatePosition(simulation: Simulation, position: Position): void {
  if (!isInside(simulation.config.worldSize, position.x, position.y)) {
    throw new Error(`Position (${position.x}, ${position.y}) is outside world bounds.`);
  }
}

function firstOpenPosition(worldSize: number, agents: AgentProfile[]): Position {
  const occupied = new Set(agents.map((agent) => `${agent.position.x}:${agent.position.y}`));
  for (let y = 0; y < worldSize; y += 1) {
    for (let x = 0; x < worldSize; x += 1) {
      if (!occupied.has(`${x}:${y}`)) {
        return { x, y };
      }
    }
  }
  throw new Error("No open position is available for a new agent.");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
