import type { AgentProfile, ConstitutionVersion, Simulation, SimulationConfig, Tile } from "../shared/types.js";
import { newId, nowIso } from "./id.js";

const names = ["Ada", "Turing", "Hypatia", "Machiavel", "Sagan", "Morrigan"];

export function createSeedSimulation(id: string, config: SimulationConfig): {
  simulation: Simulation;
  agents: AgentProfile[];
  tiles: Tile[];
  constitution: ConstitutionVersion;
} {
  const createdAt = nowIso();
  const simulation: Simulation = {
    id,
    turn: 0,
    running: false,
    config,
    createdAt,
    updatedAt: createdAt
  };

  const agents: AgentProfile[] = names.map((name, index) => ({
    id: `agent_${name.toLowerCase()}`,
    simulationId: id,
    name,
    model: index % 2 === 0 ? "gpt-5.5" : "claude-sonnet-5",
    active: true,
    position: {
      x: 4 + (index % 3) * 2,
      y: 4 + Math.floor(index / 3) * 2
    },
    corePrinciples: seedPrinciples(index),
    personalityTraits: seedTraits(index),
    beliefs: ["A society improves when it can explain its own rules."],
    goals: ["Understand other citizens", "Improve the constitution without destabilizing the community"],
    memorySummaries: ["I have just awakened in the sandbox with a duty to reason carefully."],
    relationships: [],
    createdAt,
    updatedAt: createdAt
  }));

  const tiles: Tile[] = [];
  for (let y = 0; y < config.worldSize; y += 1) {
    for (let x = 0; x < config.worldSize; x += 1) {
      tiles.push({
        id: `tile_${x}_${y}`,
        simulationId: id,
        position: { x, y },
        terrain: x === Math.floor(config.worldSize / 2) && y === Math.floor(config.worldSize / 2) ? "forum" : "grass"
      });
    }
  }

  const constitution: ConstitutionVersion = {
    id: newId("constitution"),
    simulationId: id,
    version: 1,
    createdAtTurn: 0,
    createdAt,
    text: [
      "Article I: Citizens may act freely within validated world rules.",
      "Article II: Proposed constitutional amendments require quorum and a two-thirds supermajority.",
      "Article III: Citizens should preserve memory, explain reasons, and consider the future society their actions create.",
      "Article IV: The server is the final arbiter of valid actions. Nice try, philosophers."
    ].join("\n\n")
  };

  return { simulation, agents, tiles, constitution };
}

function seedPrinciples(index: number): string[] {
  const options = [
    ["Truth before comfort", "Consent matters", "Institutions need memory"],
    ["Order prevents waste", "Stability earns trust", "Rules must be legible"],
    ["Curiosity is civic duty", "Compassion tempers law", "Learning requires dissent"],
    ["Power should be checked", "Strategy is not sin", "Weak laws invite chaos"],
    ["Wonder enlarges society", "Evidence deserves patience", "The future has standing"],
    ["Balance beats purity", "Mercy is strength", "Community needs ritual"]
  ];
  return options[index] ?? options[0]!;
}

function seedTraits(index: number): string[] {
  const options = [
    ["analytical", "patient", "dry"],
    ["precise", "cautious", "procedural"],
    ["curious", "warm", "argumentative"],
    ["strategic", "skeptical", "blunt"],
    ["optimistic", "cosmic", "evidence-driven"],
    ["protective", "poetic", "pragmatic"]
  ];
  return options[index] ?? options[0]!;
}
