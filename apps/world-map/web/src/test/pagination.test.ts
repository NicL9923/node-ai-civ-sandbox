import { describe, expect, it } from "vitest";
import { crawlPaged, PaginationError, type CursorPage } from "../domain/pagination";

const signal = new AbortController().signal;

/** Build a fetcher from a map of request-cursor -> page. */
function fetcherFrom(pages: Record<string, CursorPage<number>>) {
  const calls: (string | undefined)[] = [];
  const fetch = async (after: string | undefined) => {
    calls.push(after);
    const key = after ?? "";
    if (!(key in pages)) throw new Error(`unexpected cursor: ${after}`);
    return pages[key];
  };
  return { fetch, calls };
}

describe("crawlPaged", () => {
  it("accumulates items across multiple pages and returns the final-page cursor as resume", async () => {
    const { fetch } = fetcherFrom({
      "": { items: [1, 2], nextCursor: "c1" },
      c1: { items: [3, 4], nextCursor: "c2" },
      c2: { items: [5], nextCursor: null },
    });
    const result = await crawlPaged(fetch, signal);
    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.capped).toBe(false);
    // Final page was requested with cursor "c2" → bounded resume overlaps only that last page.
    expect(result.resumeCursor).toBe("c2");
  });

  it("returns an undefined resume cursor for a single-page feed", async () => {
    const { fetch } = fetcherFrom({ "": { items: [1], nextCursor: null } });
    const result = await crawlPaged(fetch, signal);
    expect(result.items).toEqual([1]);
    expect(result.resumeCursor).toBeUndefined();
  });

  it("throws on a repeated (cyclic) cursor", async () => {
    const { fetch } = fetcherFrom({
      "": { items: [1], nextCursor: "c1" },
      c1: { items: [2], nextCursor: "c1" }, // self-loop
    });
    await expect(crawlPaged(fetch, signal)).rejects.toBeInstanceOf(PaginationError);
  });

  it("throws on a cursor that revisits an earlier page", async () => {
    const { fetch } = fetcherFrom({
      "": { items: [1], nextCursor: "c1" },
      c1: { items: [2], nextCursor: "c2" },
      c2: { items: [3], nextCursor: "c1" }, // back-edge cycle
    });
    await expect(crawlPaged(fetch, signal)).rejects.toBeInstanceOf(PaginationError);
  });

  it("caps at maxPages and returns the pending cursor (not throwing)", async () => {
    const fetch = async (after: string | undefined): Promise<CursorPage<number>> => ({
      items: [1],
      nextCursor: `${after ?? "start"}-next`,
    });
    const result = await crawlPaged(fetch, signal, { maxPages: 3 });
    expect(result.capped).toBe(true);
    expect(result.resumeCursor).toBeDefined();
    expect(result.items).toHaveLength(3);
  });

  it("throws when the item cap is exceeded", async () => {
    const fetch = async (): Promise<CursorPage<number>> => ({
      items: [1, 2, 3, 4, 5],
      nextCursor: "more",
    });
    await expect(crawlPaged(fetch, signal, { maxItems: 3, maxPages: 100 })).rejects.toBeInstanceOf(
      PaginationError,
    );
  });

  it("starts from startAfter and reports it as resume for a single page", async () => {
    const { fetch, calls } = fetcherFrom({ c9: { items: [10], nextCursor: null } });
    const result = await crawlPaged(fetch, signal, { startAfter: "c9" });
    expect(calls[0]).toBe("c9");
    expect(result.items).toEqual([10]);
    expect(result.resumeCursor).toBe("c9");
  });

  it("detects a cycle back to startAfter", async () => {
    const { fetch } = fetcherFrom({
      c9: { items: [10], nextCursor: "c9" },
    });
    await expect(crawlPaged(fetch, signal, { startAfter: "c9" })).rejects.toBeInstanceOf(
      PaginationError,
    );
  });
});
