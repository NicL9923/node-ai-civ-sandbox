import { readFile } from "node:fs/promises";
import type { Scenario } from "./types.js";
import { ScenarioDefinitionError } from "./types.js";

const operations = new Set([
  "register", "heartbeat", "pushEvents", "pull", "sync", "ack", "submitInteraction",
  "getInteraction", "getCivilization", "listCivilizations", "listRelationships", "listEvents",
  "syncSocialAccounts", "getSocialAccount", "listSocialAccountPosts", "listSocialFollowingFeed",
  "listSocialFollowers", "listSocialFollowing", "setSocialFollow", "listSocialGlobalFeed",
  "createSocialPost", "getSocialPost", "getSocialThread", "tombstoneSocialPost",
  "setSocialPostLike",
  "setOnline", "setAuthFault", "replay", "assert", "arrange",
]);
const networkOperations = new Set([
  "register", "heartbeat", "pushEvents", "pull", "sync", "ack", "submitInteraction",
  "getInteraction", "getCivilization", "listCivilizations", "listRelationships", "listEvents",
  "syncSocialAccounts", "getSocialAccount", "listSocialAccountPosts", "listSocialFollowingFeed",
  "listSocialFollowers", "listSocialFollowing", "setSocialFollow", "listSocialGlobalFeed",
  "createSocialPost", "getSocialPost", "getSocialThread", "tombstoneSocialPost",
  "setSocialPostLike",
]);
const signingFaults = new Set([
  "none", "invalid-signature", "stale-timestamp", "reused-nonce", "body-tamper", "wrong-civ-id",
]);
const commonNetworkFields = ["id", "op", "actor", "saveAs", "expectError"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ScenarioDefinitionError(message);
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must be a non-empty string`);
}

function positiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) invalid(`${field} must be a positive integer`);
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
}

function primitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${context} contains unsupported field '${key}'`);
  }
}

function optionalNonEmptyString(value: unknown, field: string): void {
  if (value !== undefined) nonEmptyString(value, field);
}

function valueReference(value: unknown, field: string): boolean {
  if (!isRecord(value) || !Object.hasOwn(value, "valueFrom")) return false;
  exactKeys(value, ["valueFrom"], field);
  nonEmptyString(value.valueFrom, `${field}.valueFrom`);
  if (!value.valueFrom.startsWith("/")) invalid(`${field}.valueFrom must be an absolute JSON Pointer`);
  return true;
}

function inputString(value: unknown, field: string): void {
  if (!valueReference(value, field)) nonEmptyString(value, field);
}

function optionalInputString(value: unknown, field: string): void {
  if (value !== undefined) inputString(value, field);
}

function inputBoolean(value: unknown, field: string): void {
  if (!valueReference(value, field) && typeof value !== "boolean") invalid(`${field} must be a boolean or value reference`);
}

function inputPositiveInteger(value: unknown, field: string): void {
  if (!valueReference(value, field)) positiveInteger(value, field);
}

function inputNonNegativeInteger(value: unknown, field: string): void {
  if (
    !valueReference(value, field)
    && (!Number.isInteger(value) || (value as number) < 0)
  ) {
    invalid(`${field} must be a non-negative integer or value reference`);
  }
}

function validateExpectedError(value: unknown): void {
  if (!isRecord(value)) invalid("expectError must be an object");
  exactKeys(value, ["status", "code"], "expectError");
  if (value.status === undefined && value.code === undefined) invalid("expectError must specify status or code");
  if (value.status !== undefined) boundedInteger(value.status, "expectError.status", 100, 599);
  optionalNonEmptyString(value.code, "expectError.code");
}

function validateCapabilities(value: unknown, actorName: string): void {
  if (!isRecord(value)) invalid(`actors.${actorName}.capabilities must be an object`);
  exactKeys(value, ["protocolVersion", "supportedInteractionKinds", "maxEventBatchSize", "features"], `actors.${actorName}.capabilities`);
  nonEmptyString(value.protocolVersion, `actors.${actorName}.capabilities.protocolVersion`);
  if (
    !Array.isArray(value.supportedInteractionKinds)
    || value.supportedInteractionKinds.some((kind) => typeof kind !== "string" || kind.trim().length === 0)
  ) {
    invalid(`actors.${actorName}.capabilities.supportedInteractionKinds must be an array of non-empty strings`);
  }
  if (value.maxEventBatchSize !== undefined) {
    positiveInteger(value.maxEventBatchSize, `actors.${actorName}.capabilities.maxEventBatchSize`);
  }
  if (
    value.features !== undefined
    && (!Array.isArray(value.features) || value.features.some((feature) => typeof feature !== "string" || feature.trim().length === 0))
  ) {
    invalid(`actors.${actorName}.capabilities.features must be an array of non-empty strings`);
  }
}

