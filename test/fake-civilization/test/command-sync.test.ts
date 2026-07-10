import { describe, expect, it } from "vitest";
import { FakeCivilization } from "../src/fake-civilization.js";
import { createInitialState } from "../src/state.js";
import { ScriptedTransport } from "../src/transport.js";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function fake(transport: ScriptedTransport) {
  const state = createInitialState("Aurora", "1.0.0");
  state.registration = {
    civId: "civ_aurora",
    keyId: "key_aurora",
    protocolVersion: "1",
    registeredAt: "2026-01-01T00:00:00.000Z",
  };
  state.projection.civId = "civ_aurora";
  return new FakeCivilization({
    alias: "aurora",
    displayName: "Aurora",
    worldBaseUrl: "https://world.test/world/v1",
    hmacSecret: "not-logged",
    capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact", "message"] },
    retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
  }, {
    transport,
    state,
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    nonceSource: { next: () => "nonce" },
    sleeper: { sleep: async () => undefined },
  });
}

describe("command sync", () => {
  it("rejects unknown commands then commits the page cursor", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({
      method: "GET",
      path: "/world/v1/civilizations/civ_aurora/commands",
      reply: response(200, {
        items: [{
          id: "event-1",
          specversion: "1.0",
          type: "world.future.v9",
          source: "/world",
          datacontenttype: "application/json",
          commandid: "cmd-1",
        }],
        nextCursor: "cursor-2",
      }),
    });
    transport.enqueue({
      method: "POST",
      path: "/world/v1/civilizations/civ_aurora/commands/cmd-1/ack",
      reply: response(200, { commandId: "cmd-1", status: "rejected", duplicate: false }),
    });
    transport.enqueue({
      method: "GET",
      path: "/world/v1/civilizations/civ_aurora/commands",
      query: "after=cursor-2&limit=50",
      reply: response(200, { items: [], nextCursor: null }),
    });
    const civilization = fake(transport);
    const result = await civilization.sync();
    expect(result.rejected).toBe(1);
    expect(result.pages).toBe(2);
    expect(civilization.state.lastProcessedCommandCursor).toBeNull();
    expect(civilization.state.processedCommands["cmd-1"]?.problem?.code).toBe("unsupported_command_type");
  });

  it("does not advance the cursor when terminal ACK retries are exhausted", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({
      method: "GET",
      path: "/world/v1/civilizations/civ_aurora/commands",
      reply: response(200, {
        items: [{
          id: "event-1",
          specversion: "1.0",
          type: "world.civilization.message.v1",
          source: "/world",
          datacontenttype: "application/json",
          commandid: "cmd-1",
          data: { interactionId: "int-1", fromCiv: "civ_borealis", body: "hello" },
        }],
        nextCursor: "cursor-2",
      }),
    });
    for (let index = 0; index < 2; index += 1) {
      transport.enqueue({
        method: "POST",
        path: "/world/v1/civilizations/civ_aurora/commands/cmd-1/ack",
        reply: response(500, { type: "about:blank", title: "Transient", status: 500, code: "transient", retryable: true }),
      });
    }
    const civilization = fake(transport);
    await expect(civilization.sync()).rejects.toMatchObject({ name: "RetryExhaustedError" });
    expect(civilization.state.lastProcessedCommandCursor).toBeNull();
    expect(civilization.state.messages).toHaveLength(1);

    transport.enqueue({
      method: "GET",
      path: "/world/v1/civilizations/civ_aurora/commands",
      reply: response(200, {
        items: [{
          id: "event-1",
          specversion: "1.0",
          type: "world.civilization.message.v1",
          source: "/world",
          datacontenttype: "application/json",
          commandid: "cmd-1",
          data: { interactionId: "int-1", fromCiv: "civ_borealis", body: "hello" },
        }],
        nextCursor: "cursor-2",
      }),
    });
    transport.enqueue({
      method: "POST",
      path: "/world/v1/civilizations/civ_aurora/commands/cmd-1/ack",
      reply: response(200, { commandId: "cmd-1", status: "duplicate", duplicate: true }),
    });
    transport.enqueue({
      method: "GET",
      path: "/world/v1/civilizations/civ_aurora/commands",
      query: "after=cursor-2&limit=50",
      reply: response(200, { items: [], nextCursor: null }),
    });
    const replay = await civilization.sync();
    expect(replay.pages).toBe(2);
    expect(civilization.state.messages).toHaveLength(1);
    expect(civilization.state.lastProcessedCommandCursor).toBeNull();
    transport.assertDrained();
  });

  it("does not commit a cursor when the World does not record the matching terminal ACK", async () => {
    const transport = new ScriptedTransport();
    transport.enqueue({
      method: "GET",
      path: "/world/v1/civilizations/civ_aurora/commands",
      reply: response(200, {
        items: [{
          id: "event-1",
          specversion: "1.0",
          type: "world.future.v9",
          source: "/world",
          commandid: "cmd-1",
        }],
        nextCursor: "cursor-2",
      }),
    });
    transport.enqueue({
      method: "POST",
      path: "/world/v1/civilizations/civ_aurora/commands/cmd-1/ack",
      reply: response(200, { commandId: "different-command", status: "rejected" }),
    });
    const civilization = fake(transport);
    await expect(civilization.sync()).rejects.toThrow("did not record a terminal ACK");
    expect(civilization.state.lastProcessedCommandCursor).toBeNull();
  });
});
