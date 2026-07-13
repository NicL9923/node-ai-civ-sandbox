import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig, FederationConfig } from "../config.js";
import { createAiProvider } from "../aiProvider.js";
import { EventBus } from "../eventBus.js";
import { SimulationEngine } from "../simulation.js";
import { MemorySimulationStore } from "../store.js";
import type { Simulation } from "../../shared/types.js";
import { FederationConnector } from "./federationConnector.js";
import { FederationService } from "./federationService.js";
import type { Command } from "./federationTypes.js";
import { sign } from "./hmac.js";

const SECRET = "s3cr3t-hmac-key-v1";

/** A minimal in-process World that verifies HMAC signatures and records what the connector sends. */
class MockWorld {
  private server: http.Server | undefined;
  port = 0;
  heartbeats: unknown[] = [];
  acks: Array<{ commandId: string; status: string }> = [];
  events: unknown[] = [];
  interactions: unknown[] = [];
  registrations: unknown[] = [];
  private commandsServed = false;
  commandsPage: Command[] = [];
  /**
   * Optional scripted responses for GET /civilizations, keyed by the `after` cursor ("" for the first
   * page). When set, the mock serves these instead of the default single page. A value of `"__fail__"`
   * makes that page respond 500. `dirCalls` records the cursors requested, in order.
   */
  directoryPages?: Record<string, { items: unknown[]; nextCursor: string | null } | "__fail__">;
  dirCalls: string[] = [];

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}/world/v1`;
  }

  private verify(req: http.IncomingMessage, body: string): boolean {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const h = req.headers;
    const expected = sign(
      {
        protocolVersion: String(h["x-protocol-version"] ?? ""),
        civId: String(h["x-civ-id"] ?? ""),
        keyId: String(h["x-key-id"] ?? ""),
        timestamp: String(h["x-timestamp"] ?? ""),
        nonce: String(h["x-nonce"] ?? ""),
        idempotencyKey: String(h["idempotency-key"] ?? ""),
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search.startsWith("?") ? url.search.slice(1) : url.search,
        body
      },
      SECRET
    );
    return expected === h["x-signature"];
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      const p = url.pathname;
      const method = req.method ?? "GET";
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (method === "POST" && p.endsWith("/civilizations/register")) {
        this.registrations.push(JSON.parse(body || "{}"));
        json(201, { civId: "civ_a", keyId: "key_a", protocolVersion: "1", registeredAt: new Date().toISOString(), duplicate: false, commandsCursor: null });
        return;
      }
      if (method === "GET" && p.endsWith("/civilizations")) {
        if (this.directoryPages) {
          const after = url.searchParams.get("after") ?? "";
          this.dirCalls.push(after);
          const page = this.directoryPages[after];
          if (page === "__fail__") {
            json(500, { type: "about:blank", title: "Internal Error", code: "boom", retryable: true });
            return;
          }
          if (!page) {
            json(200, { items: [], nextCursor: null });
            return;
          }
          json(200, page);
          return;
        }
        json(200, { items: [{ civId: "civ_b", displayName: "Civ B", protocolVersion: "1.0.0", turn: 3, running: true, population: 2, updatedAt: new Date().toISOString() }], nextCursor: null });
        return;
      }
      // All remaining endpoints are authenticated.
      if (!this.verify(req, body)) {
        json(401, { type: "about:blank", title: "Unauthorized", code: "bad_signature", retryable: false });
        return;
      }
      if (method === "POST" && p.endsWith("/heartbeat")) {
        this.heartbeats.push(JSON.parse(body || "{}"));
        json(200, { civId: "civ_a", serverTime: new Date().toISOString() });
        return;
      }
      if (method === "GET" && p.endsWith("/commands")) {
        if (!this.commandsServed) {
          this.commandsServed = true;
          json(200, { items: this.commandsPage, nextCursor: "cursor-1" });
        } else {
          json(200, { items: [], nextCursor: null });
        }
        return;
      }
      const ackMatch = p.match(/\/commands\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const parsed = JSON.parse(body || "{}") as { status: string };
        this.acks.push({ commandId: ackMatch[1] ?? "", status: parsed.status });
        json(200, { commandId: ackMatch[1], status: parsed.status, duplicate: false, acknowledgedAt: new Date().toISOString() });
        return;
      }
      if (method === "POST" && p.endsWith("/events/batch")) {
        const parsed = JSON.parse(body || "{}") as { events: Array<{ id: string }> };
        this.events.push(parsed);
        json(200, { acceptedCount: parsed.events.length, results: parsed.events.map((e) => ({ id: e.id, status: "accepted" })) });
        return;
      }
      if (method === "POST" && p.endsWith("/interactions")) {
        this.interactions.push(JSON.parse(body || "{}"));
        json(202, { status: "accepted", resourceId: "int_1", statusUrl: "/world/v1/interactions/int_1", duplicate: false });
        return;
      }
      json(404, { type: "about:blank", title: "Not Found", code: "not_found", retryable: false });
    });
  }
}

function federationConfig(overrides: Partial<FederationConfig> = {}): FederationConfig {
  return {
    apiBaseUrl: "https://world.example/world/v1",
    protocolVersion: "1",
    civId: "civ_a",
    keyId: "key_a",
    hmacSecret: SECRET,
    displayName: "Civ A",
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 60_000,
    outboxIntervalMs: 60_000,
    ...overrides
  };
}

function seedSimulation(): Simulation {
  const now = new Date(0).toISOString();
  return {
    id: "default",
    turn: 4,
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

function unknownCommand(): Command {
  return {
    id: "evt2",
    specversion: "1.0",
    type: "world.civilization.trade.v1",
    source: "/civilizations/civ_b",
    datacontenttype: "application/json",
    commandid: "cmd2",
    idempotencykey: "idem-u1",
    data: { foo: "bar" }
  } as Command;
}

async function newServiceAndConnector(config: FederationConfig) {
  const store = new MemorySimulationStore();
  await store.upsertSimulation(seedSimulation());
  const service = new FederationService(store, config, new EventBus(), "default");
  const connector = new FederationConnector(service, config, () => undefined);
  return { store, service, connector };
}

let world: MockWorld;

beforeEach(async () => {
  world = new MockWorld();
  await world.start();
});

afterEach(async () => {
  await world.stop();
});

describe("FederationConnector against a mock World", () => {
  it("heartbeats (signed) and refreshes the civ directory", async () => {
    const { service, connector } = await newServiceAndConnector(federationConfig({ apiBaseUrl: world.baseUrl() }));
    await connector.heartbeat();
    expect(world.heartbeats).toHaveLength(1);
    expect(await service.isKnownCiv("civ_b")).toBe(true);
  });

  it("refreshes the directory across multiple pages, filtering self", async () => {
    const proj = (civId: string) => ({ civId, displayName: civId.toUpperCase(), protocolVersion: "1.0.0", turn: 1, running: true, population: 1, updatedAt: new Date().toISOString() });
    world.directoryPages = {
      "": { items: [proj("civ_a"), proj("civ_b")], nextCursor: "p2" },
      p2: { items: [proj("civ_c")], nextCursor: "p3" },
      p3: { items: [proj("civ_d")], nextCursor: null }
    };
    const { service, connector } = await newServiceAndConnector(federationConfig({ apiBaseUrl: world.baseUrl() }));
    await connector.refreshDirectory();
    const snapshot = await service.getSnapshot();
    const ids = snapshot.knownCivilizations.map((c) => c.civId).sort();
    expect(ids).toEqual(["civ_b", "civ_c", "civ_d"]); // civ_a (self) filtered out
    expect(world.dirCalls).toEqual(["", "p2", "p3"]);
  });

  it("preserves the last-known directory when a later page fails (no partial overwrite)", async () => {
    const proj = (civId: string) => ({ civId, displayName: civId.toUpperCase(), protocolVersion: "1.0.0", turn: 1, running: true, population: 1, updatedAt: new Date().toISOString() });
    const { service, connector } = await newServiceAndConnector(federationConfig({ apiBaseUrl: world.baseUrl() }));
    // First refresh succeeds and caches civ_b.
    world.directoryPages = { "": { items: [proj("civ_b")], nextCursor: null } };
    await connector.refreshDirectory();
    expect((await service.getSnapshot()).knownCivilizations.map((c) => c.civId)).toEqual(["civ_b"]);
    // Second refresh: page 2 fails. Cache must be preserved (not partially overwritten with civ_x).
    world.directoryPages = { "": { items: [proj("civ_x")], nextCursor: "p2" }, p2: "__fail__" };
    await expect(connector.refreshDirectory()).rejects.toThrow();
    expect((await service.getSnapshot()).knownCivilizations.map((c) => c.civId)).toEqual(["civ_b"]);
  });

  it("aborts and preserves cache when the directory cursor cycles", async () => {
    const proj = (civId: string) => ({ civId, displayName: civId.toUpperCase(), protocolVersion: "1.0.0", turn: 1, running: true, population: 1, updatedAt: new Date().toISOString() });
    const { service, connector } = await newServiceAndConnector(federationConfig({ apiBaseUrl: world.baseUrl() }));
    // Page 2 points back to itself -> cycle. Nothing should be committed.
    world.directoryPages = { "": { items: [proj("civ_b")], nextCursor: "loop" }, loop: { items: [proj("civ_c")], nextCursor: "loop" } };
    await connector.refreshDirectory();
    expect((await service.getSnapshot()).knownCivilizations).toHaveLength(0);
  });

  it("flushes outbox events and interactions with stable idempotency keys", async () => {
    const { service, connector } = await newServiceAndConnector(federationConfig({ apiBaseUrl: world.baseUrl() }));
    await service.exportLocalEvent({ id: "e1", type: "lawEnacted", message: "A law", simulationId: "default", turn: 1, createdAt: new Date(0).toISOString() });
    await service.submitInteraction({
      idempotencyKey: "intent:default:agent_a:contact:civ_b:4",
      kind: "contact",
      source: "civ_a",
      target: "civ_b",
      authorityDecision: { mode: "president", ref: "term-1" },
      payload: { greeting: "hi" }
    });
    await connector.flushOutbox();
    expect(world.events).toHaveLength(1);
    expect(world.interactions).toHaveLength(1);
    expect(await service.listPendingOutbox()).toHaveLength(0);
  });

  it("pulls commands, applies+acks each, advances the cursor only after acking, and dedupes", async () => {
    const config = federationConfig({ apiBaseUrl: world.baseUrl() });
    world.commandsPage = [contactCommand(), unknownCommand()];
    const { service, connector } = await newServiceAndConnector(config);

    await connector.pollAndAck();
    expect(world.acks).toHaveLength(2);
    expect(world.acks.map((a) => a.status).sort()).toEqual(["applied", "rejected"]);
    expect((await service.getState()).commandCursor).toBe("cursor-1");
    expect(await service.isKnownCiv("civ_b")).toBe(true);

    // Second pull returns an empty page with nextCursor=null (caught up); nothing is re-applied or
    // re-acked, and the cursor must NOT reset to the beginning.
    await connector.pollAndAck();
    expect(world.acks).toHaveLength(2);
    expect((await service.getState()).commandCursor).toBe("cursor-1");
  });

  it("registers via onboarding token and then signs with the assigned key", async () => {
    const config = federationConfig({ apiBaseUrl: world.baseUrl(), civId: undefined, keyId: undefined, onboardingToken: "tok-1" });
    const { service, connector } = await newServiceAndConnector(config);
    await connector.register();
    expect(world.registrations).toHaveLength(1);
    const state = await service.getState();
    expect(state.registered).toBe(true);
    expect(state.civId).toBe("civ_a");

    await connector.heartbeat();
    expect(world.heartbeats).toHaveLength(1);
  });

  it("tolerates World downtime at start without throwing", async () => {
    await world.stop(); // World is now unreachable
    const config = federationConfig({ apiBaseUrl: `http://127.0.0.1:${world.port}/world/v1` });
    const { connector } = await newServiceAndConnector(config);
    await expect(connector.start()).resolves.toBeUndefined();
    connector.stop();
    // restart a server so afterEach stop() is a no-op-safe close
    world = new MockWorld();
    await world.start();
  });
});

