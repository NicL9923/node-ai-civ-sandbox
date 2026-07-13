import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useEventFeed } from "../hooks/useEventFeed";
import { makeEvent } from "./fixtures";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A controllable SSE stream Response. */
function makeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(stream, { status: 200 }),
    push: (evt: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(evt)}\n\n`)),
  };
}

const BASE = "http://test.local/world/v1";
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe("useEventFeed", () => {
  it("crawls the forward event feed and dedupes by id", async () => {
    const e1 = makeEvent({ id: "e1", worldsequence: "1" });
    const e2 = makeEvent({ id: "e2", worldsequence: "2" });
    const e3 = makeEvent({ id: "e3", worldsequence: "3" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/stream")) return new Response(new ReadableStream(), { status: 200 });
        if (url.includes("after=2")) return json({ items: [e2, e3], nextCursor: null });
        return json({ items: [e1, e2], nextCursor: "2" });
      }),
    );

    const { result, unmount } = renderHook(() => useEventFeed(BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.totalRetained).toBe(3);
    expect(result.current.visible.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(result.current.latestWorldSequence).toBe("3");
    unmount();
  });

  it("resumes the live stream from the bounded cursor and drops overlap via the floor", async () => {
    const e1 = makeEvent({ id: "e1", worldsequence: "1" });
    const e2 = makeEvent({ id: "e2", worldsequence: "2" });
    const e3 = makeEvent({ id: "e3", worldsequence: "3" });
    const stream = makeStream();
    const streamUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/stream")) {
          streamUrls.push(url);
          return stream.response;
        }
        // Two pages so the crawl yields a bounded resume cursor ("c1").
        if (url.includes("after=c1")) return json({ items: [e3], nextCursor: null });
        return json({ items: [e1, e2], nextCursor: "c1" });
      }),
    );

    const { result, unmount } = renderHook(() => useEventFeed(BASE));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.connection).toBe("open"));

    // The stream resumes from the crawl's bounded resume cursor, not the origin.
    expect(streamUrls[0]).toContain("/stream?after=c1");

    // Server replays the overlap (e3, already ingested → dropped by floor) then new events.
    await act(async () => {
      stream.push(e3); // worldsequence 3 <= floor 3 → dropped
      stream.push(makeEvent({ id: "e4", worldsequence: "4" }));
      stream.push(makeEvent({ id: "e5", worldsequence: "5" }));
      await flush();
    });

    expect(result.current.visible.map((e) => e.id)).toEqual(["e5", "e4", "e3", "e2", "e1"]);
    expect(result.current.totalRetained).toBe(5); // no duplicate e3
    unmount();
  });

  it("refresh polls forward from the saved cursor (not the origin) and merges new events", async () => {
    const e1 = makeEvent({ id: "e1", worldsequence: "1" });
    const e2 = makeEvent({ id: "e2", worldsequence: "2" });
    const e3 = makeEvent({ id: "e3", worldsequence: "3" });
    const e6 = makeEvent({ id: "e6", worldsequence: "6" });
    const pollCursors: string[] = [];
    let e6HasArrived = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/stream")) return new Response(new ReadableStream(), { status: 200 });
        if (url.includes("after=c1")) {
          pollCursors.push("c1");
          // Overlap e3 (dropped by id) always; e6 only appears after the refresh point.
          return json({ items: e6HasArrived ? [e3, e6] : [e3], nextCursor: null });
        }
        return json({ items: [e1, e2], nextCursor: "c1" });
      }),
    );

    const { result, unmount } = renderHook(() => useEventFeed(BASE));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.totalRetained).toBe(3); // e1,e2,e3 from the initial crawl

    e6HasArrived = true;
    await act(async () => {
      result.current.refresh();
      await flush();
    });

    // Poll requested /events with after=c1 (forward from saved cursor), never the origin.
    expect(pollCursors).toContain("c1");
    expect(result.current.visible.map((e) => e.id)).toEqual(["e6", "e3", "e2", "e1"]);
    expect(result.current.totalRetained).toBe(4); // e3 not duplicated
    unmount();
  });
});
