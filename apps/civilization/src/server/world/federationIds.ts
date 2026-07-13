// Stable, Cosmos-safe document/id derivation for the federation subsystem. Cosmos DB item ids may not
// contain '/', '\\', '?', or '#', but logical dedupe keys are derived from external values (a
// CloudEvents `idempotencykey`, or a `source` URI + `id`) that can contain any of those, plus unicode.
// We therefore never use a raw logical key as an id; instead we hash it to lowercase SHA-256 hex (which
// is always `[0-9a-f]`) behind a short human-readable kind prefix. The raw logical key is retained as a
// normal document property for diagnostics and dedupe reasoning.
import { createHash } from "node:crypto";

/** `${kind}_${sha256hex(rawKey)}` — always a valid Cosmos id regardless of what rawKey contains. */
export function safeFederationId(kind: string, rawKey: string): string {
  const digest = createHash("sha256").update(rawKey, "utf8").digest("hex");
  return `${kind}_${digest}`;
}
