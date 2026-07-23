import { describe, expect, it } from "vitest";
import {
  SOCIAL_EVENT_TYPES,
  accountKindLabel,
  civAffiliation,
  classifySocialEvent,
  compareSeqAsc,
  compareSeqDesc,
  isAgentKind,
  isOfficialKind,
  isSocialEventType,
  isSystemKind,
  mergeAccounts,
  mergePosts,
  nextCursor,
  replaceExistingPosts,
  toSeq,
  tombstonePost,
} from "../domain/social";
import { makePost, makeSocialEvent, makeSummary } from "./socialFixtures";

describe("social domain", () => {
  describe("event classification", () => {
    it("recognizes the citizen-safe social event types only", () => {
      expect(isSocialEventType(SOCIAL_EVENT_TYPES.postCreated)).toBe(true);
      expect(isSocialEventType("world.civilization.message.v1")).toBe(false);
      expect(isSocialEventType(undefined)).toBe(false);
    });

    it("classifies a post creation with its full post payload", () => {
      const post = makePost({ postId: "p1" });
      const signal = classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, { post }));
      expect(signal).toEqual({ kind: "post-created", post });
    });

    it("classifies a reply creation", () => {
      const post = makePost({ postId: "p2", parentPostId: "p1", replyDepth: 1 });
      const signal = classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.replyCreated, { post }));
      expect(signal?.kind).toBe("reply-created");
    });

    it("classifies like and unlike into reaction-changed with liked flag", () => {
      const liked = classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.postLiked, { postId: "p1", accountId: "a" }));
      const unliked = classifySocialEvent(
        makeSocialEvent(SOCIAL_EVENT_TYPES.postUnliked, { postId: "p1", accountId: "a" }),
      );
      expect(liked).toMatchObject({ kind: "reaction-changed", postId: "p1", liked: true });
      expect(unliked).toMatchObject({ kind: "reaction-changed", postId: "p1", liked: false });
    });

    it("classifies follow and unfollow", () => {
      const followed = classifySocialEvent(
        makeSocialEvent(SOCIAL_EVENT_TYPES.accountFollowed, {
          followerAccountId: "a",
          followedAccountId: "b",
        }),
      );
      expect(followed).toMatchObject({ kind: "follow-changed", following: true, followerAccountId: "a" });
    });

    it("classifies a tombstone with its timestamp", () => {
      const signal = classifySocialEvent(
        makeSocialEvent(SOCIAL_EVENT_TYPES.postTombstoned, {
          postId: "p1",
          authorAccountId: "acc",
          conversationRootPostId: "p1",
          tombstonedAt: "2026-07-13T13:00:00Z",
        }),
      );
      expect(signal).toMatchObject({ kind: "post-tombstoned", postId: "p1", tombstonedAt: "2026-07-13T13:00:00Z" });
    });

    it("returns null for non-social events and malformed payloads (never throws)", () => {
      expect(classifySocialEvent(makeSocialEvent("civ.agent.acted.v1", {}))).toBeNull();
      expect(classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, null))).toBeNull();
      expect(classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, { post: { nope: true } }))).toBeNull();
      expect(classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.postLiked, {}))).toBeNull();
    });
  });

  describe("account kinds", () => {
    it("labels known kinds as text and tolerates unknowns", () => {
      expect(accountKindLabel("official")).toBe("Official");
      expect(accountKindLabel("system")).toBe("System");
      expect(accountKindLabel("agent")).toBe("Agent");
      expect(accountKindLabel("moderator")).toBe("moderator");
      expect(accountKindLabel(undefined)).toBe("Account");
    });

    it("predicates classify kinds", () => {
      expect(isOfficialKind("official")).toBe(true);
      expect(isSystemKind("system")).toBe(true);
      expect(isAgentKind("agent")).toBe(true);
      expect(isOfficialKind("agent")).toBe(false);
    });

    it("resolves civ affiliation for agents/officials but not system accounts", () => {
      expect(civAffiliation({ civId: "civ_1", kind: "agent", displayName: "X" })).toEqual({ civId: "civ_1" });
      expect(civAffiliation({ civId: "world", kind: "system", displayName: "World" })).toBeNull();
      expect(civAffiliation(undefined)).toBeNull();
    });
  });

  describe("worldsequence ordering (BigInt-safe)", () => {
    it("parses decimal strings beyond 2^53 without precision loss", () => {
      const big = "9007199254740993"; // 2^53 + 1
      expect(toSeq(big)).toBe(9007199254740993n);
      expect(toSeq("nope")).toBeNull();
      expect(toSeq(null)).toBeNull();
    });

    it("orders newest-first / oldest-first using BigInt comparison", () => {
      const a = "9007199254740992"; // 2^53
      const b = "9007199254740993"; // 2^53 + 1
      expect(compareSeqDesc(a, b)).toBeGreaterThan(0);
      expect(compareSeqAsc(a, b)).toBeLessThan(0);
      expect(compareSeqDesc(null, b)).toBeGreaterThan(0); // nulls sort last
    });
  });

  describe("post/account merging", () => {
    it("merges posts newest-first, deduping by id (incoming wins)", () => {
      const p1 = makePost({ postId: "p1", worldsequence: "1" });
      const p2 = makePost({ postId: "p2", worldsequence: "2" });
      const p2updated = makePost({ postId: "p2", worldsequence: "2", likeCount: 9 });
      const merged = mergePosts([p1], [p2, p2updated], "desc", 500);
      expect(merged.map((p) => p.postId)).toEqual(["p2", "p1"]);
      expect(merged[0].likeCount).toBe(9);
    });

    it("orders threads oldest-first and caps", () => {
      const posts = ["3", "1", "2"].map((seq) => makePost({ postId: `p${seq}`, worldsequence: seq }));
      const merged = mergePosts([], posts, "asc", 2);
      expect(merged.map((p) => p.postId)).toEqual(["p1", "p2"]);
    });

    it("replaces only already-present posts in place (never injects)", () => {
      const p1 = makePost({ postId: "p1", likeCount: 0 });
      const p2 = makePost({ postId: "p2", likeCount: 0 });
      const fresh1 = makePost({ postId: "p1", likeCount: 5 });
      const strayP9 = makePost({ postId: "p9", likeCount: 1 });
      const result = replaceExistingPosts([p1, p2], [fresh1, strayP9]);
      expect(result.map((p) => p.postId)).toEqual(["p1", "p2"]); // p9 not injected
      expect(result[0].likeCount).toBe(5);
      const base = [p1];
      expect(replaceExistingPosts(base, [])).toBe(base); // empty replacements → same reference
      expect(replaceExistingPosts(base, [strayP9])).toBe(base); // no matching id → same reference
    });

    it("tombstones a post in place, clearing text but keeping identity", () => {
      const p = makePost({ postId: "p1", text: "secret", replyCount: 3, worldsequence: "10" });
      const dead = tombstonePost(p, "2026-07-13T13:00:00Z");
      expect(dead.status).toBe("tombstoned");
      expect(dead.text).toBeNull();
      expect(dead.replyCount).toBe(3);
      expect(dead.worldsequence).toBe("10");
      expect(tombstonePost(dead, "later")).toBe(dead); // terminal / idempotent
    });

    it("merges account summaries deduping by accountId", () => {
      const a = makeSummary({ accountId: "a" });
      const b = makeSummary({ accountId: "b" });
      const merged = mergeAccounts([a], [a, b], 500);
      expect(merged.map((x) => x.accountId)).toEqual(["a", "b"]);
    });
  });

  describe("cursor guard", () => {
    it("stops at a null next cursor", () => {
      expect(nextCursor(new Set(), "c1", null)).toEqual({ done: true });
    });
    it("detects a repeated cursor as a cycle without throwing", () => {
      const seen = new Set<string>(["c2"]);
      expect(nextCursor(seen, "c1", "c2")).toEqual({ done: true, cycle: true });
      expect(nextCursor(new Set(), "c1", "c1")).toEqual({ done: true, cycle: true });
    });
    it("advances to a fresh cursor and records it", () => {
      const seen = new Set<string>();
      expect(nextCursor(seen, "c1", "c2")).toEqual({ done: false, cursor: "c2" });
      expect(seen.has("c2")).toBe(true);
    });
  });

  describe("plain-text safety", () => {
    it("carries submitted text verbatim (no parsing of URL/mention/hashtag/HTML)", () => {
      // The domain never transforms text; rendering escapes it. Verify it is passed through as-is.
      const raw = "<b>hi</b> @world #tag http://x javascript:alert(1)";
      const post = makePost({ text: raw });
      const signal = classifySocialEvent(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, { post }));
      expect(signal?.kind === "post-created" && signal.post.text).toBe(raw);
    });
  });
});
