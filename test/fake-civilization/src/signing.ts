import { createHash, createHmac, randomUUID } from "node:crypto";

const unreserved = /^[A-Za-z0-9\-._~]$/;

export interface Clock {
  now(): Date;
}

export interface NonceSource {
  next(): string;
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
  body: string | Uint8Array;
}

export interface SigningCredentials {
  civId: string;
  keyId: string;
  secret: string;
  protocolVersion?: string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomNonceSource implements NonceSource {
  next(): string {
    return randomUUID();
  }
}

export function rfc3986Encode(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    encoded += byte < 128 && unreserved.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

export function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

export function canonicalQuery(rawQuery: string): string {
  if (!rawQuery) return "";
  const pairs = rawQuery
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const separator = pair.indexOf("=");
      const key = separator === -1 ? pair : pair.slice(0, separator);
      const value = separator === -1 ? "" : pair.slice(separator + 1);
      return [rfc3986Encode(formDecode(key)), rfc3986Encode(formDecode(value))] as const;
    });
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0,
  );
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

export function sha256Hex(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function buildCanonicalString(input: SigningInput): string {
  return [
    input.protocolVersion,
    input.civId,
    input.keyId,
    input.timestamp,
    input.nonce,
    input.idempotencyKey,
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query),
    sha256Hex(input.body),
  ].join("\n");
}

export class HmacSigner {
  sign(input: SigningInput, secret: string): string {
    return base64Url(
      createHmac("sha256", Buffer.from(secret, "utf8"))
        .update(Buffer.from(buildCanonicalString(input), "utf8"))
        .digest(),
    );
  }

  headers(input: Omit<SigningInput, "protocolVersion" | "civId" | "keyId" | "timestamp" | "nonce"> & {
    credentials: SigningCredentials;
    timestamp: string;
    nonce: string;
  }): Record<string, string> {
    const protocolVersion = input.credentials.protocolVersion ?? "1";
    const signingInput: SigningInput = {
      ...input,
      protocolVersion,
      civId: input.credentials.civId,
      keyId: input.credentials.keyId,
    };
    return {
      "X-Protocol-Version": protocolVersion,
      "X-Civ-Id": input.credentials.civId,
      "X-Key-Id": input.credentials.keyId,
      "X-Timestamp": input.timestamp,
      "X-Nonce": input.nonce,
      "X-Signature": this.sign(signingInput, input.credentials.secret),
    };
  }
}
