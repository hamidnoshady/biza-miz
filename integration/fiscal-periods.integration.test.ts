/**
 * Phase 16 exit criterion: "A locked period rejects every posting path,
 * including the automatic ones" — proven at the database posting boundary.
 * Locked always rejects. Soft-close authorization is resolved from the canonical
 * effective ledger.close_period permission and delivered to the database via
 * the actual request authorization context.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Role, SessionPayload } from "../src/lib/auth-edge";
import type { RialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let authorization: typeof import("../src/lib/authorize");
let ledgerService: typeof import("../src/lib/ledger-service");
let permissions: typeof import("../src/lib/permissions");

const biz = { id: "" };

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

beforeAll(async () => {
  databaseName = `pos_fiscal_${randomUUID().replaceAll("-", "")}`;

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
  fiscalService = await import("../src/lib/fiscal-periods-service");
  authorization = await import("../src/lib/authorize");
  ledgerService = await import("../src/lib/ledger-service");
  permissions = await import("../src/lib/permissions");

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

const users: { owner: string; accountant: string; cashier: string; admin: string } = {
  owner: "",
  accountant: "",
  cashier: "",
  admin: "",
};
const rolesByUser = new Map<string, Role>();

beforeEach(async () => {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");
  rolesByUser.clear();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Ledger Co', $1) RETURNING id",
    [`ledger-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  for (const role of ["owner", "accountant", "cashier", "admin"] as const) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, 'Member', 'x') RETURNING id`,
      [biz.id, role],
    );
    users[role] = rows[0].id;
    rolesByUser.set(rows[0].id, role);
  }
});

async function addMember(role: Role, overrides: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash, permissions)
     VALUES ($1, $2, 'Member', 'x', $3::jsonb) RETURNING id`,
    [biz.id, role, JSON.stringify(overrides)],
  );
  rolesByUser.set(rows[0].id, role);
  return rows[0].id;
}

function sessionFor(userId: string): SessionPayload {
  return {
    sub: userId,
    role: rolesByUser.get(userId) ?? "cashier",
    businessId: biz.id,
    locationId: null,
    fullName: "Member",
  };
}

/** Exercise the same request-local authorization snapshot as withTenantScope. */
async function withMember<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(
    biz.id,
    () => authorization.withAuthorizationMemo(async () => {
      await authorization.authorize(sessionFor(userId), {});
      return fn();
    }),
    { userId },
  );
}

async function withNoAuthorization<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(biz.id, () => authorization.withAuthorizationMemo(fn));
}

async function createYear(year: number, actorId = users.owner) {
  return withMember(actorId, () => fiscalService.createFiscalYear(biz.id, year, actorId));
}

async function listYears() {
  return dbLib.withTenant(biz.id, () => fiscalService.listFiscalYears(biz.id));
}

async function listPeriods(yearId: string) {
  return dbLib.withTenant(biz.id, () => fiscalService.listPeriods(biz.id, yearId));
}

async function setPeriodStatus(periodId: string, status: "open" | "soft_closed" | "locked", actorId = users.owner) {
  return withMember(actorId, () => fiscalService.setPeriodStatus(biz.id, periodId, status, actorId));
}

async function insertEntry(entryDate: string, createdBy: string | null) {
  return dbLib.getPool().query(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, 'test', 'manual', $3) RETURNING id`,
    [biz.id, entryDate, createdBy],
  );
}

async function insertEntryAs(actorId: string, entryDate: string, createdBy: string | null = actorId) {
  return withMember(actorId, () => insertEntry(entryDate, createdBy));
}

async function addCustomRoleMember(
  name: string,
  customPermissions: string[],
  options: { isActive?: boolean; role?: Role } = {},
): Promise<string> {
  const actorId = users.owner;
  const { rows: roles } = await db.query<{ id: string }>(
    `INSERT INTO tenant_roles (business_id, name, permissions, created_by, is_active)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
    [biz.id, name, JSON.stringify(customPermissions), actorId, options.isActive ?? true],
  );
  const userId = await addMember(options.role ?? "manager");
  await db.query("UPDATE users SET custom_role_id = $2 WHERE id = $1", [userId, roles[0].id]);
  return userId;
}

