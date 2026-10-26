/**
 * The membership-edit route is the one place in the tenant where a signed-in
 * member can change what *another* member may do — so it is the one place
 * where a bug hands out access instead of merely leaking a read. These tests
 * cover the four refusals that stand between a delegated team administrator
 * and the owner's authority: the owner-only rule, the separate
 * `team.permissions.manage` key, the no-granting-beyond-yourself rule, and the
 * no-promoting-yourself rule.
 *
 * The database is mocked, because what is being pinned is the policy the route
 * applies, not the SQL it runs. `team-service.test.ts` covers the writes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as teamService from "@/lib/team-service";
import { PERMISSIONS, roleBasePermissions } from "@/lib/permissions";
import { lockoutMessage } from "@/lib/team";
import type { Role } from "@/lib/auth";
import { DELETE, PATCH } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", () => ({ query: vi.fn(), withTenant: vi.fn() }));

vi.mock("@/lib/team-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/team-service")>();
  return {
    ...actual,
    updateMembership: vi.fn(),
    removeMembership: vi.fn(),
    deleteMembership: vi.fn(),
    setMemberPhone: vi.fn(),
  };
});

const ACTOR_ID = "actor-1";
const TARGET_ID = "target-1";
const session = { businessId: "biz-1", sub: ACTOR_ID, role: "manager" as Role };

/**
 * Drives `requirePermission` off an explicit capability set, so each test
 * states the editor's authority the way the database would hold it rather than
 * relying on a role string the route deliberately does not trust.
 */
function actingWith(permissions: readonly string[]) {
  vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
    if (permissions.includes(permission)) return { session, error: null };
    return {
      session: null,
      error: {
        status: 403,
        json: async () => ({ error: "forbidden", code: "MISSING_PERMISSION", permission }),
      },
    };
  }) as never);
}

/** The single row the route reads: the editor's and the target's role + overrides. */
function membershipRow(row: {
  actorRole: Role;
  actorOverrides?: unknown;
  targetRole: Role;
  targetOverrides?: unknown;
}) {
  vi.mocked(db.query).mockResolvedValue({
    rows: [
      {
        actor_role: row.actorRole,
        actor_permissions: row.actorOverrides ?? {},
        target_role: row.targetRole,
        target_permissions: row.targetOverrides ?? {},
      },
    ],
  } as never);
}

