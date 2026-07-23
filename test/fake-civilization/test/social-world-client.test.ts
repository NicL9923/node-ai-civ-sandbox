import type { components } from "@ai-civ/federation-contracts";
import { describe, expect, it } from "vitest";
import { ScriptedTransport, WorldHttpError } from "../src/transport.js";
import { WorldFederationDriver } from "../src/world-client.js";

const json = (status: number, body: unknown, contentType = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });

const authorization: components["schemas"]["SocialMutationAuthorization"] = {
  actingLocalAgentId: "agent-1",
  authorityDecision: { mode: "delegated", ref: "decision-1" },
};

const account: components["schemas"]["SocialAccount"] = {
  accountId: "acct-1",
  actor: {
    civId: "civ_aurora",
    localAgentId: "agent-1",
    displayName: "Agent One",
    kind: "agent",
  },
  status: "active",
  bio: "",
  followerCount: 0,
  followingCount: 0,
  postCount: 1,
  rateLimitPolicy: {
    postCooldownSeconds: 0,
    postsPerWindow: 10,
    reactionsPerWindow: 10,
    followsPerWindow: 10,
    windowSeconds: 60,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  worldsequence: "1",
};

const post: components["schemas"]["SocialPost"] = {
  postId: "post-1",
  author: {
    accountId: account.accountId,
    actor: account.actor,
    status: account.status,
  },
  status: "published",
  text: "hello",
  parentPostId: null,
  conversationRootPostId: "post-1",
  replyDepth: 0,
  replyCount: 0,
  likeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
  worldsequence: "2",
};

function driver(transport: ScriptedTransport): WorldFederationDriver {
  let nonce = 0;
  return new WorldFederationDriver({
    baseUrl: "https://world.test/world/v1",
    transport,
    credentials: () => ({
      civId: "civ_aurora",
      keyId: "key_aurora",
      secret: "never-log-social-secret",
    }),
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    nonceSource: { next: () => `social-nonce-${++nonce}` },
  });
}

describe("WorldFederationDriver social routes", () => {
  it("sends exact generated methods, paths, queries, bodies, and auth headers", async () => {
    const transport = new ScriptedTransport();
    const syncBody: components["schemas"]["SocialAccountSyncRequest"] = {
      civId: "civ_aurora",
      accounts: [{ actor: account.actor }],
    };
    const postBody: components["schemas"]["SocialPostCreateRequest"] = {
      authorAccountId: account.accountId,
      text: "hello",
      authorization,
    };
    const followBody: components["schemas"]["SocialFollowSetRequest"] = {
      following: true,
      authorization,
    };
    const tombstoneBody: components["schemas"]["SocialPostTombstoneRequest"] = { authorization };
    const likeBody: components["schemas"]["SocialReactionSetRequest"] = {
      liked: true,
      authorization,
    };
    const pageQuery = "cursor=cursor-1&limit=2";
    const commonPage = { items: [post], nextCursor: null };
    const accountPage = {
      items: [{ accountId: account.accountId, actor: account.actor, status: account.status }],
      nextCursor: null,
    };
    const expectations = [
      {
        method: "POST",
        path: "/world/v1/social/accounts/sync",
        body: JSON.stringify(syncBody),
        headers: { "Idempotency-Key": "sync-1", "X-Civ-Id": "civ_aurora" },
        reply: json(200, { accounts: [account] }),
      },
      {
        method: "GET",
        path: "/world/v1/social/accounts/acct-1",
        reply: json(200, account),
      },
      {
        method: "GET",
        path: "/world/v1/social/accounts/acct-1/posts",
        query: pageQuery,
        reply: json(200, commonPage),
      },
      {
        method: "GET",
        path: "/world/v1/social/accounts/acct-1/feed",
        query: pageQuery,
        reply: json(200, commonPage),
      },
      {
        method: "GET",
        path: "/world/v1/social/accounts/acct-1/followers",
        query: pageQuery,
        reply: json(200, accountPage),
      },
      {
        method: "GET",
        path: "/world/v1/social/accounts/acct-1/following",
        query: pageQuery,
        reply: json(200, accountPage),
      },
      {
        method: "PUT",
        path: "/world/v1/social/accounts/acct-1/following/acct-2",
        body: JSON.stringify(followBody),
        headers: { "Idempotency-Key": "follow-1", "X-Civ-Id": "civ_aurora" },
        reply: json(200, {
          followerAccountId: "acct-1",
          followedAccountId: "acct-2",
          following: true,
          changed: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          worldsequence: "3",
        }),
      },
      {
        method: "GET",
        path: "/world/v1/social/feed",
        query: pageQuery,
        reply: json(200, commonPage),
      },
      {
        method: "POST",
        path: "/world/v1/social/posts",
        body: JSON.stringify(postBody),
        headers: { "Idempotency-Key": "post-1", "X-Civ-Id": "civ_aurora" },
        reply: json(201, post),
      },
      {
        method: "GET",
        path: "/world/v1/social/posts/post-1",
        reply: json(200, post),
      },
      {
        method: "GET",
        path: "/world/v1/social/posts/post-1/thread",
        query: pageQuery,
        reply: json(200, {
          conversationRootPostId: "post-1",
          items: [post],
          nextCursor: null,
        }),
      },
      {
        method: "POST",
        path: "/world/v1/social/posts/post-1/tombstone",
        body: JSON.stringify(tombstoneBody),
        headers: { "Idempotency-Key": "tombstone-1", "X-Civ-Id": "civ_aurora" },
        reply: json(200, {
          ...post,
          status: "tombstoned",
          text: null,
          tombstonedAt: "2026-01-01T00:01:00.000Z",
        }),
      },
      {
        method: "PUT",
        path: "/world/v1/social/posts/post-1/likes/acct-1",
        body: JSON.stringify(likeBody),
        headers: { "Idempotency-Key": "like-1", "X-Civ-Id": "civ_aurora" },
        reply: json(200, {
          postId: "post-1",
          accountId: "acct-1",
          liked: true,
          changed: true,
          likeCount: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          worldsequence: "4",
        }),
      },
    ] as const;
    expectations.forEach((expectation) => transport.enqueue(expectation));

    const client = driver(transport);
    await client.syncSocialAccounts(syncBody, "sync-1");
    await client.getSocialAccount("acct-1");
    await client.listSocialAccountPosts("acct-1", { cursor: "cursor-1", limit: 2 });
    await client.listSocialFollowingFeed("acct-1", { cursor: "cursor-1", limit: 2 });
    await client.listSocialFollowers("acct-1", { cursor: "cursor-1", limit: 2 });
    await client.listSocialFollowing("acct-1", { cursor: "cursor-1", limit: 2 });
    await client.setSocialFollow("acct-1", "acct-2", followBody, "follow-1");
    await client.listSocialGlobalFeed({ cursor: "cursor-1", limit: 2 });
    await client.createSocialPost(postBody, "post-1");
    await client.getSocialPost("post-1");
    await client.getSocialThread("post-1", { cursor: "cursor-1", limit: 2 });
    await client.tombstoneSocialPost("post-1", tombstoneBody, "tombstone-1");
    await client.setSocialPostLike("post-1", "acct-1", likeBody, "like-1");

    transport.assertDrained();
    const publicEntries = transport.journal.filter((entry) => entry.method === "GET");
    expect(publicEntries.every((entry) => entry.headers["x-civ-id"] === undefined)).toBe(true);
    expect(JSON.stringify(transport.journal)).not.toContain("never-log-social-secret");
  });

  it("surfaces social ProblemDetails without success-shaped fallbacks", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({
      method: "PUT",
      path: "/world/v1/social/accounts/acct-1/following/acct-1",
      reply: json(409, {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        code: "self_follow_forbidden",
      }, "application/problem+json"),
    });

    await expect(driver(transport).setSocialFollow(
      "acct-1",
      "acct-1",
      { following: true, authorization },
      "self-follow-1",
    )).rejects.toMatchObject<Partial<WorldHttpError>>({
      status: 409,
      problem: { code: "self_follow_forbidden" },
    });
  });

  it("replays identical intent bytes and exposes a different-byte idempotency conflict", async () => {
    const transport = new ScriptedTransport();
    const original = {
      authorAccountId: "acct-1",
      text: "stable bytes",
      authorization,
    };
    const different = { ...original, text: "different bytes" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      transport.enqueue({
        method: "POST",
        path: "/world/v1/social/posts",
        body: JSON.stringify(original),
        headers: { "Idempotency-Key": "post-idem-1" },
        reply: json(201, post),
      });
    }
    transport.enqueue({
      method: "POST",
      path: "/world/v1/social/posts",
      body: JSON.stringify(different),
      headers: { "Idempotency-Key": "post-idem-1" },
      reply: json(409, {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        code: "idempotency_conflict",
      }, "application/problem+json"),
    });
    const client = driver(transport);

    expect(await client.createSocialPost(original, "post-idem-1")).toEqual(post);
    expect(await client.createSocialPost(original, "post-idem-1")).toEqual(post);
    await expect(client.createSocialPost(different, "post-idem-1")).rejects.toMatchObject({
      status: 409,
      problem: { code: "idempotency_conflict" },
    });
    expect(transport.journal.map((entry) => entry.headers["idempotency-key"])).toEqual([
      "post-idem-1",
      "post-idem-1",
      "post-idem-1",
    ]);
  });

  it("allows public social reads without configured signing credentials", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({
      method: "GET",
      path: "/world/v1/social/feed",
      reply: json(200, { items: [post], nextCursor: null }),
    });
    const client = new WorldFederationDriver({
      baseUrl: "https://world.test/world/v1",
      transport,
    });

    expect(await client.listSocialGlobalFeed()).toEqual({ items: [post], nextCursor: null });
    expect(transport.journal[0]?.headers["x-signature"]).toBeUndefined();
  });
});
