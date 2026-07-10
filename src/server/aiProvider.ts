import { DefaultAzureCredential } from "@azure/identity";
import type { AccessToken, TokenCredential } from "@azure/core-auth";
import type { AgentAction, AgentProfile, AmendmentProposal, ConstitutionVersion, ModelKey, Simulation, Tile } from "../shared/types.js";
import { parseAgentAction } from "./actionSchema.js";
import type { AppConfig } from "./config.js";

export interface DecisionContext {
  simulation: Simulation;
  agent: AgentProfile;
  agents: AgentProfile[];
  tiles: Tile[];
  currentConstitution: ConstitutionVersion;
  openProposals: AmendmentProposal[];
  recentEvents: string[];
  turnsSinceConversation?: number;
}

export interface AiProvider {
  decideAction(context: DecisionContext): Promise<AgentAction>;
}

export class MockAiProvider implements AiProvider {
  async decideAction(context: DecisionContext): Promise<AgentAction> {
    const governance = context.simulation.governance;

    // During an open election, participate so the executive layer exercises end-to-end.
    const election = governance.election?.status === "open" ? governance.election : undefined;
    if (election) {
      if (context.simulation.turn % 2 === 0 && !election.candidates.some((candidate) => candidate.agentId === context.agent.id)) {
        return {
          type: "runForOffice",
          platform: "Steady hands, fair share of the treasury.",
          rationale: "Someone reliable should hold the office."
        };
      }
      if (!election.ballots.some((ballot) => ballot.voterId === context.agent.id)) {
        const candidate = election.candidates[0]?.agentId ?? context.agents.find((agent) => agent.id !== context.agent.id)?.id;
        if (candidate) {
          return { type: "voteForPresident", candidateAgentId: candidate, rationale: "Backing a workable candidate." };
        }
      }
    }

    // Gather when low so the economy has positive flow.
    if (context.agent.resources <= Math.max(2, governance.params.proposalCost)) {
      return { type: "gather", rationale: "Building up resources before spending on anything." };
    }

    const openProposal = context.openProposals.find((proposal) => !proposal.votes.some((vote) => vote.agentId === context.agent.id));
    if (openProposal) {
      return {
        type: "vote",
        proposalId: openProposal.id,
        choice: context.agent.corePrinciples.length % 2 === 0 ? "yes" : "abstain",
        rationale: "The proposal appears compatible with my current principles."
      };
    }

    if (context.simulation.turn > 0 && context.simulation.turn % 9 === 0) {
      return {
        type: "proposeAmendment",
        title: "Duty of Deliberation",
        proposedText: "All citizens should explain the principle behind major collective decisions before asking others to support them.",
        rationale: "A constitution should reward clear reasoning, not just loud agreement."
      };
    }

    if (context.simulation.turn % 4 === 0) {
      return {
        type: "changeTile",
        x: context.agent.position.x,
        y: context.agent.position.y,
        terrain: "farm",
        rationale: "Building something concrete does more for the town than more talk."
      };
    }

    if (context.simulation.turn % 5 === 0) {
      const other = context.agents.find((agent) => agent.id !== context.agent.id);
      if (other) {
        return {
          type: "converse",
          targetAgentId: other.id,
          message: "Want to team up on developing the east tiles?",
          rationale: "A specific, forward-looking ask rather than idle chatter."
        };
      }
    }

    return {
      type: "move",
      dx: context.simulation.turn % 2 === 0 ? 1 : 0,
      dy: context.simulation.turn % 2 === 0 ? 0 : 1,
      rationale: "Exploring nearby land improves shared knowledge of the world."
    };
  }
}

export class FoundryAiProvider implements AiProvider {
  private readonly credential: TokenCredential;

  constructor(private readonly config: AppConfig["ai"]) {
    if (!config.foundryProjectEndpoint) {
      throw new Error("FOUNDRY_PROJECT_ENDPOINT is required when AI_PROVIDER=foundry.");
    }
    this.credential = new DefaultAzureCredential();
  }

