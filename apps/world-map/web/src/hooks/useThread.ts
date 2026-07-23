import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "../api/client";
import type { SocialPost } from "../api/social";
import type { WorldEvent } from "../api/types";
import { classifySocialEvent, mergePosts, tombstonePost } from "../domain/social";
import { useCursorList, type CursorListStatus } from "./useCursorList";
import { usePostRefetcher } from "./usePostRefetcher";
import { SOCIAL_MAX_RETAINED, SOCIAL_PAGE_LIMIT } from "./useSocialFeed";

export interface Thread {
  /** The focal post the deep link addresses (highlighted within the conversation). */
  focal: SocialPost | null;
  focalStatus: CursorListStatus;
  focalError: string | null;
  /** The conversation, oldest first (root → replies), including the focal post. */
  posts: SocialPost[];
  status: CursorListStatus;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

/**
 * One conversation snapshot addressed by any member post id. The `/thread` endpoint resolves the
 * conversation root and returns posts oldest-first; "load more" advances forward within the same
 * snapshot. Live replies to this conversation append (deduped, ordered), likes trigger a targeted
 * count refetch, and tombstones are applied in place — to both the thread list and the focal post.
 */
export function useThread(
  postId: string,
  subscribe: (listener: (event: WorldEvent) => void) => () => void,
  baseUrl?: string,
): Thread {
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);
  const rootIdRef = useRef<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const { data, error } = await client.GET("/social/posts/{postId}/thread", {
        params: { path: { postId }, query: { cursor, limit: SOCIAL_PAGE_LIMIT } },
        signal,
      });
      if (error || !data) throw new Error("thread request failed");
      rootIdRef.current = data.conversationRootPostId ?? rootIdRef.current;
      return { items: data.items ?? [], nextCursor: data.nextCursor ?? null };
    },
    [client, postId],
  );

  const list = useCursorList<SocialPost>({
    fetchPage,
    getId: (p) => p.postId,
    resetKey: postId ? `thread:${postId}` : "",
    cap: SOCIAL_MAX_RETAINED,
  });
  const { applyPatch } = list;
  const { request: refetch } = usePostRefetcher(client, applyPatch);

  // Focal post — fetched directly so the header renders even if the post is deep in a big thread.
  const [focal, setFocal] = useState<SocialPost | null>(null);
  const [focalStatus, setFocalStatus] = useState<CursorListStatus>("loading");
  const [focalError, setFocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!postId) return;
    const controller = new AbortController();
    setFocal(null);
    setFocalStatus("loading");
    setFocalError(null);
    client
      .GET("/social/posts/{postId}", { params: { path: { postId } }, signal: controller.signal })
      .then(({ data, error }) => {
        if (controller.signal.aborted) return;
        if (error || !data) {
          setFocalStatus("error");
          setFocalError("Couldn't load this post.");
          return;
        }
        setFocal(data as SocialPost);
        setFocalStatus("ready");
      })
      .catch((err) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        setFocalStatus("error");
        setFocalError("Couldn't load this post.");
      });
    return () => controller.abort();
  }, [client, postId]);

  const itemsRef = useRef(list.items);
  itemsRef.current = list.items;
  const focalRef = useRef(focal);
  focalRef.current = focal;
  const isDisplayed = (id: string) =>
    itemsRef.current.some((p) => p.postId === id) || focalRef.current?.postId === id;

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      const signal = classifySocialEvent(event);
      if (!signal) return;
      switch (signal.kind) {
        case "reply-created": {
          if (rootIdRef.current && signal.post.conversationRootPostId === rootIdRef.current) {
            applyPatch((items) => mergePosts(items, [signal.post], "asc", SOCIAL_MAX_RETAINED));
            const parentId = signal.post.parentPostId;
            if (parentId && isDisplayed(parentId)) refetch(parentId);
          }
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
          setFocal((f) => (f && f.postId === signal.postId ? tombstonePost(f, signal.tombstonedAt) : f));
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, applyPatch, refetch]);

  const refresh = useCallback(() => list.reload(), [list]);

  return {
    focal,
    focalStatus,
    focalError,
    posts: list.items,
    status: list.status,
    error: list.error,
    hasMore: list.hasMore,
    loadingMore: list.loadingMore,
    loadMore: list.loadMore,
    refresh,
  };
}
