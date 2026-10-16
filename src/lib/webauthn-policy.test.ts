/**
 * Issue #854 follow-up (F02 / F12) — one WebAuthn management policy for the
 * Profile card and the credential routes, across every role.
 */
import { describe, expect, it } from "vitest";
import { ALL_ROLES, PASSWORD_ROLES, PIN_ROLES } from "./roles";
import {
  WEBAUTHN_ENROLMENT_ROLES,
  mayEnrolWebauthn,
  webauthnManagementPolicy,
} from "./webauthn-policy";

const writable = { readOnly: false };
const readOnly = { readOnly: true };

describe("webauthnManagementPolicy", () => {
  it("covers all seven roles: PIN roles may enrol, password roles may not", () => {
    expect([...ALL_ROLES].sort()).toEqual(
      ["accountant", "admin", "cashier", "kitchen", "manager", "owner", "waiter"].sort(),
    );
    for (const role of PIN_ROLES) {
      expect(webauthnManagementPolicy({ role, surface: writable })).toEqual({
        canList: true,
        canRegister: true,
        canRemove: true,
        registerBlockedBy: null,
      });
    }
    for (const role of PASSWORD_ROLES) {
      // Owner / admin / manager / accountant: no ceremony offered, but their
      // own authenticators (e.g. from an earlier till role) stay visible and
      // removable — a factor you cannot see is one you cannot revoke.
      expect(webauthnManagementPolicy({ role, surface: writable })).toEqual({
        canList: true,
        canRegister: false,
        canRemove: true,
        registerBlockedBy: "role",
      });
    }
  });

  it("a read-only deployment removes both mutations but never the list", () => {
    for (const role of ALL_ROLES) {
      const policy = webauthnManagementPolicy({ role, surface: readOnly });
      expect(policy.canList).toBe(true);
      expect(policy.canRegister).toBe(false);
      expect(policy.canRemove).toBe(false);
    }
    expect(webauthnManagementPolicy({ role: "cashier", surface: readOnly }).registerBlockedBy).toBe(
      "deployment",
    );
    // The role reason wins: it is the one the member can do nothing about here.
    expect(webauthnManagementPolicy({ role: "owner", surface: readOnly }).registerBlockedBy).toBe(
      "role",
    );
  });

  it("treats a missing surface as writable (webauthn is self-service on every profile today)", () => {
    expect(webauthnManagementPolicy({ role: "waiter" }).canRegister).toBe(true);
    expect(webauthnManagementPolicy({ role: "waiter", surface: null }).canRemove).toBe(true);
  });

  it("refuses an unknown role string rather than guessing", () => {
    expect(mayEnrolWebauthn("viewer")).toBe(false);
    expect(webauthnManagementPolicy({ role: "superadmin" }).canRegister).toBe(false);
  });

  it("aliases the role taxonomy instead of copying it", () => {
    expect(WEBAUTHN_ENROLMENT_ROLES).toBe(PIN_ROLES);
  });
});
