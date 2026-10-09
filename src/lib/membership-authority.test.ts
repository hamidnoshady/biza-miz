/**
 * Issue #854 (P0.1 / P0.2 / P1.12) — the escalation matrix, without a database.
 *
 * This file exists because the defect it guards was never a *missing* check: it
 * was that create, invite and update each decided the same question separately,
 * and only one of them actually compared capabilities. A test that only
 * exercises `PATCH /api/team/[id]` would have passed the whole time.
 *
 * So the matrix below is written from the *actor's* point of view — "what may a
 * manager hand out?" — and every entry is checked against every door, because
 * the doors share the decision and must therefore share its answers.
 */
import { describe, expect, it } from "vitest";
import {
  grantRefusalMessage,
  membershipGrantRefusal,
  projectGrantedPermissions,
  type MembershipGrantCheck,
} from "./membership-authority";
import {
  effectivePermissions,
  PERMISSIONS,
  type Permission,
  type PermissionOverrides,
} from "./permissions";
import type { Role } from "./auth-edge";

/**
 * The delegated-team-manager shape every case below starts from.
 *
 * `team.permissions.manage` is deliberately *not* in the manager preset: the
 * product ships a manager who runs the floor, and handing out capabilities is
 * an explicit delegation. The first test proves the gate exists; the rest grant
 * it so they exercise the escalation comparison itself.
 */
const DELEGATED: PermissionOverrides = { granted: [PERMISSIONS.teamPermissionsManage] };

function authority(role: Role, overrides: PermissionOverrides = {}, customRole: string[] | null = null) {
  return {
    actorId: "actor",
    actorRole: role,
    actorPermissions: effectivePermissions(role, overrides, customRole),
    actorCustomRoleId: customRole ? "role-1" : null,
    actorCustomRolePermissions: customRole,
  };
}

function check(overrides: Partial<MembershipGrantCheck> & { actor: MembershipGrantCheck["actor"] }): MembershipGrantCheck {
  const base: MembershipGrantCheck = {
    actor: overrides.actor,
    nextRole: "cashier",
    nextPermissions: projectGrantedPermissions({ role: "cashier", overrides: {} }),
    isSelf: false,
    isCreation: true,
    roleChanges: false,
    changesAccess: true,
  };
  return { ...base, ...overrides };
}

