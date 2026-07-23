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
  /** Every like/follow attempt in order, including those answered 429 (to assert delivery ordering). */
  likeRequests: Array<{ liked: boolean }> = [];
  followRequests: Array<{ following: boolean }> = [];
  eventsBatches: unknown[] = [];
  feedItems: unknown[] = [];
  /** When >0, the next N POST /social/posts calls answer 429 with this Retry-After (seconds). */
  postRateLimit = 0;
  /** When >0, the next N PUT like calls answer 429. */
  likeRateLimit = 0;
  /** When >0, the next N PUT follow calls answer 429. */
  followRateLimit = 0;
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
        const parsed = JSON.parse(body || "{}") as { liked: boolean };
        this.likeRequests.push({ liked: parsed.liked });
        if (this.likeRateLimit > 0) {
          this.likeRateLimit -= 1;
          json(429, { type: "about:blank", title: "Too Many Requests", code: "rate_limited" }, { "Retry-After": String(this.retryAfterSeconds) });
          return;
        }
        this.likes.push(parsed);
        json(200, { postId: likeMatch[1], accountId: likeMatch[2], liked: parsed.liked, changed: true, likeCount: 1, updatedAt: new Date(0).toISOString(), worldsequence: "2" });
        return;
      }
      const followMatch = p.match(/\/social\/accounts\/([^/]+)\/following\/([^/]+)$/);
      if (method === "PUT" && followMatch) {
        const parsed = JSON.parse(body || "{}") as { following: boolean };
        this.followRequests.push({ following: parsed.following });
        if (this.followRateLimit > 0) {
          this.followRateLimit -= 1;
          json(429, { type: "about:blank", title: "Too Many Requests", code: "rate_limited" }, { "Retry-After": String(this.retryAfterSeconds) });
          return;
        }
        this.follows.push(parsed);
        json(200, { followerAccountId: followMatch[1], followedAccountId: followMatch[2], following: parsed.following, changed: true, updatedAt: new Date(0).toISOString(), worldsequence: "3" });
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

  // --- FIFO-per-target desired-state ordering (regression) -------------------

  /** Pin a durable causal order onto two same-target intents so createdAt is deterministic. */
  async function pinOrder(store: MemorySimulationStore, match: (p: { op: string; liked?: boolean; following?: boolean }) => boolean, iso: string) {
    for (const item of await store.listOutbox(SIM_ID)) {
      if (item.itemKind === "social" && match(item.payload as { op: string })) {
        item.createdAt = iso;
        await store.putOutboxItem(item);
      }
    }
  }

  /** Force any backoff on matching items to be due (nextAttemptAt in the past). */
  async function expireBackoff(store: MemorySimulationStore) {
    for (const item of await store.listOutbox(SIM_ID, ["pending"])) {
      if (item.nextAttemptAt) {
        item.nextAttemptAt = "2000-01-01T00:00:00.000Z";
        await store.putOutboxItem(item);
      }
    }
  }

  it("keeps FIFO per like target so a newer unlike never regresses to an older like", async () => {
    const { store, social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "like-true", targetPostId: "pX", liked: true });
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "like-false", targetPostId: "pX", liked: false });
    await pinOrder(store, (p) => p.op === "like" && p.liked === true, "2020-01-01T00:00:00.000Z");
    await pinOrder(store, (p) => p.op === "like" && p.liked === false, "2020-01-01T00:00:01.000Z");

    // Cycle 1: the older like=true gets 429'd; the newer like=false MUST NOT overtake it.
    world.likeRateLimit = 1;
    world.retryAfterSeconds = 5;
    await connector.flushOutbox();
    expect(world.likeRequests.map((r) => r.liked)).toEqual([true]);

    // Cycle 2: once the older is due and succeeds, both send in FIFO order and final state is false.
    await expireBackoff(store);
    await connector.flushOutbox();
    expect(world.likeRequests.map((r) => r.liked)).toEqual([true, true, false]);
    expect(world.likes.map((l) => (l as { liked: boolean }).liked)).toEqual([true, false]);
  });

  it("keeps FIFO per follow target so a newer unfollow never regresses to an older follow", async () => {
    const { store, social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "follow", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "f-true", targetAccountId: "acct_t", following: true });
    await social.enqueue({ op: "follow", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "f-false", targetAccountId: "acct_t", following: false });
    await pinOrder(store, (p) => p.op === "follow" && p.following === true, "2020-01-01T00:00:00.000Z");
    await pinOrder(store, (p) => p.op === "follow" && p.following === false, "2020-01-01T00:00:01.000Z");

    world.followRateLimit = 1;
    await connector.flushOutbox();
    expect(world.followRequests.map((r) => r.following)).toEqual([true]);

    await expireBackoff(store);
    await connector.flushOutbox();
    expect(world.follows.map((f) => (f as { following: boolean }).following)).toEqual([true, false]);
  });

  it("blocks the newer same-key intent across multiple transient failures of the older one", async () => {
    const { store, social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "lt", targetPostId: "pY", liked: true });
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "lf", targetPostId: "pY", liked: false });
    await pinOrder(store, (p) => p.op === "like" && p.liked === true, "2020-01-01T00:00:00.000Z");
    await pinOrder(store, (p) => p.op === "like" && p.liked === false, "2020-01-01T00:00:01.000Z");

    world.likeRateLimit = 2; // the older like=true 429s twice before succeeding
    await connector.flushOutbox();
    await expireBackoff(store);
    await connector.flushOutbox();
    // Two transient failures of the older intent; the newer unlike stayed blocked both cycles.
    expect(world.likeRequests.map((r) => r.liked)).toEqual([true, true]);
    expect(world.likes).toHaveLength(0);

    await expireBackoff(store);
    await connector.flushOutbox();
    // Subsequent cycle: older succeeds, then newer sends; final state is false.
    expect(world.likeRequests.map((r) => r.liked)).toEqual([true, true, true, false]);
    expect(world.likes.map((l) => (l as { liked: boolean }).liked)).toEqual([true, false]);
  });

  it("lets unrelated targets and posts progress while one desired-state key is blocked", async () => {
    const { social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "blk", targetPostId: "pBlocked", liked: true });
    await social.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "pst", text: "still posting" });
    await social.enqueue({ op: "follow", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "flw", targetAccountId: "acct_other", following: true });

    world.likeRateLimit = 1; // block only the like target
    await connector.flushOutbox();
    expect(world.likes).toHaveLength(0); // like was 429'd/blocked
    expect(world.posts).toHaveLength(1); // unrelated post still sent
    expect(world.follows).toHaveLength(1); // unrelated follow target still sent
  });

  it("uses the enqueue seq to keep FIFO even when two same-target toggles share a createdAt", async () => {
    const { store, social, connector } = await setup(world);
    await connector.syncSocialAccounts();
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "seq-true", targetPostId: "pZ", liked: true });
    await social.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "seq-false", targetPostId: "pZ", liked: false });
    // Force an EXACT createdAt tie so ordering must fall through to the monotonic enqueue seq.
    await pinOrder(store, (p) => p.op === "like", "2020-01-01T00:00:00.000Z");
    const seqs = (await store.listOutbox(SIM_ID)).filter((i) => i.itemKind === "social").map((i) => i.seq);
    expect(seqs.every((s) => typeof s === "number")).toBe(true);

    await connector.flushOutbox();
    // true was enqueued first (lower seq), so despite the createdAt tie it is delivered before false.
    expect(world.likes.map((l) => (l as { liked: boolean }).liked)).toEqual([true, false]);
  });
});
