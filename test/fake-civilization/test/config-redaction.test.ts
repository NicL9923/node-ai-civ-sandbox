import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  environmentConfig,
  readConfigFile,
  redactConfig,
  resolveConfig,
} from "../src/config.js";

describe("configuration", () => {
  it("applies source precedence and redacts credentials", () => {
    const config = resolveConfig(
      { alias: "file", displayName: "File", worldBaseUrl: "https://file.test", hmacSecret: "file-secret" },
      { alias: "environment", displayName: "Environment", worldBaseUrl: "https://environment.test" },
      { alias: "cli" },
    );
    expect(config.alias).toBe("cli");
    expect(config.displayName).toBe("Environment");
    expect(config.worldBaseUrl).toBe("https://environment.test");
    expect(redactConfig(config)).toMatchObject({ hmacSecret: "[REDACTED]" });
  });

  it("keeps file values when environment values are missing or empty", () => {
    const file = {
      alias: "file",
      displayName: "File",
      worldBaseUrl: "https://file.test",
      hmacSecret: "file-secret",
      capabilities: { supportedInteractionKinds: ["contact"] },
    };
    const config = resolveConfig(file, environmentConfig({
      FAKE_CIV_HMAC_SECRET: "",
      FAKE_CIV_PROTOCOL_VERSION: "2.0.0",
    }), {});

    expect(config).toMatchObject({
      alias: "file",
      displayName: "File",
      worldBaseUrl: "https://file.test",
      hmacSecret: "file-secret",
      capabilities: {
        protocolVersion: "2.0.0",
        supportedInteractionKinds: ["contact"],
      },
    });
    expect(environmentConfig({ FAKE_CIV_HMAC_SECRET: "" })).not.toHaveProperty("hmacSecret");
  });

  it("resolves a complete file configuration without environment or CLI values", () => {
    const config = resolveConfig({
      alias: "file",
      displayName: "File",
      worldBaseUrl: "https://file.test",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, environmentConfig({}), {});

    expect(config).toMatchObject({
      alias: "file",
      displayName: "File",
      worldBaseUrl: "https://file.test",
    });
  });

  it("applies only defined CLI values over environment and file values", () => {
    const config = resolveConfig(
      {
        alias: "file",
        displayName: "File",
        worldBaseUrl: "https://file.test",
        capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
      },
      environmentConfig({ FAKE_CIV_DISPLAY_NAME: "Environment" }),
      { alias: "cli" },
    );

    expect(config.alias).toBe("cli");
    expect(config.displayName).toBe("Environment");
    expect(config.worldBaseUrl).toBe("https://file.test");
    expect(config.capabilities).toMatchObject({
      protocolVersion: "1.0.0",
      supportedInteractionKinds: ["contact"],
    });
  });

  it("rejects malformed primitive values in configuration files", async () => {
    const path = join(process.cwd(), "malformed-config-for-test.json");
    await writeFile(path, JSON.stringify({
      alias: "aurora",
      displayName: 42,
      worldBaseUrl: "https://world.test",
    }), "utf8");
    try {
      await expect(readConfigFile(path)).rejects.toBeInstanceOf(ConfigurationError);
    } finally {
      await rm(path, { force: true });
    }
  });

  it("rejects malformed retry policy primitives before runtime", () => {
    expect(() => resolveConfig({
      alias: "aurora",
      displayName: "Aurora",
      worldBaseUrl: "https://world.test",
      retry: { maxAttempts: 0, initialDelayMs: -1 },
    }, {}, {})).toThrow(ConfigurationError);
  });
});
