import { describe, expect, it } from "vitest";
import { deriveFreshness, relativeAge, toEpochMs } from "../domain/freshness";

const NOW = Date.parse("2026-07-13T12:00:00Z");

describe("deriveFreshness", () => {
  it("returns 'stopped' when the civ reports not running, regardless of age", () => {
    const f = deriveFreshness(false, "2026-07-13T11:59:59Z", NOW);
    expect(f.state).toBe("stopped");
  });

  it("returns 'live' for a recent heartbeat", () => {
    const f = deriveFreshness(true, "2026-07-13T11:59:30Z", NOW); // 30s
    expect(f.state).toBe("live");
  });

  it("returns 'stale' between 90s and 300s", () => {
    const f = deriveFreshness(true, "2026-07-13T11:58:00Z", NOW); // 120s
    expect(f.state).toBe("stale");
  });

  it("returns 'offline' after 300s", () => {
    const f = deriveFreshness(true, "2026-07-13T11:50:00Z", NOW); // 600s
    expect(f.state).toBe("offline");
  });

  it("treats a missing/invalid timestamp as offline when running", () => {
    expect(deriveFreshness(true, null, NOW).state).toBe("offline");
    expect(deriveFreshness(true, "not-a-date", NOW).state).toBe("offline");
  });
});

describe("relativeAge", () => {
  it("formats seconds, minutes, hours, days", () => {
    expect(relativeAge(5_000)).toBe("5s ago");
    expect(relativeAge(90_000)).toBe("1m ago");
    expect(relativeAge(3 * 3_600_000)).toBe("3h ago");
    expect(relativeAge(2 * 86_400_000)).toBe("2d ago");
  });
  it("handles invalid input", () => {
    expect(relativeAge(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

describe("toEpochMs", () => {
  it("returns NaN for missing/invalid input", () => {
    expect(Number.isNaN(toEpochMs(null))).toBe(true);
    expect(Number.isNaN(toEpochMs("nope"))).toBe(true);
  });
});
