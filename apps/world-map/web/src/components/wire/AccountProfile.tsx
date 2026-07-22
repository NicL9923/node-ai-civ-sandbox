import { useEffect } from "react";
import { formatCount } from "../../domain/format";
import { civAffiliation } from "../../domain/social";
import type { SocialAccountSummary, SocialPost } from "../../api/social";
import { WIRE_TABS, type WireTab } from "../../domain/wireRouting";
import { isPostTab, useAccount, useAccountTab } from "../../hooks/useAccount";
import type { CursorListState } from "../../hooks/useCursorList";
import type { SocialDirectory } from "../../hooks/useSocialDirectory";
import { EmptyState, ErrorState, LoadingState } from "../common/StatusStates";
import { AccountList } from "./AccountList";
import { KindBadge } from "./KindBadge";
import { PostCard } from "./PostCard";
import type { WireActions } from "./types";

interface AccountProfileProps {
  accountId: string;
  tab: WireTab;
  onSelectTab: (tab: WireTab) => void;
  directory: SocialDirectory;
  actions: WireActions;
  nowMs: number;
  baseUrl?: string;
}

const TAB_LABEL: Record<WireTab, string> = {
  posts: "Posts",
  followers: "Followers",
  following: "Following",
  feed: "Feed",
};

/**
 * A read-only account profile: identity + kind, civ affiliation link back to the map, bio, and
 * eventually-consistent follower/following/post counts, over a tabbed view of the account's posts,
 * followers, following, and its (viewable) following feed. No follow or other mutation controls.
 */
export function AccountProfile({ accountId, tab, onSelectTab, directory, actions, nowMs, baseUrl }: AccountProfileProps) {
  const { account, status, error, reload } = useAccount(accountId, baseUrl);
  const list = useAccountTab(accountId, tab, baseUrl);

  useEffect(() => {
    if (account) directory.record([{ accountId: account.accountId, actor: account.actor, status: account.status }]);
  }, [account, directory]);

  useEffect(() => {
    if (isPostTab(tab) && list.items.length > 0) {
      directory.record((list.items as SocialPost[]).map((p) => p.author));
    } else if (!isPostTab(tab) && list.items.length > 0) {
      directory.record(list.items as SocialAccountSummary[]);
    }
  }, [list.items, tab, directory]);

  if (status === "loading") return <div className="wire-panel"><LoadingState label="Loading account…" /></div>;
  if (status === "error" || !account) {
    return (
      <div className="wire-panel">
        <ErrorState message={error ?? "Couldn't load this account."} onRetry={reload} />
      </div>
    );
  }

  const displayName = account.actor.displayName || account.accountId;
  const affiliation = civAffiliation(account.actor);

  return (
    <section className="wire-panel" aria-label={`Profile of ${displayName}`}>
      <header className="profile__head">
        <div className="profile__identity">
          <h2 className="panel__title" style={{ fontSize: "var(--t-lg)" }}>
            {displayName}
          </h2>
          <KindBadge kind={account.actor.kind} />
        </div>
        <p className="panel__eyebrow">
          <span className="mono">{account.accountId}</span>
          {affiliation ? (
            <>
              {" · "}
              <button type="button" className="btn-link" onClick={() => actions.selectCiv(affiliation.civId)}>
                of <span className="mono">{affiliation.civId}</span> →
              </button>
            </>
          ) : null}
        </p>

        {account.bio ? <p className="profile__bio">{account.bio}</p> : null}

        <p className="profile__counts" title="Public counts are eventually consistent.">
          <span>
            <strong className="mono">{formatCount(account.postCount)}</strong> posts
          </span>
          <button type="button" className="btn-link" onClick={() => onSelectTab("followers")}>
            <strong className="mono">{formatCount(account.followerCount)}</strong> followers
          </button>
          <button type="button" className="btn-link" onClick={() => onSelectTab("following")}>
            <strong className="mono">{formatCount(account.followingCount)}</strong> following
          </button>
        </p>
      </header>

      <div className="wire-tabs" role="tablist" aria-label="Profile sections">
        {WIRE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className="wire-tab"
            onClick={() => onSelectTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "feed" ? (
          <p className="panel__eyebrow" style={{ padding: "var(--s-2) var(--s-4) 0" }}>
            Posts from accounts this one follows, newest first.
          </p>
        ) : null}
        {isPostTab(tab) ? (
          <PostTabPanel list={list.items as SocialPost[]} listState={list} actions={actions} nowMs={nowMs} tab={tab} />
        ) : (
          <AccountList
            list={list as unknown as CursorListState<SocialAccountSummary>}
            actions={actions}
            label={tab === "followers" ? "Followers" : "Following"}
            emptyTitle={tab === "followers" ? "No followers yet" : "Not following anyone yet"}
            emptyBody={
              tab === "followers"
                ? "No accounts follow this one yet."
                : "This account doesn't follow anyone yet."
            }
            loadMoreLabel="Load more accounts"
          />
        )}
      </div>
    </section>
  );
}

function PostTabPanel({
  list,
  listState,
  actions,
  nowMs,
  tab,
}: {
  list: SocialPost[];
  listState: { status: string; error: string | null; hasMore: boolean; loadingMore: boolean; loadMore: () => void; reload: () => void };
  actions: WireActions;
  nowMs: number;
  tab: WireTab;
}) {
  if (listState.status === "loading" && list.length === 0) return <LoadingState label="Loading posts…" />;
  if (listState.status === "error" && list.length === 0) {
    return <ErrorState message={listState.error ?? "Couldn't load posts."} onRetry={listState.reload} />;
  }
  if (list.length === 0) {
    return (
      <EmptyState title={tab === "feed" ? "This feed is empty" : "No posts yet"}>
        {tab === "feed"
          ? "Once this account follows others, their posts appear here."
          : "This account hasn't posted yet."}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="wire-list" role="feed" aria-busy={listState.loadingMore} aria-label="Posts, newest first">
        {list.map((post) => (
          <PostCard key={post.postId} post={post} actions={actions} nowMs={nowMs} />
        ))}
      </div>
      {listState.hasMore ? (
        <button type="button" className="btn btn--block" onClick={listState.loadMore} disabled={listState.loadingMore}>
          {listState.loadingMore ? "Loading…" : "Load older posts"}
        </button>
      ) : null}
    </>
  );
}
