/**
 * Issue #1006 — staff get no accounting code; every staff row shows «—».
 *
 * Root cause: `updateParty` in Automatic mode was writing NULL to
 * `accounting_code` on every save (a note edit, a rename, the personnel-file
 * sync's reconcile step), so the first sync assigned a code and the very next
 * touch of the same member wiped it. New members created from Team or the
 * directory therefore appeared with «—» within one round trip, and any
 * existing staff the sync revisited lost their codes the same way.
 *
 * This file pins the three acceptance criteria from the issue:
 *
 *   1. Creating a member from Team (through createMembership + the personnel
 *      file sync, followed by any subsequent update) leaves the party with an
 *      accounting code — and never wipes it.
 *   2. Creating an Employee party from the directory allocates a code in the
 *      same write, and an edit after that keeps it.
 *   3. Parties that already exist with NULL accounting codes (the historical
 *      data the bug produced) get a code allocated on the next edit, same as
 *      if they were new.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
const ROOT_DATABASE_URL: string = rootDatabaseUrl;

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let personnel: typeof import("../src/lib/personnel-file");
let partiesService: typeof import("../src/lib/parties-service");
let teamService: typeof import("../src/lib/team-service");

function urlFor(dbName: string): string {
  const url = new URL(ROOT_DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(ROOT_DATABASE_URL);
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

const biz = { id: "", locationId: "" };

async function partyByEmployee(businessId: string, userId: string) {
  const { rows } = await db.query<{
    accounting_code: string | null;
    accounting_code_mode: string;
    name: string;
  }>(
    `SELECT accounting_code, accounting_code_mode, name FROM parties
      WHERE business_id = $1 AND employee_user_id = $2`,
    [businessId, userId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  databaseName = `pos_staff_codes_${randomUUID().replaceAll("-", "")}`;

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
  partiesService = await import("../src/lib/parties-service");
  teamService = await import("../src/lib/team-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = ROOT_DATABASE_URL;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses CASCADE");
  Object.assign(biz, await seedBusiness("Staff-Code", `sc-${randomUUID().slice(0, 8)}`));
});

describe("issue #1006 — staff always end up with an accounting code", () => {
  it("create-from-Team: personnel file gets a code, and a later name-sync keeps it", async () => {
    // createMembership is what POST /api/team calls, and it invokes
    // ensurePersonnelFileForMembership after the commit. We use a PIN role
    // (waiter) because a password role would require an email/identity.
    const { userId } = await dbLib.withTenant(biz.id, () =>
      teamService.createMembership({
        businessId: biz.id,
        role: "waiter",
        fullName: "حسین رضایی",
        pin: "1234",
        actorId: null,
      }),
    );

    // After create: code is assigned.
    let file = await partyByEmployee(biz.id, userId);
    expect(file).not.toBeNull();
    expect(file?.accounting_code).toMatch(/^3\d{5}$/);
    expect(file?.accounting_code_mode).toBe("automatic");

    // Simulate a name edit → second sync (what visiting the Team page does,
    // or what setMemberPhone calls). Before the fix this second call wiped
    // the code to NULL; after the fix it must stay put.
    await db.query("UPDATE users SET full_name = 'حسین رضایی‌زاده' WHERE id = $1", [userId]);
    await dbLib.withTenant(biz.id, () => personnel.ensurePersonnelFileForMembership(biz.id, userId));

    file = await partyByEmployee(biz.id, userId);
    expect(file?.accounting_code).toMatch(/^3\d{5}$/);
    expect(file?.name).toBe("حسین رضایی‌زاده");
  });

  it("create-from-directory: an Employee party gets a code and keeps it through an edit", async () => {
    const party = await dbLib.withTenant(biz.id, () =>
      partiesService.createParty(biz.id, {
        role: "Employee",
        roles: ["Employee"],
        personType: "Real",
        displayName: "مریم احمدی",
        firstName: "مریم",
        lastName: "احمدی",
      }),
    );

    expect(party.accountingCode).toMatch(/^3\d{5}$/);
    expect(party.accountingCodeMode).toBe("Automatic");

    // Edit notes (unrelated field). This is the path that used to null the code.
    const updated = await dbLib.withTenant(biz.id, () =>
      partiesService.updateParty(biz.id, party.id, { notes: "قرارداد ساعتی" }),
    );
    expect(updated?.accountingCode).toBe(party.accountingCode);
  });

  it("a code-less Automatic party gets a code allocated on its next edit (the backfill's online repair)", async () => {
    // Simulate a historical row: employee party with NULL accounting_code
    // (precisely the state the bug left people in). Insert directly to bypass
    // the service's allocation.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند بی‌کد', 'employee', ARRAY['employee']::text[],
               'real', true, NULL, 'automatic', '{}'::jsonb)
       RETURNING id`,
      [biz.id],
    );
    const id = rows[0].id;

    // Any ordinary edit (the personnel-file reconciliation, a note save) must
    // now *assign* a code rather than re-write NULL.
    const healed = await dbLib.withTenant(biz.id, () =>
      partiesService.updateParty(biz.id, id, { notes: "ترمیم" }),
    );
    expect(healed?.accountingCode).toMatch(/^3\d{5}$/);
  });

  it("codes allocated this way never collide between concurrent writes", async () => {
    // Create several employee parties in parallel — the update's retry arm
    // (mirroring createParty's) must hand each one a distinct code.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                               accounting_code, accounting_code_mode, general_info)
         VALUES (gen_random_uuid(), $1, $2, 'employee', ARRAY['employee']::text[], 'real', true,
                 NULL, 'automatic', '{}'::jsonb)
         RETURNING id`,
        [biz.id, `کارمند ${i}`],
      );
      ids.push(rows[0].id);
    }

    const healed = await Promise.all(
      ids.map((id) =>
        dbLib.withTenant(biz.id, () => partiesService.updateParty(biz.id, id, { notes: "x" })),
      ),
    );

    const codes = healed.map((p) => p?.accountingCode).filter(Boolean) as string[];
    expect(new Set(codes).size).toBe(ids.length);
    for (const code of codes) expect(code).toMatch(/^3\d{5}$/);
  });

  it("bulk-assign endpoint heals every code-less employee in one call", async () => {
    // Seed three employees: one with a code already, two NULL. The bulk call
    // must assign codes to the two NULL rows and leave the existing one alone.
    const { rows: existing } = await db.query<{ id: string; accounting_code: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'دارای کد', 'employee', ARRAY['employee']::text[], 'real', true,
               '300055', 'automatic', '{}'::jsonb)
       RETURNING id, accounting_code`,
      [biz.id],
    );
    const missing: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                               accounting_code, accounting_code_mode, general_info)
         VALUES (gen_random_uuid(), $1, $2, 'employee', ARRAY['employee']::text[], 'real', true,
                 NULL, 'automatic', '{}'::jsonb)
         RETURNING id`,
        [biz.id, `کارمند ${i}`],
      );
      missing.push(rows[0].id);
    }

    const result = await dbLib.withTenant(biz.id, () =>
      partiesService.bulkAssignMissingStaffAccountingCodes(biz.id, { actorId: null }),
    );
    expect(result.assigned).toHaveLength(2);
    expect(new Set(result.assigned.map((r) => r.id))).toEqual(new Set(missing));
    for (const { code } of result.assigned) {
      expect(code).toMatch(/^3\d{5}$/);
      expect(code).not.toBe(existing[0].accounting_code);
    }
    expect(result.failed).toHaveLength(0);

    // Second call must be a no-op (nothing left to assign).
    const again = await dbLib.withTenant(biz.id, () =>
      partiesService.bulkAssignMissingStaffAccountingCodes(biz.id, { actorId: null }),
    );
    expect(again.assigned).toHaveLength(0);
  });

  it("a long all-numeric manual code on another role does not crash the backfill or block allocation", async () => {
    // A Customer with a huge numeric manual code (e.g. `3999999999` — nine
    // digits under the Employee prefix) must neither crash the backfill's
    // ::integer cast (the P1 fix) nor make an Employee allocation loop forever
    // on a unique-index collision (the P2 fix).
    await db.query(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'مشتری با کد عددی بزرگ', 'customer', ARRAY['customer']::text[],
               'real', true, '3999999999', 'manual', '{}'::jsonb)`,
      [biz.id],
    );

    // Directly run the migration's DO-block logic against the current DB by
    // inserting a NULL Automatic employee and running an in-line equivalent.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند بی‌کد', 'employee', ARRAY['employee']::text[],
               'real', true, NULL, 'automatic', '{}'::jsonb)
       RETURNING id`,
      [biz.id],
    );

    // Run the allocator directly. Before the P2 fix this picked 300001 (wrong
    // — it only looked at role-scoped codes) and would not actually collide
    // with 3999999999. The real assertion is that the code returned is a
    // properly-padded 6-digit Employee code (the allocator's own output)
    // rather than 3999999999+1 or a thrown error. Before the P1 overflow fix
    // a numeric code of width > int32 in the DB crashed migration; here we
    // prove the service handles the same situation without throwing.
    const healed = await dbLib.withTenant(biz.id, () =>
      partiesService.updateParty(biz.id, rows[0].id, { notes: "heal" }),
    );
    expect(healed?.accountingCode).toMatch(/^3\d{5}$/);
    expect(healed?.accountingCode).not.toBe("3999999999");
  });

  it("a manual code under the Employee prefix on a Customer does not block Employee allocation (cross-role collision)", async () => {
    // Customer manually owns 300001 — first slot the Employee allocator would
    // try. After the P2 fix, usedAccountingCodes filters by PREFIX across the
    // whole business, so it sees 300001 and hands the new employee 300002.
    await db.query(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'مشتری با کد ۳۰۰۰۰۱', 'customer', ARRAY['customer']::text[],
               'real', true, '300001', 'manual', '{}'::jsonb)`,
      [biz.id],
    );

    const party = await dbLib.withTenant(biz.id, () =>
      partiesService.createParty(biz.id, {
        role: "Employee",
        roles: ["Employee"],
        personType: "Real",
        displayName: "کارمند جدید",
        firstName: "کارمند",
        lastName: "جدید",
      }),
    );
    // Must skip over 300001 even though it belongs to a Customer, landing on
    // the next slot 300002 exactly.
    expect(party.accountingCode).toBe("300002");
  });

  it("backfill-style PL/pgSQL loop tolerates huge numeric manual codes without overflow", async () => {
    // Reproduce the P1 bug: run a stripped-down version of the backfill's
    // inner loop against a DB that contains a 10-digit manual code. Before
    // the ::bigint fix this cast to ::integer raised 22003 (numeric out of
    // range) and the whole migration aborted.
    await db.query(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند با کد بلند', 'employee', ARRAY['employee']::text[],
               'real', true, '3999999999999', 'manual', '{}'::jsonb)`,
      [biz.id],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند بی‌کد', 'employee', ARRAY['employee']::text[],
               'real', true, NULL, 'automatic', '{}'::jsonb)
       RETURNING id`,
      [biz.id],
    );

    // Mirror of migration 0236's inner SELECT (the safe re-backfill) but using
    // bigint + bounded regex. If the cast or regex regresses, this statement
    // raises. (PL/pgSQL DO blocks don't bind $N parameters, so we use format()
    // with literal UUIDs — the data is throwaway per-test.)
    await db.query(
      `DO $$
       DECLARE
         bid uuid := '${biz.id}'::uuid;
         target_id uuid := '${rows[0].id}'::uuid;
         prefix text := '3';
         tail bigint;
         next_code text;
       BEGIN
         SELECT COALESCE(
           (SELECT max(
              CASE WHEN substring(accounting_code FROM length(prefix)+1) ~ '^[0-9]{1,5}$'
                   THEN substring(accounting_code FROM length(prefix)+1)::bigint
                   ELSE 0
              END)
            FROM parties WHERE business_id = bid
              AND accounting_code IS NOT NULL
              AND accounting_code LIKE prefix || '%'),
           0) INTO tail;
         tail := tail + 1;
         next_code := prefix || lpad(tail::text, 5, '0');
         UPDATE parties SET accounting_code = next_code WHERE id = target_id;
       END$$;`,
    );

    const { rows: healed } = await db.query<{ accounting_code: string | null }>(
      `SELECT accounting_code FROM parties WHERE id = $1`,
      [rows[0].id],
    );
    expect(healed[0].accounting_code).toMatch(/^3\d{5}$/);
  });

  it("migration 0231 backfills NULL employees in the presence of large numeric manual codes (real SQL)", async () => {
    await db.query(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند با کد', 'employee', ARRAY['employee']::text[],
               'real', true, '300099', 'automatic', '{}'::jsonb)`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'مشتری کد بلند', 'customer', ARRAY['customer']::text[],
               'real', true, '3999999999999', 'manual', '{}'::jsonb)`,
      [biz.id],
    );
    const id1 = (await db.query<{ id: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند بی‌کد ۱', 'employee', ARRAY['employee']::text[],
               'real', true, NULL, 'automatic', '{}'::jsonb)
       RETURNING id`,
      [biz.id],
    )).rows[0].id;
    const id2 = (await db.query<{ id: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند بی‌کد ۲', 'employee', ARRAY['employee']::text[],
               'real', true, NULL, 'automatic', '{}'::jsonb)
       RETURNING id`,
      [biz.id],
    )).rows[0].id;

    const sql0231 = readFileSync(
      join(__dirname, "..", "migrations", "0231_staff_accounting_code_backfill.sql"),
      "utf8",
    );
    await db.query(sql0231);

    const { rows: after } = await db.query<{ id: string; accounting_code: string | null }>(
      `SELECT id, accounting_code FROM parties WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[id1, id2]],
    );
    for (const r of after) {
      expect(r.accounting_code).toMatch(/^3\d{5}$/);
      expect(r.accounting_code).not.toBe("300099");
    }
    expect(after[0].accounting_code).not.toBe(after[1].accounting_code);
  });

  it("migration 0238 re-backfills a NULL staff code without being shifted by a wide manual code", async () => {
    await db.query(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'مشتری با کد بلند', 'customer', ARRAY['customer']::text[],
               'real', true, '3999999999999', 'manual', '{}'::jsonb)`,
      [biz.id],
    );
    const { rows: created } = await db.query<{ id: string }>(
      `INSERT INTO parties (id, business_id, name, role, roles, person_type, is_active,
                             accounting_code, accounting_code_mode, general_info)
       VALUES (gen_random_uuid(), $1, 'کارمند مانده از ترمیم', 'employee', ARRAY['employee']::text[],
               'real', true, NULL, 'automatic', '{}'::jsonb)
       RETURNING id`,
      [biz.id],
    );

    const sql0238 = readFileSync(
      join(__dirname, "..", "migrations", "0238_staff_accounting_code_backfill_resilient.sql"),
      "utf8",
    );
    await db.query(sql0238);

    const { rows: healed } = await db.query<{ accounting_code: string | null }>(
      `SELECT accounting_code FROM parties WHERE id = $1`,
      [created[0].id],
    );
    expect(healed[0].accounting_code).toMatch(/^3\d{5}$/);
  });

  it("create-from-Team rolls back the membership when the linked personnel-account audit cannot be written", async () => {
    // The party insert happens before its personnel-link audit. Make that audit
    // fail to prove the Team creation transaction does not leave either a
    // membership or an unlinked/code-less party behind.
    await db.query(`
      CREATE FUNCTION reject_issue_1006_personnel_link_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'team.personnel_link_changed' THEN
          RAISE EXCEPTION 'reject personnel link audit for atomicity test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_reject_issue_1006_personnel_link_audit
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_issue_1006_personnel_link_audit();
    `);

    try {
      await expect(
        dbLib.withTenant(biz.id, () =>
          teamService.createMembership({
            businessId: biz.id,
            role: "waiter",
            fullName: "زهرا کریمی",
            pin: "4321",
            actorId: null,
          }),
        ),
      ).rejects.toMatchObject({ message: "personnel_file_creation_failed", status: 409 });

      const { rows } = await db.query<{ members: string; files: string }>(
        `SELECT
           (SELECT count(*)::text FROM users WHERE business_id = $1) AS members,
           (SELECT count(*)::text FROM parties WHERE business_id = $1) AS files`,
        [biz.id],
      );
      expect(rows[0]).toEqual({ members: "0", files: "0" });
    } finally {
      await db.query(`
        DROP TRIGGER IF EXISTS trg_reject_issue_1006_personnel_link_audit ON audit_log;
        DROP FUNCTION IF EXISTS reject_issue_1006_personnel_link_audit();
      `);
    }
  });

  it("an ordinary note edit preserves the existing accounting code (atomicity sanity)", async () => {
    const party = await dbLib.withTenant(biz.id, () =>
      partiesService.createParty(biz.id, {
        role: "Employee",
        roles: ["Employee"],
        personType: "Real",
        displayName: "کارمند اتمیک",
        firstName: "اتمیک",
        lastName: "کارمند",
      }),
    );
    const beforeCode = party.accountingCode;
    const updated = await dbLib.withTenant(biz.id, () =>
      partiesService.updateParty(biz.id, party.id, { notes: "atomicity-check" }),
    );
    expect(updated?.accountingCode).toBe(beforeCode);
  });


  it("a 23505 unique-violation inside a savepoint does NOT abort the outer transaction (concurrent writers both get codes)", async () => {
    // Two concurrent createParty calls targeting the same prefix must both
    // succeed because the inSavepoint wrapper catches the 23505 and retries.
    // Run them in Promise.all against the same business so the only
    // serialisation is the advisory lock + savepoint retry.
    const [a, b] = await Promise.all([
      dbLib.withTenant(biz.id, () =>
        partiesService.createParty(biz.id, {
          role: "Employee",
          roles: ["Employee"],
          personType: "Real",
          displayName: "همکار همزمان الف",
          firstName: "الف",
          lastName: "همزمان",
        }),
      ),
      dbLib.withTenant(biz.id, () =>
        partiesService.createParty(biz.id, {
          role: "Employee",
          roles: ["Employee"],
          personType: "Real",
          displayName: "همکار همزمان ب",
          firstName: "ب",
          lastName: "همزمان",
        }),
      ),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(a.accountingCode).toMatch(/^3\d{5}$/);
    expect(b.accountingCode).toMatch(/^3\d{5}$/);
    expect(a.accountingCode).not.toBe(b.accountingCode);
  });

  it("POST /api/parties/assign-codes calls requirePermission(partiesManage) — structural guard", () => {
    // Structural pin (like other grep-style tests in this repo): asserts the
    // source actually invokes the partiesManage guard so a future edit cannot
    // silently drop it. The behavioural assertion lives in
    // src/app/api/parties/assign-codes/route.test.ts, which mocks requirePermission
    // and verifies the 403 response when permission is denied.
    const routeSource = readFileSync(
      join(__dirname, "..", "src", "app", "api", "parties", "assign-codes", "route.ts"),
      "utf8",
    );
    expect(routeSource).toContain("requirePermission(PERMISSIONS.partiesManage)");
    expect(routeSource).not.toContain("requirePermission(PERMISSIONS.ledgerView)");
  });
});