function validateActors(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid("Scenario actors must be a non-null object");
  for (const [name, actor] of Object.entries(value)) {
    nonEmptyString(name, "Actor name");
    if (!isRecord(actor)) invalid(`actors.${name} must be an object`);
    exactKeys(actor, ["displayName", "credentialRef", "capabilities"], `actors.${name}`);
    nonEmptyString(actor.displayName, `actors.${name}.displayName`);
    nonEmptyString(actor.credentialRef, `actors.${name}.credentialRef`);
    validateCapabilities(actor.capabilities, name);
  }
}

function validateNetworkMetadata(step: Record<string, unknown>): void {
  optionalNonEmptyString(step.id, "Scenario step id");
  optionalNonEmptyString(step.saveAs, "Scenario step saveAs");
  if (step.expectError !== undefined) validateExpectedError(step.expectError);
  nonEmptyString(step.actor, "Scenario step actor");
}

function validateCloudEvent(value: unknown): void {
  if (!isRecord(value)) invalid("pushEvents.events must contain event objects");
  nonEmptyString(value.id, "pushEvents.events[].id");
  if (value.specversion !== "1.0") invalid("pushEvents.events[].specversion must be '1.0'");
  nonEmptyString(value.type, "pushEvents.events[].type");
  nonEmptyString(value.source, "pushEvents.events[].source");
}

function validateInteractionRequest(value: unknown): void {
  if (!isRecord(value)) invalid("submitInteraction.request must be an object");
  nonEmptyString(value.kind, "submitInteraction.request.kind");
  nonEmptyString(value.source, "submitInteraction.request.source");
  nonEmptyString(value.target, "submitInteraction.request.target");
  if (!isRecord(value.authorityDecision)) invalid("submitInteraction.request.authorityDecision must be an object");
  nonEmptyString(value.authorityDecision.mode, "submitInteraction.request.authorityDecision.mode");
}

function validatePagination(step: Record<string, unknown>, allowed: string[], context: string): void {
  exactKeys(step, [...commonNetworkFields, ...allowed], context);
  validateNetworkMetadata(step);
  optionalNonEmptyString(step.after, `${context}.after`);
  if (step.limit !== undefined) boundedInteger(step.limit, `${context}.limit`, 1, 200);
}

function validateAuthorityDecision(value: unknown, field: string): void {
  if (!isRecord(value)) invalid(`${field} must be an object`);
  exactKeys(value, ["mode", "ref", "authorizedAt"], field);
  inputString(value.mode, `${field}.mode`);
  inputString(value.ref, `${field}.ref`);
  optionalInputString(value.authorizedAt, `${field}.authorizedAt`);
}

function validateSocialAuthorization(value: unknown, field: string): void {
  if (!isRecord(value)) invalid(`${field} must be an object`);
  exactKeys(value, ["actingLocalAgentId", "authorityDecision", "officialTermNumber"], field);
  inputString(value.actingLocalAgentId, `${field}.actingLocalAgentId`);
  validateAuthorityDecision(value.authorityDecision, `${field}.authorityDecision`);
  if (value.officialTermNumber !== undefined) {
    inputNonNegativeInteger(value.officialTermNumber, `${field}.officialTermNumber`);
  }
}

function validateSocialAccountSyncBody(value: unknown): void {
  if (!isRecord(value)) invalid("syncSocialAccounts.body must be an object");
  exactKeys(value, ["civId", "accounts"], "syncSocialAccounts.body");
  inputString(value.civId, "syncSocialAccounts.body.civId");
  if (!Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > 100) {
    invalid("syncSocialAccounts.body.accounts must contain between 1 and 100 accounts");
  }
  value.accounts.forEach((account, index) => {
    const field = `syncSocialAccounts.body.accounts[${index}]`;
    if (!isRecord(account)) invalid(`${field} must be an object`);
    exactKeys(account, ["actor", "bio", "officialAuthority"], field);
    if (!isRecord(account.actor)) invalid(`${field}.actor must be an object`);
    exactKeys(account.actor, ["civId", "localAgentId", "displayName", "kind"], `${field}.actor`);
    inputString(account.actor.civId, `${field}.actor.civId`);
    optionalInputString(account.actor.localAgentId, `${field}.actor.localAgentId`);
    inputString(account.actor.displayName, `${field}.actor.displayName`);
    inputString(account.actor.kind, `${field}.actor.kind`);
    optionalInputString(account.bio, `${field}.bio`);
    if (account.officialAuthority !== undefined) {
      if (!isRecord(account.officialAuthority)) invalid(`${field}.officialAuthority must be an object`);
      exactKeys(
        account.officialAuthority,
        ["presidentLocalAgentId", "presidentDisplayName", "termNumber", "authorityDecision"],
        `${field}.officialAuthority`,
      );
      inputString(account.officialAuthority.presidentLocalAgentId, `${field}.officialAuthority.presidentLocalAgentId`);
      inputString(account.officialAuthority.presidentDisplayName, `${field}.officialAuthority.presidentDisplayName`);
      inputNonNegativeInteger(account.officialAuthority.termNumber, `${field}.officialAuthority.termNumber`);
      validateAuthorityDecision(
        account.officialAuthority.authorityDecision,
        `${field}.officialAuthority.authorityDecision`,
      );
    }
  });
}

