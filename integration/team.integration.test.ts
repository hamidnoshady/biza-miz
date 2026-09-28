/**
 * Phase 13 exit criteria, against a real database.
 *
 * The four things this phase promised:
 *   1. a person already in one business can be invited into another, ending up
 *      with two memberships and one login;
 *   2. revoking a permission takes effect on the next request, without the
 *      member re-authenticating;
 *   3. a business cannot lock itself out of its own account;
 *   4. every membership mutation is auditable.
 *
 * Plus a regression test for the Phase 12 bug this phase fixes: a member
 * created through the setup wizard had no `platform_users` row and therefore
 * could not log in at all.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

/** Modules under test are imported after DATABASE_URL is pointed at the scratch DB. */
let team: typeof import("../src/lib/team-service");
let permissions: typeof import("../src/lib/permissions");
let dbLib: typeof import("../src/lib/db");

const alpha = { businessId: "", locationId: "", ownerId: "" };
const beta = { businessId: "", locationId: "", ownerId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(name: string, slug: string, ownerEmail: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;

  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );

  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, 'Owner') RETURNING id`,
    [ownerEmail, await bcrypt.hash("owner-password", 10)],
  );

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'owner', 'Owner', $3) RETURNING id`,
    [businessId, identity.rows[0].id, ownerEmail],
  );

  return { businessId, locationId: loc.rows[0].id, ownerId: owner.rows[0].id };
}

