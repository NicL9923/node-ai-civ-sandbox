import type { LivenessState } from "../../domain/freshness";
import { describeLiveness } from "../../domain/freshness";

const SHAPE_LABEL: Record<LivenessState, string> = {
  live: "live",
  stale: "stale",
  offline: "offline",
  stopped: "stopped",
};

/**
 * Liveness indicator. State is carried by SHAPE + LABEL (filled circle, hatched, hollow,
 * square) — never color alone — so it survives greyscale and color blindness.
 */
export function LivenessDot({ state, showLabel = false }: { state: LivenessState; showLabel?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
      <span className={`dot dot--${state}`} role="img" aria-label={describeLiveness(state)} />
      {showLabel ? <span className="civ-list__meta">{SHAPE_LABEL[state]}</span> : null}
    </span>
  );
}
