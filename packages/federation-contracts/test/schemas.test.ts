import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { components } from "../generated/ts/world.v1.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bundled = JSON.parse(
  readFileSync(resolve(pkgRoot, "openapi/world.v1.bundled.json"), "utf8"),
) as Record<string, unknown>;

// OpenAPI 3.1 schemas are JSON Schema 2020-12. We register the whole bundled
// document under the base id "world" and validate examples by $ref-ing into its
// components. `validateSchema:false` avoids meta-validating the (non-schema)
// OpenAPI root; `strict:false` ignores OpenAPI-only keywords (example, xml, ...).
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addSchema(bundled, "world");

function validatorFor(schema: string): ValidateFunction {
  return ajv.compile({ $ref: `world#/components/schemas/${schema}` });
}

function example(file: string): unknown {
  return JSON.parse(readFileSync(resolve(pkgRoot, "examples", file), "utf8"));
}

const positives: Array<[string, string]> = [
  ["RegistrationRequest", "register.request.json"],
  ["RegistrationResponse", "register.response.json"],
  ["Heartbeat", "heartbeat.request.json"],
  ["InteractionRequest", "interaction.contact.request.json"],
  ["InteractionRequest", "interaction.message.request.json"],
  ["ContactIntentData", "contact.intent.data.json"],
  ["MessageIntentData", "message.intent.data.json"],
  ["Command", "command.json"],
  ["EventBatch", "eventBatch.request.json"],
  ["CommandAck", "commandAck.request.json"],
  ["ProblemDetails", "problemDetails.json"],
  ["SocialAccountSyncRequest", "social.account-sync.request.json"],
  ["SocialAccountSyncResponse", "social.account-sync.response.json"],
  ["SocialPostCreateRequest", "social.post-create.request.json"],
  ["SocialPostCreateRequest", "social.reply-create.request.json"],
  ["SocialPostCreateRequest", "social.official-post-create.request.json"],
  ["SocialPost", "social.post.json"],
  ["SocialPost", "social.post-tombstone.json"],
  ["SocialPostPage", "social.feed.page.json"],
  ["SocialReactionSetRequest", "social.reaction-set.request.json"],
  ["SocialFollowSetRequest", "social.follow-set.request.json"],
  ["SocialAccountSyncedEventData", "social.event.account-synced.data.json"],
  ["SocialPostCreatedEventData", "social.event.post-created.data.json"],
  ["SocialReplyCreatedEventData", "social.event.reply-created.data.json"],
  ["SocialPostReactionChangedEventData", "social.event.reaction-changed.data.json"],
  ["SocialFollowChangedEventData", "social.event.follow-changed.data.json"],
  ["SocialPostTombstonedEventData", "social.event.post-tombstoned.data.json"],
];

describe("example fixtures validate against their schemas", () => {
  it.each(positives)("%s accepts %s", (schema, file) => {
    const validate = validatorFor(schema);
    const ok = validate(example(file));
    if (!ok) console.error(schema, validate.errors);
    expect(ok).toBe(true);
  });
});

describe("typed interaction payloads validate against their kind's payload schema", () => {
  it("contact request payload conforms to ContactIntentData", () => {
    const req = example("interaction.contact.request.json") as { payload: unknown };
    expect(validatorFor("ContactIntentData")(req.payload)).toBe(true);
  });

  it("message request payload conforms to MessageIntentData", () => {
    const req = example("interaction.message.request.json") as { payload: unknown };
    expect(validatorFor("MessageIntentData")(req.payload)).toBe(true);
  });
});

