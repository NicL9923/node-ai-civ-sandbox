import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState, ErrorState, LoadingState } from "../components/common/StatusStates";

describe("status states", () => {
  it("LoadingState exposes a polite status label", () => {
    render(<LoadingState label="Loading world" />);
    expect(screen.getByText("Loading world")).toBeInTheDocument();
  });

  it("EmptyState renders its teaching copy", () => {
    render(<EmptyState title="Nothing yet">Register a civ to begin.</EmptyState>);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.getByText("Register a civ to begin.")).toBeInTheDocument();
  });

  it("ErrorState is an alert and retries", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="It broke" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("It broke");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
