import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { components } from "@ai-civ/federation-contracts";
import { ConfigurationError } from "./config.js";

export interface RegistrationState {
  civId: string;
  keyId: string;
  protocolVersion: string;
  worldBaseUrl?: string;
  registeredAt: string;
}

export interface ProcessedCommand {
  status: "applied" | "rejected" | "duplicate";
  detail?: string;
  problem?: components["schemas"]["ProblemDetails"] | null;
  appliedAt: string;
}

export interface AppliedContact {
  commandId: string;
  interactionId: string;
  fromCiv: string;
  greeting?: string;
}

export interface AppliedMessage {
  commandId: string;
  interactionId: string;
  fromCiv: string;
  body: string;
  subject?: string;
}

export interface FakeCivilizationState {
  registration?: RegistrationState;
  projection: Omit<components["schemas"]["PublicProjection"], "civId"> & { civId?: string };
  lastProcessedCommandCursor: string | null;
  nextEventSequence: number;
  nextRequestSequence: number;
  processedCommands: Record<string, ProcessedCommand>;
  contacts: AppliedContact[];
  messages: AppliedMessage[];
  online: boolean;
}

export function createInitialState(
  displayName: string,
  protocolVersion: string,
): FakeCivilizationState {
  return {
    projection: {
      displayName,
      protocolVersion,
      turn: 0,
      running: true,
      population: 0,
      updatedAt: new Date(0).toISOString(),
    },
    lastProcessedCommandCursor: null,
    nextEventSequence: 1,
    nextRequestSequence: 1,
    processedCommands: {},
    contacts: [],
    messages: [],
    online: true,
  };
}

export function serializeState(state: FakeCivilizationState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export async function saveState(path: string, state: FakeCivilizationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, serializeState(state), "utf8");
  await rename(temporaryPath, path);
}

export async function loadState(path: string): Promise<FakeCivilizationState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ConfigurationError("Unable to read fake civilization state");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("projection" in parsed) ||
    !("processedCommands" in parsed)
  ) {
    throw new ConfigurationError("State file is not a fake civilization state");
  }
  return parsed as FakeCivilizationState;
}
