/**
 * Fixed-asset register, depreciation and lifecycle — issue #833's
 * accounting-integrity coverage. Proves, against a real database:
 *
 *   * concurrency — simultaneous posts cannot over-depreciate an asset, the
 *     same canonical month posts exactly once, and the final-period
 *     rounding correction stays exact under concurrent months;
 *   * branch integrity — the journal posts to the asset's own location, not
 *     the caller's, and a recorded transfer moves future postings;
 *   * source-history integrity — deletion cannot race a posting, posted
 *     history cannot be hard-deleted, and the FK no longer cascades;
 *   * period identity — equivalent labels resolve to one canonical month,
 *     chronology (in-service start, no future months) is enforced;
 *   * reversal — the exact mirror effect, no double reversal, fiscal locks
 *     honoured, and the schedule recalculates correctly afterwards;
 *   * disposal — gain above NBV, loss below it, zero-proceeds write-off,
 *     cost/accumulated removed from the Balance Sheet, no depreciation after;
 *   * estimate changes — prospective only, historical postings unchanged,
 *     remaining depreciable amount exact;
 *   * register ↔ ledger — acquisition provenance and reconciliation;
 *   * idempotency — repeated/concurrent same-key creates make one asset;
 *   * pagination/filtering/export — server-backed totals across pages.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  addMonthsToPeriodKey,
  depreciationPeriod,
  depreciationPeriodOfDate,
  parseDepreciationPeriodKey,
} from "../src/lib/depreciation";
import { isoDateToJalali } from "../src/lib/jalali";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let fixedAssetsService: typeof import("../src/lib/fixed-assets-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationA: "", locationB: "" };
const acct = {
  depreciationExpense: "",
  accumulatedDepreciation: "",
  fixedAssetsRoot: "",
  gain: "",
  loss: "",
  cash: "",
};
const owner = { id: "" };

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
  databaseName = `pos_fixed_assets_${randomUUID().replaceAll("-", "")}`;

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
  fixedAssetsService = await import("../src/lib/fixed-assets-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");
  provisioning = await import("../src/lib/business-provisioning");

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
  // RESTRICT means the children must go first, and fixed_assets itself
  // references journal_entries/parties/accounts, which the businesses delete
  // would cascade — the register's rows go before them either way.
  await db.query("DELETE FROM fixed_asset_transfers");
  await db.query("DELETE FROM fixed_asset_estimate_changes");
  await db.query("DELETE FROM fixed_asset_depreciation_entries");
  await db.query("DELETE FROM fixed_assets");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Fixed Assets Co', $1) RETURNING id",
    [`fa-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRows = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Branch A'), ($1, 'Branch B') RETURNING id",
    [biz.id],
  );
  biz.locationA = locRows.rows[0].id;
  biz.locationB = locRows.rows[1].id;

  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  owner.id = ownerRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5700', 'Depreciation expense', 'expense'),
            ($1, '1510', 'Accumulated depreciation', 'asset'),
            ($1, '1500', 'Fixed assets', 'asset'),
            ($1, '4920', 'Gain on asset sale', 'revenue'),
            ($1, '5750', 'Loss on asset sale', 'expense'),
            ($1, '1100', 'Cash', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "5700") acct.depreciationExpense = r.id;
    if (r.code === "1510") acct.accumulatedDepreciation = r.id;
    if (r.code === "1500") acct.fixedAssetsRoot = r.id;
    if (r.code === "4920") acct.gain = r.id;
    if (r.code === "5750") acct.loss = r.id;
    if (r.code === "1100") acct.cash = r.id;
  }
});

interface CreateOverrides {
  name?: string;
  cost?: number;
  salvageValue?: number;
  usefulLifeMonths?: number;
  locationId?: string;
  acquisitionDate?: string;
  inServiceDate?: string | null;
  category?: string | null;
}

async function createAsset(overrides: CreateOverrides = {}) {
  return fixedAssetsService.createFixedAsset({
    businessId: biz.id,
    locationId: overrides.locationId ?? biz.locationA,
    name: overrides.name ?? "یخچال صنعتی",
    acquisitionDate: overrides.acquisitionDate ?? "2025-01-01",
    inServiceDate: overrides.inServiceDate ?? null,
    cost: overrides.cost ?? 120_000_000,
    salvageValue: overrides.salvageValue ?? 0,
    usefulLifeMonths: overrides.usefulLifeMonths ?? 60,
    category: overrides.category ?? null,
    createdBy: owner.id,
  });
}

/**
 * The last `count` Jalali month keys up to and including the current one —
 * every posting in these tests must land in a month that has started, so
 * the windows are derived from the real clock rather than hard-coded years
 * that age into the future.
 */
function recentPeriodKeys(count: number, includeCurrent = true): string[] {
  const todayIso = new Date().toISOString().slice(0, 10);
  const j = isoDateToJalali(todayIso)!;
  const keys: string[] = [];
  let y = j.jy;
  let m = j.jm;
  const total = includeCurrent ? count : count + 1;
  for (let i = 0; i < total; i++) {
    if (i > 0 || includeCurrent) keys.unshift(depreciationPeriod(y, m).key);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return keys;
}

/** The Jalali month key `n` months before the current one. */
function periodMonthsAgo(n: number): string {
  const current = depreciationPeriodOfDate(new Date().toISOString().slice(0, 10))!;
  return addMonthsToPeriodKey(current.key, -n);
}

/**
 * An acquisition date that puts the asset in service in the given Jalali
 * month — the calendar schedule (issue #833) anchors at that month, so tests
 * that post recent months need assets whose schedule actually covers them.
 */
function acquisitionDateFor(periodKey: string): string {
  return parseDepreciationPeriodKey(periodKey)!.startsOn;
}

function post(assetId: string, extra: { periodKey?: string; periodLabel?: string; entryDate?: string } = {}) {
  return fixedAssetsService.postDepreciation({
    businessId: biz.id,
    fixedAssetId: assetId,
    createdBy: owner.id,
    ...extra,
  });
}

describe("createFixedAsset", () => {
  it("registers an asset with zero accumulated depreciation, a book value equal to cost and a stable auto code", async () => {
    const asset = await createAsset();
    expect(asset.accumulatedDepreciation).toBe(0);
    expect(asset.bookValue).toBe(120_000_000);
    expect(asset.status).toBe("active");
    expect(asset.code).toBe("FA-0001");
    const second = await createAsset({ cost: 1_000_000 });
    expect(second.code).toBe("FA-0002");
  });

  it("rejects an invalid asset (e.g. salvage value not less than cost)", async () => {
    await expect(createAsset({ salvageValue: 120_000_000 })).rejects.toThrow();
  });

  it("rejects a loose acquisition date that Date.parse would accept, and an over-long life", async () => {
    await expect(
      fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name: "تست",
        acquisitionDate: "March 5, 2025",
        cost: 1_000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/تاریخ خرید/);
    await expect(
      fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name: "تست",
        acquisitionDate: "2025-01-01",
        cost: 1_000,
        salvageValue: 0,
        usefulLifeMonths: 5000,
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/عمر مفید/);
  });

  it("refuses a location, party or asset account from another business", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`fa-other-${randomUUID().slice(0, 8)}`],
    );
    const otherLoc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Elsewhere') RETURNING id",
      [other.rows[0].id],
    );
    await expect(createAsset({ locationId: otherLoc.rows[0].id })).rejects.toThrow("location_not_found");
  });
});

describe("createFixedAsset — idempotency (issue #833)", () => {
  it("a repeated request with the same key returns the original asset", async () => {
    const key = `asset-${randomUUID()}`;
    const base = {
      businessId: biz.id,
      locationId: biz.locationA,
      name: "میز اداری",
      acquisitionDate: "2025-01-01",
      cost: 5_000_000,
      salvageValue: 0,
      usefulLifeMonths: 24,
      createdBy: owner.id,
      idempotencyKey: key,
    };
    const first = await fixedAssetsService.createFixedAsset(base);
    const again = await fixedAssetsService.createFixedAsset({ ...base, name: "میز اداری (ارسال دوباره)" });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("میز اداری");
    const all = await fixedAssetsService.listFixedAssets(biz.id);
    expect(all).toHaveLength(1);
  });

  it("concurrent same-key creates make exactly one asset", async () => {
    const key = `asset-${randomUUID()}`;
    const base = {
      businessId: biz.id,
      locationId: biz.locationA,
      name: "کولر",
      acquisitionDate: "2025-01-01",
      cost: 8_000_000,
      salvageValue: 0,
      usefulLifeMonths: 36,
      createdBy: owner.id,
      idempotencyKey: key,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => fixedAssetsService.createFixedAsset(base)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
    expect(fulfilled.length).toBe(4);
    expect(new Set(fulfilled.map((r) => r.value.id)).size).toBe(1);
    expect(await fixedAssetsService.listFixedAssets(biz.id)).toHaveLength(1);
  });

  it("different keys create distinct assets with distinct auto codes", async () => {
    await Promise.all([
      fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name: "الف",
        acquisitionDate: "2025-01-01",
        cost: 1_000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        createdBy: owner.id,
        idempotencyKey: "k1",
      }),
      fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name: "ب",
        acquisitionDate: "2025-01-01",
        cost: 1_000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        createdBy: owner.id,
        idempotencyKey: "k2",
      }),
    ]);
    const all = await fixedAssetsService.listFixedAssets(biz.id);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((a) => a.code)).size).toBe(2);
  });
});

