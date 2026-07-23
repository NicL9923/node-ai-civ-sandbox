import { describe, expect, it } from "vitest";
import type { Simulation } from "../../shared/types.js";
import type { FederationConfig } from "../config.js";
import { defaultSocialConfig } from "../config.js";
import { EventBus } from "../eventBus.js";
import { MemorySimulationStore } from "../store.js";
import type { SimulationStore } from "../store.js";
import { FederationService } from "./federationService.js";
import type { Command, FederationStateDoc, InboxItemDoc } from "./federationTypes.js";

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
    social: defaultSocialConfig({ enabled: false })
  };
}

function seedSimulation(): Simulation {
  const now = new Date(0).toISOString();
  return {
    id: SIM_ID,
    turn: 2,
    running: true,
    createdAt: now,
    updatedAt: now,
    governance: { treasury: 0, params: {} as never, laws: [], violations: [] },
    config: {} as never
  };
}

function contactCommand(): Command {
  return {
    id: "evt1",
    specversion: "1.0",
    type: "world.civilization.contact.v1",
    source: "/civilizations/civ_b",
    datacontenttype: "application/json",
    commandid: "cmd1",
    idempotencykey: "idem-c1",
    data: { interactionId: "int1", fromCiv: "civ_b", fromDisplayName: "Civ B", greeting: "Hello" }
  } as Command;
}

/** A store that throws on the commitInboundCommand batch exactly once, to simulate a crash mid-apply. */
class CrashOnceStore extends MemorySimulationStore {
  private failNextCommit = false;

  failNextInboundCommit(): void {
    this.failNextCommit = true;
  }

  override async commitInboundCommand(state: FederationStateDoc, inbox: InboxItemDoc): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("injected crash before terminal batch");
    }
    await super.commitInboundCommand(state, inbox);
  }
}

async function newService(store: SimulationStore) {
  await store.upsertSimulation(seedSimulation());
  const service = new FederationService(store, federationConfig(), new EventBus(), SIM_ID);
  return service;
}

describe("inbound apply atomicity (replay never duplicates a world note)", () => {
  it("does not persist the briefing note or dedupe record when the terminal batch fails, then applies exactly once on replay", async () => {
    const store = new CrashOnceStore();
    const service = await newService(store);

    store.failNextInboundCommit();
    await expect(service.applyInboundCommand(contactCommand())).rejects.toThrow(/injected crash/);

    // Crash before the atomic batch: no dedupe record and no world note persisted.
    const afterCrash = await service.getState();
    expect(afterCrash.recentWorldNotes.filter((n) => n.includes("opened contact"))).toHaveLength(0);
    expect(afterCrash.knownCivs).toHaveLength(0);

    // Replay succeeds and applies exactly once.
    const decision = await service.applyInboundCommand(contactCommand());
    expect(decision.status).toBe("applied");
    const afterReplay = await service.getState();
    expect(afterReplay.recentWorldNotes.filter((n) => n.includes("opened contact"))).toHaveLength(1);
    expect(afterReplay.knownCivs.map((c) => c.civId)).toEqual(["civ_b"]);

    // A second replay is a no-op duplicate — still exactly one note.
    const dup = await service.applyInboundCommand(contactCommand());
    expect(dup.status).toBe("duplicate");
    const afterDup = await service.getState();
    expect(afterDup.recentWorldNotes.filter((n) => n.includes("opened contact"))).toHaveLength(1);
  });

  it("commits the briefing note and inbox record together (both present after success)", async () => {
    const store = new MemorySimulationStore();
    const service = await newService(store);
    await service.applyInboundCommand(contactCommand());

    const state = await service.getState();
    expect(state.recentWorldNotes.filter((n) => n.includes("opened contact"))).toHaveLength(1);
    // The dedupe (inbox) record was persisted in the same batch, so a re-pull is a duplicate.
    expect((await service.applyInboundCommand(contactCommand())).status).toBe("duplicate");
  });

  it("crash after the batch but before ACK still yields exactly one effect on re-pull (dedupe by inbox)", async () => {
    // Simulate the connector applying, the batch committing, then a crash before the World ACK: the
    // connector re-pulls the same command and re-applies. The inbox dedupe record from the committed
    // batch makes the re-apply a no-op duplicate, so there is still exactly one world note.
    const store = new MemorySimulationStore();
    const service = await newService(store);
    const first = await service.applyInboundCommand(contactCommand());
    expect(first.status).toBe("applied");
    const rePull = await service.applyInboundCommand(contactCommand());
    expect(rePull.status).toBe("duplicate");
    const state = await service.getState();
    expect(state.recentWorldNotes.filter((n) => n.includes("opened contact"))).toHaveLength(1);
  });

  it("serializes concurrent state writes so a heartbeat markConnection cannot clobber an inbound note", async () => {
    const store = new MemorySimulationStore();
    const service = await newService(store);
    // Fire an inbound apply and a heartbeat-style connection update concurrently. The state mutation
    // lock must serialize them so neither whole-document write clobbers the other's fields.
    await Promise.all([
      service.applyInboundCommand(contactCommand()),
      service.markConnection(true),
      service.refreshDirectory([
        { civId: "civ_c", displayName: "Civ C", protocolVersion: "1.0.0", turn: 1, running: true, population: 1, updatedAt: new Date().toISOString() }
      ])
    ]);
    const state = await service.getState();
    // The inbound world note survived, the connection flag was set, and the directory entry is present.
    expect(state.recentWorldNotes.filter((n) => n.includes("opened contact"))).toHaveLength(1);
    expect(state.connected).toBe(true);
    const ids = state.knownCivs.map((c) => c.civId).sort();
    expect(ids).toContain("civ_b"); // from the inbound contact
    expect(ids).toContain("civ_c"); // from the directory refresh
  });
});
