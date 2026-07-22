import { useCallback, useEffect, useRef, useState } from "react";
import type { SocialAccountSummary } from "../api/social";
import type { WorldEvent } from "../api/types";
import { civAffiliation, classifySocialEvent } from "../domain/social";

const MAX_CIVS = 500;
const MAX_ACCOUNTS_PER_CIV = 50;

export interface SocialDirectory {
  /** Known social accounts for a civilization, discovered through public feed traffic. */
  accountsForCiv: (civId: string) => SocialAccountSummary[];
  /** Contribute discovered account summaries (feed authors, profile actor, follow lists). */
  record: (summaries: SocialAccountSummary[]) => void;
}

function indexSummaries(
  base: Map<string, SocialAccountSummary[]>,
  summaries: SocialAccountSummary[],
): Map<string, SocialAccountSummary[]> {
  let next: Map<string, SocialAccountSummary[]> | null = null;
  for (const summary of summaries) {
    const affiliation = civAffiliation(summary?.actor);
    if (!affiliation || typeof summary.accountId !== "string") continue;
    const { civId } = affiliation;
    const source = next ?? base;
    const existing = source.get(civId);
    if (existing?.some((a) => a.accountId === summary.accountId)) continue;
    if (!existing && source.size >= MAX_CIVS) continue;
    if (existing && existing.length >= MAX_ACCOUNTS_PER_CIV) continue;
    if (!next) next = new Map(base);
    next.set(civId, existing ? [...existing, summary] : [summary]);
  }
  return next ?? base;
}

/**
 * A bounded client-side civilization→social-account directory built purely from public feed
 * traffic. The World exposes no civId→accounts or list-all-accounts endpoint, so map→wire linking
 * is best-effort discovery: authors seen in live social events and any recorded summaries populate
 * the index, letting CivDetail surface a civ's World Wire presence once it has appeared publicly.
 */
export function useSocialDirectory(
  subscribe: (listener: (event: WorldEvent) => void) => () => void,
): SocialDirectory {
  const [index, setIndex] = useState<Map<string, SocialAccountSummary[]>>(() => new Map());
  const indexRef = useRef(index);
  indexRef.current = index;

  const record = useCallback((summaries: SocialAccountSummary[]) => {
    if (summaries.length === 0) return;
    setIndex((prev) => indexSummaries(prev, summaries));
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      const signal = classifySocialEvent(event);
      if (signal && (signal.kind === "post-created" || signal.kind === "reply-created")) {
        record([signal.post.author]);
      }
    });
    return unsubscribe;
  }, [subscribe, record]);

  const accountsForCiv = useCallback((civId: string) => index.get(civId) ?? [], [index]);

  return { accountsForCiv, record };
}
