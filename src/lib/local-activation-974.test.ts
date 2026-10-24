import { describe, expect, it } from "vitest";
import {
  computeNextActivationState,
  computeValidationBackoffMs,
  deriveLocalActivationStatusSummary,
  isAllowedWhenLocalInstallationLocked,
  isConfirmedCloudDenial,
  isRemoteSupportCommandAllowed,
  LOCAL_ACTIVATION_PROTOCOL_VERSION,
  LOCAL_CLOUD_REFRESH_AUTHORITY,
  redactLocalSupportDiagnostics,
} from "./local-activation-contract";
import {
  generateLocalEnrollmentCode,
  generateLocalInstallationToken,
  hashLocalEnrollmentCode,
  openLocalCredential,
  sealLocalCredential,
  signOfflineLease,
  validateCloudOriginForLocalActivation,
  verifyOfflineLease,
} from "./local-activation-crypto";
import { classifyConnectionCode, classifyLocalEnrollmentCode } from "./connection-code";

describe("Issue #974 — Full Offline Cloud activation crypto, SSRF, state machine & security contracts", () => {
  it("generates distinct OFL1 enrollment codes and LOC1 installation tokens and separates them from Hybrid pairing/sync credentials", () => {
    const code = generateLocalEnrollmentCode();
    expect(code).toMatch(/^OFL1-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    expect(classifyLocalEnrollmentCode(code)).toBe("local_enrollment_code");
    expect(classifyConnectionCode(code)).toBe("local_enrollment_code");

    const locToken = generateLocalInstallationToken();
    expect(locToken.startsWith("LOC1-")).toBe(true);
    expect(classifyLocalEnrollmentCode(locToken)).toBe("local_installation_token");
    expect(classifyConnectionCode(locToken)).toBe("local_installation_token");

    // Hybrid pairing codes and sync tokens must be rejected by Full Offline activation
    expect(classifyLocalEnrollmentCode("ABCDEFGHJKLM")).toBe("pairing_code");
    expect(classifyLocalEnrollmentCode("POS1-0123456789abcdef")).toBe("sync_token");
    expect(hashLocalEnrollmentCode(code.toLowerCase())).toBe(hashLocalEnrollmentCode(code));
  });

  it("enforces HTTPS-only and blocks SSRF loopback/RFC1918/link-local/metadata Cloud origins", async () => {
    expect(
      await validateCloudOriginForLocalActivation("https://8.8.8.8", {
        NODE_ENV: "production",
      }),
    ).toEqual({ ok: true, origin: "https://8.8.8.8" });

    expect(
      await validateCloudOriginForLocalActivation("http://8.8.8.8", {
        NODE_ENV: "production",
      }),
    ).toEqual({ ok: false, error: "https_required" });

    for (const forbidden of [
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://172.16.4.2",
      "https://192.168.1.10",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[fe80::1]",
      "https://[fc00::1]",
    ]) {
      const check = await validateCloudOriginForLocalActivation(forbidden, {
        NODE_ENV: "production",
      });
      expect(check.ok, `expected ${forbidden} to fail SSRF check`).toBe(false);
    }

    expect(
      (
        await validateCloudOriginForLocalActivation("https://user:pass@8.8.8.8", {
          NODE_ENV: "production",
        })
      ).ok,
    ).toBe(false);

    // Loopback HTTP allowed strictly when explicit test/smoke flag is present
    expect(
      await validateCloudOriginForLocalActivation("http://127.0.0.1:41234", {
        NODE_ENV: "production",
        DESKTOP_SMOKE_MARKER: "/tmp/smoke.json",
        LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK: "1",
      }),
    ).toEqual({ ok: true, origin: "http://127.0.0.1:41234" });

    // Even with test loopback flag, RFC1918 LAN stays forbidden
    expect(
      (
        await validateCloudOriginForLocalActivation("http://192.168.1.10:3000", {
          NODE_ENV: "test",
          LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK: "1",
        })
      ).ok,
    ).toBe(false);
  });

  it("seals and opens LOC1 credentials with AES-256-GCM without storing plaintext", () => {
    const raw = generateLocalInstallationToken();
    const sealed = sealLocalCredential(raw);
    expect(sealed).not.toContain(raw);
    expect(sealed.startsWith("mk1.") || sealed.startsWith("ek1.")).toBe(true);
    expect(openLocalCredential(sealed)).toBe(raw);
    expect(openLocalCredential(`${sealed}tampered`)).toBeNull();
  });

  it("signs and verifies Ed25519 offline leases with clock-rollback and binding checks", () => {
    const installationId = "11111111-2222-4333-8444-555555555555";
    const cloudBusinessId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const issuedAt = new Date("2026-10-01T10:00:00.000Z");

    const signed = signOfflineLease({
      installationId,
      cloudBusinessId,
      issuedAt,
      leaseDays: 14,
      enforceOfflineLease: true,
    });

    expect(
      verifyOfflineLease({
        payload: signed.payload,
        signature: signed.signature,
        publicKeyPem: signed.publicKeyPem,
        expectedInstallationId: installationId,
        expectedCloudBusinessId: cloudBusinessId,
        enforceOfflineLease: true,
        maxObservedClockAt: new Date("2026-10-05T10:00:00.000Z"),
        now: new Date("2026-10-06T10:00:00.000Z"),
      }),
    ).toEqual({
      valid: true,
      enforced: true,
      expiresAt: signed.payload.expiresAt,
    });

    expect(
      verifyOfflineLease({
        payload: signed.payload,
        signature: signed.signature,
        publicKeyPem: signed.publicKeyPem,
        expectedInstallationId: installationId,
        expectedCloudBusinessId: "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        enforceOfflineLease: true,
        now: new Date("2026-10-06T10:00:00.000Z"),
      }),
    ).toEqual({ valid: false, reason: "binding_mismatch" });

    expect(
      verifyOfflineLease({
        payload: signed.payload,
        signature: signed.signature,
        publicKeyPem: signed.publicKeyPem,
        expectedInstallationId: installationId,
        expectedCloudBusinessId: cloudBusinessId,
        enforceOfflineLease: true,
        maxObservedClockAt: new Date("2026-10-12T10:00:00.000Z"),
        now: new Date("2026-10-08T10:00:00.000Z"),
      }),
    ).toEqual({ valid: false, reason: "clock_rollback_detected" });

    expect(
      verifyOfflineLease({
        payload: signed.payload,
        signature: signed.signature,
        publicKeyPem: signed.publicKeyPem,
        expectedInstallationId: installationId,
        expectedCloudBusinessId: cloudBusinessId,
        enforceOfflineLease: true,
        now: new Date("2026-10-20T10:00:00.000Z"),
      }),
    ).toEqual({ valid: false, reason: "lease_expired" });

    expect(
      verifyOfflineLease({
        payload: signed.payload,
        signature: signed.signature,
        publicKeyPem: signed.publicKeyPem,
        expectedInstallationId: installationId,
        expectedCloudBusinessId: cloudBusinessId,
        enforceOfflineLease: false,
        now: new Date("2027-10-20T10:00:00.000Z"),
      }).valid,
    ).toBe(true);
  });

  it("never locks on offline/DNS/TLS/timeout/5xx/429 and locks ONLY on confirmed Cloud denials", () => {
    expect(
      isConfirmedCloudDenial({
        httpStatus: 503,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: "device_revoked",
      }),
    ).toBe(false);
    expect(
      isConfirmedCloudDenial({
        httpStatus: 403,
        protocol: undefined,
        code: "device_revoked",
      }),
    ).toBe(false);
    expect(
      isConfirmedCloudDenial({
        httpStatus: 403,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: "device_revoked",
      }),
    ).toBe(true);

    for (const transient of [
      "internet_offline",
      "dns_error",
      "tls_error",
      "timeout",
      "cloud_5xx",
      "rate_limited",
      "network_error",
    ] as const) {
      const next = computeNextActivationState("active", null, {
        kind: "transient_failure",
        reason: transient,
      });
      expect(next).toEqual({
        nextState: "validation_pending",
        lockReason: null,
        localOperationsAllowed: true,
      });
    }

    // Recovery from validation_pending -> active
    expect(
      computeNextActivationState("validation_pending", null, {
        kind: "validated_ok",
      }),
    ).toEqual({
      nextState: "active",
      lockReason: null,
      localOperationsAllowed: true,
    });

    // Confirmed Cloud denial -> locked_invalid
    const locked = computeNextActivationState("active", null, {
      kind: "confirmed_denial",
      code: "device_revoked",
    });
    expect(locked).toEqual({
      nextState: "locked_invalid",
      lockReason: "device_revoked",
      localOperationsAllowed: false,
    });

    // Offline while locked_invalid MUST stay locked_invalid
    expect(
      computeNextActivationState("locked_invalid", "device_revoked", {
        kind: "transient_failure",
        reason: "internet_offline",
      }),
    ).toEqual({
      nextState: "locked_invalid",
      lockReason: "device_revoked",
      localOperationsAllowed: false,
    });

    // Begin validation while locked stays locked until Cloud confirms success
    expect(
      computeNextActivationState("locked_invalid", "device_revoked", {
        kind: "begin_validation",
      }).localOperationsAllowed,
    ).toBe(false);

    // Validated_ok after new token unlocks -> active
    expect(
      computeNextActivationState("locked_invalid", "device_revoked", {
        kind: "validated_ok",
      }),
    ).toEqual({
      nextState: "active",
      lockReason: null,
      localOperationsAllowed: true,
    });

    expect(computeValidationBackoffMs(1, 0.5)).toBeGreaterThanOrEqual(10_000);
    expect(computeValidationBackoffMs(20, 0.99)).toBeLessThanOrEqual(45 * 60_000);
  });

  it("enforces locked_invalid API boundary allowlist, remote support command scopes, domain authority, and secret redaction", () => {
    expect(isAllowedWhenLocalInstallationLocked("/api/orders", "POST")).toBe(false);
    expect(isAllowedWhenLocalInstallationLocked("/api/pos/checkout", "POST")).toBe(false);
    expect(isAllowedWhenLocalInstallationLocked("/api/accounting/journals", "GET")).toBe(false);
    expect(isAllowedWhenLocalInstallationLocked("/api/local-activation/status", "POST")).toBe(true);
    expect(isAllowedWhenLocalInstallationLocked("/api/backup", "GET")).toBe(true);
    expect(isAllowedWhenLocalInstallationLocked("/api/audit-log", "GET")).toBe(true);
    expect(isAllowedWhenLocalInstallationLocked("/api/auth/logout", "POST")).toBe(true);

    expect(isRemoteSupportCommandAllowed("read_only", "inspect_system_diagnostics", false)).toBe(true);
    expect(isRemoteSupportCommandAllowed("read_only", "clear_stuck_print_jobs", false)).toBe(false);
    expect(isRemoteSupportCommandAllowed("controlled", "clear_stuck_print_jobs", false)).toBe(true);
    expect(isRemoteSupportCommandAllowed("controlled", "inspect_system_diagnostics", true)).toBe(false);
    expect(isRemoteSupportCommandAllowed("recovery_only", "trigger_cloud_revalidation", true)).toBe(true);
    expect(isRemoteSupportCommandAllowed("recovery_only", "clear_stuck_print_jobs", true)).toBe(false);

    expect(LOCAL_CLOUD_REFRESH_AUTHORITY.neverOverwrittenLocal).toContain("orders_and_pos");
    expect(LOCAL_CLOUD_REFRESH_AUTHORITY.cloudAuthoritative).toContain("business_identity");

    const redacted = redactLocalSupportDiagnostics({
      ok: true,
      password: "super-secret-password",
      Authorization: "Bearer LOC1-0123456789abcdef0123456789abcdef",
      note: "Failed with OFL1-BCDF-GHJK-MNPQ and sync_abcdef0123456789",
    }) as Record<string, unknown>;
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.Authorization).toBe("[REDACTED]");
    expect(String(redacted.note)).not.toContain("OFL1-BCDF-GHJK-MNPQ");
    expect(String(redacted.note)).not.toContain("sync_abcdef0123456789");

    const lockedSummary = deriveLocalActivationStatusSummary({
      state: "locked_invalid",
      lockReason: "business_suspended",
      cloudReachable: true,
      internetHintOffline: false,
    });
    expect(lockedSummary.localOperationsReady).toBe(false);
    expect(lockedSummary.cloudSupportAvailable).toBe(false);
  });
});
