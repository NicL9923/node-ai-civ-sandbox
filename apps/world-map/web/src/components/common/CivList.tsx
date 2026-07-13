import type { Civilization } from "../../api/types";
import { deriveFreshness } from "../../domain/freshness";
import { formatPopulation } from "../../domain/format";
import { LivenessDot } from "./LivenessDot";

interface CivListProps {
  civs: Map<string, Civilization>;
  civIds: string[];
  nowMs: number;
  selectedCivId: string | null;
  onSelect: (civId: string) => void;
}

/**
 * Accessible, keyboard-navigable list of civilizations — the equal of the map (and the primary
 * surface on narrow screens). Shares selection state with the map so either can drive focus.
 */
export function CivList({ civs, civIds, nowMs, selectedCivId, onSelect }: CivListProps) {
  return (
    <ul className="civ-list" aria-label="Civilizations">
      {civIds.map((id) => {
        const civ = civs.get(id);
        if (!civ) return null;
        const fresh = deriveFreshness(civ.running, civ.updatedAt, nowMs);
        const leader = civ.president?.name;
        const selected = id === selectedCivId;
        return (
          <li key={id}>
            <button
              type="button"
              className="civ-list__item"
              aria-current={selected}
              onClick={() => onSelect(id)}
            >
              <LivenessDot state={fresh.state} />
              <span>
                <span className="civ-list__name">{civ.displayName}</span>
                <span className="civ-list__meta">
                  {" "}
                  {leader ? `${civ.president?.title ?? "President"} ${leader}` : "leader unknown"}
                </span>
              </span>
              <span className="civ-list__meta mono">{formatPopulation(civ.population)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
