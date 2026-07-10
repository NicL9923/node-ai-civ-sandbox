import { describe, expect, it } from "vitest";
import type { Simulation } from "../../shared/types.js";
import type { FederationConfig } from "../config.js";
import { EventBus } from "../eventBus.js";
import { MemorySimulationStore } from "../store.js";
import { FederationService } from "./federationService.js";
import { safeFederationId } from "./federationIds.js";
import { FEDERATION_STATE_ID, type Command, type FederationStateDoc } from "./federationTypes.js";

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
    turn: 3,
    running: true,
    createdAt: now,
    updatedAt: now,
    governance: { treasury: 0, params: {} as never, laws: [], violations: [] },
    config: {} as never
  };
}

async function newService(config: FederationConfig = federationConfig(), seedState?: FederationStateDoc) {
  const store = new MemorySimulationStore();
  await store.upsertSimulation(seedSimulation());
  if (seedState) {
    await store.putFederationState(seedState);
  }
  const service = new FederationService(store, config, new EventBus(), SIM_ID);
  return { store, service };
}

function persistedState(overrides: Partial<FederationStateDoc>): FederationStateDoc {
  return {
    id: FEDERATION_STATE_ID,
    simulationId: SIM_ID,
    kind: "state",
    displayName: "Civ A",
    registered: true,
    commandCursor: "cursor-42",
    connected: false,
    knownCivs: [],
    recentWorldNotes: [],
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

describe("safeFederationId", () => {
  it("produces a valid Cosmos id (no /, \\, ?, # or unicode) for messy raw keys", () => {
    const raw = "/civilizations/civ_b/events?x=1&y=2#frag:naïve/../é";
    const id = safeFederationId("inbox", raw);
    expect(id).toMatch(/^inbox_[0-9a-f]{64}$/);
    expect(id).not.toMatch(/[/\\?#]/);
  });

  it("is stable for the same raw key and distinct for different keys", () => {
    expect(safeFederationId("inbox", "a/b")).toBe(safeFederationId("inbox", "a/b"));
    expect(safeFederationId("inbox", "a/b")).not.toBe(safeFederationId("inbox", "a/c"));
  });
});

describe("inbound dedupe with unsafe source-derived keys", () => {
  function commandWithSourceKey(source: string, id: string): Command {
    // No idempotencykey -> the service derives the dedupe key from `${source}:${id}`, which contains
    // slashes/query and would be an invalid Cosmos id if used raw.
    return {
      id,
      specversion: "1.0",
      type: "world.civilization.contact.v1",
      source,
      datacontenttype: "application/json",
      commandid: "cmd-x",
      data: { interactionId: "int1", fromCiv: "civ_b", fromDisplayName: "Civ B", greeting: "Hi" }
    } as Command;
  }

  it("stores a valid safe id, retains the raw key, and dedupes replays", async () => {
    const { store, service } = await newService();
    const command = commandWithSourceKey("/civilizations/civ_b/commands?after=abc", "évt-1");

    const first = await service.applyInboundCommand(command);
    expect(first.status).toBe("applied");
    const second = await service.applyInboundCommand(command);
    expect(second.status).toBe("duplicate");

    const rawKey = "/civilizations/civ_b/commands?after=abc:évt-1";
    const inboxId = safeFederationId("inbox", rawKey);
    const inbox = await store.getInboxItem(SIM_ID, inboxId);
    expect(inbox).toBeDefined();
    expect(inbox?.id).toMatch(/^inbox_[0-9a-f]{64}$/);
    // The raw logical key is kept as a property for diagnostics, never as the id.
    expect(inbox?.dedupeKey).toBe(rawKey);

    // Exactly one citizen-visible event with a safe deterministic id.
    const events = (await store.listRecentEvents(SIM_ID, 50)).filter((e) => e.type === "foreignContactReceived");
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(safeFederationId("event_fed", rawKey));
  });
});

describe("FederationService identity reconciliation", () => {
  it("registration mode: uses the persisted assigned identity", async () => {
    const config = federationConfig({ civId: undefined, keyId: undefined, onboardingToken: "tok" });
    const { service } = await newService(config, persistedState({ civId: "civ_assigned", keyId: "key_assigned" }));
    const state = await service.ensureState();
    expect(state.civId).toBe("civ_assigned");
    expect(state.keyId).toBe("key_assigned");
    expect(state.commandCursor).toBe("cursor-42");
  });

  it("registration mode with no persisted identity: starts unregistered", async () => {
    const config = federationConfig({ civId: undefined, keyId: undefined, onboardingToken: "tok" });
    const { service } = await newService(config);
    const state = await service.ensureState();
    expect(state.registered).toBe(false);
    expect(state.civId).toBeUndefined();
  });

  it("explicit mode, same civId, rotated keyId: adopts the new keyId and preserves cursor", async () => {
    const config = federationConfig({ civId: "civ_a", keyId: "key_v2" });
    const { service } = await newService(config, persistedState({ civId: "civ_a", keyId: "key_v1", commandCursor: "cursor-42" }));
    const state = await service.ensureState();
    expect(state.keyId).toBe("key_v2");
    expect(state.civId).toBe("civ_a");
    expect(state.commandCursor).toBe("cursor-42");
  });

  it("explicit mode, differing civId: FAILS CLOSED without leaking the secret", async () => {
    const config = federationConfig({ civId: "civ_new", keyId: "key_a", hmacSecret: "super-secret" });
    const { service } = await newService(config, persistedState({ civId: "civ_old", keyId: "key_a" }));
    await expect(service.ensureState()).rejects.toThrow(/identity mismatch/i);
    try {
      await service.ensureState();
      throw new Error("expected throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret");
    }
  });

  it("explicit mode adopts identity when persisted had none yet, preserving cursor/outbox", async () => {
    const config = federationConfig({ civId: "civ_a", keyId: "key_a" });
    const { service } = await newService(config, persistedState({ civId: undefined, keyId: undefined, registered: false, commandCursor: "cursor-42" }));
    const state = await service.ensureState();
    expect(state.civId).toBe("civ_a");
    expect(state.keyId).toBe("key_a");
    expect(state.registered).toBe(true);
    expect(state.commandCursor).toBe("cursor-42");
  });
});
