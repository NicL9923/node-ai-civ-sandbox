import type { StreamStatus } from "../../api/sse";
import { ConnectionStatus } from "../common/ConnectionStatus";

interface SummaryHeaderProps {
  civCount: number;
  liveCount: number;
  staleCount: number;
  relCount: number;
  latestWorldSequence: string | null;
  connection: StreamStatus;
  onRefresh: () => void;
}

/** Top bar: what the world contains right now, plus live-stream health. No giant hero metrics. */
export function SummaryHeader({
  civCount,
  liveCount,
  staleCount,
  relCount,
  latestWorldSequence,
  connection,
  onRefresh,
}: SummaryHeaderProps) {
  return (
    <header className="summary">
      <h1 className="summary__title">World Observatory</h1>
      <div className="summary__stats">
        <span className="stat">
          <span className="stat__value mono">{civCount}</span>
          <span className="stat__label">civilizations</span>
        </span>
        <span className="stat">
          <span className="stat__value mono">{liveCount}</span>
          <span className="stat__label">live</span>
        </span>
        <span className="stat">
          <span className="stat__value mono">{staleCount}</span>
          <span className="stat__label">stale</span>
        </span>
        <span className="stat">
          <span className="stat__value mono">{relCount}</span>
          <span className="stat__label">relationships</span>
        </span>
        <span className="stat">
          <span className="stat__value mono">{latestWorldSequence ?? "—"}</span>
          <span className="stat__label">latest sequence</span>
        </span>
      </div>
      <span className="summary__spacer" />
      <ConnectionStatus status={connection} />
      <button type="button" className="btn" onClick={onRefresh}>
        Refresh
      </button>
    </header>
  );
}
