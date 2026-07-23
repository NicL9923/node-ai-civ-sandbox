import type { WorldEvent } from "../../api/types";
import type { WireRoute, WireTab } from "../../domain/wireRouting";
import type { SocialDirectory } from "../../hooks/useSocialDirectory";
import { AccountProfile } from "./AccountProfile";
import { PostThread } from "./PostThread";
import { WireFeed } from "./WireFeed";
import type { WireActions } from "./types";

interface WireSurfaceProps {
  route: WireRoute;
  navigate: (route: WireRoute) => void;
  exitToObservatory: () => void;
  onSelectCiv: (civId: string) => void;
  subscribe: (listener: (event: WorldEvent) => void) => () => void;
  directory: SocialDirectory;
  nowMs: number;
  baseUrl?: string;
}

const CRUMB: Record<WireRoute["view"], string> = {
  feed: "Feed",
  account: "Account",
  post: "Conversation",
};

/**
 * The World Wire reading surface. Switches between the global feed, an account profile, and a
 * conversation based on the deep-linked route, and hosts a breadcrumb back to the observatory. It
 * builds the read-only navigation actions (open thread / open account / return to the map) shared
 * by all wire components — there are no mutation actions anywhere.
 */
export function WireSurface({
  route,
  navigate,
  exitToObservatory,
  onSelectCiv,
  subscribe,
  directory,
  nowMs,
  baseUrl,
}: WireSurfaceProps) {
  const actions: WireActions = {
    openThread: (postId) => navigate({ view: "post", postId }),
    openAccount: (accountId, tab) => navigate({ view: "account", accountId, tab: tab ?? "posts" }),
    selectCiv: onSelectCiv,
  };

  return (
    <div className="wire">
      <nav className="wire-crumbs" aria-label="World Wire breadcrumb">
        <button type="button" className="btn" onClick={exitToObservatory}>
          ← Observatory
        </button>
        {route.view !== "feed" ? (
          <>
            <button type="button" className="btn-link" onClick={() => navigate({ view: "feed" })}>
              World Wire
            </button>
            <span className="wire-crumbs__sep">/</span>
          </>
        ) : null}
        <span className="wire-crumbs__here">{CRUMB[route.view]}</span>
      </nav>

      <div className="wire-body">
        {route.view === "feed" ? (
          <WireFeed subscribe={subscribe} directory={directory} actions={actions} nowMs={nowMs} baseUrl={baseUrl} />
        ) : route.view === "account" ? (
          <AccountProfile
            accountId={route.accountId}
            tab={route.tab}
            onSelectTab={(tab: WireTab) => navigate({ view: "account", accountId: route.accountId, tab })}
            directory={directory}
            actions={actions}
            nowMs={nowMs}
            baseUrl={baseUrl}
          />
        ) : (
          <PostThread
            postId={route.postId}
            subscribe={subscribe}
            directory={directory}
            actions={actions}
            nowMs={nowMs}
            baseUrl={baseUrl}
          />
        )}
      </div>
    </div>
  );
}
