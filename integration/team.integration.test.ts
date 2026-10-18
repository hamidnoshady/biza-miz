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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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

  it("lets two members share a PIN, in one business and across businesses", async () => {
    const created: string[] = [];
    for (const business of [alpha, alpha, beta]) {
      const { userId } = await asBusiness(business.businessId, () =>
        team.createMembership({
          businessId: business.businessId,
          role: "waiter",
          fullName: "Waiter",
          pin: "2468",
          defaultLocationId: business.locationId,
          actorId: business.ownerId,
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
        }),
      );
      created.push(userId);
    }
    expect(new Set(created).size).toBe(3);
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    const preview = await team.previewInvitation(token);
    expect(preview.businessName).toBe("Beta");
    expect(preview.hasExistingLogin).toBe(true);

    /**
     * Issue #854 (P0.4): the link identifies the intended account, it does not
     * prove who is holding it. For an address that already has a login, the
     * ceremony must therefore include that login's password — otherwise anyone
     * who obtained the invitation (forwarded, leaked, intercepted) inherits the
     * membership, and with it every business the identity can reach.
     */
    await expect(team.acceptInvitation(token, null)).rejects.toThrow("authentication_required");
    await expect(team.acceptInvitation(token, "not-the-password")).rejects.toThrow(
      "invalid_credentials",
    );

    const result = await team.acceptInvitation(token, "owner-password");
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    expect((await team.previewInvitation(token)).hasExistingLogin).toBe(false);
    /**
     * A brand-new identity has nothing to authenticate against, so the password
     * *is* the credential — and it goes through the one shared strength
     * validator, whose vocabulary (`password_too_short`) is the same one every
     * other password surface answers with (#854 P2.16).
     */
    await expect(team.acceptInvitation(token, null)).rejects.toThrow("password_too_short");
    await expect(team.acceptInvitation(token, "short")).rejects.toThrow("password_too_short");
    await expect(team.acceptInvitation(token, "        ")).rejects.toThrow("password_blank");

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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    const second = await asBusiness(alpha.businessId, () =>
      team.createInvitation({
        businessId: alpha.businessId,
        email: "twice@example.com",
        role: "manager",
        fullName: "Twice",
        actorId: alpha.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        overrides: { granted: [permissions.PERMISSIONS.reportsView], revoked: [] },
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    expect(secondOwner).toBeTruthy();

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: alpha.ownerId,
        actorId: alpha.ownerId,
        role: "manager",
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    const alphaMembers = await asBusiness(alpha.businessId, () =>
      team.listMembers(alpha.businessId),
    );
    expect(alphaMembers.map((m) => m.fullName)).not.toContain("Beta Cashier");
  });
});

/**
 * Issue #885, gap 6 — the seven-day device trust must not outlive the
 * credential it was earned with.
 *
 * Trust is read by digest with no session in play, so nothing else about a
 * membership going stale takes it back. Both of these are third-party changes
 * to the credential itself: an owner rotating a member's PIN is the "somebody
 * else now knows the secret" case, and offboarding removes the membership
 * entirely. In both, a browser still holding the cookie must stop skipping the
 * OTP and MFA challenges immediately.
 */
describe("device trust does not outlive the credential (issue #885 gap 6)", () => {
  /** A live trust row for `userId`, the shape issueTrustedDevice writes. */
  async function seedTrust(businessId: string, userId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO trusted_devices
         (business_id, user_id, token_hash, trusted_at, expires_at, last_seen_at)
       VALUES ($1, $2, encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
               now(), now() + interval '7 days', now())
       RETURNING id`,
      [businessId, userId],
    );
    return rows[0].id;
  }

  it("revokes device trust when an owner rotates the member's PIN", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Trust Cashier",
        pin: "4816",
        actorId: alpha.ownerId,
      }),
    );
    const trustId = await seedTrust(alpha.businessId, userId);

    await asBusiness(alpha.businessId, () =>
      team.setPin(alpha.businessId, userId, "2468", alpha.ownerId),
    );

    const { rows } = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM trusted_devices WHERE id = $1`,
      [trustId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].revoked_reason).toBe("pin_rotated");
  });

  it("revokes device trust when the membership is offboarded", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Offboard Cashier",
        pin: "9182",
        actorId: alpha.ownerId,
      }),
    );
    const trustId = await seedTrust(alpha.businessId, userId);

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    const { rows } = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM trusted_devices WHERE id = $1`,
      [trustId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].revoked_reason).toBe("member_offboarded");
  });

  it("leaves another business's trust alone", async () => {
    // The revocation is scoped to the tenant being acted on. A digest found
    // globally must not let one business's credential change reach into
    // another's rows.
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Scoped Cashier",
        pin: "5309",
        actorId: alpha.ownerId,
      }),
    );
    const otherTrust = await seedTrust(beta.businessId, userId);

    await asBusiness(alpha.businessId, () =>
      team.setPin(alpha.businessId, userId, "7391", alpha.ownerId),
    );

    const { rows } = await db.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM trusted_devices WHERE id = $1`,
      [otherTrust],
    );
    expect(rows[0].revoked_at).toBeNull();
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
      reason: "تست: دلیل تغییر دسترسی ثبت شد",
    }));
    const before = await db.query<{ membership_revision: string }>("SELECT membership_revision FROM users WHERE id=$1", [userId]);

    await asBusiness(alpha.businessId, () => team.updateMembership({
      businessId: alpha.businessId, userId, actorId: alpha.ownerId, customRoleId: roles[0].id,
      reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
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

/**
 * Issue #947 (TEAM-F03) — the branch policy of a membership is *decided*, not
 * inferred from whichever column happened to be NULL.
 *
 * `createMembership`'s `INSERT` ended in `ELSE 'all'`, so a caller that named no
 * branch policy at all — the shape the PIN-staff form sent — wrote
 * `location_scope = 'all'` with zero `user_locations` rows: the widest possible
 * answer, chosen by nobody, and invisible on the member's own card because there was
 * no assignment row to show it. The pure rule is unit-tested
 * (`location-access.test.ts`); what only a database can show is what lands in the row
 * and in the replica event.
 */
describe("branch policy of a new membership (issue #947, TEAM-F03)", () => {
  async function policyOf(userId: string): Promise<{ scope: string; defaultId: string | null; ids: string[] }> {
    const { rows } = await db.query<{ location_scope: string; location_id: string | null; ids: string[] | null }>(
      `SELECT u.location_scope, u.location_id,
              (SELECT array_agg(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id) AS ids
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return { scope: rows[0].location_scope, defaultId: rows[0].location_id, ids: rows[0].ids ?? [] };
  }

  it("binds a creation that names no branch policy to the business's default branch", async () => {
    /*
     * The whole finding in one case: role, name and PIN — nothing else — and the member
     * must not end up holding every branch of the business. The default is the oldest
     * active branch, the same «when nobody said otherwise» rule the branch service uses.
     */
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Unnamed Policy Cashier",
        pin: "4455",
        actorId: alpha.ownerId,
      }),
    );

    expect(await policyOf(userId)).toEqual({
      scope: "home",
      defaultId: alpha.locationId,
      ids: [],
    });
  });

  it("honours each explicit policy, and never widens one that cannot be honoured", async () => {
    const second = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Policy Second') RETURNING id",
      [alpha.businessId],
    );
    const secondId = second.rows[0].id;

    // all / selected / home / none, named directly.
    const all = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "All Branch Cashier",
        pin: "5566",
        locationScope: "all",
        actorId: alpha.ownerId,
      }),
    );
    expect(await policyOf(all.userId)).toMatchObject({ scope: "all", ids: [] });

    const selected = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Selected Branch Cashier",
        pin: "6677",
        locationScope: "selected",
        locationIds: [secondId],
        actorId: alpha.ownerId,
      }),
    );
    expect(await policyOf(selected.userId)).toMatchObject({ scope: "selected", ids: [secondId] });

    const none = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "No Branch Cashier",
        pin: "7788",
        locationScope: "none",
        actorId: alpha.ownerId,
      }),
    );
    expect(await policyOf(none.userId)).toMatchObject({ scope: "none" });

    // «selected» with nothing selected was an `ELSE 'all'` case; it is now a refusal,
    // and nothing was written.
    await expect(
      asBusiness(alpha.businessId, () =>
        team.createMembership({
          businessId: alpha.businessId,
          role: "cashier",
          fullName: "Impossible Selected",
          pin: "8899",
          locationScope: "selected",
          actorId: alpha.ownerId,
        }),
      ),
    ).rejects.toMatchObject({ message: "selected_locations_required" });
    const rows = await db.query("SELECT 1 FROM users WHERE full_name = 'Impossible Selected'");
    expect(rows.rowCount).toBe(0);
  });

  it("reads a cleared assignment as «none», not as «every branch»", async () => {
    // The update path's own `ELSE 'all'`: unticking every branch used to grant the
    // whole business, including branches opened later.
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Cleared Branches Waiter",
        pin: "9911",
        locationIds: [alpha.locationId],
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
      }),
    );
    /*
     * A creation that names a branch set and no policy reads as «selected» — the same
     * inference every pre-0170 row reads as, and what the old `CASE` produced too. The
     * point of the case is the *second* half: clearing the set must land on «none».
     */
    expect(await policyOf(userId)).toMatchObject({ scope: "selected" });

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationIds: [],
        defaultLocationId: null,
      }),
    );
    expect(await policyOf(userId)).toEqual({ scope: "none", defaultId: null, ids: [] });
  });

  it("records which arm of the rule decided it", async () => {
    /*
     * «Who gave this cashier every branch?» has to have an answer, and the answer is
     * the audit entry: the policy plus the arm that produced it. A member created by a
     * legacy client that named nothing is recorded as `business_default` rather than as
     * an unremarked `all`.
     */
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Audited Policy Cashier",
        pin: "1212",
        actorId: alpha.ownerId,
      }),
    );
    const { rows } = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_log
        WHERE business_id = $1 AND entity_id = $2 AND action = 'team.member_created'
        ORDER BY created_at DESC LIMIT 1`,
      [alpha.businessId, userId],
    );
    expect(rows[0]?.payload).toMatchObject({
      after: { locationScope: "home", locationScopeBasis: "business_default" },
    });
  });

  it("replicates the fallback branch the row actually stored, all the way to access", async () => {
    /*
     * The same unnamed-policy creation, followed through the replication seam — the
     * half a cloud-only assertion cannot see.
     *
     * `membership.created` carried `locations.defaultLocationId`, which is **null** in
     * exactly this case (the caller named no branch, so nothing was assigned), while the
     * row the cloud wrote holds the business's default branch. `applyIamEvents` writes
     * the payload value straight into `users.location_id`, so the site ended up with
     * `location_scope = 'home'` and `location_id = NULL` — and `branchScopeSql`'s home
     * arm is `location_id = $branch`, which no branch satisfies. The member the cloud had
     * hired could not be put on floor work anywhere on the replica, although the two
     * installs agreed about the role, the name and the policy.
     *
     * So this case asserts all three links of the chain: the event says the branch the
     * membership holds, the replica stores it, and the shared eligibility contract then
     * *admits* the replicated member at that branch.
     */
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Replicated Fallback Waiter",
        pin: "7788",
        actorId: alpha.ownerId,
      }),
    );

    // The cloud row: home, bound to the default branch, no explicit assignment.
    const cloud = await db.query<{ location_scope: string; location_id: string | null }>(
      "SELECT location_scope, location_id FROM users WHERE id = $1",
      [userId],
    );
    expect(cloud.rows[0]).toEqual({ location_scope: "home", location_id: alpha.locationId });

    const events = await db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM iam_events
        WHERE business_id = $1 AND event_type = 'membership.created' AND entity_id = $2`,
      [alpha.businessId, userId],
    );
    const payload = JSON.parse(events.rows[0].payload) as {
      membership: { defaultLocationId: string | null; locationScope: string; locationIds: string[] };
    };
    // The event describes the row — the fix this case exists for.
    expect(payload.membership.locationScope).toBe("home");
    expect(payload.membership.defaultLocationId).toBe(alpha.locationId);
    expect(payload.membership.locationIds).toEqual([]);

    /*
     * Apply it the way a Hybrid/Local site does: `applyIamEvents` in the tenant the
     * event belongs to, with the membership id the site materialised for it (a site
     * is another install, so its row ids are its own; the branch ids the payload
     * carries are the tenant's, which is how they resolve at all).
     */
    const iamSync = await import("../src/lib/iam/sync");
    const staff = await import("../src/lib/staff-eligibility");
    const applyCreated = (membershipId: string, defaultLocationId: string | null) =>
      asBusiness(alpha.businessId, () =>
        iamSync.applyIamEvents(alpha.businessId, randomUUID(), 0, [
          {
            id: randomUUID(),
            businessId: alpha.businessId,
            sequence: 1,
            eventType: "membership.created",
            entityType: "membership",
            entityId: membershipId,
            schemaVersion: 1,
            payload: {
              ...(JSON.parse(events.rows[0].payload) as Record<string, unknown>),
              membership: {
                ...payload.membership,
                id: membershipId,
                defaultLocationId,
              },
            },
            actorUserId: null,
            origin: "cloud",
            createdAt: new Date().toISOString(),
          },
        ]),
      );

    const replicatedId = randomUUID();
    await applyCreated(replicatedId, payload.membership.defaultLocationId);

    const replica = await db.query<{ location_scope: string; location_id: string | null }>(
      "SELECT location_scope, location_id FROM users WHERE id = $1",
      [replicatedId],
    );
    expect(replica.rows[0]).toEqual({ location_scope: "home", location_id: alpha.locationId });

    // …and the point of storing it: the replicated member may actually work there.
    expect(
      await asBusiness(alpha.businessId, () =>
        staff.isEligibleStaffAtLocation(alpha.businessId, alpha.locationId, replicatedId),
      ),
    ).toBe(true);
    const roster = await asBusiness(alpha.businessId, () =>
      staff.listEligibleStaffAtLocation(alpha.businessId, alpha.locationId),
    );
    expect(roster.map((row) => row.id)).toContain(replicatedId);

    /*
     * The control: the same event with the value the payload used to carry. A «home»
     * member with no home is not eligible *anywhere*, which is the failure this fix
     * removes — stated here so the reason the field matters cannot be mistaken for a
     * cosmetic difference between two equal values.
     */
    const strandedId = randomUUID();
    await applyCreated(strandedId, null);
    const stranded = await db.query<{ location_scope: string; location_id: string | null }>(
      "SELECT location_scope, location_id FROM users WHERE id = $1",
      [strandedId],
    );
    expect(stranded.rows[0]).toEqual({ location_scope: "home", location_id: null });
    expect(
      await asBusiness(alpha.businessId, () =>
        staff.isEligibleStaffAtLocation(alpha.businessId, alpha.locationId, strandedId),
      ),
    ).toBe(false);
  });
});

/**
 * Issue #854 (P1.12) — a role transition may not strand the membership.
 *
 * The two models are not interchangeable: a password role signs in at the
 * tenant login screen through the global identity, a PIN role signs in at the
 * staff door. Moving a member across the line changes which door exists for
 * them, and before this pass the role was written regardless — leaving an
 * "active" member with no way in.
 *
 * The refusals name the missing credential, because the server deliberately
 * does not invent one (a password or PIN the member never chose is a credential
 * their administrator holds). Suspended memberships move freely: nobody signs in
 * with a suspended membership, so the door is not needed until reactivation —
 * which is checked, and is the third case below.
 */
/**
 * Issue #947 (consumer seam) — the floor's staff eligibility, driven by real policies.
 *
 * `GET /api/staff` (the picker) and `floor.validWaiterId` (the write-side check) both
 * asked `users.location_id IS NULL OR location_id = $2`, which since migration 0170 is
 * the member's *default* branch: a waiter with two branches was missing at one of them,
 * and a waiter with no branch at all stayed assignable at the old one. These cases take
 * the four policies `createMembership` can persist and ask the shared contract what it
 * answers at each branch — the two doors now answer with the same function.
 */
describe("floor staff eligibility (issue #947, consumer seam)", () => {
  let staff: typeof import("../src/lib/staff-eligibility");

  beforeAll(async () => {
    staff = await import("../src/lib/staff-eligibility");
  });

  async function secondLocation(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Eligibility Second') RETURNING id",
      [alpha.businessId],
    );
    return rows[0].id;
  }

  it("follows the policy, not the default branch column", async () => {
    const second = await secondLocation();
    const selected = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Selected Waiter",
        pin: "1010",
        locationScope: "selected",
        locationIds: [second],
        actorId: alpha.ownerId,
      }),
    );

    // Eligible exactly where the policy says, through both halves of the contract.
    expect(await asBusiness(alpha.businessId, () => staff.isEligibleStaffAtLocation(alpha.businessId, second, selected.userId))).toBe(true);
    expect(await asBusiness(alpha.businessId, () => staff.isEligibleStaffAtLocation(alpha.businessId, alpha.locationId, selected.userId))).toBe(false);

    const atSecond = await asBusiness(alpha.businessId, () => staff.listEligibleStaffAtLocation(alpha.businessId, second));
    expect(atSecond.map((row) => row.id)).toEqual([selected.userId]);
    const atHome = await asBusiness(alpha.businessId, () => staff.listEligibleStaffAtLocation(alpha.businessId, alpha.locationId));
    expect(atHome.map((row) => row.id)).not.toContain(selected.userId);
  });

  it("keeps the other three policies honest — home, none and all", async () => {
    const second = await secondLocation();
    const home = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Home Waiter",
        pin: "1212",
        locationScope: "home",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
      }),
    );
    const none = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "No Branch Waiter",
        pin: "1313",
        locationScope: "none",
        actorId: alpha.ownerId,
      }),
    );
    const all = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Every Branch Waiter",
        pin: "1414",
        locationScope: "all",
        actorId: alpha.ownerId,
      }),
    );

    // Sorted, because the list is ordered by the member's name and these are Persian
    // and English names side by side — the *set* is what the contract promises.
    const eligibleAt = async (locationId: string) =>
      (await asBusiness(alpha.businessId, () => staff.listEligibleStaffAtLocation(alpha.businessId, locationId)))
        .map((row) => row.id)
        .sort();

    expect(await eligibleAt(alpha.locationId)).toEqual([home.userId, all.userId].sort());
    expect(await eligibleAt(second)).toEqual([all.userId]);
    // «no branch» means no branch: not the old default, not the new one.
    expect(await eligibleAt(alpha.locationId)).not.toContain(none.userId);
    expect(await eligibleAt(second)).not.toContain(none.userId);
  });

  it("drops a suspended member and keeps roles and tenants apart", async () => {
    const second = await secondLocation();
    const waiter = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Suspended Waiter",
        pin: "1515",
        locationScope: "all",
        actorId: alpha.ownerId,
      }),
    );
    const cashier = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "All Branch Cashier",
        pin: "1616",
        locationScope: "all",
        actorId: alpha.ownerId,
      }),
    );
    // A rival business's branch never appears in this business's eligibility, even for a
    // member id from the wrong tenant.
    const rival = await seedBusiness("Eligibility Rival", `rival-elig-${randomUUID().slice(0, 8)}`, `rival-elig-${randomUUID().slice(0, 8)}@example.ir`);

    const eligible = await asBusiness(alpha.businessId, () => staff.listEligibleStaffAtLocation(alpha.businessId, alpha.locationId));
    expect(eligible.map((row) => row.id)).toContain(waiter.userId);
    // A cashier is not floor staff: the role filter is the contract's, not the caller's.
    expect(eligible.map((row) => row.id)).not.toContain(cashier.userId);
    expect(
      await asBusiness(alpha.businessId, () =>
        staff.isEligibleStaffAtLocation(alpha.businessId, rival.locationId, waiter.userId),
      ),
    ).toBe(false);

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: waiter.userId,
        actorId: alpha.ownerId,
        isActive: false,
      }),
    );
    expect(
      await asBusiness(alpha.businessId, () =>
        staff.isEligibleStaffAtLocation(alpha.businessId, alpha.locationId, waiter.userId),
      ),
    ).toBe(false);
    // The second branch is forbidden to everyone in this business except the roaming
    // member below — the suspended waiter is gone from it too.
    expect(
      await asBusiness(alpha.businessId, () =>
        staff.isEligibleStaffAtLocation(alpha.businessId, second, waiter.userId),
      ),
    ).toBe(false);
  });

  it("keeps the pre-0170 roaming member reachable, and has no widening fallback", async () => {
    /*
     * The two shapes migration 0170's backfill produced, from the other side:
     *
     *  - the old «roaming manager» (no assignment, no default branch) became
     *    `location_scope = 'all'` and must stay reachable everywhere — the floor may not
     *    lose a waiter it used to show;
     *  - a row with no branch *and* a «home» policy reached nowhere before this change
     *    and reaches nowhere now. `home` means «the member's default branch»; when there
     *    is none, the honest answer is «no branch», never «every branch» — the widening
     *    fallback is exactly what TEAM-F03 removed from the membership writers.
     */
    const second = await secondLocation();
    const insert = async (name: string, locationScope?: string) => {
      // The column is `NOT NULL DEFAULT 'home'` since 0170, so «no policy stated» is
      // written by *omitting* it, exactly the way a raw insert of that era would.
      const { rows } = await db.query<{ id: string }>(
        locationScope
          ? `INSERT INTO users (business_id, full_name, role, pin_hash, is_active, location_scope)
             VALUES ($1, $2, 'waiter', '$2b$10$notarealhashnotarealhashnotarealhashno', true, $3::location_scope)
             RETURNING id`
          : `INSERT INTO users (business_id, full_name, role, pin_hash, is_active)
             VALUES ($1, $2, 'waiter', '$2b$10$notarealhashnotarealhashnotarealhashno', true)
             RETURNING id`,
        locationScope ? [alpha.businessId, name, locationScope] : [alpha.businessId, name],
      );
      return rows[0].id;
    };
    const roaming = await insert("Legacy Roaming Waiter", "all");
    const homed = await insert("Branchless Home Waiter");

    const eligible = async (locationId: string, userId: string) =>
      asBusiness(alpha.businessId, () => staff.isEligibleStaffAtLocation(alpha.businessId, locationId, userId));

    expect(await eligible(alpha.locationId, roaming)).toBe(true);
    expect(await eligible(second, roaming)).toBe(true);
    expect(await eligible(alpha.locationId, homed)).toBe(false);
    expect(await eligible(second, homed)).toBe(false);
  });
});

describe("credential-aware role transitions (P1.12)", () => {
  it("refuses to move a PIN member into a password role without a global identity", async () => {
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Stranded",
        pin: "7314",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE business_id = $1 AND full_name = 'Stranded'",
      [alpha.businessId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.updateMembership({
          businessId: alpha.businessId,
          userId: rows[0].id,
          actorId: alpha.ownerId,
          role: "manager",
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
        }),
      ),
    ).rejects.toMatchObject({ message: "identity_required", status: 409 });

    // Nothing half-applied: the member is still a cashier with their PIN.
    const after = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      rows[0].id,
    ]);
    expect(after.rows[0].role).toBe("cashier");
  });

  it("allows the same move once a global identity is linked", async () => {
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Promoted",
        pin: "7315",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    const identity = await db.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ('promoted@example.com', 'hash', 'Promoted') RETURNING id`,
    );
    await db.query(
      "UPDATE users SET platform_user_id = $2 WHERE business_id = $1 AND full_name = 'Promoted'",
      [alpha.businessId, identity.rows[0].id],
    );
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE business_id = $1 AND full_name = 'Promoted'",
      [alpha.businessId],
    );

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: rows[0].id,
        actorId: alpha.ownerId,
        role: "manager",
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    const after = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      rows[0].id,
    ]);
    expect(after.rows[0].role).toBe("manager");
  });

  it("refuses to move a password member onto the staff door without a PIN", async () => {
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "Demoted",
        email: "demoted@example.com",
        password: "manager-password",
        actorId: alpha.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE business_id = $1 AND full_name = 'Demoted'",
      [alpha.businessId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.updateMembership({
          businessId: alpha.businessId,
          userId: rows[0].id,
          actorId: alpha.ownerId,
          role: "cashier",
          reason: "تست: دلیل تغییر دسترسی ثبت شد",
        }),
      ),
    ).rejects.toMatchObject({ message: "pin_required", status: 409 });

    // With a PIN set first — the same order the Team screen asks for — it lands.
    await asBusiness(alpha.businessId, () =>
      team.setPin(alpha.businessId, rows[0].id, "9182", alpha.ownerId),
    );
    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: rows[0].id,
        actorId: alpha.ownerId,
        role: "cashier",
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    const after = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      rows[0].id,
    ]);
    expect(after.rows[0].role).toBe("cashier");
  });

  it("lets a suspended member change model, then insists on the credential before reactivation", async () => {
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "Returning",
        email: "returning@example.com",
        password: "manager-password",
        actorId: alpha.ownerId,
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE business_id = $1 AND full_name = 'Returning'",
      [alpha.businessId],
    );

    // Suspend, then move to the staff door while inactive: allowed, because a
    // suspended membership has no door to lose.
    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: rows[0].id,
        actorId: alpha.ownerId,
        isActive: false,
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: rows[0].id,
        actorId: alpha.ownerId,
        role: "waiter",
        reason: "تست: دلیل تغییر دسترسی ثبت شد",
      }),
    );

    // Reactivation is where the door is needed again — and there is no PIN yet.
    await expect(
      asBusiness(alpha.businessId, () =>
        team.updateMembership({
          businessId: alpha.businessId,
          userId: rows[0].id,
          actorId: alpha.ownerId,
          isActive: true,
        }),
      ),
    ).rejects.toMatchObject({ message: "pin_required", status: 409 });

    await asBusiness(alpha.businessId, () =>
      team.setPin(alpha.businessId, rows[0].id, "9183", alpha.ownerId),
    );
    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId: rows[0].id,
        actorId: alpha.ownerId,
        isActive: true,
      }),
    );
    const after = await db.query<{ is_active: boolean }>(
      "SELECT is_active FROM users WHERE id = $1",
      [rows[0].id],
    );
    expect(after.rows[0].is_active).toBe(true);
  });
});

