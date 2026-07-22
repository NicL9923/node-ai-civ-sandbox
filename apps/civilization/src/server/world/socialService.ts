// Store-backed World Wire (social) core. Implements the engine-facing SocialPort (bounded snapshot for
// prompts/observer, durable social-mutation enqueue, direct-reply surfacing) and the connector-facing
// operations (account-sync planning + apply, global-feed merge, pending-outbox lifecycle). It performs
// NO network I/O — the connector owns every World call. Every effect is idempotent so at-least-once
// delivery yields exactly-once observable results. Nothing here ever holds secrets, model ids,
// memories, or private profile data.
import { createHash } from "node:crypto";
import type { FederationConfig, SocialConfig } from "../config.js";
import { nowIso } from "../id.js";
import type { SimulationStore } from "../store.js";
import { safeFederationId } from "./federationIds.js";
import {
  SOCIAL_STATE_ID,
  type SocialAccount,
  type SocialAccountSyncRequest,
  type SocialAccountUpsert,
  type SocialCachedPost,
  type SocialMutationAuthorization,
  type SocialOutboxPayload,
  type SocialPost,
  type SocialStateDoc,
  type OutboxItemDoc
} from "./federationTypes.js";
import type {
  SocialActionInput,
  SocialDirectReply,
  SocialEnqueueResult,
  SocialFeedItem,
  SocialPort,
  SocialSnapshot
} from "./socialTypes.js";

/** Older than this since the last successful feed poll / sync ⇒ we report `connected: false`. */
const CONNECTION_STALENESS_MS = 2 * 60 * 1000;
/** Hard contract bound on a sync batch. */
const MAX_ACCOUNTS_PER_SYNC = 100;
/** Bounded dedupe set of already-surfaced reply postIds. */
const SEEN_REPLY_MAX = 200;
/** Max direct replies surfaced to a single agent per turn. */
const DIRECT_REPLY_MAX_PER_CALL = 2;
/** Max distinct known accounts derived from the cached feed for a prompt. */
const KNOWN_ACCOUNTS_MAX = 20;

/** A per-batch descriptor used to zip the ordered sync RESPONSE back onto local identities. */
type SyncSlot =
  | { kind: "agent"; localAgentId: string; displayName: string }
  | { kind: "official"; termNumber: number };

export interface SocialSyncPlan {
  request: SocialAccountSyncRequest;
  slots: SyncSlot[];
  fingerprint: string;
}