async function patch(body: unknown, targetId = TARGET_ID) {
  const res = await PATCH(
    new Request(`http://localhost/api/team/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: targetId }) } as never,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const TEAM_ADMIN = [PERMISSIONS.teamManage, PERMISSIONS.teamPermissionsManage] as string[];

beforeEach(() => {
  vi.clearAllMocks();
  actingWith(TEAM_ADMIN);
  membershipRow({ actorRole: "manager", targetRole: "cashier" });
  vi.mocked(teamService.updateMembership).mockResolvedValue(undefined as never);
});

describe("PATCH /api/team/[id] — request validation", () => {
  it("refuses a role that is not in the catalogue", async () => {
    const res = await patch({ role: "superadmin" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_role");
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });

  it("accepts every role the catalogue does define, including the two new ones", async () => {
    // `admin` and `viewer` arrived with the authorization refactor. A route
    // that still carried the old six-role list would make them unassignable.
    for (const role of ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"]) {
      vi.clearAllMocks();
      actingWith(TEAM_ADMIN);
      membershipRow({ actorRole: "owner", targetRole: "cashier" });
      vi.mocked(teamService.updateMembership).mockResolvedValue(undefined as never);
      const res = await patch({ role });
      expect(res.status, `${role} must be assignable`).toBe(200);
    }
  });

  // Issue #1125 (P0): the UI sends "" (empty string) to clear a custom role.
  // The route must normalize that to null before reaching any SQL ::uuid cast,
  // or the request 500s on the invalid input and the clear never persists.
  it("normalizes an empty-string customRoleId to null before reaching SQL", async () => {
    membershipRow({ actorRole: "owner", targetRole: "cashier" });
    const res = await patch({ customRoleId: "" });
    expect(res.status).toBe(200);
    const call = vi.mocked(teamService.updateMembership).mock.calls[0][0];
    expect(call.customRoleId).toBeNull();
  });

  it("refuses a malformed non-empty customRoleId", async () => {
    membershipRow({ actorRole: "owner", targetRole: "cashier" });
    const res = await patch({ customRoleId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_custom_role");
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });

  it("refuses an unrecognised branch scope rather than silently ignoring it", async () => {
    // Dropping it would leave the member on a policy the caller did not ask
    // for and believes they changed.
    const res = await patch({ locationScope: "everywhere" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_location_scope");
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });

  it("accepts the four scopes migration 0170 defines", async () => {
    const cases = [
      { locationScope: "all" },
      { locationScope: "none" },
      { locationScope: "selected", locationIds: ["loc-1"] },
      { locationScope: "home", defaultLocationId: "loc-1" },
    ] as const;
    for (const body of cases) {
      vi.mocked(teamService.updateMembership).mockClear();
      const res = await patch(body);
      expect(res.status, body.locationScope).toBe(200);
      expect(teamService.updateMembership).toHaveBeenCalledWith(
        expect.objectContaining({ locationScope: body.locationScope }),
      );
    }
  });

  it("refuses a body that is not JSON", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/team/${TARGET_ID}`, {
        method: "PATCH",
        body: "not json",
      }) as never,
      { params: Promise.resolve({ id: TARGET_ID }) } as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/team/[id] — which key each edit needs", () => {
  it("lets plain team.manage rename, suspend and re-branch a member", async () => {
    // The point of splitting the keys: the everyday administrative workflow
    // must not start demanding the escalation key.
    actingWith([PERMISSIONS.teamManage]);
    const res = await patch({ fullName: "نام تازه", isActive: false, locationScope: "home" });
    expect(res.status).toBe(200);
  });

  it("refuses a role change to someone holding only team.manage", async () => {
    actingWith([PERMISSIONS.teamManage]);
    const res = await patch({ role: "manager" });
    expect(res.status).toBe(403);
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });

  it("refuses a permission change to someone holding only team.manage", async () => {
    actingWith([PERMISSIONS.teamManage]);
    const res = await patch({ permissions: { granted: ["menu.edit"], revoked: [] } });
    expect(res.status).toBe(403);
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/team/[id] — owner authority", () => {
  it("refuses a non-owner editing an owner", async () => {
    membershipRow({ actorRole: "manager", targetRole: "owner" });
    const res = await patch({ role: "manager" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("refuses a non-owner handing out ownership", async () => {
    membershipRow({ actorRole: "manager", targetRole: "cashier" });
    const res = await patch({ role: "owner" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("reads the role from the database, not from the session token", async () => {
    // A token minted before a demotion must not still spend the access it was
    // minted with. The session here still claims manager; the row says cashier,
    // and the row is what decides.
    membershipRow({ actorRole: "cashier", targetRole: "waiter" });
    const res = await patch({ permissions: { granted: ["payments.refund"], revoked: [] } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("grants_beyond_actor");
  });

  it("404s when the target is not a member of this business", async () => {
    // The join is scoped to the actor's business_id, so a cross-tenant id
    // simply produces no row — it must not fall through to an update.
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    const res = await patch({ fullName: "x" });
    expect(res.status).toBe(404);
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/team/[id] — no granting beyond yourself", () => {
  it("refuses granting a capability the editor does not hold", async () => {
    // The manager preset has no `ledger.post`. A delegated team administrator
    // must not be able to tick it onto anyone, themselves included.
    expect(roleBasePermissions("manager")).not.toContain(PERMISSIONS.ledgerPost);
    const res = await patch({ permissions: { granted: [PERMISSIONS.ledgerPost], revoked: [] } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("grants_beyond_actor");
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });

  it("allows granting a capability the editor does hold", async () => {
    expect(roleBasePermissions("manager")).toContain(PERMISSIONS.menuEdit);
    const res = await patch({ permissions: { granted: [PERMISSIONS.menuEdit], revoked: [] } });
    expect(res.status).toBe(200);
  });

  it("allows revoking a capability the editor does not hold", async () => {
    // Reducing someone's access is never an escalation. An accountant's
    // `ledger.post` must stay removable by a manager who never had it.
    membershipRow({ actorRole: "manager", targetRole: "accountant" });
    const res = await patch({ permissions: { granted: [], revoked: [PERMISSIONS.ledgerPost] } });
    expect(res.status).toBe(200);
  });

  it("does not mistake a target's untouched preset for a new grant", async () => {
    // The check measures the delta, not the resulting set. A manager editing an
    // accountant whose preset already contains `ledger.post` is not granting it.
    membershipRow({ actorRole: "manager", targetRole: "accountant" });
    const res = await patch({ permissions: { granted: [PERMISSIONS.menuEdit], revoked: [] } });
    expect(res.status).toBe(200);
  });

  it("refuses a role promotion that would add capability the editor lacks", async () => {
    // Promotion is the same escalation wearing a different hat: an accountant
    // with the team keys must not be able to mint a manager.
    membershipRow({ actorRole: "accountant", targetRole: "waiter" });
    const res = await patch({ role: "manager" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("grants_beyond_actor");
  });

  it("refuses minting an admin, whose set exceeds every non-owner editor", async () => {
    membershipRow({ actorRole: "manager", targetRole: "cashier" });
    const res = await patch({ role: "admin" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("grants_beyond_actor");
  });

  it("cannot be used to hand out the owner-only api.manage key", async () => {
    // Two independent defences: sanitizeOverrides drops owner-only keys, and
    // effectivePermissions refuses to apply them. Asserted here so that
    // loosening either one fails a test at the route.
    membershipRow({ actorRole: "manager", targetRole: "cashier" });
    const res = await patch({ permissions: { granted: [PERMISSIONS.apiManage], revoked: [] } });
    expect(res.status).toBe(200);
    const call = vi.mocked(teamService.updateMembership).mock.calls[0][0];
    expect(call.overrides?.granted ?? []).not.toContain(PERMISSIONS.apiManage);
  });

  it("lets an owner grant anything, because they already hold everything", async () => {
    membershipRow({ actorRole: "owner", targetRole: "cashier" });
    const res = await patch({ permissions: { granted: [PERMISSIONS.ledgerPost], revoked: [] } });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/team/[id] — no promoting yourself", () => {
  it("refuses a non-owner changing their own role", async () => {
    // Not caught by the permission delta: a few decisions are made on role
    // identity rather than capability (AI autonomous approval, the first-run
    // wizard), so a sideways self-move is still a privilege change.
    membershipRow({ actorRole: "manager", targetRole: "manager" });
    const res = await patch({ role: "accountant" }, ACTOR_ID);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("self_role_change");
    expect(teamService.updateMembership).not.toHaveBeenCalled();
  });

  it("allows a non-owner to edit their own non-role fields", async () => {
    membershipRow({ actorRole: "manager", targetRole: "manager" });
    const res = await patch({ fullName: "نام من" }, ACTOR_ID);
    expect(res.status).toBe(200);
  });

  it("treats a no-op role in the body as no role change", async () => {
    // The UI posts the whole form back, so the member's current role arrives
    // on every save. That must not read as an attempted self-promotion.
    membershipRow({ actorRole: "manager", targetRole: "manager" });
    const res = await patch({ role: "manager", fullName: "نام من" }, ACTOR_ID);
    expect(res.status).toBe(200);
  });

  it("still lets an owner change their own role, guarded only by the last-owner rule", async () => {
    membershipRow({ actorRole: "owner", targetRole: "owner" });
    const res = await patch({ role: "manager" }, ACTOR_ID);
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/team/[id] — offboard vs hard delete (issue #1007)", () => {
  async function del({ hard = false, targetId = TARGET_ID }: { hard?: boolean; targetId?: string } = {}) {
    const url = `http://localhost/api/team/${targetId}${hard ? "?hard=1" : ""}`;
    const res = await DELETE(
      new Request(url, { method: "DELETE" }) as never,
      { params: Promise.resolve({ id: targetId }) } as never,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeEach(() => {
    vi.mocked(teamService.removeMembership).mockResolvedValue(undefined as never);
    vi.mocked(teamService.deleteMembership).mockResolvedValue(undefined as never);
  });

  it("sends the bare request down the offboarding path, not the hard delete", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("offboarded");
    expect(teamService.removeMembership).toHaveBeenCalledWith("biz-1", TARGET_ID, ACTOR_ID);
    expect(teamService.deleteMembership).not.toHaveBeenCalled();
  });

  it("sends ?hard=1 down the hard-delete path, not the offboard", async () => {
    membershipRow({ actorRole: "owner", targetRole: "cashier" });
    const res = await del({ hard: true });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("deleted");
    expect(teamService.deleteMembership).toHaveBeenCalledWith("biz-1", TARGET_ID, ACTOR_ID);
    expect(teamService.removeMembership).not.toHaveBeenCalled();
  });

  it("refuses a non-owner hard-deleting an owner, same as the soft path", async () => {
    membershipRow({ actorRole: "manager", targetRole: "owner" });
    const res = await del({ hard: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
    expect(teamService.deleteMembership).not.toHaveBeenCalled();
  });

  it("refuses a non-owner hard-deleting a non-owner, before any history check", async () => {
    // team.manage alone opens the offboard — erasing is the owner's call, so a
    // manager (or any non-owner role) with ?hard=1 gets 403 and never reaches
    // deleteMembership, whatever the target's role or history.
    membershipRow({ actorRole: "manager", targetRole: "cashier" });
    const res = await del({ hard: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
    expect(teamService.deleteMembership).not.toHaveBeenCalled();
    expect(teamService.removeMembership).not.toHaveBeenCalled();
  });

  it("surfaces the service's Persian reason for a refusal, as-is", async () => {
    // The screen shows `reason` verbatim (issue #1007: «the UI explains why»).
    membershipRow({ actorRole: "owner", targetRole: "cashier" });
    vi.mocked(teamService.deleteMembership).mockRejectedValue(
      new teamService.TeamError("has_history", 409, "این عضو سابقهٔ کاری دارد و قابل حذف نیست."),
    );
    const res = await del({ hard: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("has_history");
    expect(res.body.reason).toBe("این عضو سابقهٔ کاری دارد و قابل حذف نیست.");
  });

  it("keeps the last-owner lockout message on the hard path too", async () => {
    membershipRow({ actorRole: "owner", targetRole: "cashier" });
    vi.mocked(teamService.deleteMembership).mockRejectedValue(
      new teamService.TeamError("last_owner", 409),
    );
    const res = await del({ hard: true });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe(lockoutMessage("last_owner"));
  });
});
