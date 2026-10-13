/**
 * Issue #824, indirect account writers. Every path that creates, deletes or
 * re-types a chart row must hold the same invariants as the editor, in the
 * same transaction, against real Postgres:
 *
 *  - the setup wizard's wholesale replacement refuses a chart that any draft
 *    or posting references (a typed 409, not a raw foreign-key 500), and writes
 *    an audit row for each account it removes and each it creates;
 *  - the Holoo import writes `account.created` for every account it creates;
 *  - the Holoo rollback takes the chart lock, refuses to orphan a user-added
 *    child or to delete an account a draft still uses, and audits each delete;
 *  - seeding a live chart refuses an archived parent and a parent of another
 *    type as typed conflicts, changes no live row, and reactivates nothing
 *    (issue #824 finding 2).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { coaTemplateForIndustry, type TemplateAccount } from "../src/lib/coa-template";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let accountsService: typeof import("../src/lib/accounts-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let manualJournal: typeof import("../src/lib/manual-journal-service");
let holooImport: typeof import("../src/lib/integrations/holoo/import-service");
let holooRuns: typeof import("../src/lib/integrations/holoo/migration-run-service");
let holooRollback: typeof import("../src/lib/integrations/holoo/rollback-service");
let withTenant: typeof import("../src/lib/db").withTenant;

const biz = { id: "", location: "", connection: "", cash: "", expense: "", owner: "" };

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
  databaseName = `pos_acctw_${randomUUID().replaceAll("-", "")}`;
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
  withTenant = dbLib.withTenant;
  accountsService = await import("../src/lib/accounts-service");
  provisioning = await import("../src/lib/business-provisioning");
  manualJournal = await import("../src/lib/manual-journal-service");
  holooImport = await import("../src/lib/integrations/holoo/import-service");
  holooRuns = await import("../src/lib/integrations/holoo/migration-run-service");
  holooRollback = await import("../src/lib/integrations/holoo/rollback-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

// Every test gets its own business, so no test depends on another test's rows.
beforeEach(async () => {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Writers Co', $1) RETURNING id",
    [`writers-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  biz.owner = userRow.rows[0].id;
  const locationRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.location = locationRow.rows[0].id;
  const connectionRow = await db.query<{ id: string }>(
    `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
     VALUES ($1, $2, 'Holoo', 'holoo', NULL, 'rial') RETURNING id`,
    [biz.id, biz.location],
  );
  biz.connection = connectionRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5000', 'Expenses', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") biz.cash = row.id;
    if (row.code === "5000") biz.expense = row.id;
  }
});

async function auditRows(action: string, entityId?: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE business_id = $1 AND action = $2 AND entity = 'account'
        AND ($3::text IS NULL OR entity_id = $3)`,
    [biz.id, action, entityId ?? null],
  );
  return Number(rows[0].n);
}

async function accountCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM accounts WHERE business_id = $1",
    [biz.id],
  );
  return Number(rows[0].n);
}

/** A pooled client with an open transaction, released with `end(commit)`. */
async function transaction() {
  const pool = dbLib.getPool();
  const client = await pool.connect();
  await client.query("BEGIN");
  return {
    client,
    async end(commit: boolean) {
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      client.release();
    },
  };
}

