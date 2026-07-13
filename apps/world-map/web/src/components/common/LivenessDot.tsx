import type { LivenessState } from "../../domain/freshness";
import { describeLiveness, livenessLabel } from "../../domain/freshness";

/**
 * Recency indicator. State is carried by SHAPE + LABEL (filled circle, hatched, hollow,
 * square) — never color alone — so it survives greyscale and color blindness. Labels describe
 * projection recency, not an authoritative online/offline state (the API has no such flag).
 */
export function LivenessDot({ state, showLabel = false }: { state: LivenessState; showLabel?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
      <span className={`dot dot--${state}`} role="img" aria-label={describeLiveness(state)} />
      {showLabel ? <span className="civ-list__meta">{livenessLabel(state)}</span> : null}
    </span>
  );
}
