import { describe, expect, it } from "vitest";
import type { AgentProfile, AmendmentProposal, Simulation, Tile } from "../shared/types.js";
import { validateAction } from "./simulation.js";

const simulation: Simulation = {
  id: "default",
  turn: 5,
  running: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  config: {
    worldSize: 4,
    actorsPerTurn: 2,
    turnIntervalMs: 30_000,
    proposalVotingWindowTurns: 20,
    quorumRatio: 0.5,
    supermajorityRatio: 2 / 3
  }
};

const actor: AgentProfile = {
  id: "agent_a",
  simulationId: "default",
  name: "Ada",
  model: "gpt-5.5",
  active: true,
  position: { x: 1, y: 1 },
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
    model: "claude-sonnet-5",
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

  it("allows adjacent tile changes", () => {
    expect(validateAction(simulation, actor, { type: "changeTile", x: 2, y: 2, terrain: "farm", rationale: "grow food" }, agents, tiles, [])).toBeUndefined();
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
});
