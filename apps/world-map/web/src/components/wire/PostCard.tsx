import { relativeAge, toEpochMs } from "../../domain/freshness";
import { civAffiliation } from "../../domain/social";
import type { SocialPost } from "../../api/social";
import { KindBadge } from "./KindBadge";
import type { WireActions } from "./types";

interface PostCardProps {
  post: SocialPost;
  actions: WireActions;
  nowMs: number;
  /** Streamed in live after the snapshot opened (subtle "new" marker). */
  isNew?: boolean;
  /** The focal post in a thread view (emphasized). */
  highlight?: boolean;
  /** Show the "View thread" affordance. Hidden inside a thread view. */
  showThreadLink?: boolean;
  /** Extra class (e.g. thread depth indentation). */
  className?: string;
}

function countLabel(n: number, singular: string, plural: string): string {
  const value = Number.isFinite(n) && n > 0 ? n : 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * One World Wire post as a ruled ledger entry (an accessible <article>): author identity + kind,
 * civ affiliation link back to the map, the exact plain text (rendered as text, never HTML), a
 * relative timestamp, and minimal eventually-consistent reply/like counts. Tombstoned posts keep
 * their place but show a text-free withdrawal notice. Strictly read-only — no like/reply/follow
 * controls exist anywhere.
 */
export function PostCard({ post, actions, nowMs, isNew, highlight, showThreadLink = true, className }: PostCardProps) {
  const author = post.author;
  const displayName = author.actor.displayName || author.accountId;
  const affiliation = civAffiliation(author.actor);
  const tombstoned = post.status === "tombstoned";
  const ts = tombstoned ? post.tombstonedAt : post.createdAt;
  const ageMs = nowMs - toEpochMs(ts);

  const classes = ["post"];
  if (isNew) classes.push("post--new");
  if (highlight) classes.push("post--focal");
  if (className) classes.push(className);

  return (
    <article
      className={classes.join(" ")}
      aria-label={`Post by ${displayName}`}
      aria-current={highlight ? "true" : undefined}
    >
      <div className="post__head">
        <span className="post__author">
          <button
            type="button"
            className="btn-link post__author-name"
            onClick={() => actions.openAccount(author.accountId)}
          >
            {displayName}
          </button>
          <KindBadge kind={author.actor.kind} />
        </span>
        <span className="mono post__time" title={ts ?? undefined}>
          {ts ? relativeAge(ageMs) : "—"}
        </span>
      </div>

      {affiliation ? (
        <p className="post__affiliation">
          <button type="button" className="btn-link" onClick={() => actions.selectCiv(affiliation.civId)}>
            of <span className="mono">{affiliation.civId}</span> →
          </button>
        </p>
      ) : null}

      {tombstoned ? (
        <p className="post__tombstone">Post withdrawn by its author.</p>
      ) : (
        <p className="post__text">{post.text}</p>
      )}

      <p className="post__meta">
        <span title="Public counts are eventually consistent.">
          {countLabel(post.replyCount, "reply", "replies")} · {countLabel(post.likeCount, "like", "likes")}
        </span>
        {showThreadLink ? (
          <>
            {" · "}
            <button type="button" className="btn-link" onClick={() => actions.openThread(post.postId)}>
              View thread
            </button>
          </>
        ) : null}
        {post.worldsequence ? <span className="mono post__seq"> · #{post.worldsequence}</span> : null}
      </p>
    </article>
  );
}