describe("schemas reject invalid documents", () => {
  it("RegistrationRequest requires displayName and capabilities", () => {
    const validate = validatorFor("RegistrationRequest");
    expect(validate({ onboardingToken: "onb_x" })).toBe(false);
  });

  it("InteractionRequest requires source, target, and authorityDecision", () => {
    const validate = validatorFor("InteractionRequest");
    expect(validate({ kind: "contact", source: "civ_a" })).toBe(false);
  });

  it("ProblemDetails requires the stable code field", () => {
    const validate = validatorFor("ProblemDetails");
    expect(
      validate({ type: "about:blank", title: "x", status: 400 }),
    ).toBe(false);
  });

  it("CloudEvent worldsequence must be a string int64, not a JSON number", () => {
    const validate = validatorFor("CloudEvent");
    const base = {
      id: "e1",
      specversion: "1.0",
      type: "civ.agent.acted.v1",
      source: "/civilizations/civ_a",
    };
    expect(validate({ ...base, worldsequence: "1024" })).toBe(true);
    expect(validate({ ...base, worldsequence: 1024 })).toBe(false);
  });

  it("InteractionStatus is a closed enum", () => {
    const validate = validatorFor("InteractionStatus");
    expect(validate("delivered")).toBe(true);
    expect(validate("teleported")).toBe(false);
  });

  it("InteractionKind is an open string (forward compatible)", () => {
    const validate = validatorFor("InteractionKind");
    expect(validate("contact")).toBe(true);
    // A future additive kind must NOT break existing validators.
    expect(validate("trade")).toBe(true);
  });

  it("counts post text in Unicode code points rather than UTF-16 code units", () => {
    const validate = validatorFor("SocialPostCreateRequest");
    const base = example("social.post-create.request.json") as Record<string, unknown>;
    expect(validate({ ...base, text: "😀".repeat(280) })).toBe(true);
    expect(validate({ ...base, text: "😀".repeat(281) })).toBe(false);
    expect(validate({ ...base, text: " \n\t " })).toBe(false);
  });

  it("bounds account sync batches and rejects reserved system upserts", () => {
    const validate = validatorFor("SocialAccountSyncRequest");
    const request = example("social.account-sync.request.json") as {
      civId: string;
      accounts: unknown[];
    };
    expect(validate({ ...request, accounts: Array.from({ length: 101 }, (_, i) => ({
      actor: {
        civId: request.civId,
        localAgentId: `agent_${i}`,
        displayName: `Agent ${i}`,
        kind: "agent",
      },
    })) })).toBe(false);
    expect(validate({
      civId: request.civId,
      accounts: [{ actor: { civId: request.civId, displayName: "World", kind: "system" } }],
    })).toBe(false);
  });

  it("requires official authority with a President-term decision reference", () => {
    const validate = validatorFor("SocialAccountUpsert");
    const official = {
      actor: { civId: "civ_a", displayName: "Civ A", kind: "official" },
      officialAuthority: {
        presidentLocalAgentId: "agent_p",
        presidentDisplayName: "President P",
        termNumber: 2,
        authorityDecision: { mode: "president", ref: "term_2" },
      },
    };
    expect(validate(official)).toBe(true);
    expect(validate({ actor: official.actor })).toBe(false);
    expect(validate({
      ...official,
      officialAuthority: {
        ...official.officialAuthority,
        authorityDecision: { mode: "president" },
      },
    })).toBe(false);
  });

  it("generates a constructible strict social authorization type", () => {
    const authorization = {
      actingLocalAgentId: "agent_p",
      officialTermNumber: 2,
      authorityDecision: { mode: "president", ref: "term_2" },
    } satisfies components["schemas"]["SocialMutationAuthorization"];
    expect(authorization.authorityDecision.ref).toBe("term_2");
  });

  it("keeps account kinds open while post lifecycle remains closed", () => {
    expect(validatorFor("SocialAccountKind")("collective")).toBe(true);
    const validateStatus = validatorFor("SocialPostStatus");
    expect(validateStatus("published")).toBe(true);
    expect(validateStatus("tombstoned")).toBe(true);
    expect(validateStatus("edited")).toBe(false);
  });

  it("enforces bounded reply depth and terminal text-free tombstones", () => {
    const validate = validatorFor("SocialPost");
    const post = example("social.post.json") as Record<string, unknown>;
    const tombstone = example("social.post-tombstone.json") as Record<string, unknown>;
    const deepReply = {
      ...post,
      parentPostId: "post_parent",
      conversationRootPostId: "post_root",
      replyDepth: 4,
    };
    expect(validate(deepReply)).toBe(true);
    expect(validate({ ...deepReply, replyDepth: 5 })).toBe(false);
    expect(validate({ ...tombstone, text: "leaked original text" })).toBe(false);
    expect(validate({ ...post, text: null })).toBe(false);
  });

  it("retains the open CloudEvent payload fallback for future social types", () => {
    const validate = validatorFor("CloudEvent");
    expect(validate({
      id: "evt_future",
      specversion: "1.0",
      type: "world.social.poll.created.v1",
      source: "/world/social",
      data: { futureField: { nested: true } },
      worldsequence: "9999",
    })).toBe(true);
  });

  it("requires privacy-safe typed data for every known social event", () => {
    const validate = validatorFor("CloudEvent");
    const base = {
      id: "evt_tombstone",
      specversion: "1.0",
      type: "world.social.post.tombstoned.v1",
      source: "/world/social",
      worldsequence: "10000",
    };
    expect(validate({
      ...base,
      data: example("social.event.post-tombstoned.data.json"),
    })).toBe(true);
    expect(validate({
      ...base,
      data: {
        postId: "post_100",
        authorAccountId: "acct_aurora_ada",
        conversationRootPostId: "post_100",
        tombstonedAt: "2026-07-22T21:05:00Z",
        deletedText: "must not escape",
        authorization: { actingLocalAgentId: "private" },
      },
    })).toBe(false);
    expect(validate(base)).toBe(false);
  });

  it("rejects more than one official account in a sync batch", () => {
    const validate = validatorFor("SocialAccountSyncRequest");
    const official = (name: string) => ({
      actor: { civId: "civ_a", displayName: name, kind: "official" },
      officialAuthority: {
        presidentLocalAgentId: "agent_p",
        presidentDisplayName: "President P",
        termNumber: 2,
        authorityDecision: { mode: "president", ref: "term_2" },
      },
    });
    expect(validate({ civId: "civ_a", accounts: [official("A"), official("B")] })).toBe(false);
  });

  it("bounds account-sync event summaries to the sync batch maximum", () => {
    const validate = validatorFor("SocialAccountSyncedEventData");
    expect(validate({
      civId: "civ_a",
      accountIds: Array.from({ length: 101 }, (_, i) => `acct_${i}`),
      createdCount: 101,
      updatedCount: 0,
    })).toBe(false);
  });

  it("binds reaction and follow event names to their desired-state booleans", () => {
    const validate = validatorFor("CloudEvent");
    const base = {
      id: "evt_state",
      specversion: "1.0",
      source: "/world/social",
      worldsequence: "10001",
    };
    const reaction = example("social.event.reaction-changed.data.json") as Record<string, unknown>;
    const follow = example("social.event.follow-changed.data.json") as Record<string, unknown>;
    expect(validate({ ...base, type: "world.social.post.liked.v1", data: reaction })).toBe(true);
    expect(validate({
      ...base,
      type: "world.social.post.liked.v1",
      data: { ...reaction, liked: false },
    })).toBe(false);
    expect(validate({ ...base, type: "world.social.account.followed.v1", data: follow })).toBe(true);
    expect(validate({
      ...base,
      type: "world.social.account.followed.v1",
      data: { ...follow, following: false },
    })).toBe(false);
  });

  it("distinguishes roots, replies, and their event payloads", () => {
    const post = example("social.post.json") as Record<string, unknown>;
    const replyData = example("social.event.reply-created.data.json") as { post: Record<string, unknown> };
    expect(validatorFor("SocialPost")({ ...post, parentPostId: null, replyDepth: 4 })).toBe(false);
    expect(validatorFor("SocialPost")({
      ...post,
      parentPostId: "post_parent",
      replyDepth: 0,
    })).toBe(false);
    expect(validatorFor("SocialPostCreatedEventData")({ post: replyData.post })).toBe(false);
    expect(validatorFor("SocialReplyCreatedEventData")({ post })).toBe(false);
  });
});