export class SocialService implements SocialPort {
  private stateLock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SimulationStore,
    private readonly config: FederationConfig,
    private readonly simulationId: string
  ) {}

  private get social(): SocialConfig {
    return this.config.social;
  }

  // --- state lifecycle -------------------------------------------------------

  async ensureState(): Promise<SocialStateDoc> {
    const existing = await this.store.getSocialState(this.simulationId);
    if (existing) {
      return existing;
    }
    const state: SocialStateDoc = {
      id: SOCIAL_STATE_ID,
      simulationId: this.simulationId,
      kind: "social",
      agentAccounts: {},
      feed: [],
      follows: [],
      briefing: [],
      seenReplyPostIds: [],
      updatedAt: nowIso()
    };
    await this.store.putSocialState(state);
    return state;
  }

  async getState(): Promise<SocialStateDoc> {
    return this.ensureState();
  }

  private async saveState(state: SocialStateDoc): Promise<void> {
    state.updatedAt = nowIso();
    await this.store.putSocialState(state);
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateLock.then(fn, fn);
    this.stateLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // --- SocialPort (engine-facing) -------------------------------------------

  async getSnapshot(): Promise<SocialSnapshot> {
    const state = await this.getState();
    const social = (await this.store.listOutbox(this.simulationId)).filter((item) => item.itemKind === "social");
    const connected = this.isConnected(state);
    const feed = state.feed.slice(0, this.social.promptFeedItems).map(toFeedItem);

    const known = new Map<string, string>();
    for (const post of state.feed) {
      if (!known.has(post.authorAccountId)) {
        known.set(post.authorAccountId, post.authorName);
      }
      if (known.size >= KNOWN_ACCOUNTS_MAX) {
        break;
      }
    }

    return {
      enabled: this.social.enabled,
      connected,
      agentAccounts: Object.fromEntries(
        Object.entries(state.agentAccounts).map(([localAgentId, account]) => [
          localAgentId,
          { accountId: account.accountId, displayName: account.displayName }
        ])
      ),
      officialAccount: state.officialAccount ? { accountId: state.officialAccount.accountId } : undefined,
      officialTermNumber: state.officialTermNumber,
      feed,
      knownAccounts: [...known.entries()].map(([accountId, name]) => ({ accountId, name })),
      follows: state.follows,
      briefing: state.briefing,
      pendingOutbox: social.filter((item) => item.status === "pending").length,
      failedOutbox: social.filter((item) => item.status === "failed").length
    };
  }

  async enqueue(input: SocialActionInput): Promise<SocialEnqueueResult> {
    if (!this.social.enabled) {
      return { ok: false, reason: "disabled" };
    }
    const state = await this.getState();
    const account = input.useOfficialAccount ? state.officialAccount : state.agentAccounts[input.actingLocalAgentId];
    if (!account) {
      return { ok: false, reason: "account_not_synced" };
    }

    const authorization = this.buildAuthorization(input, state);
    const payload = this.buildOutboxPayload(input, account.accountId, authorization);
    if (!payload) {
      return { ok: false, reason: "invalid" };
    }

    const id = safeFederationId("outbox_soc", input.idempotencyKey);
    const existing = (await this.store.listOutbox(this.simulationId)).find((item) => item.id === id);
    if (existing) {
      // Idempotent: the same intent is already durably enqueued.
      return { ok: true };
    }

    const now = nowIso();
    const item: OutboxItemDoc = {
      id,
      simulationId: this.simulationId,
      kind: "outbox",
      itemKind: "social",
      idempotencyKey: input.idempotencyKey,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.store.putOutboxItem(item);
    return { ok: true };
  }

  async takeDirectRepliesForAgent(localAgentId: string, includeOfficial: boolean): Promise<SocialDirectReply[]> {
    return this.runExclusive(async () => {
      const state = structuredClone(await this.getState());
      const agentAccountId = state.agentAccounts[localAgentId]?.accountId;
      const officialAccountId = includeOfficial ? state.officialAccount?.accountId : undefined;
      if (!agentAccountId && !officialAccountId) {
        return [];
      }

      const byId = new Map(state.feed.map((post) => [post.postId, post]));
      const seen = new Set(state.seenReplyPostIds);
      const results: SocialDirectReply[] = [];

      // Oldest-first so surfaced replies read chronologically.
      for (const post of [...state.feed].reverse()) {
        if (results.length >= DIRECT_REPLY_MAX_PER_CALL) {
          break;
        }
        if (!post.parentPostId || post.text === null || seen.has(post.postId)) {
          continue;
        }
        const parent = byId.get(post.parentPostId);
        if (!parent) {
          continue;
        }
        const toOfficial = officialAccountId !== undefined && parent.authorAccountId === officialAccountId;
        const toAgent = agentAccountId !== undefined && parent.authorAccountId === agentAccountId;
        if (!toOfficial && !toAgent) {
          continue;
        }
        results.push({
          postId: post.postId,
          toLocalAgentId: toAgent ? localAgentId : undefined,
          toOfficial,
          fromName: post.authorName,
          text: post.text
        });
        seen.add(post.postId);
      }

      if (results.length > 0) {
        state.seenReplyPostIds = [...seen].slice(-SEEN_REPLY_MAX);
        await this.saveState(state);
      }
      return results;
    });
  }

  // --- connector-facing: account sync ---------------------------------------

  /**
   * Build the desired account-sync batch from live state (active agents + sitting President). Returns
   * undefined when there is no civId yet or nothing to sync. Agent accounts use `(civId, localAgentId)`;
   * the single official account is included only while a President sits (its authority requires one).
   * Deactivated agents simply fall out of the active set — they are never deleted (the contract has no
   * delete/suspend), so their World account is left as-is.
   */
  async buildSyncPlan(): Promise<SocialSyncPlan | undefined> {
    if (!this.social.enabled) {
      return undefined;
    }
    const fed = await this.store.getFederationState(this.simulationId);
    const civId = fed?.civId;
    if (!civId) {
      return undefined;
    }
    const displayName = fed?.displayName ?? this.config.displayName;
    const agents = (await this.store.listAgents(this.simulationId))
      .filter((agent) => agent.active)
      .sort((a, b) => a.id.localeCompare(b.id));
    const simulation = await this.store.getSimulation(this.simulationId);
    const president = simulation?.governance?.president;
    const presidentAgent = president ? agents.find((agent) => agent.id === president.agentId) : undefined;

    const accounts: SocialAccountUpsert[] = [];
    const slots: SyncSlot[] = [];

    // Reserve one slot for the official account so the batch never exceeds the contract bound.
    const agentBudget = president && presidentAgent ? MAX_ACCOUNTS_PER_SYNC - 1 : MAX_ACCOUNTS_PER_SYNC;
    for (const agent of agents.slice(0, agentBudget)) {
      accounts.push({ actor: { civId, localAgentId: agent.id, displayName: agent.name, kind: "agent" } });
      slots.push({ kind: "agent", localAgentId: agent.id, displayName: agent.name });
    }

    if (president && presidentAgent) {
      accounts.push({
        actor: { civId, displayName, kind: "official" },
        officialAuthority: {
          presidentLocalAgentId: president.agentId,
          presidentDisplayName: presidentAgent.name,
          termNumber: president.termNumber,
          authorityDecision: { mode: "president", ref: `term-${president.termNumber}` }
        }
      });
      slots.push({ kind: "official", termNumber: president.termNumber });
    }

    if (accounts.length === 0) {
      return undefined;
    }

    const fingerprint = fingerprintSlots(civId, displayName, slots);
    return { request: { civId, accounts }, slots, fingerprint };
  }

  /** True when the desired fingerprint differs from the last synced one AND the debounce window elapsed. */
  async shouldSync(fingerprint: string): Promise<boolean> {
    const state = await this.getState();
    if (state.syncedFingerprint === fingerprint) {
      return false;
    }
    if (state.lastSyncedAt && Date.now() - new Date(state.lastSyncedAt).getTime() < this.social.syncDebounceMs) {
      return false;
    }
    return true;
  }

  /** The stable idempotency key for a sync of the given fingerprint. */
  syncIdempotencyKey(fingerprint: string): string {
    return `social-sync:${this.simulationId}:${fingerprint}`;
  }

  /**
   * Persist the World-owned account ids from an ordered sync RESPONSE (response[i] matches slots[i]).
   * Agent accounts are rebuilt from this batch so a deactivated agent naturally drops from our local
   * map (its World account is untouched). The official account id is stable across President rotation.
   */
  async applySyncResult(slots: SyncSlot[], accounts: SocialAccount[], fingerprint: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = structuredClone(await this.getState());
      const nextAgents: SocialStateDoc["agentAccounts"] = {};
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        const account = accounts[index];
        if (!slot || !account) {
          continue;
        }
        if (slot.kind === "agent") {
          nextAgents[slot.localAgentId] = { accountId: account.accountId, displayName: slot.displayName };
        } else {
          state.officialAccount = { accountId: account.accountId, displayName: account.actor.displayName };
          state.officialTermNumber = slot.termNumber;
        }
      }
      state.agentAccounts = nextAgents;
      state.syncedFingerprint = fingerprint;
      state.lastSyncedAt = nowIso();
      await this.saveState(state);
    });
  }

  // --- connector-facing: outbox + feed --------------------------------------

  async listPendingSocialOutbox(): Promise<OutboxItemDoc[]> {
    const pending = await this.store.listOutbox(this.simulationId, ["pending"]);
    return pending.filter((item) => item.itemKind === "social");
  }

  async saveOutboxItem(item: OutboxItemDoc): Promise<void> {
    item.updatedAt = nowIso();
    await this.store.putOutboxItem(item);
  }

  /**
   * Merge a fresh first-page feed snapshot into the bounded cache by `(worldsequence DESC, postId ASC)`,
   * upserting by postId (a newer projection — e.g. a tombstone or updated counts — replaces the old).
   * Refreshes the compact briefing and connection freshness. A failed poll never calls this, so the
   * last-known cache is preserved.
   */
  async applyFeedPage(posts: SocialPost[]): Promise<void> {
    await this.runExclusive(async () => {
      const state = structuredClone(await this.getState());
      const byId = new Map(state.feed.map((post) => [post.postId, post]));
      for (const post of posts) {
        byId.set(post.postId, toCachedPost(post));
      }
      const merged = [...byId.values()].sort(compareFeed).slice(0, this.social.feedCacheMax);
      state.feed = merged;
      state.lastFeedPollAt = nowIso();
      state.briefing = buildBriefing(merged, this.social.briefingMax);
      await this.saveState(state);
    });
  }

  /** Record that a follow intent was accepted, so the prompt reflects the acting account's follows. */
  async recordFollowResult(followerAccountId: string, followedAccountId: string, following: boolean): Promise<void> {
    await this.runExclusive(async () => {
      const state = structuredClone(await this.getState());
      const others = state.follows.filter(
        (edge) => !(edge.followerAccountId === followerAccountId && edge.followedAccountId === followedAccountId)
      );
      state.follows = following ? [...others, { followerAccountId, followedAccountId }].slice(-200) : others;
      await this.saveState(state);
    });
  }

  // --- helpers ---------------------------------------------------------------

  private buildAuthorization(input: SocialActionInput, state: SocialStateDoc): SocialMutationAuthorization {
    const authorization: SocialMutationAuthorization = {
      actingLocalAgentId: input.actingLocalAgentId,
      authorityDecision: { mode: input.authorityMode, ref: input.authorityRef }
    };
    if (input.useOfficialAccount && state.officialTermNumber !== undefined) {
      authorization.officialTermNumber = state.officialTermNumber;
    }
    return authorization;
  }

  private buildOutboxPayload(
    input: SocialActionInput,
    accountId: string,
    authorization: SocialMutationAuthorization
  ): SocialOutboxPayload | undefined {
    switch (input.op) {
      case "post":
      case "reply":
        if (!input.text) {
          return undefined;
        }
        return {
          op: "post",
          authorAccountId: accountId,
          text: input.text,
          parentPostId: input.op === "reply" ? input.parentPostId : undefined,
          authorization
        };
      case "like":
        if (!input.targetPostId) {
          return undefined;
        }
        return {
          op: "like",
          postId: input.targetPostId,
          accountId,
          liked: input.liked ?? true,
          authorization
        };
      case "follow":
        if (!input.targetAccountId || input.targetAccountId === accountId) {
          return undefined;
        }
        return {
          op: "follow",
          followerAccountId: accountId,
          targetAccountId: input.targetAccountId,
          following: input.following ?? true,
          authorization
        };
    }
  }

  private isConnected(state: SocialStateDoc): boolean {
    const marks = [state.lastFeedPollAt, state.lastSyncedAt].filter((mark): mark is string => Boolean(mark));
    if (marks.length === 0) {
      return false;
    }
    const freshest = Math.max(...marks.map((mark) => new Date(mark).getTime()));
    return Date.now() - freshest < CONNECTION_STALENESS_MS;
  }
}

