#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  environmentConfig,
  ConfigurationError,
  FakeCivilization,
  loadScenario,
  loadState,
  readConfigFile,
  resolveConfig,
  RetryExhaustedError,
  runScenario,
  saveState,
  ScenarioAssertionError,
  ScenarioDefinitionError,
  ScenarioHostControlError,
  WorldHttpError,
} from "./index.js";
import type { ConfigInput, FakeCivilizationConfig } from "./config.js";

const usage = `Usage: fake-civ <register|heartbeat|sync|scenario|help> [file] [--config file] [--state file] [--world-url url] [--json]

Environment: FAKE_CIV_ALIAS, FAKE_CIV_DISPLAY_NAME, FAKE_CIV_WORLD_URL,
FAKE_CIV_ONBOARDING_TOKEN, FAKE_CIV_HMAC_SECRET, FAKE_CIV_CIV_ID, FAKE_CIV_KEY_ID.
All output is JSON. No command prompts.`;

class UsageError extends Error {}

function cliInput(values: Record<string, string | boolean | undefined>): ConfigInput {
  return {
    ...(typeof values["world-url"] === "string" ? { worldBaseUrl: values["world-url"] } : {}),
  };
}

export function errorCode(error: unknown): number {
  if (
    error instanceof UsageError ||
    error instanceof ConfigurationError ||
    (error instanceof TypeError &&
      "code" in error &&
      String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS"))
  ) return 2;
  if (error instanceof WorldHttpError && error.status >= 400 && error.status < 500) return 3;
  if (error instanceof RetryExhaustedError) return 4;
  if (
    error instanceof ScenarioAssertionError
    || error instanceof ScenarioDefinitionError
    || error instanceof ScenarioHostControlError
  ) return 5;
  return 1;
}

function diagnostic(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/(secret|token|password)=[^ ]+/gi, "$1=[REDACTED]");
  return "Unexpected fake-civ failure";
}

async function configFrom(values: Record<string, string | boolean | undefined>): Promise<FakeCivilizationConfig> {
  const file = typeof values.config === "string" ? await readConfigFile(values.config) : {};
  return resolveConfig(file, environmentConfig(), cliInput(values));
}

async function run(): Promise<unknown> {
  const parsed = parseArgs({
    options: {
      config: { type: "string" },
      state: { type: "string" },
      "world-url": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (parsed.values.help) return { help: usage };
  const [command, scenarioPath] = parsed.positionals;
  if (command === "help") return { help: usage };
  if (!command || !["register", "heartbeat", "sync", "scenario"].includes(command)) {
    throw new UsageError(usage);
  }
  if (command === "scenario") {
    if (!scenarioPath) throw new UsageError("scenario requires a fixture file\n" + usage);
    const file = typeof parsed.values.config === "string" ? await readConfigFile(parsed.values.config) : {};
    const environment = environmentConfig();
    const config = resolveConfig({
      ...file,
      alias: file.alias ?? environment.alias ?? "scenario",
      displayName: file.displayName ?? environment.displayName ?? "Scenario actor",
    }, environment, cliInput(parsed.values));
    const scenario = await loadScenario(scenarioPath);
    const result = await runScenario(scenario, {
      createActor: (name, actor) => new FakeCivilization({
        ...config,
        alias: name,
        displayName: actor.displayName,
        capabilities: actor.capabilities,
        hmacSecret: process.env[`FAKE_CIV_SECRET_${actor.credentialRef.toUpperCase()}`] ?? config.hmacSecret,
        onboardingToken: process.env[`FAKE_CIV_ONBOARDING_TOKEN_${actor.credentialRef.toUpperCase()}`] ?? config.onboardingToken,
      }),
    });
    return { command, name: result.name, completedSteps: result.completedSteps };
  }
  const config = await configFrom(parsed.values);
  const statePath = typeof parsed.values.state === "string" ? parsed.values.state : ".fake-civ-state.json";
  const state = existsSync(statePath) ? await loadState(statePath) : undefined;
  const civilization = new FakeCivilization(config, { state });
  try {
    const result = command === "register"
      ? await civilization.register()
      : command === "heartbeat"
        ? await civilization.heartbeat()
        : await civilization.sync();
    return { command, result, state: civilization.state };
  } finally {
    await saveState(statePath, civilization.state);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error: unknown) => {
      const code = errorCode(error);
      process.stdout.write(`${JSON.stringify({ error: diagnostic(error), exitCode: code })}\n`);
      process.stderr.write(`${diagnostic(error)}\n`);
      process.exitCode = code;
    },
  );
}
