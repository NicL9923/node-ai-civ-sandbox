import { describe, expect, it } from "vitest";
import type { AgentProfile, ConstitutionVersion, ForeignAffairsSnapshot, Simulation } from "../../shared/types.js";
import { buildDecisionPrompt, type DecisionContext } from "../aiProvider.js";

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
      president: presidentAgentId ? { agentId: presidentAgentId, termStartedTurn: 0, termNumber: 1 } : undefined,
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

const foreignAffairs: ForeignAffairsSnapshot = {
  enabled: true,
  registered: true,
  connected: true,
  civId: "civ_a",
  displayName: "Civ A",
  briefing: ["Known civilizations: Civ B.", "Civ B opened contact with us."],
  knownCivilizations: [{ civId: "civ_b", displayName: "Civ B" }],
  pendingOutbox: 0,
  failedOutbox: 0
};

function baseContext(agent: AgentProfile, simulation: Simulation, foreign?: ForeignAffairsSnapshot): DecisionContext {
  return {
    simulation,
    agent,
    agents: [agent, makeAgent("agent_b", "Turing")],
    tiles: [],
    currentConstitution: constitution,
    openProposals: [],
    recentEvents: [],
    turnsSinceConversation: 1,
    foreignAffairs: foreign
  };
}

describe("buildDecisionPrompt — world briefing", () => {
  it("includes a compact world briefing in every prompt when federation is enabled", () => {
    const simulation = makeSimulation("agent_b");
    const agent = makeAgent("agent_a", "Ada");
    const prompt = JSON.parse(buildDecisionPrompt(baseContext(agent, simulation, foreignAffairs)));
    expect(prompt.worldBriefing).toBeDefined();
    expect(prompt.worldBriefing.recent).toEqual(foreignAffairs.briefing);
    expect(prompt.worldBriefing.recent.length).toBeLessThanOrEqual(6);
  });

  it("offers cross-civ actions only to the President", () => {
    const agent = makeAgent("agent_a", "Ada");
    const asPresident = JSON.parse(buildDecisionPrompt(baseContext(agent, makeSimulation("agent_a"), foreignAffairs)));
    const asCitizen = JSON.parse(buildDecisionPrompt(baseContext(agent, makeSimulation("agent_b"), foreignAffairs)));
    const presidentActions = asPresident.allowedActions.map((a: { type: string }) => a.type);
    const citizenActions = asCitizen.allowedActions.map((a: { type: string }) => a.type);
    expect(presidentActions).toContain("contactCivilization");
    expect(presidentActions).toContain("messageCivilization");
    expect(citizenActions).not.toContain("contactCivilization");
  });

  it("omits the briefing and cross-civ actions when federation is disabled (standalone)", () => {
    const agent = makeAgent("agent_a", "Ada");
    const prompt = JSON.parse(buildDecisionPrompt(baseContext(agent, makeSimulation("agent_a"), undefined)));
    expect(prompt.worldBriefing).toBeUndefined();
    expect(prompt.allowedActions.map((a: { type: string }) => a.type)).not.toContain("contactCivilization");
  });

  it("shares the same briefing across agents without cloning it into agent memory", () => {
    const simulation = makeSimulation("agent_b");
    const ada = makeAgent("agent_a", "Ada");
    const turing = makeAgent("agent_b", "Turing");
    const promptA = JSON.parse(buildDecisionPrompt(baseContext(ada, simulation, foreignAffairs)));
    const promptB = JSON.parse(buildDecisionPrompt(baseContext(turing, simulation, foreignAffairs)));
    expect(promptA.worldBriefing.recent).toEqual(promptB.worldBriefing.recent);
    // Building the prompt must never mutate an agent's personal memory with the shared briefing.
    expect(ada.memorySummaries).toEqual(["I remember arriving."]);
    expect(turing.memorySummaries).toEqual(["I remember arriving."]);
  });
});
