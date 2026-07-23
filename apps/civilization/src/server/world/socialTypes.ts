// Engine-facing World Wire (social) contracts: the narrow SocialPort the simulation engine uses, plus
// the bounded, citizen-safe snapshot injected into prompts and the observer endpoint. Like FederationPort,
// every method is a no-op-safe store operation — the engine never performs network I/O for social. When
// social is disabled the engine holds no port, so the standalone path is unchanged.

/** A compact citizen-safe feed item for prompts / observer (subset of the cached post). */
export interface SocialFeedItem {
  postId: string;
  authorAccountId: string;
  authorName: string;
  text: string | null;
  parentPostId: string | null;
  conversationRootPostId: string;
  replyCount: number;
  likeCount: number;
}

/** A direct reply to one of our own accounts, surfaced (bounded) so the addressed agent can notice it. */
export interface SocialDirectReply {
  postId: string;
  toLocalAgentId?: string;
  toOfficial: boolean;
  fromName: string;
  text: string;
}

/**
 * Bounded, citizen-safe snapshot of World Wire state. The ONLY social data exposed to prompts and the
 * observer. MUST NOT include model ids, memories, private profile, authority audit, or any secret.
 */
export interface SocialSnapshot {
  enabled: boolean;
  /** True when the last successful feed poll or sync is recent. */
  connected: boolean;
  /** localAgentId -> own agent account (only present once synced). */
  agentAccounts: Record<string, { accountId: string; displayName: string }>;
  /** Stable official (President) account, present once synced. */
  officialAccount?: { accountId: string };
  /** President term currently bound to the official account (for official-post authorization). */
  officialTermNumber?: number;
  /** Recent global feed, newest first, already bounded to a small N. */
  feed: SocialFeedItem[];
  /** Distinct accounts known from the feed (id -> display name), bounded. */
  knownAccounts: Array<{ accountId: string; name: string }>;
  /** Own follows currently active. */
  follows: Array<{ followerAccountId: string; followedAccountId: string }>;
  /** Compact social briefing lines. */
  briefing: string[];
  /** Pending/failed social outbox counts (diagnostics only). */
  pendingOutbox: number;
  failedOutbox: number;
}

/** How a social action was authorized locally, mapped to SocialMutationAuthorization by the service. */
export interface SocialActionInput {
  op: "post" | "reply" | "like" | "follow";
  /** The internal agent id of the acting citizen (== localAgentId). */
  actingLocalAgentId: string;
  /** True when the President acts through the civ's official account. */
  useOfficialAccount: boolean;
  /** Open authorization mode ("president" | "citizen" | ...). */
  authorityMode: string;
  /** Opaque civ-scoped decision reference (e.g. `term-3` or `agent-<id>`). */
  authorityRef: string;
  /** Stable idempotency key; identical across retries for the same intent. */
  idempotencyKey: string;
  // post / reply
  text?: string;
  parentPostId?: string;
  // like
  targetPostId?: string;
  liked?: boolean;
  // follow
  targetAccountId?: string;
  following?: boolean;
}

export type SocialEnqueueResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "account_not_synced" | "invalid" };

/**
 * Narrow surface the engine uses to talk to the social subsystem. All store-only; no network I/O.
 */
export interface SocialPort {
  /** Bounded citizen-safe snapshot for prompts + observer. */
  getSnapshot(): Promise<SocialSnapshot>;
  /** Durably enqueue a social mutation intent (resolves account ids from synced state). */
  enqueue(input: SocialActionInput): Promise<SocialEnqueueResult>;
  /**
   * Take (and mark seen) any not-yet-surfaced direct replies addressed to the given local agent (and,
   * when includeOfficial is true, to the official account), so the engine can add a single bounded
   * personal memory. Deduped by postId across turns.
   */
  takeDirectRepliesForAgent(localAgentId: string, includeOfficial: boolean): Promise<SocialDirectReply[]>;
}
