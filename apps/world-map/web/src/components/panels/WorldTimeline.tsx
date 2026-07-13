import { useEffect, useRef } from "react";
import type { Civilization, PublicEventData, WorldEvent } from "../../api/types";
import { relativeAge, toEpochMs } from "../../domain/freshness";
import { humanize } from "../../domain/format";
import type { EventFeed } from "../../hooks/useEventFeed";
import { ConnectionStatus } from "../common/ConnectionStatus";
import { EmptyState, ErrorState, LoadingState } from "../common/StatusStates";

interface WorldTimelineProps {
  feed: EventFeed;
  civs: Map<string, Civilization>;
  nowMs: number;
}

const KIND_LABEL: Record<string, string> = {
  "world.civilization.contact.v1": "Contact",
  "world.civilization.message.v1": "Message",
};

function kindLabel(event: WorldEvent, data: PublicEventData | null): string {
  if (event.type && KIND_LABEL[event.type]) return KIND_LABEL[event.type];
  if (data?.kind) return humanize(data.kind);
  const seg = (event.type ?? "event").split(".");
  return humanize(seg[Math.max(0, seg.length - 2)] ?? "event");
}

/** Read the allowlisted public `data` blob defensively (it may be null / any shape). */
function readData(event: WorldEvent): PublicEventData | null {
  const d = event.data;
  return d && typeof d === "object" ? (d as PublicEventData) : null;
}

function EventRow({
  event,
  civs,
  nowMs,
  isNew,
}: {
  event: WorldEvent;
  civs: Map<string, Civilization>;
  nowMs: number;
  isNew: boolean;
}) {
  const data = readData(event);
  const from = data?.fromDisplayName ?? (data?.fromCiv ? civs.get(data.fromCiv)?.displayName ?? data.fromCiv : null);
  const target = event.subject ? civs.get(event.subject)?.displayName ?? event.subject : null;
  const ageMs = nowMs - toEpochMs(event.time);

  return (
    <li className={`event ${isNew ? "event--new" : ""}`.trim()}>
      <div className="event__head">
        <span className="event__kind">{kindLabel(event, data)}</span>
        <span className="mono" title={event.time ?? undefined}>
          {event.time ? relativeAge(ageMs) : "—"}
        </span>
      </div>
      {/* All narrative is rendered as plain text — never innerHTML. */}
      {data?.publicNarrative ? (
        <p className="event__narrative">{data.publicNarrative}</p>
      ) : data?.subject ? (
        <p className="event__narrative">Subject: {data.subject}</p>
      ) : (
        <p className="event__narrative panel__empty">No public detail.</p>
      )}
      <p className="event__meta">
        {from ? <>from {from}</> : null}
        {from && target ? " " : null}
        {target ? <>to {target}</> : null}
        {event.worldsequence ? <span className="mono"> · #{event.worldsequence}</span> : null}
      </p>
    </li>
  );
}

/** The live world timeline: recent public events, newest first, streaming in without duplicates. */
export function WorldTimeline({ feed, civs, nowMs }: WorldTimelineProps) {
  // Track ids already shown so only genuinely-new (streamed) events animate in — not the
  // initial batch. Seeded on first render.
  const seen = useRef<Set<string> | null>(null);
  const isNew = (id: string | undefined): boolean =>
    seen.current !== null && id != null && !seen.current.has(id);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(feed.visible.map((e) => e.id).filter(Boolean) as string[]);
    } else {
      for (const e of feed.visible) if (e.id) seen.current.add(e.id);
    }
  });

  return (
    <section className="panel timeline" aria-label="World timeline">
      <div className="event__head" style={{ marginBottom: "var(--s-2)" }}>
        <h2 className="panel__title" style={{ fontSize: "var(--t-md)" }}>
          Timeline
        </h2>
        <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
          <ConnectionStatus status={feed.connection} />
          {feed.connection !== "open" ? (
            <button type="button" className="btn" onClick={feed.refresh}>
              Refresh
            </button>
          ) : null}
        </span>
      </div>

      {feed.status === "loading" ? (
        <LoadingState label="Loading the world timeline…" />
      ) : feed.status === "error" ? (
        <ErrorState message={feed.error ?? "Couldn't load the timeline."} onRetry={feed.refresh} />
      ) : feed.visible.length === 0 ? (
        <EmptyState title="No events yet">
          When civilizations contact or message one another, those public events appear here live.
        </EmptyState>
      ) : (
        <>
          <ul className="timeline__list">
            {feed.visible.map((event) => (
              <EventRow key={event.id} event={event} civs={civs} nowMs={nowMs} isNew={isNew(event.id)} />
            ))}
          </ul>
          {feed.hasOlder ? (
            <button type="button" className="btn btn--block" onClick={feed.loadOlder}>
              Load older events
            </button>
          ) : (
            <p className="panel__empty" style={{ padding: "var(--s-3) var(--s-4)" }}>
              Showing all {feed.totalRetained} retained events.
            </p>
          )}
        </>
      )}
    </section>
  );
}
