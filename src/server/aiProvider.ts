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
        memory: `On turn ${context.simulation.turn}, I noticed the community still needs patient deliberation.`,
        rationale: "Reflection helps me align future actions with stable principles."
      };
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

    const deployment = this.config.deployments[context.agent.model];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/openai/v1/chat/completions`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({
          model: deployment,
          messages: [
            {
              role: "system",
              content:
                "You are an autonomous citizen in a small AI civilization sandbox. Return exactly one valid JSON object matching one allowed action. No markdown. No commentary outside JSON."
            },
            {
              role: "user",
              content: this.buildPrompt(context)
            }
          ],
          max_tokens: this.config.maxOutputTokens,
          response_format: { type: "json_object" }
        }),
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
    const token = await this.credential.getToken("https://cognitiveservices.azure.com/.default");
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
      recentEvents: context.recentEvents,
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
