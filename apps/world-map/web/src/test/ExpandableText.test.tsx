import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExpandableText } from "../components/common/ExpandableText";

const LONG = "A".repeat(120) + " and then some more narrative text that pushes it well past the clamp threshold.";

describe("ExpandableText", () => {
  it("renders short text without a toggle", () => {
    render(<ExpandableText text="short narrative" />);
    expect(screen.getByText("short narrative")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clamps long text and expands/collapses accessibly", async () => {
    render(<ExpandableText text={LONG} />);
    const toggle = screen.getByRole("button", { name: /show more/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Clamped: the ellipsis is shown and the full text is not yet present.
    expect(screen.getByText(/…$/)).toBeInTheDocument();

    await userEvent.click(toggle);
    const collapse = screen.getByRole("button", { name: /show less/i });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(LONG)).toBeInTheDocument();

    await userEvent.click(collapse);
    expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
  });

  it("renders markup as text (no innerHTML)", async () => {
    const malicious = "<img src=x onerror=alert(1)> " + "z".repeat(200);
    const { container } = render(<ExpandableText text={malicious} />);
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(malicious)).toBeInTheDocument();
  });
});
