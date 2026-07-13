import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { useEventFeed } from "../hooks/useEventFeed";
import { makeEvent } from "./fixtures";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("useEventFeed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("crawls the forward event feed and dedupes by id", async () => {
    const e1 = makeEvent({ id: "e1", worldsequence: "1" });
    const e2 = makeEvent({ id: "e2", worldsequence: "2" });
    const e3 = makeEvent({ id: "e3", worldsequence: "3" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/stream")) {
          // An open, silent stream keeps the connection "open" without emitting events.
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
        }
        if (url.includes("after=2")) {
          // Second page repeats e2 (duplicate id) to exercise dedupe.
          return jsonResponse({ items: [e2, e3], nextCursor: null });
        }
        return jsonResponse({ items: [e1, e2], nextCursor: "2" });
      }),
    );

    // Render under StrictMode so double-invoked updaters would surface impure merge logic
    // (a real bug this guards against: dedupe state must not be mutated inside a setState updater).
    const { result, unmount } = renderHook(() => useEventFeed("http://test.local/world/v1"), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.totalRetained).toBe(3);
    // Newest first, deduped.
    expect(result.current.visible.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(result.current.latestWorldSequence).toBe("3");

    unmount();
  });
});
