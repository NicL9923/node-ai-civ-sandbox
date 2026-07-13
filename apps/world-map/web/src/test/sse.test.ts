import { describe, expect, it, vi } from "vitest";
import { SseFrameParser, WorldEventStream, type StreamStatus } from "../api/sse";
import type { WorldEvent } from "../api/types";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SseFrameParser", () => {
  it("extracts data payloads from complete frames", () => {
    const p = new SseFrameParser();
    expect(p.push('data: {"id":"a"}\n\n')).toEqual(['{"id":"a"}']);
  });

  it("ignores comment/keep-alive frames", () => {
    const p = new SseFrameParser();
    expect(p.push(": keep-alive\n\n")).toEqual([]);
  });

  it("buffers partial frames across chunks", () => {
    const p = new SseFrameParser();
    expect(p.push("data: {"))
      .toEqual([]);
    expect(p.push('"id":"a"}\n\n')).toEqual(['{"id":"a"}']);
  });

  it("handles multiple frames and CRLF separators", () => {
    const p = new SseFrameParser();
    expect(p.push("data: one\r\n\r\ndata: two\r\n\r\n")).toEqual(["one", "two"]);
  });

  it("joins multi-line data fields", () => {
    const p = new SseFrameParser();
    expect(p.push("data: a\ndata: b\n\n")).toEqual(["a\nb"]);
  });
});

/** A fetch stub whose body is a stream the test drives frame-by-frame. */
function streamingFetch() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response);
  return {
    fetchImpl,
    push: (frame: string) => controller.enqueue(new TextEncoder().encode(frame)),
    close: () => controller.close(),
  };
}

function frame(event: Partial<WorldEvent>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe("WorldEventStream", () => {
  it("delivers events and reports open status", async () => {
    const net = streamingFetch();
    const events: WorldEvent[] = [];
    const stream = new WorldEventStream({
      baseUrl: "/world/v1",
      onEvent: (e) => events.push(e),
      onStatus: () => {},
      fetchImpl: net.fetchImpl,
    });
    stream.start();
    await flush();
    net.push(frame({ id: "a", worldsequence: "1" }));
    net.push(frame({ id: "b", worldsequence: "2" }));
    await flush();
    stream.stop();

    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("drops catch-up overlap using an advancing sequence floor (id-distinct dupes and older seqs)", async () => {
    const net = streamingFetch();
    const events: WorldEvent[] = [];
    let floor = 0n;
    const stream = new WorldEventStream({
      baseUrl: "/world/v1",
      getSeqFloor: () => floor,
      // Simulate the app advancing the shared floor as it ingests.
      onEvent: (e) => {
        events.push(e);
        const s = BigInt(e.worldsequence as string);
        if (s > floor) floor = s;
      },
      onStatus: () => {},
      fetchImpl: net.fetchImpl,
    });
    stream.start();
    await flush();
    net.push(frame({ id: "a", worldsequence: "5" }));
    net.push(frame({ id: "dup", worldsequence: "5" })); // <= floor → dropped
    net.push(frame({ id: "old", worldsequence: "3" })); // older → dropped
    net.push(frame({ id: "c", worldsequence: "6" }));
    await flush();
    stream.stop();

    expect(events.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("compares sequences as BigInt (10 > 9; handles values beyond 2^53)", async () => {
    const net = streamingFetch();
    const events: WorldEvent[] = [];
    const stream = new WorldEventStream({
      baseUrl: "/world/v1",
      getSeqFloor: () => 9n, // fixed floor
      onEvent: (e) => events.push(e),
      onStatus: () => {},
      fetchImpl: net.fetchImpl,
    });
    stream.start();
    await flush();
    net.push(frame({ id: "nine", worldsequence: "9" })); // 9 <= 9 → dropped (string "9" would sort after "10")
    net.push(frame({ id: "ten", worldsequence: "10" })); // 10 > 9 → delivered
    net.push(frame({ id: "huge", worldsequence: "90071992547409910" })); // > 2^53 → delivered
    await flush();
    stream.stop();

    expect(events.map((e) => e.id)).toEqual(["ten", "huge"]);
  });

  it("connects using the current resume cursor from getAfter", async () => {
    const net = streamingFetch();
    let cursor: string | undefined = "CURSOR-1";
    const stream = new WorldEventStream({
      baseUrl: "/world/v1",
      getAfter: () => cursor,
      onEvent: () => {},
      onStatus: () => {},
      fetchImpl: net.fetchImpl,
    });
    stream.start();
    await flush();
    stream.stop();

    expect(net.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/stream?after=CURSOR-1"),
      expect.anything(),
    );
    void cursor;
  });

  it("reconnects with backoff after an error", async () => {
    vi.useFakeTimers();
    const good = streamingFetch();
    const calls: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async (url: string) => {
        calls.push(url);
        throw new Error("boom");
      })
      .mockImplementationOnce(async (url: string) => {
        calls.push(url);
        return good.fetchImpl();
      });

    const statuses: StreamStatus[] = [];
    const stream = new WorldEventStream({
      baseUrl: "/world/v1",
      getAfter: () => "CUR",
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 10,
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(0); // first (failing) connect
    expect(statuses).toContain("offline");
    await vi.advanceTimersByTimeAsync(50); // let backoff fire the reconnect
    stream.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Reconnect resumes from the same bounded cursor (never the origin).
    expect(calls[0]).toContain("/stream?after=CUR");
    expect(calls[1]).toContain("/stream?after=CUR");
    expect(statuses).toContain("reconnecting");
    vi.useRealTimers();
  });
});
