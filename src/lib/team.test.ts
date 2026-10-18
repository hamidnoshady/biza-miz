import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_DAYS,
  checkLastOwner,
  escalationRefusal,
  generateInvitationToken,
  hardDeleteRefusal,
  hardDeleteRefusalMessage,
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  isPasswordRole,
  isPinRole,
  lockoutMessage,
  overridesAreEmpty,
  resolveMemberLocationAssignment,
  sanitizeOverrides,
  type MemberSummary,
} from "./team";
import type { MemberHistoryFlags } from "./member-history";
import { PERMISSIONS } from "./permissions";

describe("invitation tokens", () => {
  it("returns a prefixed token and its hash, never storing the plaintext", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(token.startsWith("inv_")).toBe(true);
    expect(tokenHash).toBe(hashInvitationToken(token));
    // The hash must not contain the token — it's what gets persisted.
    expect(tokenHash).not.toContain(token.slice(4));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a distinct token every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInvitationToken().token));
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically so a presented token can be looked up", () => {
    expect(hashInvitationToken("inv_abc")).toBe(hashInvitationToken("inv_abc"));
    expect(hashInvitationToken("inv_abc")).not.toBe(hashInvitationToken("inv_abd"));
  });

  it("expires the configured number of days out", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiry = invitationExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("invitationStatus", () => {
  const future = new Date("2026-02-01T00:00:00Z");
  const now = new Date("2026-01-10T00:00:00Z");

  it("is pending while unused and unexpired", () => {
    expect(invitationStatus({ expiresAt: future, acceptedAt: null, revokedAt: null }, now)).toBe(
      "pending",
    );
  });

  it("reports accepted ahead of every other state", () => {
    // An accepted invitation that later expires is still "accepted" — the
    // membership exists, and reporting "expired" would be misleading.
    expect(
      invitationStatus(
        { expiresAt: new Date("2026-01-01T00:00:00Z"), acceptedAt: now, revokedAt: now },
        now,
      ),
    ).toBe("accepted");
  });

  it("reports revoked before expiry", () => {
    expect(invitationStatus({ expiresAt: future, acceptedAt: null, revokedAt: now }, now)).toBe(
      "revoked",
    );
  });

  it("expires exactly at the boundary, not after it", () => {
    const at = new Date("2026-01-10T00:00:00Z");
    expect(invitationStatus({ expiresAt: at, acceptedAt: null, revokedAt: null }, at)).toBe("expired");
  });

  it("accepts ISO strings as they come back from the database", () => {
    expect(
      invitationStatus(
        { expiresAt: "2026-02-01T00:00:00Z", acceptedAt: null, revokedAt: null },
        now,
      ),
    ).toBe("pending");
  });
});

describe("role families", () => {
  it("separates password roles from PIN roles exhaustively", () => {
    for (const role of ["owner", "admin", "manager", "accountant"] as const) {
      expect(isPasswordRole(role)).toBe(true);
      expect(isPinRole(role)).toBe(false);
    }
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      expect(isPinRole(role)).toBe(true);
      expect(isPasswordRole(role)).toBe(false);
    }
  });
});

