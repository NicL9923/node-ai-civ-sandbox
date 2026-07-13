import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCanonicalString, canonicalQuery, sha256Hex, sign, type SigningInput } from "./hmac.js";

// The authoritative golden vectors are owned by P1 (packages/federation-contracts). Loading them here
// (rather than copying) guarantees the connector's signing stays byte-identical to the shared contract.
const vectorsPath = fileURLToPath(
  new URL("../../../../../packages/federation-contracts/examples/signing.vector.json", import.meta.url)
);

interface Vector {
  name: string;
  input: SigningInput & { secret: string };
  expected: { canonicalQuery: string; bodySha256Hex: string; canonicalString: string; signature: string };
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")).vectors as Vector[];

describe("federation HMAC signing (shared P1 vectors)", () => {
  it("loads at least the two golden vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(2);
  });

  for (const vector of vectors) {
    describe(vector.name, () => {
      it("reproduces the canonical query", () => {
        expect(canonicalQuery(vector.input.query)).toBe(vector.expected.canonicalQuery);
      });

      it("reproduces the body SHA-256", () => {
        expect(sha256Hex(vector.input.body)).toBe(vector.expected.bodySha256Hex);
      });

      it("reproduces the canonical string", () => {
        expect(buildCanonicalString(vector.input)).toBe(vector.expected.canonicalString);
      });

      it("reproduces the signature", () => {
        expect(sign(vector.input, vector.input.secret)).toBe(vector.expected.signature);
      });
    });
  }
});
