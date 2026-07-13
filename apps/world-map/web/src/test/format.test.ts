import { describe, expect, it } from "vitest";
import { formatPopulation, formatTreasury, humanize, toPercent } from "../domain/format";

describe("format helpers", () => {
  it("formats population compactly and handles missing values", () => {
    expect(formatPopulation(1_200_000)).toBe("1.2M");
    expect(formatPopulation(340_000)).toBe("340K");
    expect(formatPopulation(null)).toBe("unknown");
  });

  it("formats treasury with a currency and a safe default", () => {
    expect(formatTreasury(48_000, "credits")).toBe("48K credits");
    expect(formatTreasury(1000, null)).toContain("credits");
    expect(formatTreasury(null, "credits")).toBe("not reported");
  });

  it("humanizes labels and tolerates missing values", () => {
    expect(humanize("hostile")).toBe("Hostile");
    expect(humanize(undefined)).toBe("unknown");
  });

  it("computes clamped percentages within a range", () => {
    expect(toPercent(0, -1, 1)).toBe(50);
    expect(toPercent(5, 0, 100)).toBe(5);
    expect(toPercent(999, 0, 100)).toBe(100);
  });
});
