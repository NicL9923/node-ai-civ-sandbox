// Pure World Wire helpers: event classification, account-kind vocabulary, worldsequence BigInt
// ordering, and post/account list merging with dedup + caps. No React, no fetch — all unit-tested.
import type { SocialAccountSummary, SocialActorRef, SocialPost } from "../api/social";
import type { WorldEvent } from "../api/types";

// --- Event types -----------------------------------------------------------------------------

export const SOCIAL_EVENT_TYPES = {
  accountSynced: "world.social.account.synced.v1",
  postCreated: "world.social.post.created.v1",
  replyCreated: "world.social.reply.created.v1",
  postLiked: "world.social.post.liked.v1",
  postUnliked: "world.social.post.unliked.v1",
  accountFollowed: "world.social.account.followed.v1",
  accountUnfollowed: "world.social.account.unfollowed.v1",
  postTombstoned: "world.social.post.tombstoned.v1",
} as const;

const SOCIAL_TYPE_SET = new Set<string>(Object.values(SOCIAL_EVENT_TYPES));

/** True when a CloudEvent is one of the citizen-safe World Wire social events. */
export function isSocialEventType(type: string | undefined | null): boolean {
  return type != null && SOCIAL_TYPE_SET.has(type);
}

/** A normalized, defensively-read description of what a social event changed. */
export type SocialSignal =
  | { kind: "post-created"; post: SocialPost }
  | { kind: "reply-created"; post: SocialPost }
  | { kind: "reaction-changed"; postId: string; liked: boolean }
  | {
      kind: "follow-changed";
      followerAccountId: string;
      followedAccountId: string;
      following: boolean;
    }
  | {
      kind: "post-tombstoned";
      postId: string;
      authorAccountId: string;
      conversationRootPostId: string;
      tombstonedAt: string;
    }
  | { kind: "account-synced"; civId: string; accountIds: string[] };