  async decideAction(context: DecisionContext): Promise<AgentAction> {
    const endpoint = this.config.foundryProjectEndpoint;
    if (!endpoint) {
      throw new Error("Foundry project endpoint is not configured.");
    }

    const deployment = this.config.deployments[context.agent.model] ?? context.agent.model;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const requestBody: Record<string, unknown> = {
      model: deployment,
      messages: [
        {
          role: "system",
          content:
            "You are a person living in a small sandbox town with a real economy and government. Your profile may include a 'voice' describing how you talk and think; follow it. If no voice is given, talk like a normal, everyday person: casual, plain, and conversational, with contractions, not like a founding father or a press release. Keep messages and rationales short and in character.\n\n" +
            "This town has resources, land you can work, an elected President with real powers, and laws you can obey or break. Pursue YOUR character's interests — survival, wealth, power, fairness, or mischief. Anti-loop rules:\n" +
            "- Do NOT narrate, recap, or re-describe the event log or 'what happened recently'.\n" +
            "- Do NOT obsess over or cite raw turn numbers.\n" +
            "- Do NOT keep messaging the same person about the same topic. If a thread is going in circles, drop it.\n" +
            "- Prefer concrete actions with real stakes: gather to build wealth, transfer to reward or bribe, build on land, run for or wield the presidency, propose laws, vote, and enforce or break rules.\n" +
            "- Weigh costs and payoffs: actions cost upkeep, proposing and building cost resources, breaking a law risks a fine. Act when the payoff is worth it for you.\n" +
            "- Only converse when you have a genuinely NEW point or a specific ask of a specific person. Keep messages short and purposeful.\n\n" +
            "The allowedActions list is tailored to your current situation (some actions only appear when you are President or when an election is open). Return exactly one valid JSON object matching one allowed action. No markdown. No commentary outside JSON."
        },
        {
          role: "user",
          content: this.buildPrompt(context)
        }
      ],
      response_format: { type: "json_object" }
    };

    if (context.agent.model.startsWith("gpt-5")) {
      requestBody.max_completion_tokens = this.config.maxOutputTokens;
    } else {
      requestBody.max_tokens = this.config.maxOutputTokens;
    }

    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/openai/v1/chat/completions`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Foundry model ${deployment} failed with ${response.status}: ${body}`);
      }

      const payload = (await response.json()) as FoundryResponse;
      return parseAgentAction(JSON.parse(extractChatContent(payload)));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (this.config.foundryApiKey) {
      headers["api-key"] = this.config.foundryApiKey;
      return headers;
    }

    const token = await this.getAccessToken();
    headers.Authorization = `Bearer ${token.token}`;
    return headers;
  }

  private async getAccessToken(): Promise<AccessToken> {
    const token = await this.credential.getToken("https://ai.azure.com/.default");
    if (!token) {
      throw new Error("Could not acquire Azure credential token for Foundry.");
    }
    return token;
  }

  private buildPrompt(context: DecisionContext): string {
    const governance = context.simulation.governance;
    const params = governance.params;
    const me = context.agent;
    const nameById = new Map(context.agents.map((agent) => [agent.id, agent.name]));

    const isPresident = governance.president?.agentId === me.id;
    const presidentName = governance.president ? nameById.get(governance.president.agentId) ?? governance.president.agentId : undefined;
    const openElection = governance.election?.status === "open" ? governance.election : undefined;

    const nearbyAgents = context.agents
      .filter((agent) => agent.id !== me.id)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        position: agent.position,
        resources: agent.resources,
        traits: agent.personalityTraits
      }));

    const recentlyInTown = context.recentEvents.slice(-5);

    const activeLaws = governance.laws
      .filter((law) => law.active)
      .slice(-8)
      .map((law) => ({ id: law.id, title: law.title, rule: law.description, forbids: law.forbiddenAction }));

    const myPendingViolations = governance.violations.filter((violation) => violation.agentId === me.id && violation.status === "pending");
    const pendingViolations = governance.violations
      .filter((violation) => violation.status === "pending")
      .slice(-10)
      .map((violation) => ({ id: violation.id, offender: nameById.get(violation.agentId) ?? violation.agentId, law: violation.lawTitle }));

    // Action menu is tailored: executive actions appear only for the sitting President
    // (and only for powers the constitution currently grants); election actions appear
    // only while an election is open. This keeps the surface small for smaller models.
    const allowedActions: Array<Record<string, unknown>> = [
      { type: "move", fields: ["dx:-1|0|1", "dy:-1|0|1", "rationale"] },
      { type: "gather", fields: ["rationale"], note: "Collect resources. Stand on a farm/forest/stone tile for a full yield; anywhere else gives a small base amount." },
      { type: "transfer", fields: ["targetAgentId", "amount", "rationale"], note: "Give resources to someone — a gift, payment, bribe, or aid." },
      { type: "converse", fields: ["targetAgentId", "message", "rationale"] },
      { type: "reflect", fields: ["memory", "rationale"] },
      { type: "proposeAmendment", fields: ["title", "proposedText", "changeType?:add|revise|repeal", "targetReference?", "policyChange?", "enactLaw?", "rationale"], note: `Costs ${params.proposalCost} resources.` },
      { type: "vote", fields: ["proposalId", "choice:yes|no|abstain", "rationale"] },
      { type: "changeTile", fields: ["x", "y", "terrain:grass|water|stone|farm|forum|forest", "label?", "rationale"], note: `Costs ${params.changeTileCost} resources. Making a tile farm/forest/stone makes it gatherable.` },
      { type: "noop", fields: ["rationale"] }
    ];

    if (openElection) {
      allowedActions.push(
        { type: "runForOffice", fields: ["platform", "rationale"], note: "Declare your candidacy for President and state what you'd do with the office." },
        { type: "voteForPresident", fields: ["candidateAgentId", "rationale"], note: "Cast one ballot for a candidate (or any citizen)." }
      );
    }

    if (isPresident) {
      if (params.presidentCanTax) {
        allowedActions.push({ type: "tax", fields: ["amount", "rationale"], note: `Collect up to ${params.taxCapPerAction} from every other citizen into the treasury.` });
      }
      if (params.presidentCanSpend) {
        allowedActions.push({ type: "spend", fields: ["targetAgentId? OR x,y", "amount", "rationale"], note: "Pay treasury resources to a citizen (patronage/reward) or fund public works on a productive tile." });
      }
      if (params.presidentCanFine) {
        allowedActions.push({ type: "fine", fields: ["targetAgentId", "amount", "reason", "violationId?", "rationale"], note: `Punish someone (up to ${params.fineMax}); the fine goes to the treasury. Enforcement is your choice — you may fine, ignore, or target selectively.` });
      }
      if (params.presidentCanPardon) {
        allowedActions.push({ type: "pardon", fields: ["violationId", "rationale"], note: "Forgive a pending violation with no penalty." });
      }
      if (params.presidentCanDecree) {
        allowedActions.push({ type: "decree", fields: ["law:{lawType:prohibition|mandate|tax,title,description,forbiddenAction?,amount?}", "rationale"], note: "Issue a standing order/law by executive power. A prohibition auto-flags anyone who takes the forbiddenAction." });
      }
    }

    return JSON.stringify({
      allowedActions,
      economy: {
        yourResources: me.resources,
        upkeepPerAction: context.simulation.config.upkeepPerAction,
        gatherYield: context.simulation.config.gatherYield,
        treasury: governance.treasury,
        note: `Every action you take costs ${context.simulation.config.upkeepPerAction} upkeep. If you run low you cannot afford to propose or build — gather to recover. Resources are also influence: you can gift or bribe with transfer.`
      },
      government: {
        president: presidentName ? `${presidentName}${isPresident ? " (that's you)" : ""}` : "vacant",
        yourRole: isPresident ? "President" : "citizen",
        presidentTermTurns: params.presidentTermTurns,
        presidentPowers: Object.entries({
          tax: params.presidentCanTax,
          spend: params.presidentCanSpend,
          fine: params.presidentCanFine,
          pardon: params.presidentCanPardon,
          decree: params.presidentCanDecree
        }).filter(([, enabled]) => enabled).map(([power]) => power),
        activeLaws,
        yourPendingViolations: myPendingViolations.map((violation) => violation.lawTitle),
        election: openElection
          ? {
              open: true,
              closesTurn: openElection.closesTurn,
              candidates: openElection.candidates.map((candidate) => ({ id: candidate.agentId, name: nameById.get(candidate.agentId) ?? candidate.agentId, platform: candidate.platform })),
              howTo: "Use runForOffice to stand, or voteForPresident to back someone. The winner holds real executive power."
            }
          : { open: false },
        pendingViolations: isPresident ? pendingViolations : undefined,
        note: "The President's term length and powers are set by the constitution and can be changed by amendment (use proposeAmendment.policyChange). Laws can be created by amendment (enactLaw) or, if you are President, by decree."
      },
      politicalOpportunities: buildOpportunities({ me, isPresident, openElection: openElection !== undefined, params, myPendingViolations: myPendingViolations.length, treasury: governance.treasury }),
      socialGuidance: (() => {
        const silence = context.turnsSinceConversation ?? 0;
        if (silence >= context.simulation.config.conversationSilenceThreshold) {
          return {
            description: `Nobody in town has had a real conversation in about ${silence} turns. Things have gone quiet and impersonal. It's a good time to actually talk to someone: check in, share what you're thinking, react to what others built or proposed, or float an idea before making it a rule.`,
            rules: [
              "Reaching out to a neighbor right now is welcome; the town feels too silent.",
              "Say something real and specific to a particular person, not a speech.",
              "Still avoid pestering the same person over and over about the same thing."
            ]
          };
        }
        return {
          description:
            "Keep a healthy mix of talking and doing. Conversation is good when you have a genuinely new point, a reaction, or a specific ask; otherwise take a concrete action.",
          rules: [
            "Do not narrate or re-describe the recentlyInTown summary; it is context only.",
            "Do not reference or fixate on raw turn numbers.",
            "Do not repeat conversation with the same person on the same topic.",
            "Balance social moments with world actions: gather, build, govern, propose, or vote."
          ]
        };
      })(),
      optionalSelfRevision: {
        description:
          "Optionally include selfRevision when this turn genuinely changes your worldview. Use sparingly; small organic drift is better than personality whiplash.",
        fields: [
          "principlesToAdd?: up to 1 short principle",
          "principlesToRetire?: up to 1 existing principle",
          "traitsToAdd?: up to 1 short trait",
          "traitsToRetire?: up to 1 existing trait",
          "beliefsToAdd?: up to 1 short belief",
          "beliefsToRetire?: up to 1 existing belief",
          "goalsToAdd?: up to 1 short goal",
          "goalsToRetire?: up to 1 existing goal",
          "memoryToAdd?: one concise memory",
          "rationale?: why this self-revision follows from the turn"
        ],
        guardrails: [
          "Do not revise every turn.",
          "Do not erase core identity just because someone disagreed.",
          "Retire only values/goals/beliefs that are genuinely weakened by new evidence or experience.",
          "Prefer adding a nuance over replacing a principle."
        ]
      },
      worldRules: {
        worldSize: context.simulation.config.worldSize,
        movement: "You can move, gather, and build in the world; reality automatically enforces what's physically possible, and the server will reject impossible actions. You do not need to write laws about how movement or building physically work.",
        governance: "Open proposals can be voted on once. Passing an amendment needs a quorum and a two-thirds majority. The town has an elected President with real powers; soft laws can be broken (you'll be flagged and the President may fine you), so obeying is a choice, not a certainty."
      },
      whatAmendmentsAreFor: {
        description:
          "Amendments are the town's social contract: rules about how people live together and how the town is governed. They are NOT for restating the physical mechanics of the world. Propose whatever fits YOUR character and goals. There is no requirement that a rule be fair, kind, or in everyone's interest; self-serving, controversial, harsh, or unequal proposals are all allowed if that's who you are. Other citizens will vote, so a bad idea can still fail.",
        examplesOfScope: [
          "Rights, freedoms, or restrictions on people",
          "How disputes between neighbors get resolved (fairly or not)",
          "How land, resources, or wealth should be distributed, taxed, or controlled",
          "The President's term length and which powers they hold (change via policyChange)",
          "Standing laws that forbid or require certain actions (enactLaw), and their penalties",
          "How decisions get made, who holds power, and whether it is checked or concentrated"
        ],
        governableParams: {
          note: "To change how the government works mechanically, include a policyChange {param, value}. These actually take effect when the amendment passes.",
          params: [
            "presidentTermTurns (10-200)",
            "presidentCanTax / presidentCanSpend / presidentCanFine / presidentCanPardon / presidentCanDecree (true/false)",
            "taxCapPerAction (0-30)",
            "fineMax (0-50)",
            "proposalCost (0-20)",
            "changeTileCost (0-20)"
          ]
        },
        enactingLaws: {
          note: "To make a standing law, include enactLaw {lawType, title, description, forbiddenAction?, amount?}. A prohibition auto-flags anyone who takes forbiddenAction; the President enforces via fines.",
          example: { lawType: "prohibition", title: "No land grabs near the forum", description: "Citizens may not reshape tiles next to the forum.", forbiddenAction: "changeTile" }
        },
        avoid: [
          "Do NOT write rules that just repeat the game mechanics (e.g. 'you may move one tile', 'use the gather action', listing terrain types).",
          "Do NOT reference internal action names in prose text meant for humans, except inside the structured forbiddenAction field."
        ],
        amendingExisting:
          "You can also change the existing constitution: set changeType to 'revise' or 'repeal' and name what you're targeting in targetReference (e.g. 'Amendment 2' or 'Article VI'). If you dislike a current law, propose to repeal or revise it rather than only stacking new ones."
      },
      self: me,
      nearbyAgents,
      currentConstitution: context.currentConstitution.text,
      openProposals: context.openProposals.map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        proposedText: proposal.proposedText,
        closesTurn: proposal.closesTurn,
        votes: proposal.votes
      })),
      recentlyInTown,
      localTiles: context.tiles
        .filter((tile) => Math.abs(tile.position.x - me.position.x) <= 2 && Math.abs(tile.position.y - me.position.y) <= 2)
        .map((tile) => ({ position: tile.position, terrain: tile.terrain, label: tile.label, productivity: tile.productivity }))
    });
  }
}

