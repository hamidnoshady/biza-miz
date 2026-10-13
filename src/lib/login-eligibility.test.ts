import { describe, expect, it } from "vitest";
import {
  isPinEligibleRole,
  pinEligibleRolesSql,
  PASSWORD_ROLES_SQL,
  STAFF_PIN_ROLES_SQL,
  WEBAUTHN_LOGIN_ROLES_SQL,
} from "./login-eligibility";
// Role membership lives in @/lib/roles; this module only decides which set a
// door applies. The test reads both so it checks the wiring, not a copy.
import { PASSWORD_ROLES, PIN_ROLES } from "./roles";

/**
 * Issue #885 L13 — the login eligibility policy.
 *
 * These values are interpolated straight into SQL `IN (...)` lists, so a
 * stray character is a syntax error at query time rather than a type error at
 * build time. The shape assertions below are the cheap half of catching that;
 * the deployment-dependent behaviour is the half that actually changed.
 *
 * The policy itself — that WebAuthn stays narrow when the PIN door widens —
 * is a product decision recorded in the module. What is asserted here is that
 * the decision is still the one that was made, so widening one door cannot
 * silently widen the other.
 */

describe("SQL fragments", () => {
  it("renders a parenthesised, quoted, comma-separated list", () => {
    // Interpolated into `role IN ${…}`, so the parentheses are part of the
    // value and must be present.
    expect(STAFF_PIN_ROLES_SQL).toBe("('cashier', 'waiter', 'kitchen')");
    expect(PASSWORD_ROLES_SQL).toBe("('owner', 'admin', 'manager', 'accountant')");
  });

  it("lists exactly the exported roles, in order", () => {
    const parse = (sql: string) =>
      sql
        .replace(/^\(|\)$/g, "")
        .split(", ")
        .map((r) => r.replace(/^'|'$/g, ""));

    expect(parse(STAFF_PIN_ROLES_SQL)).toEqual([...PIN_ROLES]);
    expect(parse(PASSWORD_ROLES_SQL)).toEqual([...PASSWORD_ROLES]);
  });

  it("contains no interpolation hazard", () => {
    // Roles are literals in this module, never caller input, but the fragment
    // is concatenated into SQL — so pin that no value can break out.
    for (const sql of [STAFF_PIN_ROLES_SQL, PASSWORD_ROLES_SQL, pinEligibleRolesSql("local")]) {
      expect(sql).not.toContain("--");
      expect(sql).not.toContain(";");
      expect(sql).not.toContain("/*");
      expect(sql.split("'").length - 1).toBe(sql.split(",").length * 2);
    }
  });
});

describe("pinEligibleRolesSql", () => {
  it("admits only staff roles on cloud", () => {
    expect(pinEligibleRolesSql("cloud")).toBe(STAFF_PIN_ROLES_SQL);
    expect(pinEligibleRolesSql("cloud")).not.toContain("owner");
  });

  it("admits the privileged roles off cloud", () => {
    for (const profile of ["local", "hybrid"] as const) {
      const sql = pinEligibleRolesSql(profile);
      for (const role of [...PIN_ROLES, ...PASSWORD_ROLES]) {
        expect(sql, `${profile} should admit ${role}`).toContain(`'${role}'`);
      }
    }
  });

  it("is wider off cloud than on it", () => {
    expect(pinEligibleRolesSql("local").length).toBeGreaterThan(
      pinEligibleRolesSql("cloud").length,
    );
  });

  it("never drops a staff role when widening", () => {
    const widened = pinEligibleRolesSql("local");
    for (const role of PIN_ROLES) {
      expect(widened).toContain(`'${role}'`);
    }
  });
});

describe("isPinEligibleRole", () => {
  it("agrees with the SQL it backs", () => {
    for (const profile of ["cloud", "local", "hybrid"] as const) {
      const sql = pinEligibleRolesSql(profile);
      for (const role of [...PIN_ROLES, ...PASSWORD_ROLES]) {
        expect(isPinEligibleRole(role, profile), `${role} on ${profile}`).toBe(
          sql.includes(`'${role}'`),
        );
      }
    }
  });

  it("refuses a role outside both sets", () => {
    expect(isPinEligibleRole("supervisor", "local")).toBe(false);
    expect(isPinEligibleRole("", "local")).toBe(false);
  });

  it("refuses a privileged role on cloud", () => {
    expect(isPinEligibleRole("owner", "cloud")).toBe(false);
    expect(isPinEligibleRole("accountant", "cloud")).toBe(false);
  });
});

describe("the WebAuthn door stays narrow", () => {
  it("accepts only staff roles, on every profile", () => {
    expect(WEBAUTHN_LOGIN_ROLES_SQL).toBe(STAFF_PIN_ROLES_SQL);
    expect(WEBAUTHN_LOGIN_ROLES_SQL).not.toContain("owner");
    expect(WEBAUTHN_LOGIN_ROLES_SQL).not.toContain("manager");
  });

  it("does not widen when the PIN door does", () => {
    // The regression this guards: someone notices the PIN door widens off
    // cloud and "fixes" WebAuthn to match. A passkey is bound to one device
    // and the privileged doors are not, so that would let an owner's
    // authority ride on a shared till's authenticator.
    expect(pinEligibleRolesSql("local")).not.toBe(WEBAUTHN_LOGIN_ROLES_SQL);
  });
});
