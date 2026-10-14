/**
 * Issue #947 (TEAM-F04 / TEAM-F05), against a real database.
 *
 * The membership → personnel-file guarantee has two halves and this file pins both:
 *
 *   1. **the obligation is part of the membership write** (migration 0223). A `users`
 *      row that commits without a linked file — written by any path, including one that
 *      does not know the guarantee exists — leaves a durable debt in the *same*
 *      transaction. A rolled-back membership leaves nothing at all, because there is no
 *      membership to owe anything for;
 *   2. **the inventory does not trust the bookkeeping.** `listPersonnelFileDebts` reads
 *      the debt from `users` × `parties`, so deleting the drift row does not make a
 *      missing file disappear from the sweep.
 *
 * Plus the properties the issue names for the repair itself: idempotent across retries
 * and restarts (one file, one closed episode), and no file invented for a membership
 * that cannot be named.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let personnel: typeof import("../src/lib/personnel-file");
let team: typeof import("../src/lib/team-service");

const biz = { id: "", locationId: "" };
const other = { id: "", locationId: "" };

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

async function seedBusiness(name: string, slug: string) {
  const row = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [row.rows[0].id],
  );
  return { id: row.rows[0].id, locationId: location.rows[0].id };
}

/** A membership written the way a forgotten writer would: raw SQL, no sync call. */
async function rawMember(
  businessId: string,
  fullName: string,
  phone: string | null = null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, full_name, role, pin_hash, phone_e164)
     VALUES ($1, $2, 'waiter', '$2b$10$notarealhashnotarealhashnotarealhashno', $3)
     RETURNING id`,
    [businessId, fullName, phone],
  );
  return rows[0].id;
}

async function openDrift(businessId: string, userId: string) {
  const { rows } = await db.query<{ reason: string; attempts: number; last_error: string | null }>(
    `SELECT reason, attempts, last_error
       FROM personnel_file_drift
      WHERE business_id = $1 AND user_id = $2 AND resolved_at IS NULL`,
    [businessId, userId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  databaseName = `pos_personnel_file_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  personnel = await import("../src/lib/personnel-file");
  team = await import("../src/lib/team-service");

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
  Object.assign(biz, await seedBusiness("Personnel Alpha", `pf-alpha-${randomUUID().slice(0, 8)}`));
  Object.assign(other, await seedBusiness("Personnel Beta", `pf-beta-${randomUUID().slice(0, 8)}`));
});

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("the personnel-file obligation is part of the membership write (issue #947, F05)", () => {
  it("records a durable debt in the membership's own transaction", async () => {
    const userId = await rawMember(biz.id, "کارمند بی‌پرونده", "+989121119001");

    // No application code ran: the row exists and so does the record of what it owes.
    expect(await openDrift(biz.id, userId)).toMatchObject({
      reason: "file_missing",
      attempts: 0,
      last_error: "awaiting_projection",
    });
  });

  it("aborted the membership, aborted the debt", async () => {
    /*
     * The point of writing the obligation in the same transaction: a membership that
     * never committed cannot leave work behind for a reconciler to chase. Nothing here
     * observes the trigger's row from outside until COMMIT.
     */
    const client = new Client({ connectionString: urlFor(databaseName) });
    await client.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (business_id, full_name, role, pin_hash)
         VALUES ($1, 'هرگز عضو نشد', 'waiter', '$2b$10$notarealhashnotarealhashnotarealhashno')
         RETURNING id`,
        [biz.id],
      );
      // Visible inside the transaction …
      const inside = await client.query(
        "SELECT 1 FROM personnel_file_drift WHERE user_id = $1 AND resolved_at IS NULL",
        [rows[0].id],
      );
      expect(inside.rowCount).toBe(1);
      await client.query("ROLLBACK");
      // … and gone with it.
      const after = await db.query(
        "SELECT 1 FROM personnel_file_drift WHERE user_id = $1",
        [rows[0].id],
      );
      expect(after.rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM users WHERE id = $1", [rows[0].id])).rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("does not disturb an episode that already has a diagnosis", async () => {
    // A real failure recorded by the projection is more specific than the trigger's
    // «owed»; a later identity change must not overwrite it.
    const userId = await rawMember(biz.id, "کارمند خاموش", "+989121119002");
    await db.query(
      `UPDATE personnel_file_drift SET last_error = 'employee_link_taken', reason = 'identity_stale', attempts = 3
        WHERE business_id = $1 AND user_id = $2`,
      [biz.id, userId],
    );
    await db.query("UPDATE users SET full_name = 'کارمند خاموش ۲' WHERE id = $1", [userId]);

    expect(await openDrift(biz.id, userId)).toMatchObject({
      reason: "identity_stale",
      attempts: 3,
      last_error: "employee_link_taken",
    });
  });

  it("closes the episode once the projection has written the file", async () => {
    const userId = await rawMember(biz.id, "کارمند همگام", "+989121119003");
    expect(await openDrift(biz.id, userId)).not.toBeNull();

    const result = await asBusiness(biz.id, () =>
      personnel.ensurePersonnelFileForMembership(biz.id, userId),
    );
    expect(result.ok).toBe(true);
    expect(await openDrift(biz.id, userId)).toBeNull();

    // A later identity change re-opens it, because the file is out of line again — this
    // is the «stale» half of the debt, recorded by the same membership write.
    await db.query("UPDATE users SET phone_e164 = '+989121119004' WHERE id = $1", [userId]);
    expect(await openDrift(biz.id, userId)).toMatchObject({ reason: "identity_stale", attempts: 0 });
  });
});

describe("the inventory is independent of the drift bookkeeping (issue #947, F05)", () => {
  it("finds a member whose drift row was lost", async () => {
    const userId = await rawMember(biz.id, "کارمند گم‌شده", "+989121119005");
    // The bookkeeping disappears; the debt does not.
    await db.query("DELETE FROM personnel_file_drift WHERE business_id = $1", [biz.id]);

    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({
      userId,
      fileId: null,
      reason: "file_missing",
      recorded: false,
    });
  });

  it("reports a stale identity without asking the drift table", async () => {
    const userId = await rawMember(biz.id, "کارمند ناهمخوان", "+989121119006");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    await db.query("DELETE FROM personnel_file_drift WHERE business_id = $1", [biz.id]);
    // The file's own label drifts: the membership was renamed by a writer that never
    // reached the file (a restore, a repair script, an older release).
    await db.query("UPDATE parties SET name = 'نام قدیمی' WHERE business_id = $1", [biz.id]);

    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ userId, reason: "identity_stale", recorded: false });
  });

  it("says nothing when the file matches", async () => {
    const userId = await rawMember(biz.id, "کارمند سالم", "+989121119007");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    // The sync wrote the file; clearing the row is what a healthy member looks like.
    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts).toEqual([]);
  });

  it("never reaches another business's members", async () => {
    await rawMember(other.id, "کارمند کسب‌وکار دیگر", "+989121119008");
    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts).toEqual([]);
    const theirs = await asBusiness(other.id, () => personnel.listPersonnelFileDebts(other.id));
    expect(theirs).toHaveLength(1);
  });
});

describe("the retry is idempotent across attempts and restarts (issue #947, F05)", () => {
  it("creates one file, closes one episode, and stays put when run again", async () => {
    const userId = await rawMember(biz.id, "کارمند تکراری", "+989121119009");

    const first = await asBusiness(biz.id, () =>
      personnel.retryPersonnelFileDrift(biz.id, { userId }),
    );
    expect(first).toMatchObject({ attempted: 1, repaired: 1, remaining: 0 });

    // A second run (a restart, a cron, an operator) must not create a second file.
    const second = await asBusiness(biz.id, () =>
      personnel.retryPersonnelFileDrift(biz.id, { userId }),
    );
    expect(second).toMatchObject({ attempted: 0, repaired: 0, remaining: 0 });

    const files = await db.query<{ id: string }>(
      "SELECT id FROM parties WHERE business_id = $1 AND employee_user_id = $2",
      [biz.id, userId],
    );
    expect(files.rowCount).toBe(1);
    const episodes = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM personnel_file_drift WHERE business_id = $1 AND user_id = $2",
      [biz.id, userId],
    );
    expect(Number(episodes.rows[0].count)).toBe(1);
    const open = await openDrift(biz.id, userId);
    expect(open).toBeNull();
  });

  it("keeps owing a file it cannot invent a name for", async () => {
    /*
     * A payroll row named «کارمند» would follow the person onto a payslip, so the
     * projection refuses to write one — and the debt stays visible (`attempts` > 0,
     * because something did try). The trigger's zero-attempt obligation is promoted by
     * the attempt that failed, which is the honest count of what happened.
     */
    const userId = await rawMember(biz.id, "   ");

    const result = await asBusiness(biz.id, () =>
      personnel.ensurePersonnelFileForMembership(biz.id, userId),
    );
    expect(result).toMatchObject({ ok: false, fileId: null, error: "membership_name_missing" });

    const drift = await openDrift(biz.id, userId);
    expect(drift).toMatchObject({ reason: "file_missing", last_error: "membership_name_missing" });
    expect(drift!.attempts).toBeGreaterThan(0);

    // The inventory agrees with the projection about the debt (the file is missing) …
    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts.map((debt) => debt.userId)).toContain(userId);
    // … and the retry does not pretend to have repaired it.
    const retry = await asBusiness(biz.id, () =>
      personnel.retryPersonnelFileDrift(biz.id, { userId }),
    );
    expect(retry).toMatchObject({ attempted: 1, repaired: 0, remaining: 1 });
  });

  it("is the same guarantee the roster reports (one read, no second opinion)", async () => {
    // The Team roster's flag and the inventory must answer «is this member owed a file»
    // identically — they are the same question asked by a screen and by a script.
    const owed = await rawMember(biz.id, "کارمند نمایان", "+989121119010");
    const healthy = await rawMember(biz.id, "کارمند بی‌نیاز", "+989121119011");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, healthy));
    // Lose the bookkeeping for the owed member: the roster still has to say so.
    await db.query("DELETE FROM personnel_file_drift WHERE business_id = $1 AND user_id = $2", [
      biz.id,
      owed,
    ]);

    const members = await asBusiness(biz.id, () => team.listMembers(biz.id));
    const flagFor = (id: string) => members.find((member) => member.id === id)?.personnelFileDrift;
    expect(flagFor(owed)).toBe(true);
    expect(flagFor(healthy)).toBe(false);
  });
});
