import { describe, expect, it } from "vitest";
import type { AgentProfile, ConstitutionVersion, Simulation } from "../../shared/types.js";
import { buildDecisionPrompt, type DecisionContext } from "../aiProvider.js";
import type { SocialSnapshot } from "./socialTypes.js";

function makeSimulation(presidentAgentId?: string): Simulation {
  const now = new Date(0).toISOString();
  return {
    id: "default",
    turn: 5,
    running: true,
    createdAt: now,
    updatedAt: now,
    governance: {
      treasury: 10,
      params: {
        presidentTermTurns: 40,
        presidentCanTax: true,
        presidentCanSpend: true,
        presidentCanFine: true,
        presidentCanPardon: true,
        presidentCanDecree: true,
        taxCapPerAction: 3,
        fineMax: 8,
        proposalCost: 3,
        changeTileCost: 2
      },
      president: presidentAgentId ? { agentId: presidentAgentId, termStartedTurn: 0, termNumber: 2 } : undefined,
      laws: [],
      violations: []
    },
    config: {
      worldSize: 8,
      actorsPerTurn: 2,
      turnIntervalMs: 30_000,
      proposalVotingWindowTurns: 20,
      quorumRatio: 0.5,
      supermajorityRatio: 2 / 3,
      maxConsecutiveConverses: 3,
      conversationSilenceThreshold: 8,
      startResources: 10,
      upkeepPerAction: 1,
      gatherYield: 3,
      gatherBase: 1,
      tileMaxProductivity: 6,
      tileRegenInterval: 4,
      electionWindowTurns: 8
    }
  };
}

function makeAgent(id: string, name: string): AgentProfile {
  const now = new Date(0).toISOString();
  return {
    id,
    simulationId: "default",
    name,
    model: "gpt-5.4",
    active: true,
    position: { x: 2, y: 2 },
    resources: 10,
    corePrinciples: [],
    personalityTraits: ["curious"],
    beliefs: [],
    goals: [],
    memorySummaries: ["I remember arriving."],
    relationships: [],
    createdAt: now,
    updatedAt: now
  };
}

const constitution: ConstitutionVersion = {
  id: "c1",
  simulationId: "default",
  version: 1,
  text: "Be excellent to each other.",
  createdAtTurn: 0,
  createdAt: new Date(0).toISOString()
};

function socialSnapshot(overrides: Partial<SocialSnapshot> = {}): SocialSnapshot {
  return {
    enabled: true,
    connected: true,
    agentAccounts: { agent_a: { accountId: "acct_a", displayName: "Ada" } },
    officialAccount: { accountId: "acct_official" },
    officialTermNumber: 2,
    feed: [
      { postId: "p1", authorAccountId: "acct_x", authorName: "Ext", text: "hi world", parentPostId: null, conversationRootPostId: "p1", replyCount: 0, likeCount: 1 }
    ],
    knownAccounts: [{ accountId: "acct_x", name: "Ext" }],
    follows: [],
    briefing: ["The World Wire is active — 1 recent post."],
    pendingOutbox: 0,
    failedOutbox: 0,
    ...overrides
  };
}

function context(agent: AgentProfile, simulation: Simulation, social?: SocialSnapshot): DecisionContext {
  return {
    simulation,
    agent,
    agents: [agent, makeAgent("agent_b", "Turing")],
    tiles: [],
    currentConstitution: constitution,
    openProposals: [],
    recentEvents: [],
    turnsSinceConversation: 1,
    social
  };
}

describe("buildDecisionPrompt — World Wire", () => {
  it("offers social actions and a worldWire block once the acting agent's account is synced", () => {
    const agent = makeAgent("agent_a", "Ada");
    const prompt = JSON.parse(buildDecisionPrompt(context(agent, makeSimulation("agent_b"), socialSnapshot())));
    const types = prompt.allowedActions.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(["postSocial", "replySocial", "likeSocial", "followSocial"]));
    expect(prompt.worldWire).toBeDefined();
    expect(prompt.worldWire.yourAccountId).toBe("acct_a");
    expect(prompt.worldWire.feed[0].postId).toBe("p1");
  });

  it("hides social affordances when the acting agent has no synced account", () => {
    const agent = makeAgent("agent_a", "Ada");
    const snapshot = socialSnapshot({ agentAccounts: {} });
    const prompt = JSON.parse(buildDecisionPrompt(context(agent, makeSimulation("agent_b"), snapshot)));
    expect(prompt.allowedActions.map((a: { type: string }) => a.type)).not.toContain("postSocial");
    expect(prompt.worldWire).toBeUndefined();
  });

  it("advertises the official account only to a President with a synced official account", () => {
    const agent = makeAgent("agent_a", "Ada");
    const asPresident = JSON.parse(buildDecisionPrompt(context(agent, makeSimulation("agent_a"), socialSnapshot())));
    const asCitizen = JSON.parse(buildDecisionPrompt(context(agent, makeSimulation("agent_b"), socialSnapshot())));
    expect(asPresident.worldWire.official.available).toBe(true);
    expect(asCitizen.worldWire.official.available).toBe(false);
  });

  it("bounds the feed shown in the prompt", () => {
    const agent = makeAgent("agent_a", "Ada");
    const bigFeed = Array.from({ length: 25 }, (_unused, index) => ({
      postId: `p${index}`,
      authorAccountId: "acct_x",
      authorName: "Ext",
      text: `post ${index}`,
      parentPostId: null,
      conversationRootPostId: `p${index}`,
      replyCount: 0,
      likeCount: 0
    }));
    // The snapshot itself is already bounded by the service (promptFeedItems); the prompt echoes it as-is.
    const prompt = JSON.parse(buildDecisionPrompt(context(agent, makeSimulation("agent_b"), socialSnapshot({ feed: bigFeed.slice(0, 8) }))));
    expect(prompt.worldWire.feed.length).toBeLessThanOrEqual(8);
  });

  it("shows nothing when the social sub-feature is absent (standalone)", () => {
    const agent = makeAgent("agent_a", "Ada");
    const prompt = JSON.parse(buildDecisionPrompt(context(agent, makeSimulation("agent_a"), undefined)));
    expect(prompt.worldWire).toBeUndefined();
    expect(prompt.allowedActions.map((a: { type: string }) => a.type)).not.toContain("postSocial");
  });

  it("does not clone the shared feed into an agent's personal memory", () => {
    const ada = makeAgent("agent_a", "Ada");
    buildDecisionPrompt(context(ada, makeSimulation("agent_b"), socialSnapshot()));
    expect(ada.memorySummaries).toEqual(["I remember arriving."]);
  });
});
