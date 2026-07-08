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
}

export interface AiProvider {
  decideAction(context: DecisionContext): Promise<AgentAction>;
}

export class MockAiProvider implements AiProvider {
  async decideAction(context: DecisionContext): Promise<AgentAction> {
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

    if (context.simulation.turn % 3 === 0) {
      return {
        type: "reflect",
        memory: `I noticed the community still needs patient deliberation.`,
        rationale: "Reflection helps me align future actions with stable principles.",
        selfRevision: {
          goalsToAdd: ["Ask whether deliberation is producing clearer decisions"],
          memoryToAdd: "Repeated deliberation is becoming part of my civic identity.",
          rationale: "A recurring concern should gently adjust future goals."
        }
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
            "You are a person living in a small sandbox town. Your profile may include a 'voice' describing how you talk and think; follow it. If no voice is given, talk like a normal, everyday person: casual, plain, and conversational, with contractions, not like a founding father or a press release. Keep messages and rationales short and in character.\n\n" +
            "The town needs ACTION, not chatter. Anti-loop rules:\n" +
            "- Do NOT narrate, recap, or re-describe the event log or 'what happened recently'.\n" +
            "- Do NOT obsess over or cite raw turn numbers (e.g. 'through turns 955-958'); they don't matter.\n" +
            "- Do NOT keep messaging the same person about the same topic. If a thread is going in circles, drop it.\n" +
            "- Prefer concrete actions that change the world: move to explore, changeTile to build/develop, proposeAmendment when you want a rule, vote on open proposals. Governance and building are stalled — help move them forward.\n" +
            "- Only converse when you have a genuinely NEW point or a specific ask of a specific person. Keep messages short and purposeful.\n\n" +
            "Return exactly one valid JSON object matching one allowed action. No markdown. No commentary outside JSON."
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
    const nearbyAgents = context.agents
      .filter((agent) => agent.id !== context.agent.id)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        position: agent.position,
        traits: agent.personalityTraits
      }));

    const recentlyInTown = context.recentEvents.slice(-5);

    return JSON.stringify({
      allowedActions: [
        { type: "move", fields: ["dx:-1|0|1", "dy:-1|0|1", "rationale"] },
        { type: "converse", fields: ["targetAgentId", "message", "rationale"] },
        { type: "reflect", fields: ["memory", "rationale"] },
        { type: "proposeAmendment", fields: ["title", "proposedText", "rationale"] },
        { type: "vote", fields: ["proposalId", "choice:yes|no|abstain", "rationale"] },
        { type: "changeTile", fields: ["x", "y", "terrain:grass|water|stone|farm|forum|forest", "label?", "rationale"] },
        { type: "noop", fields: ["rationale"] }
      ],
      antiLoopGuidance: {
        description:
          "You have been talking a lot; the town needs action. Conversation is stuck in a loop and governance has stalled. Consider moving to explore, building on tiles, proposing a rule, or voting on open proposals instead of just discussing.",
        rules: [
          "Do not narrate or re-describe the recentlyInTown summary; it is context only.",
          "Do not reference or fixate on raw turn numbers.",
          "Do not repeat conversation with the same person on the same topic.",
          "Only converse with a genuinely new point or a specific ask; otherwise take a world-changing action.",
          "Favor variety: move, changeTile, proposeAmendment, or vote over yet another message."
        ]
      },
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
        movement: "Move at most one tile in each axis. Coordinates must remain inside the world.",
        governance: "Open proposals can be voted on once. Constitutional amendments require quorum and a two-thirds supermajority.",
        stateSafety: "You propose actions only. The server validates and may reject impossible actions."
      },
      self: context.agent,
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
        .filter((tile) => Math.abs(tile.position.x - context.agent.position.x) <= 2 && Math.abs(tile.position.y - context.agent.position.y) <= 2)
        .map((tile) => ({ position: tile.position, terrain: tile.terrain, label: tile.label }))
    });
  }
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
