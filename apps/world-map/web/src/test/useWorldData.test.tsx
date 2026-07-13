import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorldData } from "../hooks/useWorldData";
import { makeCiv, makeRelationship } from "./fixtures";

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

const BASE = "http://test.local/world/v1";

afterEach(() => vi.unstubAllGlobals());

describe("useWorldData", () => {
  it("crawls civilizations across pages and relationships, then reports ready", async () => {
    const civA = makeCiv({ civId: "civ_a", displayName: "A" });
    const civB = makeCiv({ civId: "civ_b", displayName: "B" });
    const rel = makeRelationship({ pair: { civA: "civ_a", civB: "civ_b" } });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/civilizations")) {
          return url.includes("after=cc1")
            ? json({ items: [civB], nextCursor: null })
            : json({ items: [civA], nextCursor: "cc1" });
        }
        if (url.includes("/relationships")) return json({ items: [rel], nextCursor: null });
        return json({ items: [], nextCursor: null });
      }),
    );

    const { result, unmount } = renderHook(() => useWorldData(BASE, 0), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.civs.size).toBe(2);
    expect(result.current.relationships.size).toBe(1);
    expect(result.current.civIds).toEqual(["civ_a", "civ_b"]);
    unmount();
  });

  it("errors (no partial snapshot) when a cursor cycle is detected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/civilizations")) {
          // page 1 -> cc1, page 2 (after=cc1) -> cc1 again (cycle)
          return json({ items: [makeCiv()], nextCursor: "cc1" });
        }
        return json({ items: [], nextCursor: null });
      }),
    );

    const { result, unmount } = renderHook(() => useWorldData(BASE, 0));
    await waitFor(() => expect(result.current.status).toBe("error"));
    // Snapshot never swapped in a partial world.
    expect(result.current.civs.size).toBe(0);
    unmount();
  });

  it("preserves the last-good snapshot when a background refresh fails", async () => {
    const civA = makeCiv({ civId: "civ_a", displayName: "A" });
    let failNow = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (failNow) return new Response("nope", { status: 500 });
        if (url.includes("/civilizations")) return json({ items: [civA], nextCursor: null });
        return json({ items: [], nextCursor: null });
      }),
    );

    const { result, unmount } = renderHook(() => useWorldData(BASE, 0));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.civs.size).toBe(1);

    failNow = true;
    await act(async () => {
      result.current.refresh();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // Still ready with the last-good snapshot intact.
    expect(result.current.status).toBe("ready");
    expect(result.current.civs.size).toBe(1);
    unmount();
  });
});
