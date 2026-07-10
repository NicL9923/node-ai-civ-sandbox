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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function environmentConfig(environment: NodeJS.ProcessEnv = process.env): ConfigInput {
  const protocolVersion = nonEmptyString(environment.FAKE_CIV_PROTOCOL_VERSION);
  const interactionKinds = nonEmptyString(environment.FAKE_CIV_INTERACTION_KINDS)
    ?.split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  return {
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
  };
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError("Fake civilization configuration must be a JSON object");
  }
  return parsed as ConfigInput;
}

export function resolveConfig(
  file: ConfigInput = {},
  environment: ConfigInput = environmentConfig(),
  cli: ConfigInput = {},
): FakeCivilizationConfig {
  const capabilities = {
    ...defaultCapabilities,
    ...(file.capabilities ?? {}),
    ...(environment.capabilities ?? {}),
    ...(cli.capabilities ?? {}),
  };
  const merged: ConfigInput = { ...file, ...environment, ...cli, capabilities };
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