async function periodAccountIds(): Promise<[string, string]> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '834-debit', 'Test debit', 'asset'), ($1, '834-credit', 'Test credit', 'equity')
     RETURNING id`,
    [biz.id],
  );
  return [rows[0].id, rows[1].id];
}

describe("fiscal year & period creation", () => {
  it("creates a Jalali year's twelve periods, all open", async () => {
    await createYear(1404);
    const [year] = await listYears();
    expect(year.label).toBe("1404");
    expect(year.startsOn).toBe("2025-03-21");

    const periods = await listPeriods(year.id);
    expect(periods).toHaveLength(12);
    expect(periods.every((p) => p.status === "open")).toBe(true);
  });

  it("rejects defining the same fiscal year twice", async () => {
    await createYear(1404);
    await expect(createYear(1404)).rejects.toThrow("fiscal_year_exists");
  });

  it("turns simultaneous definitions of one year into one creation and one normal conflict", async () => {
    const results = await Promise.allSettled([
      createYear(1404),
      createYear(1404),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toHaveProperty("message", "fiscal_year_exists");

    const [year] = await listYears();
    expect(await listPeriods(year.id)).toHaveLength(12);
  });

  it("treats a stale or malformed year id as missing rather than emitting a database cast error", async () => {
    await expect(listPeriods(randomUUID())).rejects.toThrow("fiscal_year_not_found");
    await expect(listPeriods("not-a-uuid")).rejects.toThrow("fiscal_year_not_found");
  });

  it("keeps a period inside its parent year and rejects overlapping calendar ranges in the database", async () => {
    const year = await createYear(1404);

    await expect(
      db.query(
        `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
         VALUES ($1, $2, 'outside', '2025-03-19', '2025-03-20')`,
        [biz.id, year.id],
      ),
    ).rejects.toThrow("fiscal_period_outside_year");

    await expect(
      db.query(
        `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
         VALUES ($1, $2, 'overlap', '2025-03-22', '2025-03-23')`,
        [biz.id, year.id],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });
});

describe("an open period", () => {
  it("accepts a posting from anyone", async () => {
    await createYear(1404);
    await expect(insertEntryAs(users.cashier, "2025-04-15")).resolves.toBeTruthy();
  });
});

describe("a locked period", () => {
  it("rejects every posting, including the owner's and the accountant's", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const periods = await listPeriods(year.id);
    const farvardin = periods[0]; // 1404-01, 2025-03-21..2025-04-20

    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);
    await setPeriodStatus(farvardin.id, "locked", users.owner);

    await expect(insertEntryAs(users.owner, "2025-04-01")).rejects.toThrow("fiscal_period_locked");
    await expect(insertEntryAs(users.accountant, "2025-04-01")).rejects.toThrow("fiscal_period_locked");
    await expect(insertEntryAs(users.cashier, "2025-04-01")).rejects.toThrow("fiscal_period_locked");
  });

  it("also blocks retiming a pre-adoption legacy entry into the locked period", async () => {
    const entry = await withNoAuthorization(() => insertEntry("2000-01-01", users.cashier));
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);
    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);
    await setPeriodStatus(farvardin.id, "locked", users.owner);

    await expect(
      dbLib.withTenant(biz.id, () => dbLib.getPool().query("UPDATE journal_entries SET entry_date = '2025-04-01' WHERE id = $1", [entry.rows[0].id]), { userId: users.owner }),
    ).rejects.toThrow("fiscal_period_locked");
  });

  it("does not affect a different, still-open period", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const periods = await listPeriods(year.id);

    await setPeriodStatus(periods[0].id, "soft_closed", users.owner);
    await setPeriodStatus(periods[0].id, "locked", users.owner);

    // Ordibehesht (period[1]) is untouched.
    await expect(insertEntryAs(users.cashier, periods[1].startsOn)).resolves.toBeTruthy();
  });

  it("reopens back to a postable state", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);

    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);
    await setPeriodStatus(farvardin.id, "locked", users.owner);
    await setPeriodStatus(farvardin.id, "open", users.owner);

    await expect(insertEntryAs(users.cashier, "2025-04-01")).resolves.toBeTruthy();
  });
});

describe("a soft-closed period", () => {
  it("uses the canonical effective permission for built-in, custom, and per-member grants", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);
    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);

    const managerGranted = await addMember("manager", {
      granted: [permissions.PERMISSIONS.ledgerClosePeriod],
    });
    const customRoleMember = await addCustomRoleMember("Fiscal controller", [permissions.PERMISSIONS.ledgerClosePeriod]);
    const permitted = [users.owner, users.accountant, users.admin, customRoleMember, managerGranted];

    for (const [index, actorId] of permitted.entries()) {
      const decision = await withMember(actorId, () =>
        authorization.authorize(sessionFor(actorId), { permission: permissions.PERMISSIONS.ledgerClosePeriod }),
      );
      expect(decision.ok, `actor ${actorId} should hold the canonical close permission`).toBe(true);
      await expect(insertEntryAs(actorId, `2025-04-${String(index + 1).padStart(2, "0")}`)).resolves.toBeTruthy();
    }

    const cashierDecision = await withMember(users.cashier, () =>
      authorization.authorize(sessionFor(users.cashier), { permission: permissions.PERMISSIONS.ledgerClosePeriod }),
    );
    expect(cashierDecision).toMatchObject({ ok: false, code: "MISSING_PERMISSION" });
    await expect(insertEntryAs(users.cashier, "2025-04-10")).rejects.toThrow("fiscal_period_soft_closed");
  });

  it("denies an explicit revocation, an inactive custom role, and an inactive membership", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);
    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);

    const revokedAccountant = await addMember("accountant", {
      revoked: [permissions.PERMISSIONS.ledgerClosePeriod],
    });
    const inactiveCustomRole = await addCustomRoleMember(
      "Inactive fiscal controller",
      [permissions.PERMISSIONS.ledgerClosePeriod],
      { isActive: false },
    );
    const inactiveMember = await addMember("accountant");
    await db.query(
      "UPDATE users SET is_active = false, membership_status = 'inactive' WHERE id = $1",
      [inactiveMember],
    );

    for (const actorId of [revokedAccountant, inactiveCustomRole, inactiveMember]) {
      const decision = await withMember(actorId, () =>
        authorization.authorize(sessionFor(actorId), { permission: permissions.PERMISSIONS.ledgerClosePeriod }),
      );
      expect(decision.ok).toBe(false);
      await expect(insertEntryAs(actorId, "2025-04-03")).rejects.toThrow("fiscal_period_soft_closed");
    }
  });

  it("honors the hybrid site's deny-only permission overlay", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);
    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);
    const hybridMember = await addMember("accountant");

    const { rows: locations } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Hybrid site') RETURNING id",
      [biz.id],
    );
    const { rows: devices } = await db.query<{ id: string }>(
      `INSERT INTO site_devices (business_id, location_id, display_name)
       VALUES ($1, $2, 'Hybrid site device') RETURNING id`,
      [biz.id, locations[0].id],
    );
    await db.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'deployment.profile', '{"profile":"hybrid"}'::jsonb),
              ($1, NULL, 'server_sync.config', jsonb_build_object('siteDeviceId', $2::text, 'enabled', true))`,
      [biz.id, devices[0].id],
    );
    await db.query(
      `INSERT INTO site_member_access (business_id, site_device_id, user_id, permission_denies)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [biz.id, devices[0].id, hybridMember, JSON.stringify([permissions.PERMISSIONS.ledgerClosePeriod])],
    );

    const decision = await withMember(hybridMember, () =>
      authorization.authorize(sessionFor(hybridMember), { permission: permissions.PERMISSIONS.ledgerClosePeriod }),
    );
    expect(decision).toMatchObject({ ok: false, code: "MISSING_PERMISSION" });
    await expect(insertEntryAs(hybridMember, "2025-04-04")).rejects.toThrow("fiscal_period_soft_closed");
  });

  it("rejects null or mismatched creators even inside an otherwise authorized request", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);
    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);

    await expect(withMember(users.owner, () => insertEntry("2025-04-05", null))).rejects.toThrow("fiscal_period_soft_closed");
    await expect(withMember(users.owner, () => insertEntry("2025-04-06", users.accountant))).rejects.toThrow("fiscal_period_soft_closed");
    await expect(withNoAuthorization(() => insertEntry("2025-04-07", users.owner))).rejects.toThrow("fiscal_period_soft_closed");
  });

  it("allows authorized entry construction once, but never later line edits or additions", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);
    await setPeriodStatus(farvardin.id, "soft_closed", users.owner);
    const [debitAccount, creditAccount] = await periodAccountIds();

    let constructedEntryId = "";
    await withMember(users.owner, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const entryId = await ledgerService.postExactJournalEntry(client, {
          businessId: biz.id,
          locationId: null,
          entryDate: "2025-04-08",
          memo: "initial soft-close construction",
          sourceType: "manual",
          sourceId: null,
          createdBy: users.owner,
          lines: [
            { accountId: debitAccount, debit: "100" as RialText, credit: "0" as RialText },
            { accountId: creditAccount, debit: "0" as RialText, credit: "100" as RialText },
          ],
        });
        expect(entryId).toBeTruthy();
        constructedEntryId = entryId!;

        await client.query("SAVEPOINT later_line");
        await expect(
          client.query(
            "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1, 0)",
            [entryId, debitAccount],
          ),
        ).rejects.toThrow("fiscal_period_soft_closed");
        await client.query("ROLLBACK TO SAVEPOINT later_line");

        const { rows: lines } = await client.query<{ id: string }>(
          "SELECT id FROM journal_lines WHERE entry_id = $1 ORDER BY id",
          [entryId],
        );
        for (const operation of [
          () => client.query("UPDATE journal_lines SET debit = 101 WHERE id = $1", [lines[0].id]),
          () => client.query("DELETE FROM journal_lines WHERE id = $1", [lines[0].id]),
        ]) {
          await client.query("SAVEPOINT later_edit");
          await expect(operation()).rejects.toThrow("fiscal_period_soft_closed");
          await client.query("ROLLBACK TO SAVEPOINT later_edit");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });

    await setPeriodStatus(farvardin.id, "locked", users.owner);
    await withMember(users.owner, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const { rows: lines } = await client.query<{ id: string }>(
          "SELECT id FROM journal_lines WHERE entry_id = $1 ORDER BY id",
          [constructedEntryId],
        );
        for (const operation of [
          () => client.query("UPDATE journal_lines SET debit = 102 WHERE id = $1", [lines[0].id]),
          () => client.query("DELETE FROM journal_lines WHERE id = $1", [lines[0].id]),
          () => client.query(
            "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1, 0)",
            [constructedEntryId, debitAccount],
          ),
          () => client.query("DELETE FROM journal_entries WHERE id = $1", [constructedEntryId]),
        ]) {
          await client.query("SAVEPOINT locked_edit");
          await expect(operation()).rejects.toThrow("fiscal_period_locked");
          await client.query("ROLLBACK TO SAVEPOINT locked_edit");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
  });
});


describe("fiscal-control adoption", () => {
  it("preserves uncovered legacy dates but rejects uncovered dates from adoption onward", async () => {
    // Seed a genuinely uncovered legacy entry before creating the first year.
    await expect(withNoAuthorization(() => insertEntry("2000-01-01", users.owner))).resolves.toBeTruthy();
    const year = await createYear(1404);
    const { rows } = await db.query<{ adopted_on: string; adopted_at: string }>(
      `SELECT fiscal_control_required_from::text AS adopted_on,
              fiscal_control_adopted_at::text AS adopted_at
         FROM businesses WHERE id = $1`,
      [biz.id],
    );
    expect(rows[0].adopted_on).toBeTruthy();
    expect(rows[0].adopted_at).toBeTruthy();
    const legacyRows = await db.query(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND entry_date = '2000-01-01'",
      [biz.id],
    );
    expect(legacyRows.rows).toHaveLength(1);

    // The pre-adoption row remains untouched, but a new uncovered posting is
    // rejected after adoption regardless of whether it is back-dated.
    await expect(insertEntryAs(users.owner, "2000-01-02")).rejects.toThrow("fiscal_period_not_defined");
    await expect(insertEntryAs(users.owner, "2099-01-01")).rejects.toThrow("fiscal_period_not_defined");
    // The defined Jalali year itself remains postable.
    await expect(insertEntryAs(users.cashier, "2025-04-15")).resolves.toBeTruthy();
    expect(year.label).toBe("1404");
  });
});

describe("fiscal lifecycle audit", () => {
  it("records same-transaction before/after states and keeps lifecycle events append-only", async () => {
    const year = await createYear(1404, users.owner);
    const [first] = await listPeriods(year.id);
    await setPeriodStatus(first.id, "soft_closed", users.owner);
    await setPeriodStatus(first.id, "locked", users.owner);
    await setPeriodStatus(first.id, "open", users.owner);

    const { rows } = await db.query<{ action: string; entity: string; entity_id: string; user_id: string; payload: Record<string, unknown> }>(
      `SELECT action, entity, entity_id, user_id, payload
         FROM audit_log
        WHERE business_id = $1 AND entity_id IN ($2, $3)
        ORDER BY id`,
      [biz.id, year.id, first.id],
    );
    expect(rows.map((row) => row.action)).toEqual([
      "fiscal_year.created",
      "fiscal_period.soft_closed",
      "fiscal_period.locked",
      "fiscal_period.reopened",
    ]);
    for (const row of rows) {
      expect(row.user_id).toBe(users.owner);
      expect(row.payload.actorId).toBe(users.owner);
      expect(row.payload.startsOn).toBeTruthy();
      expect(row.payload.endsOn).toBeTruthy();
      expect(row.payload.after).toBeTruthy();
    }
    for (const row of rows.slice(1)) expect(row.payload.before).toBeTruthy();
    expect(rows[0].payload.before).toBeNull();
    expect(rows[0].payload.fiscalControlRequiredFrom).toBeTruthy();
    expect(rows[0].payload.fiscalControlAdoptedAt).toBeTruthy();
    expect(rows[1].payload).toMatchObject({ previousStatus: "open", newStatus: "soft_closed" });
    expect(rows[2].payload).toMatchObject({ previousStatus: "soft_closed", newStatus: "locked" });
    expect(rows[3].payload).toMatchObject({ previousStatus: "locked", newStatus: "open" });

    await expect(
      db.query("UPDATE audit_log SET payload = '{}'::jsonb WHERE action = 'fiscal_period.soft_closed' AND entity_id = $1", [first.id]),
    ).rejects.toThrow("fiscal_audit_append_only");
    await expect(
      db.query("DELETE FROM audit_log WHERE action = 'fiscal_period.soft_closed' AND entity_id = $1", [first.id]),
    ).rejects.toThrow("fiscal_audit_append_only");
  });
});

describe("period status transitions", () => {
  it("serializes competing transitions so a double press cannot both succeed", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);

    const results = await Promise.allSettled([
      setPeriodStatus(farvardin.id, "soft_closed", users.owner),
      setPeriodStatus(farvardin.id, "soft_closed", users.accountant),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toHaveProperty("message", "invalid_transition");

    const [updated] = await listPeriods(year.id);
    expect(updated.status).toBe("soft_closed");
  });

  it("rejects skipping straight from open to locked", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const [farvardin] = await listPeriods(year.id);

    await expect(
      setPeriodStatus(farvardin.id, "locked", users.owner),
    ).rejects.toThrow("invalid_transition");
  });
});
