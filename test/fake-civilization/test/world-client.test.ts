import { describe, expect, it } from "vitest";
import type { paths } from "@ai-civ/federation-contracts";
import { FakeCivilization } from "../src/fake-civilization.js";
import { createInitialState } from "../src/state.js";
import { ScriptedTransport } from "../src/transport.js";
import { WorldFederationDriver } from "../src/world-client.js";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const usedGeneratedPaths = [
  "/civilizations/register",
  "/civilizations/{civId}/heartbeat",
  "/civilizations/{civId}/events/batch",
  "/civilizations/{civId}/commands",
  "/civilizations/{civId}/commands/{commandId}/ack",
  "/interactions",
  "/interactions/{interactionId}",
  "/civilizations",
  "/civilizations/{civId}",
  "/relationships",
  "/events",
] satisfies Array<keyof paths>;

describe("WorldFederationDriver", () => {
  it("keeps every driver route pinned to a generated OpenAPI path", () => {
    expect(usedGeneratedPaths).toHaveLength(11);
  });

  it("uses the generated route shapes and signs serialized authenticated calls", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({
      method: "POST",
      path: "/world/v1/civilizations/register",
      reply: response(201, {
        civId: "civ_aurora",
        keyId: "key_aurora",
        protocolVersion: "1",
        registeredAt: "2026-01-01T00:00:00.000Z",
        duplicate: false,
      }),
    });
    transport.enqueue({
      method: "POST",
      path: "/world/v1/civilizations/civ_aurora/heartbeat",
      headers: { "X-Protocol-Version": "1", "X-Civ-Id": "civ_aurora" },
      reply: response(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    const driver = new WorldFederationDriver({
      baseUrl: "https://world.test/world/v1",
      transport,
      credentials: () => ({ civId: "civ_aurora", keyId: "key_aurora", secret: "not-logged" }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      nonceSource: { next: () => "nonce-1" },
    });
    await driver.register({
      onboardingToken: "not-logged",
      displayName: "Aurora",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, "register-1");
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
    transport.assertDrained();
    expect(transport.journal).toHaveLength(2);
    expect(transport.journal[1]?.headers["x-signature"]).toBe("[REDACTED]");
    expect(transport.journal[1]?.headers["idempotency-key"]).toBeUndefined();
    expect(JSON.stringify(transport.journal)).not.toContain("not-logged");
  });

  it("emits each fixed adversarial signing mutation without exposing secrets", async () => {
    const transport = new ScriptedTransport();
    const timestamp = Math.floor(new Date("2026-01-01T00:00:00.000Z").getTime() / 1_000);
    transport.enqueue({
      path: "/world/v1/civilizations/civ_aurora/heartbeat",
      headers: { "X-Signature": "invalid-signature" },
      reply: response(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    transport.enqueue({
      headers: { "X-Timestamp": String(timestamp - 301) },
      reply: response(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    transport.enqueue({
      headers: { "X-Nonce": "aurora-reused-nonce" },
      reply: response(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    transport.enqueue({
      body: "{}",
      reply: response(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    transport.enqueue({
      headers: { "X-Civ-Id": "civ_aurora-wrong" },
      reply: response(200, { civId: "civ_aurora", serverTime: "2026-01-01T00:00:00.000Z" }),
    });
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    state.projection.civId = "civ_aurora";
    const civilization = new FakeCivilization({
      alias: "aurora",
      displayName: "Aurora",
      worldBaseUrl: "https://world.test/world/v1",
      hmacSecret: "never-journal-this",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, {
      state,
      transport,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      nonceSource: { next: () => "nonce" },
    });
    for (const fault of [
      "invalid-signature",
      "stale-timestamp",
      "reused-nonce",
      "body-tamper",
      "wrong-civ-id",
    ] as const) {
      civilization.setSigningFault(fault);
      await civilization.heartbeat();
    }
    transport.assertDrained();
    expect(JSON.stringify(transport.journal)).not.toContain("never-journal-this");
  });
});
