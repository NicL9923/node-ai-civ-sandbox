import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostThread } from "../components/wire/PostThread";
import type { SocialDirectory } from "../hooks/useSocialDirectory";
import type { WireActions } from "../components/wire/types";
import type { WorldEvent } from "../api/types";
import { SOCIAL_EVENT_TYPES } from "../domain/social";
import { makePost, makeSocialEvent, makeSummary } from "./socialFixtures";

const BASE = "http://test.local/world/v1";
const NOW = Date.parse("2026-07-13T12:05:00Z");

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
const directory: SocialDirectory = { accountsForCiv: () => [], record: vi.fn() };
function actions(): WireActions {
  return { openThread: vi.fn(), openAccount: vi.fn(), selectCiv: vi.fn() };
}

const root = makePost({ postId: "root", conversationRootPostId: "root", replyDepth: 0, worldsequence: "1", text: "Root of the thread" });
// A deep reply beyond the loaded window / retained cap — the deep-link target.
const deep = makePost({
  postId: "deep",
  parentPostId: "root",
  conversationRootPostId: "root",
  replyDepth: 3,
  worldsequence: "900",
  text: "The linked deep reply",
  author: makeSummary({ accountId: "acc_beta", actor: { civId: "civ_beta", kind: "official", displayName: "Office of Beta" } }),
});

beforeAll(() => {
  // jsdom has no layout; PostThread calls scrollIntoView on the focused article.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

function renderThread(postId: string, bus = makeBus()) {
  return {
    bus,
    ...render(
      <PostThread postId={postId} subscribe={bus.subscribe} directory={directory} actions={actions()} nowMs={NOW} baseUrl={BASE} />,
    ),
  };
}

describe("PostThread — focal deep-link rendering", () => {
  it("renders a focal post outside the loaded thread once, in a pinned focused section, highlighted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root], nextCursor: null });
        if (url.includes("/social/posts/deep")) return json(deep);
        throw new Error(`unexpected ${url}`);
      }),
    );
    renderThread("deep");
    await waitFor(() => expect(screen.getByText("Focused post")).toBeInTheDocument());

    // Focal text appears exactly once (no duplication).
    expect(screen.getAllByText("The linked deep reply")).toHaveLength(1);
    // It is highlighted (aria-current on its article) and lives in the pinned section.
    const focalArticle = screen.getByRole("article", { name: /Post by Office of Beta/ });
    expect(focalArticle).toHaveAttribute("aria-current", "true");
    // The chronological context is still there and undistorted.
    expect(screen.getByText("Root of the thread")).toBeInTheDocument();
  });

  it("does not duplicate a focal post already present in the loaded thread; highlights the row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root, deep], nextCursor: null });
        if (url.includes("/social/posts/deep")) return json(deep);
        throw new Error(`unexpected ${url}`);
      }),
    );
    renderThread("deep");
    await waitFor(() => expect(screen.getByText("The linked deep reply")).toBeInTheDocument());

    // No pinned section, and the focal appears exactly once.
    expect(screen.queryByText("Focused post")).toBeNull();
    expect(screen.getAllByText("The linked deep reply")).toHaveLength(1);
    // The in-thread row is highlighted.
    const focalArticle = screen.getByRole("article", { name: /Post by Office of Beta/ });
    expect(focalArticle).toHaveAttribute("aria-current", "true");
  });

  it("removes the pinned duplicate once pagination reaches the focal post, keeping the highlight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("cursor=c1")) return json({ conversationRootPostId: "root", items: [deep], nextCursor: null });
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root], nextCursor: "c1" });
        if (url.includes("/social/posts/deep")) return json(deep);
        throw new Error(`unexpected ${url}`);
      }),
    );
    renderThread("deep");
    await waitFor(() => expect(screen.getByText("Focused post")).toBeInTheDocument());
    expect(screen.getAllByText("The linked deep reply")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /Load more replies/ }));

    // Pinned section is gone, focal now lives in the thread exactly once, still highlighted.
    await waitFor(() => expect(screen.queryByText("Focused post")).toBeNull());
    expect(screen.getAllByText("The linked deep reply")).toHaveLength(1);
    const focalArticle = screen.getByRole("article", { name: /Post by Office of Beta/ });
    expect(focalArticle).toHaveAttribute("aria-current", "true");
  });

  it("renders a tombstoned focal safely in the pinned section", async () => {
    const deadFocal = { ...deep, status: "tombstoned" as const, text: null, tombstonedAt: "2026-07-13T12:04:00Z" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root], nextCursor: null });
        if (url.includes("/social/posts/deep")) return json(deadFocal);
        throw new Error(`unexpected ${url}`);
      }),
    );
    renderThread("deep");
    await waitFor(() => expect(screen.getByText("Focused post")).toBeInTheDocument());
    const focused = screen.getByText("Focused post").closest(".wire-focused") as HTMLElement;
    expect(within(focused).getByText(/withdrawn by its author/i)).toBeInTheDocument();
    // No leaked original text.
    expect(screen.queryByText("The linked deep reply")).toBeNull();
  });

  it("applies a live tombstone to a pinned focal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root], nextCursor: null });
        if (url.includes("/social/posts/deep")) return json(deep);
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { bus } = renderThread("deep");
    await waitFor(() => expect(screen.getByText("The linked deep reply")).toBeInTheDocument());

    bus.emit(
      makeSocialEvent(SOCIAL_EVENT_TYPES.postTombstoned, {
        postId: "deep",
        authorAccountId: "acc_beta",
        conversationRootPostId: "root",
        tombstonedAt: "2026-07-13T12:04:30Z",
      }),
    );
    await waitFor(() => expect(screen.getByText(/withdrawn by its author/i)).toBeInTheDocument());
    expect(screen.queryByText("The linked deep reply")).toBeNull();
  });

  it("keeps the thread usable when the focal GET fails but the conversation loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return json({ conversationRootPostId: "root", items: [root], nextCursor: null });
        if (url.includes("/social/posts/deep")) return new Response("nope", { status: 404 });
        throw new Error(`unexpected ${url}`);
      }),
    );
    renderThread("deep");
    // Conversation remains readable.
    await waitFor(() => expect(screen.getByText("Root of the thread")).toBeInTheDocument());
    // No pinned section; an honest note about the linked post; no crash / no error state.
    expect(screen.queryByText("Focused post")).toBeNull();
    expect(screen.getByText(/Couldn't load the linked post/i)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /Conversation, oldest first/ })).toBeInTheDocument();
  });

  it("stays in the loading state (no false empty flash) when the focal GET errors before the thread loads", async () => {
    // The focal single-post GET can resolve (here: 404) before the heavier /thread page. The loading
    // gate must not drop to "No conversation found" while the conversation is still in flight.
    let resolveThread!: (r: Response) => void;
    const threadPromise = new Promise<Response>((r) => {
      resolveThread = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/thread")) return threadPromise;
        if (url.includes("/social/posts/deep")) return Promise.resolve(new Response("nope", { status: 404 }));
        throw new Error(`unexpected ${url}`);
      }),
    );
    renderThread("deep");

    // Focal has errored; the thread is still pending → show the loading skeleton, never a false empty.
    await waitFor(() => expect(screen.getByText("Loading the conversation…")).toBeInTheDocument());
    expect(screen.queryByText("No conversation found")).toBeNull();

    resolveThread(json({ conversationRootPostId: "root", items: [root], nextCursor: null }));
    await waitFor(() => expect(screen.getByText("Root of the thread")).toBeInTheDocument());
    expect(screen.queryByText("No conversation found")).toBeNull();
  });
});
