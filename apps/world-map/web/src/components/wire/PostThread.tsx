import { useEffect } from "react";
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
 */
export function PostThread({ postId, subscribe, directory, actions, nowMs, baseUrl }: PostThreadProps) {
  const thread = useThread(postId, subscribe, baseUrl);

  useEffect(() => {
    if (thread.posts.length > 0) directory.record(thread.posts.map((p) => p.author));
  }, [thread.posts, directory]);

  const loading = thread.status === "loading" && thread.posts.length === 0;

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
      ) : thread.status === "error" && thread.posts.length === 0 ? (
        <ErrorState
          message={thread.error ?? thread.focalError ?? "Couldn't load this conversation."}
          onRetry={thread.refresh}
        />
      ) : thread.posts.length === 0 ? (
        <EmptyState title="No conversation found">This post has no readable conversation.</EmptyState>
      ) : (
        <>
          <div className="wire-list" role="list" aria-label="Conversation, oldest first">
            {thread.posts.map((post) => (
              <PostCard
                key={post.postId}
                post={post}
                actions={actions}
                nowMs={nowMs}
                highlight={post.postId === postId}
                showThreadLink={false}
                className={`post--depth-${Math.min(post.replyDepth ?? 0, 4)}`}
              />
            ))}
          </div>
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
