import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventFeed } from "../hooks/useEventFeed";
import { WorldTimeline } from "../components/panels/WorldTimeline";
import { makeCiv, makeEvent } from "./fixtures";

const NOW = Date.parse("2026-07-13T12:00:05Z");
const civs = new Map([
  ["civ_alpha", makeCiv({ civId: "civ_alpha", displayName: "Alpha" })],
  ["civ_beta", makeCiv({ civId: "civ_beta", displayName: "Beta" })],
]);

function makeFeed(overrides: Partial<EventFeed> = {}): EventFeed {
  return {
    visible: [],
    hasOlder: false,
    loadOlder: vi.fn(),
    status: "ready",
    error: null,
    connection: "open",
    latestWorldSequence: null,
    totalRetained: 0,
    refresh: vi.fn(),
    ...overrides,
  };
}

describe("WorldTimeline", () => {
  it("renders the public narrative as text", () => {
    render(<WorldTimeline feed={makeFeed({ visible: [makeEvent()], totalRetained: 1 })} civs={civs} nowMs={NOW} />);
    expect(screen.getByText("Alpha proposed new trade terms to Beta.")).toBeInTheDocument();
  });

  it("does not execute markup in narrative (no innerHTML)", () => {
    const evt = makeEvent({ id: "x", data: { publicNarrative: '<img src=x onerror="alert(1)">' } });
    const { container } = render(
      <WorldTimeline feed={makeFeed({ visible: [evt], totalRetained: 1 })} civs={civs} nowMs={NOW} />,
    );
    // Rendered verbatim as text, with no <img> element injected.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });

  it("shows a safe fallback when an event carries no public data", () => {
    // The API sends data:null for civ-ingested events (the generated type omits null — a
    // contract gap flagged in the PR); readData tolerates it at runtime.
    const evt = makeEvent({ id: "nodata", data: null as never, type: "world.civilization.contact.v1" });
    render(<WorldTimeline feed={makeFeed({ visible: [evt], totalRetained: 1 })} civs={civs} nowMs={NOW} />);
    expect(screen.getByText(/no public detail/i)).toBeInTheDocument();
  });

  it("reveals older events on demand", async () => {
    const loadOlder = vi.fn();
    render(
      <WorldTimeline
        feed={makeFeed({ visible: [makeEvent()], hasOlder: true, loadOlder, totalRetained: 50 })}
        civs={civs}
        nowMs={NOW}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /load older/i }));
    expect(loadOlder).toHaveBeenCalledOnce();
  });

  it("renders an empty state when there are no events", () => {
    render(<WorldTimeline feed={makeFeed()} civs={civs} nowMs={NOW} />);
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it("renders loading and error states", () => {
    const { rerender } = render(<WorldTimeline feed={makeFeed({ status: "loading" })} civs={civs} nowMs={NOW} />);
    expect(screen.getByText(/loading the world timeline/i)).toBeInTheDocument();

    rerender(
      <WorldTimeline feed={makeFeed({ status: "error", error: "nope" })} civs={civs} nowMs={NOW} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("nope");
  });
});
