import { describe, expect, it } from "vitest";
import type { Simulation } from "../../shared/types.js";
import type { FederationConfig } from "../config.js";
import { EventBus } from "../eventBus.js";
import { MemorySimulationStore } from "../store.js";
import { FederationService } from "./federationService.js";
import type { Command } from "./federationTypes.js";

const SIM_ID = "default";

function federationConfig(overrides: Partial<FederationConfig> = {}): FederationConfig {
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
    ...overrides
  };
}

function seedSimulation(): Simulation {
  const now = new Date(0).toISOString();
  return {
    id: SIM_ID,
    turn: 7,
    running: true,
    createdAt: now,
    updatedAt: now,
    governance: { treasury: 0, params: {} as never, laws: [], violations: [] },
    config: {} as never
  };
}

async function newService(config: FederationConfig = federationConfig()) {
  const store = new MemorySimulationStore();
  await store.upsertSimulation(seedSimulation());
  const service = new FederationService(store, config, new EventBus(), SIM_ID);
  return { store, service };
}

function contactCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "evt1",
    specversion: "1.0",
    type: "world.civilization.contact.v1",
    source: "/civilizations/civ_b",
    datacontenttype: "application/json",
    commandid: "cmd1",
    idempotencykey: "idem-1",
    data: { interactionId: "int1", fromCiv: "civ_b", fromDisplayName: "Civ B", greeting: "Greetings" },
    ...overrides
  } as Command;
}

describe("FederationService", () => {
  it("marks state registered when credentials are present", async () => {
    const { service } = await newService();
    const state = await service.ensureState();
    expect(state.registered).toBe(true);
    expect(state.civId).toBe("civ_a");
  });

  it("enqueues an interaction to the outbox with a stable id, and dedupes re-submits", async () => {
    const { store, service } = await newService();
    const input = {
      idempotencyKey: "intent:default:agent_a:contact:civ_b:7",
      kind: "contact" as const,
      source: "civ_a",
      target: "civ_b",
      authorityDecision: { mode: "president", ref: "term-1" },
      publicNarrative: "President opened contact.",
      payload: { greeting: "hello" }
    };
    await service.submitInteraction(input);
    await service.submitInteraction(input);
    const outbox = await store.listOutbox(SIM_ID);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.itemKind).toBe("interaction");
    expect(outbox[0]?.idempotencyKey).toBe(input.idempotencyKey);
    expect(outbox[0]?.status).toBe("pending");
  });

  it("exports only allowlisted events as CloudEvents", async () => {
    const { store, service } = await newService();
    const base = { simulationId: SIM_ID, turn: 7, createdAt: new Date(0).toISOString() };
    await service.exportLocalEvent({ id: "e1", type: "lawEnacted", message: "Law enacted", ...base });
    await service.exportLocalEvent({ id: "e2", type: "conversation", message: "chatter", ...base });
    const outbox = await store.listOutbox(SIM_ID);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.itemKind).toBe("event");
    expect((outbox[0]?.payload as { type: string }).type).toBe("civ.governance.law_enacted.v1");
  });

  it("applies an inbound contact command idempotently and updates the directory", async () => {
    const { store, service } = await newService();
    const first = await service.applyInboundCommand(contactCommand());
    expect(first.status).toBe("applied");

    const second = await service.applyInboundCommand(contactCommand());
    expect(second.status).toBe("duplicate");

    // Exactly one local event with the deterministic id (re-apply upserts, never duplicates).
    const events = await store.listRecentEvents(SIM_ID, 50);
    const foreign = events.filter((event) => event.type === "foreignContactReceived");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.id).toBe("event_fed_idem-1");

    const known = await service.isKnownCiv("civ_b");
    expect(known).toBe(true);
  });

  it("rejects an unknown command type with a stable reason and does not crash", async () => {
    const { service } = await newService();
    const decision = await service.applyInboundCommand(
      contactCommand({ type: "world.civilization.trade.v1", commandid: "cmd2", idempotencykey: "idem-2" })
    );
    expect(decision.status).toBe("rejected");
    expect(decision.detail).toBe("unsupported_command_type");
  });

  it("produces a citizen-safe snapshot with a compact briefing", async () => {
    const { service } = await newService();
    await service.applyInboundCommand(contactCommand());
    const snapshot = await service.getSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.registered).toBe(true);
    expect(snapshot.knownCivilizations.map((civ) => civ.civId)).toContain("civ_b");
    expect(snapshot.briefing.length).toBeGreaterThan(0);
    expect(snapshot.briefing.length).toBeLessThanOrEqual(6);
    // The snapshot must never carry secret material.
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
});