beforeAll(async () => {
  databaseName = `pos_team_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  team = await import("../src/lib/team-service");
  permissions = await import("../src/lib/permissions");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
  Object.assign(alpha, await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`, "alpha.owner@example.com"));
  Object.assign(beta, await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`, "beta.owner@example.com"));
});

/** Runs `fn` scoped to a business, the way an authenticated request would be. */
function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("membership creation always produces a usable login", () => {
  it("creates the global identity, not just the users row (Phase 12 regression)", async () => {
    // The bug: the setup wizard inserted into `users` with a password_hash but
    // no platform_users row, and login resolves by identity — so the manager it
    // created could never sign in.
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "New Manager",
        email: "manager@example.com",
        password: "manager-password",
        actorId: alpha.ownerId,
      }),
    );

    const identity = await db.query(
      "SELECT id FROM platform_users WHERE email = 'manager@example.com'",
    );
    expect(identity.rowCount, "no platform_users row — this member cannot log in").toBe(1);

    const membership = await db.query<{ platform_user_id: string | null }>(
      "SELECT platform_user_id FROM users WHERE email = 'manager@example.com'",
    );
    expect(membership.rows[0].platform_user_id).toBe(identity.rows[0].id);
  });

  it("creates PIN staff without an identity, since they never log in with a password", async () => {
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Cashier",
        pin: "4816",
        defaultLocationId: alpha.locationId,
        locationIds: [alpha.locationId],
        actorId: alpha.ownerId,
      }),
    );

    const { rows } = await db.query<{ platform_user_id: string | null; legacy_pin_hash: string | null; pin_hash: string }>(
      `SELECT u.platform_user_id, u.pin_hash AS legacy_pin_hash, ec.secret_hash AS pin_hash
         FROM users u
         JOIN employee_credentials ec ON ec.employee_id=u.id AND ec.business_id=u.business_id
          AND ec.credential_type='pin' AND ec.status='active'
        WHERE u.full_name = 'Cashier'`,
    );
    expect(rows[0].platform_user_id).toBeNull();
    expect(rows[0].legacy_pin_hash).toBeNull();
    expect(await bcrypt.compare("4816", rows[0].pin_hash)).toBe(true);
  });

  it("scopes PIN uniqueness to the business, so two businesses may share a PIN", async () => {
    for (const business of [alpha, beta]) {
      await asBusiness(business.businessId, () =>
        team.createMembership({
          businessId: business.businessId,
          role: "waiter",
          fullName: "Waiter",
          pin: "2468",
          defaultLocationId: business.locationId,
          actorId: business.ownerId,
        }),
      );
    }

    await asBusiness(alpha.businessId, async () => {
      expect(await team.isPinTaken(alpha.businessId, "2468")).toBe(true);
      expect(await team.isPinTaken(alpha.businessId, "1357")).toBe(false);
    });
  });
});

describe("cross-business invitation", () => {
  it("gives one person two memberships and one login", async () => {
    // Alpha's owner is invited into Beta. Same email, same identity.
    const { token } = await asBusiness(beta.businessId, () =>
      team.createInvitation({
        businessId: beta.businessId,
        email: "alpha.owner@example.com",
        role: "accountant",
        fullName: "Alpha Owner",
        locationIds: [beta.locationId],
        actorId: beta.ownerId,
      }),
    );

    const preview = await team.previewInvitation(token);
    expect(preview.businessName).toBe("Beta");
    // They already have a login, so acceptance needs no password.
    expect(preview.hasExistingLogin).toBe(true);

    const result = await team.acceptInvitation(token, null);
    expect(result.businessId).toBe(beta.businessId);
    expect(result.role).toBe("accountant");

    const { rows } = await db.query<{ business_id: string; role: string }>(
      `SELECT u.business_id, u.role FROM users u
         JOIN platform_users p ON p.id = u.platform_user_id
        WHERE p.email = 'alpha.owner@example.com' ORDER BY u.role::text`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role)).toEqual(["accountant", "owner"]);

    // One identity, two memberships.
    const identities = await db.query(
      "SELECT id FROM platform_users WHERE email = 'alpha.owner@example.com'",
    );
    expect(identities.rowCount).toBe(1);
  });

  it("creates an identity when the invitee is new to the platform", async () => {
    const { token } = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "newcomer@example.com",
        role: "manager",
        fullName: "Newcomer",
        actorId: alpha.ownerId,
      }),
    );

    expect((await team.previewInvitation(token)).hasExistingLogin).toBe(false);
    await expect(team.acceptInvitation(token, null)).rejects.toThrow("weak_password");
    await expect(team.acceptInvitation(token, "short")).rejects.toThrow("weak_password");

    await team.acceptInvitation(token, "a-good-password");
    const identity = await db.query("SELECT 1 FROM platform_users WHERE email = 'newcomer@example.com'");
    expect(identity.rowCount).toBe(1);
  });

  it("burns the token on acceptance", async () => {
    const { token } = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "once@example.com",
        role: "manager",
        fullName: "Once",
        actorId: alpha.ownerId,
      }),
    );

    await team.acceptInvitation(token, "a-good-password");
    await expect(team.acceptInvitation(token, "a-good-password")).rejects.toThrow(
      "invitation_accepted",
    );
    await expect(team.previewInvitation(token)).rejects.toThrow("invitation_accepted");
  });

  it("refuses a revoked or expired token", async () => {
    const { token, invitationId } = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "revoked@example.com",
        role: "manager",
        fullName: "Revoked",
        actorId: alpha.ownerId,
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.revokeInvitation(alpha.businessId, invitationId, alpha.ownerId),
    );
    await expect(team.acceptInvitation(token, "a-good-password")).rejects.toThrow(
      "invitation_revoked",
    );

    const { token: stale } = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "stale@example.com",
        role: "manager",
        fullName: "Stale",
        actorId: alpha.ownerId,
      }),
    );
    await db.query("UPDATE invitations SET expires_at = now() - interval '1 day'");
    await expect(team.acceptInvitation(stale, "a-good-password")).rejects.toThrow(
      "invitation_expired",
    );
  });

  it("rejects an unknown token without revealing anything", async () => {
    await expect(team.previewInvitation("inv_nonsense")).rejects.toThrow("invalid_invitation");
  });

  it("re-inviting supersedes the pending invitation rather than stacking tokens", async () => {
    const first = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "twice@example.com",
        role: "manager",
        fullName: "Twice",
        actorId: alpha.ownerId,
      }),
    );
    const second = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "twice@example.com",
        role: "manager",
        fullName: "Twice",
        actorId: alpha.ownerId,
      }),
    );

    await expect(team.previewInvitation(first.token)).rejects.toThrow("invitation_revoked");
    expect((await team.previewInvitation(second.token)).email).toBe("twice@example.com");
  });

  it("will not invite someone who is already a member", async () => {
    await expect(
      asBusiness(alpha.businessId, () =>
        team.createInvitation({
          businessId: alpha.businessId,
          email: "alpha.owner@example.com",
          role: "manager",
          fullName: "Alpha Owner",
          actorId: alpha.ownerId,
        }),
      ),
    ).rejects.toThrow("already_a_member");
  });
});

describe("permission changes take effect immediately", () => {
  it("reflects a revoked permission on the very next read, with no re-login", async () => {
    // The session token is untouched here — requirePermission re-reads the
    // membership, which is what makes this true.
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "Manager",
        email: "perm@example.com",
        password: "manager-password",
        actorId: alpha.ownerId,
      }),
    );

    const before = await asBusiness(alpha.businessId, () => team.listMembers(alpha.businessId));
    const managerBefore = before.find((m) => m.id === userId)!;
    expect(managerBefore.effectivePermissions).toContain(permissions.PERMISSIONS.menuEdit);

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        overrides: { granted: [], revoked: [permissions.PERMISSIONS.menuEdit] },
      }),
    );

    const after = await asBusiness(alpha.businessId, () => team.listMembers(alpha.businessId));
    const managerAfter = after.find((m) => m.id === userId)!;
    expect(managerAfter.effectivePermissions).not.toContain(permissions.PERMISSIONS.menuEdit);
  });

  it("grants a permission the role preset does not include", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Trusted Cashier",
        pin: "9182",
        actorId: alpha.ownerId,
      }),
    );

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        overrides: { granted: [permissions.PERMISSIONS.reportsView], revoked: [] },
      }),
    );

    const members = await asBusiness(alpha.businessId, () => team.listMembers(alpha.businessId));
    expect(members.find((m) => m.id === userId)!.effectivePermissions).toContain(
      permissions.PERMISSIONS.reportsView,
    );
  });
});

describe("a business cannot lock itself out", () => {
  it("refuses to demote, suspend or remove the only active owner", async () => {
    for (const change of [
      { role: "manager" as const },
      { isActive: false },
    ]) {
      await expect(
        asBusiness(alpha.businessId, () =>
          team.updateMembership({
            businessId: alpha.businessId,
            userId: alpha.ownerId,
            actorId: alpha.ownerId,
            ...change,
          }),
        ),
      ).rejects.toThrow("last_owner");
    }

    await expect(
      asBusiness(alpha.businessId, () =>
        team.removeMembership(alpha.businessId, alpha.ownerId, alpha.ownerId),
      ),
    ).rejects.toThrow("last_owner");

    // Still an owner, still active.
    const { rows } = await db.query<{ role: string; is_active: boolean }>(
      "SELECT role, is_active FROM users WHERE id = $1",
      [alpha.ownerId],
    );
    expect(rows[0]).toMatchObject({ role: "owner", is_active: true });
  });

  it("allows it once a second owner exists (a business may have several)", async () => {
    const { userId: secondOwner } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "owner",
        fullName: "Second Owner",
        email: "second.owner@example.com",
        password: "second-password",
        actorId: alpha.ownerId,
      }),
    );
    expect(secondOwner).toBeTruthy();

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: alpha.ownerId,
        actorId: alpha.ownerId,
        role: "manager",
      }),
    );

    const { rows } = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      alpha.ownerId,
    ]);
    expect(rows[0].role).toBe("manager");
  });
});

describe("removal preserves history", () => {
  it("deactivates and strips credentials instead of deleting the row", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Departing Cashier",
        pin: "5309",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
      }),
    );

    // An order they opened must stay attributed after removal.
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_by)
       VALUES ($1, 1, 'takeaway', 'completed', 1000, $2)`,
      [alpha.locationId, userId],
    );

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    const { rows } = await db.query<{
      is_active: boolean;
      pin_hash: string | null;
      platform_user_id: string | null;
      full_name: string;
    }>("SELECT is_active, pin_hash, platform_user_id, full_name FROM users WHERE id = $1", [userId]);
    expect(rows[0]).toMatchObject({
      is_active: false,
      pin_hash: null,
      platform_user_id: null,
      full_name: "Departing Cashier",
    });

    const order = await db.query<{ opened_by: string }>(
      "SELECT opened_by FROM orders WHERE opened_by = $1",
      [userId],
    );
    expect(order.rowCount, "history lost its attribution").toBe(1);
  });
});

