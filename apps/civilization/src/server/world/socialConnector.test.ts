import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProfile, Simulation } from "../../shared/types.js";
import { defaultSocialConfig, type FederationConfig } from "../config.js";
import { EventBus } from "../eventBus.js";
import { MemorySimulationStore } from "../store.js";
import { FederationConnector } from "./federationConnector.js";
import { FederationService } from "./federationService.js";
import { SocialService } from "./socialService.js";
import { FEDERATION_STATE_ID, type FederationStateDoc } from "./federationTypes.js";

const SIM_ID = "default";

/** A minimal in-process World exposing the social endpoints the connector calls. */
class MockSocialWorld {
  private server: http.Server | undefined;
  port = 0;
  syncs: Array<{ accounts: Array<{ actor: { kind: string } }> }> = [];
  posts: Array<{ body: unknown; idempotencyKey: string }> = [];
  likes: unknown[] = [];
  follows: unknown[] = [];
  eventsBatches: unknown[] = [];
  feedItems: unknown[] = [];
  /** When >0, the next N POST /social/posts calls answer 429 with this Retry-After (seconds). */
  postRateLimit = 0;
  retryAfterSeconds = 5;

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

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      const p = url.pathname;
      const method = req.method ?? "GET";
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      const idem = String(req.headers["idempotency-key"] ?? "");

      if (method === "POST" && p.endsWith("/social/accounts/sync")) {
        const parsed = JSON.parse(body || "{}") as { accounts: Array<{ actor: { kind: string; displayName: string; civId: string } }> };
        this.syncs.push(parsed);
        const accounts = parsed.accounts.map((upsert, index) => ({
          accountId: `acct_${index}`,
          actor: upsert.actor,
          status: "active",
          bio: "",
          followerCount: 0,
          followingCount: 0,
          postCount: 0,
          rateLimitPolicy: { postCooldownSeconds: 1, postsPerWindow: 10, reactionsPerWindow: 50, followsPerWindow: 50, windowSeconds: 60 },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          worldsequence: "1"
        }));
        json(200, { accounts });
        return;
      }
      if (method === "GET" && p.endsWith("/social/feed")) {
        json(200, { items: this.feedItems, nextCursor: null });
        return;
      }
      if (method === "POST" && p.endsWith("/social/posts")) {
        if (this.postRateLimit > 0) {
          this.postRateLimit -= 1;
          json(429, { type: "about:blank", title: "Too Many Requests", code: "rate_limited" }, { "Retry-After": String(this.retryAfterSeconds) });
          return;
        }
        this.posts.push({ body: JSON.parse(body || "{}"), idempotencyKey: idem });
        json(201, this.samplePost());
        return;
      }
      const likeMatch = p.match(/\/social\/posts\/([^/]+)\/likes\/([^/]+)$/);
      if (method === "PUT" && likeMatch) {
        this.likes.push(JSON.parse(body || "{}"));
        json(200, { postId: likeMatch[1], accountId: likeMatch[2], liked: true, changed: true, likeCount: 1, updatedAt: new Date(0).toISOString(), worldsequence: "2" });
        return;
      }
      const followMatch = p.match(/\/social\/accounts\/([^/]+)\/following\/([^/]+)$/);
      if (method === "PUT" && followMatch) {
        this.follows.push(JSON.parse(body || "{}"));
        json(200, { followerAccountId: followMatch[1], followedAccountId: followMatch[2], following: true, changed: true, updatedAt: new Date(0).toISOString(), worldsequence: "3" });
        return;
      }
      if (method === "POST" && p.endsWith("/events/batch")) {
        this.eventsBatches.push(JSON.parse(body || "{}"));
        json(200, { acceptedCount: 0, results: [] });
        return;
      }
      json(404, { type: "about:blank", title: "Not Found", code: "not_found" });
    });
  }

  private samplePost() {
    return {
      postId: "post_1",
      author: { accountId: "acct_0", actor: { civId: "civ_a", displayName: "Ada", kind: "agent", localAgentId: "a1" }, status: "active" },
      status: "published",
      text: "hello",
      parentPostId: null,
      conversationRootPostId: "post_1",
      replyDepth: 0,
      replyCount: 0,
      likeCount: 0,
      createdAt: new Date(0).toISOString(),
      tombstonedAt: null,
      worldsequence: "10"
    };
  }
}

function config(baseUrl: string, overrides: Partial<ReturnType<typeof defaultSocialConfig>> = {}): FederationConfig {
  return {
    apiBaseUrl: baseUrl,
    protocolVersion: "1",
    civId: "civ_a",
    keyId: "key_a",
    hmacSecret: "s3cr3t-hmac-key-v1",
    displayName: "Civ A",
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 60_000,
    outboxIntervalMs: 60_000,
    social: defaultSocialConfig({ enabled: true, syncDebounceMs: 0, maxRetryAfterMs: 60_000, ...overrides })
  };
}

