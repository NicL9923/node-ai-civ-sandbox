import type {
  ExpectedScenarioError,
  ReplayableScenarioStep,
  Scenario,
  ScenarioResult,
  ScenarioRunOptions,
  ScenarioStep,
} from "./types.js";
import { ScenarioAssertionError, ScenarioHostControlError } from "./types.js";
import { WorldHttpError } from "../transport.js";

function pointer(root: unknown, expression: string): unknown {
  if (expression === "") return root;
  if (!expression.startsWith("/")) throw new ScenarioAssertionError("Assertions require an absolute JSON Pointer");
  return expression.slice(1).split("/").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }, root);
}

function primitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function assertStep(step: Extract<ScenarioStep, { op: "assert" }>, values: Record<string, unknown>): void {
  const actual = pointer(values, step.actual);
  if (!primitive(actual) && !Array.isArray(actual)) {
    throw new ScenarioAssertionError(`Assertion ${step.actual} did not resolve to a primitive or array`);
  }
  if (step.equals !== undefined && actual !== step.equals) {
    throw new ScenarioAssertionError(`Expected ${step.actual} to equal ${JSON.stringify(step.equals)}`);
  }
  if (step.contains !== undefined) {
    const contains = typeof actual === "string"
      ? actual.includes(String(step.contains))
      : Array.isArray(actual)
        ? actual.includes(step.contains)
        : false;
    if (!contains) throw new ScenarioAssertionError(`Expected ${step.actual} to contain ${JSON.stringify(step.contains)}`);
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
