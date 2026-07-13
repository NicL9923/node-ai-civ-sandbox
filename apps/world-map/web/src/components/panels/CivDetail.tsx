import type { Civilization, Relationship } from "../../api/types";
import { deriveFreshness } from "../../domain/freshness";
import { formatCount, formatPopulation, formatTreasury, humanize } from "../../domain/format";
import { pairKey } from "../../domain/relationships";
import { LivenessDot } from "../common/LivenessDot";
import { Metric } from "../common/Metric";

interface CivDetailProps {
  civ: Civilization;
  relationships: Relationship[];
  civs: Map<string, Civilization>;
  nowMs: number;
  onSelectRel: (a: string, b: string) => void;
}

/** Detail for one civilization: identity, leadership, run state, safe economy, and its ties. */
export function CivDetail({ civ, relationships, civs, nowMs, onSelectRel }: CivDetailProps) {
  const fresh = deriveFreshness(civ.running, civ.updatedAt, nowMs);

  return (
    <section className="panel" aria-label={`Details for ${civ.displayName}`}>
      <h2 className="panel__title">{civ.displayName}</h2>
      <p className="panel__eyebrow">
        <span className="mono">{civ.civId}</span> · protocol {civ.protocolVersion}
      </p>

      <Metric
        label="State"
        value={
          <span style={{ display: "inline-flex", gap: "0.375rem", alignItems: "center" }}>
            <LivenessDot state={fresh.state} />
            {fresh.state}
          </span>
        }
        note={civ.running ? `Reports running; last heartbeat ${fresh.label}.` : "Reports it is not running."}
      />
      <Metric label="Turn" value={<span className="mono">{formatCount(civ.turn)}</span>} />
      <Metric
        label="President"
        value={civ.president?.name ?? "—"}
        note={
          civ.president
            ? `${civ.president.title ?? "President"}${civ.president.termNumber ? `, term ${civ.president.termNumber}` : ""}`
            : "No leader reported."
        }
      />
      <Metric
        label="Population"
        value={<span className="mono">{formatPopulation(civ.population)}</span>}
        note={`${formatCount(civ.population)} citizens reported.`}
      />
      <Metric
        label="Treasury"
        value={<span className="mono">{formatTreasury(civ.economy?.treasury, civ.economy?.currency)}</span>}
        note="Aggregate public treasury; the World exposes no further economic detail."
      />
      <Metric label="Last updated" value={fresh.label} note={civ.updatedAt ?? "unknown"} />

      <h3 className="panel__title" style={{ fontSize: "var(--t-md)", marginTop: "var(--s-4)" }}>
        Relationships
      </h3>
      {relationships.length === 0 ? (
        <p className="panel__empty">No relationships recorded with other civilizations.</p>
      ) : (
        <ul className="civ-list" aria-label={`Relationships of ${civ.displayName}`}>
          {relationships.map((rel) => {
            const otherId = rel.pair.civA === civ.civId ? rel.pair.civB : rel.pair.civA;
            const otherName = civs.get(otherId)?.displayName ?? otherId;
            return (
              <li key={pairKey(rel.pair.civA, rel.pair.civB)}>
                <button
                  type="button"
                  className="civ-list__item"
                  onClick={() => onSelectRel(rel.pair.civA, rel.pair.civB)}
                >
                  <span className="civ-list__name">{otherName}</span>
                  <span className="civ-list__meta">{humanize(rel.stance)}</span>
                  <span className="civ-list__meta mono">trust {rel.trust.toFixed(2)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
