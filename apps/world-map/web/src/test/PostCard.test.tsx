import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostCard } from "../components/wire/PostCard";
import type { WireActions } from "../components/wire/types";
import { makePost, makeSummary } from "./socialFixtures";

const NOW = Date.parse("2026-07-13T12:00:30Z");

function actions(): WireActions {
  return { openThread: vi.fn(), openAccount: vi.fn(), selectCiv: vi.fn() };
}

describe("PostCard", () => {
  it("renders author identity, kind, and minimal counts", () => {
    const post = makePost({ replyCount: 2, likeCount: 3 });
    render(<PostCard post={post} actions={actions()} nowMs={NOW} />);
    expect(screen.getByRole("button", { name: "Ada Vane" })).toBeInTheDocument();
    expect(screen.getByText(/2 replies · 3 likes/)).toBeInTheDocument();
  });

  it("marks an official account with TEXT, not color alone", () => {
    const post = makePost({ author: makeSummary({ actor: { civId: "civ_alpha", kind: "official", displayName: "President" } }) });
    render(<PostCard post={post} actions={actions()} nowMs={NOW} />);
    // The kind is encoded as readable text so it survives greyscale / screen readers.
    expect(screen.getByText("Official")).toBeInTheDocument();
  });

  it("links the author's civ affiliation back to the map", async () => {
    const acts = actions();
    const post = makePost();
    render(<PostCard post={post} actions={acts} nowMs={NOW} />);
    await userEvent.click(screen.getByRole("button", { name: /civ_alpha/ }));
    expect(acts.selectCiv).toHaveBeenCalledWith("civ_alpha");
  });

  it("renders post text as plain text, never as HTML (no injection)", () => {
    const raw = '<img src=x onerror="alert(1)"> <b>bold</b> javascript:evil #tag @who';
    const post = makePost({ text: raw });
    const { container } = render(<PostCard post={post} actions={actions()} nowMs={NOW} />);
    expect(screen.getByText(raw)).toBeInTheDocument();
    // The markup is inert: no real <img>/<b> element was created from the text.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("renders a tombstone as a clear text-free withdrawal, keeping the entry in place", () => {
    const post = makePost({ status: "tombstoned", text: null, replyCount: 1, tombstonedAt: "2026-07-13T12:00:00Z" });
    render(<PostCard post={post} actions={actions()} nowMs={NOW} />);
    expect(screen.getByText(/withdrawn by its author/i)).toBeInTheDocument();
    expect(screen.getByText(/1 reply/)).toBeInTheDocument(); // counts preserved
  });

  it("exposes only read-only navigation — no like/follow/reply/mutation controls", () => {
    const post = makePost();
    render(<PostCard post={post} actions={actions()} nowMs={NOW} />);
    const article = screen.getByRole("article");
    const buttons = within(article).getAllByRole("button");
    const labels = buttons.map((b) => (b.textContent ?? "").toLowerCase());
    for (const label of labels) {
      expect(label).not.toMatch(/\b(like|unlike|follow|unfollow|repost|reply to|delete|post)\b/);
    }
    // No form controls (textboxes) that would imply composing/mutating.
    expect(within(article).queryByRole("textbox")).toBeNull();
  });

  it("is an accessible article labelled by its author", () => {
    const post = makePost();
    render(<PostCard post={post} actions={actions()} nowMs={NOW} />);
    expect(screen.getByRole("article", { name: /Post by Ada Vane/ })).toBeInTheDocument();
  });
});
