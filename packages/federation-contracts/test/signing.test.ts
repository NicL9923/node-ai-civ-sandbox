import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildCanonicalString,
  canonicalQuery,
  sha256Hex,
  sign,
  type SigningInput,
} from "./signing.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Vector {
  name: string;
  input: SigningInput & { secret: string };
  expected: {
    canonicalQuery: string;
    bodySha256Hex: string;
    canonicalString: string;
    signature: string;
  };
}

const fixture = JSON.parse(
  readFileSync(resolve(pkgRoot, "examples/signing.vector.json"), "utf8"),
) as { vectors: Vector[] };

describe("HMAC signing canonicalization matches the shared golden vectors", () => {
  it("ships at least one messy-query vector and one empty-idempotency read vector", () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixture.vectors.map((v) => [v.name, v] as const))(
    "%s: canonical string, body hash, and signature are reproducible",
    (_name, v) => {
      const { secret, ...input } = v.input;

      expect(canonicalQuery(input.query)).toBe(v.expected.canonicalQuery);
      expect(sha256Hex(input.body)).toBe(v.expected.bodySha256Hex);
      expect(buildCanonicalString(input)).toBe(v.expected.canonicalString);
      expect(sign(input, secret)).toBe(v.expected.signature);
    },
  );
});

describe("canonical query normalization edge cases", () => {
  it("encodes spaces as %20 (never +) and uppercases hex escapes", () => {
    expect(canonicalQuery("a=hello world")).toBe("a=hello%20world");
    expect(canonicalQuery("z=a+b")).toBe("z=a%20b");
  });

  it("sorts by encoded key then value and preserves repeated keys", () => {
    expect(canonicalQuery("b=2&a=hello world&a=1")).toBe("a=1&a=hello%20world&b=2");
  });

  it("produces the well-known SHA-256 for an empty body", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("emits base64url without padding", () => {
    const sig = sign(
      {
        protocolVersion: "1",
        civId: "c",
        keyId: "k",
        timestamp: "1",
        nonce: "n",
        idempotencyKey: "",
        method: "GET",
        path: "/x",
        query: "",
        body: "",
      },
      "secret",
    );
    expect(sig).not.toContain("=");
    expect(sig).not.toContain("+");
    expect(sig).not.toContain("/");
  });
});
