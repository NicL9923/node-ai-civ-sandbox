import { describe, expect, it } from "vitest";
import { ScriptedTransport } from "../src/transport.js";
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
    transport.enqueue({ reply: new Error("connection reset") });
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
