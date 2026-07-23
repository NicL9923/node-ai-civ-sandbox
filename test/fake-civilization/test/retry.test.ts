import { describe, expect, it } from "vitest";
import {
  RetryExhaustedError,
  ScriptedTransport,
  TransientTransportError,
  sendWithRetry,
  type WorldTransport,
} from "../src/transport.js";
import { WorldFederationDriver } from "../src/world-client.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("signed request retries", () => {
  it("reuses body and idempotency key while refreshing nonce on each attempt", async () => {
    const transport = new ScriptedTransport();
    const body = JSON.stringify({ events: [] });
    for (const reply of [
      json(503, { type: "about:blank", title: "Busy", status: 503, code: "busy", retryable: true }),
      json(200, { acceptedCount: 0, duplicateCount: 0, results: [] }),
    ]) {
      transport.enqueue({
        method: "POST",
        path: "/world/v1/civilizations/civ_aurora/events/batch",
        body,
        headers: { "Idempotency-Key": "events-1" },
        reply,
      });
    }
    let nonce = 0;
    const delays: number[] = [];
    const driver = new WorldFederationDriver({
      baseUrl: "https://world.test/world/v1",
      transport,
      credentials: () => ({ civId: "civ_aurora", keyId: "key_aurora", secret: "shared-secret" }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      nonceSource: { next: () => `nonce-${++nonce}` },
      sleeper: { sleep: async (milliseconds) => { delays.push(milliseconds); } },
      retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 },
    });
    await driver.pushEvents("civ_aurora", { events: [] }, "events-1");
    expect(transport.journal.map((entry) => entry.headers["x-nonce"])).toEqual(["nonce-1", "nonce-2"]);
    expect(transport.journal.map((entry) => entry.headers["idempotency-key"])).toEqual(["events-1", "events-1"]);
    expect(delays).toEqual([10]);
  });

  it("retries heartbeat with an empty canonical idempotency field and no header", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({ reply: new TransientTransportError("connection reset") });
    transport.enqueue({
      headers: { "X-Nonce": "fixed-replay-nonce" },
      reply: json(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    const driver = new WorldFederationDriver({
      baseUrl: "https://world.test/world/v1",
      transport,
      credentials: () => ({ civId: "civ_aurora", keyId: "key_aurora", secret: "shared-secret" }),
      nonceSource: { next: () => "fixed-replay-nonce" },
      sleeper: { sleep: async () => undefined },
      signingHooks: { beforeSign: () => ({ nonce: "fixed-replay-nonce" }) },
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });
    await driver.heartbeat("civ_aurora", {
      projection: {
        civId: "civ_aurora",
        displayName: "Aurora",
        protocolVersion: "1",
        turn: 1,
        running: true,
        population: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(transport.journal.every((entry) => entry.headers["idempotency-key"] === undefined)).toBe(true);
  });
});

describe("retry classification", () => {
  const policy = { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 };
  const sleeper = { sleep: async () => undefined };
  const success = new Response(null, { status: 204 });

  async function classify(first: Response | Error): Promise<{ attempts: number; response?: Response; error?: unknown }> {
    let attempts = 0;
    const transport: WorldTransport = {
      send: async () => {
        attempts += 1;
        if (attempts > 1) return success;
        if (first instanceof Error) throw first;
        return first;
      },
    };
    try {
      const response = await sendWithRetry(
        async () => new Request("https://world.test/world/v1/events"),
        transport,
        policy,
        sleeper,
      );
      return {
        attempts,
        response,
      };
    } catch (error) {
      return { attempts, error };
    }
  }

  it.each([
    ["bare 503", new Response(null, { status: 503 })],
    ["bare 429", new Response(null, { status: 429 })],
    [
      "valid retryable problem",
      json(408, {
        type: "about:blank",
        title: "Timeout",
        status: 408,
        code: "request_timeout",
        retryable: true,
      }),
    ],
    ["known transient transport failure", new TransientTransportError("reset")],
  ])("retries %s", async (_name, first) => {
    const result = await classify(first);
    expect(result.attempts).toBe(2);
    expect(result.response?.status).toBe(204);
  });

  it.each([
    [
      "401 even with retryable body",
      json(401, {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "invalid_signature",
        retryable: true,
      }),
    ],
    [
      "403 even with retryable body",
      json(403, {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        code: "forbidden",
        retryable: true,
      }),
    ],
    [
      "nonretryable 409",
      json(409, {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        code: "conflict",
        retryable: false,
      }),
    ],
  ])("does not retry %s", async (_name, first) => {
    const result = await classify(first);
    expect(result.attempts).toBe(1);
    expect(result.response).toBe(first);
  });

  it("throws RetryExhaustedError after the final retryable response", async () => {
    let attempts = 0;
    const transport: WorldTransport = {
      send: async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      },
    };
    await expect(sendWithRetry(
      async () => new Request("https://world.test/world/v1/events"),
      transport,
      policy,
      sleeper,
    )).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(attempts).toBe(2);
  });

  it("does not retry arbitrary request-construction or transport exceptions", async () => {
    const localError = new Error("local bug");
    let transportAttempts = 0;
    const transport: WorldTransport = {
      send: async () => {
        transportAttempts += 1;
        throw localError;
      },
    };
    await expect(sendWithRetry(
      async () => { throw localError; },
      transport,
      policy,
      sleeper,
    )).rejects.toBe(localError);
    expect(transportAttempts).toBe(0);

    await expect(sendWithRetry(
      async () => new Request("https://world.test/world/v1/events"),
      transport,
      policy,
      sleeper,
    )).rejects.toBe(localError);
    expect(transportAttempts).toBe(1);
  });
});

describe("Retry-After handling", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it.each([
    ["huge delta", "999999", 100, 999_999_000],
    ["future HTTP-date", "Thu, 01 Jan 2026 00:00:10 GMT", 1_000, 10_000],
    ["past HTTP-date", "Wed, 31 Dec 2025 23:59:59 GMT", 1_000, 0],
    ["invalid value", "eventually", 1_000, 25],
  ])("handles %s", async (_name, retryAfter, maxDelayMs, expectedDelay) => {
    let attempts = 0;
    const delays: number[] = [];
    const transport: WorldTransport = {
      send: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 503, headers: { "retry-after": retryAfter } })
          : new Response(null, { status: 204 });
      },
    };
    await sendWithRetry(
      async () => new Request("https://world.test/world/v1/events"),
      transport,
      { maxAttempts: 2, initialDelayMs: 25, maxDelayMs },
      { sleep: async (milliseconds) => { delays.push(milliseconds); } },
      { now: () => now },
    );
    expect(delays).toEqual([expectedDelay]);
  });

  it("retries a social PUT with stable bytes/key and fresh signing material", async () => {
    const transport = new ScriptedTransport();
    const body = JSON.stringify({
      liked: true,
      authorization: {
        actingLocalAgentId: "agent-1",
        authorityDecision: { mode: "delegated", ref: "like-1" },
      },
    });
    transport.enqueue({
      method: "PUT",
      path: "/world/v1/social/posts/post-1/likes/acct-1",
      body,
      headers: { "Idempotency-Key": "like-1" },
      reply: new Response(JSON.stringify({
        type: "about:blank",
        title: "Rate limited",
        status: 429,
        code: "rate_limited",
        retryable: true,
      }), {
        status: 429,
        headers: {
          "content-type": "application/problem+json",
          "retry-after": "2",
        },
      }),
    });
    transport.enqueue({
      method: "PUT",
      path: "/world/v1/social/posts/post-1/likes/acct-1",
      body,
      headers: { "Idempotency-Key": "like-1" },
      reply: json(200, {
        postId: "post-1",
        accountId: "acct-1",
        liked: true,
        changed: true,
        likeCount: 1,
        updatedAt: "2026-01-01T00:00:02.000Z",
        worldsequence: "4",
      }),
    });
    let nonce = 0;
    const signatures: string[] = [];
    const delays: number[] = [];
    const driver = new WorldFederationDriver({
      baseUrl: "https://world.test/world/v1",
      transport,
      credentials: () => ({ civId: "civ_aurora", keyId: "key_aurora", secret: "shared-secret" }),
      clock: { now: () => now },
      nonceSource: { next: () => `social-nonce-${++nonce}` },
      sleeper: { sleep: async (milliseconds) => { delays.push(milliseconds); } },
      retry: { maxAttempts: 2 },
      signingHooks: {
        afterSign: (request) => {
          signatures.push(request.headers.get("X-Signature") ?? "");
        },
      },
    });

    await driver.setSocialPostLike("post-1", "acct-1", {
      liked: true,
      authorization: {
        actingLocalAgentId: "agent-1",
        authorityDecision: { mode: "delegated", ref: "like-1" },
      },
    }, "like-1");

    expect(delays).toEqual([2_000]);
    expect(transport.journal.map((entry) => entry.headers["x-nonce"])).toEqual([
      "social-nonce-1",
      "social-nonce-2",
    ]);
    expect(transport.journal.map((entry) => entry.headers["idempotency-key"])).toEqual([
      "like-1",
      "like-1",
    ]);
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).not.toBe(signatures[1]);
  });
});
