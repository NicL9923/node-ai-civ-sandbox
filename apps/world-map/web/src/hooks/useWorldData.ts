import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type WorldClient } from "../api/client";
import type { Civilization, Relationship } from "../api/types";
import { pairKey } from "../domain/relationships";
import { crawlPaged, DEFAULT_PAGE_LIMIT, PaginationError } from "../domain/pagination";

const PAGE_LIMIT = DEFAULT_PAGE_LIMIT;
const DEFAULT_POLL_MS = 30_000;

export type LoadStatus = "loading" | "ready" | "error";

export interface WorldData {
  civs: Map<string, Civilization>;
  /** Civ ids in a stable display order. */
  civIds: string[];
  relationships: Map<string, Relationship>;
  status: LoadStatus;
  error: string | null;
  /** True once the first successful load has completed (for background refreshes). */
  loaded: boolean;
  refresh: () => void;
}

interface Snapshot {
  civs: Map<string, Civilization>;
  civIds: string[];
  relationships: Map<string, Relationship>;
}

/**
 * Fully crawl a paginated public read endpoint into a complete list. Cursor cycles and cap
 * overruns throw (via crawlPaged); a capped result also throws here, because the civ/relationship
 * SNAPSHOT must be complete-and-swap — never a silently-partial world.
 */
async function crawlAll<T>(
  client: WorldClient,
  path: "/civilizations" | "/relationships",
  signal: AbortSignal,
): Promise<T[]> {
  const result = await crawlPaged<T>(async (after, sig) => {
    const { data, error } = await client.GET(path, {
      params: { query: { after, limit: PAGE_LIMIT } },
      signal: sig,
    });
    if (error || !data) throw new Error(`${path} request failed`);
    return { items: (data.items ?? []) as T[], nextCursor: data.nextCursor };
  }, signal);

  if (result.capped) {
    throw new PaginationError(`${path} exceeded the page cap before completing`);
  }
  return result.items;
}

function buildSnapshot(civList: Civilization[], relList: Relationship[]): Snapshot {
  const civs = new Map<string, Civilization>();
  for (const c of civList) civs.set(c.civId, c);

  const civIds = [...civs.values()]
    .sort((a, b) => (a.displayName ?? a.civId).localeCompare(b.displayName ?? b.civId) || a.civId.localeCompare(b.civId))
    .map((c) => c.civId);

  const relationships = new Map<string, Relationship>();
  for (const r of relList) {
    if (r.pair?.civA && r.pair?.civB) {
      relationships.set(pairKey(r.pair.civA, r.pair.civB), r);
    }
  }
  return { civs, civIds, relationships };
}

/**
 * Loads the world's civilizations and relationships in parallel, normalizes them into lookup
 * maps, and refreshes gently on an interval. A monotonic request id guards against stale
 * responses overwriting newer data (e.g. an in-flight load landing after a manual refresh).
 */
export function useWorldData(baseUrl?: string, pollMs = DEFAULT_POLL_MS): WorldData {
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => buildSnapshot([], []));
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const requestId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (background: boolean) => {
      const id = ++requestId.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (!background) setStatus((s) => (s === "ready" ? s : "loading"));
      try {
        const [civList, relList] = await Promise.all([
          crawlAll<Civilization>(client, "/civilizations", controller.signal),
          crawlAll<Relationship>(client, "/relationships", controller.signal),
        ]);
        if (id !== requestId.current) return; // superseded
        setSnapshot(buildSnapshot(civList, relList));
        setStatus("ready");
        setError(null);
        setLoaded(true);
      } catch (err) {
        if (controller.signal.aborted || id !== requestId.current) return;
        // Keep the last good snapshot on a background failure; only hard-fail the first load.
        setError("Couldn't reach the World. Retrying automatically.");
        setStatus((s) => (loaded ? s : "error"));
      }
    },
    [client, loaded],
  );

  useEffect(() => {
    void load(false);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  const refresh = useCallback(() => void load(true), [load]);

  return {
    civs: snapshot.civs,
    civIds: snapshot.civIds,
    relationships: snapshot.relationships,
    status,
    error,
    loaded,
    refresh,
  };
}
