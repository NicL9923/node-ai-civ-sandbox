import { describe, expect, it } from "vitest";
import type { AgentProfile, Simulation } from "../../shared/types.js";
import { defaultSocialConfig, type FederationConfig } from "../config.js";
import { MemorySimulationStore } from "../store.js";
import { parseAgentAction } from "../actionSchema.js";
import {
  FEDERATION_STATE_ID,
  type FederationStateDoc,
  type SocialAccount,
  type SocialActorRef,
  type SocialPost
} from "./federationTypes.js";
import { SocialService, type SocialSyncPlan } from "./socialService.js";

const SIM_ID = "default";

function config(overrides: Partial<ReturnType<typeof defaultSocialConfig>> = {}): FederationConfig {
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
    social: defaultSocialConfig({ enabled: true, syncDebounceMs: 0, ...overrides })
  };
}

function agent(id: string, name: string, active = true): AgentProfile {
  const now = new Date(0).toISOString();
  return {
    id,
    simulationId: SIM_ID,
    name,
    model: "gpt-5.4",
    active,
    position: { x: 0, y: 0 },
    resources: 5,
    corePrinciples: ["secret-principle"],
    personalityTraits: ["secret-trait"],
    beliefs: ["secret-belief"],
    goals: ["secret-goal"],
    memorySummaries: ["secret-memory"],
    relationships: [],
    createdAt: now,
    updatedAt: now
  };
}

function seedSimulation(presidentId?: string, termNumber = 1): Simulation {
  const now = new Date(0).toISOString();
  return {
    id: SIM_ID,
    turn: 5,
    running: true,
    createdAt: now,
    updatedAt: now,
    governance: {
      treasury: 0,
      params: {} as never,
      laws: [],
      violations: [],
      president: presidentId ? { agentId: presidentId, termStartedTurn: 1, termNumber } : undefined
    },
    config: {} as never
  };
}

async function seedStore(store: MemorySimulationStore, opts: { agents: AgentProfile[]; presidentId?: string; termNumber?: number; civId?: string }): Promise<void> {
  await store.upsertSimulation(seedSimulation(opts.presidentId, opts.termNumber));
  for (const a of opts.agents) {
    await store.upsertAgent(a);
  }
  if (opts.civId !== undefined) {
    const state: FederationStateDoc = {
      id: FEDERATION_STATE_ID,
      simulationId: SIM_ID,
      kind: "state",
      civId: opts.civId,
      keyId: "key_a",
      displayName: "Civ A",
      registered: true,
      connected: true,
      knownCivs: [],
      recentWorldNotes: [],
      updatedAt: new Date(0).toISOString()
    };
    await store.putFederationState(state);
  }
}

function fakeAccount(accountId: string, actor: SocialActorRef): SocialAccount {
  const now = new Date(0).toISOString();
  return {
    accountId,
    actor,
    status: "active",
    bio: "",
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    rateLimitPolicy: { postCooldownSeconds: 1, postsPerWindow: 10, reactionsPerWindow: 50, followsPerWindow: 50, windowSeconds: 60 },
    createdAt: now,
    updatedAt: now,
    worldsequence: "1"
  };
}

/** Build the SocialAccount[] response for a plan, mirroring request order with synthetic ids. */
function responseFor(plan: SocialSyncPlan): SocialAccount[] {
  return plan.request.accounts.map((upsert, index) => fakeAccount(`acct_${index}_${upsert.actor.kind}`, upsert.actor));
}

async function apply(service: SocialService, plan: SocialSyncPlan): Promise<void> {
  await service.applySyncResult(plan.slots, responseFor(plan), plan.fingerprint);
}

