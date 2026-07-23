// Server-only federation runtime types: durable store document shapes, the port the engine uses to
// talk to the federation subsystem, and convenient aliases for the P1 generated contract types.
// The contract types come straight from @ai-civ/federation-contracts — we never re-declare DTOs.
import type { components } from "@ai-civ/federation-contracts";
import type { ForeignAffairsSnapshot, KnownCivilization, SimulationEvent } from "../../shared/types.js";

export type CloudEvent = components["schemas"]["CloudEvent"];
export type Command = components["schemas"]["Command"];
export type InteractionRequest = components["schemas"]["InteractionRequest"];
export type AuthorityDecision = components["schemas"]["AuthorityDecision"];
export type PublicProjection = components["schemas"]["PublicProjection"];
export type ContactCommandData = components["schemas"]["ContactCommandData"];
export type MessageCommandData = components["schemas"]["MessageCommandData"];

/** Opaque forward-only command cursor (World `Cursor`). */
export type CommandCursor = string;

// --- P10 World Wire (social) contract aliases (never re-declare DTOs) -------
export type SocialAccountUpsert = components["schemas"]["SocialAccountUpsert"];
export type SocialAccountSyncRequest = components["schemas"]["SocialAccountSyncRequest"];
export type SocialAccount = components["schemas"]["SocialAccount"];
export type SocialActorRef = components["schemas"]["SocialActorRef"];
export type SocialOfficialAuthority = components["schemas"]["SocialOfficialAuthority"];
export type SocialMutationAuthorization = components["schemas"]["SocialMutationAuthorization"];
export type SocialPost = components["schemas"]["SocialPost"];
export type SocialPostCreateRequest = components["schemas"]["SocialPostCreateRequest"];
export type SocialReactionSetRequest = components["schemas"]["SocialReactionSetRequest"];
export type SocialFollowSetRequest = components["schemas"]["SocialFollowSetRequest"];
export type SocialPostPage = components["schemas"]["SocialPostPage"];

export type FederationDocKind = "state" | "outbox" | "inbox" | "social";

export interface FederationDocBase {
  id: string;
  simulationId: string;
  kind: FederationDocKind;
}

/** Singleton connector + foreign-affairs state (id === FEDERATION_STATE_ID). */
export interface FederationStateDoc extends FederationDocBase {
  kind: "state";
  /** Provisioned/registered World civ id (mirrors config or registration result). */
  civId?: string;
  keyId?: string;
  displayName?: string;
  /** True once the civ has usable credentials (pre-provisioned or registered). */
  registered: boolean;
  registeredAt?: string;
  /** Forward-only cursor for the commands pull. Only advanced AFTER a command is acked. */
  commandCursor?: CommandCursor | null;
  lastHeartbeatAt?: string;
  lastPullAt?: string;
  /** True when the last successful World contact is recent. */
  connected: boolean;
  /** Cached citizen-safe directory of other civilizations, refreshed from listCivilizations/heartbeat. */
  knownCivs: KnownCivilization[];
  /** Compact ring buffer of recent foreign-affairs happenings, shown to every agent in the briefing. */
  recentWorldNotes: string[];
  updatedAt: string;
}

export type OutboxItemKind = "event" | "interaction" | "social";
export type OutboxStatus = "pending" | "sent" | "failed";

/**
 * A durable World Wire mutation intent. Account/target ids are resolved from the synced social state
 * at ENQUEUE time (in the AI turn); the connector flushes it to the network later. Never network in a
 * turn. `op` selects the endpoint: `post` = createSocialPost (root or reply via parentPostId), `like` =
 * setSocialPostLike, `follow` = setSocialFollow. unlike/unfollow are the boolean desired state.
 */
export type SocialOutboxPayload =
  | {
      op: "post";
      authorAccountId: string;
      text: string;
      parentPostId?: string;
      authorization: SocialMutationAuthorization;
    }
  | {
      op: "like";
      postId: string;
      accountId: string;
      liked: boolean;
      authorization: SocialMutationAuthorization;
    }
  | {
      op: "follow";
      followerAccountId: string;
      targetAccountId: string;
      following: boolean;
      authorization: SocialMutationAuthorization;
    };

