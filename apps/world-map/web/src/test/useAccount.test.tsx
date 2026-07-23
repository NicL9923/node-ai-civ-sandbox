import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { useAccount, useAccountTab } from "../hooks/useAccount";
import type { SocialPost, SocialAccountSummary } from "../api/social";
import { makeAccount, makePost, makeSummary } from "./socialFixtures";

const BASE = "http://test.local/world/v1";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("useAccount", () => {
  it("loads the public account header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/accounts/acc_alpha")) return json(makeAccount());
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { result, unmount } = renderHook(() => useAccount("acc_alpha", BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.account?.accountId).toBe("acc_alpha");
    expect(result.current.account?.followerCount).toBe(12);
    unmount();
  });

  it("surfaces an error state on a failed load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const { result, unmount } = renderHook(() => useAccount("acc_missing", BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.account).toBeNull();
    unmount();
  });
});

describe("useAccountTab", () => {
  it("loads the posts tab as SocialPosts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/posts")) return json({ items: [makePost({ postId: "p1" })], nextCursor: null });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { result, unmount } = renderHook(() => useAccountTab("acc_alpha", "posts", BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect((result.current.items[0] as SocialPost).postId).toBe("p1");
    unmount();
  });

  it("loads the followers tab as account summaries with pagination", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/followers")) {
          return json({ items: [makeSummary({ accountId: "acc_b" })], nextCursor: null });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { result, unmount } = renderHook(() => useAccountTab("acc_alpha", "followers", BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect((result.current.items[0] as SocialAccountSummary).accountId).toBe("acc_b");
    expect(result.current.hasMore).toBe(false);
    unmount();
  });

  it("re-opens a fresh snapshot when the tab changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/following")) return json({ items: [makeSummary({ accountId: "acc_f" })], nextCursor: null });
      if (url.includes("/posts")) return json({ items: [makePost({ postId: "p1" })], nextCursor: null });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender, unmount } = renderHook(({ tab }: { tab: "posts" | "following" }) => useAccountTab("acc_alpha", tab, BASE), {
      wrapper: StrictMode,
      initialProps: { tab: "posts" } as { tab: "posts" | "following" },
    });
    await waitFor(() => expect((result.current.items[0] as SocialPost).postId).toBe("p1"));
    rerender({ tab: "following" });
    await waitFor(() => expect((result.current.items[0] as SocialAccountSummary).accountId).toBe("acc_f"));
    unmount();
  });
});
