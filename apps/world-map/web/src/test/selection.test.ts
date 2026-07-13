import { describe, expect, it } from "vitest";
import { parseSelectionHash, selectionToHash } from "../hooks/useSelection";

describe("parseSelectionHash", () => {
  it("parses a civ selection", () => {
    expect(parseSelectionHash("#civ=civ_1")).toEqual({ kind: "civ", civId: "civ_1" });
  });

  it("parses a relationship selection and canonicalizes order", () => {
    expect(parseSelectionHash("#rel=civ_b~civ_a")).toEqual({ kind: "rel", a: "civ_a", b: "civ_b" });
  });

  it("returns null for empty or unknown hashes", () => {
    expect(parseSelectionHash("")).toBeNull();
    expect(parseSelectionHash("#")).toBeNull();
    expect(parseSelectionHash("#other=x")).toBeNull();
    expect(parseSelectionHash("#rel=onlyone")).toBeNull();
  });

  it("decodes percent-encoded ids", () => {
    expect(parseSelectionHash("#civ=civ%20one")).toEqual({ kind: "civ", civId: "civ one" });
  });
});

describe("selectionToHash", () => {
  it("round-trips civ and rel selections", () => {
    for (const sel of [
      { kind: "civ", civId: "civ_1" } as const,
      { kind: "rel", a: "civ_a", b: "civ_b" } as const,
    ]) {
      expect(parseSelectionHash(selectionToHash(sel))).toEqual(sel);
    }
  });

  it("serializes null to an empty string", () => {
    expect(selectionToHash(null)).toBe("");
  });
});