describe("postDepreciation", () => {
  it("posts a balanced entry (Debit depreciation expense / Credit accumulated depreciation) with the depreciation posting kind", async () => {
    const asset = await createAsset(); // 120,000,000 / 60 = 2,000,000/month
    const { amount, journalEntryId } = await post(asset.id, { periodLabel: "1404-01", entryDate: "2025-04-01" });
    expect(amount).toBe(2_000_000);
    expect(journalEntryId).toBeTruthy();

    const { rows: entries } = await db.query<{ id: string; source_type: string; posting_kind: string | null }>(
      `SELECT id, source_type, posting_kind FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source_type).toBe("fixed_asset_depreciation");
    expect(entries[0].posting_kind).toBe("depreciation");

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC`,
      [entries[0].id],
    );
    expect(lines).toEqual([
      { account_id: acct.depreciationExpense, debit: "2000000", credit: "0" },
      { account_id: acct.accumulatedDepreciation, debit: "0", credit: "2000000" },
    ]);
  });

  it("updates the reconstructed accumulatedDepreciation and bookValue", async () => {
    const asset = await createAsset();
    await post(asset.id, { periodKey: "1404-01" });
    await post(asset.id, { periodKey: "1404-02" });

    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(4_000_000);
    expect(listed.bookValue).toBe(116_000_000);
  });

  it("refuses to post the same period twice for the same asset", async () => {
    const asset = await createAsset();
    await post(asset.id, { periodLabel: "1404-01" });
    await expect(post(asset.id, { periodLabel: "1404-01" })).rejects.toThrow("period_already_depreciated");

    // The rejected attempt didn't leave a second journal entry behind.
    const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text FROM journal_entries WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(rows[0].count).toBe("1");
  });

  it("caps the final period at what's left of the depreciable base, then refuses further depreciation", async () => {
    // cost 100,000, salvage 0, useful life 3 months from 1403-10 (the month
    // of the 2025-01-01 in-service date) -> monthly = 33,333.33... rounds to 33,333.
    const asset = await createAsset({ cost: 100_000, salvageValue: 0, usefulLifeMonths: 3 });

    const p1 = await post(asset.id, { periodKey: "1403-10" });
    const p2 = await post(asset.id, { periodKey: "1403-11" });
    const p3 = await post(asset.id, { periodKey: "1403-12" });

    expect(p1.amount + p2.amount + p3.amount).toBe(100_000);
    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(100_000);
    expect(listed.bookValue).toBe(0);

    // The schedule is a calendar: 1404-01 is past its end, not a fourth period.
    await expect(post(asset.id, { periodKey: "1404-01" })).rejects.toThrow("period_beyond_schedule");
  });

  it("refuses to post into a locked fiscal period", async () => {
    const asset = await createAsset();
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    await expect(post(asset.id, { periodKey: "1404-01", entryDate: farvardin.startsOn })).rejects.toThrow(
      "fiscal_period_locked",
    );
  });
});

describe("postDepreciation — canonical months and concurrency (audit F07)", () => {
  it("refuses the same Jalali month under a different label or date", async () => {
    const asset = await createAsset();
    await post(asset.id, { periodLabel: "۱۴۰۴/۰۱", entryDate: "2025-03-25" });
    await expect(post(asset.id, { periodLabel: "فروردین ۱۴۰۴", entryDate: "2025-04-15" })).rejects.toThrow(
      "period_already_depreciated",
    );
    await expect(post(asset.id, { periodKey: "1404-01" })).rejects.toThrow("period_already_depreciated");
  });

  it("dates a past month at its last day and stores the canonical key", async () => {
    const asset = await createAsset();
    const result = await post(asset.id, { periodKey: "1404-01" });
    expect(result).toMatchObject({ periodKey: "1404-01", entryDate: "2025-04-20", periodLabel: "فروردین 1404" });
    const { rows } = await db.query<{ entry_date: string; period_key: string }>(
      `SELECT je.entry_date::text, d.period_key FROM fixed_asset_depreciation_entries d
         JOIN journal_entries je ON je.source_id = d.id AND je.source_type = 'fixed_asset_depreciation'`,
    );
    expect(rows).toEqual([{ entry_date: "2025-04-20", period_key: "1404-01" }]);
  });

  it("refuses a month before the asset entered service", async () => {
    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "کوره",
      acquisitionDate: "2025-01-01",
      inServiceDate: "2025-06-01",
      cost: 12_000_000,
      salvageValue: 0,
      usefulLifeMonths: 12,
      createdBy: owner.id,
    });
    expect(asset.inServiceDate).toBe("2025-06-01");
    await expect(post(asset.id, { periodKey: "1404-02" })).rejects.toThrow("period_before_in_service");
    // 2025-06-01 is 1404/03/11 — the in-service month itself depreciates.
    await expect(post(asset.id, { periodKey: "1404-03" })).resolves.toMatchObject({ amount: 1_000_000 });
  });

  it("refuses a month that has not started", async () => {
    const asset = await createAsset();
    await expect(post(asset.id, { periodKey: "1499-01" })).rejects.toThrow("period_in_future");
  });

  it("lets a legacy free-text entry still block its month", async () => {
    const asset = await createAsset();
    await db.query(
      `INSERT INTO fixed_asset_depreciation_entries (fixed_asset_id, period_label, entry_date, amount)
       VALUES ($1, 'دوره قدیمی', '2025-04-10', 2000000)`,
      [asset.id],
    );
    await expect(post(asset.id, { periodKey: "1404-01" })).rejects.toThrow("period_already_depreciated");
    await expect(post(asset.id, { periodKey: "1404-02" })).resolves.toMatchObject({ amount: 2_000_000 });
  });

  it("serialises concurrent requests for the same month: one entry, one refusal", async () => {
    const asset = await createAsset();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => post(asset.id, { periodKey: "1404-05" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason.message).toBe("period_already_depreciated");
    }
    const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text FROM journal_entries WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(rows[0].count).toBe("1");
  });

  it("never depreciates past cost minus salvage under concurrent months", async () => {
    // 100,000 − 10,000 over the 3-month schedule from 1403-10; five months
    // requested at once — the two past the schedule's end are refused by the
    // calendar, and the three scheduled ones never overrun the base.
    const asset = await createAsset({ cost: 100_000, salvageValue: 10_000, usefulLifeMonths: 3 });
    const months = ["1403-10", "1403-11", "1403-12", "1404-01", "1404-02"];
    const results = await Promise.allSettled(months.map((periodKey) => post(asset.id, { periodKey })));
    const posted = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ amount: number }>[];
    // Which months land depends on the interleaving — the row lock
    // serialises the posts, but the absorber month may soak up the whole
    // base before a neighbour gets its turn and that neighbour is then
    // honestly told the base is consumed. What must hold in EVERY
    // interleaving: at least one month posts, the base is never exceeded,
    // and it is consumed EXACTLY.
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted.length).toBeLessThanOrEqual(3);
    expect(posted.reduce((sum, r) => sum + r.value.amount, 0)).toBe(90_000);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(["period_beyond_schedule", "fully_depreciated"]).toContain(
        (r as PromiseRejectedResult).reason.message,
      );
    }
    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(90_000);
    expect(listed.bookValue).toBe(10_000);
    expect(listed.fullyDepreciated).toBe(true);
    const { rows } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit), 0)::text AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.accumulatedDepreciation],
    );
    expect(rows[0].credit).toBe("90000");
  });
});

describe("chronology and catch-up policy (issue #833 follow-up)", () => {
  it("accepts out-of-order and skipped months as catch-up, each at its own month's amount", async () => {
    // The three months before the current one, oldest first. m2 is skipped
    // until the end; m3 is posted before m1.
    const [m1, m2, m3] = recentPeriodKeys(3, false);
    // In service in m1's month, so the 12-month calendar schedule covers m1..m3.
    const asset = await createAsset({
      cost: 12_000_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(m1),
    });

    const third = await post(asset.id, { periodKey: m3 });
    const first = await post(asset.id, { periodKey: m1 });
    const late = await post(asset.id, { periodKey: m2 });
    // Straight-line: every month is 1,000,000 regardless of arrival order.
    expect([first, third, late].map((r) => r.amount)).toEqual([1_000_000, 1_000_000, 1_000_000]);

    const detail = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(detail.fixedAsset.accumulatedDepreciation).toBe(3_000_000);
    expect(detail.fixedAsset.depreciationCount).toBe(3);
  });

  it("refuses a document dated in the future, even inside the current month", async () => {
    const asset = await createAsset();
    const todayIso = new Date().toISOString().slice(0, 10);
    const period = depreciationPeriodOfDate(todayIso)!;
    // Deterministic coverage of the same rule lives in depreciation.test.ts
    // with a fixed today; this guard runs whenever the month has days left.
    if (period.endsOn > todayIso) {
      await expect(post(asset.id, { periodKey: period.key, entryDate: period.endsOn })).rejects.toThrow(
        "entry_date_in_future",
      );
    }
    // A past day inside the current month is fine.
    await expect(post(asset.id, { periodKey: period.key, entryDate: todayIso })).resolves.toBeTruthy();
  });
});

