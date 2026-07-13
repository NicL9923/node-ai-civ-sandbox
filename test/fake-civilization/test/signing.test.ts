import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { HmacSigner, buildCanonicalString, canonicalQuery, sha256Hex } from "../src/signing.js";

interface Vector {
  input: {
    protocolVersion: string;
    civId: string;
    keyId: string;
    timestamp: string;
    nonce: string;
    idempotencyKey: string;
    method: string;
    path: string;
    query: string;
    body: string;
    secret: string;
  };
  expected: { canonicalQuery: string; bodySha256Hex: string; canonicalString: string; signature: string };
}

describe("HmacSigner", () => {
  it("matches the shared federation signing vectors independently", async () => {
    const contents = await readFile(
      new URL("../../../packages/federation-contracts/examples/signing.vector.json", import.meta.url),
      "utf8",
    );
    const vectors = (JSON.parse(contents) as { vectors: Vector[] }).vectors;
    const signer = new HmacSigner();
    for (const vector of vectors) {
      const { secret, ...input } = vector.input;
      expect(canonicalQuery(input.query)).toBe(vector.expected.canonicalQuery);
      expect(sha256Hex(input.body)).toBe(vector.expected.bodySha256Hex);
      expect(buildCanonicalString(input)).toBe(vector.expected.canonicalString);
      expect(signer.sign(input, secret)).toBe(vector.expected.signature);
    }
  });

  it("normalizes repeated and reserved query values", () => {
    expect(canonicalQuery("z=a+b&z=a%20b&a=%7E&a=hello world")).toBe("a=hello%20world&a=~&z=a%20b&z=a%20b");
  });
});
