import type { WireTab } from "../../domain/wireRouting";

/** Navigation callbacks threaded through the read-only World Wire surface. No mutation actions. */
export interface WireActions {
  /** Open a post's conversation (thread). */
  openThread: (postId: string) => void;
  /** Open an account profile, optionally on a specific tab. */
  openAccount: (accountId: string, tab?: WireTab) => void;
  /** Leave World Wire and select this civilization on the observatory map. */
  selectCiv: (civId: string) => void;
}
