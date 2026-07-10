import { describe, expect, it } from "vitest";
import { redactConfig, resolveConfig } from "../src/config.js";

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
});
