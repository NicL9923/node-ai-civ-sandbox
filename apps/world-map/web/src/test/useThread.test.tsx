import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useThread } from "../hooks/useThread";
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

const root = makePost({ postId: "root", conversationRootPostId: "root", replyDepth: 0, worldsequence: "1" });
const reply = makePost({
  postId: "r1",
  parentPostId: "root",
  conversationRootPostId: "root",
  replyDepth: 1,
  worldsequence: "2",
});

afterEach(() => vi.unstubAllGlobals());

describe("useThread", () => {
  it("loads the focal post and the conversation oldest-first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root, reply], nextCursor: null });
        if (url.includes("/social/posts/root")) return json(root);
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useThread("root", bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.posts.map((p) => p.postId)).toEqual(["root", "r1"]); // oldest first
    await waitFor(() => expect(result.current.focal?.postId).toBe("root"));
    unmount();
  });

  it("appends a live reply that belongs to this conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root], nextCursor: null });
        if (url.includes("/social/posts/root")) return json(root);
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useThread("root", bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    act(() => bus.emit(makeSocialEvent(SOCIAL_EVENT_TYPES.replyCreated, { post: reply })));
    expect(result.current.posts.map((p) => p.postId)).toEqual(["root", "r1"]); // appended at tail

    // A reply for a different conversation is ignored.
    const other = makePost({ postId: "x", conversationRootPostId: "other", parentPostId: "other", replyDepth: 1, worldsequence: "9" });
    act(() => bus.emit(makeSocialEvent(SOCIAL_EVENT_TYPES.replyCreated, { post: other })));
    expect(result.current.posts.map((p) => p.postId)).toEqual(["root", "r1"]);
    unmount();
  });

  it("tombstones a member and the focal post from an event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root, reply], nextCursor: null });
        if (url.includes("/social/posts/root")) return json(root);
        throw new Error(`unexpected ${url}`);
      }),
    );
    const bus = makeBus();
    const { result, unmount } = renderHook(() => useThread("root", bus.subscribe, BASE), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.posts).toHaveLength(2));

    act(() =>
      bus.emit(
        makeSocialEvent(SOCIAL_EVENT_TYPES.postTombstoned, {
          postId: "root",
          authorAccountId: "acc_alpha",
          conversationRootPostId: "root",
          tombstonedAt: "2026-07-13T13:00:00Z",
        }),
      ),
    );
    expect(result.current.posts.find((p) => p.postId === "root")?.status).toBe("tombstoned");
    await waitFor(() => expect(result.current.focal?.status).toBe("tombstoned"));
    unmount();
  });
});
