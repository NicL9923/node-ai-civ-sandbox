import { useMemo } from "react";
import type { Civilization, Relationship } from "../../api/types";
import { deriveFreshness } from "../../domain/freshness";
import { layoutCivs } from "../../domain/layout";
import { edgeTreatment, pairKey } from "../../domain/relationships";
import type { Selection } from "../../hooks/useSelection";
import { CivNode } from "./CivNode";
import { RelationshipEdge } from "./RelationshipEdge";

const SIZE = 1000;
const PAD = 96;

interface WorldMapProps {
  civs: Map<string, Civilization>;
  civIds: string[];
  relationships: Map<string, Relationship>;
  nowMs: number;
  selection: Selection;
  onSelectCiv: (civId: string) => void;
  onSelectRel: (a: string, b: string) => void;
  reducedMotion: boolean;
}

/**
 * The surveyor's chart. Civilizations are placed deterministically from their id; relationships
 * are inked survey lines. Selection highlights related edges/nodes and dims the rest. The SVG
 * carries a title/desc; the CivList is the equivalent non-visual surface.
 */
export function WorldMap({
  civs,
  civIds,
  relationships,
  nowMs,
  selection,
  onSelectCiv,
  onSelectRel,
  reducedMotion,
}: WorldMapProps) {
  const positions = useMemo(() => layoutCivs(civIds, SIZE, PAD), [civIds]);

  const selectedCivId = selection?.kind === "civ" ? selection.civId : null;
  const selectedPairKey =
    selection?.kind === "rel" ? pairKey(selection.a, selection.b) : null;

  const isEdgeRelated = (a: string, b: string): boolean => {
    if (!selection) return true;
    if (selectedCivId) return a === selectedCivId || b === selectedCivId;
    if (selectedPairKey) return pairKey(a, b) === selectedPairKey;
    return true;
  };

  const isNodeSelected = (id: string): boolean => {
    if (selectedCivId) return id === selectedCivId;
    if (selection?.kind === "rel") return id === selection.a || id === selection.b;
    return false;
  };

  const civCount = civIds.length;
  const relCount = [...relationships.values()].filter(
    (r) => r.pair?.civA && r.pair?.civB && positions.has(r.pair.civA) && positions.has(r.pair.civB),
  ).length;

  return (
    <svg
      className="map-svg"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="World map of civilizations"
    >
      <title>World map of civilizations</title>
      <desc>
        {`${civCount} civilization${civCount === 1 ? "" : "s"} and ${relCount} relationship${
          relCount === 1 ? "" : "s"
        }. Use the civilizations list for a keyboard-navigable equivalent.`}
      </desc>

      {/* Faint survey graticule (decorative). */}
      <g aria-hidden="true">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <circle key={f} className="graticule" cx={SIZE / 2} cy={SIZE / 2} r={((SIZE - PAD * 2) / 2) * f} />
        ))}
        <line className="graticule" x1={SIZE / 2} y1={PAD} x2={SIZE / 2} y2={SIZE - PAD} />
        <line className="graticule" x1={PAD} y1={SIZE / 2} x2={SIZE - PAD} y2={SIZE / 2} />
      </g>

      {/* Edges beneath nodes. */}
      <g>
        {[...relationships.values()].map((rel) => {
          const a = rel.pair?.civA;
          const b = rel.pair?.civB;
          if (!a || !b) return null;
          const pa = positions.get(a);
          const pb = positions.get(b);
          if (!pa || !pb) return null;
          const treatment = edgeTreatment(rel);
          const nameA = civs.get(a)?.displayName ?? a;
          const nameB = civs.get(b)?.displayName ?? b;
          return (
            <RelationshipEdge
              key={pairKey(a, b)}
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              treatment={treatment}
              dim={selection != null && !isEdgeRelated(a, b)}
              title={`${nameA} and ${nameB}: ${treatment.description}`}
              onSelect={() => onSelectRel(a, b)}
            />
          );
        })}
      </g>

      {/* Nodes. */}
      <g>
        {civIds.map((id) => {
          const civ = civs.get(id);
          const p = positions.get(id);
          if (!civ || !p) return null;
          const fresh = deriveFreshness(civ.running, civ.updatedAt, nowMs);
          return (
            <CivNode
              key={id}
              civ={civ}
              x={p.x}
              y={p.y}
              state={fresh.state}
              selected={isNodeSelected(id)}
              reducedMotion={reducedMotion}
              onSelect={onSelectCiv}
            />
          );
        })}
      </g>
    </svg>
  );
}
