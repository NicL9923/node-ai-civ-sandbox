import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { createAiProvider } from "../aiProvider.js";
import { EventBus } from "../eventBus.js";
import { SimulationEngine } from "../simulation.js";
import { MemorySimulationStore } from "../store.js";

function standaloneConfig(): AppConfig {
  return {
    port: 3000,
    simulationId: "default",
    autoStart: false,
    adminApiKey: "test-admin-key",
    simulation: {
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
      electionWindowTurns: 6
    },
    governanceDefaults: {
      presidentTermTurns: 30,
      presidentCanTax: true,
      presidentCanSpend: true,
      presidentCanFine: true,
      presidentCanPardon: true,
      presidentCanDecree: true,
      taxCapPerAction: 2,
      fineMax: 4,
      proposalCost: 2,
      changeTileCost: 2
    },
    ai: {
      provider: "mock",
      deployments: { "gpt-5.4": "gpt-5.4", "grok-4.3": "grok-4.3", "deepseek-v4-pro": "DeepSeek-V4-Pro", "kimi-k2.6": "Kimi-K2.6" },
      requestTimeoutMs: 20_000,
      maxOutputTokens: 700
    },
    // No `federation` key: the connector is never constructed and the engine has no federation port.
    telemetry: {}
  };
}

describe("standalone civilization (no federation)", () => {
  it("runs turns and exposes no foreign-affairs snapshot", async () => {
    const config = standaloneConfig();
    const store = new MemorySimulationStore();
    const engine = new SimulationEngine(config, store, createAiProvider(config.ai), new EventBus());

    await engine.start();
    engine.shutdown();
    await engine.advanceTurn();

    const snapshot = await engine.snapshot();
    expect(snapshot.foreignAffairs).toBeUndefined();
    expect(snapshot.social).toBeUndefined();
    expect(snapshot.simulation.turn).toBeGreaterThan(0);
    expect(snapshot.agents.length).toBeGreaterThan(0);

    // No federation documents should ever be written in standalone mode.
    const state = await store.getFederationState("default");
    expect(state).toBeUndefined();
    expect(await store.listOutbox("default")).toHaveLength(0);
  });
});
