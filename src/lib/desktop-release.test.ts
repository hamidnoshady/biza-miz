import { describe, expect, it } from "vitest";
import {
  classifyDesktopVersion,
  classifyDeviceConnectivity,
  compareSemVer,
  complianceWithFreshness,
  validateDesktopReleaseManifest,
} from "./desktop-release";

const manifest = {
  manifestSignature: "A".repeat(96),
  version: "1.2.0",
  buildCommit: "6f714578b1c59990",
  buildId: "windows-production-123",
  channel: "stable",
  releasedAt: "2026-09-28T08:00:00.000Z",
  minimumSupportedVersion: "1.0.3",
  mandatory: false,
  installer: {
    url: "https://github.com/example/project/releases/download/desktop-v1.2.0/Business.exe",
    sha256: "a".repeat(64),
    size: 140_000_000,
    signatureRequired: true,
    expectedPublisher: "Business Suite",
  },
  database: {
    migrationVersion: 187,
    minimumSchemaVersion: 150,
    maximumSchemaVersion: 187,
    backupRequired: true,
  },
  releaseNotes: ["بهبود پایداری"],
  recovery: { knownGoodVersion: "1.1.0", notes: "Use the preserved backup." },
};

describe("Desktop SemVer release decisions", () => {
  it("orders releases semantically rather than comparing arbitrary strings", () => {
    expect(compareSemVer("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemVer("1.2.0-beta.2", "1.2.0-beta.11")).toBe(-1);
    expect(compareSemVer("1.2.0", "1.2.0-beta.11")).toBe(1);
    expect(compareSemVer("6f71457", "1.2.0")).toBeNull();
  });

  it.each([
    ["1.1.0", "1.1.0", null, "up_to_date"],
    ["1.0.5", "1.1.0", null, "update_available"],
    ["1.2.0", "1.1.0", null, "ahead_of_target"],
    ["1.0.2", "1.1.0", "1.0.3", "unsupported"],
    ["6f71457", "1.1.0", null, "version_mismatch"],
    ["1.0.5", null, null, "unknown"],
  ])("classifies installed %s against target %s", (installed, target, minimum, expected) => {
    expect(classifyDesktopVersion(installed, target, minimum)).toBe(expected);
  });
});

describe("runtime report freshness", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");

  it("uses server receipt age thresholds", () => {
    expect(classifyDeviceConnectivity("2026-09-28T11:59:00.000Z", now)).toBe("online");
    expect(classifyDeviceConnectivity("2026-09-28T11:55:00.000Z", now)).toBe("delayed");
    expect(classifyDeviceConnectivity("2026-09-28T11:30:00.000Z", now)).toBe("stale");
    expect(classifyDeviceConnectivity("2026-09-28T10:00:00.000Z", now)).toBe("offline");
  });

  it("never renders a stale, offline or errored device as compliant", () => {
    expect(complianceWithFreshness("up_to_date", "stale", false)).toBe("stale");
    expect(complianceWithFreshness("up_to_date", "offline", false)).toBe("offline");
    expect(complianceWithFreshness("up_to_date", "online", true)).toBe("error");
  });
});

describe("release manifest validation", () => {
  it("accepts a complete HTTPS, hash/signing and backup-gated manifest", () => {
    expect(validateDesktopReleaseManifest(manifest)).toEqual({ ok: true, manifest: expect.objectContaining({ version: "1.2.0" }) });
  });

  it("rejects malformed, downgrade-unsafe inputs before download", () => {
    expect(validateDesktopReleaseManifest({ ...manifest, version: "latest" })).toEqual({ ok: false, error: "manifest_version_invalid" });
    expect(validateDesktopReleaseManifest({ ...manifest, installer: { ...manifest.installer, url: "http://updates.invalid/app.exe" } })).toEqual({ ok: false, error: "manifest_installer_url_invalid" });
    expect(validateDesktopReleaseManifest({ ...manifest, installer: { ...manifest.installer, sha256: "bad" } })).toEqual({ ok: false, error: "manifest_installer_hash_invalid" });
    expect(validateDesktopReleaseManifest({ ...manifest, database: { ...manifest.database, backupRequired: false } })).toEqual({ ok: false, error: "manifest_backup_required" });
  });
});
