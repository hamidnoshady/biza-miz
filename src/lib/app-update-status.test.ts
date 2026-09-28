import { describe, expect, it } from "vitest";
import { computeUpdateAvailable, computeUpdateStatus } from "./app-update-status";

describe("Desktop update status", () => {
  it("is up to date when SemVer matches", () => {
    expect(computeUpdateStatus("1.0.5", "1.0.5")).toBe("up_to_date");
    expect(computeUpdateAvailable("1.0.5", "1.0.5")).toBe(false);
  });

  it("offers only a semantically newer release", () => {
    expect(computeUpdateAvailable("1.0.5", "1.1.0")).toBe(true);
    expect(computeUpdateStatus("1.1.0", "1.0.5")).toBe("ahead_of_target");
    expect(computeUpdateAvailable("1.1.0", "1.0.5")).toBe(false);
  });

  it("never compares a Docker Git SHA with Desktop SemVer", () => {
    expect(computeUpdateStatus("1.0.5", "6f71457")).toBe("version_mismatch");
    expect(computeUpdateAvailable("1.0.5", "6f71457")).toBe(false);
  });

  it("handles prereleases and unsupported minimum versions", () => {
    expect(computeUpdateStatus("1.1.0-beta.1", "1.1.0-beta.2")).toBe("update_available");
    expect(computeUpdateStatus("1.0.2", "1.1.0", "1.0.3")).toBe("unsupported");
  });

  it("keeps an unknown target non-compliant rather than green", () => {
    expect(computeUpdateStatus("1.0.5", null)).toBe("unknown");
  });
});
