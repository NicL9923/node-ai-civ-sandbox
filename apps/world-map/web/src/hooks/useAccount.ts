import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "../api/client";
import type { SocialAccount, SocialAccountSummary, SocialPost } from "../api/social";
import type { WireTab } from "../domain/wireRouting";
import { useCursorList, type CursorListState, type CursorListStatus } from "./useCursorList";
import { SOCIAL_MAX_RETAINED, SOCIAL_PAGE_LIMIT } from "./useSocialFeed";

export interface AccountHeader {
  account: SocialAccount | null;
  status: CursorListStatus;
  error: string | null;
  reload: () => void;
}

/** Public account projection (profile header): display identity, bio, and eventually-consistent counts. */
export function useAccount(accountId: string, baseUrl?: string): AccountHeader {
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [status, setStatus] = useState<CursorListStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    setAccount(null);
    setStatus("loading");
    setError(null);
    client
      .GET("/social/accounts/{accountId}", { params: { path: { accountId } }, signal: controller.signal })
      .then(({ data, error: err }) => {
        if (controller.signal.aborted) return;
        if (err || !data) {
          setStatus("error");
          setError("Couldn't load this account.");
          return;
        }
        setAccount(data as SocialAccount);
        setStatus("ready");
      })
      .catch((e) => {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setStatus("error");
        setError("Couldn't load this account.");
      });
    return () => controller.abort();
  }, [client, accountId, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { account, status, error, reload };
}

/** Whether a tab renders posts (posts/feed) or accounts (followers/following). */
export function isPostTab(tab: WireTab): boolean {
  return tab === "posts" || tab === "feed";
}

type TabItem = SocialPost | SocialAccountSummary;

function tabItemId(item: TabItem): string {
  return "postId" in item ? item.postId : item.accountId;
}

/**
 * The active profile tab as an immutable cursor-paginated snapshot. Posts/feed tabs return
 * `SocialPost`s (newest first); followers/following return `SocialAccountSummary`s. Each tab is its
 * own snapshot with its own opaque cursor; switching tabs opens a fresh one. Snapshots refresh via
 * the profile's Refresh control rather than live mutation, matching the contract's snapshot model.
 */
export function useAccountTab(
  accountId: string,
  tab: WireTab,
  baseUrl?: string,
): CursorListState<TabItem> {
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);

  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const query = { cursor, limit: SOCIAL_PAGE_LIMIT };
      if (tab === "posts") {
        const { data, error } = await client.GET("/social/accounts/{accountId}/posts", {
          params: { path: { accountId }, query },
          signal,
        });
        if (error || !data) throw new Error("account posts request failed");
        return { items: (data.items ?? []) as TabItem[], nextCursor: data.nextCursor ?? null };
      }
      if (tab === "feed") {
        const { data, error } = await client.GET("/social/accounts/{accountId}/feed", {
          params: { path: { accountId }, query },
          signal,
        });
        if (error || !data) throw new Error("account feed request failed");
        return { items: (data.items ?? []) as TabItem[], nextCursor: data.nextCursor ?? null };
      }
      if (tab === "followers") {
        const { data, error } = await client.GET("/social/accounts/{accountId}/followers", {
          params: { path: { accountId }, query },
          signal,
        });
        if (error || !data) throw new Error("followers request failed");
        return { items: (data.items ?? []) as TabItem[], nextCursor: data.nextCursor ?? null };
      }
      const { data, error } = await client.GET("/social/accounts/{accountId}/following", {
        params: { path: { accountId }, query },
        signal,
      });
      if (error || !data) throw new Error("following request failed");
      return { items: (data.items ?? []) as TabItem[], nextCursor: data.nextCursor ?? null };
    },
    [client, accountId, tab],
  );

  return useCursorList<TabItem>({
    fetchPage,
    getId: tabItemId,
    resetKey: accountId ? `acct:${accountId}:${tab}` : "",
    cap: SOCIAL_MAX_RETAINED,
  });
}
