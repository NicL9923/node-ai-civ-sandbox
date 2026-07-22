import { describe, expect, it } from "vitest";
import type { Simulation } from "../../shared/types.js";
import { defaultSocialConfig, type FederationConfig } from "../config.js";
import { EventBus } from "../eventBus.js";
import { MemorySimulationStore } from "../store.js";
import { FederationService } from "./federationService.js";
import type { Command } from "./federationTypes.js";

const SIM_ID = "default";

function federationConfig(): FederationConfig {
  return {
    apiBaseUrl: "https://world.example/world/v1",
    protocolVersion: "1",
    civId: "civ_a",
    keyId: "key_a",
    hmacSecret: "secret",
    displayName: "Civ A",
    heartbeatIntervalMs: 30_000,
    pollIntervalMs: 10_000,
    outboxIntervalMs: 5_000,
    social: defaultSocialConfig({ enabled: true })
  };
}

function seedSimulation(): Simulation {
  const now = new Date(0).toISOString();
  return { id: SIM_ID, turn: 7, running: true, createdAt: now, updatedAt: now, governance: { treasury: 0, params: {} as never, laws: [], violations: [] }, config: {} as never };
}

function socialCommand(): Command {
  return {
    id: "evt-soc",
    specversion: "1.0",
    type: "world.social.post_created.v1",
    source: "/social",
    datacontenttype: "application/json",
    commandid: "cmd-soc",
    idempotencykey: "idem-soc-1",
    data: { post: { postId: "p1" } }
  } as Command;
}

function unknownCommand(): Command {
  return {
    id: "evt-x",
    specversion: "1.0",
    type: "world.mystery.thing.v1",
    source: "/civilizations/civ_b",
    datacontenttype: "application/json",
    commandid: "cmd-x",
    idempotencykey: "idem-x",
    data: {}
  } as Command;
}

async function newService() {
  const store = new MemorySimulationStore();
  await store.upsertSimulation(seedSimulation());
  const service = new FederationService(store, federationConfig(), new EventBus(), SIM_ID);
  return { store, service };
}

describe("inbound social CloudEvents", () => {
  it("applies a typed social command by freshening the briefing, not by cloning posts into memory", async () => {
    const { service } = await newService();
    const decision = await service.applyInboundCommand(socialCommand());
    expect(decision.status).toBe("applied");
    const snapshot = await service.getSnapshot();
    expect(snapshot.briefing.some((line) => line.includes("World Wire"))).toBe(true);
  });

  it("still rejects a genuinely unknown command type without crashing", async () => {
    const { service } = await newService();
    const decision = await service.applyInboundCommand(unknownCommand());
    expect(decision.status).toBe("rejected");
    expect(decision.detail).toBe("unsupported_command_type");
  });

  it("dedupes a replayed social command", async () => {
    const { service } = await newService();
    await service.applyInboundCommand(socialCommand());
    const again = await service.applyInboundCommand(socialCommand());
    expect(again.status).toBe("duplicate");
  });
});
