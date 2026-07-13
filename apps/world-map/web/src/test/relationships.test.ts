import { describe, expect, it } from "vitest";
import {
  dashArray,
  edgeTreatment,
  pairKey,
  splitPairKey,
  trustWeight,
} from "../domain/relationships";
import { makeRelationship } from "./fixtures";

describe("pairKey", () => {
  it("is canonical (order-independent)", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });
  it("round-trips through splitPairKey", () => {
    expect(splitPairKey(pairKey("civ_a", "civ_b"))).toEqual(["civ_a", "civ_b"]);
  });
});

describe("trustWeight", () => {
  it("maps trust monotonically to stroke width within bounds", () => {
    const low = trustWeight(-1);
    const mid = trustWeight(0);
    const high = trustWeight(1);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(1);
    expect(high).toBeLessThanOrEqual(3.5);
  });
  it("clamps out-of-range and non-finite input", () => {
    expect(trustWeight(5)).toBeLessThanOrEqual(3.5);
    expect(trustWeight(Number.NaN)).toBeGreaterThanOrEqual(1);
  });
});

describe("edgeTreatment", () => {
  it("maps each known stance to a distinct pattern", () => {
    const patterns = (["allied", "friendly", "neutral", "wary", "hostile"] as const).map(
      (stance) => edgeTreatment(makeRelationship({ stance })).pattern,
    );
    expect(new Set(patterns).size).toBe(5);
  });

  it("tolerates unknown stances with a dotted, flagged treatment", () => {
    const t = edgeTreatment(makeRelationship({ stance: "frenemy" }));
    expect(t.known).toBe(false);
    expect(t.pattern).toBe("dotted");
    expect(t.description).toContain("unrecognized");
  });

  it("marks high threat with signal emphasis", () => {
    expect(edgeTreatment(makeRelationship({ threat: 60 })).emphasis).toBe("threat");
    expect(edgeTreatment(makeRelationship({ threat: 10 })).emphasis).toBe("none");
  });

  it("encodes trust in stroke width, not color", () => {
    const trusting = edgeTreatment(makeRelationship({ trust: 1 }));
    const distrusting = edgeTreatment(makeRelationship({ trust: -1 }));
    expect(trusting.strokeWidth).toBeGreaterThan(distrusting.strokeWidth);
  });
});

describe("dashArray", () => {
  it("returns dash patterns only for dashed/dotted", () => {
    expect(dashArray("dashed")).toBeDefined();
    expect(dashArray("dotted")).toBeDefined();
    expect(dashArray("solid")).toBeUndefined();
    expect(dashArray("double")).toBeUndefined();
  });
});
