// Reference implementation of the federation HMAC-SHA256 request-signing
// canonicalization (see docs/protocol.md and the civHmac security scheme). This
// is the authoritative Node reference; the C# runtime (P2/P3) must reproduce the
// same golden vectors in examples/signing.vector.json.
import { createHash, createHmac } from "node:crypto";

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** RFC 3986 percent-encoding: unreserved chars literal, everything else UPPERCASE-hex escaped. */
export function rfc3986Encode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && UNRESERVED.test(ch)
      ? ch
      : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** application/x-www-form-urlencoded decode: `+` becomes a space, then percent-decode. */
export function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

/** Canonical query string: decode, re-encode, sort by encoded key then value, preserve repeats. */
export function canonicalQuery(rawQuery: string): string {
  if (!rawQuery) return "";
  const pairs = rawQuery
    .split("&")
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
      const rawVal = eq >= 0 ? pair.slice(eq + 1) : "";
      return [rfc3986Encode(formDecode(rawKey)), rfc3986Encode(formDecode(rawVal))] as const;
    });
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** Lowercase-hex SHA-256 of the raw body bytes (empty body => SHA-256 of zero bytes). */
export function sha256Hex(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

/** URL-safe base64 without padding. */
export function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SigningInput {
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
}

/** Build the LF-joined 10-field canonical string. */
export function buildCanonicalString(i: SigningInput): string {
  return [
    i.protocolVersion,
    i.civId,
    i.keyId,
    i.timestamp,
    i.nonce,
    i.idempotencyKey,
    i.method.toUpperCase(),
    i.path,
    canonicalQuery(i.query),
    sha256Hex(i.body),
  ].join("\n");
}

/** Compute the X-Signature (base64url, no padding) for the given input and secret. */
export function sign(i: SigningInput, secret: string): string {
  const canonical = buildCanonicalString(i);
  return base64Url(
    createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(Buffer.from(canonical, "utf8"))
      .digest(),
  );
}