describe("SocialService account sync", () => {
  it("builds a batch of active agents plus one official account bound to the President term", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada"), agent("a2", "Ben")], presidentId: "a1", termNumber: 3, civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);

    const plan = await service.buildSyncPlan();
    expect(plan).toBeDefined();
    const kinds = plan!.request.accounts.map((a) => a.actor.kind);
    expect(kinds.filter((k) => k === "agent")).toHaveLength(2);
    expect(kinds.filter((k) => k === "official")).toHaveLength(1);
    const official = plan!.request.accounts.find((a) => a.actor.kind === "official");
    expect(official?.officialAuthority?.termNumber).toBe(3);
    expect(official?.officialAuthority?.authorityDecision.ref).toBe("term-3");
    // Agent actors carry only citizen-safe identity (civId, localAgentId, displayName, kind).
    const agentUpsert = plan!.request.accounts.find((a) => a.actor.kind === "agent");
    expect(agentUpsert?.actor.localAgentId).toBe("a1");
    expect(agentUpsert?.actor.displayName).toBe("Ada");
  });

  it("returns undefined with no civId (nothing to sync before registration)", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada")], presidentId: "a1" });
    const service = new SocialService(store, config(), SIM_ID);
    expect(await service.buildSyncPlan()).toBeUndefined();
  });

  it("omits the official account while the office is vacant", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada")], civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    const plan = await service.buildSyncPlan();
    expect(plan!.request.accounts.every((a) => a.actor.kind === "agent")).toBe(true);
  });

  it("persists World-owned account ids from the ordered response", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada")], presidentId: "a1", civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    const plan = await service.buildSyncPlan();
    await apply(service, plan!);

    const snapshot = await service.getSnapshot();
    expect(snapshot.agentAccounts.a1?.accountId).toBe("acct_0_agent");
    expect(snapshot.officialAccount?.accountId).toBe("acct_1_official");
    expect(snapshot.officialTermNumber).toBe(1);
  });

  it("keeps a stable official account id across President rotation while updating authority", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada"), agent("a2", "Ben")], presidentId: "a1", termNumber: 1, civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    const plan1 = await service.buildSyncPlan();
    await apply(service, plan1!);
    const firstOfficial = (await service.getSnapshot()).officialAccount?.accountId;

    // Rotate the President: new term ⇒ new fingerprint ⇒ re-sync, but the official slot index is stable.
    await store.upsertSimulation(seedSimulation("a2", 2));
    const plan2 = await service.buildSyncPlan();
    expect(plan2!.fingerprint).not.toBe(plan1!.fingerprint);
    await apply(service, plan2!);

    const after = await service.getSnapshot();
    expect(after.officialAccount?.accountId).toBe(firstOfficial);
    expect(after.officialTermNumber).toBe(2);
  });

  it("drops a deactivated agent from future syncs without deleting its account", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada"), agent("a2", "Ben")], presidentId: "a1", civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    await apply(service, (await service.buildSyncPlan())!);
    expect((await service.getSnapshot()).agentAccounts.a2).toBeDefined();

    // Deactivate Ben; the next plan must not include him.
    await store.upsertAgent(agent("a2", "Ben", false));
    const plan = await service.buildSyncPlan();
    expect(plan!.request.accounts.some((a) => a.actor.localAgentId === "a2")).toBe(false);
    await apply(service, plan!);
    // Ben's local mapping is dropped (we never re-sync him); no delete call is ever emitted.
    expect((await service.getSnapshot()).agentAccounts.a2).toBeUndefined();
  });

  it("debounces and skips re-sync when the fingerprint is unchanged", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada")], presidentId: "a1", civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    const plan = await service.buildSyncPlan();
    await apply(service, plan!);
    expect(await service.shouldSync(plan!.fingerprint)).toBe(false);

    const debounced = new SocialService(store, config({ syncDebounceMs: 10 * 60_000 }), SIM_ID);
    // A changed fingerprint is still gated while the debounce window is open.
    expect(await debounced.shouldSync("different-fingerprint")).toBe(false);
  });

  it("derives a stable idempotency key from the fingerprint", async () => {
    const store = new MemorySimulationStore();
    const service = new SocialService(store, config(), SIM_ID);
    expect(service.syncIdempotencyKey("abc")).toBe(`social-sync:${SIM_ID}:abc`);
  });
});

