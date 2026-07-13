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