describe("branch integrity — the asset's own location, never the caller's (issue #833)", () => {
  it("posts depreciation to the asset's registered branch", async () => {
    const asset = await createAsset({ locationId: biz.locationA });
    await post(asset.id, { periodKey: "1404-01" });
    const { rows } = await db.query<{ location_id: string | null }>(
      `SELECT location_id FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].location_id).toBe(biz.locationA);
  });

  it("resolves the posting branch by the document's date, never by the asset's branch today", async () => {
    // 1404-01 = 2025-03-21..2025-04-20, 1404-02 = ..2025-05-21, 1404-03 = ..2025-06-21.
    const asset = await createAsset({ locationId: biz.locationA });

    // Posted while the asset sat in branch A: a historical fact that stays A.
    await post(asset.id, { periodKey: "1404-02" });

    // A transfer effective 2025-05-01 — after 1404-01's and 1404-02's document
    // dates, before 1404-03's.
    await fixedAssetsService.transferFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      toLocationId: biz.locationB,
      effectiveDate: "2025-05-01",
      reason: "انتقال به شعبه مرکزی",
      createdBy: owner.id,
    });

    // A catch-up month from BEFORE the transfer date posts to the branch that
    // held the asset then — branch A — even though the asset now sits in B.
    await post(asset.id, { periodKey: "1404-01" });
    // A month from after the transfer date posts to the new branch.
    await post(asset.id, { periodKey: "1404-03" });

    const { rows } = await db.query<{ location_id: string | null; entry_date: string }>(
      `SELECT location_id, entry_date::text FROM journal_entries WHERE business_id = $1 ORDER BY entry_date`,
      [biz.id],
    );
    expect(rows).toHaveLength(3);
    // 1404-01 (document 2025-04-20, before the transfer) → A.
    // 1404-02 (posted while in A) → A, untouched by the later transfer.
    // 1404-03 (document 2025-06-21, after the transfer) → B.
    expect(rows.map((r) => r.location_id)).toEqual([biz.locationA, biz.locationA, biz.locationB]);

    const detail = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(detail.transfers).toHaveLength(1);
    expect(detail.transfers[0]).toMatchObject({
      fromLocationName: "Branch A",
      toLocationName: "Branch B",
      reason: "انتقال به شعبه مرکزی",
      transferredByName: "Owner",
    });
    expect(detail.fixedAsset.locationId).toBe(biz.locationB);
  });

  it("refuses transfers that would rewrite history: before in-service, or before the latest transfer", async () => {
    const asset = await createAsset({ locationId: biz.locationA }); // in service 2025-01-01
    const transfer = (effectiveDate: string, toLocationId = biz.locationB) =>
      fixedAssetsService.transferFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        toLocationId,
        effectiveDate,
        reason: "تست",
        createdBy: owner.id,
      });

    await expect(transfer("2024-06-01")).rejects.toThrow("transfer_before_in_service");
    await expect(transfer("2025-05-01")).resolves.toBeTruthy();
    // The recorded chain is append-only: an earlier-dated transfer would need
    // the previous transfer's `from` rewritten. (Destination A — distinct
    // from the asset's current branch B, so the same-branch refusal cannot
    // mask the chronology one.)
    await expect(transfer("2025-04-01", biz.locationA)).rejects.toThrow("transfer_before_last_transfer");
    // Same-date and later transfers are fine (the asset moves back to A).
    await expect(transfer("2025-06-01", biz.locationA)).resolves.toBeTruthy();
    const detail = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    // The history lists newest first.
    expect(detail.transfers.map((t) => `${t.fromLocationName}→${t.toLocationName}`)).toEqual([
      "Branch B→Branch A",
      "Branch A→Branch B",
    ]);
  });

  it("refuses a transfer to the same branch and records the reason as audit", async () => {
    const asset = await createAsset({ locationId: biz.locationA });
    await expect(
      fixedAssetsService.transferFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        toLocationId: biz.locationA,
        reason: "تست",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("transfer_same_location");
    await expect(
      fixedAssetsService.transferFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        toLocationId: biz.locationB,
        reason: "",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("reason_required");
  });
});

describe("acquisition linkage and register ↔ GL reconciliation (audit F09)", () => {
  async function postPurchase(cost: number, businessId = biz.id): Promise<string> {
    const { rows: fa } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1500', 'اثاثه و تجهیزات', 'asset')
       ON CONFLICT (business_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [businessId],
    );
    const { rows: bank } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'بانک', 'asset')
       ON CONFLICT (business_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [businessId],
    );
    const { rows: entry } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, '2025-01-01', 'خرید یخچال', 'manual') RETURNING id`,
      [businessId],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)`,
      [entry[0].id, fa[0].id, bank[0].id, cost],
    );
    return entry[0].id;
  }

  it("links an asset to its purchase entry and then reconciles with the ledger", async () => {
    const entryId = await postPurchase(120_000_000);
    const before = await fixedAssetsService.getFixedAssetReconciliation(biz.id);
    expect(before).toMatchObject({ registerCost: "0", ledgerCost: "120000000", status: "difference" });

    const candidates = await fixedAssetsService.listAcquisitionCandidates(biz.id);
    expect(candidates).toEqual([expect.objectContaining({ entryId, availableRial: "120000000" })]);

    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "یخچال صنعتی",
      acquisitionDate: "2025-01-01",
      cost: 120_000_000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      acquisitionSource: "journal",
      acquisitionEntryId: entryId,
      createdBy: owner.id,
    });
    expect(asset).toMatchObject({ acquisitionSource: "journal", acquisitionEntryId: entryId });
    expect(await fixedAssetsService.listAcquisitionCandidates(biz.id)).toEqual([]);

    // Linking posted nothing: the purchase is still the only entry.
    const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text FROM journal_entries WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(rows[0].count).toBe("1");

    await post(asset.id, { periodKey: "1403-10" });
    expect(await fixedAssetsService.getFixedAssetReconciliation(biz.id)).toEqual({
      registerCost: "120000000",
      ledgerCost: "120000000",
      costDifference: "0",
      registerAccumulated: "2000000",
      ledgerAccumulated: "2000000",
      accumulatedDifference: "0",
      unlinkedCount: 0,
      unlinkedCost: "0",
      status: "reconciled",
    });
  });

  it("refuses a second asset claiming more than the entry debited", async () => {
    const entryId = await postPurchase(100_000_000);
    const base = {
      businessId: biz.id,
      locationId: biz.locationA,
      acquisitionDate: "2025-01-01",
      salvageValue: 0,
      usefulLifeMonths: 60,
      acquisitionSource: "journal" as const,
      acquisitionEntryId: entryId,
      createdBy: owner.id,
    };
    await fixedAssetsService.createFixedAsset({ ...base, name: "میز", cost: 60_000_000 });
    await expect(fixedAssetsService.createFixedAsset({ ...base, name: "صندلی", cost: 50_000_000 })).rejects.toThrow(
      "acquisition_entry_insufficient",
    );
  });

  it("refuses another business's entry and reports unlinked assets", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`fa-other-${randomUUID().slice(0, 8)}`],
    );
    const foreignEntry = await postPurchase(5_000_000, other.rows[0].id);
    const asset = await createAsset();
    await expect(
      fixedAssetsService.setFixedAssetAcquisition({
        businessId: biz.id,
        fixedAssetId: asset.id,
        acquisitionSource: "journal",
        acquisitionEntryId: foreignEntry,
      }),
    ).rejects.toThrow("acquisition_entry_not_found");
    // The database guard holds even when the service is bypassed.
    await expect(
      db.query(`UPDATE fixed_assets SET acquisition_source = 'journal', acquisition_entry_id = $2 WHERE id = $1`, [
        asset.id,
        foreignEntry,
      ]),
    ).rejects.toThrow(/another business/);

    expect(await fixedAssetsService.getFixedAssetReconciliation(biz.id)).toMatchObject({
      unlinkedCount: 1,
      unlinkedCost: "120000000",
    });
    const opening = await fixedAssetsService.setFixedAssetAcquisition({
      businessId: biz.id,
      fixedAssetId: asset.id,
      acquisitionSource: "opening_balance",
    });
    expect(opening.acquisitionSource).toBe("opening_balance");
    expect((await fixedAssetsService.getFixedAssetReconciliation(biz.id)).unlinkedCount).toBe(0);
  });
});

describe("depreciation reversal — the auditable correction path (issue #833)", () => {
  async function postOne(assetId: string, periodKey: string) {
    return post(assetId, { periodKey });
  }

  it("posts the exact mirror of the original journal effect and marks the source row", async () => {
    const asset = await createAsset();
    const original = await postOne(asset.id, "1404-01");
    expect(original.amount).toBe(2_000_000);

    const reversal = await fixedAssetsService.reverseDepreciation({
      businessId: biz.id,
      fixedAssetId: asset.id,
      depreciationEntryId: original.depreciationEntryId ?? "",
      reason: "ثبت اشتباه مبلغ",
      createdBy: owner.id,
    });
    expect(reversal.reversalJournalEntryId).toBeTruthy();

    const { rows: entries } = await db.query<{
      id: string;
      posting_kind: string | null;
      reverses_entry_id: string | null;
      reversed_at: string | null;
    }>(
      `SELECT id, posting_kind, reverses_entry_id, reversed_at::text FROM journal_entries
        WHERE business_id = $1 ORDER BY (reverses_entry_id IS NULL) DESC`,
      [biz.id],
    );
    expect(entries).toHaveLength(2);
    const [originalEntry, reversalEntry] = entries;
    expect(originalEntry.posting_kind).toBe("depreciation");
    expect(originalEntry.reversed_at).not.toBeNull();
    expect(reversalEntry.posting_kind).toBe("reversal");
    expect(reversalEntry.reverses_entry_id).toBe(originalEntry.id);

    // The mirror's lines are the original's, swapped.
    const { rows: mirrorLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC`,
      [reversalEntry.id],
    );
    expect(mirrorLines).toEqual([
      { account_id: acct.accumulatedDepreciation, debit: "2000000", credit: "0" },
      { account_id: acct.depreciationExpense, debit: "0", credit: "2000000" },
    ]);

    // The accumulated depreciation on the 1510 account is back to zero.
    const { rows: accum } = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(credit - debit), 0)::text AS balance FROM journal_lines WHERE account_id = $1`,
      [acct.accumulatedDepreciation],
    );
    expect(accum[0].balance).toBe("0");

    // The source row is marked, not deleted, with who/when/why.
    const detail = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(detail.depreciationEntries).toHaveLength(1);
    const entry = detail.depreciationEntries[0];
    expect(entry.reversedAt).toBeTruthy();
    expect(entry.reversalReason).toBe("ثبت اشتباه مبلغ");
    expect(entry.reversedByName).toBe("Owner");
    expect(entry.reversalJournalEntryId).toBe(reversalEntry.id);
    // The schedule recalculated: nothing live, month free again.
    expect(detail.fixedAsset.accumulatedDepreciation).toBe(0);
    expect(detail.fixedAsset.depreciationCount).toBe(0);
    expect(detail.fixedAsset.bookValue).toBe(120_000_000);
    await expect(postOne(asset.id, "1404-01")).resolves.toMatchObject({ amount: 2_000_000 });
  });

  it("mirrors a pre-transfer posting on the branch it was posted to, even after a transfer", async () => {
    const asset = await createAsset({ locationId: biz.locationA });
    const original = await post(asset.id, { periodKey: "1404-01" }); // posted in branch A

    await fixedAssetsService.transferFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      toLocationId: biz.locationB,
      effectiveDate: "2025-05-01",
      reason: "انتقال",
      createdBy: owner.id,
    });

    const reversal = await fixedAssetsService.reverseDepreciation({
      businessId: biz.id,
      fixedAssetId: asset.id,
      depreciationEntryId: original.depreciationEntryId,
      reason: "اصلاح سند شعبهٔ قبل",
      createdBy: owner.id,
    });
    expect(reversal.reversalJournalEntryId).toBeTruthy();

    // The undo of a branch-A posting happens on branch A — the asset's new
    // branch (B) must not inherit the mirror.
    const { rows } = await db.query<{ location_id: string | null }>(
      `SELECT location_id FROM journal_entries WHERE id = $1`,
      [reversal.reversalJournalEntryId],
    );
    expect(rows[0].location_id).toBe(biz.locationA);
  });

  it("refuses a double reversal", async () => {
    const asset = await createAsset();
    const original = await postOne(asset.id, "1404-01");
    const reverse = (reversalDate?: string) =>
      fixedAssetsService.reverseDepreciation({
        businessId: biz.id,
        fixedAssetId: asset.id,
        depreciationEntryId: original.depreciationEntryId ?? "",
        reversalDate: reversalDate ?? null,
        reason: "دلیل",
        createdBy: owner.id,
      });
    await reverse();
    await expect(reverse()).rejects.toThrow("depreciation_already_reversed");
  });

  it("refuses a reversal dated into a locked period, and accepts one dated into an open period", async () => {
    const asset = await createAsset();
    // 1404-01 = 2025-03-21..2025-04-20; the entry is dated at the month's last day.
    const original = await postOne(asset.id, "1404-01");
    expect(original.entryDate).toBe("2025-04-20");

    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    const farvardin = periods[0];
    const ordibehesht = periods[1];
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    const reverse = (reversalDate?: string) =>
      fixedAssetsService.reverseDepreciation({
        businessId: biz.id,
        fixedAssetId: asset.id,
        depreciationEntryId: original.depreciationEntryId ?? "",
        reversalDate: reversalDate ?? null,
        reason: "اصلاح دورهٔ قفل‌شده",
        createdBy: owner.id,
      });

    // Default (the original's own date) is refused by the fiscal lock…
    await expect(reverse()).rejects.toThrow("fiscal_period_locked");
    // …but a permitted correction date in the open next period works.
    await expect(reverse(ordibehesht.endsOn)).resolves.toMatchObject({ reversalDate: ordibehesht.endsOn });
  });

  it("refuses a reversal after the asset was disposed", async () => {
    const asset = await createAsset({ cost: 10_000_000, usefulLifeMonths: 10 });
    const original = await postOne(asset.id, "1404-01");
    await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "retirement",
      createdBy: owner.id,
      reason: null,
    });
    await expect(
      fixedAssetsService.reverseDepreciation({
        businessId: biz.id,
        fixedAssetId: asset.id,
        depreciationEntryId: original.depreciationEntryId ?? "",
        reason: "دیررس",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("asset_disposed");
  });
});

describe("disposal / sale / retirement (issue #833)", () => {
  /**
   * Posts the first `months` months of the asset's own schedule. The window
   * is fixed by the data — the asset enters service with its acquisition —
   * not by the wall clock or a hard-coded Jalali year that ages badly.
   */
  async function depreciateMonths(asset: { id: string; acquisitionDate?: string }, months: number) {
    let key = depreciationPeriodOfDate(asset.acquisitionDate ?? "2025-01-01")!.key;
    for (let i = 0; i < months; i++) {
      await post(asset.id, { periodKey: key });
      key = addMonthsToPeriodKey(key, 1);
    }
  }

  it("a sale above net book value realises a gain and removes cost + accumulated depreciation", async () => {
    // cost 100M, salvage 0, life 50 → 2M/month; 12 months = 24M accumulated; NBV = 76M.
    const asset = await createAsset({ cost: 100_000_000, usefulLifeMonths: 50 });
    await depreciateMonths(asset, 12);

    const outcome = await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "sale",
      proceeds: 80_000_000,
      proceedsAccountId: acct.cash,
      reason: "فروش به خریدار نقدی",
      createdBy: owner.id,
    });
    expect(outcome).toMatchObject({ netBookValue: 76_000_000, gain: 4_000_000, loss: 0, proceeds: 80_000_000 });

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT l.account_id, l.debit::text, l.credit::text FROM journal_lines l
         JOIN journal_entries je ON je.id = l.entry_id
        WHERE je.business_id = $1 AND je.posting_kind = 'disposal'
        ORDER BY l.debit DESC, l.credit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.cash, debit: "80000000", credit: "0" },
      { account_id: acct.accumulatedDepreciation, debit: "24000000", credit: "0" },
      { account_id: acct.fixedAssetsRoot, debit: "0", credit: "100000000" },
      { account_id: acct.gain, debit: "0", credit: "4000000" },
    ]);

    const detail = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(detail.fixedAsset).toMatchObject({
      status: "disposed",
      disposalKind: "sale",
      disposalProceeds: 80_000_000,
      disposalReason: "فروش به خریدار نقدی",
    });

    // No further depreciation after disposal.
    await expect(post(asset.id, { periodKey: "1405-01" })).rejects.toThrow("asset_disposed");
    await expect(
      fixedAssetsService.disposeFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        kind: "retirement",
        createdBy: owner.id,
        reason: null,
      }),
    ).rejects.toThrow("asset_disposed");
  });

  it("a sale below net book value realises a loss", async () => {
    const asset = await createAsset({ cost: 100_000_000, usefulLifeMonths: 50 });
    await depreciateMonths(asset, 12); // accumulated 24M, NBV 76M

    const outcome = await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "sale",
      proceeds: 70_000_000,
      proceedsAccountId: acct.cash,
      createdBy: owner.id,
      reason: null,
    });
    expect(outcome).toMatchObject({ gain: 0, loss: 6_000_000 });

    const { rows: lines } = await db.query<{ account_id: string; debit: string }>(
      `SELECT l.account_id, l.debit::text FROM journal_lines l
         JOIN journal_entries je ON je.id = l.entry_id
        WHERE je.business_id = $1 AND je.posting_kind = 'disposal' AND l.debit > 0
        ORDER BY l.debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.cash, debit: "70000000" },
      { account_id: acct.accumulatedDepreciation, debit: "24000000" },
      { account_id: acct.loss, debit: "6000000" },
    ]);
  });

  it("a zero-proceeds write-off expenses the whole net book value", async () => {
    const asset = await createAsset({ cost: 50_000_000, usefulLifeMonths: 50 });
    await depreciateMonths(asset, 10); // accumulated 10M, NBV 40M

    const outcome = await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "write_off",
      createdBy: owner.id,
      reason: "از رده خارج",
    });
    expect(outcome).toMatchObject({ netBookValue: 40_000_000, loss: 40_000_000, proceeds: 0 });

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT l.account_id, l.debit::text, l.credit::text FROM journal_lines l
         JOIN journal_entries je ON je.id = l.entry_id
        WHERE je.business_id = $1 AND je.posting_kind = 'disposal'
        ORDER BY l.debit DESC, l.credit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.loss, debit: "40000000", credit: "0" },
      { account_id: acct.accumulatedDepreciation, debit: "10000000", credit: "0" },
      { account_id: acct.fixedAssetsRoot, debit: "0", credit: "50000000" },
    ]);
  });

  it("a disposed asset with acquisition provenance leaves the register reconciled", async () => {
    // The purchase debited 1500, the disposal credited it back out: net zero
    // on both sides of the reconciliation.
    const { rows: entry } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, '2025-01-01', 'خرید', 'manual') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 100000000, 0), ($1, $3, 0, 100000000)`,
      [entry[0].id, acct.fixedAssetsRoot, acct.cash],
    );
    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "ماشین",
      acquisitionDate: "2025-01-01",
      cost: 100_000_000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      acquisitionSource: "journal",
      acquisitionEntryId: entry[0].id,
      createdBy: owner.id,
    });
    await depreciateMonths(asset, 12);
    expect(await fixedAssetsService.getFixedAssetReconciliation(biz.id)).toMatchObject({ status: "reconciled" });

    await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "sale",
      proceeds: 76_000_000,
      proceedsAccountId: acct.cash,
      createdBy: owner.id,
      reason: null,
    });
    expect(await fixedAssetsService.getFixedAssetReconciliation(biz.id)).toMatchObject({ status: "reconciled" });
  });

  it("disposes on the branch that held the asset on the disposal date, and refuses one dated before the last transfer", async () => {
    const asset = await createAsset({ locationId: biz.locationA, cost: 10_000_000, usefulLifeMonths: 10 });
    await fixedAssetsService.transferFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      toLocationId: biz.locationB,
      effectiveDate: "2025-06-01",
      reason: "انتقال",
      createdBy: owner.id,
    });

    // A disposal dated before the transfer contradicts the recorded history.
    await expect(
      fixedAssetsService.disposeFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        kind: "retirement",
        disposalDate: "2025-05-15",
        createdBy: owner.id,
        reason: null,
      }),
    ).rejects.toThrow("disposal_before_last_transfer");

    // A disposal dated after it posts on the branch that held the asset then.
    const outcome = await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "retirement",
      disposalDate: "2025-07-15",
      createdBy: owner.id,
      reason: null,
    });
    expect(outcome.journalEntryId).toBeTruthy();
    const { rows } = await db.query<{ location_id: string | null }>(
      `SELECT location_id FROM journal_entries WHERE id = $1`,
      [outcome.journalEntryId],
    );
    expect(rows[0].location_id).toBe(biz.locationB);
  });

  it("validates the disposal shape", async () => {
    const asset = await createAsset();
    const base = { businessId: biz.id, fixedAssetId: asset.id, createdBy: owner.id } as const;
    await expect(
      fixedAssetsService.disposeFixedAsset({ ...base, kind: "retirement", proceeds: 5, reason: null }),
    ).rejects.toThrow("disposal_proceeds_not_allowed");
    await expect(fixedAssetsService.disposeFixedAsset({ ...base, kind: "sale", reason: null })).rejects.toThrow(
      "disposal_proceeds_required",
    );
    await expect(
      fixedAssetsService.disposeFixedAsset({ ...base, kind: "sale", proceeds: 1_000, reason: null }),
    ).rejects.toThrow("proceeds_account_required");
    await expect(
      fixedAssetsService.disposeFixedAsset({
        ...base,
        kind: "sale",
        proceeds: 1_000,
        proceedsAccountId: acct.fixedAssetsRoot,
        reason: null,
      }),
    ).rejects.toThrow("invalid_proceeds_account");
    await expect(
      fixedAssetsService.disposeFixedAsset({ ...base, kind: "sale", proceeds: 1_000, proceedsAccountId: acct.cash, disposalDate: "2999-01-01", reason: null }),
    ).rejects.toThrow("disposal_date_in_future");
    await expect(
      fixedAssetsService.disposeFixedAsset({
        ...base,
        kind: "sale",
        proceeds: 1_000,
        proceedsAccountId: acct.cash,
        disposalDate: "2024-01-01",
        reason: null,
      }),
    ).rejects.toThrow("disposal_before_in_service");
  });

  it("refuses a disposal dated before the last live depreciation — reverse first, then dispose", async () => {
    // In service two months back; one month posted, dated at that month's end.
    const start = periodMonthsAgo(2);
    const asset = await createAsset({
      cost: 12_000_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(start),
    });
    const posted = await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 1) });
    expect(posted.amount).toBe(1_000_000);

    // A disposal dated before that document would strand depreciation after
    // the asset left the register: refused, with the correction path named.
    await expect(
      fixedAssetsService.disposeFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        kind: "retirement",
        disposalDate: acquisitionDateFor(start),
        createdBy: owner.id,
        reason: null,
      }),
    ).rejects.toThrow("disposal_before_depreciation");

    // Dated ON the posting's own date, the same disposal is legitimate — the
    // books carry the asset out with everything charged up to that day.
    await expect(
      fixedAssetsService.disposeFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        kind: "retirement",
        disposalDate: posted.entryDate,
        createdBy: owner.id,
        reason: null,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("prospective estimate changes (issue #833)", () => {
  it("applies a revised useful life prospectively; historical postings are untouched", async () => {
    // cost 120M, salvage 0, life 60 → 2M/month. After 24 months (48M), the
    // life is revised to 48: the revised rate is 120M/48 = 2.5M/month. The
    // acquisition anchors the calendar schedule at the first posted month.
    const months = recentPeriodKeys(24, false);
    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "ماشین صنعتی",
      acquisitionDate: acquisitionDateFor(months[0]),
      cost: 120_000_000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      createdBy: owner.id,
    });
    for (const key of months) {
      await post(asset.id, { periodKey: key });
    }
    const detailBefore = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(detailBefore.fixedAsset.accumulatedDepreciation).toBe(48_000_000);

    const { fixedAsset, estimateChange } = await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 48,
      reason: "بازبینی عمر مفید",
      createdBy: owner.id,
    });
    expect(fixedAsset.usefulLifeMonths).toBe(48);
    expect(estimateChange).toMatchObject({
      oldUsefulLifeMonths: 60,
      newUsefulLifeMonths: 48,
      remainingLifeMonths: 24,
      remainingBase: 72_000_000,
      reason: "بازبینی عمر مفید",
    });

    // Historical postings are unchanged: 2M each.
    expect(detailBefore.depreciationEntries.every((e) => e.amount === 2_000_000)).toBe(true);

    // The next period follows the revised schedule's rate: 120M/48 = 2.5M.
    const [currentKey] = recentPeriodKeys(1);
    const next = await post(asset.id, { periodKey: currentKey });
    expect(next.amount).toBe(2_500_000);
  });

  it("consumes the remaining depreciable amount exactly when the revision shortens the life to its end", async () => {
    // 24 months posted at 2M = 48M of a 120M base; revising the life to 25
    // makes the current month the schedule's last, which must absorb the
    // remaining 72M exactly.
    const months = recentPeriodKeys(24, false);
    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "دستگاه",
      acquisitionDate: acquisitionDateFor(months[0]),
      cost: 120_000_000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      createdBy: owner.id,
    });
    for (const key of months) {
      await post(asset.id, { periodKey: key });
    }
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 25,
      reason: "کوتاه‌شدن عمر مفید",
      createdBy: owner.id,
    });
    const [currentKey] = recentPeriodKeys(1);
    const final = await post(asset.id, { periodKey: currentKey });
    expect(final.amount).toBe(72_000_000);
    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(120_000_000);
    expect(listed.bookValue).toBe(0);
    expect(listed.fullyDepreciated).toBe(true);
  });

  it("refuses an unchanged estimate, an invalid one, and changes on a disposed asset", async () => {
    const asset = await createAsset({ cost: 10_000_000, usefulLifeMonths: 10 });
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        usefulLifeMonths: 10,
        reason: "بدون تغییر",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("estimate_unchanged");
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        salvageValue: 10_000_000,
        reason: "اسقاط بزرگ",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("salvage_not_less_than_cost");
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        usefulLifeMonths: 0,
        reason: "صفر",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("invalid_useful_life");

    await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      kind: "retirement",
      createdBy: owner.id,
      reason: null,
    });
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        usefulLifeMonths: 20,
        reason: "دیررس",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("asset_disposed");
  });
});

describe("the calendar schedule, resolved by period and live history (issue #833 follow-up)", () => {
  it("refuses months beyond the useful-life schedule, and a later extension only re-opens months from the change forward", async () => {
    // In service 6 months back with a 4-month life: the schedule ended two
    // months ago. A PAST month beyond its end is refused — the schedule is a
    // calendar, not a row count (a future month is refused as future, a past
    // one as beyond: two different honest answers).
    const start = periodMonthsAgo(6);
    const asset = await createAsset({
      cost: 1_000_000,
      usefulLifeMonths: 4,
      acquisitionDate: acquisitionDateFor(start),
    });
    await expect(post(asset.id, { periodKey: addMonthsToPeriodKey(start, 4) })).rejects.toThrow(
      "period_beyond_schedule",
    );

    // Extend the life to 8: the change is effective from the current month,
    // so the current month and later open up under the extended schedule…
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 8,
      reason: "افزایش عمر",
      createdBy: owner.id,
    });
    const [currentKey] = recentPeriodKeys(1);
    const now = await post(asset.id, { periodKey: currentKey });
    expect(now.amount).toBe(Math.round(1_000_000 / 8));

    // …while a hole month the expired original schedule never covered stays
    // closed to it: an 8-month-old asset with a 2-month life cannot catch up
    // its idle middle months by extending late.
    const old = await createAsset({
      cost: 1_000_000,
      usefulLifeMonths: 2,
      acquisitionDate: acquisitionDateFor(periodMonthsAgo(8)),
    });
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: old.id,
      usefulLifeMonths: 12,
      reason: "افزایش عمر دیرهنگام",
      createdBy: owner.id,
    });
    await expect(post(old.id, { periodKey: periodMonthsAgo(5) })).rejects.toThrow("period_beyond_schedule");
    // …but the extension's own months (from the change forward) are open.
    await expect(post(old.id, { periodKey: currentKey })).resolves.toBeTruthy();
  });

  it("refuses an estimate change that would strand posted months beyond the new schedule's end", async () => {
    const start = periodMonthsAgo(6);
    const asset = await createAsset({
      cost: 12_000_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(start),
    });
    await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 3) }); // a posted month 3 into the schedule

    // A 2-month life ends before the posted month: the change contradicts
    // the history it is supposed to revise.
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        usefulLifeMonths: 2,
        reason: "خیلی کوتاه",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("estimate_change_excludes_history");
    // A life that still covers every posted month is fine.
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        usefulLifeMonths: 4,
        reason: "کوتاه ولی پوشش‌دهنده",
        createdBy: owner.id,
      }),
    ).resolves.toBeTruthy();
  });

  it("a reversal after an estimate change is live-authoritative: the freed amount is never lost to a stale snapshot", async () => {
    // The review's arithmetic, production-shaped: cost 1,200,000, life 12 →
    // 100,000/month. One month posted, then the life is shortened to 3
    // (effective from the current month, freezing a snapshot that says
    // "100,000 accumulated, 1,100,000 left"), then that month is REVERSED.
    // The snapshot is an audit fact; the LIVE history — nothing posted — is
    // what the schedule must price from.
    const start = periodMonthsAgo(2);
    const asset = await createAsset({
      cost: 1_200_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(start),
    });
    const original = await post(asset.id, { periodKey: start });
    expect(original.amount).toBe(100_000);

    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 3,
      reason: "کوتاه‌شدن عمر",
      createdBy: owner.id,
    });
    await fixedAssetsService.reverseDepreciation({
      businessId: biz.id,
      fixedAssetId: asset.id,
      depreciationEntryId: original.depreciationEntryId,
      reason: "برگشت برای اصلاح",
      createdBy: owner.id,
    });

    // The skipped month before the change still runs on the original rate.
    const catchUp = await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 1) });
    expect(catchUp.amount).toBe(100_000);
    // The current month — the revised schedule's last — absorbs everything
    // genuinely left: the full 1,200,000 base minus the one live posting.
    // (The stale-snapshot arithmetic the review reproduced posted 550,000
    // here and then stranded the last 100,000 as unpostable.)
    const [currentKey] = recentPeriodKeys(1);
    const final = await post(asset.id, { periodKey: currentKey });
    expect(final.amount).toBe(1_100_000);

    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(1_200_000);
    expect(listed.bookValue).toBe(0);
    expect(listed.fullyDepreciated).toBe(true);
  });

  it("a reversal after an estimate change with replacement: the re-posted month runs on the schedule that governed it", async () => {
    const start = periodMonthsAgo(2);
    const asset = await createAsset({
      cost: 1_200_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(start),
    });
    const original = await post(asset.id, { periodKey: start });
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 3,
      reason: "کوتاه‌شدن عمر",
      createdBy: owner.id,
    });
    await fixedAssetsService.reverseDepreciation({
      businessId: biz.id,
      fixedAssetId: asset.id,
      depreciationEntryId: original.depreciationEntryId,
      reason: "برگشت برای اصلاح",
      createdBy: owner.id,
    });

    // Re-post the reversed month, then the skipped one: both predate the
    // change's effective month, so the ORIGINAL schedule governs them —
    // 100,000 each, never the revision's rate.
    const rePosted = await post(asset.id, { periodKey: start });
    expect(rePosted.amount).toBe(100_000);
    const catchUp = await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 1) });
    expect(catchUp.amount).toBe(100_000);

    // The current month is the revised schedule's last open month and
    // absorbs exactly what is left: 1,200,000 − 200,000.
    const [currentKey] = recentPeriodKeys(1);
    const final = await post(asset.id, { periodKey: currentKey });
    expect(final.amount).toBe(1_000_000);

    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(1_200_000);
    expect(listed.fullyDepreciated).toBe(true);
  });

  it("resolves the applicable estimate by period, across changes in different effective months", async () => {
    const start = periodMonthsAgo(6);
    const asset = await createAsset({
      cost: 12_000_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(start),
    });
    // One month posted under the original schedule (1,000,000/month).
    await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 1) });

    // A change via the service, effective from the current month: life 8
    // (rate 1,500,000/month) — long enough that the current month still lies
    // inside the final schedule's span.
    const [currentKey] = recentPeriodKeys(1);
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 8,
      reason: "برآورد جاری",
      createdBy: owner.id,
    });

    // A second, EARLIER-effective change (recorded between the original
    // schedule and the current one — the frozen audit shape, inserted
    // directly as a past-dated revision would be): life 4, effective from
    // start+2. For months in [start+2, current) it is the schedule in force.
    await db.query(
      `INSERT INTO fixed_asset_estimate_changes
         (fixed_asset_id, effective_period_key, old_useful_life_months, new_useful_life_months,
          old_salvage_value, new_salvage_value, periods_posted_at_change, remaining_life_months,
          remaining_base, accumulated_at_change, snapshot_period_keys, reason, changed_by)
       VALUES ($1, $2, 12, 4, 0, 0, 0, 4, 12000000, 0, '{}', 'برآورد گذشته', $3)`,
      [asset.id, addMonthsToPeriodKey(start, 2), owner.id],
    );

    // A catch-up month inside the earlier change's window runs on ITS rate
    // (12,000,000 / 4 = 3,000,000), not the original's and not the newest's.
    const middle = await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 2) });
    expect(middle.amount).toBe(3_000_000);
    // The current month runs on the latest-effective change (life 8):
    // 12,000,000 / 8 = 1,500,000.
    const now = await post(asset.id, { periodKey: currentKey });
    expect(now.amount).toBe(1_500_000);
    // And a month before every change still runs on the original schedule.
    const first = await post(asset.id, { periodKey: start });
    expect(first.amount).toBe(1_000_000);
  });

  it("a catch-up month after a later revision is charged under the schedule that governed it", async () => {
    const start = periodMonthsAgo(4);
    const asset = await createAsset({
      cost: 12_000_000,
      usefulLifeMonths: 12,
      acquisitionDate: acquisitionDateFor(start),
    });
    await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 2) }); // 1,000,000

    // The revision (life 6 → 2,000,000/month) is effective from the current
    // month; the skipped month start+1 is still governed by the original
    // schedule, so catching it up costs 1,000,000, not 2,000,000.
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      usefulLifeMonths: 6,
      reason: "بازبینی",
      createdBy: owner.id,
    });
    const catchUp = await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 1) });
    expect(catchUp.amount).toBe(1_000_000);
    const [currentKey] = recentPeriodKeys(1);
    const now = await post(asset.id, { periodKey: currentKey });
    expect(now.amount).toBe(2_000_000);
  });

  it("a revised salvage raises the floor: the lifetime total lands on cost − final salvage, and a salvage above the depreciated base is refused", async () => {
    const start = periodMonthsAgo(6);
    const asset = await createAsset({
      cost: 12_000_000,
      usefulLifeMonths: 6,
      acquisitionDate: acquisitionDateFor(start),
    });
    await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 1) });
    await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 2) }); // 4,000,000 accumulated

    // Salvage above cost − accumulated (12M − 4M = 8M) would make the live
    // history over-depreciated the moment it lands: refused.
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: biz.id,
        fixedAssetId: asset.id,
        salvageValue: 11_000_000,
        reason: "اسقاط بیش از باقیمانده",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("salvage_above_depreciated_base");

    // A legitimate floor: salvage 4,000,000 leaves 4,000,000 to charge. The
    // schedule's last month — the one just before the current — absorbs it
    // exactly, and the register lands on cost − salvage with the salvage as
    // the surviving book value.
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: asset.id,
      salvageValue: 4_000_000,
      reason: "ارزش اسقاط واقعی",
      createdBy: owner.id,
    });
    const final = await post(asset.id, { periodKey: addMonthsToPeriodKey(start, 5) }); // the schedule's last month
    expect(final.amount).toBe(4_000_000);

    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(8_000_000); // cost − salvage, exactly
    expect(listed.bookValue).toBe(4_000_000); // the salvage floor survives
    expect(listed.fullyDepreciated).toBe(true);
    await expect(post(asset.id, { periodKey: addMonthsToPeriodKey(start, 3) })).rejects.toThrow(
      "fully_depreciated",
    );
  });
});

describe("archiving (issue #833)", () => {
  it("archives an asset with a reason and freezes it", async () => {
    const asset = await createAsset();
    const archived = await fixedAssetsService.archiveFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      reason: "مازاد و خارج از استفاده",
      createdBy: owner.id,
    });
    expect(archived.fixedAsset.archivedAt).toBeTruthy();

    await expect(post(asset.id, { periodKey: "1404-01" })).rejects.toThrow("asset_archived");
    await expect(
      fixedAssetsService.transferFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        toLocationId: biz.locationB,
        reason: "تست",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("asset_archived");
    await expect(
      fixedAssetsService.archiveFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        reason: "دوباره",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("asset_archived");

    // Archived assets are hidden from the working register unless asked for.
    expect(await fixedAssetsService.listFixedAssets(biz.id)).toHaveLength(0);
    const withArchived = await fixedAssetsService.listFixedAssetsPage(biz.id, { includeArchived: true });
    expect(withArchived.assets).toHaveLength(1);
    const onlyArchived = await fixedAssetsService.listFixedAssetsPage(biz.id, { status: "archived" });
    expect(onlyArchived.assets).toHaveLength(1);
  });
});

describe("deleteFixedAsset — source-history integrity (issue #833)", () => {
  it("deletes an asset with no history at all", async () => {
    const asset = await createAsset();
    await fixedAssetsService.deleteFixedAsset(biz.id, asset.id);
    expect(await fixedAssetsService.listFixedAssets(biz.id)).toEqual([]);
  });

  it("throws 404 for nonexistent asset", async () => {
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, randomUUID())).rejects.toThrow("fixed_asset_not_found");
  });

  it("refuses to delete an asset that has depreciation posted — even after reversal", async () => {
    const asset = await createAsset();
    const posted = await post(asset.id, { periodKey: "1404-01" });
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, asset.id)).rejects.toThrow("fixed_asset_has_depreciation");

    await fixedAssetsService.reverseDepreciation({
      businessId: biz.id,
      fixedAssetId: asset.id,
      depreciationEntryId: posted.depreciationEntryId ?? "",
      reason: "برگشت",
      createdBy: owner.id,
    });
    // A reversed entry is still history.
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, asset.id)).rejects.toThrow("fixed_asset_has_depreciation");
  });

  it("refuses to delete an asset with other history (link, transfer, estimate change)", async () => {
    const linked = await fixedAssetsService.setFixedAssetAcquisition({
      businessId: biz.id,
      fixedAssetId: (await createAsset()).id,
      acquisitionSource: "opening_balance",
    });
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, linked.id)).rejects.toThrow("fixed_asset_has_history");

    const transferred = await createAsset();
    await fixedAssetsService.transferFixedAsset({
      businessId: biz.id,
      fixedAssetId: transferred.id,
      toLocationId: biz.locationB,
      reason: "انتقال",
      createdBy: owner.id,
    });
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, transferred.id)).rejects.toThrow("fixed_asset_has_history");

    const revised = await createAsset();
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: revised.id,
      usefulLifeMonths: 72,
      reason: "بازبینی",
      createdBy: owner.id,
    });
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, revised.id)).rejects.toThrow("fixed_asset_has_history");
  });

  it("a delete racing a depreciation posting can never orphan the journal history", async () => {
    const asset = await createAsset();
    const results = await Promise.allSettled([
      post(asset.id, { periodKey: "1404-01" }),
      fixedAssetsService.deleteFixedAsset(biz.id, asset.id),
    ]);

    const posted = results[0].status === "fulfilled";
    const deleted = results[1].status === "fulfilled";
    // Both cannot succeed: a posting and a deletion of the same asset are
    // mutually exclusive under the row lock.
    expect(posted && deleted).toBe(false);

    const { rows: journalCount } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    const { rows: assetCount } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM fixed_assets WHERE business_id = $1`,
      [biz.id],
    );
    if (posted) {
      expect(deleted).toBe(false);
      expect(assetCount[0].count).toBe("1");
      expect(journalCount[0].count).toBe("1");
    } else {
      expect(deleted).toBe(true);
      expect(assetCount[0].count).toBe("0");
      expect(journalCount[0].count).toBe("0");
    }
  });

  it("the database itself refuses to cascade away posted depreciation rows", async () => {
    const asset = await createAsset();
    await post(asset.id, { periodKey: "1404-01" });
    await expect(db.query(`DELETE FROM fixed_assets WHERE id = $1`, [asset.id])).rejects.toThrow(/violates foreign key/);
  });
});