describe("SocialService mutation enqueue", () => {
  async function synced(): Promise<{ store: MemorySimulationStore; service: SocialService }> {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada"), agent("a2", "Ben")], presidentId: "a1", civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    await apply(service, (await service.buildSyncPlan())!);
    return { store, service };
  }

  it("enqueues a durable post intent from the agent's own account", async () => {
    const { store, service } = await synced();
    const result = await service.enqueue({
      op: "post",
      actingLocalAgentId: "a1",
      useOfficialAccount: false,
      authorityMode: "citizen",
      authorityRef: "agent-a1",
      idempotencyKey: "k1",
      text: "hello world 🌍"
    });
    expect(result.ok).toBe(true);
    const outbox = await store.listOutbox(SIM_ID);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.itemKind).toBe("social");
    const payload = outbox[0]?.payload as { op: string; authorAccountId: string; text: string; authorization: { actingLocalAgentId: string } };
    expect(payload.op).toBe("post");
    expect(payload.authorAccountId).toBe("acct_0_agent");
    expect(payload.text).toBe("hello world 🌍");
    expect(payload.authorization.actingLocalAgentId).toBe("a1");
  });

  it("attaches the official term number when the President posts as the official account", async () => {
    const { store, service } = await synced();
    await service.enqueue({
      op: "post",
      actingLocalAgentId: "a1",
      useOfficialAccount: true,
      authorityMode: "president",
      authorityRef: "term-1",
      idempotencyKey: "k-off",
      text: "an official statement"
    });
    const payload = (await store.listOutbox(SIM_ID))[0]?.payload as { authorAccountId: string; authorization: { officialTermNumber?: number } };
    // Two agents (a1, a2) + official ⇒ the official account is the third slot.
    expect(payload.authorAccountId).toBe("acct_2_official");
    expect(payload.authorization.officialTermNumber).toBe(1);
  });

  it("encodes unlike/unfollow as the boolean desired state", async () => {
    const { store, service } = await synced();
    await service.enqueue({ op: "like", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "kl", targetPostId: "p1", liked: false });
    await service.enqueue({ op: "follow", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "kf", targetAccountId: "acct_0_agent_other", following: false });
    const outbox = await store.listOutbox(SIM_ID);
    const like = outbox.find((i) => (i.payload as { op: string }).op === "like");
    const follow = outbox.find((i) => (i.payload as { op: string }).op === "follow");
    expect((like?.payload as { liked: boolean }).liked).toBe(false);
    expect((follow?.payload as { following: boolean }).following).toBe(false);
  });

  it("is idempotent: re-enqueuing the same key does not duplicate the outbox item", async () => {
    const { store, service } = await synced();
    await service.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "dup", text: "x" });
    await service.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "dup", text: "x" });
    expect(await store.listOutbox(SIM_ID)).toHaveLength(1);
  });

  it("rejects an intent for an unsynced account, a self-follow, and when disabled", async () => {
    const { service } = await synced();
    expect(await service.enqueue({ op: "post", actingLocalAgentId: "ghost", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-ghost", idempotencyKey: "n1", text: "x" })).toEqual({ ok: false, reason: "account_not_synced" });
    expect(await service.enqueue({ op: "follow", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "n2", targetAccountId: "acct_0_agent", following: true })).toEqual({ ok: false, reason: "invalid" });

    const store2 = new MemorySimulationStore();
    await seedStore(store2, { agents: [agent("a1", "Ada")], presidentId: "a1", civId: "civ_a" });
    const disabled = new SocialService(store2, config({ enabled: false }), SIM_ID);
    expect(await disabled.enqueue({ op: "post", actingLocalAgentId: "a1", useOfficialAccount: false, authorityMode: "citizen", authorityRef: "agent-a1", idempotencyKey: "n3", text: "x" })).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("SocialService feed merge and direct replies", () => {
  function post(overrides: Partial<SocialPost> & { postId: string; worldsequence: string }): SocialPost {
    const now = new Date(0).toISOString();
    return {
      postId: overrides.postId,
      author: overrides.author ?? { accountId: "acct_other", actor: { civId: "civ_b", displayName: "Ext", kind: "agent", localAgentId: "x" }, status: "active" },
      status: overrides.status ?? "published",
      text: overrides.text ?? "a post",
      parentPostId: overrides.parentPostId ?? null,
      conversationRootPostId: overrides.conversationRootPostId ?? overrides.postId,
      replyDepth: overrides.replyDepth ?? 0,
      replyCount: overrides.replyCount ?? 0,
      likeCount: overrides.likeCount ?? 0,
      createdAt: now,
      tombstonedAt: overrides.tombstonedAt ?? null,
      worldsequence: overrides.worldsequence
    } as SocialPost;
  }

  it("merges by worldsequence DESC then postId ASC and bounds the cache", async () => {
    const store = new MemorySimulationStore();
    const service = new SocialService(store, config({ feedCacheMax: 2, promptFeedItems: 2 }), SIM_ID);
    await service.applyFeedPage([
      post({ postId: "p1", worldsequence: "10" }),
      post({ postId: "p2", worldsequence: "30" }),
      post({ postId: "p3", worldsequence: "20" })
    ]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.feed.map((f) => f.postId)).toEqual(["p2", "p3"]);
    expect(snapshot.connected).toBe(true);
  });

  it("surfaces a direct reply to our account once, then dedupes it", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada")], presidentId: "a1", civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    await apply(service, (await service.buildSyncPlan())!);
    const myAccountId = (await service.getSnapshot()).agentAccounts.a1!.accountId;

    await service.applyFeedPage([
      post({ postId: "root", worldsequence: "5", author: { accountId: myAccountId, actor: { civId: "civ_a", displayName: "Ada", kind: "agent", localAgentId: "a1" }, status: "active" } }),
      post({ postId: "reply", worldsequence: "6", parentPostId: "root", text: "nice one!" })
    ]);

    const first = await service.takeDirectRepliesForAgent("a1", false);
    expect(first).toHaveLength(1);
    expect(first[0]?.text).toBe("nice one!");
    const second = await service.takeDirectRepliesForAgent("a1", false);
    expect(second).toHaveLength(0);
  });
});

describe("action schema (World Wire)", () => {
  it("accepts a 280 code-point post counting astral emoji as one code point", () => {
    const emoji = "😀".repeat(280); // 280 code points, 560 UTF-16 units
    const parsed = parseAgentAction({ type: "postSocial", text: emoji, rationale: "r" });
    expect(parsed.type).toBe("postSocial");
  });

  it("rejects a post over 280 code points and a whitespace-only post", () => {
    expect(() => parseAgentAction({ type: "postSocial", text: "😀".repeat(281), rationale: "r" })).toThrow();
    expect(() => parseAgentAction({ type: "postSocial", text: "   ", rationale: "r" })).toThrow();
  });

  it("accepts boolean unlike/unfollow", () => {
    expect(parseAgentAction({ type: "likeSocial", postId: "p1", liked: false, rationale: "r" }).type).toBe("likeSocial");
    expect(parseAgentAction({ type: "followSocial", targetAccountId: "acct", following: false, rationale: "r" }).type).toBe("followSocial");
  });
});

describe("SocialService privacy", () => {
  it("never leaks model/memory/beliefs into the sync batch", async () => {
    const store = new MemorySimulationStore();
    await seedStore(store, { agents: [agent("a1", "Ada")], presidentId: "a1", civId: "civ_a" });
    const service = new SocialService(store, config(), SIM_ID);
    const plan = await service.buildSyncPlan();
    const serialized = JSON.stringify(plan!.request);
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain("gpt-5.4");
  });
});
