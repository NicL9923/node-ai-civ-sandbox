import { afterEach, describe, expect, it } from "vitest";
import { loadFederationConfig } from "../config.js";

const WORLD_KEYS = [
  "WORLD_API_BASE_URL",
  "WORLD_PROTOCOL_VERSION",
  "WORLD_CIV_ID",
  "WORLD_KEY_ID",
  "WORLD_HMAC_SECRET",
  "WORLD_ONBOARDING_TOKEN",
  "WORLD_DISPLAY_NAME",
  "WORLD_HEARTBEAT_INTERVAL_MS",
  "WORLD_POLL_INTERVAL_MS",
  "WORLD_OUTBOX_INTERVAL_MS"
];

function clearWorldEnv(): void {
  for (const key of WORLD_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearWorldEnv();
});

describe("loadFederationConfig", () => {
  it("returns undefined (standalone) when WORLD_API_BASE_URL is unset", () => {
    clearWorldEnv();
    expect(loadFederationConfig("default")).toBeUndefined();
  });

  it("accepts pre-provisioned credentials", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_CIV_ID = "civ_aurora";
    process.env.WORLD_KEY_ID = "key_01";
    process.env.WORLD_HMAC_SECRET = "s3cr3t-hmac-key-v1";
    const config = loadFederationConfig("aurora");
    expect(config).toBeDefined();
    expect(config?.civId).toBe("civ_aurora");
    expect(config?.protocolVersion).toBe("1");
    expect(config?.displayName).toBe("aurora");
  });

  it("accepts an onboarding token plus the out-of-band secret", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_HMAC_SECRET = "s3cr3t-hmac-key-v1";
    process.env.WORLD_ONBOARDING_TOKEN = "onboard-123";
    const config = loadFederationConfig("aurora");
    expect(config).toBeDefined();
    expect(config?.onboardingToken).toBe("onboard-123");
    expect(config?.civId).toBeUndefined();
  });

  it("rejects a missing HMAC secret without leaking any value", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_ONBOARDING_TOKEN = "onboard-123";
    expect(() => loadFederationConfig("aurora")).toThrow(/WORLD_HMAC_SECRET/);
  });

  it("rejects a half-provided credential pair", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_HMAC_SECRET = "s3cr3t";
    process.env.WORLD_CIV_ID = "civ_aurora";
    expect(() => loadFederationConfig("aurora")).toThrow(/WORLD_KEY_ID/);
  });

  it("rejects enabled federation with a secret but no credentials and no token", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_HMAC_SECRET = "s3cr3t";
    expect(() => loadFederationConfig("aurora")).toThrow(/WORLD_ONBOARDING_TOKEN|WORLD_CIV_ID/);
  });

  it("rejects an unsupported protocol version", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_HMAC_SECRET = "s3cr3t";
    process.env.WORLD_ONBOARDING_TOKEN = "onboard-123";
    process.env.WORLD_PROTOCOL_VERSION = "2";
    expect(() => loadFederationConfig("aurora")).toThrow(/WORLD_PROTOCOL_VERSION/);
  });

  it("rejects a non-absolute base URL", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "not-a-url";
    process.env.WORLD_HMAC_SECRET = "s3cr3t";
    process.env.WORLD_ONBOARDING_TOKEN = "onboard-123";
    expect(() => loadFederationConfig("aurora")).toThrow(/WORLD_API_BASE_URL/);
  });

  it("never includes the secret value in any thrown error message", () => {
    clearWorldEnv();
    process.env.WORLD_API_BASE_URL = "https://world.example/world/v1";
    process.env.WORLD_HMAC_SECRET = "super-secret-value";
    process.env.WORLD_CIV_ID = "civ_aurora"; // missing key id -> throws
    try {
      loadFederationConfig("aurora");
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-value");
    }
  });
});
