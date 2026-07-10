// Typed World API client built on the P1 generated `paths` + openapi-fetch. An onRequest middleware
// signs every authenticated request with the federation HMAC scheme (see hmac.ts). Registration is the
// only unsigned call, so it uses a client created without a signer.
import { randomBytes, randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "@ai-civ/federation-contracts";
import { sign } from "./hmac.js";

export type WorldClient = Client<paths>;

export interface WorldSigner {
  civId: string;
  keyId: string;
  secret: string;
  protocolVersion: "1";
}

function nowEpochSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/** Minimal W3C traceparent: version-00, random trace id + span id, sampled flag. */
function generateTraceparent(): string {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}-01`;
}

/** True for the unsigned bootstrap registration endpoint. */
function isRegisterPath(pathname: string): boolean {
  return pathname.endsWith("/civilizations/register");
}

/**
 * Create a World client. When `signer` is provided, every request (except register) is HMAC-signed.
 * The idempotency key is taken from the caller-supplied `Idempotency-Key` header so it stays stable
 * across retries; a fresh nonce and timestamp are generated per attempt.
 */
export function createWorldClient(baseUrl: string, signer?: WorldSigner): WorldClient {
  const client = createClient<paths>({ baseUrl });

  if (signer) {
    client.use({
      async onRequest({ request }) {
        const url = new URL(request.url);
        if (isRegisterPath(url.pathname)) {
          return request;
        }

        const method = request.method.toUpperCase();
        const body = method === "GET" || method === "HEAD" ? "" : await request.clone().text();
        const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
        const timestamp = nowEpochSeconds();
        const nonce = randomUUID();
        const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;

        const signature = sign(
          {
            protocolVersion: signer.protocolVersion,
            civId: signer.civId,
            keyId: signer.keyId,
            timestamp,
            nonce,
            idempotencyKey,
            method,
            path: url.pathname,
            query,
            body
          },
          signer.secret
        );

        request.headers.set("X-Civ-Id", signer.civId);
        request.headers.set("X-Key-Id", signer.keyId);
        request.headers.set("X-Timestamp", timestamp);
        request.headers.set("X-Nonce", nonce);
        request.headers.set("X-Protocol-Version", signer.protocolVersion);
        request.headers.set("X-Signature", signature);
        if (!request.headers.has("traceparent")) {
          request.headers.set("traceparent", generateTraceparent());
        }
        return request;
      }
    });
  }

  return client;
}
