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
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let personnel: typeof import("../src/lib/personnel-file");
let partiesService: typeof import("../src/lib/parties-service");
let teamService: typeof import("../src/lib/team-service");

function urlFor(dbName: string): string {
  const url = new URL(rootDatabaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl);
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
});
