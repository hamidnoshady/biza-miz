import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEFAULT_POLICY,
  POLICY_KEYS,
  POLICY_TTL_HOURS,
  buildPolicyDocument,
  effectivePolicyChannel,
  resolveDesktopUpdatePolicy,
  validateDesktopUpdatePolicyPatch,
  type PolicyLayer,
} from "./desktop-update-policy";
import { selectTargetReleaseForPolicy, type PlatformDesktopRelease } from "./desktop-release-service";

const layer = (scope: PolicyLayer["scope"], patch: PolicyLayer["patch"], version: number, reason = "تست"): PolicyLayer =>
  ({ scope, patch, version, reason, updatedAt: "2026-10-16T10:00:00.000Z" });

describe("validateDesktopUpdatePolicyPatch", () => {
  it("accepts a typed partial policy and normalises dates and days", () => {
    const result = validateDesktopUpdatePolicyPatch({
      automaticInstall: "safe_window",
      backgroundDownload: true,
      deferUntil: "2026-11-01T00:00:00+03:30",
      maintenance: { timezone: "Asia/Tehran", daysOfWeek: [6, 0, 6, 1], start: "23:00", end: "04:00" },
      minimumBatteryPercent: 40,
    });
    expect(result).toEqual({
      ok: true,
      patch: {
        automaticInstall: "safe_window",
        backgroundDownload: true,
        deferUntil: "2026-10-31T20:30:00.000Z",
        maintenance: { timezone: "Asia/Tehran", daysOfWeek: [0, 1, 6], start: "23:00", end: "04:00" },
        minimumBatteryPercent: 40,
      },
    });
  });

  it("refuses keys that are not policy — an installer URL, an origin, a downgrade, a verification switch", () => {
    for (const key of ["installerUrl", "allowedOrigins", "allowDowngrade", "skipSignature", "backupRequired", "signatureRequired", "installerSha256"]) {
      expect(validateDesktopUpdatePolicyPatch({ [key]: true })).toMatchObject({ ok: false, error: "unknown_policy_key", key });
    }
  });

  it.each([
    [{ automaticInstall: "always" }],
    [{ automaticInstall: true }],
    [{ channel: "nightly" }],
    [{ hold: "yes" }],
    [{ targetReleaseId: "not-a-uuid" }],
    [{ deferUntil: "tomorrow" }],
    [{ minimumBatteryPercent: 101 }],
    [{ minimumBatteryPercent: 12.5 }],
    [{ maintenance: { timezone: "Mars/Olympus", daysOfWeek: [1], start: "02:00", end: "05:00" } }],
    [{ maintenance: { timezone: "Asia/Tehran", daysOfWeek: [], start: "02:00", end: "05:00" } }],
    [{ maintenance: { timezone: "Asia/Tehran", daysOfWeek: [7], start: "02:00", end: "05:00" } }],
    [{ maintenance: { timezone: "Asia/Tehran", daysOfWeek: [1], start: "2:00", end: "05:00" } }],
    [{ maintenance: { timezone: "Asia/Tehran", daysOfWeek: [1], start: "03:00", end: "03:00" } }],
  ])("rejects an invalid value %j", (patch) => {
    expect(validateDesktopUpdatePolicyPatch(patch)).toMatchObject({ ok: false, error: "invalid_policy_value" });
  });

  it("allows null where null means 'no value' and rejects non-objects", () => {
    expect(validateDesktopUpdatePolicyPatch({ channel: null, deferUntil: null, targetReleaseId: null })).toMatchObject({ ok: true });
    for (const bad of [null, "x", 3, []]) expect(validateDesktopUpdatePolicyPatch(bad)).toMatchObject({ ok: false, error: "bad_policy" });
  });
});

