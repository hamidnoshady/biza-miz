/**
 * Phase 22 Wave 5, second slice (issue #160 §2): fixed-asset register &
 * straight-line depreciation. Proves accumulatedDepreciation/bookValue are
 * correctly reconstructed from posted fixed_asset_depreciation_entries
 * (never a shadow column), depreciation posts a balanced entry against the
 * right accounts, the same period can't be depreciated twice, an asset
 * can't be depreciated past its salvage value, and deletion is blocked once
 * anything has been posted.
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
let fixedAssetsService: typeof import("../src/lib/fixed-assets-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "" };
const acct = { depreciationExpense: "", accumulatedDepreciation: "" };
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

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  owner.id = ownerRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5700', 'Depreciation expense', 'expense'), ($1, '1510', 'Accumulated depreciation', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "5700") acct.depreciationExpense = r.id;
    if (r.code === "1510") acct.accumulatedDepreciation = r.id;
  }
});

async function createAsset(overrides: Partial<{ cost: number; salvageValue: number; usefulLifeMonths: number }> = {}) {
  return fixedAssetsService.createFixedAsset({
    businessId: biz.id,
    locationId: biz.locationId,
    name: "یخچال صنعتی",
    acquisitionDate: "2025-01-01",
    cost: overrides.cost ?? 120_000_000,
    salvageValue: overrides.salvageValue ?? 0,
    usefulLifeMonths: overrides.usefulLifeMonths ?? 60,
    createdBy: owner.id,
  });
}

describe("createFixedAsset", () => {
  it("registers an asset with zero accumulated depreciation and a book value equal to cost", async () => {
    const asset = await createAsset();
    expect(asset.accumulatedDepreciation).toBe(0);
    expect(asset.bookValue).toBe(120_000_000);
  });

  it("rejects an invalid asset (e.g. salvage value not less than cost)", async () => {
    await expect(createAsset({ salvageValue: 120_000_000 })).rejects.toThrow();
  });
});

describe("postDepreciation", () => {
  it("posts a balanced entry (Debit depreciation expense / Credit accumulated depreciation) for the monthly amount", async () => {
    const asset = await createAsset(); // 120,000,000 / 60 = 2,000,000/month
    const { amount } = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-01",
      entryDate: "2025-02-01",
      createdBy: owner.id,
    });
    expect(amount).toBe(2_000_000);

    const { rows: entries } = await db.query<{ id: string; memo: string; source_type: string }>(
      `SELECT id, memo, source_type FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source_type).toBe("fixed_asset_depreciation");

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC`,
      [entries[0].id],
    );
    expect(lines).toEqual([
      { account_id: acct.depreciationExpense, debit: "2000000", credit: "0" },
      { account_id: acct.accumulatedDepreciation, debit: "0", credit: "2000000" },
    ]);
  });

  it("updates listFixedAssets' reconstructed accumulatedDepreciation and bookValue", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1404-01",
      createdBy: owner.id,
    });
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1404-02",
      createdBy: owner.id,
    });

    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(4_000_000);
    expect(listed.bookValue).toBe(116_000_000);
  });

  it("refuses to post the same period twice for the same asset", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-01",
      createdBy: owner.id,
    });
    await expect(
      fixedAssetsService.postDepreciation({
        businessId: biz.id,
        locationId: biz.locationId,
        fixedAssetId: asset.id,
        periodLabel: "1404-01",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("period_already_depreciated");

    // The rejected attempt didn't leave a second journal entry behind.
    const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text FROM journal_entries WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(rows[0].count).toBe("1");
  });

  it("caps the final period at what's left of the depreciable base, then refuses further depreciation", async () => {
    // cost 100,000, salvage 0, useful life 3 months -> monthly = 33,333.33... rounds to 33,333.
    const asset = await createAsset({ cost: 100_000, salvageValue: 0, usefulLifeMonths: 3 });

    const p1 = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1404-01",
      createdBy: owner.id,
    });
    const p2 = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1404-02",
      createdBy: owner.id,
    });
    const p3 = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1404-03",
      createdBy: owner.id,
    });

    expect(p1.amount + p2.amount + p3.amount).toBe(100_000);
    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(100_000);
    expect(listed.bookValue).toBe(0);

    await expect(
      fixedAssetsService.postDepreciation({
        businessId: biz.id,
        locationId: biz.locationId,
        fixedAssetId: asset.id,
        periodKey: "1404-04",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fully_depreciated");
  });

  it("refuses to post into a locked fiscal period", async () => {
    const asset = await createAsset();
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    await expect(
      fixedAssetsService.postDepreciation({
        businessId: biz.id,
        locationId: biz.locationId,
        fixedAssetId: asset.id,
        periodKey: "1404-01",
        entryDate: farvardin.startsOn,
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");
  });
});

describe("postDepreciation — canonical months and concurrency (audit F07)", () => {
  const post = (assetId: string, extra: { periodKey?: string; periodLabel?: string; entryDate?: string }) =>
    fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: assetId,
      createdBy: owner.id,
      ...extra,
    });

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
      locationId: biz.locationId,
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
      locationId: biz.locationId,
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

    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1403-10",
      createdBy: owner.id,
    });
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
      locationId: biz.locationId,
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

describe("deleteFixedAsset", () => {
  it("deletes an asset with no depreciation posted", async () => {
    const asset = await createAsset();
    await fixedAssetsService.deleteFixedAsset(biz.id, asset.id);
    expect(await fixedAssetsService.listFixedAssets(biz.id)).toEqual([]);
  });

  it("throws 404 for nonexistent asset", async () => {
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, randomUUID())).rejects.toThrow("fixed_asset_not_found");
  });

  it("refuses to delete an asset that has depreciation posted", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodKey: "1404-01",
      createdBy: owner.id,
    });
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, asset.id)).rejects.toThrow("fixed_asset_has_depreciation");
  });
});

describe("getFixedAssetWithDepreciation", () => {
  it("retrieves the asset along with its full depreciation history", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-01",
      entryDate: "2025-04-01",
      createdBy: owner.id,
    });
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-02",
      entryDate: "2025-05-01",
      createdBy: owner.id,
    });

    const result = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(result.fixedAsset.id).toBe(asset.id);
    expect(result.fixedAsset.accumulatedDepreciation).toBe(4_000_000);
    expect(result.fixedAsset.depreciationCount).toBe(2);
    expect(result.fixedAsset.locationName).toBe("Main");
    expect(result.depreciationEntries).toHaveLength(2);
    expect(result.depreciationEntries[0].periodLabel).toBe("1404-02");
    expect(result.depreciationEntries[0].amount).toBe(2_000_000);
    expect(result.depreciationEntries[0].journalEntryId).toBeTruthy();
    expect(result.depreciationEntries[0].createdByName).toBe("Owner");
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
        locationId: locRow.rows[0].id,
        fixedAssetId: asset.id,
        periodLabel: "بهمن ۱۴۰۳",
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
