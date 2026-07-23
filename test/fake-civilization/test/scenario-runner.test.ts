import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { components } from "@ai-civ/federation-contracts";
import { describe, expect, it } from "vitest";
import type { SigningFault, SyncResult } from "../src/fake-civilization.js";
import { loadScenario, validateScenario } from "../src/scenario/loader.js";
import { runScenario } from "../src/scenario/runner.js";
import type { ScenarioCivilization } from "../src/scenario/types.js";
import { ScenarioDefinitionError, ScenarioHostControlError } from "../src/scenario/types.js";
import { WorldHttpError } from "../src/transport.js";

class ScenarioActorStub implements ScenarioCivilization {
  readonly state = { online: true };
  registerCalls = 0;
  lastCreatedPostAuthor?: string;
  fault: SigningFault = "none";

  async register(): Promise<components["schemas"]["RegistrationResponse"]> {
    this.registerCalls += 1;
    return {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
      duplicate: this.registerCalls > 1,
    };
  }

  async heartbeat(): Promise<components["schemas"]["HeartbeatAck"]> {
    if (this.fault !== "none") {
      throw new WorldHttpError(401, {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "invalid_signature",
      });
    }
    return { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" };
  }

  async pushEvents(): Promise<components["schemas"]["EventBatchResult"]> {
    return { results: [], acceptedCount: 0, duplicateCount: 0 };
  }

  async pull(): Promise<components["schemas"]["CommandPage"]> {
    return { items: [], nextCursor: null };
  }

  async sync(): Promise<SyncResult> {
    return {
      blockedOffline: !this.state.online,
      pages: this.state.online ? 1 : 0,
      applied: 0,
      rejected: 0,
      duplicates: 0,
      capped: false,
      cursor: null,
    };
  }

  async ack(commandId: string): Promise<components["schemas"]["CommandAckResult"]> {
    return { commandId, status: "applied" };
  }

  async submitInteraction(): Promise<components["schemas"]["Accepted"]> {
    return { status: "accepted", statusUrl: "/interactions/int-1", resourceId: "int-1" };
  }

  async getInteraction(interactionId: string): Promise<components["schemas"]["Interaction"]> {
    return {
      interactionId,
      kind: "contact",
      source: "civ_aurora",
      target: "civ_borealis",
      status: "acknowledged",
      public: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async getCivilization(civId: string): Promise<components["schemas"]["PublicProjection"]> {
    return {
      civId,
      displayName: "Aurora",
      protocolVersion: "1",
      turn: 1,
      running: true,
      population: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async listCivilizations(): Promise<components["schemas"]["CivilizationListPage"]> {
    return { items: [], nextCursor: null };
  }

  async listRelationships(): Promise<components["schemas"]["RelationshipPage"]> {
    return { items: [], nextCursor: null };
  }

  async listEvents(): Promise<components["schemas"]["EventPage"]> {
    return { items: [], nextCursor: null };
  }

  async syncSocialAccounts(): Promise<components["schemas"]["SocialAccountSyncResponse"]> {
    return { accounts: [socialAccount("acct-1"), socialAccount("acct-2")] };
  }

  async getSocialAccount(accountId: string): Promise<components["schemas"]["SocialAccount"]> {
    return socialAccount(accountId);
  }

  async listSocialAccountPosts(): Promise<components["schemas"]["SocialPostPage"]> {
    return { items: [], nextCursor: null };
  }

  async listSocialFollowingFeed(): Promise<components["schemas"]["SocialPostPage"]> {
    return { items: [], nextCursor: null };
  }

  async listSocialFollowers(): Promise<components["schemas"]["SocialAccountPage"]> {
    return { items: [], nextCursor: null };
  }

  async listSocialFollowing(): Promise<components["schemas"]["SocialAccountPage"]> {
    return { items: [], nextCursor: null };
  }

  async setSocialFollow(
    accountId: string,
    targetAccountId: string,
    body: components["schemas"]["SocialFollowSetRequest"],
  ): Promise<components["schemas"]["SocialFollow"]> {
    return {
      followerAccountId: accountId,
      followedAccountId: targetAccountId,
      following: body.following,
      changed: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      worldsequence: "1",
    };
  }

  async listSocialGlobalFeed(): Promise<components["schemas"]["SocialPostPage"]> {
    return { items: [], nextCursor: null };
  }

  async createSocialPost(
    body: components["schemas"]["SocialPostCreateRequest"],
  ): Promise<components["schemas"]["SocialPost"]> {
    this.lastCreatedPostAuthor = body.authorAccountId;
    return socialPost(body.authorAccountId, body.parentPostId);
  }

  async getSocialPost(): Promise<components["schemas"]["SocialPost"]> {
    return socialPost("acct-1");
  }

  async getSocialThread(): Promise<components["schemas"]["SocialThreadPage"]> {
    return { conversationRootPostId: "post-1", items: [], nextCursor: null };
  }

  async tombstoneSocialPost(): Promise<components["schemas"]["SocialPost"]> {
    return { ...socialPost("acct-1"), status: "tombstoned", text: null, tombstonedAt: "2026-01-01T00:01:00.000Z" };
  }

  async setSocialPostLike(
    postId: string,
    accountId: string,
    body: components["schemas"]["SocialReactionSetRequest"],
  ): Promise<components["schemas"]["SocialReaction"]> {
    return {
      postId,
      accountId,
      liked: body.liked,
      changed: true,
      likeCount: body.liked ? 1 : 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      worldsequence: "1",
    };
  }

  setSigningFault(fault: SigningFault): void {
    this.fault = fault;
  }
}

function socialAccount(accountId: string): components["schemas"]["SocialAccount"] {
    return {
      accountId,
      actor: { civId: "civ_aurora", localAgentId: "agent-1", displayName: "Agent One", kind: "agent" },
      status: "active",
      bio: "",
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
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
}

function socialPost(
  accountId: string,
  parentPostId?: string,
): components["schemas"]["SocialPost"] {
    return {
      postId: "post-1",
      author: {
        accountId,
        actor: { civId: "civ_aurora", localAgentId: "agent-1", displayName: "Agent One", kind: "agent" },
        status: "active",
      },
      status: "published",
      text: "hello",
      parentPostId: parentPostId ?? null,
      conversationRootPostId: "post-1",
      replyDepth: parentPostId ? 1 : 0,
      replyCount: 0,
      likeCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      tombstonedAt: null,
      worldsequence: "1",
    };
}

describe("scenario fixtures", () => {
  it("loads all checked-in versioned fixtures with JSON Pointer assertions", async () => {
    const directory = new URL("../scenarios/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".scenario.json"));
    expect(files).toHaveLength(11);
    for (const file of files) {
      const scenario = await loadScenario(fileURLToPath(new URL(file, directory)));
      expect(scenario.schemaVersion).toBe("1");
      for (const step of scenario.steps) {
        if (step.op === "assert") expect(step.actual.startsWith("/")).toBe(true);
      }
    }
  });

  it("replays prior operations, matches expected errors, and uses primitive assertions", async () => {
    const actor = new ScenarioActorStub();
    const result = await runScenario({
      schemaVersion: "1",
      name: "runner",
      actors: {
        aurora: {
          displayName: "Aurora",
          credentialRef: "aurora",
          capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
        },
      },
      steps: [
        { id: "register", op: "register", actor: "aurora", idempotencyKey: "register-1" },
        { op: "replay", stepId: "register", saveAs: "duplicate" },
        { op: "assert", actual: "/duplicate/duplicate", equals: true },
        { op: "setAuthFault", actor: "aurora", fault: "invalid-signature" },
        { op: "heartbeat", actor: "aurora", expectError: { status: 401, code: "invalid_signature" }, saveAs: "authError" },
        { op: "assert", actual: "/authError/status", equals: 401 },
      ],
    }, { createActor: () => actor });
    expect(result.completedSteps).toBe(6);
    expect(actor.registerCalls).toBe(2);
  });

  it("rejects arrange without injected host controls", async () => {
    await expect(runScenario({
      schemaVersion: "1",
      name: "host required",
      actors: {},
      steps: [{ op: "arrange", action: "queueCommand" }],
    }, {
      createActor: () => new ScenarioActorStub(),
    })).rejects.toBeInstanceOf(ScenarioHostControlError);
  });

  it("rejects operations outside the fixed DSL during loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fake-civ-scenario-"));
    const path = join(directory, "invalid.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: "1",
      name: "invalid",
      actors: {},
      steps: [{ op: "eval", value: "process.exit()" }],
    }), "utf8");
    try {
      await expect(loadScenario(path)).rejects.toThrow("Unsupported scenario operation");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("resolves only validated absolute value references into later social inputs", async () => {
    const actor = new ScenarioActorStub();
    const result = await runScenario(validateScenario({
      schemaVersion: "1",
      name: "social references",
      actors: {
        aurora: {
          displayName: "Aurora",
          credentialRef: "aurora",
          capabilities: {
            protocolVersion: "1.0.0",
            supportedInteractionKinds: ["contact"],
            features: ["world-wire-social-v1"],
          },
        },
      },
      steps: [
        {
          id: "accounts",
          op: "syncSocialAccounts",
          actor: "aurora",
          body: {
            civId: "civ_aurora",
            accounts: [{
              actor: {
                civId: "civ_aurora",
                kind: "agent",
                localAgentId: "agent-1",
                displayName: "Agent One",
              },
            }],
          },
        },
        {
          id: "post",
          op: "createSocialPost",
          actor: "aurora",
          body: {
            authorAccountId: { valueFrom: "/accounts/accounts/0/accountId" },
            text: "hello",
            authorization: {
              actingLocalAgentId: "agent-1",
              authorityDecision: { mode: "delegated", ref: "post-1" },
            },
          },
        },
        {
          op: "assert",
          actual: "/post/author/accountId",
          equals: { valueFrom: "/accounts/accounts/0/accountId" },
        },
      ],
    }), { createActor: () => actor });

    expect(actor.lastCreatedPostAuthor).toBe("acct-1");
    expect(result.values.post).toMatchObject({ author: { accountId: "acct-1" } });
  });

  it.each([
    [{ valueFrom: "relative" }, "absolute JSON Pointer"],
    [{ valueFrom: "/accounts", extra: true }, "unsupported field"],
  ])("rejects malformed value references", (reference, message) => {
    expect(() => validateScenario({
      schemaVersion: "1",
      name: "invalid reference",
      actors: {
        aurora: {
          displayName: "Aurora",
          credentialRef: "aurora",
          capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
        },
      },
      steps: [{ op: "getSocialAccount", actor: "aurora", accountId: reference }],
    })).toThrow(message);
  });

  it("accepts contract-valid zero official terms", () => {
    expect(() => validateScenario({
      schemaVersion: "1",
      name: "term zero",
      actors: {
        aurora: {
          displayName: "Aurora",
          credentialRef: "aurora",
          capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
        },
      },
      steps: [{
        op: "syncSocialAccounts",
        actor: "aurora",
        body: {
          civId: "civ_aurora",
          accounts: [{
            actor: { civId: "civ_aurora", kind: "official", displayName: "Aurora Presidency" },
            officialAuthority: {
              presidentLocalAgentId: "agent-president",
              presidentDisplayName: "President Sol",
              termNumber: 0,
              authorityDecision: { mode: "president", ref: "term-0" },
            },
          }],
        },
      }, {
        op: "createSocialPost",
        actor: "aurora",
        body: {
          authorAccountId: "acct-official",
          text: "First term",
          authorization: {
            actingLocalAgentId: "agent-president",
            officialTermNumber: 0,
            authorityDecision: { mode: "president", ref: "term-0" },
          },
        },
      }],
    })).not.toThrow();
  });

  it("does not traverse inherited properties in JSON Pointer reads", async () => {
    await expect(runScenario({
      schemaVersion: "1",
      name: "own properties only",
      actors: {},
      steps: [{ op: "assert", actual: "/constructor", exists: false }],
    }, { createActor: () => new ScenarioActorStub() })).resolves.toMatchObject({
      completedSteps: 1,
    });
  });

  it("keeps the Unicode boundary fixture at 280 and 281 code points", async () => {
    const fixture = await loadScenario(fileURLToPath(
      new URL("../scenarios/world-wire-posts.scenario.json", import.meta.url),
    ));
    const creates = fixture.steps.filter((step) => step.op === "createSocialPost");
    const at280 = creates.find((step) => step.idempotencyKey === "wire-post-unicode-280");
    const at281 = creates.find((step) => step.idempotencyKey === "wire-post-unicode-281");
    if (at280?.op !== "createSocialPost" || at281?.op !== "createSocialPost") {
      throw new Error("Unicode boundary steps are missing");
    }
    expect(Array.from(at280.body.text as string)).toHaveLength(280);
    expect(Array.from(at281.body.text as string)).toHaveLength(281);
  });

  it("keeps every requested World Wire scenario behavior checked in", async () => {
    const directory = new URL("../scenarios/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.startsWith("world-wire-"));
    const scenarios = await Promise.all(
      files.map((file) => loadScenario(fileURLToPath(new URL(file, directory)))),
    );
    const steps = scenarios.flatMap((scenario) => scenario.steps);
    const operations = new Set(steps.map((step) => step.op));
    expect([...operations]).toEqual(expect.arrayContaining([
      "syncSocialAccounts",
      "getSocialAccount",
      "listSocialAccountPosts",
      "listSocialFollowingFeed",
      "listSocialFollowers",
      "listSocialFollowing",
      "setSocialFollow",
      "listSocialGlobalFeed",
      "createSocialPost",
      "getSocialPost",
      "getSocialThread",
      "tombstoneSocialPost",
      "setSocialPostLike",
      "listEvents",
      "arrange",
    ]));
    const problemCodes = steps.flatMap((step) =>
      "expectError" in step && step.expectError?.code ? [step.expectError.code] : []);
    expect(problemCodes).toEqual(expect.arrayContaining([
      "content_too_long",
      "reply_depth_exceeded",
      "self_follow_forbidden",
      "idempotency_conflict",
      "cursor_filter_mismatch",
    ]));
  });

  it.each([
    ["actors", {
      schemaVersion: "1", name: "invalid actor", actors: { aurora: null }, steps: [],
    }],
    ["network", {
      schemaVersion: "1", name: "invalid network", actors: {}, steps: [{ op: "heartbeat" }],
    }],
    ["network bounds", {
      schemaVersion: "1",
      name: "invalid network bounds",
      actors: {
        aurora: {
          displayName: "Aurora",
          credentialRef: "aurora",
          capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
        },
      },
      steps: [{ op: "listEvents", actor: "aurora", limit: 201 }],
    }],
    ["state", {
      schemaVersion: "1", name: "invalid state", actors: {}, steps: [{ op: "setOnline", actor: "aurora", online: "true" }],
    }],
    ["auth", {
      schemaVersion: "1", name: "invalid auth", actors: {}, steps: [{ op: "setAuthFault", actor: "aurora", fault: "eval" }],
    }],
    ["assert", {
      schemaVersion: "1", name: "invalid assertion", actors: {}, steps: [{ op: "assert", actual: 4, equals: true }],
    }],
    ["arrange", {
      schemaVersion: "1", name: "invalid arrange", actors: {}, steps: [{ op: "arrange", action: "" }],
    }],
    ["replay", {
      schemaVersion: "1", name: "invalid replay", actors: {}, steps: [{ op: "replay", stepId: "missing" }],
    }],
  ])("rejects malformed %s DSL shapes with a definition error", (_family, scenario) => {
    expect(() => validateScenario(scenario)).toThrow(ScenarioDefinitionError);
  });
});
