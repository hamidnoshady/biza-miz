/**
 * Issue #1583 — the opening step's real read model.
 *
 * The screen used to decide "no accounts" from a client-side filter over a
 * response whose failure it never inspected. This suite pins the server half
 * against a real PostgreSQL: a missing chart, a chart with no postable leaf, an
 * unselected Accounting app and a genuinely ready chart each report a distinct
 * state, and the eligible list excludes the automatic inventory-control subtree.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { SessionPayload } from "../src/lib/auth";
const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let settings: typeof import("../src/lib/settings");
let openingService: typeof import("../src/lib/setup-opening-service");
let financialService: typeof import("../src/lib/financial-accounts-service");
let postingService: typeof import("../src/lib/setup-opening-posting");

const biz = { id: "", locationId: "", userId: "" };

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
  databaseName = `pos_setup_opening_${randomUUID().replaceAll("-", "")}`;
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
  settings = await import("../src/lib/settings");
  openingService = await import("../src/lib/setup-opening-service");
  financialService = await import("../src/lib/financial-accounts-service");
  postingService = await import("../src/lib/setup-opening-posting");

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
  await db.query(`TRUNCATE
    journal_lines, journal_entries, financial_accounts, accounts,
    settings, users, locations, businesses
    CASCADE`);

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Opening Step Co', $1, 'food_service') RETURNING id",
    [`setup-opening-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name, pin_hash)
     VALUES ($1, $2, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id, biz.locationId],
  );
  biz.userId = userRow.rows[0].id;
});

function session(): SessionPayload {
  return {
    sub: biz.userId,
    role: "owner",
    businessId: biz.id,
    locationId: biz.locationId,
    activeLocationId: biz.locationId,
  } as unknown as SessionPayload;
}

const ACCESS = { permissions: new Set(["accounts.edit", "finance.accounts_manage", "ledger.view"]) };

async function load() {
  return dbLib.withTenant(biz.id, () =>
    openingService.loadSetupOpeningData({ session: session(), access: ACCESS }),
  );
}

async function seedChart(rows: { code: string; name: string; type: string; parentCode?: string }[]) {
  const ids = new Map<string, string>();
  for (const row of rows) {
    const result = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type, parent_id)
       VALUES ($1, $2, $3, $4::account_type, $5) RETURNING id`,
      [biz.id, row.code, row.name, row.type, row.parentCode ? (ids.get(row.parentCode) ?? null) : null],
    );
    ids.set(row.code, result.rows[0].id);
  }
  return ids;
}

describe("setup opening read model", () => {
  it("reports a missing chart when the business has no accounts", async () => {
    const data = await load();
    expect(data.state).toBe("chart_missing");
    expect(data.eligibleAccounts).toEqual([]);
    expect(data.chartAccountCount).toBe(0);
  });

  it("reports accounting_not_enabled when the saved app selection excludes Accounting", async () => {
    await dbLib.withTenant(biz.id, () =>
      settings.setSetting(biz.id, settings.SETTING_KEYS.setupSelectedApps, { apps: ["crm"], updatedAt: null }),
    );
    const data = await load();
    expect(data.state).toBe("accounting_not_enabled");
    expect(data.accountingEnabled).toBe(false);
  });

  it("distinguishes a chart with only parents from a ready chart", async () => {
    await seedChart([
      { code: "1000", name: "دارایی‌ها", type: "asset" },
      { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
      { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
      { code: "1120", name: "وجوه در راه", type: "asset", parentCode: "1000" },
      { code: "1300", name: "موجودی کالا", type: "asset", parentCode: "1000" },
      { code: "3000", name: "سرمایه", type: "equity" },
      { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },
    ]);
    // Every asset row above is still a leaf except 1000/3000, so the chart is
    // ready; the inventory subtree is excluded from the opening list.
    const ready = await load();
    expect(ready.state).toBe("ready");
    expect(ready.eligibleAccounts.map((account) => account.code)).toEqual(["1100", "1110", "1120", "3900"]);

    // Give 1100 a child: it stops being postable, but others remain.
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type, parent_id)
       SELECT $1, '1101', 'صندوق دوم', 'asset', id FROM accounts WHERE business_id = $1 AND code = '1100'`,
      [biz.id],
    );
    const afterChild = await load();
    expect(afterChild.state).toBe("ready");
    expect(afterChild.eligibleAccounts.some((account) => account.code === "1100")).toBe(false);

    // Archive every remaining leaf — the chart exists but nothing is postable.
    await db.query(
      `UPDATE accounts SET is_active = false
        WHERE business_id = $1 AND code IN ('1101','1110','1120','3900')`,
      [biz.id],
    );
    const noLeaf = await load();
    expect(noLeaf.state).toBe("no_eligible_leaf");
    expect(noLeaf.chartAccountCount).toBeGreaterThan(0);
  });

  it("returns real financial accounts and their ledger-derived balances", async () => {
    const ids = await seedChart([
      { code: "1000", name: "دارایی‌ها", type: "asset" },
      { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
      { code: "3900", name: "تراز افتتاحیه", type: "equity" },
    ]);
    const glId = ids.get("1110")!;
    const equityId = ids.get("3900")!;
    const fa = await db.query<{ id: string }>(
      `INSERT INTO financial_accounts (business_id, kind, name, gl_account_id, currency_code)
       VALUES ($1, 'bank', 'بانک ملت — جاری', $2, 'IRR') RETURNING id`,
      [biz.id, glId],
    );
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
       VALUES ($1, CURRENT_DATE, 'test', 'opening') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, 1000000, 0), ($1, $3, 0, 1000000)`,
      [entry.rows[0].id, glId, equityId],
    );

    const data = await load();
    expect(data.state).toBe("ready");
    const bank = data.financialAccounts.find((account) => account.id === fa.rows[0].id);
    expect(bank?.name).toBe("بانک ملت — جاری");
    expect(bank?.balance).toBe("1000000");
    expect(data.openingEntry?.total).toBe("1000000");
    expect(data.financialTotalsByKind.bank).toBe("1000000");
  });
});

describe("in-wizard money containers", () => {
  it("lets several POS terminals settle into one real bank, each with its own clearing GL", async () => {
    const ids = await seedChart([
      { code: "1000", name: "دارایی‌ها", type: "asset" },
      { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
      { code: "1120", name: "وجوه در راه", type: "asset", parentCode: "1000" },
      { code: "11201", name: "کارتخوان ۱", type: "asset", parentCode: "1120" },
      { code: "11202", name: "کارتخوان ۲", type: "asset", parentCode: "1120" },
      { code: "3350", name: "سرمایه", type: "equity" },
    ]);

    const created = await dbLib.withTenant(biz.id, async () => {
      const bank = await financialService.createFinancialAccount({
        businessId: biz.id,
        actorId: biz.userId,
        locationId: null,
        input: {
          kind: "bank",
          name: "بانک ملت — جاری",
          glAccountId: ids.get("1110"),
          bankCode: "mellat",
        },
      });
      const terminalOne = await financialService.createFinancialAccount({
        businessId: biz.id,
        actorId: biz.userId,
        locationId: null,
        input: {
          kind: "pos_psp",
          name: "کارتخوان صندوق ۱",
          glAccountId: ids.get("11201"),
          pspProvider: "به‌پرداخت",
          terminalNumber: "T-1",
          settlementAccountId: bank.id,
          settlementDelayDays: 1,
        },
      });
      const terminalTwo = await financialService.createFinancialAccount({
        businessId: biz.id,
        actorId: biz.userId,
        locationId: null,
        input: {
          kind: "pos_psp",
          name: "کارتخوان صندوق ۲",
          glAccountId: ids.get("11202"),
          pspProvider: "به‌پرداخت",
          terminalNumber: "T-2",
          settlementAccountId: bank.id,
          settlementDelayDays: 2,
        },
      });
      return { bank, terminalOne, terminalTwo };
    });

    expect(created.terminalOne.account.settlementAccountId).toBe(created.bank.id);
    expect(created.terminalTwo.account.settlementAccountId).toBe(created.bank.id);
    expect(created.terminalOne.account.glAccountId).not.toBe(created.terminalTwo.account.glAccountId);
    expect(created.bank.account.glAccountId).not.toBe(created.terminalOne.account.glAccountId);

    // A second container may not share the first terminal's clearing GL.
    await expect(
      dbLib.withTenant(biz.id, () =>
        financialService.createFinancialAccount({
          businessId: biz.id,
          actorId: biz.userId,
          locationId: null,
          input: {
            kind: "pos_psp",
            name: "کارتخوان سوم",
            glAccountId: ids.get("11201"),
            pspProvider: "به‌پرداخت",
            terminalNumber: "T-3",
            settlementAccountId: created.bank.id,
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "financial_account_already_linked" });
  });

  it("refuses another tenant's GL account", async () => {
    const ids = await seedChart([
      { code: "1000", name: "دارایی‌ها", type: "asset" },
      { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
    ]);
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Other Co', $1, 'food_service') RETURNING id",
      [`setup-opening-other-${randomUUID().slice(0, 8)}`],
    );
    const otherGl = await db.query<{ id: string }>(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'بانک دیگر', 'asset') RETURNING id",
      [other.rows[0].id],
    );

    await expect(
      dbLib.withTenant(biz.id, () =>
        financialService.createFinancialAccount({
          businessId: biz.id,
          actorId: biz.userId,
          locationId: null,
          input: { kind: "bank", name: "بانک مهمان", glAccountId: otherGl.rows[0].id },
        }),
      ),
    ).rejects.toMatchObject({ message: "gl_account_unavailable" });

    // The business's own GL still works, proving the refusal was tenancy.
    const own = await dbLib.withTenant(biz.id, () =>
      financialService.createFinancialAccount({
        businessId: biz.id,
        actorId: biz.userId,
        locationId: null,
        input: { kind: "bank", name: "بانک خودی", glAccountId: ids.get("1110") },
      }),
    );
    expect(own.id).toBeTruthy();
  });
});

describe("wizard opening posting", () => {
  async function chart() {
    return seedChart([
      { code: "1000", name: "دارایی‌ها", type: "asset" },
      { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
      { code: "1300", name: "موجودی کالا", type: "asset", parentCode: "1000" },
      { code: "3000", name: "سرمایه", type: "equity" },
      { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },
    ]);
  }

  function post(lines: { accountId: string; debit: number; credit: number }[], autoOffset = true) {
    return dbLib.withTenant(biz.id, () =>
      postingService.postWizardOpeningBalances({ session: session(), lines, autoOffset }),
    );
  }

  it("posts one balanced opening entry through the canonical engine, exactly in Rial", async () => {
    const ids = await chart();
    const result = await post([{ accountId: ids.get("1100")!, debit: 123_456_789, credit: 0 }]);
    expect(result.totalDebit).toBe(123_456_789);
    expect(result.totalCredit).toBe(123_456_789);

    const entry = await db.query<{ source_type: string; voucher_number: string | null; idempotency_key: string | null }>(
      "SELECT source_type, voucher_number, idempotency_key FROM journal_entries WHERE id = $1",
      [result.entryId],
    );
    expect(entry.rows[0].source_type).toBe("opening");
    expect(entry.rows[0].voucher_number).toBeTruthy();
    expect(entry.rows[0].idempotency_key).toBe(`setup-opening:${biz.id}`);

    const lines = await db.query<{ total_debit: string; total_credit: string; count: string }>(
      `SELECT COALESCE(SUM(debit),0)::text AS total_debit,
              COALESCE(SUM(credit),0)::text AS total_credit,
              count(*)::text AS count
         FROM journal_lines WHERE entry_id = $1`,
      [result.entryId],
    );
    expect(lines.rows[0]).toEqual({
      total_debit: "123456789",
      total_credit: "123456789",
      count: "2",
    });
  });

  it("is idempotent: a retry returns the existing entry and never posts a second one", async () => {
    const ids = await chart();
    const first = await post([{ accountId: ids.get("1100")!, debit: 5_000, credit: 0 }]);
    const second = await post([{ accountId: ids.get("1100")!, debit: 5_000, credit: 0 }]);
    expect(second.entryId).toBe(first.entryId);
    expect(second.alreadyExists).toBe(true);
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'opening'",
      [biz.id],
    );
    expect(count.rows[0].n).toBe("1");
  });

  it("refuses the automatic inventory control and non-postable parents", async () => {
    const ids = await chart();
    await expect(
      post([{ accountId: ids.get("1300")!, debit: 1_000, credit: 0 }]),
    ).rejects.toMatchObject({ message: "inventory_opening_is_automatic" });

    // Give the cash account a child: it is a parent now, not a posting target.
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type, parent_id)
       SELECT $1, '1101', 'صندوق دوم', 'asset', id FROM accounts WHERE business_id = $1 AND code = '1100'`,
      [biz.id],
    );
    await expect(
      post([{ accountId: ids.get("1100")!, debit: 1_000, credit: 0 }]),
    ).rejects.toMatchObject({ message: "not_a_leaf_account" });
  });

  it("refuses when a formal opening set is already approved", async () => {
    const ids = await chart();
    await db.query(
      `INSERT INTO opening_balance_sets
         (business_id, fiscal_year_label, effective_date, status, submitted_at, approved_at, created_by)
       VALUES ($1, '1404', '2025-04-01', 'approved', now(), now(), $2)`,
      [biz.id, biz.userId],
    );
    await expect(
      post([{ accountId: ids.get("1100")!, debit: 1_000, credit: 0 }]),
    ).rejects.toMatchObject({ message: "opening_set_exists" });
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'opening'",
      [biz.id],
    );
    expect(count.rows[0].n).toBe("0");
  });
});
