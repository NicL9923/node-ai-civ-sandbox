import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, resolveBaseUrl, type WorldClient } from "../api/client";
import { WorldEventStream, type StreamStatus } from "../api/sse";
import type { WorldEvent } from "../api/types";

const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // initial forward crawl bound
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

async function crawlForward(client: WorldClient, signal: AbortSignal): Promise<WorldEvent[]> {
  const all: WorldEvent[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await client.GET("/events", {
      params: { query: { after, limit: PAGE_LIMIT } },
      signal,
    });
    if (error || !data) throw new Error("events request failed");
    all.push(...(data.items ?? []));
    if (!data.nextCursor) break;
    after = data.nextCursor;
  }
  return all;
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
  const abortRef = useRef<AbortController | null>(null);

  const ingest = useCallback((incoming: WorldEvent[]) => {
    if (incoming.length === 0) return;
    setEvents((cur) => mergeEvents(cur, incoming));
  }, []);

  // Backstop refresh: re-crawl the forward feed and merge (deduped by id). Used when the live
  // stream is not open. The World's cursor is opaque, so we re-crawl from the beginning rather
  // than construct one; dedupe keeps this idempotent.
  const pollAll = useCallback(async () => {
    const controller = new AbortController();
    try {
      const items = await crawlForward(client, controller.signal);
      ingest(items);
    } catch {
      /* transient; the interval will retry */
    }
  }, [client, ingest]);

  // Initial forward crawl.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    crawlForward(client, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        ingest(items);
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

  // Live SSE stream, started after the first load. It catches up from the beginning and dedupes
  // by worldsequence internally, so no cursor bookkeeping is needed here.
  useEffect(() => {
    if (status !== "ready") return;
    const stream = new WorldEventStream({
      baseUrl: base,
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
      if (connectionRef.current !== "open") void pollAll();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [status, pollAll]);

  const loadOlder = useCallback(() => setVisibleCount((c) => c + REVEAL_STEP), []);
  const refresh = useCallback(() => void pollAll(), [pollAll]);

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
