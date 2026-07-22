import { useCallback, useEffect, useReducer, useRef } from "react";
import { nextCursor } from "../domain/social";

export type CursorListStatus = "loading" | "ready" | "error";

export interface CursorListState<T> {
  items: T[];
  status: CursorListStatus;
  error: string | null;
  /** A further page may exist (server returned a non-null cursor and the cap is not reached). */
  hasMore: boolean;
  /** True while a "load more" page (not the first snapshot) is in flight. */
  loadingMore: boolean;
  loadMore: () => void;
  /** Discard the current snapshot and re-open a fresh one from the newest state. */
  reload: () => void;
  /** Imperatively transform the loaded items (used by live SSE merge / tombstone / count patch). */
  applyPatch: (fn: (items: T[]) => T[]) => void;
}

interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

interface Internal<T> {
  items: T[];
  status: CursorListStatus;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
}

type Action<T> =
  | { type: "reset" }
  | { type: "first"; items: T[]; serverHasMore: boolean; getId: (t: T) => string; cap: number }
  | { type: "more-start" }
  | { type: "more"; items: T[]; serverHasMore: boolean; getId: (t: T) => string; cap: number }
  | { type: "error"; message: string; first: boolean }
  | { type: "patch"; fn: (items: T[]) => T[] };

function dedupeCap<T>(base: T[], incoming: T[], getId: (t: T) => string, cap: number): T[] {
  const ids = new Set(base.map(getId));
  const additions: T[] = [];
  for (const it of incoming) {
    const id = getId(it);
    if (ids.has(id)) continue;
    ids.add(id);
    additions.push(it);
  }
  const merged = additions.length ? base.concat(additions) : base;
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

function reducer<T>(state: Internal<T>, action: Action<T>): Internal<T> {
  switch (action.type) {
    case "reset":
      return { items: [], status: "loading", error: null, hasMore: false, loadingMore: false };
    case "first": {
      const items = dedupeCap([], action.items, action.getId, action.cap);
      return {
        items,
        status: "ready",
        error: null,
        hasMore: action.serverHasMore && items.length < action.cap,
        loadingMore: false,
      };
    }
    case "more-start":
      return { ...state, loadingMore: true };
    case "more": {
      const items = dedupeCap(state.items, action.items, action.getId, action.cap);
      return {
        ...state,
        items,
        hasMore: action.serverHasMore && items.length < action.cap,
        loadingMore: false,
      };
    }
    case "error":
      return action.first
        ? { items: [], status: "error", error: action.message, hasMore: false, loadingMore: false }
        : { ...state, status: "ready", error: action.message, loadingMore: false };
    case "patch":
      return { ...state, items: action.fn(state.items) };
  }
}

/**
 * Generic guarded cursor-pagination over one immutable World snapshot. The first fetch (no cursor)
 * opens the snapshot; `loadMore` advances within it. Guards against cursor cycles, caps retained
 * items, dedupes by id, and aborts in-flight requests when the `resetKey` changes or on unmount —
 * so a stale response can never overwrite a newer snapshot. Live/count updates go through
 * `applyPatch`; a `reload` re-opens a fresh snapshot without corrupting an in-flight traversal.
 */
export function useCursorList<T>(params: {
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<PageResult<T>>;
  getId: (item: T) => string;
  /** Snapshot identity; when it changes the list resets and re-fetches. Empty string = disabled. */
  resetKey: string;
  cap?: number;
}): CursorListState<T> {
  const { getId, resetKey } = params;
  const cap = params.cap ?? 500;
  const enabled = resetKey !== "";

  const [state, dispatch] = useReducer(reducer<T>, {
    items: [],
    status: "loading",
    error: null,
    hasMore: false,
    loadingMore: false,
  });

  // Latest fetchPage/getId without retriggering the snapshot effect on every render.
  const fetchPageRef = useRef(params.fetchPage);
  fetchPageRef.current = params.fetchPage;
  const getIdRef = useRef(getId);
  getIdRef.current = getId;

  const seenCursorsRef = useRef(new Set<string>());
  const nextCursorRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  // Monotonic snapshot generation; a response from a superseded snapshot is dropped.
  const genRef = useRef(0);
  // The snapshot identity the current reducer state belongs to. When `resetKey` changes, the
  // reset effect hasn't run yet during this render, so the reducer still holds the PREVIOUS
  // snapshot's items (possibly a different item type). Track the applied key so we can surface an
  // empty/loading view for the one render before the reset lands — preventing consumers from
  // rendering stale, wrong-typed items on a tab/identity switch.
  const appliedKeyRef = useRef(resetKey);
  const isFresh = appliedKeyRef.current === resetKey;

  const openSnapshot = useCallback(() => {
    abortRef.current?.abort();
    const gen = ++genRef.current;
    seenCursorsRef.current = new Set<string>();
    nextCursorRef.current = undefined;
    dispatch({ type: "reset" });
    if (!enabled) {
      inFlightRef.current = false;
      return;
    }
    inFlightRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    fetchPageRef
      .current(undefined, controller.signal)
      .then((page) => {
        if (gen !== genRef.current) return;
        const step = nextCursor(seenCursorsRef.current, undefined, page.nextCursor);
        nextCursorRef.current = step.done ? undefined : step.cursor;
        dispatch({ type: "first", items: page.items, serverHasMore: !step.done, getId: getIdRef.current, cap });
      })
      .catch((err) => {
        if (gen !== genRef.current || (err instanceof DOMException && err.name === "AbortError")) return;
        dispatch({ type: "error", message: "Couldn't load from World Wire.", first: true });
      })
      .finally(() => {
        if (gen === genRef.current) inFlightRef.current = false;
      });
  }, [cap, enabled]);

  // (Re)open the snapshot whenever the identity changes. Advancing `appliedKeyRef` here (in the
  // effect keyed on `resetKey`) — rather than inside the `openSnapshot` callback, which is memoized
  // on a stale `resetKey` — is what lets the fresh-guard release once the new snapshot is applied.
  useEffect(() => {
    appliedKeyRef.current = resetKey;
    openSnapshot();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const loadMore = useCallback(() => {
    if (!enabled || inFlightRef.current) return;
    const cursor = nextCursorRef.current;
    if (cursor === undefined) return;
    const gen = genRef.current;
    inFlightRef.current = true;
    dispatch({ type: "more-start" });
    const controller = new AbortController();
    abortRef.current = controller;
    fetchPageRef
      .current(cursor, controller.signal)
      .then((page) => {
        if (gen !== genRef.current) return;
        const step = nextCursor(seenCursorsRef.current, cursor, page.nextCursor);
        nextCursorRef.current = step.done ? undefined : step.cursor;
        dispatch({ type: "more", items: page.items, serverHasMore: !step.done, getId: getIdRef.current, cap });
      })
      .catch((err) => {
        if (gen !== genRef.current || (err instanceof DOMException && err.name === "AbortError")) return;
        dispatch({ type: "error", message: "Couldn't load more from World Wire.", first: false });
      })
      .finally(() => {
        if (gen === genRef.current) inFlightRef.current = false;
      });
  }, [cap, enabled]);

  const reload = useCallback(() => openSnapshot(), [openSnapshot]);
  const applyPatch = useCallback((fn: (items: T[]) => T[]) => dispatch({ type: "patch", fn }), []);

  // Until the reset effect for a changed identity lands, present an empty loading view so consumers
  // never see the previous snapshot's (possibly differently-typed) items.
  return {
    items: isFresh ? state.items : [],
    status: isFresh ? state.status : "loading",
    error: isFresh ? state.error : null,
    hasMore: isFresh ? state.hasMore : false,
    loadingMore: isFresh ? state.loadingMore : false,
    loadMore,
    reload,
    applyPatch,
  };
}