describe("checkLastOwner", () => {
  const members: MemberSummary[] = [
    { id: "owner-1", role: "owner", isActive: true },
    { id: "manager-1", role: "manager", isActive: true },
    { id: "owner-2", role: "owner", isActive: false },
  ];

  it("blocks demoting the only active owner", () => {
    expect(checkLastOwner(members, "owner-1", { role: "manager" })).toBe("last_owner");
  });

  it("blocks suspending the only active owner", () => {
    expect(checkLastOwner(members, "owner-1", { isActive: false })).toBe("last_owner");
  });

  it("blocks removing the only active owner", () => {
    expect(checkLastOwner(members, "owner-1", { remove: true })).toBe("last_owner");
  });

  it("does not count a suspended owner as a way back in", () => {
    // owner-2 exists but is inactive, so owner-1 is still the last active one.
    expect(checkLastOwner(members, "owner-1", { remove: true })).toBe("last_owner");
  });

  it("allows the change once a second active owner exists", () => {
    const withTwo: MemberSummary[] = [...members, { id: "owner-3", role: "owner", isActive: true }];
    expect(checkLastOwner(withTwo, "owner-1", { role: "manager" })).toBeNull();
    expect(checkLastOwner(withTwo, "owner-1", { remove: true })).toBeNull();
    expect(checkLastOwner(withTwo, "owner-1", { isActive: false })).toBeNull();
  });

  it("ignores changes that keep the owner an active owner", () => {
    expect(checkLastOwner(members, "owner-1", { role: "owner" })).toBeNull();
    expect(checkLastOwner(members, "owner-1", { isActive: true })).toBeNull();
    expect(checkLastOwner(members, "owner-1", {})).toBeNull();
  });

  it("never blocks changes to non-owners", () => {
    expect(checkLastOwner(members, "manager-1", { remove: true })).toBeNull();
    expect(checkLastOwner(members, "owner-2", { remove: true })).toBeNull();
  });

  it("is a no-op for an unknown member", () => {
    expect(checkLastOwner(members, "nobody", { remove: true })).toBeNull();
  });

  it("has a message for every reason it can return", () => {
    expect(lockoutMessage("last_owner")).toContain("مالک");
  });
});

describe("hardDeleteRefusal (issue #1007)", () => {
  const members: MemberSummary[] = [
    { id: "owner-1", role: "owner", isActive: true },
    { id: "owner-2", role: "owner", isActive: true },
    { id: "manager-1", role: "manager", isActive: true },
    { id: "cashier-1", role: "cashier", isActive: true },
  ];
  const clean: MemberHistoryFlags = {
    orders: false,
    shifts: false,
    journal: false,
    payroll: false,
    audit: false,
    file: false,
  };

  it("allows deleting a member nothing in the business points at", () => {
    expect(
      hardDeleteRefusal({ members, targetId: "cashier-1", actorId: "owner-1", history: clean }),
    ).toBeNull();
  });

  it("refuses deleting yourself, whoever you are", () => {
    expect(
      hardDeleteRefusal({ members, targetId: "owner-1", actorId: "owner-1", history: clean }),
    ).toBe("self_delete");
    expect(
      hardDeleteRefusal({ members, targetId: "manager-1", actorId: "manager-1", history: clean }),
    ).toBe("self_delete");
  });

  it("refuses deleting the last active owner, even by someone else", () => {
    const lastOwner: MemberSummary[] = [
      { id: "owner-1", role: "owner", isActive: true },
      { id: "manager-1", role: "manager", isActive: true },
    ];
    expect(
      hardDeleteRefusal({ members: lastOwner, targetId: "owner-1", actorId: "manager-1", history: clean }),
    ).toBe("last_owner");
  });

  it("lets an owner delete another owner while one more remains", () => {
    expect(
      hardDeleteRefusal({ members, targetId: "owner-2", actorId: "owner-1", history: clean }),
    ).toBeNull();
  });

  it("refuses a member with any kind of history", () => {
    for (const key of ["orders", "shifts", "journal", "payroll", "audit", "file"] as const) {
      expect(
        hardDeleteRefusal({
          members,
          targetId: "cashier-1",
          actorId: "owner-1",
          history: { ...clean, [key]: true },
        }),
        key,
      ).toBe("has_history");
    }
  });

  it("reports self_delete ahead of history and of the last-owner rule", () => {
    // Deterministic, so the API's error code is stable for the UI.
    expect(
      hardDeleteRefusal({
        members: [{ id: "owner-1", role: "owner", isActive: true }],
        targetId: "owner-1",
        actorId: "owner-1",
        history: { ...clean, orders: true },
      }),
    ).toBe("self_delete");
  });

  it("treats a system actor (null) as no self rule, but keeps the last-owner rule", () => {
    const lastOwner: MemberSummary[] = [{ id: "owner-1", role: "owner", isActive: true }];
    expect(
      hardDeleteRefusal({ members: lastOwner, targetId: "owner-1", actorId: null, history: clean }),
    ).toBe("last_owner");
    expect(
      hardDeleteRefusal({ members, targetId: "cashier-1", actorId: null, history: clean }),
    ).toBeNull();
  });

  it("has a message for every refusal, naming the history for has_history", () => {
    expect(hardDeleteRefusalMessage("self_delete", clean)).toContain("خودتان");
    expect(hardDeleteRefusalMessage("last_owner", clean)).toBe(lockoutMessage("last_owner"));
    const explained = hardDeleteRefusalMessage("has_history", { ...clean, shifts: true, audit: true });
    expect(explained).toContain("شیفت‌های کاری");
    expect(explained).toContain("فعالیت‌های ثبت‌شده در گزارش حسابرسی");
    // A refusal a named flag did not produce (a foreign key the flags do not
    // enumerate) still gets the plain sentence, never «()».
    expect(hardDeleteRefusalMessage("has_history", clean)).not.toContain("()");
  });
});

