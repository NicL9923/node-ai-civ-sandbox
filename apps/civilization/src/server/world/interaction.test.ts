import { describe, expect, it } from "vitest";
import type { AgentProfile, Governance, Simulation } from "../../shared/types.js";
import { validateAction, type ForeignValidationContext } from "../simulation.js";

const governance: Governance = {
  treasury: 0,
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
  laws: [],
  violations: []
};

const simulation: Simulation = {
  id: "default",
  turn: 5,
  running: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  governance,
  config: {
    worldSize: 4,
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

const actor: AgentProfile = {
  id: "agent_a",
  simulationId: "default",
  name: "Ada",
  model: "gpt-5.4",
  active: true,
  position: { x: 1, y: 1 },
  resources: 10,
  corePrinciples: [],
  personalityTraits: [],
  beliefs: [],
  goals: [],
  memorySummaries: [],
  relationships: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

const agents = [actor];

function withPresident(agentId: string): Simulation {
  return { ...simulation, governance: { ...governance, president: { agentId, termStartedTurn: 0, termNumber: 1 } } };
}

const enabledForeign: ForeignValidationContext = {
  enabled: true,
  ownCivId: "civ_a",
  knownCivIds: new Set(["civ_b"])
};

const contact = { type: "contactCivilization", targetCivId: "civ_b", greeting: "hi", rationale: "diplomacy" } as const;

describe("validateAction — cross-civ actions", () => {
  it("rejects when federation is disabled", () => {
    expect(validateAction(withPresident("agent_a"), actor, contact, agents, [], [])).toBe("federation is not enabled");
  });

  it("rejects a non-President initiator", () => {
    expect(validateAction(simulation, actor, contact, agents, [], [], enabledForeign)).toBe(
      "only the President may conduct foreign affairs"
    );
  });

  it("rejects an unknown target civilization", () => {
    const sim = withPresident("agent_a");
    const foreign: ForeignValidationContext = { enabled: true, ownCivId: "civ_a", knownCivIds: new Set() };
    expect(validateAction(sim, actor, contact, agents, [], [], foreign)).toBe("target civilization is not known");
  });

  it("rejects targeting your own civilization", () => {
    const sim = withPresident("agent_a");
    const self = { type: "contactCivilization", targetCivId: "civ_a", greeting: "hi", rationale: "x" } as const;
    const foreign: ForeignValidationContext = { enabled: true, ownCivId: "civ_a", knownCivIds: new Set(["civ_a"]) };
    expect(validateAction(sim, actor, self, agents, [], [], foreign)).toBe(
      "cannot direct a foreign action at your own civilization"
    );
  });

  it("allows the sitting President to contact a known civilization", () => {
    expect(validateAction(withPresident("agent_a"), actor, contact, agents, [], [], enabledForeign)).toBeUndefined();
  });

  it("allows the President to message a known civilization", () => {
    const message = { type: "messageCivilization", targetCivId: "civ_b", body: "hello there", rationale: "x" } as const;
    expect(validateAction(withPresident("agent_a"), actor, message, agents, [], [], enabledForeign)).toBeUndefined();
  });
});
