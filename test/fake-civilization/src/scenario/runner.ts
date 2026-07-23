import type { components } from "@ai-civ/federation-contracts";
import type {
  ExpectedScenarioError,
  ReplayableScenarioStep,
  Scenario,
  ScenarioResult,
  ScenarioRunOptions,
  ScenarioStep,
  ScenarioInput,
} from "./types.js";
import { ScenarioAssertionError, ScenarioHostControlError } from "./types.js";
import { WorldHttpError } from "../transport.js";

function pointer(root: unknown, expression: string): unknown {
  if (expression === "") return root;
  if (!expression.startsWith("/")) throw new ScenarioAssertionError("Assertions require an absolute JSON Pointer");
  return expression.slice(1).split("/").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!Object.hasOwn(value, decoded)) return undefined;
    return (value as Record<string, unknown>)[decoded];
  }, root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveInput<T>(input: ScenarioInput<T>, values: Record<string, unknown>): T {
  if (
    isRecord(input)
    && Object.keys(input).length === 1
    && typeof input.valueFrom === "string"
  ) {
    const resolved = pointer(values, input.valueFrom);
    if (resolved === undefined) {
      throw new ScenarioAssertionError(`Value reference ${input.valueFrom} did not resolve`);
    }
    return resolved as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => resolveInput(item, values)) as T;
  }
  if (isRecord(input)) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, resolveInput(value, values)]),
    ) as T;
  }
  return input as T;
}

function primitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function assertStep(step: Extract<ScenarioStep, { op: "assert" }>, values: Record<string, unknown>): void {
  const actual = pointer(values, step.actual);
  if (step.exists !== undefined) {
    const exists = actual !== undefined;
    if (exists !== step.exists) {
      throw new ScenarioAssertionError(`Expected ${step.actual} existence to be ${step.exists}`);
    }
    if (!step.exists) return;
  }
  if (!primitive(actual) && !Array.isArray(actual)) {
    throw new ScenarioAssertionError(`Assertion ${step.actual} did not resolve to a primitive or array`);
  }
  const expectedEquals = step.equals === undefined ? undefined : resolveInput(step.equals, values);
  if (step.equals !== undefined && actual !== expectedEquals) {
    throw new ScenarioAssertionError(`Expected ${step.actual} to equal ${JSON.stringify(expectedEquals)}`);
  }
  if (step.contains !== undefined) {
    const expectedContains = resolveInput(step.contains, values);
    const contains = typeof actual === "string"
      ? actual.includes(String(expectedContains))
      : Array.isArray(actual)
        ? actual.includes(expectedContains)
        : false;
    if (!contains) throw new ScenarioAssertionError(`Expected ${step.actual} to contain ${JSON.stringify(expectedContains)}`);
  }
}