function validateSocialPage(
  step: Record<string, unknown>,
  context: string,
  idField?: "accountId" | "postId",
): void {
  exactKeys(step, [...commonNetworkFields, ...(idField ? [idField] : []), "cursor", "limit"], context);
  validateNetworkMetadata(step);
  if (idField) inputString(step[idField], `${context}.${idField}`);
  optionalInputString(step.cursor, `${context}.cursor`);
  if (step.limit !== undefined) boundedInteger(step.limit, `${context}.limit`, 1, 100);
}

function validateSocialPostBody(value: unknown): void {
  if (!isRecord(value)) invalid("createSocialPost.body must be an object");
  exactKeys(value, ["authorAccountId", "text", "parentPostId", "authorization"], "createSocialPost.body");
  inputString(value.authorAccountId, "createSocialPost.body.authorAccountId");
  inputString(value.text, "createSocialPost.body.text");
  optionalInputString(value.parentPostId, "createSocialPost.body.parentPostId");
  validateSocialAuthorization(value.authorization, "createSocialPost.body.authorization");
}

function validateNetworkStep(step: Record<string, unknown>): void {
  validateNetworkMetadata(step);
  switch (step.op) {
    case "register":
      exactKeys(step, [...commonNetworkFields, "idempotencyKey"], "register");
      optionalNonEmptyString(step.idempotencyKey, "register.idempotencyKey");
      return;
    case "heartbeat":
    case "pull":
      exactKeys(step, commonNetworkFields, String(step.op));
      return;
    case "pushEvents":
      exactKeys(step, [...commonNetworkFields, "events", "idempotencyKey"], "pushEvents");
      if (!Array.isArray(step.events)) invalid("pushEvents.events must be an array");
      if (step.events.length < 1 || step.events.length > 500) {
        invalid("pushEvents.events must contain between 1 and 500 events");
      }
      step.events.forEach(validateCloudEvent);
      optionalNonEmptyString(step.idempotencyKey, "pushEvents.idempotencyKey");
      return;
    case "sync":
      exactKeys(step, [...commonNetworkFields, "expect"], "sync");
      if (step.expect !== undefined) {
        if (!isRecord(step.expect) || Object.values(step.expect).some((value) => !primitive(value))) {
          invalid("sync.expect must be an object of primitive values");
        }
      }
      return;
    case "ack":
      exactKeys(step, [...commonNetworkFields, "commandId", "ack", "idempotencyKey"], "ack");
      nonEmptyString(step.commandId, "ack.commandId");
      if (
        !isRecord(step.ack)
        || typeof step.ack.status !== "string"
        || !["applied", "rejected", "duplicate"].includes(step.ack.status)
      ) invalid("ack.ack.status must be applied, rejected, or duplicate");
      optionalNonEmptyString(step.ack.detail, "ack.ack.detail");
      optionalNonEmptyString(step.ack.appliedAt, "ack.ack.appliedAt");
      if (step.ack.problem !== undefined && step.ack.problem !== null && !isRecord(step.ack.problem)) {
        invalid("ack.ack.problem must be an object or null");
      }
      optionalNonEmptyString(step.idempotencyKey, "ack.idempotencyKey");
      return;
    case "submitInteraction":
      exactKeys(step, [...commonNetworkFields, "request", "idempotencyKey"], "submitInteraction");
      validateInteractionRequest(step.request);
      optionalNonEmptyString(step.idempotencyKey, "submitInteraction.idempotencyKey");
      return;
    case "getInteraction":
      exactKeys(step, [...commonNetworkFields, "interactionId"], "getInteraction");
      nonEmptyString(step.interactionId, "getInteraction.interactionId");
      return;
    case "getCivilization":
      exactKeys(step, [...commonNetworkFields, "civId"], "getCivilization");
      nonEmptyString(step.civId, "getCivilization.civId");
      return;
    case "listCivilizations":
    case "listEvents":
      validatePagination(step, ["after", "limit"], String(step.op));
      return;
    case "listRelationships":
      exactKeys(step, [...commonNetworkFields, "query"], "listRelationships");
      if (step.query !== undefined) {
        if (!isRecord(step.query)) invalid("listRelationships.query must be an object");
        exactKeys(step.query, ["after", "limit", "civA", "civB"], "listRelationships.query");
        optionalNonEmptyString(step.query.after, "listRelationships.query.after");
        optionalNonEmptyString(step.query.civA, "listRelationships.query.civA");
        optionalNonEmptyString(step.query.civB, "listRelationships.query.civB");
        if (step.query.limit !== undefined) {
          boundedInteger(step.query.limit, "listRelationships.query.limit", 1, 200);
        }
      }
      return;
    case "syncSocialAccounts":
      exactKeys(step, [...commonNetworkFields, "body", "idempotencyKey"], "syncSocialAccounts");
      validateSocialAccountSyncBody(step.body);
      optionalNonEmptyString(step.idempotencyKey, "syncSocialAccounts.idempotencyKey");
      return;
    case "getSocialAccount":
      exactKeys(step, [...commonNetworkFields, "accountId"], "getSocialAccount");
      inputString(step.accountId, "getSocialAccount.accountId");
      return;
    case "listSocialAccountPosts":
    case "listSocialFollowingFeed":
    case "listSocialFollowers":
    case "listSocialFollowing":
      validateSocialPage(step, String(step.op), "accountId");
      return;
    case "setSocialFollow":
      exactKeys(
        step,
        [...commonNetworkFields, "accountId", "targetAccountId", "body", "idempotencyKey"],
        "setSocialFollow",
      );
      inputString(step.accountId, "setSocialFollow.accountId");
      inputString(step.targetAccountId, "setSocialFollow.targetAccountId");
      if (!isRecord(step.body)) invalid("setSocialFollow.body must be an object");
      exactKeys(step.body, ["following", "authorization"], "setSocialFollow.body");
      inputBoolean(step.body.following, "setSocialFollow.body.following");
      validateSocialAuthorization(step.body.authorization, "setSocialFollow.body.authorization");
      optionalNonEmptyString(step.idempotencyKey, "setSocialFollow.idempotencyKey");
      return;
    case "listSocialGlobalFeed":
      validateSocialPage(step, "listSocialGlobalFeed");
      return;
    case "createSocialPost":
      exactKeys(step, [...commonNetworkFields, "body", "idempotencyKey"], "createSocialPost");
      validateSocialPostBody(step.body);
      optionalNonEmptyString(step.idempotencyKey, "createSocialPost.idempotencyKey");
      return;
    case "getSocialPost":
      exactKeys(step, [...commonNetworkFields, "postId"], "getSocialPost");
      inputString(step.postId, "getSocialPost.postId");
      return;
    case "getSocialThread":
      validateSocialPage(step, "getSocialThread", "postId");
      return;
    case "tombstoneSocialPost":
      exactKeys(step, [...commonNetworkFields, "postId", "body", "idempotencyKey"], "tombstoneSocialPost");
      inputString(step.postId, "tombstoneSocialPost.postId");
      if (!isRecord(step.body)) invalid("tombstoneSocialPost.body must be an object");
      exactKeys(step.body, ["authorization"], "tombstoneSocialPost.body");
      validateSocialAuthorization(step.body.authorization, "tombstoneSocialPost.body.authorization");
      optionalNonEmptyString(step.idempotencyKey, "tombstoneSocialPost.idempotencyKey");
      return;
    case "setSocialPostLike":
      exactKeys(
        step,
        [...commonNetworkFields, "postId", "accountId", "body", "idempotencyKey"],
        "setSocialPostLike",
      );
      inputString(step.postId, "setSocialPostLike.postId");
      inputString(step.accountId, "setSocialPostLike.accountId");
      if (!isRecord(step.body)) invalid("setSocialPostLike.body must be an object");
      exactKeys(step.body, ["liked", "authorization"], "setSocialPostLike.body");
      inputBoolean(step.body.liked, "setSocialPostLike.body.liked");
      validateSocialAuthorization(step.body.authorization, "setSocialPostLike.body.authorization");
      optionalNonEmptyString(step.idempotencyKey, "setSocialPostLike.idempotencyKey");
      return;
  }
}

