/**
 * Audit F08 — fiscal-period readiness. The database deliberately lets an entry
 * land on a date no period covers; this proves the readiness service reports
 * that honestly (no year, uncovered count and range, today's coverage), that
 * the accounting review carries it as a finding, and that only *closing* is
 * tightened: closeFiscalYear refuses while earlier entries are uncovered,
 * and nothing — posting included — rejects, moves or re-dates an entry.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { fiscalYearSpec } from "../src/lib/fiscal-periods";
import { jalaliYearOf } from "../src/lib/fiscal-readiness";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let closingService: typeof import("../src/lib/closing-service");
let reviewService: typeof import("../src/lib/accounting-review-service");
let dayService: typeof import("../src/lib/business-day-service");

const biz = { id: "", owner: "", cash: "", revenue: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

beforeAll(async () => {
  databaseName = `pos_fiscal_ready_${randomUUID().replaceAll("-", "")}`;
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
  closingService = await import("../src/lib/closing-service");
  reviewService = await import("../src/lib/accounting-review-service");
  dayService = await import("../src/lib/business-day-service");

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
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Fiscal Ready Co', $1) RETURNING id",
    [`fiscal-ready-${randomUUID().slice(0, 8)}`],
  );
  biz.id = rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  biz.owner = owner.rows[0].id;
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4300', 'Sales', 'revenue'),
            ($1, '3800', 'Retained earnings', 'equity')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") biz.cash = row.id;
    if (row.code === "4300") biz.revenue = row.id;
  }
});

/** A balanced sale entry on `entryDate`, written the way an import would — straight in. */
async function postSale(entryDate: string, amount = 100_000): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, 'sale', 'manual', $3) RETURNING id`,
    [biz.id, entryDate, biz.owner],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [rows[0].id, biz.cash, amount, biz.revenue],
  );
  return rows[0].id;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("getFiscalReadiness", () => {
  it("reports a business with no fiscal year: every entry uncovered, closing impossible", async () => {
    await postSale("2025-06-01");
    await postSale("2025-09-15");
    await postSale("2025-09-15");

    const r = await fiscalService.getFiscalReadiness(biz.id);
    expect(r.hasFiscalYear).toBe(false);
    expect(r.todayCovered).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.issues).toEqual(["no_fiscal_year", "uncovered_entries"]);
    expect(r.uncovered).toEqual({ count: 3, earliest: "2025-06-01", latest: "2025-09-15" });
    expect(r.canClose).toBe(false);
  });

  it("counts only the entries outside every period, and covers today once its year exists", async () => {
    const today = await dayService.businessToday(biz.id);
    const jy = jalaliYearOf(today)!;
    const previous = fiscalYearSpec(jy - 1);
    await fiscalService.createFiscalYear(biz.id, jy);

    await postSale(today);
    const legacy = await postSale(addDays(previous.startsOn, 10));

    const r = await fiscalService.getFiscalReadiness(biz.id);
    expect(r.hasFiscalYear).toBe(true);
    expect(r.todayCovered).toBe(true);
    expect(r.uncovered).toEqual({
      count: 1,
      earliest: addDays(previous.startsOn, 10),
      latest: addDays(previous.startsOn, 10),
    });
    expect(r.issues).toEqual(["uncovered_entries"]);
    // The uncovered entry is dated before this year's end, so this year cannot close.
    expect(r.canClose).toBe(false);

    // Defining the earlier year covers it — without touching the entry.
    await fiscalService.createFiscalYear(biz.id, jy - 1);
    const covered = await fiscalService.getFiscalReadiness(biz.id);
    expect(covered.ready).toBe(true);
    expect(covered.uncovered.count).toBe(0);
    expect(covered.canClose).toBe(true);
    expect(covered.closableYearLabels.sort()).toEqual([String(jy - 1), String(jy)]);

    const { rows } = await db.query<{ entry_date: string }>(
      "SELECT entry_date::text AS entry_date FROM journal_entries WHERE id = $1",
      [legacy],
    );
    expect(rows[0].entry_date).toBe(addDays(previous.startsOn, 10));
  });

  it("flags today as uncovered when only a past year is defined", async () => {
    const today = await dayService.businessToday(biz.id);
    const jy = jalaliYearOf(today)!;
    await fiscalService.createFiscalYear(biz.id, jy - 1);
    await postSale(today);

    const r = await fiscalService.getFiscalReadiness(biz.id);
    expect(r.todayCovered).toBe(false);
    expect(r.issues).toEqual(["today_uncovered", "uncovered_entries"]);
    // Today's uncovered sale is after last year's end: last year may still close.
    expect(r.closableYearLabels).toEqual([String(jy - 1)]);
    expect(r.canClose).toBe(true);
  });
});

describe("closeFiscalYear with uncovered history", () => {
  it("refuses while an earlier entry is outside every period, and moves nothing", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    await postSale("2025-05-01"); // inside 1404
    const legacy = await postSale("2024-12-01"); // 1403, never defined

    for (const period of await fiscalService.listPeriods(biz.id, year.id)) {
      await fiscalService.setPeriodStatus(biz.id, period.id, "soft_closed", biz.owner);
    }

    await expect(closingService.closeFiscalYear(biz.id, year.id, biz.owner)).rejects.toMatchObject({
      message: "uncovered_entries_before_close",
      status: 409,
      details: { uncovered: { count: 1, earliest: "2024-12-01", latest: "2024-12-01" } },
    });

    // Nothing was posted, locked, rejected or re-dated.
    const entries = await db.query<{ id: string; entry_date: string }>(
      "SELECT id, entry_date::text AS entry_date FROM journal_entries WHERE business_id = $1 ORDER BY entry_date",
      [biz.id],
    );
    expect(entries.rows).toHaveLength(2);
    expect(entries.rows[0]).toEqual({ id: legacy, entry_date: "2024-12-01" });
    const [stillOpen] = await fiscalService.listFiscalYears(biz.id);
    expect(stillOpen.closedAt).toBeNull();

    // Covering the legacy date lets the same close go through.
    await fiscalService.createFiscalYear(biz.id, 1403);
    const result = await closingService.closeFiscalYear(biz.id, year.id, biz.owner);
    expect(result.netIncome).toBe(100_000);
  });

  it("does not let posting depend on coverage: an uncovered date still posts", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    await expect(postSale("2030-01-01")).resolves.toBeTruthy();
  });
});

describe("the accounting review", () => {
  it("reports uncovered entries as a finding with every check available", async () => {
    await postSale("2025-06-01");
    await postSale("2025-07-01");

    const review = await dbLib.withTenant(biz.id, () => reviewService.runAccountingReview(biz.id));
    expect(review.unavailableChecks).toEqual([]);
    const finding = review.findings.find((row) => row.code === "uncovered_fiscal_dates");
    expect(finding?.count).toBe(2);
    expect(finding?.title).toBe("سال مالی تعریف نشده");
    expect(finding?.detail).not.toContain("2025");

    await fiscalService.createFiscalYear(biz.id, 1404);
    const clean = await dbLib.withTenant(biz.id, () => reviewService.runAccountingReview(biz.id));
    expect(clean.findings.find((row) => row.code === "uncovered_fiscal_dates")).toBeUndefined();
  });
});
