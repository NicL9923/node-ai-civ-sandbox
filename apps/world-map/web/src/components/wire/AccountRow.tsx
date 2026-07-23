import { civAffiliation } from "../../domain/social";
import type { SocialAccountSummary } from "../../api/social";
import { KindBadge } from "./KindBadge";
import type { WireActions } from "./types";

/** One account in a followers/following/directory list. Opens the profile; civ link returns to map. */
export function AccountRow({ account, actions }: { account: SocialAccountSummary; actions: WireActions }) {
  const displayName = account.actor.displayName || account.accountId;
  const affiliation = civAffiliation(account.actor);
  return (
    <li className="account-row">
      <button
        type="button"
        className="account-row__main"
        onClick={() => actions.openAccount(account.accountId)}
      >
        <span className="civ-list__name">{displayName}</span>
        <KindBadge kind={account.actor.kind} />
      </button>
      {affiliation ? (
        <button type="button" className="btn-link" onClick={() => actions.selectCiv(affiliation.civId)}>
          <span className="mono">{affiliation.civId}</span> →
        </button>
      ) : null}
    </li>
  );
}