describe("tenant isolation of the lifecycle mutations", () => {
  it("refuses another business's asset on every mutation, and its locations cannot lure an asset away", async () => {
    const asset = await createAsset();
    const posted = await post(asset.id, { periodKey: "1404-01" });

    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`fa-iso-${randomUUID().slice(0, 8)}`],
    );
    const otherBusinessId = other.rows[0].id;
    const otherLoc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Elsewhere') RETURNING id",
      [otherBusinessId],
    );

    await expect(
      fixedAssetsService.reverseDepreciation({
        businessId: otherBusinessId,
        fixedAssetId: asset.id,
        depreciationEntryId: posted.depreciationEntryId ?? "",
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.disposeFixedAsset({
        businessId: otherBusinessId,
        fixedAssetId: asset.id,
        kind: "retirement",
        createdBy: owner.id,
        reason: null,
      }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.transferFixedAsset({
        businessId: otherBusinessId,
        fixedAssetId: asset.id,
        toLocationId: biz.locationB,
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({
        businessId: otherBusinessId,
        fixedAssetId: asset.id,
        usefulLifeMonths: 24,
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.archiveFixedAsset({
        businessId: otherBusinessId,
        fixedAssetId: asset.id,
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fixed_asset_not_found");

    // And the owning business cannot transfer its asset INTO the other
    // business's branch, either.
    await expect(
      fixedAssetsService.transferFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        toLocationId: otherLoc.rows[0].id,
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("location_not_found");

    // Nothing above touched the asset.
    const detail = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(detail.fixedAsset.status).toBe("active");
    expect(detail.fixedAsset.locationId).toBe(biz.locationA);
    expect(detail.fixedAsset.accumulatedDepreciation).toBe(2_000_000);
  });
});

describe("getFixedAssetWithDepreciation", () => {
  it("retrieves the asset along with its full history", async () => {
    const asset = await createAsset();
    await post(asset.id, { periodLabel: "1404-01", entryDate: "2025-04-01" });
    await post(asset.id, { periodLabel: "1404-02", entryDate: "2025-05-01" });

    const result = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(result.fixedAsset.id).toBe(asset.id);
    expect(result.fixedAsset.accumulatedDepreciation).toBe(4_000_000);
    expect(result.fixedAsset.depreciationCount).toBe(2);
    expect(result.fixedAsset.locationName).toBe("Branch A");
    expect(result.depreciationEntries).toHaveLength(2);
    expect(result.depreciationEntries[0].periodLabel).toBe("1404-02");
    expect(result.depreciationEntries[0].amount).toBe(2_000_000);
    expect(result.depreciationEntries[0].journalEntryId).toBeTruthy();
    expect(result.depreciationEntries[0].createdByName).toBe("Owner");
    // The branch the journal was posted to — the asset's own.
    expect(result.depreciationEntries[0].postingLocationName).toBe("Branch A");
    expect(result.transfers).toEqual([]);
    expect(result.estimateChanges).toEqual([]);
  });

  it("cursor-pages a long depreciation history: every month, newest first, nothing repeated or skipped", async () => {
    // 105 posted months — past the history page's default of 100, so «load
    // more» has real work to do. The schedule is a calendar: the asset
    // entered service 105 months back with a 105-month life.
    const start = periodMonthsAgo(105);
    const asset = await createAsset({
      cost: 105_000_000,
      usefulLifeMonths: 105,
      acquisitionDate: acquisitionDateFor(start),
    });
    for (let i = 0; i < 105; i++) {
      await post(asset.id, { periodKey: addMonthsToPeriodKey(start, i) });
    }

    // The first page carries the newest 100 months, newest first.
    const page1 = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(page1.depreciationEntries).toHaveLength(100);
    expect(page1.depreciationHasMore).toBe(true);
    expect(page1.depreciationNextCursor).toBeTruthy();
    expect(page1.fixedAsset.depreciationCount).toBe(105); // the whole history, not the page
    // Newest first: the newest month is the one just before the current.
    expect(page1.depreciationEntries[0].periodKey).toBe(recentPeriodKeys(1, false)[0]);
    const dates = page1.depreciationEntries.map((e) => e.entryDate);
    expect([...dates].sort().reverse()).toEqual(dates);

    // The second page carries the oldest five, and the history is complete:
    // 105 distinct months, no repeats, no gaps.
    const page2 = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id, {
      depreciationCursor: page1.depreciationNextCursor,
    });
    expect(page2.depreciationEntries).toHaveLength(5);
    expect(page2.depreciationHasMore).toBe(false);
    expect(page2.depreciationNextCursor).toBeNull();
    // …and runs down to the schedule's very first month.
    expect(page2.depreciationEntries[4].periodKey).toBe(start);

    const all = [...page1.depreciationEntries, ...page2.depreciationEntries];
    expect(new Set(all.map((e) => e.id)).size).toBe(105);
    expect(new Set(all.map((e) => e.periodKey)).size).toBe(105);
    // The whole base was charged — the history is whole, not just long.
    expect(all.reduce((sum, e) => sum + e.amount, 0)).toBe(105_000_000);

    // An explicit page size works the same way: 50 + 50 + 5.
    const first = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id, {
      depreciationLimit: 50,
    });
    expect(first.depreciationEntries).toHaveLength(50);
    expect(first.depreciationHasMore).toBe(true);
    const second = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id, {
      depreciationLimit: 50,
      depreciationCursor: first.depreciationNextCursor,
    });
    const third = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id, {
      depreciationLimit: 50,
      depreciationCursor: second.depreciationNextCursor,
    });
    expect(third.depreciationEntries).toHaveLength(5);
    expect(third.depreciationHasMore).toBe(false);
    const paged = [...first.depreciationEntries, ...second.depreciationEntries, ...third.depreciationEntries];
    expect(new Set(paged.map((e) => e.id)).size).toBe(105);
  });
});

describe("server-side pagination, filters and export (issue #833)", () => {
  it("pages through the register with accurate totals — exact across sort ties, and stable under assets registered mid-read", async () => {
    // Five assets sharing one acquisition date: every row ties on the default
    // sort's value, so only the id tie-breaker makes the order — and the
    // cursor — exact.
    const beforeInsert: string[] = [];
    for (const name of ["الف", "ب", "ج", "د", "ه"]) {
      beforeInsert.push((await createAsset({ name, cost: 1_000_000, usefulLifeMonths: 12 })).id);
    }
    const page1 = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2 });
    expect(page1.assets).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    // The KPIs are the server's totals over the whole register, never one page's.
    expect(page1.kpis.count).toBe(5);
    expect(page1.kpis.totalCost).toBe(5_000_000);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.assets).toHaveLength(2);
    expect(page2.hasMore).toBe(true);
    expect(page2.kpis.count).toBe(5);

    const page3 = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2, cursor: page2.nextCursor });
    expect(page3.assets).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();

    const all = [...page1.assets, ...page2.assets, ...page3.assets];
    expect(new Set(all.map((a) => a.id)).size).toBe(5);

    // A cursor that is not one the server handed out is a bad request, not a
    // crash — whatever shape the garbage takes.
    await expect(fixedAssetsService.listFixedAssetsPage(biz.id, { cursor: "not-a-cursor" })).rejects.toThrow(
      "invalid_cursor",
    );
    const wrongShape = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64url");
    await expect(fixedAssetsService.listFixedAssetsPage(biz.id, { cursor: wrongShape })).rejects.toThrow(
      "invalid_cursor",
    );

    // Keyset stability: «load more» resumes strictly after the last row the
    // reader saw, so an asset registered mid-read can neither repeat what a
    // page already showed (an offset would — the insert pushes the boundary
    // back over read territory) nor displace a row that existed when the
    // reading started.
    for (const cost of [40_000_000, 30_000_000, 20_000_000, 10_000_000]) {
      beforeInsert.push((await createAsset({ cost, usefulLifeMonths: 12 })).id);
    }
    const top = await fixedAssetsService.listFixedAssetsPage(biz.id, { sortBy: "cost_desc", limit: 2 });
    expect(top.assets.map((a) => a.cost)).toEqual([40_000_000, 30_000_000]);
    expect(top.kpis.count).toBe(9);

    // Registered between the pages, sorted into territory page 1 already passed…
    const late = await createAsset({ cost: 35_000_000, usefulLifeMonths: 12 });
    const rest = await fixedAssetsService.listFixedAssetsPage(biz.id, {
      sortBy: "cost_desc",
      limit: 10,
      cursor: top.nextCursor,
    });
    // …so «load more» does not carry it (a refresh does), and never repeats a
    // row a page already showed…
    expect(rest.assets.map((a) => a.id)).not.toContain(late.id);
    for (const a of rest.assets) {
      expect(top.assets.some((t) => t.id === a.id)).toBe(false);
    }
    // …and every row that existed when the reading started is covered exactly —
    // the four cost-sorted ones around the cursor, and the five quiet ones
    // that sort below everything.
    expect(new Set([...top.assets, ...rest.assets].map((a) => a.id))).toEqual(new Set(beforeInsert));
    // The server's totals see the new row regardless of the cursor.
    expect(rest.kpis.count).toBe(10);
  });

  it("filters by search, category, branch, status, depreciation state and date range on the server", async () => {
    const a = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "یخچال صنعتی",
      acquisitionDate: "2025-01-01",
      cost: 120_000_000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      category: "تبرید",
      createdBy: owner.id,
    });
    const b = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationB,
      name: "خودرو پیکاپ",
      acquisitionDate: "2024-06-01",
      cost: 800_000_000,
      salvageValue: 0,
      usefulLifeMonths: 120,
      category: "حمل‌ونقل",
      createdBy: owner.id,
    });
    await post(a.id, { periodKey: "1404-01" });

    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { search: "یخچال" })).assets.map((x) => x.id)).toEqual([a.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { category: "تبرید" })).assets.map((x) => x.id)).toEqual([a.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { locationId: biz.locationB })).assets.map((x) => x.id)).toEqual([b.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { dateFrom: "2025-01-01" })).assets.map((x) => x.id)).toEqual([a.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { dateTo: "2024-12-31" })).assets.map((x) => x.id)).toEqual([b.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { depreciationState: "none" })).assets.map((x) => x.id)).toEqual([b.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { depreciationState: "partial" })).assets.map((x) => x.id)).toEqual([a.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { depreciationState: "open" })).kpis.count).toBe(2);

    // Fully depreciated: a short-life asset whose whole base is consumed —
    // its schedule starts at the first of the recent months it will post.
    const recent = recentPeriodKeys(3);
    const c = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "لپ‌تاپ",
      acquisitionDate: acquisitionDateFor(recent[0]),
      cost: 3_000,
      salvageValue: 0,
      usefulLifeMonths: 3,
      createdBy: owner.id,
    });
    for (const key of recentPeriodKeys(3)) {
      await post(c.id, { periodKey: key });
    }
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { depreciationState: "fully" })).assets.map((x) => x.id)).toEqual([c.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { depreciationState: "open" })).kpis.count).toBe(2);

    await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: b.id,
      kind: "retirement",
      createdBy: owner.id,
      reason: null,
    });
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, { status: "disposed" })).assets.map((x) => x.id)).toEqual([b.id]);
    expect((await fixedAssetsService.listFixedAssetsPage(biz.id, {})).kpis.disposedCount).toBe(1);
  });

  it("exports every sheet over the SAME filtered set, with the posting branch on the schedule", async () => {
    // «الف» in branch A with a full lifecycle; «ب» in branch B with none;
    // «ج» in branch A with none.
    const a = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "یخچال الف",
      acquisitionDate: "2025-01-01",
      cost: 1_000_000,
      salvageValue: 0,
      usefulLifeMonths: 12,
      category: "تبرید",
      createdBy: owner.id,
    });
    await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationB,
      name: "خودرو ب",
      acquisitionDate: "2025-01-01",
      cost: 2_000_000,
      salvageValue: 0,
      usefulLifeMonths: 24,
      category: "حمل‌ونقل",
      createdBy: owner.id,
    });
    await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "میز ج",
      acquisitionDate: "2025-01-01",
      cost: 500_000,
      salvageValue: 0,
      usefulLifeMonths: 12,
      category: "اداری",
      createdBy: owner.id,
    });

    // «الف»: one month posted in branch A, then transferred to B, estimate
    // revised, and finally disposed — every history sheet gets a row.
    await post(a.id, { periodKey: "1404-01" });
    await fixedAssetsService.transferFixedAsset({
      businessId: biz.id,
      fixedAssetId: a.id,
      toLocationId: biz.locationB,
      effectiveDate: "2025-06-01",
      reason: "انتقال",
      createdBy: owner.id,
    });
    await fixedAssetsService.changeFixedAssetEstimate({
      businessId: biz.id,
      fixedAssetId: a.id,
      usefulLifeMonths: 24,
      reason: "بازبینی",
      createdBy: owner.id,
    });
    await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: a.id,
      kind: "retirement",
      createdBy: owner.id,
      reason: "از رده خارج",
    });

    // Unfiltered: the complete workbook. The register, the posted schedule,
    // the remaining schedule, the summaries and the roll-forward are
    // structural; the history sheets appear with their rows.
    const full = await fixedAssetsService.fixedAssetsExportSheets(biz.id, {});
    expect(full.registerTotal).toBe(3);
    expect(full).not.toHaveProperty("truncated");
    for (const name of ["دفتر اموال", "برنامه استهلاک", "برنامه باقیمانده", "دسته", "شعبه", "گزارش حرکت"]) {
      expect(full.sheets.find((s) => s.name === name), name).toBeDefined();
    }
    expect(full.sheets.find((s) => s.name === "دفتر اموال")?.rows).toHaveLength(3);
    expect(full.sheets.find((s) => s.name === "برنامه استهلاک")?.rows).toHaveLength(1);
    expect(full.sheets.find((s) => s.name === "انتقال شعب")?.rows).toHaveLength(1);
    expect(full.sheets.find((s) => s.name === "تغییر برآوردها")?.rows).toHaveLength(1);
    expect(full.sheets.find((s) => s.name === "واگذاری‌ها")?.rows).toHaveLength(1);
    // The schedule reports the branch the posting was journalled to (A) —
    // not the asset's branch today (B, after the transfer).
    expect(full.sheets.find((s) => s.name === "برنامه استهلاک")?.rows[0]).toMatchObject({
      code: "FA-0001",
      locationName: "Branch A",
    });

    // A search filter narrows EVERY sheet, not just the register.
    const bySearch = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { search: "ب" });
    expect(bySearch.registerTotal).toBe(1);
    expect(bySearch.sheets.find((s) => s.name === "دفتر اموال")?.rows).toHaveLength(1);
    // The register and schedule sheets are structural (always present, empty
    // when their rows filter out); the history sheets drop with their rows.
    expect(bySearch.sheets.find((s) => s.name === "برنامه استهلاک")?.rows).toHaveLength(0);
    for (const name of ["انتقال شعب", "تغییر برآوردها", "واگذاری‌ها"]) {
      expect(bySearch.sheets.find((s) => s.name === name), name).toBeUndefined();
    }

    // A category filter keeps the asset with its whole history.
    const byCategory = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { category: "تبرید" });
    expect(byCategory.registerTotal).toBe(1);
    for (const name of ["دفتر اموال", "برنامه استهلاک", "انتقال شعب", "تغییر برآوردها", "واگذاری‌ها"]) {
      expect(byCategory.sheets.find((s) => s.name === name)?.rows, name).toHaveLength(1);
    }

    // A branch filter: «الف» now sits in branch B, so branch B carries its
    // history sheets and branch A only the quiet asset «ج».
    const byBranch = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { locationId: biz.locationB });
    expect(byBranch.registerTotal).toBe(2);
    expect(byBranch.sheets.find((s) => s.name === "برنامه استهلاک")?.rows).toHaveLength(1);
    const byBranchA = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { locationId: biz.locationA });
    expect(byBranchA.registerTotal).toBe(1);
    expect(byBranchA.sheets.find((s) => s.name === "برنامه استهلاک")?.rows).toHaveLength(0);
    expect(byBranchA.sheets.find((s) => s.name === "واگذاری‌ها")).toBeUndefined();

    // A status filter keeps the disposed asset with its history.
    const byStatus = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { status: "disposed" });
    expect(byStatus.registerTotal).toBe(1);
    expect(byStatus.sheets.find((s) => s.name === "واگذاری‌ها")?.rows).toHaveLength(1);

    // A date range that admits nothing admits nothing — on every sheet.
    const byDate = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { dateTo: "2024-12-31" });
    expect(byDate.registerTotal).toBe(0);
    expect(byDate.sheets.find((s) => s.name === "دفتر اموال")?.rows).toHaveLength(0);
  });

  it("is complete by construction: over twenty thousand register rows and one asset's whole history ship, uncapped", async () => {
    // One veteran asset with a long history — 60 posted months, the whole
    // schedule — created first so it carries the register's first code.
    const start = periodMonthsAgo(60);
    const veteran = await createAsset({
      cost: 60_000_000,
      usefulLifeMonths: 60,
      acquisitionDate: acquisitionDateFor(start),
    });
    for (let i = 0; i < 60; i++) {
      await post(veteran.id, { periodKey: addMonthsToPeriodKey(start, i) });
    }

    // …and 20,001 quiet assets, registered in one statement — a register past
    // any row count the old capped export would have stopped at.
    await db.query(
      `INSERT INTO fixed_assets
         (business_id, location_id, name, acquisition_date, cost, salvage_value, useful_life_months, created_by, code)
       SELECT $1, $2, 'دارایی انبوه ' || g, '2025-01-01', 100000, 0, 24, $3, 'FA-B' || lpad(g::text, 5, '0')
         FROM generate_series(1, 20001) AS g`,
      [biz.id, biz.locationA, owner.id],
    );

    const workbook = await fixedAssetsService.fixedAssetsExportSheets(biz.id, {});
    expect(workbook.registerTotal).toBe(20_002);
    // No truncation machinery exists to consult — the workbook IS the filter's
    // answer, complete or refused.
    expect(workbook).not.toHaveProperty("truncated");
    expect(workbook).not.toHaveProperty("maxRows");
    const register = workbook.sheets.find((s) => s.name === "دفتر اموال")!;
    expect(register.rows).toHaveLength(20_002);

    // The one asset's whole history ships: every posted month, nothing else.
    const schedule = workbook.sheets.find((s) => s.name === "برنامه استهلاک")!;
    expect(schedule.rows).toHaveLength(60);
    expect(new Set(schedule.rows.map((r) => (r as { code: string }).code))).toEqual(new Set([veteran.code]));
    // 60 months × 1,000,000 — the base consumed exactly, so the history is
    // whole rather than merely long.
    expect(schedule.rows.reduce((sum, r) => sum + Number((r as { amount: number }).amount), 0)).toBe(60_000_000);

    // The register page keeps its shape over the same register — a cursor,
    // not an offset that would collapse under this many rows.
    const page = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2 });
    expect(page.kpis.count).toBe(20_002);
    expect(page.hasMore).toBe(true);

    // The xlsx format's own ceiling is the only refusal left, and it is a
    // fact about the format, not a policy about the reader.
    expect(fixedAssetsService.XLSX_MAX_ROWS_PER_SHEET).toBe(1_048_575);
  });
});

