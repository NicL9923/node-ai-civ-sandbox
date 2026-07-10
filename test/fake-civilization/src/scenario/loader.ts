import { readFile } from "node:fs/promises";
import type { Scenario } from "./types.js";
import { ScenarioDefinitionError } from "./types.js";

const operations = new Set([
  "register",
  "heartbeat",
  "pushEvents",
  "pull",
  "sync",
  "ack",
  "submitInteraction",
  "getInteraction",
  "getCivilization",
  "listCivilizations",
  "listRelationships",
  "listEvents",
  "setOnline",
  "setAuthFault",
  "replay",
  "assert",
  "arrange",
]);

export async function loadScenario(path: string): Promise<Scenario> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ScenarioDefinitionError("Unable to read scenario JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== "1" ||
    typeof (parsed as { name?: unknown }).name !== "string" ||
    typeof (parsed as { actors?: unknown }).actors !== "object" ||
    !Array.isArray((parsed as { steps?: unknown }).steps)
  ) {
    throw new ScenarioDefinitionError("Scenario must have schemaVersion '1', name, actors, and steps");
  }
  const ids = new Set<string>();
  for (const step of (parsed as { steps: unknown[] }).steps) {
    if (typeof step !== "object" || step === null || typeof (step as { op?: unknown }).op !== "string") {
      throw new ScenarioDefinitionError("Scenario steps must be discriminated operation objects");
    }
    const candidate = step as { op: string; id?: unknown; actual?: unknown; stepId?: unknown };
    if (!operations.has(candidate.op)) throw new ScenarioDefinitionError(`Unsupported scenario operation '${candidate.op}'`);
    if (candidate.id !== undefined) {
      if (typeof candidate.id !== "string" || candidate.id.length === 0 || ids.has(candidate.id)) {
        throw new ScenarioDefinitionError("Scenario step ids must be unique non-empty strings");
      }
      ids.add(candidate.id);
    }
    if (candidate.op === "assert" && (typeof candidate.actual !== "string" || !candidate.actual.startsWith("/"))) {
      throw new ScenarioDefinitionError("Scenario assertions must use an absolute JSON Pointer");
    }
    if (candidate.op === "replay" && typeof candidate.stepId !== "string") {
      throw new ScenarioDefinitionError("Scenario replay requires a prior stepId");
    }
  }
  return parsed as Scenario;
}
