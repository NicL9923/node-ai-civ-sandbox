import { describe, expect, it } from "vitest";
import type { AgentProfile, AmendmentProposal, Governance, Simulation, Tile } from "../shared/types.js";
import { validateAction } from "./simulation.js";

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

function withGovernance(overrides: Partial<Governance>): Simulation {
  return { ...simulation, governance: { ...governance, ...overrides, params: { ...governance.params, ...overrides.params } } };
}

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

const agents: AgentProfile[] = [
  actor,
  {
    ...actor,
    id: "agent_b",
    name: "Turing",
    model: "grok-4.3",
    position: { x: 2, y: 1 }
  }
];

const tiles: Tile[] = Array.from({ length: 16 }, (_, index) => ({
  id: `tile_${index}`,
  simulationId: "default",
  position: { x: index % 4, y: Math.floor(index / 4) },
  terrain: "grass"
}));

describe("validateAction", () => {
  it("rejects movement outside the world", () => {
    expect(validateAction(simulation, { ...actor, position: { x: 0, y: 0 } }, { type: "move", dx: -1, dy: 0, rationale: "leave" }, agents, tiles, [])).toBe(
      "move would leave the world bounds"
    );
  });

  it("allows adjacent tile changes when affordable", () => {
    expect(validateAction(simulation, actor, { type: "changeTile", x: 2, y: 2, terrain: "farm", rationale: "grow food" }, agents, tiles, [])).toBeUndefined();
  });

  it("rejects tile changes the agent cannot afford", () => {
    expect(validateAction(simulation, { ...actor, resources: 1 }, { type: "changeTile", x: 2, y: 2, terrain: "farm", rationale: "grow food" }, agents, tiles, [])).toBe(
      "cannot afford to change a tile"
    );
  });

  it("rejects duplicate votes", () => {
    const proposals: AmendmentProposal[] = [
      {
        id: "proposal_1",
        simulationId: "default",
        title: "Test",
        proposedText: "A serious amendment long enough to be considered valid.",
        rationale: "Test",
        proposerAgentId: "agent_b",
        status: "open",
        openedTurn: 1,
        closesTurn: 20,
        votes: [{ agentId: "agent_a", choice: "yes", rationale: "ok", turn: 2 }],
        createdAt: new Date(0).toISOString()
      }
    ];

    expect(validateAction(simulation, actor, { type: "vote", proposalId: "proposal_1", choice: "yes", rationale: "again" }, agents, tiles, proposals)).toBe(
      "agent has already voted on this proposal"
    );
  });

  it("always allows gather (recovery is never blocked)", () => {
    expect(validateAction(simulation, { ...actor, resources: 0 }, { type: "gather", rationale: "recover" }, agents, tiles, [])).toBeUndefined();
  });

  it("rejects a transfer the agent cannot fund", () => {
    expect(validateAction(simulation, { ...actor, resources: 2 }, { type: "transfer", targetAgentId: "agent_b", amount: 5, rationale: "gift" }, agents, tiles, [])).toBe(
      "insufficient resources to transfer"
    );
  });

  it("rejects proposals when the agent cannot afford the cost", () => {
    expect(validateAction(simulation, { ...actor, resources: 1 }, { type: "proposeAmendment", title: "X", proposedText: "A serious amendment long enough to be considered valid.", rationale: "why" }, agents, tiles, [])).toBe(
      "cannot afford the proposal cost"
    );
  });

  it("blocks executive actions for non-presidents", () => {
    expect(validateAction(simulation, actor, { type: "tax", amount: 2, rationale: "revenue" }, agents, tiles, [])).toBe(
      "only the President may tax"
    );
  });

  it("allows the sitting President to tax when the power is granted", () => {
    const sim = withGovernance({ president: { agentId: "agent_a", termStartedTurn: 0, termNumber: 1 } });
    expect(validateAction(sim, actor, { type: "tax", amount: 2, rationale: "revenue" }, agents, tiles, [])).toBeUndefined();
  });

  it("denies a President a power the constitution has revoked", () => {
    const sim = withGovernance({
      president: { agentId: "agent_a", termStartedTurn: 0, termNumber: 1 },
      params: { ...governance.params, presidentCanTax: false }
    });
    expect(validateAction(sim, actor, { type: "tax", amount: 2, rationale: "revenue" }, agents, tiles, [])).toBe(
      "the constitution does not grant the President power to tax"
    );
  });

  it("rejects running for office with no open election", () => {
    expect(validateAction(simulation, actor, { type: "runForOffice", platform: "vote me", rationale: "ambition" }, agents, tiles, [])).toBe(
      "no election is currently open"
    );
  });
});
