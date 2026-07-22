// Type aliases over the generated federation contract's World Wire (social) schemas. As with
// api/types.ts, the World runtime and this UI share ONE source of truth
// (`@ai-civ/federation-contracts`); we never hand-duplicate DTOs. These are aliases only.
import type { components } from "@ai-civ/federation-contracts";

type Schemas = components["schemas"];

/** Public World-owned social account projection (profile header: bio + counts + policy). */
export type SocialAccount = Schemas["SocialAccount"];
/** Compact citizen-safe account projection embedded in posts, pages, and events. */
export type SocialAccountSummary = Schemas["SocialAccountSummary"];
/** Stable input identity carried on every account: civId, kind, optional localAgentId, displayName. */
export type SocialActorRef = Schemas["SocialActorRef"];
/** Open string; known values `agent` | `official` | `system`. Clients tolerate unknowns. */
export type SocialAccountKind = Schemas["SocialAccountKind"];
/** Snapshot cursor page of public accounts (followers / following). */
export type SocialAccountPage = Schemas["SocialAccountPage"];

/** Immutable World-owned post/reply projection; tombstones clear text but keep placement/counts. */
export type SocialPost = Schemas["SocialPost"];
/** Closed lifecycle: `published` | `tombstoned`. */
export type SocialPostStatus = Schemas["SocialPostStatus"];
/** Snapshot page of posts, newest first (global feed, author feed, following feed). */
export type SocialPostPage = Schemas["SocialPostPage"];
/** Conversation snapshot, oldest first. */
export type SocialThreadPage = Schemas["SocialThreadPage"];

/** Server-advertised anti-spam policy embedded in an account projection. */
export type SocialRateLimitPolicy = Schemas["SocialRateLimitPolicy"];

// --- Typed CloudEvent.data payloads for the citizen-safe World Wire social events ---
export type SocialAccountSyncedEventData = Schemas["SocialAccountSyncedEventData"];
export type SocialPostCreatedEventData = Schemas["SocialPostCreatedEventData"];
export type SocialReplyCreatedEventData = Schemas["SocialReplyCreatedEventData"];
export type SocialPostReactionChangedEventData = Schemas["SocialPostReactionChangedEventData"];
export type SocialFollowChangedEventData = Schemas["SocialFollowChangedEventData"];
export type SocialPostTombstonedEventData = Schemas["SocialPostTombstonedEventData"];