describe("engine turns never depend on the World", () => {
  function appConfig(federation: FederationConfig): AppConfig {
    return {
      port: 3000,
      simulationId: "default",
      autoStart: false,
      adminApiKey: "k",
      simulation: {
        worldSize: 8, actorsPerTurn: 2, turnIntervalMs: 30_000, proposalVotingWindowTurns: 20,
        quorumRatio: 0.5, supermajorityRatio: 2 / 3, maxConsecutiveConverses: 3, conversationSilenceThreshold: 8,
        startResources: 10, upkeepPerAction: 1, gatherYield: 3, gatherBase: 1, tileMaxProductivity: 6, tileRegenInterval: 4, electionWindowTurns: 6
      },
      governanceDefaults: {
        presidentTermTurns: 30, presidentCanTax: true, presidentCanSpend: true, presidentCanFine: true,
        presidentCanPardon: true, presidentCanDecree: true, taxCapPerAction: 2, fineMax: 4, proposalCost: 2, changeTileCost: 2
      },
      ai: { provider: "mock", deployments: { "gpt-5.4": "gpt-5.4", "grok-4.3": "grok-4.3", "deepseek-v4-pro": "d", "kimi-k2.6": "k" }, requestTimeoutMs: 20_000, maxOutputTokens: 700 },
      federation,
      telemetry: {}
    };
  }

  it("advances a turn even when the World is unreachable (no network in the turn path)", async () => {
    // Point the connector at an unreachable World; the engine only touches the store-backed service.
    const config = appConfig(federationConfig({ apiBaseUrl: "http://127.0.0.1:1/world/v1" }));
    const store = new MemorySimulationStore();
    const service = new FederationService(store, config.federation!, new EventBus(), "default");
    const engine = new SimulationEngine(config, store, createAiProvider(config.ai), new EventBus(), service);

    await engine.start();
    engine.shutdown();
    await expect(engine.advanceTurn()).resolves.toBeUndefined();

    const snapshot = await engine.snapshot();
    expect(snapshot.foreignAffairs?.enabled).toBe(true);
    expect(snapshot.simulation.turn).toBeGreaterThan(0);
  });
});
