// Liveness / freshness derivation. The public projection has no explicit online flag, so we
// derive one from `running` + `updatedAt`, mirroring the server's liveness thresholds
// (WorldMap:Liveness — StaleAfterSeconds=90, OfflineAfterSeconds=300). Values are DERIVED and
// labelled as such in the UI; we never imply an authoritative online state the API didn't send.

export const STALE_AFTER_MS = 90_000;
export const OFFLINE_AFTER_MS = 300_000;

export type LivenessState = "live" | "stale" | "offline" | "stopped";

export interface Freshness {
  state: LivenessState;
  ageMs: number;
  /** Short relative label, e.g. "12s ago", "3m ago", "1d ago". */
  label: string;
}

/** Parse an ISO timestamp to epoch ms; NaN-safe. */
export function toEpochMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

export function relativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Derive freshness for a civilization.
 * - `running === false` → "stopped" (the civ itself reports it is not running).
 * - otherwise bucket by heartbeat age: live < 90s, stale < 300s, else offline.
 */
export function deriveFreshness(
  running: boolean,
  updatedAt: string | null | undefined,
  nowMs: number,
): Freshness {
  const updated = toEpochMs(updatedAt);
  const ageMs = Number.isNaN(updated) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - updated);
  const label = Number.isFinite(ageMs) ? relativeAge(ageMs) : "unknown";

  if (!running) {
    return { state: "stopped", ageMs, label };
  }
  if (ageMs < STALE_AFTER_MS) {
    return { state: "live", ageMs, label };
  }
  if (ageMs < OFFLINE_AFTER_MS) {
    return { state: "stale", ageMs, label };
  }
  return { state: "offline", ageMs, label };
}

/** Plain-language description for aria/tooltips. Does NOT claim an authoritative online/offline
 *  state — the API exposes no such flag; these describe how recent the civ's projection is. */
export function describeLiveness(state: LivenessState): string {
  switch (state) {
    case "live":
      return "Projection updated recently";
    case "stale":
      return "Stale projection — no update in over 90 seconds";
    case "offline":
      return "No recent update — over 5 minutes";
    case "stopped":
      return "Simulation reports it is paused";
  }
}

/** Short, honest civ-facing label for a recency state (chips, detail rows). */
export function livenessLabel(state: LivenessState): string {
  switch (state) {
    case "live":
      return "updated recently";
    case "stale":
      return "stale projection";
    case "offline":
      return "no recent update";
    case "stopped":
      return "simulation paused";
  }
}
