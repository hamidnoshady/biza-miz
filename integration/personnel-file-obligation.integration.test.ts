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

/** The file's phone as stored — the column search and the OTP door match on. */
async function filePhone(businessId: string, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM parties WHERE business_id = $1 AND employee_user_id = $2`,
    [businessId, userId],
  );
  return rows[0]?.phone_e164 ?? null;
}

/** The file's label, for the cases that care about the name rather than the phone. */
async function fileLabel(businessId: string, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM parties WHERE business_id = $1 AND employee_user_id = $2`,
    [businessId, userId],
  );
  return rows[0]?.name ?? null;
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

/**
 * The phone arm of the obligation (issue #947, TEAM-F05; migration 0226).
 *
 * 0223's predicate only looked at the phone when the membership *had* one, so clearing a
 * member's number left the old number on their personnel file with nothing recorded and
 * nothing to retry. These cases walk the four directions the arm has to answer — a number
 * replaced, a number cleared, a missing number filled in, and two absences that agree —
 * and then the case the whole guarantee exists for: the membership commits, the process
 * dies before the projection, and the repair still happens because the obligation is in
 * the row the database wrote.
 */
describe("the obligation follows a cleared membership phone (issue #947, F05; 0226)", () => {
  it("records the debt when a number is replaced, and the retry writes the new one", async () => {
    const userId = await rawMember(biz.id, "کارمند تغییرشماره", "+989121119021");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    expect(await filePhone(biz.id, userId)).toBe("+989121119021");

    await db.query("UPDATE users SET phone_e164 = $2 WHERE id = $1", [userId, "+989121119022"]);
    expect(await openDrift(biz.id, userId)).toMatchObject({ reason: "identity_stale", attempts: 0 });

    const retry = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(retry).toMatchObject({ attempted: 1, repaired: 1, remaining: 0 });
    expect(await filePhone(biz.id, userId)).toBe("+989121119022");
  });

  it("records the debt when the membership's number is cleared", async () => {
    /*
     * The arm 0223 missed. The file keeps a number the member no longer has — exactly the
     * state that makes a leaked phone number reachable through search and the OTP door.
     */
    const userId = await rawMember(biz.id, "کارمند بی‌شماره‌شده", "+989121119023");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    expect(await filePhone(biz.id, userId)).toBe("+989121119023");

    await db.query("UPDATE users SET phone_e164 = NULL WHERE id = $1", [userId]);
    expect(await openDrift(biz.id, userId)).toMatchObject({
      reason: "identity_stale",
      last_error: "awaiting_projection",
      attempts: 0,
    });

    // The inventory agrees without reading the drift table, and the repair clears the file.
    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts.map((debt) => debt.userId)).toContain(userId);
    const retry = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(retry).toMatchObject({ attempted: 1, repaired: 1, remaining: 0 });
    expect(await filePhone(biz.id, userId)).toBeNull();
  });

  it("records the debt when a membership gains a number its file does not have", async () => {
    // The mirror direction: the file has nothing, the membership now does.
    const userId = await rawMember(biz.id, "کارمند بی‌شماره");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    expect(await filePhone(biz.id, userId)).toBeNull();

    await db.query("UPDATE users SET phone_e164 = $2 WHERE id = $1", [userId, "+989121119024"]);
    expect(await openDrift(biz.id, userId)).toMatchObject({ reason: "identity_stale", attempts: 0 });

    const retry = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(retry).toMatchObject({ attempted: 1, repaired: 1, remaining: 0 });
    expect(await filePhone(biz.id, userId)).toBe("+989121119024");
  });

  it("says nothing when both sides have no number", async () => {
    /*
     * A false alarm would be a repair task that never ends: the service would compare two
     * absences, find them equal, and clear a row the next membership write re-creates. So
     * the no-number arm has to be silent — a member with no phone is not owed a phone.
     */
    const userId = await rawMember(biz.id, "کارمند بدون شماره");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    expect(await openDrift(biz.id, userId)).toBeNull();

    // Touch the column so the trigger runs again (`AFTER UPDATE OF … phone_e164`).
    await db.query("UPDATE users SET phone_e164 = NULL WHERE id = $1", [userId]);
    expect(await openDrift(biz.id, userId)).toBeNull();
    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts.map((debt) => debt.userId)).not.toContain(userId);
  });

  it("keeps the repair obligation when the process dies after the membership commit", async () => {
    /*
     * The crash the obligation exists for: the membership write commits (the trigger
     * records the debt in that same transaction), and nothing calls the projection —
     * which is what a process that dies between the two looks like from the database's
     * side. The repair is then owed, not lost: the sweep finds it, and the repair clears
     * the file the member no longer matches.
     */
    const userId = await rawMember(biz.id, "کارمند سقوط‌کرده", "+989121119025");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    expect(await openDrift(biz.id, userId)).toBeNull();

    // The membership's phone is cleared and the process stops here — no sync call at all.
    await db.query("UPDATE users SET phone_e164 = NULL WHERE id = $1", [userId]);

    // A later run of the operator's reconciliation, on a fresh connection, is the repair.
    const debtsBefore = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debtsBefore).toMatchObject([{ userId, reason: "identity_stale" }]);
    const sweep = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(sweep).toMatchObject({ attempted: 1, repaired: 1, remaining: 0 });
    expect(await filePhone(biz.id, userId)).toBeNull();
    expect(await openDrift(biz.id, userId)).toBeNull();
  });

  it("backfills a membership already in that state without re-opening settled episodes", async () => {
    /*
     * The migration's inventory half. Simulated by clearing the phone with the trigger
     * disabled — which is what a database written before 0226 looks like — and then
     * asking the corrected predicate to find it. The second member's settled episode must
     * stay settled: the re-run is `ON CONFLICT … DO NOTHING`, like 0223's.
     */
    const userId = await rawMember(biz.id, "کارمند پیش از اصلاح", "+989121119026");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    await db.query("DELETE FROM personnel_file_drift WHERE business_id = $1", [biz.id]);

    await db.query("ALTER TABLE users DISABLE TRIGGER trg_users_personnel_file_obligation");
    try {
      await db.query("UPDATE users SET phone_e164 = NULL WHERE id = $1", [userId]);
    } finally {
      await db.query("ALTER TABLE users ENABLE TRIGGER trg_users_personnel_file_obligation");
    }
    // No trigger ran, so nothing is recorded yet — the state 0226's backfill repairs.
    expect(await openDrift(biz.id, userId)).toBeNull();
    await db.query(
      `INSERT INTO personnel_file_drift (business_id, user_id, reason, last_error, attempts)
       SELECT u.business_id, u.id, 'identity_stale', 'awaiting_projection', 0
         FROM users u
         LEFT JOIN parties p ON p.business_id = u.business_id AND p.employee_user_id = u.id
        WHERE u.business_id = $1
          AND (COALESCE(btrim(u.phone_e164), '') = '' AND COALESCE(btrim(p.phone_e164), '') <> '')
       ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL DO NOTHING`,
      [biz.id],
    );
    expect(await openDrift(biz.id, userId)).toMatchObject({ reason: "identity_stale", attempts: 0 });

    const retry = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(retry).toMatchObject({ repaired: 1, remaining: 0 });
    expect(await filePhone(biz.id, userId)).toBeNull();
  });

  it("keeps the name and email arms exactly as they were", async () => {
    // The correction is scoped to the phone: a rename still owes a repair, and a
    // membership with no email is still not an instruction to clear the file's.
    const userId = await rawMember(biz.id, "کارمند نام‌دار", "+989121119027");
    await asBusiness(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));
    await db.query("UPDATE parties SET email = 'kept@example.com' WHERE employee_user_id = $1", [userId]);

    await db.query("UPDATE users SET full_name = 'نام تازه' WHERE id = $1", [userId]);
    expect(await openDrift(biz.id, userId)).toMatchObject({ reason: "identity_stale" });
    await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(await fileLabel(biz.id, userId)).toBe("نام تازه");

    // The membership has no email; the file's stays put and the member is not «owed».
    await db.query("UPDATE users SET email = NULL WHERE id = $1", [userId]);
    expect(await openDrift(biz.id, userId)).toBeNull();
    const kept = await db.query<{ email: string | null }>(
      "SELECT email::text AS email FROM parties WHERE employee_user_id = $1",
      [userId],
    );
    expect(kept.rows[0].email).toBe("kept@example.com");
  });
});

