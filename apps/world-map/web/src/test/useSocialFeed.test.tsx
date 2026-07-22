import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSocialFeed } from "../hooks/useSocialFeed";
import { SOCIAL_EVENT_TYPES } from "../domain/social";
import type { WorldEvent } from "../api/types";
import { makePost, makeSocialEvent } from "./socialFixtures";

const BASE = "http://test.local/world/v1";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeBus() {
  const listeners = new Set<(e: WorldEvent) => void>();
  return {
    subscribe: (l: (e: WorldEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (e: WorldEvent) => {
      for (const l of [...listeners]) l(e);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useSocialFeed", () => {
  it("loads a newest-first snapshot and reports hasMore from the cursor", async () => {
    const p3 = makePost({ postId: "p3", worldsequence: "3" });
    const p2 = makePost({ postId: "p2", worldsequence: "2" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/feed")) return json({ items: [p3, p2], nextCursor: "c1" });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useSocialFeed(bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.posts.map((p) => p.postId)).toEqual(["p3", "p2"]);
    expect(result.current.hasMore).toBe(true);
    unmount();
  });

  it("appends older posts on load more and stops at a null cursor", async () => {
    const first = [makePost({ postId: "p3", worldsequence: "3" })];
    const older = [makePost({ postId: "p2", worldsequence: "2" })];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("cursor=c1")) return json({ items: older, nextCursor: null });
        if (url.includes("/social/feed")) return json({ items: first, nextCursor: "c1" });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useSocialFeed(bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.posts.map((p) => p.postId)).toEqual(["p3", "p2"]));
    expect(result.current.hasMore).toBe(false);
    unmount();
  });

  it("prepends a live post to the head and marks it new (without corrupting older pages)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/feed")) {
          return json({ items: [makePost({ postId: "p2", worldsequence: "2" })], nextCursor: "c1" });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useSocialFeed(bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    const live = makePost({ postId: "p9", worldsequence: "9" });
    act(() => bus.emit(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, { post: live })));

    expect(result.current.posts.map((p) => p.postId)).toEqual(["p9", "p2"]); // newest on top
    expect(result.current.liveIds.has("p9")).toBe(true);
    expect(result.current.hasMore).toBe(true); // older-page cursor unaffected
    unmount();
  });

  it("refetches a post's counts when a like event touches a displayed post", async () => {
    const original = makePost({ postId: "p2", worldsequence: "2", likeCount: 0 });
    const refreshed = makePost({ postId: "p2", worldsequence: "2", likeCount: 7 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/posts/p2")) return json(refreshed);
        if (url.includes("/social/feed")) return json({ items: [original], nextCursor: null });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useSocialFeed(bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    act(() => bus.emit(makeSocialEvent(SOCIAL_EVENT_TYPES.postLiked, { postId: "p2", accountId: "a" })));
    await waitFor(() => expect(result.current.posts[0].likeCount).toBe(7));
    unmount();
  });

  it("applies a tombstone in place from the event (clears text, keeps position)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/feed")) {
          return json({ items: [makePost({ postId: "p2", worldsequence: "2", text: "secret" })], nextCursor: null });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useSocialFeed(bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    act(() =>
      bus.emit(
        makeSocialEvent(SOCIAL_EVENT_TYPES.postTombstoned, {
          postId: "p2",
          authorAccountId: "acc_alpha",
          conversationRootPostId: "p2",
          tombstonedAt: "2026-07-13T13:00:00Z",
        }),
      ),
    );
    expect(result.current.posts[0].status).toBe("tombstoned");
    expect(result.current.posts[0].text).toBeNull();
    unmount();
  });

  it("refresh re-opens a fresh snapshot and clears live markers", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/social/feed")) {
          call += 1;
          return json({ items: [makePost({ postId: `snap${call}`, worldsequence: String(call) })], nextCursor: null });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useSocialFeed(bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    act(() => bus.emit(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, { post: makePost({ postId: "live", worldsequence: "99" }) })));
    expect(result.current.liveIds.size).toBe(1);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.posts.some((p) => p.postId.startsWith("snap"))).toBe(true));
    expect(result.current.liveIds.size).toBe(0);
    expect(result.current.posts.some((p) => p.postId === "live")).toBe(false);
    unmount();
  });
});
