import { useMemo, useState } from "react";
import "./app.css";
import type { Relationship } from "./api/types";
import { deriveFreshness } from "./domain/freshness";
import { pairKey } from "./domain/relationships";
import { useEventFeed } from "./hooks/useEventFeed";
import { useNow } from "./hooks/useNow";
import { useReducedMotion } from "./hooks/useReducedMotion";
import { useSelection } from "./hooks/useSelection";
import { useWorldData } from "./hooks/useWorldData";
import { CivList } from "./components/common/CivList";
import { EmptyState, ErrorState, LoadingState } from "./components/common/StatusStates";
import { MapLegend } from "./components/map/MapLegend";
import { WorldMap } from "./components/map/WorldMap";
import { CivDetail } from "./components/panels/CivDetail";
import { RelationshipDetail } from "./components/panels/RelationshipDetail";
import { SummaryHeader } from "./components/panels/SummaryHeader";
import { WorldTimeline } from "./components/panels/WorldTimeline";

type MobileView = "map" | "list";

export function App() {
  const world = useWorldData();
  const feed = useEventFeed();
  const [selection, select] = useSelection();
  const nowMs = useNow();
  const reducedMotion = useReducedMotion();
  const [mobileView, setMobileView] = useState<MobileView>("list");

  const { civs, civIds, relationships } = world;

  const counts = useMemo(() => {
    let live = 0;
    let stale = 0;
    for (const id of civIds) {
      const civ = civs.get(id);
      if (!civ) continue;
      const state = deriveFreshness(civ.running, civ.updatedAt, nowMs).state;
      if (state === "live") live++;
      else if (state === "stale") stale++;
    }
    const rels = [...relationships.values()].filter(
      (r) => r.pair?.civA && r.pair?.civB && civs.has(r.pair.civA) && civs.has(r.pair.civB),
    ).length;
    return { live, stale, rels };
  }, [civs, civIds, relationships, nowMs]);

  const onSelectCiv = (civId: string) => select({ kind: "civ", civId });
  const onSelectRel = (a: string, b: string) =>
    select(a <= b ? { kind: "rel", a, b } : { kind: "rel", a: b, b: a });
  const clearSelection = () => select(null);

  const selectedCiv = selection?.kind === "civ" ? civs.get(selection.civId) : undefined;
  const selectedRel: Relationship | undefined =
    selection?.kind === "rel" ? relationships.get(pairKey(selection.a, selection.b)) : undefined;

  const civRelationships = (civId: string): Relationship[] =>
    [...relationships.values()].filter((r) => r.pair?.civA === civId || r.pair?.civB === civId);

  const isLoading = world.status === "loading" && !world.loaded;
  const isError = world.status === "error";
  const isEmpty = world.status === "ready" && civIds.length === 0;

  return (
    <div className="app">
      <SummaryHeader
        civCount={civIds.length}
        liveCount={counts.live}
        staleCount={counts.stale}
        relCount={counts.rels}
        latestWorldSequence={feed.latestWorldSequence}
        connection={feed.connection}
        onRefresh={world.refresh}
      />

      <div className="layout" data-mobile-view={mobileView}>
        <div className="mobile-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "map"}
            className="btn"
            onClick={() => setMobileView("map")}
          >
            Map
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "list"}
            className="btn"
            onClick={() => setMobileView("list")}
          >
            List
          </button>
        </div>

        <main className="map-region" aria-label="Civilization map">
          <div className="map-frame">
            {isLoading ? (
              <LoadingState />
            ) : isError ? (
              <ErrorState message={world.error ?? "Couldn't reach the World."} onRetry={world.refresh} />
            ) : isEmpty ? (
              <EmptyState title="No civilizations yet">
                Civilizations appear here once they register with the World and send a heartbeat.
              </EmptyState>
            ) : (
              <WorldMap
                civs={civs}
                civIds={civIds}
                relationships={relationships}
                nowMs={nowMs}
                selection={selection}
                onSelectCiv={onSelectCiv}
                onSelectRel={onSelectRel}
                reducedMotion={reducedMotion}
              />
            )}
          </div>
          {!isLoading && !isError && !isEmpty ? <MapLegend /> : null}
        </main>

        <aside className="rail" aria-label="Details and timeline">
          {selectedCiv ? (
            <div>
              <div style={{ padding: "var(--s-3) var(--s-4) 0" }}>
                <button type="button" className="btn" onClick={clearSelection}>
                  ← All civilizations
                </button>
              </div>
              <CivDetail
                civ={selectedCiv}
                relationships={civRelationships(selectedCiv.civId)}
                civs={civs}
                nowMs={nowMs}
                onSelectRel={onSelectRel}
              />
            </div>
          ) : selectedRel ? (
            <div>
              <div style={{ padding: "var(--s-3) var(--s-4) 0" }}>
                <button type="button" className="btn" onClick={clearSelection}>
                  ← All civilizations
                </button>
              </div>
              <RelationshipDetail relationship={selectedRel} civs={civs} onSelectCiv={onSelectCiv} />
            </div>
          ) : selection?.kind === "rel" ? (
            <section className="panel">
              <button type="button" className="btn" onClick={clearSelection}>
                ← All civilizations
              </button>
              <p className="panel__empty" style={{ marginTop: "var(--s-3)" }}>
                No relationship is recorded between these civilizations.
              </p>
            </section>
          ) : (
            <section className="panel" aria-label="Civilizations">
              <h2 className="panel__title" style={{ fontSize: "var(--t-md)" }}>
                Civilizations
              </h2>
              <p className="panel__eyebrow">Select one to see its detail, on the map or in this list.</p>
              {civIds.length > 0 ? (
                <CivList
                  civs={civs}
                  civIds={civIds}
                  nowMs={nowMs}
                  selectedCivId={null}
                  onSelect={onSelectCiv}
                />
              ) : (
                <p className="panel__empty">No civilizations to list yet.</p>
              )}
            </section>
          )}

          <WorldTimeline feed={feed} civs={civs} nowMs={nowMs} />
        </aside>
      </div>
    </div>
  );
}
