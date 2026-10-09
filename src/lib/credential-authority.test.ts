/**
 * Issue #854 (P1.13 / P1.14 / P1.15) — the credential authority table.
 *
 * The point of these tests is not that the table is hard to get right; it is
 * that the table is the *only* answer, so adding a credential field or a
 * deployment profile without deciding who owns it fails here rather than
 * shipping a surface that quietly writes cloud-owned state locally.
 */
import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-contracts";
import { DEPLOYMENT_PROFILES, type DeploymentProfile } from "./deployment-mode";
import {
  CREDENTIAL_AUTHORITY,
  authorityFor,
  cloudManagedNotice,
  describeCredentialSurface,
  hybridRefusesLocalCreation,
  maySelfServiceWrite,
  mayWriteCredential,
  type CredentialField,
} from "./credential-authority";

const FIELDS = Object.keys(CREDENTIAL_AUTHORITY.cloud) as CredentialField[];
const HYBRID_LOCAL_ONLY: CredentialField[] = [
  "employee_sessions",
  "webauthn_credential",
];

describe("CREDENTIAL_AUTHORITY", () => {
  it("names every field for every profile", () => {
    for (const profile of DEPLOYMENT_PROFILES) {
      expect(Object.keys(CREDENTIAL_AUTHORITY[profile]).sort()).toEqual([...FIELDS].sort());
    }
  });

  it("makes cloud authoritative for every global field", () => {
    for (const field of FIELDS) {
      expect(authorityFor("cloud", field)).toBe("authoritative");
    }
  });

  it("makes local authoritative for every field — there is no cloud to conflict with", () => {
    for (const field of FIELDS) {
      expect(authorityFor("local", field)).toBe("authoritative");
    }
  });

  it("makes hybrid apply everything global and own only what cannot live elsewhere", () => {
    for (const field of FIELDS) {
      const expected = HYBRID_LOCAL_ONLY.includes(field) ? "local-only" : "apply";
      expect(authorityFor("hybrid", field)).toBe(expected);
    }
  });
});

describe("mayWriteCredential", () => {
  it("refuses a hybrid site originating a global credential change", () => {
    for (const field of [
      "global_password",
      "login_phone",
      "totp_secret",
      "sms_mfa_factor",
      "mfa_recovery_codes",
      "membership",
      "membership_role",
    ] as CredentialField[]) {
      expect(mayWriteCredential("hybrid", field)).toBe(false);
    }
  });

  it("allows cloud and local to originate their own", () => {
    for (const profile of ["cloud", "local"] as DeploymentProfile[]) {
      for (const field of FIELDS) {
        expect(mayWriteCredential(profile, field)).toBe(true);
      }
    }
  });
});

describe("maySelfServiceWrite", () => {
  it("lets a till rotate its own PIN even with the uplink down", () => {
    /**
     * The product decision this encodes: a Hybrid site must be able to issue a
     * new staff PIN while offline, or a forgotten PIN closes the counter.
     */
    expect(maySelfServiceWrite("hybrid", "staff_pin")).toBe(true);
    expect(maySelfServiceWrite("hybrid", "webauthn_credential")).toBe(true);
  });

  it("does not let a hybrid member change the global password or login phone locally", () => {
    expect(maySelfServiceWrite("hybrid", "global_password")).toBe(false);
    expect(maySelfServiceWrite("hybrid", "login_phone")).toBe(false);
  });
});

describe("describeCredentialSurface", () => {
  it("hands the UI a read-only surface *and* the reason", () => {
    const surface = describeCredentialSurface("hybrid", "global_password");
    expect(surface).toEqual({
      field: "global_password",
      editable: false,
      readOnly: true,
      notice: cloudManagedNotice(),
    });
    expect(surface.notice).toBe("این مورد در نسخهٔ ابری مدیریت می‌شود.");
  });

  it("leaves an owned field editable with no notice", () => {
    expect(describeCredentialSurface("cloud", "global_password")).toEqual({
      field: "global_password",
      editable: true,
      readOnly: false,
      notice: null,
    });
  });
});

describe("hybridRefusesLocalCreation", () => {
  it("refuses memberships and their credentials on a hybrid site", () => {
    for (const field of [
      "membership",
      "membership_role",
      "global_password",
      "login_phone",
    ] as CredentialField[]) {
      expect(hybridRefusesLocalCreation("hybrid", field)).toBe(true);
    }
  });

  it("says nothing about cloud or local installs", () => {
    expect(hybridRefusesLocalCreation("cloud", "membership")).toBe(false);
    expect(hybridRefusesLocalCreation("local", "membership")).toBe(false);
  });
});

describe("one source for the cloud-managed sentence (P2.3)", () => {
  it("reads the notice from the shared error-code table", () => {
    /**
     * The literal was duplicated: once here, once as
     * `AUTH_ERROR_MESSAGES.login_managed_by_cloud` (which the routes also
     * return). Two copies of a user-facing string is the same drift this pass
     * removes elsewhere, so the table is the canonical home.
     */
    expect(cloudManagedNotice()).toBe(authErrorMessage("login_managed_by_cloud"));
  });
});