describe("resolveDesktopUpdatePolicy", () => {
  it("is the conservative default with no layers: nothing installs unattended", () => {
    const resolved = resolveDesktopUpdatePolicy([]);
    expect(resolved.policy).toEqual(PLATFORM_DEFAULT_POLICY);
    expect(resolved.policy.automaticInstall).toBe("off");
    expect(resolved.policyVersion).toBe(0);
    expect(Object.values(resolved.sources).every((source) => source === "default")).toBe(true);
  });

  it("lets the most specific explicit value win, field by field, and says where each came from", () => {
    const resolved = resolveDesktopUpdatePolicy([
      layer("device", { backgroundDownload: false }, 40),
      layer("platform", { backgroundDownload: true, automaticInstall: "safe_window", channel: "stable" }, 10),
      layer("business", { automaticInstall: "off" }, 20),
      layer("location", { hold: true }, 30),
    ]);
    expect(resolved.policy).toMatchObject({ backgroundDownload: false, automaticInstall: "off", channel: "stable", hold: true });
    expect(resolved.sources).toMatchObject({
      backgroundDownload: "device", automaticInstall: "business", channel: "platform", hold: "location", automaticChecks: "default",
    });
  });

  it("an explicit null overrides an inherited value (clearing a pin for one device)", () => {
    const resolved = resolveDesktopUpdatePolicy([
      layer("business", { targetReleaseId: "11111111-1111-4111-8111-111111111111" }, 5),
      layer("device", { targetReleaseId: null }, 6),
    ]);
    expect(resolved.policy.targetReleaseId).toBeNull();
    expect(resolved.sources.targetReleaseId).toBe("device");
  });

  it("policyVersion is the highest applicable layer version and names the layer that explains it", () => {
    const resolved = resolveDesktopUpdatePolicy([
      layer("platform", { automaticChecks: true }, 7, "پیش‌فرض"),
      layer("business", { hold: true }, 12, "ایست اضطراری"),
    ]);
    expect(resolved.policyVersion).toBe(12);
    expect(resolved.latest).toMatchObject({ scope: "business", version: 12, reason: "ایست اضطراری" });
  });

  it("does not alias the default object", () => {
    const first = resolveDesktopUpdatePolicy([]);
    first.policy.maintenance.daysOfWeek.push(9);
    expect(PLATFORM_DEFAULT_POLICY.maintenance.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("every policy key has a default and a source", () => {
    const resolved = resolveDesktopUpdatePolicy([]);
    for (const key of POLICY_KEYS) {
      expect(key in resolved.policy).toBe(true);
      expect(resolved.sources[key]).toBe("default");
    }
  });
});

describe("buildPolicyDocument", () => {
  it("carries identity, version, expiry and the audit reference — without naming the operator", () => {
    const now = new Date("2026-10-16T12:00:00.000Z");
    const resolved = resolveDesktopUpdatePolicy([layer("business", { automaticInstall: "safe_window" }, 33, "کاناری")]);
    const document = buildPolicyDocument({ resolved, businessId: "b-1", deviceId: "POS-AB12", channel: "beta", now });
    expect(document).toMatchObject({
      schemaVersion: 1, policyVersion: 33, businessId: "b-1", deviceId: "POS-AB12", reason: "کاناری",
      actor: "platform", auditRef: "business:33", issuedAt: now.toISOString(),
    });
    expect(Date.parse(document.expiresAt) - now.getTime()).toBe(POLICY_TTL_HOURS * 3_600_000);
    expect(document.policy.channel).toBe("beta");
  });
});

describe("effectivePolicyChannel", () => {
  it("prefers an explicit channel, then the pinned release's, then what the device reports", () => {
    expect(effectivePolicyChannel({ channel: "beta" }, "internal", "stable")).toBe("beta");
    expect(effectivePolicyChannel({ channel: null }, "internal", "stable")).toBe("internal");
    expect(effectivePolicyChannel({ channel: null }, null, "stable")).toBe("stable");
  });
});

function release(partial: Partial<PlatformDesktopRelease> & Pick<PlatformDesktopRelease, "id" | "version">): PlatformDesktopRelease {
  return {
    manifestSignature: "S".repeat(96), buildCommit: "abcdef0", buildId: "b", channel: "stable",
    status: "published", rolloutState: "internal", rolloutPercentage: 0, releasedAt: "2026-10-16T00:00:00.000Z",
    minimumSupportedVersion: null, mandatory: false,
    installer: { url: "https://github.com/x/y.exe", sha256: "a".repeat(64), size: 10, signatureRequired: true, expectedPublisher: "P" },
    database: { migrationVersion: null, minimumSchemaVersion: null, maximumSchemaVersion: null, backupRequired: true },
    releaseNotes: [], recovery: { knownGoodVersion: null, notes: null },
    createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
    ...partial,
  };
}

describe("selectTargetReleaseForPolicy", () => {
  const internal = release({ id: "r-internal", version: "2.0.0", rolloutState: "internal" });
  const full = release({ id: "r-full", version: "1.9.0", rolloutState: "full", rolloutPercentage: 100 });
  const base = { channel: "stable" as const, targetReleaseId: null, hold: false, publicDeviceId: "POS-1" };

  it("falls back to the platform rollout when nothing is pinned", () => {
    expect(selectTargetReleaseForPolicy([internal, full], base).release?.id).toBe("r-full");
  });

  it("a pin approves an internal release for its scope (canary) while everyone else stays on the rollout", () => {
    expect(selectTargetReleaseForPolicy([internal, full], { ...base, targetReleaseId: "r-internal" }).release?.id).toBe("r-internal");
    expect(selectTargetReleaseForPolicy([internal, full], base).release?.id).toBe("r-full");
  });

  it("a hold withholds everything, pinned or not", () => {
    expect(selectTargetReleaseForPolicy([internal, full], { ...base, hold: true, targetReleaseId: "r-internal" }))
      .toEqual({ release: null, withheldReason: "hold" });
  });

  it("never substitutes: a withdrawn, paused, draft or other-channel pin is withheld", () => {
    for (const bad of [
      release({ id: "r-internal", version: "2.0.0", status: "withdrawn" }),
      release({ id: "r-internal", version: "2.0.0", status: "draft" }),
      release({ id: "r-internal", version: "2.0.0", rolloutState: "paused" }),
      release({ id: "r-internal", version: "2.0.0", channel: "beta" }),
    ]) {
      expect(selectTargetReleaseForPolicy([bad, full], { ...base, targetReleaseId: "r-internal" }))
        .toEqual({ release: null, withheldReason: "pinned_release_unavailable" });
    }
    expect(selectTargetReleaseForPolicy([full], { ...base, targetReleaseId: "missing" }).withheldReason).toBe("pinned_release_unavailable");
  });

  it("says why nothing was offered when no release is eligible", () => {
    expect(selectTargetReleaseForPolicy([internal], base)).toEqual({ release: null, withheldReason: "no_eligible_release" });
  });
});
