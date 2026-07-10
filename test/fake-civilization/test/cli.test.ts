import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
