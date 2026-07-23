import { expect, test } from "@playwright/test";
import { readSseUntil } from "./sse.js";

const encoder = new TextEncoder();

function responseFromChunks(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

test.describe("SSE frame reader", () => {
  test("finds a target frame after a replay larger than 8 KB", async () => {
    const filler = `id: 1\ndata: ${"x".repeat(9_000)}\n\n`;
    const result = await readSseUntil("http://test.invalid/stream", {
      windowMs: 100,
      matchFrame: (frame) => frame.includes("world.social."),
      fetchImpl: async () =>
        responseFromChunks([
          filler,
          "id: 2\ndata: {\"type\":\"world.social.post.created.v1\"}\n\n",
        ]),
    });

    expect(result.matched).toBe(true);
    expect(result.stopReason).toBe("matched");
    expect(result.frames).toHaveLength(2);
  });

  test("parses CRLF frames when delimiters and event type split across chunks", async () => {
    const result = await readSseUntil("http://test.invalid/stream", {
      windowMs: 100,
      matchFrame: (frame) => frame.includes("world.social."),
      fetchImpl: async () =>
        responseFromChunks([
          "id: 1\r",
          "\ndata: {\"type\":\"world.so",
          "cial.post.created.v1\"}\r",
          "\n\r",
          "\n",
        ]),
    });

    expect(result.matched).toBe(true);
    expect(result.frames).toEqual(['id: 1\r\ndata: {"type":"world.social.post.created.v1"}']);
  });

  test("returns bounded captured frames when the target never arrives", async () => {
    const result = await readSseUntil("http://test.invalid/stream", {
      windowMs: 100,
      maxFrames: 2,
      matchFrame: (frame) => frame.includes("world.social."),
      fetchImpl: async () => responseFromChunks(["id: 1\ndata: ordinary\n\nid: 2\ndata: still-ordinary\n\n"]),
    });

    expect(result.matched).toBe(false);
    expect(result.stopReason).toBe("frame-cap");
    expect(result.raw).toContain("still-ordinary");
  });

  test("enforces the cap in UTF-8 bytes and retains a partial-frame diagnostic", async () => {
    const result = await readSseUntil("http://test.invalid/stream", {
      windowMs: 100,
      maxBytes: 8,
      matchFrame: (frame) => frame.includes("world.social."),
      fetchImpl: async () => responseFromChunks(["data: 😀\n\n"]),
    });

    expect(result.matched).toBe(false);
    expect(result.stopReason).toBe("byte-cap");
    expect(result.raw).not.toBe("");
  });

  test("cancels an idle reader at the deadline", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Keep the reader pending until readSseUntil cancels it.
      },
    });
    const result = await readSseUntil("http://test.invalid/stream", {
      windowMs: 10,
      matchFrame: (frame) => frame.includes("world.social."),
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });

    expect(result.matched).toBe(false);
    expect(result.stopReason).toBe("timeout");
    expect(result.frames).toEqual([]);
  });

  test("does not wait for a non-settling cancellation to return", async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const result = await readSseUntil("http://test.invalid/stream", {
      windowMs: 10,
      matchFrame: (frame) => frame.includes("world.social."),
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });

    expect(result.stopReason).toBe("timeout");
  });
});