describe("every membership mutation is auditable", () => {
  it("records create, update and remove with actor and target", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Audited",
        pin: "7391",
        actorId: alpha.ownerId,
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        fullName: "Audited Renamed",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    const { rows } = await db.query<{ action: string; user_id: string; payload: unknown }>(
      `SELECT action, user_id, payload FROM audit_log
        WHERE business_id = $1 AND entity_id = $2 ORDER BY id`,
      [alpha.businessId, userId],
    );

    expect(rows.map((r) => r.action)).toEqual([
      "team.member_created",
      "team.member_updated",
      "team.member_removed",
    ]);
    for (const row of rows) expect(row.user_id).toBe(alpha.ownerId);

    // The update records what actually changed.
    const update = rows[1].payload as { before: { full_name: string }; after: { full_name: string } };
    expect(update.before.full_name).toBe("Audited");
    expect(update.after.full_name).toBe("Audited Renamed");
  });

  it("records invitations and their acceptance", async () => {
    const { token } = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "audited.invite@example.com",
        role: "manager",
        fullName: "Invited",
        actorId: alpha.ownerId,
      }),
    );
    await team.acceptInvitation(token, "a-good-password");

    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE business_id = $1 AND action LIKE 'team.invit%' ORDER BY id`,
      [alpha.businessId],
    );
    expect(rows.map((r) => r.action)).toEqual(["team.invited", "team.invitation_accepted"]);
  });
});

describe("team reads stay inside the business", () => {
  it("lists only its own members", async () => {
    await asBusiness(beta.businessId, () =>
      team.createMembership({
        businessId: beta.businessId,
        role: "cashier",
        fullName: "Beta Cashier",
        pin: "1593",
        actorId: beta.ownerId,
      }),
    );

    const alphaMembers = await asBusiness(alpha.businessId, () =>
      team.listMembers(alpha.businessId),
    );
    expect(alphaMembers.map((m) => m.fullName)).not.toContain("Beta Cashier");
  });
});

describe("custom role assignment revisioning", () => {
  it("increments membership revision exactly once when assigning a custom role", async () => {
    const { rows: roles } = await db.query<{ id: string }>(
      `INSERT INTO tenant_roles(business_id,name,permissions,created_by,updated_by)
       VALUES($1,$2,'[]'::jsonb,$3,$3) RETURNING id`,
      [alpha.businessId, `Revision role ${randomUUID()}`, alpha.ownerId],
    );
    const { userId } = await asBusiness(alpha.businessId, () => team.createMembership({
      businessId: alpha.businessId, role: "cashier", fullName: "Revision Cashier",
      pin: "7531", actorId: alpha.ownerId,
    }));
    const before = await db.query<{ membership_revision: string }>("SELECT membership_revision FROM users WHERE id=$1", [userId]);

    await asBusiness(alpha.businessId, () => team.updateMembership({
      businessId: alpha.businessId, userId, actorId: alpha.ownerId, customRoleId: roles[0].id,
    }));

    const after = await db.query<{ custom_role_id: string; membership_revision: string }>("SELECT custom_role_id,membership_revision FROM users WHERE id=$1", [userId]);
    expect(after.rows[0].custom_role_id).toBe(roles[0].id);
    expect(Number(after.rows[0].membership_revision)).toBe(Number(before.rows[0].membership_revision) + 1);
  });
});

describe("branch assignment", () => {
  /**
   * The rule these tests pin: branch ids arrive from a request body, so every
   * branch-touching membership write proves each id belongs to this business
   * before it is stored (`resolveMemberLocationAssignment` in team.ts is the
   * pure half; the service reads the business's locations and delegates).
   * Before that rule existed, another business's location id was stored into
   * `user_locations`/`location_id` as-is.
   */
  async function secondLocation(businessId: string, name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id",
      [businessId, name],
    );
    return rows[0].id;
  }

  async function assignmentOf(userId: string): Promise<{ defaultId: string | null; ids: string[] }> {
    const { rows } = await db.query<{ location_id: string | null; ids: string[] | null }>(
      `SELECT u.location_id,
              (SELECT array_agg(ul.location_id ORDER BY ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id) AS ids
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return { defaultId: rows[0].location_id, ids: (rows[0].ids ?? []).sort() };
  }

  it("refuses a branch that belongs to another business, on create", async () => {
    await expect(
      asBusiness(alpha.businessId, () =>
        team.createMembership({
          businessId: alpha.businessId,
          role: "cashier",
          fullName: "Cross-Tenant Cashier",
          pin: "1357",
          locationIds: [alpha.locationId, beta.locationId],
          actorId: alpha.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ message: "unknown_location" });

    // Nothing was created — the refusal is not a partial write.
    const { rows } = await db.query(
      "SELECT 1 FROM users WHERE full_name = 'Cross-Tenant Cashier'",
    );
    expect(rows).toHaveLength(0);
  });

  it("folds the default branch into the assignment it must belong to", async () => {
    const second = await secondLocation(alpha.businessId, "Second");
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Two-Branch Cashier",
        pin: "2468",
        // The default is not in the list; the rule adds it rather than storing
        // a home branch the member is not assigned to.
        locationIds: [second],
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
      }),
    );

    const assignment = await assignmentOf(userId);
    expect(assignment.defaultId).toBe(alpha.locationId);
    expect(assignment.ids).toEqual([alpha.locationId, second].sort());
  });

  it("replaces an assignment on update, and clears it with an empty list", async () => {
    const second = await secondLocation(alpha.businessId, "Second");
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Rotating Waiter",
        pin: "9871",
        locationIds: [alpha.locationId],
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
      }),
    );

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationIds: [second],
        defaultLocationId: second,
      }),
    );
    expect(await assignmentOf(userId)).toEqual({ defaultId: second, ids: [second] });

    // Clearing: an owner unticking every branch is a legal write, not an
    // unknown-location refusal.
    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationIds: [],
        defaultLocationId: null,
      }),
    );
    expect(await assignmentOf(userId)).toEqual({ defaultId: null, ids: [] });
  });

  it("refuses a foreign branch on update and leaves the member's assignment untouched", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Guarded Cashier",
        pin: "8642",
        locationIds: [alpha.locationId],
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
      }),
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.updateMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationIds: [beta.locationId],
        }),
      ),
    ).rejects.toMatchObject({ message: "unknown_location" });

    // The refused update rolled back: the original assignment still stands.
    expect(await assignmentOf(userId)).toEqual({ defaultId: alpha.locationId, ids: [alpha.locationId] });
  });
});
