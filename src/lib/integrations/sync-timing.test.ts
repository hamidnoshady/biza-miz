import { describe, expect, it } from "vitest";
import { pluginPullIntervalMs, pluginSilenceThresholdMs } from "./sync-timing";

describe("verified plugin schedule negotiation", () => {
  it("keeps legacy five-minute expectations until the new plugin reports its cadence", () => {
    for (const health of [null, {}, { fastIntervalSeconds: 0 }, { fastIntervalSeconds: "60" }]) {
      expect(pluginPullIntervalMs(health)).toBe(300_000);
      expect(pluginSilenceThresholdMs(health)).toBe(600_000);
    }
  });
  it("reports two missed minute pulls for the upgraded plugin", () => {
    expect(pluginPullIntervalMs({ fastIntervalSeconds: 60 })).toBe(60_000);
    expect(pluginSilenceThresholdMs({ fastIntervalSeconds: 60 })).toBe(120_000);
  });
});
