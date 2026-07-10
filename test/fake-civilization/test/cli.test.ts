import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorCode } from "../src/cli.js";
import { ConfigurationError } from "../src/config.js";
import {
  ScenarioAssertionError,
  ScenarioDefinitionError,
  ScenarioHostControlError,
} from "../src/scenario/types.js";
import { RetryExhaustedError, WorldHttpError } from "../src/transport.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("fake-civ CLI", () => {
  it("prints non-interactive JSON help without credentials", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "--help"], {
      env: {
        ...process.env,
        FAKE_CIV_ONBOARDING_TOKEN: "never-print-token",
        FAKE_CIV_HMAC_SECRET: "never-print-secret",
      },
    });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toHaveProperty("help");
    expect(stdout).not.toContain("never-print-token");
    expect(stdout).not.toContain("never-print-secret");
  });

  it("returns the documented usage exit code and JSON error", async () => {
    try {
      await execFileAsync(process.execPath, [cli, "not-a-command"]);
      throw new Error("CLI unexpectedly accepted an invalid command");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      expect(failure.code).toBe(2);
      expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ exitCode: 2 });
    }
  });

  it.each([
    ["heartbeat"],
    ["register", "--bogus"],
  ])("maps configuration and argument failures to exit code 2", async (...args) => {
    try {
      await execFileAsync(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          FAKE_CIV_ALIAS: "",
          FAKE_CIV_DISPLAY_NAME: "",
          FAKE_CIV_WORLD_URL: "",
        },
      });
      throw new Error("CLI unexpectedly accepted invalid configuration");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      expect(failure.code).toBe(2);
      expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ exitCode: 2 });
    }
  });

  it.each([400, 404, 409, 422])("maps every nonretryable World 4xx error to exit code 3", (status) => {
    expect(errorCode(new WorldHttpError(status))).toBe(3);
  });

  it("maps retry exhaustion to 4 and scenario failures to 5", () => {
    expect(errorCode(new RetryExhaustedError(3))).toBe(4);
    expect(errorCode(new ScenarioAssertionError("failed"))).toBe(5);
    expect(errorCode(new ScenarioHostControlError())).toBe(5);
    expect(errorCode(new ScenarioDefinitionError("malformed scenario"))).toBe(5);
    expect(errorCode(new ConfigurationError("bad config"))).toBe(2);
  });

  it("reports malformed scenarios as definition failures instead of crashing", async () => {
    const scenarioPath = join(process.cwd(), "malformed-scenario-for-cli-test.json");
    await writeFile(scenarioPath, JSON.stringify({
      schemaVersion: "1",
      name: "malformed",
      actors: {},
      steps: [{ op: "heartbeat" }],
    }), "utf8");
    try {
      try {
        await execFileAsync(process.execPath, [cli, "scenario", scenarioPath], {
          env: { ...process.env, FAKE_CIV_WORLD_URL: "https://world.test" },
        });
        throw new Error("CLI unexpectedly accepted malformed scenario");
      } catch (error) {
        const failure = error as { code?: number; stdout?: string };
        expect(failure.code).toBe(5);
        expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ exitCode: 5 });
      }
    } finally {
      await rm(scenarioPath, { force: true });
    }
  });
});
