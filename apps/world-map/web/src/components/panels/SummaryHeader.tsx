import type { StreamStatus } from "../../api/sse";
import { ConnectionStatus } from "../common/ConnectionStatus";
import { WireNav, type Surface } from "../wire/WireNav";

interface SummaryHeaderProps {
  civCount: number;
  liveCount: number;
  staleCount: number;
  relCount: number;
  latestWorldSequence: string | null;
  connection: StreamStatus;
  onRefresh: () => void;
  surface: Surface;
  onObservatory: () => void;
  onWire: () => void;
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
  surface,
  onObservatory,
  onWire,
}: SummaryHeaderProps) {
  return (
    <header className="summary">
      <h1 className="summary__title">World Observatory</h1>
      <WireNav active={surface} onObservatory={onObservatory} onWire={onWire} />
      <div className="summary__stats">
        <span className="stat">
          <span className="stat__value mono">{civCount}</span>
          <span className="stat__label">civilizations</span>
        </span>
        <span className="stat">
          <span className="stat__value mono">{liveCount}</span>
          <span className="stat__label">updated recently</span>
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
