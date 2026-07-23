import type {
  SocialAccount,
  SocialAccountSummary,
  SocialPost,
} from "../api/social";
import type { WorldEvent } from "../api/types";

/** Deterministic World Wire sample data for tests. */

export function makeSummary(overrides: Partial<SocialAccountSummary> = {}): SocialAccountSummary {
  return {
    accountId: "acc_alpha",
    actor: { civId: "civ_alpha", kind: "agent", localAgentId: "a1", displayName: "Ada Vane" },
    status: "active",
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    accountId: "acc_alpha",
    actor: { civId: "civ_alpha", kind: "agent", localAgentId: "a1", displayName: "Ada Vane" },
    status: "active",
    bio: "Diplomat of Alpha.",
    followerCount: 12,
    followingCount: 5,
    postCount: 30,
    rateLimitPolicy: {
      postCooldownSeconds: 5,
      postsPerWindow: 10,
      reactionsPerWindow: 20,
      followsPerWindow: 10,
      windowSeconds: 60,
    },
    createdAt: "2026-07-13T10:00:00Z",
    updatedAt: "2026-07-13T12:00:00Z",
    worldsequence: "100",
    ...overrides,
  };
}

export function makePost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    postId: "post_1",
    author: makeSummary(),
    status: "published",
    text: "A public dispatch to the world.",
    parentPostId: null,
    conversationRootPostId: "post_1",
    replyDepth: 0,
    replyCount: 0,
    likeCount: 0,
    createdAt: "2026-07-13T12:00:00Z",
    tombstonedAt: null,
    worldsequence: "10",
    ...overrides,
  };
}

/** Build a citizen-safe social CloudEvent for a given type + typed data. */
export function makeSocialEvent(
  type: string,
  data: unknown,
  overrides: Partial<WorldEvent> = {},
): WorldEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    specversion: "1.0",
    type,
    source: "/social",
    datacontenttype: "application/json",
    worldsequence: "50",
    time: "2026-07-13T12:00:05Z",
    data: data as WorldEvent["data"],
    ...overrides,
  };
}
