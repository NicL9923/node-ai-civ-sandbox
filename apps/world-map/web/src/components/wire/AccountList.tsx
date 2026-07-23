import type { SocialAccountSummary } from "../../api/social";
import type { CursorListState } from "../../hooks/useCursorList";
import { EmptyState, ErrorState, LoadingState } from "../common/StatusStates";
import { AccountRow } from "./AccountRow";
import type { WireActions } from "./types";

interface AccountListProps {
  list: CursorListState<SocialAccountSummary>;
  actions: WireActions;
  label: string;
  emptyTitle: string;
  emptyBody: string;
  loadMoreLabel: string;
}

/** A paginated account list (followers / following) with load-more and honest empty/error states. */
export function AccountList({ list, actions, label, emptyTitle, emptyBody, loadMoreLabel }: AccountListProps) {
  if (list.status === "loading" && list.items.length === 0) {
    return <LoadingState label="Loading accounts…" />;
  }
  if (list.status === "error" && list.items.length === 0) {
    return <ErrorState message={list.error ?? "Couldn't load accounts."} onRetry={list.reload} />;
  }
  if (list.items.length === 0) {
    return <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>;
  }
  return (
    <>
      <ul className="account-list" aria-label={label}>
        {list.items.map((account) => (
          <AccountRow key={account.accountId} account={account} actions={actions} />
        ))}
      </ul>
      {list.hasMore ? (
        <button type="button" className="btn btn--block" onClick={list.loadMore} disabled={list.loadingMore}>
          {list.loadingMore ? "Loading…" : loadMoreLabel}
        </button>
      ) : null}
    </>
  );
}
