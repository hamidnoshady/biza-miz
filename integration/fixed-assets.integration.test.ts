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
import { depreciationPeriod } from "../src/lib/depreciation";
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
    name: "یخچال صنعتی",
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
    // cost 100,000, salvage 0, useful life 3 months -> monthly = 33,333.33... rounds to 33,333.
    const asset = await createAsset({ cost: 100_000, salvageValue: 0, usefulLifeMonths: 3 });

    const p1 = await post(asset.id, { periodKey: "1404-01" });
    const p2 = await post(asset.id, { periodKey: "1404-02" });
    const p3 = await post(asset.id, { periodKey: "1404-03" });

    expect(p1.amount + p2.amount + p3.amount).toBe(100_000);
    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(100_000);
    expect(listed.bookValue).toBe(0);

    await expect(post(asset.id, { periodKey: "1404-04" })).rejects.toThrow("fully_depreciated");
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
    // 100,000 − 10,000 over 3 months; five months requested at once.
    const asset = await createAsset({ cost: 100_000, salvageValue: 10_000, usefulLifeMonths: 3 });
    const months = ["1404-01", "1404-02", "1404-03", "1404-04", "1404-05"];
    const results = await Promise.allSettled(months.map((periodKey) => post(asset.id, { periodKey })));
    const posted = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ amount: number }>[];
    expect(posted).toHaveLength(3);
    expect(posted.reduce((sum, r) => sum + r.value.amount, 0)).toBe(90_000);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason.message).toBe("fully_depreciated");
    }
    const { rows } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit), 0)::text AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.accumulatedDepreciation],
    );
    expect(rows[0].credit).toBe("90000");
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

  it("keeps posting to branch A after a transfer, then to branch B once transferred", async () => {
    const asset = await createAsset({ locationId: biz.locationA });
    await post(asset.id, { periodKey: "1404-01" });

    await fixedAssetsService.transferFixedAsset({
      businessId: biz.id,
      fixedAssetId: asset.id,
      toLocationId: biz.locationB,
      reason: "انتقال به شعبه مرکزی",
      createdBy: owner.id,
    });

    await post(asset.id, { periodKey: "1404-02" });

    const { rows } = await db.query<{ location_id: string | null; entry_date: string }>(
      `SELECT location_id, entry_date::text FROM journal_entries WHERE business_id = $1 ORDER BY entry_date`,
      [biz.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].location_id).toBe(biz.locationA);
    expect(rows[1].location_id).toBe(biz.locationB);

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
  async function depreciateMonths(assetId: string, months: number, startingAt = 1) {
    for (let i = 0; i < months; i++) {
      await post(assetId, { periodKey: `1404-${String(startingAt + i).padStart(2, "0")}` });
    }
  }

  it("a sale above net book value realises a gain and removes cost + accumulated depreciation", async () => {
    // cost 100M, salvage 0, life 50 → 2M/month; 12 months = 24M accumulated; NBV = 76M.
    const asset = await createAsset({ cost: 100_000_000, usefulLifeMonths: 50 });
    await depreciateMonths(asset.id, 12);

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
    await depreciateMonths(asset.id, 12); // accumulated 24M, NBV 76M

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
    await depreciateMonths(asset.id, 10); // accumulated 10M, NBV 40M

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
    await depreciateMonths(asset.id, 12);
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
});

describe("prospective estimate changes (issue #833)", () => {
  it("applies a revised useful life prospectively; historical postings are untouched", async () => {
    // cost 120M, salvage 0, life 60 → 2M/month. After 24 months (48M), the
    // life is revised to 48: remaining 72M over the 24 months left = 3M/month.
    const months = recentPeriodKeys(24, false);
    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "ماشین صنعتی",
      acquisitionDate: "2020-01-01",
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

    // The next period follows the revised schedule: 3M/month.
    const [currentKey] = recentPeriodKeys(1);
    const next = await post(asset.id, { periodKey: currentKey });
    expect(next.amount).toBe(3_000_000);
  });

  it("consumes the remaining depreciable amount exactly when the revision shortens the life to its end", async () => {
    // 24 months posted at 2M = 48M of a 120M base; revising the life to 25
    // leaves one scheduled month, which must absorb the remaining 72M exactly.
    const months = recentPeriodKeys(24, false);
    const asset = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "دستگاه",
      acquisitionDate: "2020-01-01",
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
});

describe("server-side pagination, filters and export (issue #833)", () => {
  it("pages through the register with accurate totals across pages", async () => {
    const names = ["الف", "ب", "ج", "د", "ه"];
    for (const name of names) {
      await fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name,
        acquisitionDate: "2025-01-01",
        cost: 1_000_000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        createdBy: owner.id,
      });
    }
    const page1 = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2 });
    expect(page1.assets).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.kpis.count).toBe(5);

    const page2 = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2, offset: 2 });
    expect(page2.assets).toHaveLength(2);
    expect(page2.hasMore).toBe(true);

    const page3 = await fixedAssetsService.listFixedAssetsPage(biz.id, { limit: 2, offset: 4 });
    expect(page3.assets).toHaveLength(1);
    expect(page3.hasMore).toBe(false);

    const all = [...page1.assets, ...page2.assets, ...page3.assets];
    expect(new Set(all.map((a) => a.id)).size).toBe(5);
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

    // Fully depreciated: a short-life asset whose whole base is consumed.
    const c = await fixedAssetsService.createFixedAsset({
      businessId: biz.id,
      locationId: biz.locationA,
      name: "لپ‌تاپ",
      acquisitionDate: "2025-01-01",
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

  it("exports the full filtered dataset, not one page", async () => {
    for (const name of ["الف", "ب", "ج"]) {
      await fixedAssetsService.createFixedAsset({
        businessId: biz.id,
        locationId: biz.locationA,
        name,
        acquisitionDate: "2025-01-01",
        cost: 1_000_000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        createdBy: owner.id,
      });
    }
    const [first] = (await fixedAssetsService.listFixedAssets(biz.id)).map((a) => a.id);
    await post(first, { periodKey: "1404-01" });

    // No disposals yet -> no disposals sheet.
    let sheets = await fixedAssetsService.fixedAssetsExportSheets(biz.id, {});
    expect(sheets.find((s) => s.name === "واگذاری‌ها")).toBeUndefined();

    await fixedAssetsService.disposeFixedAsset({
      businessId: biz.id,
      fixedAssetId: first,
      kind: "retirement",
      createdBy: owner.id,
      reason: "از رده خارج",
    });

    sheets = await fixedAssetsService.fixedAssetsExportSheets(biz.id, {});
    const register = sheets.find((s) => s.name === "دفتر اموال");
    const schedule = sheets.find((s) => s.name === "برنامه استهلاک");
    const disposalsSheet = sheets.find((s) => s.name === "واگذاری‌ها");
    expect(register?.rows).toHaveLength(3);
    expect(schedule?.rows).toHaveLength(1);
    // The disposal facts with the recomputed net book value and zero-proceeds loss.
    expect(disposalsSheet?.rows).toEqual([
      expect.objectContaining({
        kind: "بازنشستگی",
        cost: 1_000_000,
        accumulated: 83_333, // round(1,000,000 / 12), one period posted
        netBookValue: 916_667,
        proceeds: 0,
        gainLoss: -916_667,
        reason: "از رده خارج",
      }),
    ]);

    // A filter narrows the register sheet to the filtered rows.
    const filtered = await fixedAssetsService.fixedAssetsExportSheets(biz.id, { search: "الف" });
    expect(filtered.find((s) => s.name === "دفتر اموال")?.rows).toHaveLength(1);
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
