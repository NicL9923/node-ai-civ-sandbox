import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WireSurface } from "../components/wire/WireSurface";
import type { SocialDirectory } from "../hooks/useSocialDirectory";
import { makeAccount, makePost } from "./socialFixtures";

const BASE = "http://test.local/world/v1";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
const directory: SocialDirectory = { accountsForCiv: () => [], record: vi.fn() };
const noopSubscribe = () => () => {};
const NOW = Date.parse("2026-07-13T12:00:30Z");

afterEach(() => vi.unstubAllGlobals());

describe("WireSurface", () => {
  it("renders the global feed deep link as an accessible feed of posts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/social/feed")) {
          return json({ items: [makePost({ postId: "p1", text: "Hello world" })], nextCursor: null });
        }
        throw new Error("unexpected");
      }),
    );
    render(
      <WireSurface
        route={{ view: "feed" }}
        navigate={vi.fn()}
        exitToObservatory={vi.fn()}
        onSelectCiv={vi.fn()}
        subscribe={noopSubscribe}
        directory={directory}
        nowMs={NOW}
        baseUrl={BASE}
      />,
    );
    await waitFor(() => expect(screen.getByText("Hello world")).toBeInTheDocument());
    expect(screen.getByRole("feed")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /Post by/ })).toBeInTheDocument();
  });

  it("returns to the observatory from the breadcrumb", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ items: [], nextCursor: null })));
    const exit = vi.fn();
    render(
      <WireSurface
        route={{ view: "feed" }}
        navigate={vi.fn()}
        exitToObservatory={exit}
        onSelectCiv={vi.fn()}
        subscribe={noopSubscribe}
        directory={directory}
        nowMs={NOW}
        baseUrl={BASE}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Observatory/ }));
    expect(exit).toHaveBeenCalled();
  });

  it("opens a post's thread from a feed card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/social/feed")) return json({ items: [makePost({ postId: "p1" })], nextCursor: null });
        throw new Error("unexpected");
      }),
    );
    const navigate = vi.fn();
    render(
      <WireSurface
        route={{ view: "feed" }}
        navigate={navigate}
        exitToObservatory={vi.fn()}
        onSelectCiv={vi.fn()}
        subscribe={noopSubscribe}
        directory={directory}
        nowMs={NOW}
        baseUrl={BASE}
      />,
    );
    await waitFor(() => screen.getByRole("article"));
    await userEvent.click(screen.getByRole("button", { name: /View thread/ }));
    expect(navigate).toHaveBeenCalledWith({ view: "post", postId: "p1" });
  });

  it("renders an account profile with tabs and navigates on tab change (no follow button)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/accounts/acc_alpha/posts")) return json({ items: [makePost({ postId: "p1" })], nextCursor: null });
        if (url.includes("/social/accounts/acc_alpha")) return json(makeAccount());
        throw new Error(`unexpected ${url}`);
      }),
    );
    const navigate = vi.fn();
    render(
      <WireSurface
        route={{ view: "account", accountId: "acc_alpha", tab: "posts" }}
        navigate={navigate}
        exitToObservatory={vi.fn()}
        onSelectCiv={vi.fn()}
        subscribe={noopSubscribe}
        directory={directory}
        nowMs={NOW}
        baseUrl={BASE}
      />,
    );
    await waitFor(() => expect(screen.getByRole("tablist", { name: /Profile sections/ })).toBeInTheDocument());

    // No follow / mutation controls anywhere on the profile.
    const buttons = screen.getAllByRole("button").map((b) => (b.textContent ?? "").toLowerCase());
    for (const label of buttons) {
      expect(label).not.toMatch(/\b(follow|unfollow|like|post|delete)\b/);
    }

    await userEvent.click(screen.getByRole("tab", { name: "Followers" }));
    expect(navigate).toHaveBeenCalledWith({ view: "account", accountId: "acc_alpha", tab: "followers" });
  });
});