function agent(id: string, name: string): AgentProfile {
  const now = new Date(0).toISOString();
  return { id, simulationId: SIM_ID, name, model: "gpt-5.4", active: true, position: { x: 0, y: 0 }, resources: 5, corePrinciples: [], personalityTraits: [], beliefs: [], goals: [], memorySummaries: [], relationships: [], createdAt: now, updatedAt: now };
}

function seedSimulation(): Simulation {
  const now = new Date(0).toISOString();
  return { id: SIM_ID, turn: 5, running: true, createdAt: now, updatedAt: now, governance: { treasury: 0, params: {} as never, laws: [], violations: [], president: { agentId: "a1", termStartedTurn: 1, termNumber: 1 } }, config: {} as never };
}

async function setup(world: MockSocialWorld, overrides: Partial<ReturnType<typeof defaultSocialConfig>> = {}) {
  const store = new MemorySimulationStore();
  await store.upsertSimulation(seedSimulation());
  await store.upsertAgent(agent("a1", "Ada"));
  await store.upsertAgent(agent("a2", "Ben"));
  const state: FederationStateDoc = { id: FEDERATION_STATE_ID, simulationId: SIM_ID, kind: "state", civId: "civ_a", keyId: "key_a", displayName: "Civ A", registered: true, connected: true, knownCivs: [], recentWorldNotes: [], updatedAt: new Date(0).toISOString() };
  await store.putFederationState(state);
  const cfg = config(world.baseUrl(), overrides);
  const service = new FederationService(store, cfg, new EventBus(), SIM_ID);
  const social = new SocialService(store, cfg, SIM_ID);
  const connector = new FederationConnector(service, cfg, () => undefined, social);
  return { store, service, social, connector };
}

let world: MockSocialWorld;

beforeEach(async () => {
  world = new MockSocialWorld();
  await world.start();
});

afterEach(async () => {
  await world.stop();
});

describe("FederationConnector — World Wire", () => {
  it("syncs accounts and learns their World-owned ids", async () => {
    const { social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    expect(world.syncs).toHaveLength(1);
    const snapshot = await social.getSnapshot();
    expect(snapshot.agentAccounts.a1?.accountId).toBe("acct_0");
    expect(snapshot.officialAccount?.accountId).toBeDefined();
  });

  it("polls the global feed and caches it", async () => {
    const { social, connector } = await setup(world);
    world.feedItems = [
      { postId: "p1", author: { accountId: "acct_x", actor: { civId: "civ_b", displayName: "Ext", kind: "agent", localAgentId: "x" }, status: "active" }, status: "published", text: "hi", parentPostId: null, conversationRootPostId: "p1", replyDepth: 0, replyCount: 0, likeCount: 0, createdAt: new Date(0).toISOString(), tombstonedAt: null, worldsequence: "9" }
    ];
    await connector.pollSocialFeed();
    expect((await social.getSnapshot()).feed[0]?.postId).toBe("p1");
  });

  it("flushes a durable post to /social/posts (never via /events/batch) with a stable idempotency key", async () => {
    const { social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "idem-post-1", text: "gm" });
    await connector.flushOutbox();
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]?.idempotencyKey).toBe("idem-post-1");
    expect(world.eventsBatches).toHaveLength(0);
  });

  it("flushes like and follow mutations to their PUT endpoints", async () => {
    const { social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "il", targetPostId: "post_x", liked: true });
    await social.enqueue({ op: "follow", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "if", targetAccountId: "acct_target", following: true });
    await connector.flushOutbox();
    expect(world.likes).toHaveLength(1);
    expect(world.follows).toHaveLength(1);
    expect((await social.getSnapshot()).follows).toHaveLength(1);
  });

  it("honors a bounded 429 Retry-After without failing the item", async () => {
    const { store, social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    world.postRateLimit = 1;
    world.retryAfterSeconds = 5;
    await social.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "rl", text: "gm" });
    const before = Date.now();
    await connector.flushOutbox();

    const [item] = await store.listOutbox(SIM_ID, ["pending"]);
    expect(item).toBeDefined();
    expect(item?.status).toBe("pending");
    expect(item?.attempts).toBe(1);
    const waitMs = new Date(item!.nextAttemptAt!).getTime() - before;
    // ~5s Retry-After, comfortably under the maxRetryAfterMs bound.
    expect(waitMs).toBeGreaterThan(3_000);
    expect(waitMs).toBeLessThanOrEqual(60_000);
    expect(world.posts).toHaveLength(0);
  });

  it("clamps an oversized Retry-After to maxRetryAfterMs", async () => {
    const { store, social, connector } = await setup(world, { maxRetryAfterMs: 2_000 });
    await connector.syncSocialAccounts();
    world.postRateLimit = 1;
    world.retryAfterSeconds = 3_600; // 1 hour, far above the 2s bound
    await social.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "rl2", text: "gm" });
    const before = Date.now();
    await connector.flushOutbox();
    const [item] = await store.listOutbox(SIM_ID, ["pending"]);
    const waitMs = new Date(item!.nextAttemptAt!).getTime() - before;
    // Clamped from a 1-hour Retry-After down to the ~2s bound (small wall-clock drift allowed).
    expect(waitMs).toBeLessThanOrEqual(5_000);
  });
});