describe("sanitizeOverrides", () => {
  it("keeps known permissions and sorts them", () => {
    expect(
      sanitizeOverrides({ granted: [PERMISSIONS.ledgerPost, PERMISSIONS.accountsEdit] }),
    ).toEqual({
      granted: [PERMISSIONS.accountsEdit, PERMISSIONS.ledgerPost].sort(),
      revoked: [],
    });
  });

  it("drops unknown and non-string keys instead of rejecting the payload", () => {
    // A stale browser tab naming a removed permission must not 400.
    expect(sanitizeOverrides({ granted: ["made.up", 7, null, PERMISSIONS.menuEdit] })).toEqual({
      granted: [PERMISSIONS.menuEdit],
      revoked: [],
    });
  });

  it("never delegates owner-only permissions", () => {
    expect(sanitizeOverrides({ granted: [PERMISSIONS.apiManage], revoked: [PERMISSIONS.apiManage] })).toEqual({
      granted: [],
      revoked: [],
    });
  });

  it("de-duplicates", () => {
    expect(sanitizeOverrides({ revoked: [PERMISSIONS.menuEdit, PERMISSIONS.menuEdit] })).toEqual({
      granted: [],
      revoked: [PERMISSIONS.menuEdit],
    });
  });

  it("returns empty overrides for junk", () => {
    for (const input of [null, undefined, "x", 5, [], { granted: "not-an-array" }]) {
      expect(sanitizeOverrides(input)).toEqual({ granted: [], revoked: [] });
    }
  });

  it("detects the empty case so it can be stored as {}", () => {
    expect(overridesAreEmpty(sanitizeOverrides(null))).toBe(true);
    expect(overridesAreEmpty(sanitizeOverrides({ granted: [PERMISSIONS.menuEdit] }))).toBe(false);
  });
});

describe("resolveMemberLocationAssignment", () => {
  // Three branches of one business, in creation order.
  const known = ["loc-1", "loc-2", "loc-3"];
  const foreign = "loc-of-another-business";

  it("keeps a plain assignment, order preserved and duplicates folded", () => {
    expect(resolveMemberLocationAssignment(known, ["loc-3", "loc-1", "loc-3"], undefined)).toEqual({
      locationIds: ["loc-3", "loc-1"],
      defaultLocationId: null,
    });
  });

  it("folds the default into the assignment it must belong to", () => {
    expect(resolveMemberLocationAssignment(known, ["loc-1"], "loc-2")).toEqual({
      locationIds: ["loc-1", "loc-2"],
      defaultLocationId: "loc-2",
    });
  });

  it("keeps the default when it is already in the list, without duplicating it", () => {
    expect(resolveMemberLocationAssignment(known, ["loc-1", "loc-2"], "loc-2")).toEqual({
      locationIds: ["loc-1", "loc-2"],
      defaultLocationId: "loc-2",
    });
  });

  it("accepts a default alone — assigning only a home branch", () => {
    expect(resolveMemberLocationAssignment(known, undefined, "loc-1")).toEqual({
      locationIds: ["loc-1"],
      defaultLocationId: "loc-1",
    });
  });

  it("answers empty for a write that names nothing", () => {
    expect(resolveMemberLocationAssignment(known, [], null)).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
    expect(resolveMemberLocationAssignment(known, undefined, undefined)).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
    // Blank strings are "not chosen", the same as absent — an untouched form
    // field must not become an unknown-location refusal.
    expect(resolveMemberLocationAssignment(known, [""], "")).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
  });

  it("refuses a branch the business does not own, wherever it appears", () => {
    // In the assignment — the cross-tenant reference this rule exists to stop.
    expect(resolveMemberLocationAssignment(known, ["loc-1", foreign], null)).toBeNull();
    // In both lists at once.
    expect(resolveMemberLocationAssignment(known, [foreign], foreign)).toBeNull();
    // As the default alone: a home branch nobody owns is still foreign.
    expect(resolveMemberLocationAssignment(known, [], foreign)).toBeNull();
  });

  it("refuses nothing when the write is empty even though the business has branches", () => {
    // The guard must not turn "clear the assignment" into "unknown location":
    // an owner unticking every branch is a legal write.
    expect(resolveMemberLocationAssignment(known, [], undefined)).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
  });
});