/** A durable outbound item (a CloudEvent export, a President interaction, or a social mutation). */
export interface OutboxItemDoc extends FederationDocBase {
  kind: "outbox";
  itemKind: OutboxItemKind;
  /** Stable idempotency key sent to the World; identical across retries. */
  idempotencyKey: string;
  /** Process-monotonic enqueue ordinal; a deterministic causal tie-breaker for equal-`createdAt` items. */
  seq?: number;
  /** The exact payload to send (CloudEvent for events, InteractionRequest for interactions, SocialOutboxPayload for social). */
  payload: CloudEvent | InteractionRequest | SocialOutboxPayload;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  worldsequence?: string | null;
  /** World-assigned interaction id, recorded once the interaction is accepted. */
  interactionId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type InboxAckStatus = "applied" | "rejected" | "duplicate";

/**
 * Deterministic durable FIFO order for outbox items: oldest `createdAt` first, then the process-monotonic
 * enqueue `seq` (a causal tie-breaker for items sharing a millisecond), then `id` for any legacy item that
 * predates `seq`. This is the single source of truth for outbox ordering — the store returns items in this
 * order and the connector relies on it so a newer desired-state toggle never overtakes an older one for the
 * same target. Keeping it here (not just in the connector) makes the durable intent order authoritative.
 */
export function compareOutboxFifo(a: OutboxItemDoc, b: OutboxItemDoc): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  return a.id.localeCompare(b.id);
}


/** A dedupe record for a processed inbound command. id === `inbox_<dedupeKey>`. */
export interface InboxItemDoc extends FederationDocBase {
  kind: "inbox";
  dedupeKey: string;
  commandId: string;
  ackStatus: InboxAckStatus;
  detail?: string;
  createdAt: string;
}

export const FEDERATION_STATE_ID = "fed_state";
export const SOCIAL_STATE_ID = "fed_social";

/** A compact, citizen-safe cached World Wire post projection (bounded ring, newest-first). */
export interface SocialCachedPost {
  postId: string;
  authorAccountId: string;
  authorName: string;
  /** Post text; null once tombstoned. */
  text: string | null;
  parentPostId: string | null;
  conversationRootPostId: string;
  replyCount: number;
  likeCount: number;
  worldsequence: string;
  createdAt: string;
}

/** One own social account learned from a sync response. */
export interface SocialOwnAccount {
  accountId: string;
  displayName: string;
}

/**
 * Singleton durable World Wire state (id === SOCIAL_STATE_ID). Holds the World-owned account ids learned
 * from account sync, the last synced fingerprint (drives debounced re-sync), a bounded cached global
 * feed + own-follows projection, a compact briefing, and a bounded dedupe set of already-surfaced direct
 * replies. It NEVER holds secrets, model ids, memories, or private profile data.
 */
export interface SocialStateDoc extends FederationDocBase {
  kind: "social";
  /** localAgentId (internal agent id) -> synced agent account. */
  agentAccounts: Record<string, SocialOwnAccount>;
  /** The single official (President) account; its id is stable across term changes. */
  officialAccount?: SocialOwnAccount;
  /** President term whose authority was last synced onto the official account. */
  officialTermNumber?: number;
  /** Fingerprint of the last successfully synced desired account set. */
  syncedFingerprint?: string;
  lastSyncedAt?: string;
  /** Last time the global feed was successfully polled (drives connection freshness). */
  lastFeedPollAt?: string;
  /** Bounded cached global feed (newest first by worldsequence). */
  feed: SocialCachedPost[];
  /** Own follows currently set to true: (followerAccountId -> followedAccountIds). Bounded. */
  follows: Array<{ followerAccountId: string; followedAccountId: string }>;
  /** Compact social briefing lines shown in prompts. */
  briefing: string[];
  /** Bounded dedupe set of reply postIds already surfaced as direct-reply memories. */
  seenReplyPostIds: string[];
  updatedAt: string;
}

/** Input for a President-authorized cross-civ interaction, produced by the engine. */
export interface SubmitInteractionInput {
  idempotencyKey: string;
  kind: "contact" | "message";
  source: string;
  target: string;
  authorityDecision: AuthorityDecision;
  publicNarrative?: string;
  payload: components["schemas"]["ContactIntentData"] | components["schemas"]["MessageIntentData"];
}

/**
 * The narrow surface the simulation engine uses to talk to the federation subsystem. Every method is a
 * no-op-safe store operation — the engine never performs network I/O. When federation is disabled the
 * engine holds no port at all, so the standalone path is unchanged.
 */
export interface FederationPort {
  /** Enqueue an allowlisted local event as a CloudEvent export (best-effort; caller-gated by allowlist). */
  exportLocalEvent(event: SimulationEvent): Promise<void>;
  /** Durably enqueue a President interaction to the outbox (network send happens later in the connector). */
  submitInteraction(input: SubmitInteractionInput): Promise<void>;
  /** Cached citizen-safe foreign-affairs snapshot for prompts and the public world snapshot. */
  getSnapshot(): Promise<ForeignAffairsSnapshot>;
  /** Whether a civ id is currently in the cached directory (used to validate President targets). */
  isKnownCiv(civId: string): Promise<boolean>;
}