describe("membershipGrantRefusal", () => {
  it("lets an owner hand out anything — ownership is the full set by construction", () => {
    const refusal = membershipGrantRefusal(
      check({
        actor: authority("owner"),
        nextRole: "admin",
        nextPermissions: effectivePermissions("admin", {}),
      }),
    );
    expect(refusal).toBeNull();
  });

  it("refuses a grant of a capability the actor does not hold, on every door", () => {
    /**
     * The P0.1/P0.2 shape: a delegated manager holds a wide operational set
     * that does *not* include `ledger.post` — the accounting authority the
     * accountant preset owns. Editing somebody into it was already refused;
     * *creating* a member with it, or inviting one, was not, and both are the
     * same escalation.
     */
    const manager = authority("manager", DELEGATED);
    expect(manager.actorPermissions.has(PERMISSIONS.ledgerPost)).toBe(false);

    const withLedgerPost = new Set<Permission>([
      ...projectGrantedPermissions({ role: "cashier", overrides: {} }),
      PERMISSIONS.ledgerPost,
    ]);

    const asCreation = membershipGrantRefusal(
      check({ actor: manager, nextRole: "cashier", nextPermissions: withLedgerPost, isCreation: true }),
    );
    const asUpdate = membershipGrantRefusal(
      check({
        actor: manager,
        nextRole: "cashier",
        nextPermissions: withLedgerPost,
        isCreation: false,
        currentPermissions: projectGrantedPermissions({ role: "cashier", overrides: {} }),
        roleChanges: true,
      }),
    );

    expect(asCreation).toBe("grants_beyond_actor");
    expect(asUpdate).toBe("grants_beyond_actor");
    // Except when the actor genuinely holds it: an accountant may hand out
    // ledger access, which is not an escalation.
    const accountantGrantsLedger = membershipGrantRefusal(
      check({
        actor: authority("accountant", DELEGATED),
        nextRole: "accountant",
        nextPermissions: effectivePermissions("accountant", {}),
      }),
    );
    expect(accountantGrantsLedger).toBeNull();
  });

  it("refuses any access change at all without team.permissions.manage", () => {
    /**
     * `team.manage` is the "add people and set their branches" key — it must
     * NOT be enough to hand out capabilities.
     */
    const cashier = authority("cashier", { granted: [PERMISSIONS.teamManage] });
    const refusal = membershipGrantRefusal(
      check({
        actor: cashier,
        nextRole: "cashier",
        nextPermissions: projectGrantedPermissions({ role: "cashier", overrides: {} }),
      }),
    );
    expect(refusal).toBe("permissions_manage_required");
    expect(grantRefusalMessage(refusal!)).toContain("مدیریت دسترسی‌های تیم");
  });

  it("reserves ownership for owners", () => {
    const admin = authority("admin", DELEGATED);
    expect(
      membershipGrantRefusal(
        check({
          actor: admin,
          nextRole: "owner",
          nextPermissions: effectivePermissions("owner", {}),
        }),
      ),
    ).toBe("owner_only");
  });

  it("refuses a self role change even when the new set is smaller", () => {
    /**
     * Role *identity* is what some decisions key on (approval gates, the
     * first-run wizard), so a strict subset is still a change of identity.
     */
    const manager = authority("manager", DELEGATED);
    expect(
      membershipGrantRefusal(
        check({
          actor: manager,
          nextRole: "cashier",
          nextPermissions: projectGrantedPermissions({ role: "cashier", overrides: {} }),
          isSelf: true,
          isCreation: false,
          roleChanges: true,
          currentPermissions: projectGrantedPermissions({ role: "manager", overrides: {} }),
        }),
      ),
    ).toBe("self_role_change");
  });

  it("does not treat a re-send of the same role as self-promotion", () => {
    const manager = authority("manager", DELEGATED);
    expect(
      membershipGrantRefusal(
        check({
          actor: manager,
          nextRole: "manager",
          nextPermissions: projectGrantedPermissions({ role: "manager", overrides: {} }),
          isSelf: true,
          isCreation: false,
          roleChanges: false,
          currentPermissions: projectGrantedPermissions({ role: "manager", overrides: {} }),
        }),
      ),
    ).toBeNull();
  });

  it("refuses a custom role that outranks its assigner", () => {
    const manager = authority("manager", DELEGATED);
    expect(
      membershipGrantRefusal(
        check({
          actor: manager,
          nextRole: "cashier",
          nextPermissions: projectGrantedPermissions({
            role: "cashier",
            overrides: {},
            customRolePermissions: [PERMISSIONS.ledgerPost],
          }),
          customRole: {
            id: "role-1",
            name: "صندوق‌دار ارشد",
            permissions: [PERMISSIONS.ledgerPost],
            defaultLocationScope: "all",
          },
        }),
      ),
    ).toBe("custom_role_beyond_actor");
  });

  it("keeps owner-only permissions unreachable through a custom role", () => {
    /**
     * An admin holds a wide set but not the owner-only keys; a custom role is
     * not a way around that, which is why the owner-only test comes first.
     */
    const admin = authority("admin", DELEGATED);
    const ownerOnly = [...effectivePermissions("owner", {})].find((permission) =>
      permission.toString().includes("owner"),
    );
    if (!ownerOnly) return; // No owner-only keys in this build: nothing to pin.
    expect(
      membershipGrantRefusal(
        check({
          actor: admin,
          nextRole: "accountant",
          nextPermissions: new Set<Permission>([ownerOnly]),
          customRole: {
            id: "role-2",
            name: "مالک پنهان",
            permissions: [ownerOnly],
            defaultLocationScope: "all",
          },
        }),
      ),
    ).toBe("custom_role_beyond_actor");
  });

  it("never refuses a *reduction* of access", () => {
    const manager = authority("manager", DELEGATED);
    expect(
      membershipGrantRefusal(
        check({
          actor: manager,
          nextRole: "cashier",
          nextPermissions: new Set<Permission>(),
          isCreation: false,
          roleChanges: true,
          currentPermissions: projectGrantedPermissions({ role: "manager", overrides: {} }),
        }),
      ),
    ).toBeNull();
  });
});
