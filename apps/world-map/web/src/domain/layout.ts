// Deterministic civilization placement. The public projection carries no geographic
// coordinates, so a civ's position on the chart is derived purely from its civId — stable
// across renders and independent of which other civs are present (adding a civ never moves
// the others). Replace with real coordinates once the contract exposes them.

export interface Point {
  x: number;
  y: number;
}

/** FNV-1a 32-bit hash → unsigned int. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids float precision loss).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Two independent [0,1) values from one id (id and a salted id). */
function unitPair(civId: string): [number, number] {
  const a = fnv1a(civId) / 0xffffffff;
  const b = fnv1a(`${civId}\u0000layout`) / 0xffffffff;
  return [a, b];
}

/**
 * Position in the unit disc (x,y ∈ [-1,1], x²+y² ≤ 1). Uniform-area disc sampling from the
 * two hash values keeps the scatter even without clustering at the centre.
 */
export function civLayout(civId: string): Point {
  const [a, b] = unitPair(civId);
  const r = Math.sqrt(a);
  const theta = b * Math.PI * 2;
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

/**
 * Project a unit-disc point into a viewBox with padding, so nodes never touch the frame.
 * `size` is the square viewBox side; `pad` is the inset in the same units.
 */
export function projectToViewBox(p: Point, size: number, pad: number): Point {
  const usable = (size - pad * 2) / 2;
  const c = size / 2;
  return { x: c + p.x * usable, y: c + p.y * usable };
}

// --- Collision-resolved topology layout ------------------------------------------------------
// This is a TOPOLOGY, not geography: positions are a stable, legible scatter derived from civIds,
// not real-world coordinates. Nodes are anchored at their per-civ hash position, then any that
// would overlap are pushed apart along a deterministic bounded spiral so no two nodes collide.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function clampToDisc(p: Point, center: number, usable: number): Point {
  const dx = p.x - center;
  const dy = p.y - center;
  const d = Math.hypot(dx, dy);
  if (d <= usable || d === 0) return p;
  const s = usable / d;
  return { x: center + dx * s, y: center + dy * s };
}

function minClearance(p: Point, placed: readonly Point[]): number {
  let m = Number.POSITIVE_INFINITY;
  for (const q of placed) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < m) m = d;
  }
  return m;
}

function resolveCollision(
  civId: string,
  anchor: Point,
  placed: readonly Point[],
  minDistance: number,
  center: number,
  usable: number,
): Point {
  if (minClearance(anchor, placed) >= minDistance) return anchor;

  const angle0 = (fnv1a(`${civId}\u0000spiral`) / 0xffffffff) * Math.PI * 2;
  const step = minDistance * 0.62;
  const MAX_STEPS = 512;
  let best = anchor;
  let bestClearance = minClearance(anchor, placed);

  for (let k = 1; k <= MAX_STEPS; k++) {
    const r = step * Math.sqrt(k); // area-uniform outward growth
    const angle = angle0 + k * GOLDEN_ANGLE;
    const candidate = clampToDisc(
      { x: anchor.x + r * Math.cos(angle), y: anchor.y + r * Math.sin(angle) },
      center,
      usable,
    );
    const clearance = minClearance(candidate, placed);
    if (clearance >= minDistance) return candidate;
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = candidate;
    }
  }
  return best; // bounded fallback: the least-crowded candidate found within the disc
}

/**
 * Deterministic, collision-resolved placement for a whole set of civilizations. Output is stable
 * and INDEPENDENT of input order (ids are sorted first): the same set always yields the same map,
 * and adding a civ only disturbs the nodes it would actually collide with (existing anchors that
 * don't overlap the newcomer keep their positions). All points are bounded within the padded disc.
 */
export function layoutCivs(
  civIds: readonly string[],
  size = 1000,
  pad = 96,
  minDistance = 44,
): Map<string, Point> {
  const result = new Map<string, Point>();
  const center = size / 2;
  const usable = (size - pad * 2) / 2;
  const sorted = [...new Set(civIds)].sort();
  const placed: Point[] = [];
  for (const id of sorted) {
    const anchor = clampToDisc(projectToViewBox(civLayout(id), size, pad), center, usable);
    const point = resolveCollision(id, anchor, placed, minDistance, center, usable);
    placed.push(point);
    result.set(id, point);
  }
  return result;
}
