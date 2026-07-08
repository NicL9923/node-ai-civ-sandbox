import "dotenv/config";
import { randomBytes } from "node:crypto";
import type { ModelKey, SimulationConfig } from "../shared/types.js";

export interface AppConfig {
  port: number;
  simulationId: string;
  adminApiKey?: string;
  autoStart: boolean;
  simulation: SimulationConfig;
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
      conversationSilenceThreshold: numberFromEnv("CONVERSATION_SILENCE_THRESHOLD", 8)
    },
    ai: {
      provider: aiProvider,
      foundryProjectEndpoint,
      foundryApiKey: optionalEnv("FOUNDRY_API_KEY"),
      deployments: {
        "gpt-5.4": optionalEnv("GPT_5_4_DEPLOYMENT_NAME") ?? "gpt-5.4",
        "grok-4.3": optionalEnv("GROK_43_DEPLOYMENT_NAME") ?? "grok-4.3",
        "deepseek-v4-pro": optionalEnv("DEEPSEEK_V4_PRO_DEPLOYMENT_NAME") ?? "DeepSeek-V4-Pro"
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