describe("setup wizard chart replacement", () => {
  const wizardChart = [
    { code: "1000", name: "دارایی", type: "asset", parentCode: null, isContra: false },
    { code: "1010", name: "نقد", type: "asset", parentCode: "1000", isContra: false },
    { code: "1020", name: "استهلاک انباشته", type: "asset", parentCode: "1000", isContra: true },
  ] as const;

  it("refuses to replace a chart that a draft line references, with a 409 and nothing deleted", async () => {
    await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Draft rent",
      lines: [
        { accountId: biz.expense, debit: 10_000, credit: 0 },
        { accountId: biz.cash, debit: 0, credit: 10_000 },
      ],
      createdBy: biz.owner,
    });
    const before = await accountCount();
    const tx = await transaction();
    try {
      await expect(
        accountsService.replaceChartOfAccounts(tx.client, biz.id, wizardChart, biz.owner),
      ).rejects.toMatchObject({ message: "accounts_in_use", status: 409 });
    } finally {
      await tx.end(false);
    }
    expect(await accountCount()).toBe(before);
    expect(await auditRows("account.deleted")).toBe(0);
  });

  it("replaces an unused chart and writes one deleted and one created audit row per account, in the same transaction", async () => {
    const tx = await transaction();
    let created: number;
    try {
      created = await accountsService.replaceChartOfAccounts(tx.client, biz.id, wizardChart, biz.owner);
    } finally {
      await tx.end(true);
    }
    expect(created).toBe(3);
    expect(await accountCount()).toBe(3);
    expect(await auditRows("account.deleted")).toBe(2);
    expect(await auditRows("account.created")).toBe(3);

    // The contra flag and the parent link survive the replacement.
    const { rows } = await db.query<{ code: string; is_contra: boolean; parent_code: string | null }>(
      `SELECT a.code, a.is_contra, p.code AS parent_code
         FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
        WHERE a.business_id = $1 ORDER BY a.code`,
      [biz.id],
    );
    expect(rows).toEqual([
      { code: "1000", is_contra: false, parent_code: null },
      { code: "1010", is_contra: false, parent_code: "1000" },
      { code: "1020", is_contra: true, parent_code: "1000" },
    ]);
  });

  it("refuses a list that cannot be placed before touching any row", async () => {
    const before = await accountCount();
    const tx = await transaction();
    try {
      await expect(
        accountsService.replaceChartOfAccounts(
          tx.client,
          biz.id,
          [
            { code: "1000", name: "دارایی", type: "asset", parentCode: null, isContra: false },
            { code: "2000", name: "بدهی", type: "liability", parentCode: "1000", isContra: false },
          ],
          biz.owner,
        ),
      ).rejects.toMatchObject({ reason: "type_mismatch" });
    } finally {
      await tx.end(false);
    }
    expect(await accountCount()).toBe(before);
  });
});

