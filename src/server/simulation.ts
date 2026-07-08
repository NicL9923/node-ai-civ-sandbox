import type {
  AgentAction,
  AgentProfile,
  AmendmentProposal,
  ConstitutionVersion,
  Position,
  ProfileRevision,
  Simulation,
  SimulationEvent,
  Tile,
  WorldSnapshot
} from "../shared/types.js";
import type { AiProvider } from "./aiProvider.js";
import type { AppConfig } from "./config.js";
import type { EventBus } from "./eventBus.js";
import { newId, nowIso } from "./id.js";
import { createSeedSimulation } from "./seed.js";
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
      if (JSON.stringify(existing.config) !== JSON.stringify(this.config.simulation)) {
        existing.config = this.config.simulation;
        existing.updatedAt = nowIso();
        await this.store.upsertSimulation(existing);
      }
      return;
    }

    const seed = createSeedSimulation(this.config.simulationId, this.config.simulation);
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

    const seed = createSeedSimulation(this.config.simulationId, this.config.simulation);
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
      const actors = selectActors(activeAgents, simulation.turn, simulation.config.actorsPerTurn);
      const openProposals = proposals.filter((proposal) => proposal.status === "open");

      for (const actor of actors) {
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
        tile.terrain = action.terrain;
        tile.label = action.label;
        tile.changedByAgentId = actor.id;
        tile.changedAtTurn = simulation.turn;
        await this.store.upsertTiles([tile]);
        await this.recordEvent(simulation.id, simulation.turn, "tileChanged", `${actor.name} changed tile (${action.x}, ${action.y}) to ${action.terrain}.`, actor.id);
        break;
      }
      case "noop": {
        await this.recordEvent(simulation.id, simulation.turn, "agentActed", `${actor.name} waited: ${action.rationale}`, actor.id);
        break;
      }
    }

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
      } else {
        proposal.status = "failed";
        proposal.resolvedAt = nowIso();
        await this.recordEvent(simulation.id, simulation.turn, "proposalFailed", `Amendment failed: ${proposal.title}`, proposal.proposerAgentId, undefined, proposal.id);
      }

      await this.store.upsertProposal(proposal);
    }
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
      return undefined;
    }
    case "reflect":
    case "noop":
      return undefined;
  }
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
