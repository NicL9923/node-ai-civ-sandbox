import { describe, expect, it } from "vitest";
import { civLayout, layoutCivs, projectToViewBox } from "../domain/layout";

describe("civLayout", () => {
  it("is deterministic for a given civId", () => {
    const a = civLayout("civ_alpha");
    const b = civLayout("civ_alpha");
    expect(a).toEqual(b);
  });

  it("produces different positions for different ids", () => {
    const a = civLayout("civ_alpha");
    const b = civLayout("civ_beta");
    expect(a).not.toEqual(b);
  });

  it("is independent of other civs (position is a pure function of the id)", () => {
    // Adding/removing other civs never changes an existing civ's placement.
    const before = civLayout("civ_gamma");
    // simulate other work
    civLayout("civ_delta");
    civLayout("civ_epsilon");
    const after = civLayout("civ_gamma");
    expect(after).toEqual(before);
  });

  it("stays within the unit disc", () => {
    for (const id of ["a", "civ_1", "civ_longer_name_42", "zzz", "Ω-civ"]) {
      const p = civLayout(id);
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("projectToViewBox", () => {
  it("maps the disc center to the viewBox center", () => {
    const p = projectToViewBox({ x: 0, y: 0 }, 1000, 100);
    expect(p).toEqual({ x: 500, y: 500 });
  });

  it("keeps points inside the padded frame", () => {
    const p = projectToViewBox({ x: 1, y: 0 }, 1000, 100);
    expect(p.x).toBeLessThanOrEqual(900);
    expect(p.x).toBeGreaterThanOrEqual(100);
  });
});

describe("layoutCivs", () => {
  const ids = Array.from({ length: 24 }, (_, i) => `civ_${i}`);
  const SIZE = 1000;
  const PAD = 96;
  const MIN = 44;
  const usable = (SIZE - PAD * 2) / 2;

  function asObject(map: Map<string, { x: number; y: number }>) {
    return Object.fromEntries([...map.entries()].map(([k, v]) => [k, v]));
  }

  it("handles empty and single-civ inputs", () => {
    expect(layoutCivs([]).size).toBe(0);
    const one = layoutCivs(["civ_solo"]);
    expect(one.size).toBe(1);
  });

  it("is deterministic and independent of input order", () => {
    const a = layoutCivs(ids, SIZE, PAD, MIN);
    const b = layoutCivs([...ids].reverse(), SIZE, PAD, MIN);
    expect(asObject(a)).toEqual(asObject(b));
  });

  it("resolves collisions so no two nodes are closer than the minimum distance", () => {
    const pts = [...layoutCivs(ids, SIZE, PAD, MIN).values()];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        expect(d).toBeGreaterThanOrEqual(MIN - 1e-6);
      }
    }
  });

  it("keeps every node bounded within the padded disc", () => {
    for (const p of layoutCivs(ids, SIZE, PAD, MIN).values()) {
      expect(Math.hypot(p.x - SIZE / 2, p.y - SIZE / 2)).toBeLessThanOrEqual(usable + 1e-6);
    }
  });

  it("stays bounded even when heavily overcrowded", () => {
    // Tiny disc, many civs → collisions cannot all be resolved, but output must stay bounded.
    const many = Array.from({ length: 60 }, (_, i) => `crowd_${i}`);
    const small = layoutCivs(many, 200, 20, 40);
    const u = (200 - 40) / 2;
    for (const p of small.values()) {
      expect(Math.hypot(p.x - 100, p.y - 100)).toBeLessThanOrEqual(u + 1e-6);
    }
    // Deterministic under crowding too.
    expect(asObject(small)).toEqual(asObject(layoutCivs([...many].reverse(), 200, 20, 40)));
  });

  it("adding a civ does not move civs placed before it", () => {
    const base = layoutCivs(ids, SIZE, PAD, MIN);
    // Sorts after every "civ_N", so all existing nodes are placed before it and keep their spots.
    const withNew = layoutCivs([...ids, "zzz_new"], SIZE, PAD, MIN);
    for (const id of ids) {
      expect(withNew.get(id)).toEqual(base.get(id));
    }
  });
});
