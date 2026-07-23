import { describe, expect, it } from "vitest";
import {
  isWireHash,
  parseWireHash,
  wireRouteToHash,
  WIRE_TABS,
  type WireRoute,
} from "../domain/wireRouting";

describe("wireRouting", () => {
  it("detects wire hashes and ignores observatory hashes", () => {
    expect(isWireHash("#wire=feed")).toBe(true);
    expect(isWireHash("wire=account/acc_1")).toBe(true);
    expect(isWireHash("#wire")).toBe(true);
    expect(isWireHash("#civ=civ_1")).toBe(false);
    expect(isWireHash("#rel=a~b")).toBe(false);
    expect(isWireHash("")).toBe(false);
  });

  it("returns null for non-wire hashes so useSelection can own them", () => {
    expect(parseWireHash("#civ=civ_1")).toBeNull();
    expect(parseWireHash("")).toBeNull();
    expect(parseWireHash("#rel=a~b")).toBeNull();
  });

  it("parses the feed landing (bare, empty, and explicit)", () => {
    expect(parseWireHash("#wire")).toEqual({ view: "feed" });
    expect(parseWireHash("#wire=")).toEqual({ view: "feed" });
    expect(parseWireHash("#wire=feed")).toEqual({ view: "feed" });
  });

  it("parses account routes with an optional, validated tab", () => {
    expect(parseWireHash("#wire=account/acc_1")).toEqual({ view: "account", accountId: "acc_1", tab: "posts" });
    expect(parseWireHash("#wire=account/acc_1/followers")).toEqual({
      view: "account",
      accountId: "acc_1",
      tab: "followers",
    });
    // Unknown tab falls back to posts.
    expect(parseWireHash("#wire=account/acc_1/bogus")).toEqual({ view: "account", accountId: "acc_1", tab: "posts" });
    // Missing account id falls back to the feed.
    expect(parseWireHash("#wire=account/")).toEqual({ view: "feed" });
  });

  it("parses post/thread routes and decodes opaque ids", () => {
    expect(parseWireHash("#wire=post/post_9")).toEqual({ view: "post", postId: "post_9" });
    expect(parseWireHash(`#wire=post/${encodeURIComponent("post/with~weird")}`)).toEqual({
      view: "post",
      postId: "post/with~weird",
    });
    expect(parseWireHash("#wire=post/")).toEqual({ view: "feed" });
  });

  it("round-trips every route shape through serialize → parse", () => {
    const routes: WireRoute[] = [
      { view: "feed" },
      { view: "post", postId: "post_1" },
      ...WIRE_TABS.map((tab) => ({ view: "account" as const, accountId: "acc_1", tab })),
    ];
    for (const route of routes) {
      expect(parseWireHash(wireRouteToHash(route))).toEqual(route);
    }
  });

  it("omits the default posts tab from the serialized account hash", () => {
    expect(wireRouteToHash({ view: "account", accountId: "acc_1", tab: "posts" })).toBe("#wire=account/acc_1");
    expect(wireRouteToHash({ view: "account", accountId: "acc_1", tab: "feed" })).toBe("#wire=account/acc_1/feed");
  });

  it("encodes ids that contain hash/slash characters", () => {
    const hash = wireRouteToHash({ view: "post", postId: "a/b#c" });
    expect(hash).toBe(`#wire=post/${encodeURIComponent("a/b#c")}`);
    expect(parseWireHash(hash)).toEqual({ view: "post", postId: "a/b#c" });
  });
});
