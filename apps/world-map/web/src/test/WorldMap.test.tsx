import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorldMap } from "../components/map/WorldMap";
import { pairKey } from "../domain/relationships";
import { makeCiv, makeRelationship } from "./fixtures";

const NOW = Date.parse("2026-07-13T12:00:00Z");

function setup(reducedMotion = true) {
  const civs = new Map([
    ["civ_alpha", makeCiv({ civId: "civ_alpha", displayName: "Alpha" })],
    ["civ_beta", makeCiv({ civId: "civ_beta", displayName: "Beta" })],
  ]);
  const relationships = new Map([[pairKey("civ_alpha", "civ_beta"), makeRelationship()]]);
  const onSelectCiv = vi.fn();
  const onSelectRel = vi.fn();
  render(
    <WorldMap
      civs={civs}
      civIds={["civ_alpha", "civ_beta"]}
      relationships={relationships}
      nowMs={NOW}
      selection={null}
      onSelectCiv={onSelectCiv}
      onSelectRel={onSelectRel}
      reducedMotion={reducedMotion}
    />,
  );
  return { onSelectCiv, onSelectRel };
}

describe("WorldMap", () => {
  it("renders an accessible SVG group with a description", () => {
    setup();
    const group = screen.getByRole("group", { name: /world map of civilizations/i });
    expect(group).toBeInTheDocument();
  });

  it("renders each civ as a labelled, focusable node", () => {
    setup();
    const alpha = screen.getByRole("button", { name: /^Alpha\./ });
    expect(alpha).toHaveAttribute("tabindex", "0");
  });

  it("selects a civ by click and by keyboard", async () => {
    const { onSelectCiv } = setup();
    const alpha = screen.getByRole("button", { name: /^Alpha\./ });
    await userEvent.click(alpha);
    expect(onSelectCiv).toHaveBeenCalledWith("civ_alpha");

    const beta = screen.getByRole("button", { name: /^Beta\./ });
    beta.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelectCiv).toHaveBeenCalledWith("civ_beta");
  });

  it("renders the relationship as an accessible, selectable edge", async () => {
    const { onSelectRel } = setup();
    const edgeTitle = screen.getByText(/Alpha and Beta:/);
    expect(edgeTitle).toBeInTheDocument();
    // Click the edge group (the <title>'s parent).
    await userEvent.click(edgeTitle.parentElement as Element);
    expect(onSelectRel).toHaveBeenCalledWith("civ_alpha", "civ_beta");
  });

  it("tolerates an unknown relationship stance without throwing", () => {
    const civs = new Map([
      ["civ_alpha", makeCiv({ civId: "civ_alpha", displayName: "Alpha" })],
      ["civ_beta", makeCiv({ civId: "civ_beta", displayName: "Beta" })],
    ]);
    const relationships = new Map([
      [pairKey("civ_alpha", "civ_beta"), makeRelationship({ stance: "frenemy" })],
    ]);
    expect(() =>
      render(
        <WorldMap
          civs={civs}
          civIds={["civ_alpha", "civ_beta"]}
          relationships={relationships}
          nowMs={NOW}
          selection={null}
          onSelectCiv={vi.fn()}
          onSelectRel={vi.fn()}
          reducedMotion
        />,
      ),
    ).not.toThrow();
  });
});