function validateStateOrControlStep(step: Record<string, unknown>, replayableIds: Set<string>): void {
  switch (step.op) {
    case "setOnline":
      exactKeys(step, ["id", "op", "actor", "online"], "setOnline");
      optionalNonEmptyString(step.id, "Scenario step id");
      nonEmptyString(step.actor, "setOnline.actor");
      if (typeof step.online !== "boolean") invalid("setOnline.online must be a boolean");
      return;
    case "setAuthFault":
      exactKeys(step, ["id", "op", "actor", "fault"], "setAuthFault");
      optionalNonEmptyString(step.id, "Scenario step id");
      nonEmptyString(step.actor, "setAuthFault.actor");
      if (typeof step.fault !== "string" || !signingFaults.has(step.fault)) invalid("setAuthFault.fault is invalid");
      return;
    case "replay":
      exactKeys(step, ["id", "op", "stepId", "saveAs", "expectError"], "replay");
      optionalNonEmptyString(step.id, "Scenario step id");
      nonEmptyString(step.stepId, "replay.stepId");
      if (!replayableIds.has(step.stepId)) invalid(`replay.stepId '${step.stepId}' must reference a prior network step`);
      optionalNonEmptyString(step.saveAs, "replay.saveAs");
      if (step.expectError !== undefined) validateExpectedError(step.expectError);
      return;
    case "assert":
      exactKeys(step, ["id", "op", "actual", "exists", "equals", "contains"], "assert");
      optionalNonEmptyString(step.id, "Scenario step id");
      nonEmptyString(step.actual, "assert.actual");
      if (!step.actual.startsWith("/")) invalid("Scenario assertions must use an absolute JSON Pointer");
      if (step.exists === undefined && step.equals === undefined && step.contains === undefined) {
        invalid("assert requires exists, equals, or contains");
      }
      if (step.exists !== undefined && typeof step.exists !== "boolean") invalid("assert.exists must be a boolean");
      if (step.exists === false && (step.equals !== undefined || step.contains !== undefined)) {
        invalid("assert.exists false cannot be combined with equals or contains");
      }
      if (step.equals !== undefined && !primitive(step.equals) && !valueReference(step.equals, "assert.equals")) {
        invalid("assert.equals must be a primitive or value reference");
      }
      if (step.contains !== undefined && !primitive(step.contains) && !valueReference(step.contains, "assert.contains")) {
        invalid("assert.contains must be a primitive or value reference");
      }
      return;
    case "arrange":
      exactKeys(step, ["id", "op", "action", "value"], "arrange");
      optionalNonEmptyString(step.id, "Scenario step id");
      nonEmptyString(step.action, "arrange.action");
      return;
  }
}

