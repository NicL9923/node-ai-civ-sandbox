import type { Civilization, Relationship } from "../../api/types";
import { humanize } from "../../domain/format";
import {
  GRIEVANCE_RANGE,
  HIGH_THREAT,
  THREAT_RANGE,
  TRUST_RANGE,
  UNIT_RANGE,
} from "../../domain/relationships";
import { ExpandableText } from "../common/ExpandableText";
import { Metric } from "../common/Metric";

interface RelationshipDetailProps {
  relationship: Relationship;
  civs: Map<string, Civilization>;
  onSelectCiv: (civId: string) => void;
}

/** Detail for one relationship. Metrics are explained plainly; no sentiment beyond server values. */
export function RelationshipDetail({ relationship: rel, civs, onSelectCiv }: RelationshipDetailProps) {
  const nameA = civs.get(rel.pair.civA)?.displayName ?? rel.pair.civA;
  const nameB = civs.get(rel.pair.civB)?.displayName ?? rel.pair.civB;

  return (
    <section className="panel" aria-label={`Relationship between ${nameA} and ${nameB}`}>
      <h2 className="panel__title">
        <button type="button" className="btn" onClick={() => onSelectCiv(rel.pair.civA)}>
          {nameA}
        </button>{" "}
        &{" "}
        <button type="button" className="btn" onClick={() => onSelectCiv(rel.pair.civB)}>
          {nameB}
        </button>
      </h2>
      <p className="panel__eyebrow">Stance: {humanize(rel.stance)}</p>

      <Metric
        label="Trust"
        value={<span className="mono">{rel.trust.toFixed(2)}</span>}
        range={TRUST_RANGE}
        numericValue={rel.trust}
        note="Net trust, from −1 (total distrust) to +1 (full trust)."
      />
      <Metric
        label="Grievance"
        value={<span className="mono">{rel.grievance.toFixed(0)}</span>}
        range={GRIEVANCE_RANGE}
        numericValue={rel.grievance}
        note="Accumulated grievance, 0 (none) to 100 (maximal)."
      />
      <Metric
        label="Threat"
        value={<span className="mono">{rel.threat.toFixed(0)}</span>}
        range={THREAT_RANGE}
        numericValue={rel.threat}
        emphasize={rel.threat >= HIGH_THREAT}
        note="Perceived threat, 0 (none) to 100 (existential)."
      />
      <Metric
        label="Familiarity"
        value={<span className="mono">{rel.familiarity.toFixed(2)}</span>}
        range={UNIT_RANGE}
        numericValue={rel.familiarity}
        note="How much the two have interacted, 0 to 1."
      />
      <Metric
        label="Interdependence"
        value={<span className="mono">{rel.interdependence.toFixed(2)}</span>}
        range={UNIT_RANGE}
        numericValue={rel.interdependence}
        note="How intertwined their outcomes are, 0 to 1."
      />

      {rel.narrativeSummary ? (
        <>
          <h3 className="panel__title" style={{ fontSize: "var(--t-md)", marginTop: "var(--s-4)" }}>
            Summary
          </h3>
          <ExpandableText text={rel.narrativeSummary} className="event__narrative" />
        </>
      ) : null}

      <p className="metric__note" style={{ marginTop: "var(--s-3)" }}>
        Revision {rel.version}
        {rel.updatedAt ? ` · updated ${rel.updatedAt}` : ""}
      </p>
    </section>
  );
}