// --- pure helpers ------------------------------------------------------------

function toCachedPost(post: SocialPost): SocialCachedPost {
  return {
    postId: post.postId,
    authorAccountId: post.author.accountId,
    authorName: post.author.actor.displayName,
    text: post.text,
    parentPostId: post.parentPostId,
    conversationRootPostId: post.conversationRootPostId,
    replyCount: post.replyCount,
    likeCount: post.likeCount,
    worldsequence: post.worldsequence,
    createdAt: post.createdAt
  };
}

function toFeedItem(post: SocialCachedPost): SocialFeedItem {
  return {
    postId: post.postId,
    authorAccountId: post.authorAccountId,
    authorName: post.authorName,
    text: post.text,
    parentPostId: post.parentPostId,
    conversationRootPostId: post.conversationRootPostId,
    replyCount: post.replyCount,
    likeCount: post.likeCount
  };
}

/** Contract order: worldsequence DESC (int64), then postId ASC. */
function compareFeed(a: SocialCachedPost, b: SocialCachedPost): number {
  if (a.worldsequence !== b.worldsequence) {
    const left = BigInt(a.worldsequence);
    const right = BigInt(b.worldsequence);
    return left > right ? -1 : 1;
  }
  return a.postId.localeCompare(b.postId);
}

function buildBriefing(feed: SocialCachedPost[], max: number): string[] {
  if (feed.length === 0) {
    return ["The World Wire is quiet so far."];
  }
  const lines = [`The World Wire is active — ${feed.length} recent post${feed.length === 1 ? "" : "s"}.`];
  const latest = feed.find((post) => post.text);
  if (latest && latest.text) {
    lines.push(`Latest: "${snippet(latest.text)}" — ${latest.authorName}.`);
  }
  return lines.slice(0, Math.max(1, max));
}

function snippet(text: string): string {
  const chars = [...text];
  return chars.length <= 100 ? text : `${chars.slice(0, 100).join("")}…`;
}

/** Stable fingerprint of the desired account set; changing it (agents/President/term) triggers re-sync. */
function fingerprintSlots(civId: string, displayName: string, slots: SyncSlot[]): string {
  const canonical = slots
    .map((slot) =>
      slot.kind === "agent"
        ? `agent:${slot.localAgentId}:${slot.displayName}`
        : `official:${slot.termNumber}`
    )
    .join("|");
  return createHash("sha256").update(`${civId}|${displayName}|${canonical}`, "utf8").digest("hex");
}