describe("escalationRefusal", () => {
  const set = (...keys: string[]) => new Set(keys);

  /** A convenience for the common shape: nothing changes unless a test says so. */
  function check(over: Partial<Parameters<typeof escalationRefusal>[0]>) {
    return escalationRefusal({
      actorRole: "manager",
      actorPermissions: set("menu.edit", "orders.void"),
      isSelf: false,
      currentPermissions: set("menu.view"),
      nextPermissions: set("menu.view"),
      roleChanges: false,
      ...over,
    });
  }

  it("allows an edit that adds nothing", () => {
    expect(check({})).toBeNull();
  });

  it("allows adding a capability the editor holds", () => {
    expect(check({ nextPermissions: set("menu.view", "menu.edit") })).toBeNull();
  });

  it("refuses adding a capability the editor lacks", () => {
    expect(check({ nextPermissions: set("menu.view", "ledger.post") })).toBe("grants_beyond_actor");
  });

  it("allows removing a capability the editor lacks", () => {
    // Reducing access is never escalation, whoever is doing it.
    expect(
      check({ currentPermissions: set("menu.view", "ledger.post"), nextPermissions: set("menu.view") }),
    ).toBeNull();
  });

  it("measures the delta, not the resulting set", () => {
    // The target keeps a capability the editor has never had; that is the
    // status quo, not something this edit is handing out. Checking the whole
    // resulting set instead would block a manager from ever touching an
    // accountant.
    expect(
      check({
        currentPermissions: set("menu.view", "ledger.post"),
        nextPermissions: set("menu.view", "ledger.post", "menu.edit"),
      }),
    ).toBeNull();
  });

  it("refuses a non-owner changing their own role, even sideways", () => {
    expect(check({ isSelf: true, roleChanges: true })).toBe("self_role_change");
  });

  it("allows a non-owner editing their own non-role fields", () => {
    expect(check({ isSelf: true, roleChanges: false })).toBeNull();
  });

  it("allows a non-owner changing someone else's role within their own authority", () => {
    expect(check({ isSelf: false, roleChanges: true })).toBeNull();
  });

  it("exempts the owner from both rules", () => {
    expect(
      check({
        actorRole: "owner",
        actorPermissions: set(),
        isSelf: true,
        roleChanges: true,
        nextPermissions: set("menu.view", "ledger.post"),
      }),
    ).toBeNull();
  });

  it("does not exempt an admin, who is reducible and so not the last word", () => {
    // `admin` is every permission except the owner-only ones *by rule*, but it
    // is deliberately not an absolute role: overrides still apply to it, so an
    // admin whose access has been trimmed must not be able to top itself back
    // up through the team screen.
    expect(
      check({ actorRole: "admin", actorPermissions: set("menu.edit"), nextPermissions: set("menu.view", "ledger.post") }),
    ).toBe("grants_beyond_actor");
  });

  it("reports the self-role rule ahead of the grant rule when both apply", () => {
    // Deterministic, so the API's error code is stable for the UI.
    expect(
      check({ isSelf: true, roleChanges: true, nextPermissions: set("menu.view", "ledger.post") }),
    ).toBe("self_role_change");
  });
});