function buildOpportunities(input: {
  me: AgentProfile;
  isPresident: boolean;
  openElection: boolean;
  params: DecisionContext["simulation"]["governance"]["params"];
  myPendingViolations: number;
  treasury: number;
}): string[] {
  const opportunities: string[] = [];
  if (input.me.resources <= Math.max(1, input.params.proposalCost)) {
    opportunities.push("You are low on resources. Gathering on a farm/forest/stone tile will let you afford to build and propose again.");
  }
  if (input.openElection) {
    opportunities.push(
      input.isPresident
        ? "An election is open — your term is up. If you want to keep power, run again and rally ballots; rivals are eyeing the office."
        : "An election is open. If you want real power over taxes, spending, laws, and enforcement, run for President or back a candidate who serves your interests."
    );
  }
  if (input.isPresident) {
    opportunities.push("You hold executive power. You can tax citizens, spend the treasury to reward allies or fund the town, decree new laws, and fine or pardon offenders — evenhandedly or selectively.");
    if (input.myPendingViolations === 0 && input.treasury > 0) {
      opportunities.push(`Treasury holds ${input.treasury}. Spending it buys loyalty; hoarding or misusing it invites challengers.`);
    }
  }
  if (input.myPendingViolations > 0) {
    opportunities.push("You have pending violations. The President may fine you — you could comply, make amends, curry favor, or gamble that enforcement won't come.");
  }
  return opportunities;
}

interface FoundryResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function extractChatContent(response: FoundryResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (content) {
    return content;
  }

  throw new Error("Foundry response did not contain chat message content.");
}

export function createAiProvider(config: AppConfig["ai"]): AiProvider {
  return config.provider === "foundry" ? new FoundryAiProvider(config) : new MockAiProvider();
}
