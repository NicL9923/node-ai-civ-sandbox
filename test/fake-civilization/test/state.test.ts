import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInitialState, loadState, saveState, serializeState } from "../src/state.js";
import { FakeCivilization } from "../src/fake-civilization.js";
import { ScriptedTransport } from "../src/transport.js";

describe("fake civilization state", () => {
  it("persists only state supplied to it atomically", async () => {
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    const serialized = serializeState(state);
    expect(serialized).not.toContain("onboardingToken");
    expect(serialized).not.toContain("hmacSecret");
    const path = join(process.cwd(), "test", "fake-civilization", ".state-test.json");
    try {
      await saveState(path, state);
      expect(await loadState(path)).toEqual(state);
    } finally {
      await rm(path, { force: true });
    }
  });

  it("reserves deterministic event ids when events are created", () => {
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    const civilization = new FakeCivilization({
      alias: "aurora",
      displayName: "Aurora",
      worldBaseUrl: "https://world.test/world/v1",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, { state, clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } });
    expect(civilization.createEvent("civ.test.v1", {}).id).toBe("aurora-evt-1");
    expect(civilization.createEvent("civ.test.v1", {}).id).toBe("aurora-evt-2");
    expect(state.nextEventSequence).toBe(3);
  });

  it("defaults legacy state files to an empty social mirror", async () => {
    const state = createInitialState("Aurora", "1.0.0");
    const path = join(process.cwd(), "test", "fake-civilization", ".legacy-state-test.json");
    const { social: _social, ...legacy } = state;
    try {
      await saveState(path, legacy as typeof state);
      expect((await loadState(path)).social).toEqual({
        accounts: {},
        officialAuthorities: {},
        posts: {},
        follows: {},
        likes: {},
      });
    } finally {
      await rm(path, { force: true });
    }
  });

  it("records successful social accounts, authority, posts, follows, and likes without secrets", async () => {
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    const transport = new ScriptedTransport();
    const account = {
      accountId: "acct-official",
      actor: { civId: "civ_aurora", displayName: "Aurora Presidency", kind: "official" },
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
    const post = {
      postId: "post-1",
      author: { accountId: account.accountId, actor: account.actor, status: account.status },
      status: "published" as const,
      text: "Official statement",
      parentPostId: null,
      conversationRootPostId: "post-1",
      replyDepth: 0,
      replyCount: 0,
      likeCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      tombstonedAt: null,
      worldsequence: "2",
    };
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    [
      reply(200, { accounts: [account] }),
      reply(201, post),
      reply(200, {
        followerAccountId: account.accountId,
        followedAccountId: "acct-target",
        following: true,
        changed: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
        worldsequence: "3",
      }),
      reply(200, {
        postId: post.postId,
        accountId: account.accountId,
        liked: true,
        changed: true,
        likeCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        worldsequence: "4",
      }),
      reply(200, {
        ...post,
        status: "tombstoned",
        text: null,
        tombstonedAt: "2026-01-01T00:01:00.000Z",
      }),
    ].forEach((response) => transport.enqueue({ reply: response }));
    const civilization = new FakeCivilization({
      alias: "aurora",
      displayName: "Aurora",
      worldBaseUrl: "https://world.test/world/v1",
      hmacSecret: "never-persist-social-secret",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, { state, transport });
    const officialAuthority = {
      presidentLocalAgentId: "agent-president",
      presidentDisplayName: "President Sol",
      termNumber: 3,
      authorityDecision: { mode: "president", ref: "term-3" },
    };
    const authorization = {
      actingLocalAgentId: "agent-president",
      officialTermNumber: 3,
      authorityDecision: { mode: "president", ref: "term-3" },
    };

    await civilization.syncSocialAccounts({
      civId: "civ_aurora",
      accounts: [{ actor: account.actor, officialAuthority }],
    });
    await civilization.createSocialPost({
      authorAccountId: account.accountId,
      text: "Official statement",
      authorization,
    });
    await civilization.setSocialFollow(account.accountId, "acct-target", {
      following: true,
      authorization,
    });
    await civilization.setSocialPostLike(post.postId, account.accountId, {
      liked: true,
      authorization,
    });
    await civilization.tombstoneSocialPost(post.postId, { authorization });

    expect(state.social.accounts[account.accountId]).toEqual(account);
    expect(state.social.officialAuthorities[account.accountId]).toEqual(officialAuthority);
    expect(state.social.posts[post.postId]?.status).toBe("tombstoned");
    expect(state.social.follows[JSON.stringify([account.accountId, "acct-target"])]?.changed).toBe(true);
    expect(state.social.likes[JSON.stringify([post.postId, account.accountId])]?.liked).toBe(true);
    expect(serializeState(state)).not.toContain("never-persist-social-secret");
  });

  it("reserves distinct automatic idempotency keys before concurrent social mutations", async () => {
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    const transport = new ScriptedTransport();
    for (const postId of ["post-1", "post-2"]) {
      transport.enqueue({
        method: "POST",
        path: "/world/v1/social/posts",
        reply: new Response(JSON.stringify({
          postId,
          author: {
            accountId: "acct-1",
            actor: {
              civId: "civ_aurora",
              localAgentId: "agent-1",
              displayName: "Agent One",
              kind: "agent",
            },
            status: "active",
          },
          status: "published",
          text: postId,
          parentPostId: null,
          conversationRootPostId: postId,
          replyDepth: 0,
          replyCount: 0,
          likeCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          tombstonedAt: null,
          worldsequence: postId === "post-1" ? "1" : "2",
        }), { status: 201, headers: { "content-type": "application/json" } }),
      });
    }
    const civilization = new FakeCivilization({
      alias: "aurora",
      displayName: "Aurora",
      worldBaseUrl: "https://world.test/world/v1",
      hmacSecret: "shared-secret",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, { state, transport });
    const authorization = {
      actingLocalAgentId: "agent-1",
      authorityDecision: { mode: "delegated", ref: "concurrent-posts" },
    };

    await Promise.all([
      civilization.createSocialPost({
        authorAccountId: "acct-1",
        text: "first",
        authorization,
      }),
      civilization.createSocialPost({
        authorAccountId: "acct-1",
        text: "second",
        authorization,
      }),
    ]);

    expect(transport.journal.map((entry) => entry.headers["idempotency-key"])).toEqual([
      "aurora-social-post-1",
      "aurora-social-post-2",
    ]);
  });
});
