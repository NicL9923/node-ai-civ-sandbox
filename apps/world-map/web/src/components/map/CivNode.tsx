import type { KeyboardEvent } from "react";
import type { Civilization } from "../../api/types";
import type { LivenessState } from "../../domain/freshness";
import { describeLiveness } from "../../domain/freshness";
import { formatPopulation } from "../../domain/format";

interface CivNodeProps {
  civ: Civilization;
  x: number;
  y: number;
  state: LivenessState;
  selected: boolean;
  reducedMotion: boolean;
  onSelect: (civId: string) => void;
}

const FILL: Record<LivenessState, { fill: string; stroke: string }> = {
  live: { fill: "var(--ink)", stroke: "var(--ink)" },
  stale: { fill: "var(--ink-faint)", stroke: "var(--ink-soft)" },
  offline: { fill: "var(--paper)", stroke: "var(--ink-faint)" },
  stopped: { fill: "var(--paper)", stroke: "var(--ink-soft)" },
};

/** A civilization on the chart: a surveyed station whose drawing conveys liveness. Focusable. */
export function CivNode({ civ, x, y, state, selected, reducedMotion, onSelect }: CivNodeProps) {
  const paint = FILL[state];
  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(civ.civId);
    }
  };

  const label = `${civ.displayName}. ${describeLiveness(state)}. Population ${formatPopulation(civ.population)}.${
    civ.president?.name ? ` Led by ${civ.president.title ?? "President"} ${civ.president.name}.` : ""
  }`;

  return (
    <g
      className="civ-node"
      data-selected={selected}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onClick={() => onSelect(civ.civId)}
      onKeyDown={onKeyDown}
      transform={`translate(${x} ${y})`}
    >
      {/* Enlarged transparent hit target (≈44px at typical scale). */}
      <circle className="civ-node__hit" r={22} />
      {state === "live" && !reducedMotion ? (
        <circle className="civ-node__pulse civ-node__pulse--on" r={10} strokeWidth={1.5} />
      ) : null}
      {state === "stopped" ? (
        <rect x={-6} y={-6} width={12} height={12} fill={paint.fill} stroke={paint.stroke} strokeWidth={2} />
      ) : (
        <circle className="civ-node__body" r={7} fill={paint.fill} stroke={paint.stroke} strokeWidth={2} />
      )}
      <circle className="civ-node__ring" r={13} />
      <text className="civ-node__label" x={0} y={26} textAnchor="middle">
        {civ.displayName}
      </text>
    </g>
  );
}
