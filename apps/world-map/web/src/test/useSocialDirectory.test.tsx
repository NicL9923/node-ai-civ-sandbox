import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSocialDirectory } from "../hooks/useSocialDirectory";
import { SOCIAL_EVENT_TYPES } from "../domain/social";
import type { WorldEvent } from "../api/types";
import { makePost, makeSocialEvent, makeSummary } from "./socialFixtures";

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

describe("useSocialDirectory", () => {
  it("accrues civ→account discovery from live post authors", () => {
    const bus = makeBus();
    const { result } = renderHook(() => useSocialDirectory(bus.subscribe));
    expect(result.current.accountsForCiv("civ_alpha")).toEqual([]);

    const post = makePost({ author: makeSummary({ accountId: "acc_a", actor: { civId: "civ_alpha", kind: "agent", displayName: "A" } }) });
    act(() => bus.emit(makeSocialEvent(SOCIAL_EVENT_TYPES.postCreated, { post })));

    const accounts = result.current.accountsForCiv("civ_alpha");
    expect(accounts.map((a) => a.accountId)).toEqual(["acc_a"]);
  });

  it("records contributed summaries and dedupes by account", () => {
    const bus = makeBus();
    const { result } = renderHook(() => useSocialDirectory(bus.subscribe));
    const a = makeSummary({ accountId: "acc_a", actor: { civId: "civ_x", kind: "official", displayName: "Gov" } });
    act(() => result.current.record([a, a]));
    expect(result.current.accountsForCiv("civ_x").map((x) => x.accountId)).toEqual(["acc_a"]);
  });

  it("excludes system accounts (no civ affiliation)", () => {
    const bus = makeBus();
    const { result } = renderHook(() => useSocialDirectory(bus.subscribe));
    act(() => result.current.record([makeSummary({ accountId: "sys", actor: { civId: "world", kind: "system", displayName: "World" } })]));
    expect(result.current.accountsForCiv("world")).toEqual([]);
  });
});
