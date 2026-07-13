import { dashArray, type EdgeTreatment } from "../../domain/relationships";

interface RelationshipEdgeProps {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  treatment: EdgeTreatment;
  dim?: boolean;
  title: string;
  onSelect?: () => void;
}

/**
 * Renders a relationship as inked survey linework. Pattern encodes stance, stroke width encodes
 * trust, and the signal accent marks genuine threat — never color alone. `<title>` gives the
 * edge an accessible name.
 */
export function RelationshipEdge({ x1, y1, x2, y2, treatment, dim, title, onSelect }: RelationshipEdgeProps) {
  const color = treatment.emphasis === "threat" ? "var(--signal)" : "var(--ink)";
  const w = treatment.strokeWidth;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy; // perpendicular unit
  const py = ux;

  let shape: React.ReactNode;
  if (treatment.pattern === "double") {
    const off = Math.max(2, w * 0.9);
    shape = (
      <>
        <line x1={x1 + px * off} y1={y1 + py * off} x2={x2 + px * off} y2={y2 + py * off} stroke={color} strokeWidth={Math.max(1, w * 0.6)} />
        <line x1={x1 - px * off} y1={y1 - py * off} x2={x2 - px * off} y2={y2 - py * off} stroke={color} strokeWidth={Math.max(1, w * 0.6)} />
      </>
    );
  } else if (treatment.pattern === "barbed") {
    const barbLen = 6;
    const barbs = [0.32, 0.5, 0.68].map((t, i) => {
      const bx = x1 + dx * t;
      const by = y1 + dy * t;
      // A short tick angled back from the line to read as a barb.
      const ax = -ux * 0.5 + px;
      const ay = -uy * 0.5 + py;
      const an = Math.hypot(ax, ay) || 1;
      return (
        <line
          key={i}
          x1={bx}
          y1={by}
          x2={bx + (ax / an) * barbLen}
          y2={by + (ay / an) * barbLen}
          stroke={color}
          strokeWidth={Math.max(1, w * 0.7)}
        />
      );
    });
    shape = (
      <>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={w} />
        {barbs}
      </>
    );
  } else {
    const strokeWidth = treatment.pattern === "hairline" ? Math.min(w, 1.25) : w;
    shape = (
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArray(treatment.pattern)}
        strokeLinecap={treatment.pattern === "dotted" ? "round" : "butt"}
      />
    );
  }

  return (
    <g
      className={`edge ${dim ? "edge--dim" : ""}`.trim()}
      style={onSelect ? { cursor: "pointer" } : undefined}
      onClick={onSelect}
    >
      <title>{title}</title>
      {onSelect ? (
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
      ) : null}
      {shape}
    </g>
  );
}