function readObj(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function readPost(data: Record<string, unknown> | null): SocialPost | null {
  const post = data?.post;
  if (post && typeof post === "object" && typeof (post as { postId?: unknown }).postId === "string") {
    return post as SocialPost;
  }
  return null;
}

/**
 * Classify a CloudEvent into a `SocialSignal`, or null if it is not a (well-formed) social event.
 * The typed `CloudEvent.data` payloads are read defensively — a malformed payload yields null
 * rather than throwing, so the live pipeline never breaks on an unexpected shape.
 */
export function classifySocialEvent(event: WorldEvent): SocialSignal | null {
  const type = event.type;
  if (!isSocialEventType(type)) return null;
  const data = readObj(event.data);

  switch (type) {
    case SOCIAL_EVENT_TYPES.postCreated: {
      const post = readPost(data);
      return post ? { kind: "post-created", post } : null;
    }
    case SOCIAL_EVENT_TYPES.replyCreated: {
      const post = readPost(data);
      return post ? { kind: "reply-created", post } : null;
    }
    case SOCIAL_EVENT_TYPES.postLiked:
    case SOCIAL_EVENT_TYPES.postUnliked: {
      const postId = data?.postId;
      if (typeof postId !== "string") return null;
      return { kind: "reaction-changed", postId, liked: type === SOCIAL_EVENT_TYPES.postLiked };
    }
    case SOCIAL_EVENT_TYPES.accountFollowed:
    case SOCIAL_EVENT_TYPES.accountUnfollowed: {
      const follower = data?.followerAccountId;
      const followed = data?.followedAccountId;
      if (typeof follower !== "string" || typeof followed !== "string") return null;
      return {
        kind: "follow-changed",
        followerAccountId: follower,
        followedAccountId: followed,
        following: type === SOCIAL_EVENT_TYPES.accountFollowed,
      };
    }
    case SOCIAL_EVENT_TYPES.postTombstoned: {
      const postId = data?.postId;
      const authorAccountId = data?.authorAccountId;
      const conversationRootPostId = data?.conversationRootPostId;
      const tombstonedAt = data?.tombstonedAt;
      if (typeof postId !== "string" || typeof authorAccountId !== "string") return null;
      return {
        kind: "post-tombstoned",
        postId,
        authorAccountId,
        conversationRootPostId:
          typeof conversationRootPostId === "string" ? conversationRootPostId : postId,
        tombstonedAt: typeof tombstonedAt === "string" ? tombstonedAt : new Date().toISOString(),
      };
    }
    case SOCIAL_EVENT_TYPES.accountSynced: {
      const civId = data?.civId;
      const accountIds = data?.accountIds;
      if (typeof civId !== "string") return null;
      const ids = Array.isArray(accountIds) ? accountIds.filter((x): x is string => typeof x === "string") : [];
      return { kind: "account-synced", civId, accountIds: ids };
    }
    default:
      return null;
  }
}

// --- Account kinds ---------------------------------------------------------------------------

/** Known account kinds. The contract keeps `SocialAccountKind` an OPEN string; tolerate others. */
export const KNOWN_ACCOUNT_KINDS = ["agent", "official", "system"] as const;

export function isOfficialKind(kind: string | undefined): boolean {
  return kind === "official";
}
export function isSystemKind(kind: string | undefined): boolean {
  return kind === "system";
}
export function isAgentKind(kind: string | undefined): boolean {
  return kind === "agent";
}

/** Human label for an account kind, rendered as TEXT (never encoded by color alone). */
export function accountKindLabel(kind: string | undefined): string {
  switch (kind) {
    case "official":
      return "Official";
    case "system":
      return "System";
    case "agent":
      return "Agent";
    default:
      return kind && kind.trim() ? kind : "Account";
  }
}

/** Civilization affiliation for an actor, for linking back to the map. System accounts have none. */
export function civAffiliation(actor: SocialActorRef | undefined): { civId: string } | null {
  if (!actor || isSystemKind(actor.kind)) return null;
  return typeof actor.civId === "string" && actor.civId ? { civId: actor.civId } : null;
}

// --- worldsequence ordering (BigInt) ---------------------------------------------------------

/** Parse an opaque decimal worldsequence STRING to BigInt; unparseable/missing → null. */
export function toSeq(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Compare two worldsequence strings so newest sorts first (DESC). Null sequences sort last. */
export function compareSeqDesc(a: string | null | undefined, b: string | null | undefined): number {
  const sa = toSeq(a);
  const sb = toSeq(b);
  if (sa === null && sb === null) return 0;
  if (sa === null) return 1;
  if (sb === null) return -1;
  return sa < sb ? 1 : sa > sb ? -1 : 0;
}

/** Compare two worldsequence strings so oldest sorts first (ASC). Null sequences sort last. */
export function compareSeqAsc(a: string | null | undefined, b: string | null | undefined): number {
  const sa = toSeq(a);
  const sb = toSeq(b);
  if (sa === null && sb === null) return 0;
  if (sa === null) return 1;
  if (sb === null) return -1;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// --- List merging (dedup + cap) --------------------------------------------------------------

export type SeqOrder = "desc" | "asc";

/**
 * Merge `incoming` posts into `current`, deduping by postId (incoming wins, so a fresher
 * projection — e.g. an updated count or a tombstone — replaces the stale copy), re-sorting by
 * (worldsequence, postId), and capping to `cap` newest/oldest per `order`. Pure and idempotent.
 */
export function mergePosts(
  current: SocialPost[],
  incoming: SocialPost[],
  order: SeqOrder,
  cap: number,
): SocialPost[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, SocialPost>();
  for (const p of current) byId.set(p.postId, p);
  let changed = false;
  for (const p of incoming) {
    if (!p || typeof p.postId !== "string") continue;
    const prev = byId.get(p.postId);
    if (prev !== p) changed = true;
    byId.set(p.postId, p);
  }
  if (!changed) return current;
  const cmp = order === "desc" ? compareSeqDesc : compareSeqAsc;
  const next = [...byId.values()].sort((a, b) => {
    const s = cmp(a.worldsequence, b.worldsequence);
    return s !== 0 ? s : a.postId.localeCompare(b.postId);
  });
  return next.length > cap ? next.slice(0, cap) : next;
}

/**
 * Replace already-present posts with fresher projections (e.g. after a targeted count refetch),
 * preserving list order and NEVER inserting a post that isn't already displayed. Returns the same
 * array reference when nothing changed. Order is stable because a like/reply count change does not
 * change `worldsequence`.
 */
export function replaceExistingPosts(items: SocialPost[], replacements: SocialPost[]): SocialPost[] {
  if (replacements.length === 0) return items;
  const byId = new Map(replacements.map((p) => [p.postId, p] as const));
  let changed = false;
  const next = items.map((p) => {
    const fresh = byId.get(p.postId);
    if (fresh && fresh !== p) {
      changed = true;
      return fresh;
    }
    return p;
  });
  return changed ? next : items;
}

/** Apply a tombstone to a post in place-preserving fashion: clear text, mark status, keep ordering. */
export function tombstonePost(post: SocialPost, tombstonedAt: string): SocialPost {
  if (post.status === "tombstoned") return post;
  return { ...post, status: "tombstoned", text: null, tombstonedAt };
}

/** Merge account summaries by accountId (incoming wins), preserving order and capping. */
export function mergeAccounts(
  current: SocialAccountSummary[],
  incoming: SocialAccountSummary[],
  cap: number,
): SocialAccountSummary[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((a) => a.accountId));
  const additions = incoming.filter((a) => a && typeof a.accountId === "string" && !seen.has(a.accountId));
  if (additions.length === 0) return current;
  const next = current.concat(additions);
  return next.length > cap ? next.slice(0, cap) : next;
}

// --- Cursor guard ----------------------------------------------------------------------------

/**
 * Decide the next cursor for a forward "load more" traversal, guarding against a server cursor
 * cycle (which would otherwise loop forever). Returns:
 *  - `{ done: true }`            when there is no next page (null/empty next cursor),
 *  - `{ done: true, cycle: true }` when the next cursor repeats one already seen (stop, no throw),
 *  - `{ done: false, cursor }`   the next cursor to request.
 * `seen` is mutated to record the accepted cursor.
 */
export function nextCursor(
  seen: Set<string>,
  requested: string | undefined,
  next: string | null | undefined,
): { done: true; cycle?: boolean } | { done: false; cursor: string } {
  if (!next) return { done: true };
  if (next === requested || seen.has(next)) return { done: true, cycle: true };
  seen.add(next);
  return { done: false, cursor: next };
}
