import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "../api/client";
import type { SocialPost } from "../api/social";
import type { WorldEvent } from "../api/types";
import { classifySocialEvent, mergePosts, tombstonePost } from "../domain/social";
import { useCursorList, type CursorListState } from "./useCursorList";
import { usePostRefetcher } from "./usePostRefetcher";

/** Server default page is 25; we request 50 (max 100) to fill the panel with fewer round trips. */
export const SOCIAL_PAGE_LIMIT = 50;
export const SOCIAL_MAX_RETAINED = 500;

export interface SocialFeed extends Pick<CursorListState<SocialPost>, "status" | "error" | "hasMore" | "loadingMore" | "loadMore"> {
  posts: SocialPost[];
  /** postIds that streamed in live after this snapshot opened (for a subtle "new" marker). */
  liveIds: ReadonlySet<string>;
  /** Discard the snapshot and re-open a fresh newest one (clears the live markers). */
  refresh: () => void;
}

/**
 * The global World Wire feed: an immutable newest-first snapshot with guarded cursor "load more",
 * plus live reconciliation from the shared SSE. New posts prepend to a live head (deduped, ordered
 * by worldsequence) without corrupting the active older-page traversal; likes/replies trigger a
 * targeted count refetch; tombstones are applied in place. `refresh` re-opens a fresh snapshot.
 */
export function useSocialFeed(
  subscribe: (listener: (event: WorldEvent) => void) => () => void,
  baseUrl?: string,
): SocialFeed {
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);

  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const { data, error } = await client.GET("/social/feed", {
        params: { query: { cursor, limit: SOCIAL_PAGE_LIMIT } },
        signal,
      });
      if (error || !data) throw new Error("social feed request failed");
      return { items: data.items ?? [], nextCursor: data.nextCursor ?? null };
    },
    [client],
  );

  const list = useCursorList<SocialPost>({
    fetchPage,
    getId: (p) => p.postId,
    resetKey: "social-feed",
    cap: SOCIAL_MAX_RETAINED,
  });

  const { applyPatch } = list;
  const { request: refetch } = usePostRefetcher(client, applyPatch);

  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(() => new Set());

  // Read current items inside the (stable) live listener without re-subscribing each render.
  const itemsRef = useRef(list.items);
  itemsRef.current = list.items;
  const isDisplayed = (postId: string) => itemsRef.current.some((p) => p.postId === postId);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      const signal = classifySocialEvent(event);
      if (!signal) return;
      switch (signal.kind) {
        case "post-created":
        case "reply-created": {
          applyPatch((items) => mergePosts(items, [signal.post], "desc", SOCIAL_MAX_RETAINED));
          setLiveIds((prev) => {
            const next = new Set(prev);
            next.add(signal.post.postId);
            return next;
          });
          const parentId = signal.post.parentPostId;
          if (parentId && isDisplayed(parentId)) refetch(parentId);
          break;
        }
        case "reaction-changed": {
          if (isDisplayed(signal.postId)) refetch(signal.postId);
          break;
        }
        case "post-tombstoned": {
          applyPatch((items) =>
            items.map((p) => (p.postId === signal.postId ? tombstonePost(p, signal.tombstonedAt) : p)),
          );
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, applyPatch, refetch]);

  const refresh = useCallback(() => {
    setLiveIds(new Set());
    list.reload();
  }, [list]);

  return {
    posts: list.items,
    status: list.status,
    error: list.error,
    hasMore: list.hasMore,
    loadingMore: list.loadingMore,
    loadMore: list.loadMore,
    liveIds,
    refresh,
  };
}