describe("the rehire ceremony (issue #854 pass 4)", () => {
  /**
   * Offboarding is deliberately destructive — identity linkage severed,
   * credentials revoked, branch scope wiped, the row retained — and rehire is
   * the explicit mirror-image transition that puts all of it back in one
   * locked write. These tests pin that ceremony against a real database.
   */

  async function hireManager(overrides?: { revoked?: string[]; granted?: string[] }) {
    return asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "Rehire Manager",
        email: `rehire.manager.${randomUUID().slice(0, 8)}@example.com`,
        password: "strong-password-1",
        overrides: overrides ?? {},
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: استخدام اولیه برای آزمون بازگشت به کار",
      }),
    );
  }

  it("only rehire what is offboarded — suspended and active members take the ordinary path", async () => {
    const { userId } = await hireManager();

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationScope: "all",
          reason: "تست: بازگشت به کار پیش از قطع همکاری ممکن نیست",
        }),
      ),
    ).rejects.toMatchObject({ message: "not_offboarded", status: 409 });

    await asBusiness(alpha.businessId, () =>
      team.updateMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        isActive: false,
      }),
    );
    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationScope: "all",
          reason: "تست: عضو تعلیق‌شده با فعال‌سازی بازمی‌گردد نه بازگشت به کار",
        }),
      ),
    ).rejects.toMatchObject({ message: "not_offboarded", status: 409 });
  });

  it("restores the identity linkage, role, permissions and branch scope atomically, keeping history", async () => {
    const { userId } = await hireManager({ revoked: ["crm.export"] });
    const identity = await db.query<{ platform_user_id: string }>(
      "SELECT platform_user_id FROM users WHERE id = $1",
      [userId],
    );
    const platformUserId = identity.rows[0].platform_user_id;

    // History the rehire must never touch.
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_by)
       VALUES ($1, 1, 'takeaway', 'completed', 1000, $2)`,
      [alpha.locationId, userId],
    );

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    const offboarded = await db.query<{
      is_active: boolean;
      membership_status: string;
      platform_user_id: string | null;
      location_scope: string;
    }>("SELECT is_active, membership_status, platform_user_id, location_scope FROM users WHERE id = $1", [userId]);
    expect(offboarded.rows[0]).toMatchObject({
      is_active: false,
      membership_status: "offboarded",
      platform_user_id: null,
      location_scope: "none",
    });

    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "selected",
        locationIds: [alpha.locationId],
        reason: "تست: قرارداد دوباره از این ماه شروع می‌شود",
      }),
    );

    const after = await db.query<{
      is_active: boolean;
      membership_status: string;
      platform_user_id: string | null;
      role: string;
      location_scope: string;
      permissions: { revoked?: string[] };
    }>(
      "SELECT is_active, membership_status, platform_user_id, role, location_scope, permissions FROM users WHERE id = $1",
      [userId],
    );
    expect(after.rows[0]).toMatchObject({
      is_active: true,
      membership_status: "active",
      platform_user_id: platformUserId,
      role: "manager",
      location_scope: "selected",
    });
    expect(after.rows[0].permissions.revoked).toContain("crm.export");

    const branches = await db.query(
      "SELECT 1 FROM user_locations WHERE user_id = $1 AND location_id = $2",
      [userId, alpha.locationId],
    );
    expect(branches.rowCount).toBe(1);

    const history = await db.query("SELECT 1 FROM orders WHERE opened_by = $1", [userId]);
    expect(history.rowCount, "history lost during rehire").toBe(1);

    const events = await db.query(
      "SELECT event_type FROM iam_events WHERE business_id = $1 AND entity_id = $2 ORDER BY sequence",
      [alpha.businessId, userId],
    );
    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain("membership.offboarded");
    expect(types[types.length - 1]).toBe("membership.rehired");

    const audit = await db.query<{ payload: { reason?: string } }>(
      "SELECT payload FROM audit_log WHERE business_id = $1 AND action = 'team.member_rehired' AND entity_id = $2",
      [alpha.businessId, userId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].payload.reason).toBe("تست: قرارداد دوباره از این ماه شروع می‌شود");
  });

  it("brings MFA enrolments back with the relink — no bypass, no loss", async () => {
    const { userId } = await hireManager();
    const { rows: linked } = await db.query<{ platform_user_id: string }>(
      "SELECT platform_user_id FROM users WHERE id = $1",
      [userId],
    );
    const platformUserId = linked[0].platform_user_id;

    // A confirmed TOTP factor on the global identity.
    await db.query(
      `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, is_primary, confirmed_at)
       VALUES ('platform_user', $1, 'totp', true, now())`,
      [platformUserId],
    );

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "all",
        reason: "تست: بازگشت به کار باید عامل دومرحله‌ای را برگرداند",
      }),
    );

    const enrolment = await db.query(
      `SELECT 1 FROM mfa_enrolments e JOIN users u ON u.platform_user_id = e.subject_id
        WHERE u.id = $1 AND e.subject_realm = 'platform_user' AND e.method = 'totp'`,
      [userId],
    );
    expect(enrolment.rowCount, "MFA factor must survive offboarding and return with the relink").toBe(1);
  });

  it("restores the PIN that was active at offboarding when no fresh one is named", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Rehire Cashier",
        pin: "5309",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: استخدام صندوق‌دار برای آزمون بازگشت",
      }),
    );
    const before = await db.query<{ id: string; secret_hash: string }>(
      `SELECT id, secret_hash FROM employee_credentials
        WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'`,
      [userId, alpha.businessId],
    );
    expect(before.rowCount).toBe(1);

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "all",
        reason: "تست: بازگشت صندوق‌دار با همان رمز عددی قبلی",
      }),
    );

    const after = await db.query<{ id: string; status: string; secret_hash: string; revoked_at: string | null }>(
      `SELECT id, status, secret_hash, revoked_at FROM employee_credentials
        WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin'`,
      [userId, alpha.businessId],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]).toMatchObject({
      id: before.rows[0].id,
      status: "active",
      secret_hash: before.rows[0].secret_hash,
      revoked_at: null,
    });
  });

  it("provisions a fresh PIN when the rehire names one", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "waiter",
        fullName: "Rehire Waiter",
        pin: "6204",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: استخدام برای آزمون رمز تازه",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "all",
        pin: "8817",
        reason: "تست: بازگشت با رمز عددی تازه",
      }),
    );

    const active = await db.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM employee_credentials
        WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'`,
      [userId, alpha.businessId],
    );
    expect(active.rowCount).toBe(1);
    expect(await bcrypt.compare("8817", active.rows[0].secret_hash)).toBe(true);
  });

  it("restores a PIN even when another member chose the same digits meanwhile", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "First Cashier",
        pin: "4041",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: صندوق‌دار اول برای آزمون رمز مشترک",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Second Cashier",
        pin: "4041",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: صندوق‌دار دوم همان رقم‌ها را انتخاب می‌کند",
      }),
    );

    // A PIN is never compared with a colleague's, so the restore succeeds
    // and nothing about the second cashier's PIN is revealed.
    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "all",
        reason: "تست: بازگشت صندوق‌دار اول بدون رمز تازه",
      }),
    );
    const active = await db.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM employee_credentials
        WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'`,
      [userId, alpha.businessId],
    );
    expect(active.rowCount).toBe(1);
    expect(await bcrypt.compare("4041", active.rows[0].secret_hash)).toBe(true);
  });

  it("refuses a doorless rehire when nothing can be restored, then accepts a fresh PIN", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "kitchen",
        fullName: "Kitchen Hand",
        pin: "9022",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: آشپز برای آزمون فقدان رمز",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    await db.query("DELETE FROM employee_credentials WHERE employee_id = $1", [userId]);

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationScope: "all",
          reason: "تست: بازگشت بدون هیچ رمز قابل بازیابی",
        }),
      ),
    ).rejects.toMatchObject({ message: "pin_required", status: 409 });

    const still = await db.query<{ membership_status: string; is_active: boolean }>(
      "SELECT membership_status, is_active FROM users WHERE id = $1",
      [userId],
    );
    expect(still.rows[0]).toMatchObject({ membership_status: "offboarded", is_active: false });

    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "all",
        pin: "3156",
        reason: "تست: بازگشت آشپز با رمز تازه",
      }),
    );
  });

  it("enforces the reason rule on the write itself", async () => {
    const { userId } = await hireManager();
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationScope: "all",
        }),
      ),
    ).rejects.toMatchObject({ message: "reason_required", status: 400 });

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationScope: "all",
          reason: "کوتاه",
        }),
      ),
    ).rejects.toMatchObject({ message: "reason_too_short", status: 400 });
  });

  it("keeps the offboarded email reserved: re-invitation is refused, rehire restores the same row", async () => {
    const { userId } = await hireManager();
    const { rows: emailRows } = await db.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1",
      [userId],
    );
    const email = emailRows[0].email;

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    // The retained row keeps its email, so hiring «someone new» with it stops
    // with a sentence — the way back is the rehire ceremony on this row.
    await expect(
      asBusiness(alpha.businessId, () =>
        team.createMembership({
          businessId: alpha.businessId,
          role: "manager",
          fullName: "Impersonating Hire",
          email,
          password: "strong-password-2",
          actorId: alpha.ownerId,
          reason: "تست: تلاش برای گرفتن ایمیل عضو قطع‌همکاری‌شده",
        }),
      ),
    ).rejects.toMatchObject({ message: "email_taken", status: 409 });

    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId,
        actorId: alpha.ownerId,
        locationScope: "all",
        reason: "تست: بازگشت همان عضو با همان ایمیل",
      }),
    );
    const restored = await db.query<{ id: string; email: string; membership_status: string }>(
      "SELECT id, email, membership_status FROM users WHERE id = $1",
      [userId],
    );
    expect(restored.rows[0]).toMatchObject({ id: userId, email, membership_status: "active" });
  });

  it("refuses a rehire that would grant capabilities the actor does not hold", async () => {
    // The target: an accountant — the preset carries payroll.manage.
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "accountant",
        fullName: "Offboarded Accountant",
        email: `rehire.accountant.${randomUUID().slice(0, 8)}@example.com`,
        password: "strong-password-3",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: استخدام حسابدار برای آزمون ضدتصعید",
      }),
    );
    // The actor: a manager given team administration but holding none of the
    // accountant's books permissions.
    const { userId: actorId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "Delegated Team Manager",
        email: `rehire.actor.${randomUUID().slice(0, 8)}@example.com`,
        password: "strong-password-4",
        overrides: { granted: ["team.view", "team.manage", "team.permissions_manage"] },
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: اعطای مدیریت تیم به مدیر برای آزمون",
      }),
    );

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId,
          locationScope: "all",
          reason: "تست: بازگشت حسابدار توسط مدیر بدون دسترسی دفترداری",
        }),
      ),
    ).rejects.toMatchObject({ message: "grants_beyond_actor", status: 403 });

    const untouched = await db.query<{ membership_status: string }>(
      "SELECT membership_status FROM users WHERE id = $1",
      [userId],
    );
    expect(untouched.rows[0].membership_status).toBe("offboarded");
  });

  it("demands team.permissions.manage for the rehire grant", async () => {
    const { userId } = await hireManager();
    const { userId: actorId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "manager",
        fullName: "Team Manager Without Permissions Manage",
        email: `rehire.noperm.${randomUUID().slice(0, 8)}@example.com`,
        password: "strong-password-5",
        overrides: { granted: ["team.view", "team.manage"] },
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: مدیر تیم بدون مجوز مدیریت دسترسی‌ها",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId,
          locationScope: "all",
          reason: "تست: بازگشت به کار بدون مجوز مدیریت دسترسی",
        }),
      ),
    ).rejects.toMatchObject({ message: "permissions_manage_required", status: 403 });
  });

  it("only an owner may rehire an owner", async () => {
    // A second owner, so the first may be offboarded without locking out.
    const { userId: secondOwner } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "owner",
        fullName: "Second Owner",
        email: `rehire.owner2.${randomUUID().slice(0, 8)}@example.com`,
        password: "strong-password-6",
        actorId: alpha.ownerId,
        reason: "تست: مالک دوم برای ممکن کردن قطع همکاری مالک",
      }),
    );
    const { userId: adminId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "admin",
        fullName: "Admin Actor",
        email: `rehire.admin.${randomUUID().slice(0, 8)}@example.com`,
        password: "strong-password-7",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: ادمین برای آزمون بازگشت مالک",
      }),
    );

    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, secondOwner, alpha.ownerId),
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId: secondOwner,
          actorId: adminId,
          locationScope: "all",
          reason: "تست: ادمین می‌خواهد مالک را برگرداند",
        }),
      ),
    ).rejects.toMatchObject({ message: "owner_only", status: 403 });

    // The owner who remains may.
    await asBusiness(alpha.businessId, () =>
      team.rehireMembership({
        businessId: alpha.businessId,
        userId: secondOwner,
        actorId: alpha.ownerId,
        locationScope: "all",
        reason: "تست: مالک، مالک دوم را بازمی‌گرداند",
      }),
    );
    const restored = await db.query<{ membership_status: string; role: string }>(
      "SELECT membership_status, role FROM users WHERE id = $1",
      [secondOwner],
    );
    expect(restored.rows[0]).toMatchObject({ membership_status: "active", role: "owner" });
  });

  it("never reaches across tenants", async () => {
    const { userId } = await hireManager();
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    await expect(
      asBusiness(beta.businessId, () =>
        team.rehireMembership({
          businessId: beta.businessId,
          userId,
          actorId: beta.ownerId,
          locationScope: "all",
          reason: "تست: تلاش کسب‌وکار دیگر برای بازگرداندن عضو",
        }),
      ),
    ).rejects.toMatchObject({ message: "not_found", status: 404 });
  });

  it("rolls back completely when the branch policy is refused", async () => {
    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Rollback Cashier",
        pin: "1177",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: صندوق‌دار برای آزمون بازگشت تراکنش",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );
    const snapshot = await db.query<{ membership_status: string; membership_revision: string; creds: string }>(
      `SELECT u.membership_status, u.membership_revision::text,
              (SELECT count(*)::text FROM employee_credentials c
                WHERE c.employee_id = u.id AND c.status = 'revoked') AS creds
         FROM users u WHERE u.id = $1`,
      [userId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.rehireMembership({
          businessId: alpha.businessId,
          userId,
          actorId: alpha.ownerId,
          locationScope: "selected",
          locationIds: [beta.locationId],
          reason: "تست: شعبه‌ای از کسب‌وکار دیگر نباید پذیرفته شود",
        }),
      ),
    ).rejects.toMatchObject({ message: "unknown_location", status: 400 });

    const after = await db.query<{ membership_status: string; membership_revision: string; creds: string }>(
      `SELECT u.membership_status, u.membership_revision::text,
              (SELECT count(*)::text FROM employee_credentials c
                WHERE c.employee_id = u.id AND c.status = 'revoked') AS creds
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    expect(after.rows[0]).toEqual(snapshot.rows[0]);
  });
});

describe("the membership owns the login phone, and the personnel file follows (issue #854 pass 4)", () => {
  it("setMemberPhone travels to the linked party; a party edit cannot travel back", async () => {
    const partiesMod = await import("../src/lib/parties-service");
    const personnelMod = await import("../src/lib/personnel-file");

    const { userId } = await asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: "cashier",
        fullName: "Phone Sync Cashier",
        pin: "5511",
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: صندوق‌دار برای آزمون همگام‌سازی شماره",
      }),
    );
    // Issue #947 — `createMembership` already guaranteed the file; the sync is
    // idempotent, so calling it again is the retry path rather than a second writer.
    await asBusiness(alpha.businessId, () =>
      personnelMod.ensurePersonnelFileForMembership(alpha.businessId, userId),
    );

    // The canonical direction: membership → personnel file.
    await asBusiness(alpha.businessId, () =>
      team.setMemberPhone(alpha.businessId, userId, "+989121112233", alpha.ownerId),
    );
    let file = await asBusiness(alpha.businessId, () => partiesMod.getPartyByEmployee(alpha.businessId, userId));
    expect(file?.phone).toBe("+989121112233");

    // The reverse direction is refused: the party may not rewrite the login phone.
    await expect(
      asBusiness(alpha.businessId, () =>
        partiesMod.updateParty(alpha.businessId, file!.id, { phone: "09129998877" }),
      ),
    ).rejects.toMatchObject({ code: "identity_phone_managed_by_membership" });

    // Clearing the membership phone empties the file's too.
    await asBusiness(alpha.businessId, () =>
      team.setMemberPhone(alpha.businessId, userId, null, alpha.ownerId),
    );
    file = await asBusiness(alpha.businessId, () => partiesMod.getPartyByEmployee(alpha.businessId, userId));
    expect(file?.phone ?? null).toBeNull();
  });
});

describe("hard membership removal (issue #1007)", () => {
  /**
   * The issue: an owner who adds the wrong person (a test member, a duplicate)
   * has no way to erase the row — suspend and offboard keep it forever. The
   * hard delete removes a member nothing in the business points at: the row,
   * the login-identity link and the empty personnel file, with an audit entry
   * left behind. A member *with* history is refused — the flags say which — and
   * stays on the soft-removal path.
   */
  const cleanHistory = {
    orders: false,
    shifts: false,
    journal: false,
    payroll: false,
    audit: false,
    file: false,
  };

  async function makeMember(
    fullName: string,
    options: {
      /** `manager` signs in through a platform identity; `cashier` is PIN staff. */
      role?: "manager" | "cashier";
      pin?: string;
      email?: string;
      password?: string;
    } = {},
  ) {
    return asBusiness(alpha.businessId, () =>
      team.createMembership({
        businessId: alpha.businessId,
        role: options.role ?? "cashier",
        fullName,
        pin: options.pin,
        email: options.email,
        password: options.password,
        defaultLocationId: alpha.locationId,
        actorId: alpha.ownerId,
        reason: "تست: عضوی که برای آزمون حذف ساخته می‌شود",
      }),
    );
  }

  it("deletes a member nothing points at — row, identity link and empty file — and audits it", async () => {
    const { userId } = await makeMember("Mistaken Member", {
      role: "manager",
      email: "mistaken.member@example.com",
      password: "a-strong-password",
    });

    // The creation guarantee made the empty personnel file this delete removes.
    const fileBefore = await db.query<{ id: string }>(
      "SELECT id FROM parties WHERE business_id = $1 AND employee_user_id = $2",
      [alpha.businessId, userId],
    );
    expect(fileBefore.rows, "the fresh member's file should exist").toHaveLength(1);

    const flags = await asBusiness(alpha.businessId, () =>
      team.memberHistoryFlags(alpha.businessId, userId),
    );
    expect(flags).toEqual(cleanHistory);

    await asBusiness(alpha.businessId, () =>
      team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
    );

    const users = await db.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    expect(users.rows, "the membership row must be gone").toHaveLength(0);
    const file = await db.query("SELECT 1 FROM parties WHERE id = $1", [fileBefore.rows[0].id]);
    expect(file.rows, "the empty personnel file must be gone").toHaveLength(0);
    const identity = await db.query(
      "SELECT 1 FROM platform_users WHERE email = 'mistaken.member@example.com'",
    );
    expect(identity.rows, "the orphaned login identity must be purged").toHaveLength(0);

    // The deletion itself is the audit entry the issue asks for.
    const { rows: auditRows } = await db.query<{ user_id: string; payload: unknown }>(
      `SELECT user_id, payload FROM audit_log
        WHERE business_id = $1 AND entity_id = $2 AND action = 'team.member_deleted'`,
      [alpha.businessId, userId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].user_id).toBe(alpha.ownerId);
    expect(auditRows[0].payload).toMatchObject({
      after: { deleted: true, personnelFileDeleted: true, platformIdentityDeleted: true },
    });
  });

  it("keeps the shared login identity when the person is a member of another business", async () => {
    const email = "two.businesses@example.com";
    const { userId: alphaMember } = await makeMember("Two Businesses", {
      role: "manager",
      email,
      password: "a-strong-password",
    });
    // The same person again in Beta: the existing identity is *linked*, and no
    // password is needed — they already have one.
    const { userId: betaMember } = await asBusiness(beta.businessId, () =>
      team.createMembership({
        businessId: beta.businessId,
        role: "manager",
        fullName: "Two Businesses",
        email,
        actorId: beta.ownerId,
        reason: "تست: همان شخص در کسب‌وکار دیگر",
      }),
    );

    await asBusiness(alpha.businessId, () =>
      team.deleteMembership(alpha.businessId, alphaMember, alpha.ownerId),
    );

    // The link is gone with the row; the identity the *other* membership uses stays.
    const stillMember = await db.query("SELECT 1 FROM users WHERE id = $1", [betaMember]);
    expect(stillMember.rows).toHaveLength(1);
    const identity = await db.query<{ id: string }>(
      "SELECT id FROM platform_users WHERE email = $1",
      [email],
    );
    expect(identity.rows, "a shared identity must survive one membership's delete").toHaveLength(1);
  });

  it("refuses a member who opened an order, and keeps the row", async () => {
    const { userId } = await makeMember("Order Opener", { pin: "1122" });
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_by)
       VALUES ($1, 9001, 'takeaway', 'completed', 1000, $2)`,
      [alpha.locationId, userId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "has_history", status: 409 });

    const kept = await db.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    expect(kept.rows).toHaveLength(1);
  });

  it("refuses a member with a worked shift", async () => {
    const { userId } = await makeMember("Shift Worker", { pin: "3344" });
    await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      userId,
      alpha.businessId,
    ]);
    await db.query(
      `INSERT INTO employee_shifts (employee_id, business_id, location_id, business_date)
       VALUES ($1, $2, $3, CURRENT_DATE)`,
      [userId, alpha.businessId, alpha.locationId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "has_history", status: 409 });
  });

  it("refuses a member with a posted journal entry", async () => {
    const { userId } = await makeMember("Journal Poster", { pin: "5566" });
    await db.query(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
       VALUES ($1, CURRENT_DATE, 'تست', 'manual', $2)`,
      [alpha.businessId, userId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "has_history", status: 409 });
  });

  it("refuses a member the audit trail attributes business actions to", async () => {
    const { userId } = await makeMember("Audited Actor", { pin: "7788" });
    await db.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id)
       VALUES ($1, $2, 'settings.business.update', 'settings', 'business')`,
      [alpha.businessId, userId],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "has_history", status: 409 });

    // Their own lifecycle rows alone are *not* history — otherwise no member
    // could ever be deleted (`team.member_created` is written at birth).
    const fresh = await makeMember("Lifecycle Only", { pin: "9900" });
    await db.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id)
       VALUES ($1, $2, 'auth.trusted_device_login', 'user', $3)`,
      [alpha.businessId, fresh.userId, fresh.userId],
    );
    await asBusiness(alpha.businessId, () =>
      team.deleteMembership(alpha.businessId, fresh.userId, alpha.ownerId),
    );
    const gone = await db.query("SELECT 1 FROM users WHERE id = $1", [fresh.userId]);
    expect(gone.rows).toHaveLength(0);
  });

  it("refuses a member with payroll advances before the foreign key would fire", async () => {
    const { userId } = await makeMember("Advance Taker", { pin: "2468" });
    await db.query(
      `INSERT INTO payroll_advances (business_id, user_id, amount, method, advance_date)
       VALUES ($1, $2, 500000, 'cash', CURRENT_DATE)`,
      [alpha.businessId, userId],
    );

    // `payroll_advances.user_id` is `NO ACTION` — without the flag this would be
    // an unexplained foreign-key error instead of the stated refusal.
    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "has_history", status: 409 });
  });

  it("refuses a member whose personnel file carries financial history", async () => {
    const { userId } = await makeMember("File With Orders", { pin: "1357" });
    const file = await db.query<{ id: string }>(
      "SELECT id FROM parties WHERE business_id = $1 AND employee_user_id = $2",
      [alpha.businessId, userId],
    );
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, customer_id)
       VALUES ($1, 9002, 'takeaway', 'completed', 1000, $2)`,
      [alpha.locationId, file.rows[0].id],
    );

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({ message: "has_history", status: 409 });

    // The membership keeps the file that carries its record.
    const kept = await db.query("SELECT 1 FROM parties WHERE id = $1", [file.rows[0].id]);
    expect(kept.rows).toHaveLength(1);
  });

  it("refuses deleting yourself, and never the last active owner", async () => {
    const { userId: manager } = await makeMember("Self Deleting Manager", {
      role: "manager",
      email: "self.deleting.manager@example.com",
      password: "a-strong-password",
    });

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, manager, manager),
      ),
    ).rejects.toMatchObject({ message: "self_delete", status: 403 });

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, alpha.ownerId, manager),
      ),
    ).rejects.toMatchObject({ message: "last_owner", status: 409 });

    // Neither refusal touched a row.
    const { rows } = await db.query("SELECT 1 FROM users WHERE id = ANY($1::uuid[])", [
      [manager, alpha.ownerId],
    ]);
    expect(rows).toHaveLength(2);
  });

  it("deletes an offboarded mistake member — the row the issue says stayed forever", async () => {
    const { userId } = await makeMember("Offboarded Mistake", { pin: "5309" });
    await asBusiness(alpha.businessId, () =>
      team.removeMembership(alpha.businessId, userId, alpha.ownerId),
    );

    await asBusiness(alpha.businessId, () =>
      team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
    );

    const gone = await db.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    expect(gone.rows).toHaveLength(0);
    const { rows: auditRows } = await db.query(
      `SELECT 1 FROM audit_log WHERE business_id = $1 AND entity_id = $2 AND action = 'team.member_deleted'`,
      [alpha.businessId, userId],
    );
    expect(auditRows).toHaveLength(1);
  });

  it("reports the flags that block, so the screen can explain why", async () => {
    const { userId } = await makeMember("Flag Reporter", { pin: "1111" });
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_by)
       VALUES ($1, 9003, 'takeaway', 'completed', 1000, $2)`,
      [alpha.locationId, userId],
    );
    await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      userId,
      alpha.businessId,
    ]);
    await db.query(
      `INSERT INTO employee_shifts (employee_id, business_id, location_id, business_date)
       VALUES ($1, $2, $3, CURRENT_DATE)`,
      [userId, alpha.businessId, alpha.locationId],
    );

    const flags = await asBusiness(alpha.businessId, () =>
      team.memberHistoryFlags(alpha.businessId, userId),
    );
    expect(flags.orders).toBe(true);
    expect(flags.shifts).toBe(true);
    expect(flags.journal).toBe(false);

    await expect(
      asBusiness(alpha.businessId, () =>
        team.deleteMembership(alpha.businessId, userId, alpha.ownerId),
      ),
    ).rejects.toMatchObject({
      message: "has_history",
      reason: expect.stringContaining("سفارش‌ها و پرداخت‌های ثبت‌شده"),
    });
  });
});
