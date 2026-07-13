import { STANCE_LEGEND, type EdgePattern } from "../../domain/relationships";
import { LivenessDot } from "../common/LivenessDot";

/** Small SVG swatch drawing each stance's linework, matching the map's edge rendering. */
function PatternSwatch({ pattern }: { pattern: EdgePattern }) {
  const y = 6;
  const common = { stroke: "var(--ink)", strokeWidth: 2 } as const;
  return (
    <svg className="legend__swatch" viewBox="0 0 34 12" aria-hidden="true">
      {pattern === "double" ? (
        <>
          <line x1={0} y1={y - 2} x2={34} y2={y - 2} {...common} strokeWidth={1.3} />
          <line x1={0} y1={y + 2} x2={34} y2={y + 2} {...common} strokeWidth={1.3} />
        </>
      ) : pattern === "barbed" ? (
        <>
          <line x1={0} y1={y} x2={34} y2={y} {...common} />
          {[10, 18, 26].map((x) => (
            <line key={x} x1={x} y1={y} x2={x - 3} y2={y + 4} {...common} strokeWidth={1.4} />
          ))}
        </>
      ) : (
        <line
          x1={0}
          y1={y}
          x2={34}
          y2={y}
          {...common}
          strokeWidth={pattern === "hairline" ? 1 : 2}
          strokeDasharray={pattern === "dashed" ? "6 4" : undefined}
        />
      )}
    </svg>
  );
}

/** Decodes the map's non-color encodings: stance linework and liveness shapes. */
export function MapLegend() {
  return (
    <div className="legend" aria-label="Map legend">
      {STANCE_LEGEND.map((entry) => (
        <span className="legend__item" key={entry.stance}>
          <PatternSwatch pattern={entry.pattern} />
          <span>{entry.label}</span>
        </span>
      ))}
      <span className="legend__item">
        <LivenessDot state="live" />
        <span>Recent</span>
      </span>
      <span className="legend__item">
        <LivenessDot state="stale" />
        <span>Stale</span>
      </span>
      <span className="legend__item">
        <LivenessDot state="offline" />
        <span>No update</span>
      </span>
      <span className="legend__item">
        <LivenessDot state="stopped" />
        <span>Paused</span>
      </span>
    </div>
  );
}
