import { readFile } from "node:fs/promises";
import type { components } from "@ai-civ/federation-contracts";
import type { RetryPolicy } from "./transport.js";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface FakeCivilizationConfig {
  alias: string;
  displayName: string;
  worldBaseUrl: string;
  onboardingToken?: string;
  hmacSecret?: string;
  keyId?: string;
  civId?: string;
  capabilities: components["schemas"]["Capabilities"];
  pageSize?: number;
  maxPages?: number;
  retry?: Partial<RetryPolicy>;
  commandOutcomes?: Record<string, "applied" | "rejected">;
}

export type ConfigInput = Omit<Partial<FakeCivilizationConfig>, "capabilities"> & {
  capabilities?: Partial<FakeCivilizationConfig["capabilities"]>;
};

const defaultCapabilities: components["schemas"]["Capabilities"] = {
  protocolVersion: "1.0.0",
  supportedInteractionKinds: ["contact", "message"],
  maxEventBatchSize: 50,
};

function defined(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ConfigurationError(`Invalid fake civilization configuration: ${message}`);
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") fail(`${field} must be a string`);
}

function optionalPositiveInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
    fail(`${field} must be a positive integer`);
  }
}

function optionalNonNegativeInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    fail(`${field} must be a non-negative integer`);
  }
}

function validateCapabilities(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail("capabilities must be an object");
  for (const key of Object.keys(value)) {
    if (!["protocolVersion", "supportedInteractionKinds", "maxEventBatchSize", "features"].includes(key)) {
      fail(`capabilities.${key} is not supported`);
    }
  }
  if (value.protocolVersion !== undefined && (typeof value.protocolVersion !== "string" || value.protocolVersion.trim().length === 0)) {
    fail("capabilities.protocolVersion must be a non-empty string");
  }
  if (value.supportedInteractionKinds !== undefined && (
    !Array.isArray(value.supportedInteractionKinds)
    || value.supportedInteractionKinds.some((kind) => typeof kind !== "string" || kind.trim().length === 0)
  )) {
    fail("capabilities.supportedInteractionKinds must be an array of non-empty strings");
  }
  optionalPositiveInteger(value.maxEventBatchSize, "capabilities.maxEventBatchSize");
  if (value.features !== undefined && (
    !Array.isArray(value.features)
    || value.features.some((feature) => typeof feature !== "string" || feature.trim().length === 0)
  )) {
    fail("capabilities.features must be an array of non-empty strings");
  }
}

function validateConfigInput(value: unknown): asserts value is ConfigInput {
  if (!isRecord(value)) throw new ConfigurationError("Fake civilization configuration must be a JSON object");
  optionalString(value.alias, "alias");
  optionalString(value.displayName, "displayName");
  optionalString(value.worldBaseUrl, "worldBaseUrl");
  optionalString(value.onboardingToken, "onboardingToken");
  optionalString(value.hmacSecret, "hmacSecret");
  optionalString(value.keyId, "keyId");
  optionalString(value.civId, "civId");
  optionalPositiveInteger(value.pageSize, "pageSize");
  optionalPositiveInteger(value.maxPages, "maxPages");
  validateCapabilities(value.capabilities);
  if (value.retry !== undefined) {
    if (!isRecord(value.retry)) fail("retry must be an object");
    for (const key of Object.keys(value.retry)) {
      if (!["maxAttempts", "initialDelayMs", "maxDelayMs"].includes(key)) {
        fail(`retry.${key} is not supported`);
      }
    }
    optionalPositiveInteger(value.retry.maxAttempts, "retry.maxAttempts");
    optionalNonNegativeInteger(value.retry.initialDelayMs, "retry.initialDelayMs");
    optionalNonNegativeInteger(value.retry.maxDelayMs, "retry.maxDelayMs");
  }
  if (value.commandOutcomes !== undefined) {
    if (!isRecord(value.commandOutcomes) || Object.values(value.commandOutcomes).some((outcome) => outcome !== "applied" && outcome !== "rejected")) {
      fail("commandOutcomes must map names to applied or rejected");
    }
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function environmentConfig(environment: NodeJS.ProcessEnv = process.env): ConfigInput {
  const protocolVersion = nonEmptyString(environment.FAKE_CIV_PROTOCOL_VERSION);
  const interactionKinds = nonEmptyString(environment.FAKE_CIV_INTERACTION_KINDS)
    ?.split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  return defined({
    alias: nonEmptyString(environment.FAKE_CIV_ALIAS),
    displayName: nonEmptyString(environment.FAKE_CIV_DISPLAY_NAME),
    worldBaseUrl: nonEmptyString(environment.FAKE_CIV_WORLD_URL),
    onboardingToken: nonEmptyString(environment.FAKE_CIV_ONBOARDING_TOKEN),
    hmacSecret: nonEmptyString(environment.FAKE_CIV_HMAC_SECRET),
    keyId: nonEmptyString(environment.FAKE_CIV_KEY_ID),
    civId: nonEmptyString(environment.FAKE_CIV_CIV_ID),
    ...(protocolVersion || interactionKinds
      ? {
          capabilities: {
            ...(protocolVersion ? { protocolVersion } : {}),
            ...(interactionKinds ? { supportedInteractionKinds: interactionKinds } : {}),
          },
        }
      : {}),
    pageSize: numberEnvironment(environment.FAKE_CIV_PAGE_SIZE),
    maxPages: numberEnvironment(environment.FAKE_CIV_MAX_PAGES),
  }) as ConfigInput;
}

function numberEnvironment(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function readConfigFile(path: string): Promise<ConfigInput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ConfigurationError("Unable to read fake civilization configuration");
  }
  validateConfigInput(parsed);
  return parsed;
}

export function resolveConfig(
  file: ConfigInput = {},
  environment: ConfigInput = environmentConfig(),
  cli: ConfigInput = {},
): FakeCivilizationConfig {
  validateConfigInput(file);
  validateConfigInput(environment);
  validateConfigInput(cli);
  const capabilities = {
    ...defaultCapabilities,
    ...(file.capabilities ?? {}),
    ...(environment.capabilities ?? {}),
    ...(cli.capabilities ?? {}),
  };
  const merged: ConfigInput = { ...defined(file), ...defined(environment), ...defined(cli), capabilities };
  if (!merged.alias || !merged.displayName || !merged.worldBaseUrl) {
    throw new ConfigurationError("Configuration requires alias, displayName, and worldBaseUrl");
  }

  if (!/^https?:\/\//u.test(merged.worldBaseUrl)) {
    throw new ConfigurationError("worldBaseUrl must be an absolute HTTP URL");
  }
  if ((merged.pageSize ?? 50) > 200 || (merged.pageSize ?? 50) < 1) {
    throw new ConfigurationError("pageSize must be between 1 and 200");
  }
  return {
    alias: merged.alias,
    displayName: merged.displayName,
    worldBaseUrl: merged.worldBaseUrl,
    onboardingToken: merged.onboardingToken,
    hmacSecret: merged.hmacSecret,
    keyId: merged.keyId,
    civId: merged.civId,
    capabilities,
    pageSize: merged.pageSize ?? 50,
    maxPages: merged.maxPages ?? 100,
    retry: merged.retry,
    commandOutcomes: merged.commandOutcomes,
  };
}

export function redactConfig(config: ConfigInput): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = /secret|token|credential|password|key$/i.test(key) ? "[REDACTED]" : value;
  }
  return result;
}
