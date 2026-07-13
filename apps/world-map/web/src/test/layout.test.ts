import { describe, expect, it } from "vitest";
import { civLayout, projectToViewBox } from "../domain/layout";

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