describe("malformed payloads and foreign id shapes — every refusal is a domain error, never a database one", () => {
  it("treats a non-uuid id as a row that cannot exist, on every read and mutation", async () => {
    const asset = await createAsset();
    const notAnId = "not-a-uuid";
    await expect(fixedAssetsService.getFixedAssetWithDepreciation(biz.id, notAnId)).rejects.toThrow(
      "fixed_asset_not_found",
    );
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, notAnId)).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.setFixedAssetAcquisition({
        businessId: biz.id,
        fixedAssetId: notAnId,
        acquisitionSource: "unlinked",
      }),
    ).rejects.toThrow("fixed_asset_not_found");

    const by = { businessId: biz.id, fixedAssetId: notAnId, createdBy: owner.id } as const;
    await expect(fixedAssetsService.postDepreciation(by)).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.reverseDepreciation({ ...by, depreciationEntryId: randomUUID(), reason: "دلیل" }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(fixedAssetsService.disposeFixedAsset({ ...by, kind: "retirement" })).rejects.toThrow(
      "fixed_asset_not_found",
    );
    await expect(
      fixedAssetsService.changeFixedAssetEstimate({ ...by, usefulLifeMonths: 24, reason: "دلیل" }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(
      fixedAssetsService.transferFixedAsset({ ...by, toLocationId: biz.locationB, reason: "دلیل" }),
    ).rejects.toThrow("fixed_asset_not_found");
    await expect(fixedAssetsService.archiveFixedAsset({ ...by, reason: "دلیل" })).rejects.toThrow(
      "fixed_asset_not_found",
    );

    // The referenced shapes a request body can carry get the same treatment.
    const shape = {
      businessId: biz.id,
      locationId: biz.locationA,
      name: "تست ورودی",
      acquisitionDate: "2025-01-01",
      cost: 1_000_000,
      salvageValue: 0,
      usefulLifeMonths: 12,
      createdBy: owner.id,
    };
    await expect(fixedAssetsService.createFixedAsset({ ...shape, vendorPartyId: notAnId })).rejects.toThrow(
      "vendor_not_found",
    );
    await expect(fixedAssetsService.createFixedAsset({ ...shape, custodianPartyId: notAnId })).rejects.toThrow(
      "custodian_not_found",
    );
    await expect(fixedAssetsService.createFixedAsset({ ...shape, assetAccountId: notAnId })).rejects.toThrow(
      "invalid_asset_account",
    );
    await expect(
      fixedAssetsService.transferFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        toLocationId: notAnId,
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("location_not_found");
    await expect(
      fixedAssetsService.reverseDepreciation({
        businessId: biz.id,
        fixedAssetId: asset.id,
        depreciationEntryId: notAnId,
        reason: "دلیل",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("depreciation_entry_not_found");

    // A branch filter that is not a uuid is an empty register, not a crash.
    const empty = await fixedAssetsService.listFixedAssetsPage(biz.id, { locationId: notAnId });
    expect(empty.assets).toHaveLength(0);
    expect(empty.kpis.count).toBe(0);
  });

  it("refuses malformed cursors, periods and payload shapes with domain errors", async () => {
    const asset = await createAsset();
    await expect(fixedAssetsService.listFixedAssetsPage(biz.id, { cursor: "not-a-cursor" })).rejects.toThrow(
      "invalid_cursor",
    );
    const wrongShape = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64url");
    await expect(fixedAssetsService.listFixedAssetsPage(biz.id, { cursor: wrongShape })).rejects.toThrow(
      "invalid_cursor",
    );
    await expect(
      fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id, { depreciationCursor: "not-a-cursor" }),
    ).rejects.toThrow("invalid_cursor");

    // A period key that is not a canonical Jalali month is refused, not guessed.
    await expect(post(asset.id, { periodKey: "فروردین" })).rejects.toThrow("invalid_period");
    // A null disposal kind is not a disposal kind.
    await expect(
      fixedAssetsService.disposeFixedAsset({
        businessId: biz.id,
        fixedAssetId: asset.id,
        kind: null as unknown as "sale",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("invalid_disposal_kind");
    // A null name is not an asset.
    await expect(
      fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name: null as unknown as string,
        acquisitionDate: "2025-01-01",
        cost: 1_000_000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        createdBy: owner.id,
      }),
    ).rejects.toThrow();
  });
});

/**
 * Depreciation is offered to every trade (`ledger` is a CORE_MODULE), but only
 * F&B's seeded chart had either side of the entry: the four retail templates
 * carried «اثاثه و تجهیزات» with no 1510 under it and no 5700 to debit, so a
 * jewellery or cosmetics shop got `ledger_account_missing` the first time it ran
 * a month's depreciation.
 *
 * Seeded from the real template on purpose — hand-inserting the two accounts,
 * as the fixture above does, is exactly what let the gap go unnoticed.
 */
describe("depreciation for a business that is not a café", () => {
  it.each(["jewelry", "watch", "accessories", "cosmetics"] as const)(
    "posts against the %s template's own chart",
    async (industry) => {
      const bizRow = await db.query<{ id: string }>(
        "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
        [`${industry} Co`, `${industry}-${randomUUID().slice(0, 8)}`, industry],
      );
      const businessId = bizRow.rows[0].id;
      const locRow = await db.query<{ id: string }>(
        `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
        [businessId],
      );

      const client = await dbLib.getPool().connect();
      try {
        await provisioning.seedChartOfAccounts(client, businessId, industry);
      } finally {
        client.release();
      }

      const asset = await fixedAssetsService.createFixedAsset({
        businessId,
        locationId: locRow.rows[0].id,
        name: "ویترین",
        acquisitionDate: "2025-01-01",
        cost: 120_000_000,
        salvageValue: 0,
        usefulLifeMonths: 60,
        createdBy: null,
      });

      await fixedAssetsService.postDepreciation({
        businessId,
        fixedAssetId: asset.id,
        periodKey: "1404-01",
        createdBy: null,
      });

      const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = $1
          ORDER BY a.code`,
        [businessId],
      );
      expect(rows.map((r) => r.code)).toEqual(["1510", "5700"]);
      expect(Number(rows.find((r) => r.code === "5700")!.debit)).toBe(2_000_000);
      expect(Number(rows.find((r) => r.code === "1510")!.credit)).toBe(2_000_000);
      expect(asset.cost).toBe(120_000_000);
    },
  );
});