describe("Holoo account import writes an audit row per created account", () => {
  function holooAccount(code: string, parentCode: string | null) {
    return { remoteId: code, code, name: `حساب ${code}`, nature: null, parentCode };
  }

  it("records account.created for each account, in the import transaction", async () => {
    await withTenant(biz.id, async () => {
      const runId = await holooRuns.beginImportRun(biz.id, biz.connection, null);
      await holooImport.applyBaseImport(
        biz.id,
        biz.connection,
        { goods: [], persons: [], accounts: [holooAccount("9401", null), holooAccount("9402", "9401")] },
        runId,
        biz.location,
      );
    });
    const { rows } = await db.query<{ entity_id: string; payload: { code?: string } | null }>(
      `SELECT entity_id, payload FROM audit_log
        WHERE business_id = $1 AND action = 'account.created' AND entity = 'account'
        ORDER BY payload->>'code'`,
      [biz.id],
    );
    const codes = rows.map((row) => row.payload?.code);
    expect(codes).toEqual(["9401", "9402"]);
    const { rows: ids } = await db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE business_id = $1 AND code IN ('9401','9402') ORDER BY code`,
      [biz.id],
    );
    expect(rows.map((row) => row.entity_id)).toEqual(ids.map((row) => row.id));
  });
});

describe("Holoo rollback takes the chart lock, refuses orphaning, and audits each delete", () => {
  function holooAccount(code: string, parentCode: string | null) {
    return { remoteId: code, code, name: `حساب ${code}`, nature: null, parentCode };
  }

  async function importedRun(accounts: ReturnType<typeof holooAccount>[]): Promise<string> {
    const runId = await withTenant(biz.id, async () => {
      const id = await holooRuns.beginImportRun(biz.id, biz.connection, null);
      await holooImport.applyBaseImport(biz.id, biz.connection, { goods: [], persons: [], accounts }, id, biz.location);
      await holooRuns.completeImportRun(biz.id, id, { provider: "holoo", selectedScopes: ["accounts"], rollbackState: "available" });
      return id;
    });
    return runId;
  }

  it("refuses to delete an imported parent that still has a user-added child, and leaves every row in place", async () => {
    const runId = await importedRun([holooAccount("9411", null), holooAccount("9412", "9411")]);
    const parent = await db.query<{ id: string; type: string }>(
      "SELECT id, type::text AS type FROM accounts WHERE business_id = $1 AND code = '9411'",
      [biz.id],
    );
    // A child the user added after the import. It is not in the run's mappings.
    await db.query(
      `INSERT INTO accounts (business_id, parent_id, code, name, type, level)
       VALUES ($1, $2, '9413', 'کاربر', $3::account_type, 'kol')`,
      [biz.id, parent.rows[0].id, parent.rows[0].type],
    );

    await expect(
      withTenant(biz.id, () => holooRollback.rollbackImportRun(biz.id, runId, biz.connection)),
    ).rejects.toThrow(/^account_has_children$/);

    const { rows } = await db.query<{ code: string }>(
      "SELECT code FROM accounts WHERE business_id = $1 AND code IN ('9411','9412','9413') ORDER BY code",
      [biz.id],
    );
    expect(rows.map((row) => row.code)).toEqual(["9411", "9412", "9413"]);
    expect(await auditRows("account.deleted")).toBe(0);
    const { rows: run } = await db.query<{ status: string }>("SELECT status FROM holoo_import_runs WHERE id = $1", [runId]);
    expect(run[0].status).toBe("completed");
  });

  it("refuses to delete an imported account that a draft line references", async () => {
    const runId = await importedRun([holooAccount("9421", null)]);
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM accounts WHERE business_id = $1 AND code = '9421'",
      [biz.id],
    );
    await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Draft on imported account",
      lines: [
        { accountId: rows[0].id, debit: 5_000, credit: 0 },
        { accountId: biz.cash, debit: 0, credit: 5_000 },
      ],
      createdBy: biz.owner,
    });
    await expect(
      withTenant(biz.id, () => holooRollback.rollbackImportRun(biz.id, runId, biz.connection)),
    ).rejects.toThrow(/^account_has_draft_postings$/);
    const { rows: still } = await db.query("SELECT 1 FROM accounts WHERE id = $1", [rows[0].id]);
    expect(still).toHaveLength(1);
  });

  it("deletes the run's accounts children-first and writes one account.deleted row for each", async () => {
    const runId = await importedRun([holooAccount("9431", null), holooAccount("9432", "9431")]);
    const result = await withTenant(biz.id, () => holooRollback.rollbackImportRun(biz.id, runId, biz.connection));
    expect(result.reverted.holoo_account).toBe(2);
    expect(await auditRows("account.deleted")).toBe(2);
    const { rows } = await db.query("SELECT 1 FROM accounts WHERE business_id = $1 AND code IN ('9431','9432')", [biz.id]);
    expect(rows).toHaveLength(0);
  });
});

describe("issue #824 finding 2: seeding a live chart refuses conflicts and changes nothing", () => {
  const template = coaTemplateForIndustry("food_service");
  const parentTemplate = template.find(
    (a: TemplateAccount) => !a.parentCode && template.some((c) => c.parentCode === a.code),
  )!;
  const otherType = (type: TemplateAccount["type"]) => (type === "liability" ? "asset" : "liability");

  async function liveParent(extra: { type?: string; isActive: boolean }) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type, level, is_active)
       VALUES ($1, $2, 'Live parent', $3::account_type, 'group', $4) RETURNING id`,
      [biz.id, parentTemplate.code, extra.type ?? parentTemplate.type, extra.isActive],
    );
    return rows[0].id;
  }

  async function seedInTransaction(): Promise<unknown> {
    const tx = await transaction();
    try {
      await provisioning.seedChartOfAccounts(tx.client as never, biz.id, "food_service");
      await tx.end(true);
      return null;
    } catch (err) {
      await tx.end(false);
      return err;
    }
  }

  it("refuses to attach a template child under an archived live parent, with the chart unchanged", async () => {
    const parentId = await liveParent({ isActive: false });
    const before = await db.query("SELECT id, code, name, type::text AS type, is_active FROM accounts WHERE business_id = $1 ORDER BY code", [biz.id]);

    const err = await seedInTransaction();
    expect((err as Error).message).toBe("parent_archived");

    const after = await db.query("SELECT id, code, name, type::text AS type, is_active FROM accounts WHERE business_id = $1 ORDER BY code", [biz.id]);
    expect(after.rows).toEqual(before.rows);
    const { rows } = await db.query<{ is_active: boolean }>("SELECT is_active FROM accounts WHERE id = $1", [parentId]);
    expect(rows[0].is_active).toBe(false);
  });

  it("refuses to attach a template child under a live parent of another type, with the chart unchanged", async () => {
    await liveParent({ type: otherType(parentTemplate.type), isActive: true });
    const before = await db.query("SELECT id, code, name, type::text AS type, is_active FROM accounts WHERE business_id = $1 ORDER BY code", [biz.id]);

    const err = await seedInTransaction();
    expect((err as Error).message).toBe("parent_type_mismatch");

    const after = await db.query("SELECT id, code, name, type::text AS type, is_active FROM accounts WHERE business_id = $1 ORDER BY code", [biz.id]);
    expect(after.rows).toEqual(before.rows);
  });
});
