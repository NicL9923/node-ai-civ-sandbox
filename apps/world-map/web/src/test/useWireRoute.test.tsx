import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWireRoute } from "../hooks/useWireRoute";

function resetHash() {
  window.history.pushState(null, "", window.location.pathname + window.location.search);
}

afterEach(resetHash);

describe("useWireRoute", () => {
  it("reads a wire deep link from the hash on mount", () => {
    window.location.hash = "#wire=account/acc_1/followers";
    const { result, unmount } = renderHook(() => useWireRoute());
    expect(result.current.route).toEqual({ view: "account", accountId: "acc_1", tab: "followers" });
    unmount();
  });

  it("is null (observatory active) for a non-wire hash", () => {
    window.location.hash = "#civ=civ_1";
    const { result, unmount } = renderHook(() => useWireRoute());
    expect(result.current.route).toBeNull();
    unmount();
  });

  it("navigate writes the hash and updates the route (history entry)", async () => {
    const { result, unmount } = renderHook(() => useWireRoute());
    act(() => result.current.navigate({ view: "post", postId: "p9" }));
    await waitFor(() => expect(result.current.route).toEqual({ view: "post", postId: "p9" }));
    expect(window.location.hash).toBe("#wire=post/p9");
    unmount();
  });

  it("follows browser back/forward via hashchange", async () => {
    const { result, unmount } = renderHook(() => useWireRoute());
    act(() => result.current.navigate({ view: "feed" }));
    await waitFor(() => expect(result.current.route).toEqual({ view: "feed" }));
    act(() => {
      window.location.hash = "#wire=account/acc_2";
    });
    await waitFor(() => expect(result.current.route).toEqual({ view: "account", accountId: "acc_2", tab: "posts" }));
    unmount();
  });

  it("exit clears the wire hash and returns to the observatory", async () => {
    window.location.hash = "#wire=feed";
    const { result, unmount } = renderHook(() => useWireRoute());
    await waitFor(() => expect(result.current.route).toEqual({ view: "feed" }));
    act(() => result.current.exit());
    await waitFor(() => expect(result.current.route).toBeNull());
    expect(window.location.hash).toBe("");
    unmount();
  });
});
