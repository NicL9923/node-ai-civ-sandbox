import type { ReactNode } from "react";
import { toPercent } from "../../domain/format";

interface MetricProps {
  label: string;
  value: ReactNode;
  /** One-line plain-language explanation, so the number is never bare. */
  note?: string;
  /** Optional bar visualization within a known range. */
  range?: readonly [number, number];
  numericValue?: number;
  /** Draw the bar with the signal accent (used for genuine threat). */
  emphasize?: boolean;
}

/** A labelled metric row: name, monospace value, optional explanation and range bar. */
export function Metric({ label, value, note, range, numericValue, emphasize }: MetricProps) {
  const showBar = range != null && typeof numericValue === "number";
  const pct = showBar ? toPercent(numericValue, range[0], range[1]) : 0;
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
      {showBar ? (
        <span className="metric__bar" aria-hidden="true">
          <span
            className={`metric__bar-fill ${emphasize ? "metric__bar-fill--signal" : ""}`.trim()}
            style={{ width: `${pct}%` }}
          />
        </span>
      ) : null}
      {note ? <span className="metric__note">{note}</span> : null}
    </div>
  );
}
