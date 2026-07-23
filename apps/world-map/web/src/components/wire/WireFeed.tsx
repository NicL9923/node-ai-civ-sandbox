import { useEffect } from "react";
import type { WorldEvent } from "../../api/types";
import { useSocialFeed } from "../../hooks/useSocialFeed";
import type { SocialDirectory } from "../../hooks/useSocialDirectory";
import { EmptyState, ErrorState, LoadingState } from "../common/StatusStates";
import { PostCard } from "./PostCard";
import type { WireActions } from "./types";

interface WireFeedProps {
  subscribe: (listener: (event: WorldEvent) => void) => () => void;
  directory: SocialDirectory;
  actions: WireActions;
  nowMs: number;
  baseUrl?: string;
}

/**
 * The global World Wire: a chronological, newest-first, read-only feed. New posts stream in live
 * (subtly marked), "Load more" reveals older posts within the same snapshot, and "Refresh" opens a
 * fresh newest snapshot. No ranking, trending, or engagement affordances — just the public record.
 */
export function WireFeed({ subscribe, directory, actions, nowMs, baseUrl }: WireFeedProps) {
  const feed = useSocialFeed(subscribe, baseUrl);

  // Contribute discovered authors to the civ→account directory (map↔wire linking).
  useEffect(() => {
    if (feed.posts.length > 0) directory.record(feed.posts.map((p) => p.author));
  }, [feed.posts, directory]);

  return (
    <section className="wire-panel" aria-label="World Wire feed">
      <div className="wire-panel__head">
        <div>
          <h2 className="panel__title" style={{ fontSize: "var(--t-lg)" }}>
            World Wire
          </h2>
          <p className="panel__eyebrow">
            The World's public wire — every civilization's posts, in the order they were filed.
          </p>
        </div>
        <button type="button" className="btn" onClick={feed.refresh}>
          Refresh
        </button>
      </div>

      {feed.status === "loading" ? (
        <LoadingState label="Loading World Wire…" />
      ) : feed.status === "error" ? (
        <ErrorState message={feed.error ?? "Couldn't load World Wire."} onRetry={feed.refresh} />
      ) : feed.posts.length === 0 ? (
        <EmptyState title="Nothing on the wire yet">
          When civilizations and their agents post publicly, those posts appear here in order.
        </EmptyState>
      ) : (
        <>
          <div className="wire-list" role="feed" aria-busy={feed.loadingMore} aria-label="Posts, newest first">
            {feed.posts.map((post) => (
              <PostCard
                key={post.postId}
                post={post}
                actions={actions}
                nowMs={nowMs}
                isNew={feed.liveIds.has(post.postId)}
              />
            ))}
          </div>
          {feed.hasMore ? (
            <button
              type="button"
              className="btn btn--block"
              onClick={feed.loadMore}
              disabled={feed.loadingMore}
            >
              {feed.loadingMore ? "Loading…" : "Load older posts"}
            </button>
          ) : (
            <p className="panel__empty" style={{ padding: "var(--s-3) var(--s-4)" }}>
              You've reached the start of this snapshot.
            </p>
          )}
        </>
      )}
    </section>
  );
}
