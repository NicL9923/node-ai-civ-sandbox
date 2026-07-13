import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInitialState, loadState, saveState, serializeState } from "../src/state.js";
import { FakeCivilization } from "../src/fake-civilization.js";

describe("fake civilization state", () => {
  it("persists only state supplied to it atomically", async () => {
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    const serialized = serializeState(state);
    expect(serialized).not.toContain("onboardingToken");
    expect(serialized).not.toContain("hmacSecret");
    const path = join(process.cwd(), "test", "fake-civilization", ".state-test.json");
    try {
      await saveState(path, state);
      expect(await loadState(path)).toEqual(state);
    } finally {
      await rm(path, { force: true });
    }
  });

  it("reserves deterministic event ids when events are created", () => {
    const state = createInitialState("Aurora", "1.0.0");
    state.registration = {
      civId: "civ_aurora",
      keyId: "key_aurora",
      protocolVersion: "1",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    const civilization = new FakeCivilization({
      alias: "aurora",
      displayName: "Aurora",
      worldBaseUrl: "https://world.test/world/v1",
      capabilities: { protocolVersion: "1.0.0", supportedInteractionKinds: ["contact"] },
    }, { state, clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } });
    expect(civilization.createEvent("civ.test.v1", {}).id).toBe("aurora-evt-1");
    expect(civilization.createEvent("civ.test.v1", {}).id).toBe("aurora-evt-2");
    expect(state.nextEventSequence).toBe(3);
  });
});
