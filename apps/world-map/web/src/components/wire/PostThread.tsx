import { useEffect, useRef } from "react";
import type { WorldEvent } from "../../api/types";
import { useThread } from "../../hooks/useThread";
import type { SocialDirectory } from "../../hooks/useSocialDirectory";
import { EmptyState, ErrorState, LoadingState } from "../common/StatusStates";
import { PostCard } from "./PostCard";
import type { WireActions } from "./types";

interface PostThreadProps {
  postId: string;
  subscribe: (listener: (event: WorldEvent) => void) => () => void;
  directory: SocialDirectory;
  actions: WireActions;
  nowMs: number;
  baseUrl?: string;
}

/**
 * A read-only conversation view, oldest-first (root → replies), with the deep-linked focal post
 * highlighted and replies indented by depth. New replies to this conversation append live; "Load
 * more" advances forward within the same immutable snapshot. Tombstoned posts keep their place.
 *
 * The deep-linked post may sit outside the loaded pages (or beyond the retained cap) of a large
 * conversation. To honor the deep link we always fetch the focal post directly (`thread.focal`):
 * when it is present in the paged conversation we simply highlight that row, and when it is not yet
 * loaded there we render it once in a clearly-labelled pinned "Focused post" section above the
 * chronological context — never duplicating it and never distorting the oldest-first order.
 */
export function PostThread({ postId, subscribe, directory, actions, nowMs, baseUrl }: PostThreadProps) {
  const thread = useThread(postId, subscribe, baseUrl);

  useEffect(() => {
    if (thread.posts.length > 0) directory.record(thread.posts.map((p) => p.author));
  }, [thread.posts, directory]);
  useEffect(() => {
    if (thread.focal) directory.record([thread.focal.author]);
  }, [thread.focal, directory]);

  const focalInPosts = thread.posts.some((p) => p.postId === postId);
  // Pin the focal post above the conversation only while it is loaded but not yet part of the paged
  // context. Once pagination reaches it (focalInPosts), the pinned section disappears with no
  // duplicate and the in-thread row carries the highlight.
  const pinnedFocal = thread.focal && !focalInPosts ? thread.focal : null;

  // Move focus/scroll to the focused article on route change (new postId) only — not on live
  // updates — so a deep link lands the reader on the linked post without repeatedly stealing focus.
  const focusedRef = useRef<HTMLDivElement | null>(null);
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (scrolledForRef.current === postId) return;
    if (focusedRef.current) {
      scrolledForRef.current = postId;
      focusedRef.current.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [postId, pinnedFocal, focalInPosts]);

  const loading = thread.status === "loading" && thread.posts.length === 0 && !pinnedFocal;

  return (
    <section className="wire-panel" aria-label="Conversation">
      <div className="wire-panel__head">
        <h2 className="panel__title" style={{ fontSize: "var(--t-lg)" }}>
          Conversation
        </h2>
        <button type="button" className="btn" onClick={thread.refresh}>
          Refresh
        </button>
      </div>

      {loading ? (
        <LoadingState label="Loading the conversation…" />
      ) : thread.status === "error" && thread.posts.length === 0 && !pinnedFocal ? (
        <ErrorState
          message={thread.error ?? thread.focalError ?? "Couldn't load this conversation."}
          onRetry={thread.refresh}
        />
      ) : thread.posts.length === 0 && !pinnedFocal ? (
        <EmptyState title="No conversation found">This post has no readable conversation.</EmptyState>
      ) : (
        <>
          {pinnedFocal ? (
            <div className="wire-focused" ref={focusedRef} role="group" aria-labelledby="wire-focused-title">
              <h3 id="wire-focused-title" className="wire-focused__title">
                Focused post
              </h3>
              <p className="panel__eyebrow">Linked directly. Its surrounding conversation is below.</p>
              <PostCard post={pinnedFocal} actions={actions} nowMs={nowMs} highlight showThreadLink={false} />
            </div>
          ) : null}

          {/* When the focal post errored and isn't in the loaded pages, keep the thread usable and
              note the linked post honestly rather than hiding the failure. */}
          {!pinnedFocal && !focalInPosts && thread.focalError ? (
            <p className="panel__empty" style={{ padding: "var(--s-3) var(--s-4)" }}>
              Couldn't load the linked post, but its conversation is shown below.
            </p>
          ) : null}

          {thread.posts.length > 0 ? (
            <div className="wire-list" role="list" aria-label="Conversation, oldest first">
              {thread.posts.map((post) => {
                const isFocal = post.postId === postId;
                return (
                  <div key={post.postId} ref={isFocal ? focusedRef : undefined}>
                    <PostCard
                      post={post}
                      actions={actions}
                      nowMs={nowMs}
                      highlight={isFocal}
                      showThreadLink={false}
                      className={`post--depth-${Math.min(post.replyDepth ?? 0, 4)}`}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          {thread.hasMore ? (
            <button
              type="button"
              className="btn btn--block"
              onClick={thread.loadMore}
              disabled={thread.loadingMore}
            >
              {thread.loadingMore ? "Loading…" : "Load more replies"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