/**
 * The failure boundary (issue #947, TEAM-F05; found in review of PR #958).
 *
 * `ensurePersonnelFileForMembership` is called *after* the membership change commits, so
 * the one thing it may not do is throw: the caller would report a failed request for a
 * membership that exists, and the retry would come back as «این ایمیل قبلاً استفاده شده
 * است». Two of its steps used to run outside the boundary — the canonical-identity lookup
 * and the nameless case's drift write — so each of the injections below is a case that
 * used to surface as a 500.
 *
 * The injections are real database states, not mocks: a renamed column (the lookup's
 * SELECT stops resolving), a temporary CHECK constraint (reads work, the *write* is
 * refused), and a renamed `personnel_file_drift` (the bookkeeping itself is gone). Every
 * one is restored in a `finally`, because the next test deserves an honest schema.
 */
describe("the synchronization never throws after the caller has committed (issue #947, F05)", () => {
  async function hidePhoneColumn() {
    await db.query("ALTER TABLE users RENAME COLUMN phone_e164 TO phone_e164_hidden");
  }
  async function restorePhoneColumn() {
    await db.query("ALTER TABLE users RENAME COLUMN phone_e164_hidden TO phone_e164");
  }
  /** Reads of `parties` keep working; the projection's *write* is refused. */
  async function blockNewFiles() {
    await db.query(
      "ALTER TABLE parties ADD CONSTRAINT tmp_no_new_employee_file CHECK (employee_user_id IS NULL) NOT VALID",
    );
  }
  async function unblockNewFiles() {
    await db.query("ALTER TABLE parties DROP CONSTRAINT tmp_no_new_employee_file");
  }

  it("answers with a result when the identity lookup itself fails", async () => {
    const userId = await rawMember(biz.id, "کارمند بی‌شناسه", "+989121119031");
    await db.query("DELETE FROM personnel_file_drift WHERE business_id = $1", [biz.id]);

    await hidePhoneColumn();
    let result: Awaited<ReturnType<typeof personnel.ensurePersonnelFileForMembership>>;
    try {
      result = await asBusiness(biz.id, () =>
        personnel.ensurePersonnelFileForMembership(biz.id, userId),
      );
    } finally {
      await restorePhoneColumn();
    }

    // Explicit, and it says nothing it did not measure: no comparison was made, so the
    // reason is «this member may owe a file», not «its identity is stale».
    expect(result).toMatchObject({
      ok: false,
      fileId: null,
      reason: "file_missing",
      error: "identity_lookup_failed",
      recorded: true,
    });
    expect(await openDrift(biz.id, userId)).toMatchObject({
      reason: "file_missing",
      last_error: "identity_lookup_failed",
    });

    // The obligation is durable, so the next attempt — with the schema back — repairs it
    // and closes the episode: a transient failure is not a permanent debt.
    const retry = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(retry).toMatchObject({ attempted: 1, repaired: 1, remaining: 0 });
    expect(await filePhone(biz.id, userId)).toBe("+989121119031");
  });

  it("answers with a result when the projection write fails, and keeps the debt", async () => {
    const userId = await rawMember(biz.id, "کارمند بی‌پرونده‌گیری", "+989121119032");
    await db.query("DELETE FROM personnel_file_drift WHERE business_id = $1", [biz.id]);

    await blockNewFiles();
    let result: Awaited<ReturnType<typeof personnel.ensurePersonnelFileForMembership>>;
    try {
      result = await asBusiness(biz.id, () =>
        personnel.ensurePersonnelFileForMembership(biz.id, userId),
      );
    } finally {
      await unblockNewFiles();
    }

    expect(result).toMatchObject({ ok: false, fileId: null, reason: "file_missing", recorded: true });
    // SQLSTATE + the object that refused the write: a catalog name an operator can look
    // up, not a stack trace and not the useless `error` that node-postgres reports as the
    // name of every server error.
    expect(await openDrift(biz.id, userId)).toMatchObject({
      reason: "file_missing",
      last_error: "23514:tmp_no_new_employee_file",
    });

    // And the debt is payable: the repair writes the file once the schema allows it.
    const retry = await asBusiness(biz.id, () => personnel.retryPersonnelFileDrift(biz.id, { userId }));
    expect(retry).toMatchObject({ repaired: 1, remaining: 0 });
    expect(await fileLabel(biz.id, userId)).toBe("کارمند بی‌پرونده‌گیری");
  });

  it("still refuses to invent a name, and does not fail when that note cannot be written", async () => {
    /*
     * The nameless case used to write its drift row *outside* the boundary: if that write
     * failed, the caller got an exception rather than the explicit refusal it had already
     * decided on. Here the bookkeeping is gone entirely (the table is renamed) and the
     * answer must still be a result — with `recorded: false`, which is the alarm an
     * operator sees, because nothing will retry from a table that is not there.
     */
    const userId = await rawMember(biz.id, "   ");
    await db.query("ALTER TABLE personnel_file_drift RENAME TO personnel_file_drift_hidden");
    let result: Awaited<ReturnType<typeof personnel.ensurePersonnelFileForMembership>>;
    try {
      result = await asBusiness(biz.id, () =>
        personnel.ensurePersonnelFileForMembership(biz.id, userId),
      );
    } finally {
      await db.query("ALTER TABLE personnel_file_drift_hidden RENAME TO personnel_file_drift");
    }

    expect(result).toMatchObject({
      ok: false,
      fileId: null,
      reason: "file_missing",
      error: "membership_name_missing",
      recorded: false,
    });
    // Nothing was invented. The membership's own obligation row — written by the trigger
    // when the row was inserted — is untouched: the failed note neither replaced it nor
    // crashed the request, which is the difference `recorded: false` reports.
    expect(await fileLabel(biz.id, userId)).toBeNull();
    expect(await openDrift(biz.id, userId)).toMatchObject({
      reason: "file_missing",
      last_error: "awaiting_projection",
      attempts: 0,
    });
  });

  it("keeps the obligation transactional: a membership cannot commit without it", async () => {
    /*
     * The other side of the boundary, and the reason it is not a place to hide failures.
     * The trigger writes the obligation inside the membership's transaction, so when the
     * bookkeeping is unavailable the membership write is *refused* — no committed member,
     * no orphaned file, and nothing for a reconciler to guess about. A boundary that
     * swallowed this would produce exactly the member the issue exists to prevent: one
     * that exists in Team with nobody able to say whether their file is owed.
     */
    await db.query("ALTER TABLE personnel_file_drift RENAME TO personnel_file_drift_hidden");
    try {
      await expect(
        asBusiness(biz.id, () =>
          team.createMembership({
            businessId: biz.id,
            role: "cashier",
            fullName: "کارمند بدون دفتر",
            pin: "9090",
            actorId: null,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await db.query("ALTER TABLE personnel_file_drift_hidden RENAME TO personnel_file_drift");
    }

    const left = await db.query("SELECT 1 FROM users WHERE business_id = $1 AND full_name = $2", [
      biz.id,
      "کارمند بدون دفتر",
    ]);
    expect(left.rowCount).toBe(0);
  });

  it("does not turn a committed membership into a failed request", async () => {
    /*
     * The end-to-end shape of the finding: with the file write impossible, a creation must
     * still *succeed* in the caller's eyes — the member exists, the login works, and the
     * only visible trace is a debt the product already knows how to report and repair. The
     * alternative was an exception whose retry hits «email already used», which is the
     * ambiguity this case exists to forbid.
     */
    await blockNewFiles();
    let created: { userId: string };
    try {
      created = await asBusiness(biz.id, () =>
        team.createMembership({
          businessId: biz.id,
          role: "cashier",
          fullName: "کارمند با پروندهٔ معوق",
          email: `blocked-file-${randomUUID().slice(0, 8)}@example.com`,
          password: "starting-password-3",
          pin: "9191",
          actorId: null,
        }),
      );
    } finally {
      await unblockNewFiles();
    }

    expect(created.userId).toBeTruthy();
    const member = await db.query<{ full_name: string; membership_status: string }>(
      "SELECT full_name, membership_status FROM users WHERE id = $1",
      [created.userId],
    );
    expect(member.rows[0]).toMatchObject({
      full_name: "کارمند با پروندهٔ معوق",
      membership_status: "active",
    });
    // The debt is visible where the product already reports it, so the retry repairs the
    // half-written pair rather than the caller re-submitting and colliding with itself.
    const debts = await asBusiness(biz.id, () => personnel.listPersonnelFileDebts(biz.id));
    expect(debts.map((debt) => debt.userId)).toContain(created.userId);
    const retry = await asBusiness(biz.id, () =>
      personnel.retryPersonnelFileDrift(biz.id, { userId: created.userId }),
    );
    expect(retry).toMatchObject({ repaired: 1, remaining: 0 });
    expect(await fileLabel(biz.id, created.userId)).toBe("کارمند با پروندهٔ معوق");
  });
});
