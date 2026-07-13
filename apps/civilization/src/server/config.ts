import "dotenv/config";
import { randomBytes } from "node:crypto";
import type { GovernanceParams, ModelKey, SimulationConfig } from "../shared/types.js";

export interface FederationConfig {
  /** Absolute base URL of the World API, INCLUDING the `/world/v1` prefix. */
  apiBaseUrl: string;
  protocolVersion: "1";
  /** Pre-provisioned S2S credentials. Absent until registration completes (onboarding flow). */
  civId?: string;
  keyId?: string;
  /** HMAC signing secret, exchanged out-of-band. Never logged or surfaced in any response. */
  hmacSecret?: string;
  /** One-time onboarding token for the explicit registration flow. */
  onboardingToken?: string;
  displayName: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  outboxIntervalMs: number;
}

export interface AppConfig {
  port: number;
  simulationId: string;
  adminApiKey?: string;
  autoStart: boolean;
  simulation: SimulationConfig;
  governanceDefaults: GovernanceParams;
  ai: {
    provider: "mock" | "foundry";
    foundryProjectEndpoint?: string;
    foundryApiKey?: string;
    deployments: Record<ModelKey, string>;
    requestTimeoutMs: number;
    maxOutputTokens: number;
  };
  cosmos?: {
    endpoint: string;
    databaseId: string;
  };
  /** Present only when the optional World federation connector is configured. */
  federation?: FederationConfig;
  telemetry: {
    connectionString?: string;
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be numeric.`);
  }

  return parsed;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Parse the optional World federation connector configuration. Federation is enabled ONLY when
 * WORLD_API_BASE_URL is set; when absent this returns undefined and the app runs exactly as a
 * standalone civilization. Validation never logs or echoes secret values — only variable names.
 */
export function loadFederationConfig(simulationId: string): FederationConfig | undefined {
  const apiBaseUrl = optionalEnv("WORLD_API_BASE_URL");
  if (!apiBaseUrl) {
    return undefined;
  }

  try {
    // eslint-disable-next-line no-new
    new URL(apiBaseUrl);
  } catch {
    throw new Error("WORLD_API_BASE_URL must be an absolute URL (including the /world/v1 path prefix).");
  }

  const protocolVersion = optionalEnv("WORLD_PROTOCOL_VERSION") ?? "1";
  if (protocolVersion !== "1") {
    throw new Error("WORLD_PROTOCOL_VERSION must be '1' for this protocol.");
  }

  const civId = optionalEnv("WORLD_CIV_ID");
  const keyId = optionalEnv("WORLD_KEY_ID");
  const hmacSecret = optionalEnv("WORLD_HMAC_SECRET");
  const onboardingToken = optionalEnv("WORLD_ONBOARDING_TOKEN");

  // The HMAC signing secret is exchanged out-of-band and is always required to sign authenticated
  // requests — including the calls made after an onboarding-token registration assigns civId/keyId.
  if (!hmacSecret) {
    throw new Error("Federation requires WORLD_HMAC_SECRET (the S2S signing secret, exchanged out-of-band).");
  }

  if ((civId && !keyId) || (keyId && !civId)) {
    throw new Error("Provide WORLD_CIV_ID and WORLD_KEY_ID together, or neither (and use WORLD_ONBOARDING_TOKEN to register).");
  }

  const hasCivPair = Boolean(civId && keyId);
  if (!hasCivPair && !onboardingToken) {
    throw new Error(
      "Federation needs either pre-provisioned WORLD_CIV_ID + WORLD_KEY_ID, or a WORLD_ONBOARDING_TOKEN to register."
    );
  }

  return {
    apiBaseUrl,
    protocolVersion,
    civId,
    keyId,
    hmacSecret,
    onboardingToken,
    displayName: optionalEnv("WORLD_DISPLAY_NAME") ?? simulationId,
    heartbeatIntervalMs: numberFromEnv("WORLD_HEARTBEAT_INTERVAL_MS", 30_000),
    pollIntervalMs: numberFromEnv("WORLD_POLL_INTERVAL_MS", 10_000),
    outboxIntervalMs: numberFromEnv("WORLD_OUTBOX_INTERVAL_MS", 5_000)
  };
}

export function loadConfig(): AppConfig {
  const foundryProjectEndpoint = optionalEnv("FOUNDRY_PROJECT_ENDPOINT");
  const aiProvider = (optionalEnv("AI_PROVIDER") ?? (foundryProjectEndpoint ? "foundry" : "mock")) as "mock" | "foundry";

  if (aiProvider !== "mock" && aiProvider !== "foundry") {
    throw new Error("AI_PROVIDER must be either 'mock' or 'foundry'.");
  }

  const cosmosEndpoint = optionalEnv("COSMOS_ENDPOINT");
  const cosmosDatabaseId = optionalEnv("COSMOS_DATABASE_ID") ?? "sandbox";

  return {
    port: numberFromEnv("PORT", 3000),
    simulationId: optionalEnv("SIMULATION_ID") ?? "default",
    adminApiKey: optionalEnv("ADMIN_API_KEY") ?? (process.env.NODE_ENV === "production" ? undefined : randomBytes(24).toString("hex")),
    autoStart: (optionalEnv("SIM_AUTO_START") ?? "true").toLowerCase() === "true",
    simulation: {
      worldSize: numberFromEnv("WORLD_SIZE", 16),
      actorsPerTurn: numberFromEnv("ACTORS_PER_TURN", 2),
      turnIntervalMs: numberFromEnv("TURN_INTERVAL_MS", 30_000),
      proposalVotingWindowTurns: numberFromEnv("PROPOSAL_VOTING_WINDOW_TURNS", 20),
      quorumRatio: numberFromEnv("PROPOSAL_QUORUM_RATIO", 0.5),
      supermajorityRatio: numberFromEnv("PROPOSAL_SUPERMAJORITY_RATIO", 2 / 3),
      maxConsecutiveConverses: numberFromEnv("MAX_CONSECUTIVE_CONVERSES", 3),
      conversationSilenceThreshold: numberFromEnv("CONVERSATION_SILENCE_THRESHOLD", 8),
      startResources: numberFromEnv("START_RESOURCES", 6),
      upkeepPerAction: numberFromEnv("UPKEEP_PER_ACTION", 1),
      gatherYield: numberFromEnv("GATHER_YIELD", 3),
      gatherBase: numberFromEnv("GATHER_BASE", 1),
      tileMaxProductivity: numberFromEnv("TILE_MAX_PRODUCTIVITY", 6),
      tileRegenInterval: numberFromEnv("TILE_REGEN_INTERVAL", 4),
      electionWindowTurns: numberFromEnv("ELECTION_WINDOW_TURNS", 6)
    },
    governanceDefaults: {
      presidentTermTurns: numberFromEnv("PRESIDENT_TERM_TURNS", 30),
      presidentCanTax: boolFromEnv("PRESIDENT_CAN_TAX", true),
      presidentCanSpend: boolFromEnv("PRESIDENT_CAN_SPEND", true),
      presidentCanFine: boolFromEnv("PRESIDENT_CAN_FINE", true),
      presidentCanPardon: boolFromEnv("PRESIDENT_CAN_PARDON", true),
      presidentCanDecree: boolFromEnv("PRESIDENT_CAN_DECREE", true),
      taxCapPerAction: numberFromEnv("TAX_CAP_PER_ACTION", 2),
      fineMax: numberFromEnv("FINE_MAX", 4),
      proposalCost: numberFromEnv("PROPOSAL_COST", 2),
      changeTileCost: numberFromEnv("CHANGE_TILE_COST", 2)
    },
    ai: {
      provider: aiProvider,
      foundryProjectEndpoint,
      foundryApiKey: optionalEnv("FOUNDRY_API_KEY"),
      deployments: {
        "gpt-5.4": optionalEnv("GPT_5_4_DEPLOYMENT_NAME") ?? "gpt-5.4",
        "grok-4.3": optionalEnv("GROK_43_DEPLOYMENT_NAME") ?? "grok-4.3",
        "deepseek-v4-pro": optionalEnv("DEEPSEEK_V4_PRO_DEPLOYMENT_NAME") ?? "DeepSeek-V4-Pro",
        "kimi-k2.6": optionalEnv("KIMI_K26_DEPLOYMENT_NAME") ?? "Kimi-K2.6"
      },
      requestTimeoutMs: numberFromEnv("AI_REQUEST_TIMEOUT_MS", 20_000),
      maxOutputTokens: numberFromEnv("AI_MAX_OUTPUT_TOKENS", 700)
    },
    cosmos: cosmosEndpoint
      ? {
          endpoint: cosmosEndpoint,
          databaseId: cosmosDatabaseId
        }
      : undefined,
    federation: loadFederationConfig(optionalEnv("SIMULATION_ID") ?? "default"),
    telemetry: {
      connectionString: optionalEnv("APPLICATIONINSIGHTS_CONNECTION_STRING")
    }
  };
}
