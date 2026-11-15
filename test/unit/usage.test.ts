import { describe, expect, test } from "bun:test";
import {
  museUsageEnv,
  parseMuseUsage,
  renderMeterLines,
  usageBar,
} from "../../src/usage.js";

const REAL_OUTPUT = [
  "Tier: Muse Code High Usage",
  "Window: 14% used, resets in 3h 57m",
  "Weekly: 93% used, resets in 20h 25m",
  "",
].join("\n");

describe("parseMuseUsage", () => {
  test("usage.parsesRealCliOutput", () => {
    const usage = parseMuseUsage(REAL_OUTPUT);
    expect(usage.window).toEqual({ percent: 14, resetsIn: "3h 57m" });
    expect(usage.weekly).toEqual({ percent: 93, resetsIn: "20h 25m" });
  });

  test("usage.toleratesExtraWhitespaceAndCase", () => {
    const usage = parseMuseUsage("  window:  7% used,  resets in 1h 2m\nWEEKLY: 50% used, resets in 4d 1h\n");
    expect(usage.window).toEqual({ percent: 7, resetsIn: "1h 2m" });
    expect(usage.weekly).toEqual({ percent: 50, resetsIn: "4d 1h" });
  });

  test("usage.missingLinesYieldNulls", () => {
    expect(parseMuseUsage("Tier: Muse Code High Usage")).toEqual({ window: null, weekly: null });
    expect(parseMuseUsage("")).toEqual({ window: null, weekly: null });
  });

  test("usage.partialOutputKeepsThePresentMeter", () => {
    const usage = parseMuseUsage("Window: 22% used, resets in 2h 0m");
    expect(usage.window).toEqual({ percent: 22, resetsIn: "2h 0m" });
    expect(usage.weekly).toBeNull();
  });

  test("usage.malformedPercentIsRejectedNotGuessed", () => {
    const usage = parseMuseUsage("Window: lots% used, resets in soon\nWeekly: 101% used, resets in 1h");
    expect(usage.window).toBeNull();
    expect(usage.weekly).toBeNull();
  });

  test("usage.clampsNothingSilently", () => {
    expect(parseMuseUsage("Window: 0% used, resets in 5h 0m").window).toEqual({ percent: 0, resetsIn: "5h 0m" });
    expect(parseMuseUsage("Window: 100% used, resets in 0m").window).toEqual({ percent: 100, resetsIn: "0m" });
  });
});

describe("usageBar", () => {
  test("usage.barReflectsPercent", () => {
    expect(usageBar(0, 10)).toBe("░".repeat(10));
    expect(usageBar(100, 10)).toBe("█".repeat(10));
    expect(usageBar(50, 10)).toBe("█".repeat(5) + "░".repeat(5));
    expect(usageBar(14, 10)).toBe("█" + "░".repeat(9));
  });
});

describe("renderMeterLines", () => {
  test("usage.rendersTwoLinesWithPercentBarAndReset", () => {
    const lines = renderMeterLines(parseMuseUsage(REAL_OUTPUT));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.label).toBe("5h");
    expect(lines[0]!.text).toContain("14%");
    expect(lines[0]!.text).toContain("3h 57m");
    expect(lines[0]!.text).toContain(usageBar(14));
    expect(lines[1]!.label).toBe("Week");
    expect(lines[1]!.text).toContain("93%");
    expect(lines[1]!.text).toContain("20h 25m");
  });

  test("usage.placeholderWhenUnavailable", () => {
    const lines = renderMeterLines({ window: null, weekly: null });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.percent).toBeNull();
      expect(line.text).toContain("unavailable");
    }
  });

  test("usage.mixedAvailabilityRendersEachIndependently", () => {
    const lines = renderMeterLines({ window: { percent: 40, resetsIn: "1h" }, weekly: null });
    expect(lines[0]!.text).toContain("40%");
    expect(lines[1]!.text).toContain("unavailable");
  });
});

describe("museUsageEnv", () => {
  test("usage.envStripsKeysAndPinsNoAutoUpdate", () => {
    const env = museUsageEnv({
      PATH: "/usr/bin",
      META_API_KEY: "secret",
      MUSE_CONTRIBUTOR_MODE: "on",
      HOME: "/home/user",
    });
    expect(env.META_API_KEY).toBeUndefined();
    expect(env.MUSE_CONTRIBUTOR_MODE).toBeUndefined();
    expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });
});
