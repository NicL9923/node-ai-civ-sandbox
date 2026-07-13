import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, resolveBaseUrl, type WorldClient } from "../api/client";
import { WorldEventStream, type StreamStatus } from "../api/sse";
import type { WorldEvent } from "../api/types";
import { crawlPaged, DEFAULT_PAGE_LIMIT, type CrawlResult } from "../domain/pagination";

const PAGE_LIMIT = DEFAULT_PAGE_LIMIT;
const MAX_EVENT_PAGES = 20; // initial forward crawl bound (recent-history window)
const MAX_RETAINED = 500; // newest-N kept in memory
const INITIAL_VISIBLE = 40;
const REVEAL_STEP = 40;
const FALLBACK_POLL_MS = 10_000;

export type FeedStatus = "loading" | "ready" | "error";

export interface EventFeed {
  /** The currently revealed events, newest first. */
  visible: WorldEvent[];
  /** More retained-but-hidden older events exist. */
  hasOlder: boolean;
  loadOlder: () => void;
  status: FeedStatus;
  error: string | null;
  connection: StreamStatus;
  latestWorldSequence: string | null;
  totalRetained: number;
  refresh: () => void;
}

function toSeq(value: string | null | undefined): bigint {
  if (value == null) return -1n;
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

/** Merge new events into a newest-first buffer, deduping by id, capped to MAX_RETAINED.
 *  Pure: dedupes against the ids already in `current` (no external mutable state), so it is safe
 *  under React StrictMode's double-invoked updaters. */
function mergeEvents(current: WorldEvent[], incoming: WorldEvent[]): WorldEvent[] {
  const ids = new Set(current.map((e) => e.id));
  const additions: WorldEvent[] = [];
  for (const evt of incoming) {
    if (!evt.id || ids.has(evt.id)) continue;
    ids.add(evt.id);
    additions.push(evt);
  }
  if (additions.length === 0) return current;
  const next = current.concat(additions);
  next.sort((a, b) => {
    const sa = toSeq(a.worldsequence);
    const sb = toSeq(b.worldsequence);
    return sa < sb ? 1 : sa > sb ? -1 : 0; // descending (newest first)
  });
  return next.length > MAX_RETAINED ? next.slice(0, MAX_RETAINED) : next;
}

/**
 * Crawl `/events` forward from `after` (undefined = beginning), with cursor cycle + page/item cap
 * detection. Returns the events plus a bounded opaque resume cursor for the live stream / next poll.
 */
async function crawlEvents(
  client: WorldClient,
  after: string | undefined,
  signal: AbortSignal,
): Promise<CrawlResult<WorldEvent>> {
  return crawlPaged<WorldEvent>(
    async (cursor, sig) => {
      const { data, error } = await client.GET("/events", {
        params: { query: { after: cursor, limit: PAGE_LIMIT } },
        signal: sig,
      });
      if (error || !data) throw new Error("events request failed");
      return { items: (data.items ?? []) as WorldEvent[], nextCursor: data.nextCursor };
    },
    signal,
    { maxPages: MAX_EVENT_PAGES, startAfter: after },
  );
}

function maxSeq(events: WorldEvent[], floor: bigint): bigint {
  let m = floor;
  for (const e of events) {
    const s = toSeq(e.worldsequence);
    if (s > m) m = s;
  }
  return m;
}

/**
 * The world timeline data source. Crawls the forward-only `/events` feed for recent history,
 * streams live updates over SSE (deduped by id + worldsequence, reconnecting with backoff), and
 * polls `/events` as a backstop whenever the stream is not open. "Load older" reveals more of the
 * retained buffer client-side. All narrative is consumed as data and rendered as text elsewhere.
 */
export function useEventFeed(baseUrl?: string): EventFeed {
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);
  const base = useMemo(() => resolveBaseUrl(baseUrl), [baseUrl]);

  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<StreamStatus>("idle");

  const connectionRef = useRef<StreamStatus>("idle");
  // Bounded opaque resume cursor (from the crawl / advanced by the poll) echoed to the stream and
  // used as the poll's start — we never construct cursors from sequence numbers.
  const resumeCursorRef = useRef<string | undefined>(undefined);
  // Max worldsequence ingested so far — the stream's dedupe floor; advanced by crawl/poll/stream.
  const seqFloorRef = useRef<bigint>(0n);
  const abortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef(false);

  const ingest = useCallback((incoming: WorldEvent[]) => {
    if (incoming.length === 0) return;
    seqFloorRef.current = maxSeq(incoming, seqFloorRef.current);
    setEvents((cur) => mergeEvents(cur, incoming));
  }, []);

  // Backstop poll: page `/events` forward FROM the saved resume cursor (not the origin), with
  // cap/cycle detection, merge deduped, and advance the resume cursor. Used only when the stream
  // is not open. Guarded so overlapping ticks don't stack.
  const pollFromCursor = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const controller = new AbortController();
    try {
      const result = await crawlEvents(client, resumeCursorRef.current, controller.signal);
      ingest(result.items);
      if (result.resumeCursor !== undefined) resumeCursorRef.current = result.resumeCursor;
    } catch {
      /* transient (network) or a pagination cycle/cap; the interval will retry */
    } finally {
      pollingRef.current = false;
    }
  }, [client, ingest]);

  // Initial forward crawl (recent history) → seeds events, resume cursor, and sequence floor.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    crawlEvents(client, undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        ingest(result.items);
        resumeCursorRef.current = result.resumeCursor;
        setStatus("ready");
        setError(null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Couldn't load the world timeline.");
        setStatus("error");
      });
    return () => controller.abort();
  }, [client, ingest]);

  // Live SSE stream, started after the first load establishes the bootstrap resume cursor + floor.
  // While healthy, the stream advances the resume cursor from each frame's server `id:` (onCursor),
  // so a reconnect catches up only from the disconnect edge. The poll advances it while disconnected.
  // The floor + id dedupe remain as belt-and-suspenders against any re-delivered overlap.
  useEffect(() => {
    if (status !== "ready") return;
    const stream = new WorldEventStream({
      baseUrl: base,
      getAfter: () => resumeCursorRef.current,
      getSeqFloor: () => seqFloorRef.current,
      onCursor: (cursor) => {
        // Server-provided resume cursor for the last valid frame. Frames arrive in ascending order,
        // so this monotonically advances the resume point while the stream is healthy — a reconnect
        // then catches up only from the disconnect edge, not from mount.
        resumeCursorRef.current = cursor;
      },
      onEvent: (evt) => ingest([evt]),
      onStatus: (s) => {
        connectionRef.current = s;
        setConnection(s);
      },
    });
    stream.start();
    return () => stream.stop();
  }, [status, base, ingest]);

  // Backstop polling whenever the stream is not delivering (offline / reconnecting / idle).
  useEffect(() => {
    if (status !== "ready") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (connectionRef.current !== "open") void pollFromCursor();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [status, pollFromCursor]);

  const loadOlder = useCallback(() => setVisibleCount((c) => c + REVEAL_STEP), []);
  const refresh = useCallback(() => void pollFromCursor(), [pollFromCursor]);

  const visible = events.slice(0, visibleCount);
  const latestWorldSequence = events.length > 0 ? (events[0].worldsequence ?? null) : null;

  return {
    visible,
    hasOlder: visibleCount < events.length,
    loadOlder,
    status,
    error,
    connection,
    latestWorldSequence,
    totalRetained: events.length,
    refresh,
  };
}
