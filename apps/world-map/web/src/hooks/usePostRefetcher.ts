import { useCallback, useEffect, useRef } from "react";
import type { WorldClient } from "../api/client";
import type { SocialPost } from "../api/social";
import { replaceExistingPosts } from "../domain/social";

/**
 * Targeted, debounced, deduped reconciliation of eventually-consistent post projections. Social
 * reaction / reply / tombstone events carry ids but not authoritative counts, so when one touches a
 * currently-displayed post we refetch `GET /social/posts/{id}` (once per debounce window) and patch
 * only the already-present copies in place — never injecting a post that isn't displayed. In-flight
 * refetches are aborted on unmount so a stale response can't overwrite fresher state.
 */
export function usePostRefetcher(
  client: WorldClient,
  applyPatch: (fn: (items: SocialPost[]) => SocialPost[]) => void,
  debounceMs = 350,
): { request: (postId: string) => void } {
  const pendingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const applyRef = useRef(applyPatch);
  applyRef.current = applyPatch;
  const clientRef = useRef(client);
  clientRef.current = client;

  const flush = useCallback(async () => {
    timerRef.current = null;
    const ids = [...pendingRef.current];
    pendingRef.current.clear();
    if (ids.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const results = await Promise.all(
      ids.map(async (postId) => {
        try {
          const { data } = await clientRef.current.GET("/social/posts/{postId}", {
            params: { path: { postId } },
            signal: controller.signal,
          });
          return (data as SocialPost | undefined) ?? null;
        } catch {
          return null;
        }
      }),
    );
    if (controller.signal.aborted) return;
    const fresh = results.filter((p): p is SocialPost => p != null);
    if (fresh.length > 0) applyRef.current((items) => replaceExistingPosts(items, fresh));
  }, []);

  const request = useCallback(
    (postId: string) => {
      pendingRef.current.add(postId);
      if (timerRef.current == null) {
        timerRef.current = setTimeout(() => void flush(), debounceMs);
      }
    },
    [debounceMs, flush],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return { request };
}
