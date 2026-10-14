import { describe, expect, it } from "vitest";
import {
  credentialSyncLabel,
  credentialSyncNeedsAttention,
  hybridIdentityHealth,
  isCredentialSyncStatus,
} from "./credential-health";

const base = { configured: true, identity: "healthy" as const, credentials: "healthy" as const, pinMembersMissing: 0 };

describe("hybridIdentityHealth", () => {
  it("is healthy only when both planes and the roster gap are clean", () => {
    expect(hybridIdentityHealth(base)).toEqual({ overall: "healthy", degradedBy: null, reason: null });
  });

  it("does not call a Local install degraded for lacking a cloud", () => {
    expect(hybridIdentityHealth({ ...base, configured: false })).toMatchObject({ overall: "not_configured" });
  });

  it("is degraded when memberships converged but credentials failed — the owner-only roster", () => {
    expect(hybridIdentityHealth({ ...base, credentials: "degraded" })).toMatchObject({
      overall: "degraded", degradedBy: "credentials",
    });
  });

  it("is degraded while a credential pass has never run", () => {
    expect(hybridIdentityHealth({ ...base, credentials: "pending" })).toMatchObject({ overall: "degraded" });
    expect(hybridIdentityHealth({ ...base, credentials: null })).toMatchObject({ overall: "degraded" });
  });

  it("is degraded when active PIN staff exist without a usable local PIN", () => {
    expect(hybridIdentityHealth({ ...base, pinMembersMissing: 3 })).toMatchObject({
      overall: "degraded", degradedBy: "credentials", reason: "pin_credentials_missing:3",
    });
  });

  it("never calls a legacy cloud fully healthy", () => {
    expect(hybridIdentityHealth({ ...base, credentials: "unsupported_legacy_cloud" })).toMatchObject({
      overall: "limited", degradedBy: "credentials",
    });
  });

  it("still blames the identity plane when memberships are the broken half", () => {
    expect(hybridIdentityHealth({ ...base, identity: "snapshot_required" })).toMatchObject({
      overall: "degraded", degradedBy: "identity",
    });
  });

  it("reports syncing rather than a failure while work is in flight", () => {
    expect(hybridIdentityHealth({ ...base, credentials: "syncing" })).toMatchObject({ overall: "syncing" });
    expect(hybridIdentityHealth({ ...base, identity: "syncing" })).toMatchObject({ overall: "syncing" });
  });
});

describe("credential status vocabulary", () => {
  it("recognises only the stored states", () => {
    expect(isCredentialSyncStatus("healthy")).toBe(true);
    expect(isCredentialSyncStatus("weird")).toBe(false);
  });

  it("treats every non-converged state as needing attention", () => {
    expect(credentialSyncNeedsAttention("healthy")).toBe(false);
    expect(credentialSyncNeedsAttention("syncing")).toBe(false);
    expect(credentialSyncNeedsAttention("unsupported_legacy_cloud")).toBe(false);
    for (const status of ["pending", "degraded", "snapshot_required", "repair_required"] as const) {
      expect(credentialSyncNeedsAttention(status)).toBe(true);
    }
  });

  it("has operator text for every state", () => {
    for (const status of ["healthy", "pending", "syncing", "degraded", "unsupported_legacy_cloud", "snapshot_required", "repair_required"] as const) {
      expect(credentialSyncLabel(status).length).toBeGreaterThan(0);
    }
  });
});
