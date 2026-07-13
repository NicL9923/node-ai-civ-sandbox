// Guarded cursor pagination shared by the civ/relationship snapshot crawl and the event feed.
// Detects cursor cycles and enforces page/item caps so a misbehaving or unbounded feed can never
// spin forever or exhaust memory. The World's cursor is opaque — we only ever echo cursors the
// server returned, never construct them.

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGES = 100;
export const MAX_ITEMS = 20_000;

/** Thrown on a cursor cycle or when a hard cap is exceeded. */
export class PaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationError";
  }
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string | null;
}

export type PageFetcher<T> = (after: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>;

export interface CrawlResult<T> {
  items: T[];
  /**
   * A safe, bounded opaque resume cursor:
   * - complete crawl → the cursor USED to request the FINAL page (re-fetching from it overlaps
   *   only that last page); `undefined` when the first page was already the last.
   * - capped crawl → the still-pending `nextCursor` (resume forward from there).
   */
  resumeCursor?: string;
  /** True if the crawl stopped at a page/item cap while a non-null nextCursor was still pending. */
  capped: boolean;
}

export interface CrawlOptions {
  maxPages?: number;
  maxItems?: number;
  /** Opaque cursor to start the crawl from (echoed to the first page request). Omit to start at the beginning. */
  startAfter?: string;
}

/**
 * Crawl a forward-only cursor feed to its end (or a cap), accumulating items.
 * Throws `PaginationError` on a cursor cycle; returns `capped: true` (never throws) when a cap is
 * hit with more pages pending, so the caller decides whether a partial result is acceptable.
 */
export async function crawlPaged<T>(
  fetchPage: PageFetcher<T>,
  signal: AbortSignal,
  options: CrawlOptions = {},
): Promise<CrawlResult<T>> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxItems = options.maxItems ?? MAX_ITEMS;

  const items: T[] = [];
  const seenCursors = new Set<string>();
  if (options.startAfter) seenCursors.add(options.startAfter);
  let after: string | undefined = options.startAfter; // cursor used to request the current page
  let requestCursor: string | undefined; // cursor used to request the most-recent page

  for (let page = 0; page < maxPages; page++) {
    requestCursor = after;
    const { items: pageItems, nextCursor } = await fetchPage(after, signal);
    if (pageItems && pageItems.length) items.push(...pageItems);

    if (items.length > maxItems) {
      throw new PaginationError(`pagination exceeded ${maxItems} items`);
    }

    if (!nextCursor) {
      // Complete. Resume from the cursor that fetched the final page (bounded one-page overlap).
      return { items, resumeCursor: requestCursor, capped: false };
    }

    if (nextCursor === after || seenCursors.has(nextCursor)) {
      throw new PaginationError("pagination cursor cycle detected");
    }
    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  // Hit the page cap with a non-null nextCursor still pending.
  return { items, resumeCursor: after, capped: true };
}