function expectValues(actual: unknown, expected: Record<string, string | number | boolean | null>): void {
  for (const [name, value] of Object.entries(expected)) {
    const escaped = name.replace(/~/g, "~0").replace(/\//g, "~1");
    if (pointer(actual, `/${escaped}`) !== value) {
      throw new ScenarioAssertionError(`Expected operation result ${name} to equal ${JSON.stringify(value)}`);
    }
  }
}

function errorResult(error: unknown): { status?: number; code?: string } {
  if (error instanceof WorldHttpError) return { status: error.status, code: error.problem?.code };
  if (typeof error !== "object" || error === null) return {};
  const value = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
}

function assertExpectedError(expected: ExpectedScenarioError, error: unknown): Record<string, unknown> {
  const actual = errorResult(error);
  if (expected.status !== undefined && actual.status !== expected.status) {
    throw new ScenarioAssertionError(`Expected error status ${expected.status}, received ${String(actual.status)}`);
  }
  if (expected.code !== undefined && actual.code !== expected.code) {
    throw new ScenarioAssertionError(`Expected error code ${expected.code}, received ${String(actual.code)}`);
  }
  return actual;
}

export async function runScenario(scenario: Scenario, options: ScenarioRunOptions): Promise<ScenarioResult> {
  const actors = Object.fromEntries(
    Object.entries(scenario.actors).map(([name, actor]) => [name, options.createActor(name, actor)]),
  );
  const values: Record<string, unknown> = {};
  const replayableSteps = new Map<string, ReplayableScenarioStep>();
  const actorFor = (name: string) => {
    const actor = actors[name];
    if (!actor) throw new Error(`Scenario references unknown actor '${name}'`);
    return actor;
  };
  const execute = async (step: ReplayableScenarioStep): Promise<unknown> => {
    switch (step.op) {
      case "register":
        return actorFor(step.actor).register(step.idempotencyKey);
      case "heartbeat":
        return actorFor(step.actor).heartbeat();
      case "pushEvents":
        return actorFor(step.actor).pushEvents(step.events, step.idempotencyKey);
      case "pull":
        return actorFor(step.actor).pull();
      case "sync": {
        const result = await actorFor(step.actor).sync();
        if (step.expect) expectValues(result, step.expect);
        return result;
      }
      case "ack":
        return actorFor(step.actor).ack(step.commandId, step.ack, step.idempotencyKey);
      case "submitInteraction":
        return actorFor(step.actor).submitInteraction(step.request, step.idempotencyKey);
      case "getInteraction":
        return actorFor(step.actor).getInteraction(step.interactionId);
      case "getCivilization":
        return actorFor(step.actor).getCivilization(step.civId);
      case "listCivilizations":
        return actorFor(step.actor).listCivilizations(step.after, step.limit);
      case "listRelationships":
        return actorFor(step.actor).listRelationships(step.query);
      case "listEvents":
        return actorFor(step.actor).listEvents(step.after, step.limit);
      case "syncSocialAccounts":
        return actorFor(step.actor).syncSocialAccounts(
          resolveInput<components["schemas"]["SocialAccountSyncRequest"]>(step.body, values),
          step.idempotencyKey,
        );
      case "getSocialAccount":
        return actorFor(step.actor).getSocialAccount(resolveInput(step.accountId, values));
      case "listSocialAccountPosts":
        return actorFor(step.actor).listSocialAccountPosts(resolveInput(step.accountId, values), {
          ...(step.cursor ? { cursor: resolveInput(step.cursor, values) } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
      case "listSocialFollowingFeed":
        return actorFor(step.actor).listSocialFollowingFeed(resolveInput(step.accountId, values), {
          ...(step.cursor ? { cursor: resolveInput(step.cursor, values) } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
      case "listSocialFollowers":
        return actorFor(step.actor).listSocialFollowers(resolveInput(step.accountId, values), {
          ...(step.cursor ? { cursor: resolveInput(step.cursor, values) } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
      case "listSocialFollowing":
        return actorFor(step.actor).listSocialFollowing(resolveInput(step.accountId, values), {
          ...(step.cursor ? { cursor: resolveInput(step.cursor, values) } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
      case "setSocialFollow":
        return actorFor(step.actor).setSocialFollow(
          resolveInput(step.accountId, values),
          resolveInput(step.targetAccountId, values),
          resolveInput<components["schemas"]["SocialFollowSetRequest"]>(step.body, values),
          step.idempotencyKey,
        );
      case "listSocialGlobalFeed":
        return actorFor(step.actor).listSocialGlobalFeed({
          ...(step.cursor ? { cursor: resolveInput(step.cursor, values) } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
      case "createSocialPost":
        return actorFor(step.actor).createSocialPost(
          resolveInput<components["schemas"]["SocialPostCreateRequest"]>(step.body, values),
          step.idempotencyKey,
        );
      case "getSocialPost":
        return actorFor(step.actor).getSocialPost(resolveInput(step.postId, values));
      case "getSocialThread":
        return actorFor(step.actor).getSocialThread(resolveInput(step.postId, values), {
          ...(step.cursor ? { cursor: resolveInput(step.cursor, values) } : {}),
          ...(step.limit ? { limit: step.limit } : {}),
        });
      case "tombstoneSocialPost":
        return actorFor(step.actor).tombstoneSocialPost(
          resolveInput(step.postId, values),
          resolveInput<components["schemas"]["SocialPostTombstoneRequest"]>(step.body, values),
          step.idempotencyKey,
        );
      case "setSocialPostLike":
        return actorFor(step.actor).setSocialPostLike(
          resolveInput(step.postId, values),
          resolveInput(step.accountId, values),
          resolveInput<components["schemas"]["SocialReactionSetRequest"]>(step.body, values),
          step.idempotencyKey,
        );
    }
  };
  const executeExpected = async (
    step: ReplayableScenarioStep,
    expected: ExpectedScenarioError | undefined,
  ): Promise<unknown> => {
    try {
      const result = await execute(step);
      if (expected) throw new ScenarioAssertionError("Expected operation to fail, but it succeeded");
      return result;
    } catch (error) {
      if (!expected || error instanceof ScenarioAssertionError) throw error;
      return assertExpectedError(expected, error);
    }
  };
  for (const step of scenario.steps) {
    let result: unknown;
    switch (step.op) {
      case "setOnline":
        actorFor(step.actor).state.online = step.online;
        break;
      case "setAuthFault":
        actorFor(step.actor).setSigningFault(step.fault);
        break;
      case "replay": {
        const replayed = replayableSteps.get(step.stepId);
        if (!replayed) throw new Error(`Replay references unknown prior step '${step.stepId}'`);
        result = await executeExpected(replayed, step.expectError);
        break;
      }
      case "assert":
        assertStep(step, values);
        break;
      case "arrange":
        if (!options.hostControls) throw new ScenarioHostControlError();
        await options.hostControls.arrange(step);
        break;
      default:
        result = await executeExpected(step, step.expectError);
        if (step.id) replayableSteps.set(step.id, step);
        break;
    }
    if ("saveAs" in step && step.saveAs) values[step.saveAs] = result;
    if (step.id) values[step.id] = result;
  }
  return { name: scenario.name, actors, values, completedSteps: scenario.steps.length };
}
