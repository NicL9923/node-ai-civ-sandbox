import "dotenv/config";
import { randomBytes } from "node:crypto";
import type { GovernanceParams, ModelKey, SimulationConfig } from "../shared/types.js";

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
    telemetry: {
      connectionString: optionalEnv("APPLICATIONINSIGHTS_CONNECTION_STRING")
    }
  };
}
