import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CivList } from "../components/common/CivList";
import { makeCiv } from "./fixtures";

const NOW = Date.parse("2026-07-13T12:00:00Z");

function setup(selectedCivId: string | null = null) {
  const civs = new Map([
    ["civ_alpha", makeCiv({ civId: "civ_alpha", displayName: "Alpha" })],
    ["civ_beta", makeCiv({ civId: "civ_beta", displayName: "Beta", running: false })],
  ]);
  const onSelect = vi.fn();
  render(
    <CivList
      civs={civs}
      civIds={["civ_alpha", "civ_beta"]}
      nowMs={NOW}
      selectedCivId={selectedCivId}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
}

describe("CivList", () => {
  it("renders a civilization per row", () => {
    setup();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("selects on click and on keyboard activation", async () => {
    const { onSelect } = setup();
    const rows = screen.getAllByRole("button");
    await userEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith("civ_alpha");

    rows[1].focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("civ_beta");
  });

  it("marks the selected row with aria-current", () => {
    setup("civ_alpha");
    const current = screen.getByRole("button", { current: true });
    expect(current).toHaveTextContent("Alpha");
  });

  it("communicates liveness with an accessible label, not color alone", () => {
    setup();
    // Beta is not running → "stopped"; Alpha is fresh → "Running, heartbeat is recent".
    expect(screen.getByLabelText(/reports it is not running/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/heartbeat is recent/i)).toBeInTheDocument();
  });
});