export function validateScenario(parsed: unknown): Scenario {
  if (!isRecord(parsed)) invalid("Scenario must be a JSON object");
  exactKeys(parsed, ["schemaVersion", "name", "actors", "steps"], "Scenario");
  if (parsed.schemaVersion !== "1") invalid("Scenario schemaVersion must be '1'");
  nonEmptyString(parsed.name, "Scenario name");
  validateActors(parsed.actors);
  if (!Array.isArray(parsed.steps)) invalid("Scenario steps must be an array");

  const ids = new Set<string>();
  const replayableIds = new Set<string>();
  for (const candidate of parsed.steps) {
    if (!isRecord(candidate) || typeof candidate.op !== "string") {
      invalid("Scenario steps must be discriminated operation objects");
    }
    if (!operations.has(candidate.op)) invalid(`Unsupported scenario operation '${candidate.op}'`);
    if (candidate.id !== undefined) {
      nonEmptyString(candidate.id, "Scenario step id");
      if (ids.has(candidate.id)) invalid("Scenario step ids must be unique non-empty strings");
      ids.add(candidate.id);
    }
    if (networkOperations.has(candidate.op)) {
      validateNetworkStep(candidate);
      if (!Object.hasOwn(parsed.actors, candidate.actor as PropertyKey)) invalid(`Scenario references unknown actor '${candidate.actor}'`);
      if (candidate.id) replayableIds.add(candidate.id);
    } else {
      validateStateOrControlStep(candidate, replayableIds);
      if (
        (candidate.op === "setOnline" || candidate.op === "setAuthFault")
        && !Object.hasOwn(parsed.actors, candidate.actor as PropertyKey)
      ) {
        invalid(`Scenario references unknown actor '${candidate.actor}'`);
      }
    }
  }
  return parsed as unknown as Scenario;
}

export async function loadScenario(path: string): Promise<Scenario> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ScenarioDefinitionError("Unable to read scenario JSON");
  }
  return validateScenario(parsed);
}
