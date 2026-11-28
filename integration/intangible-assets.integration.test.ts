/**
 * Intangible-asset register, amortization, impairment and disposal — issue
 * #1326's accounting-integrity coverage, against a real database:
 *
 *   * a finite-life licence amortizes deterministically, lands exactly on its
 *     residual, and every posting is a balanced journal document;
 *   * an indefinite-life asset is never amortized — it is impaired and the
 *     impairment can be reversed, with both facts kept in history;
 *   * a posted month reverses (marked, mirrored) and may then be posted again;
 *   * disposal removes cost and both accumulations and recognizes the
 *     gain/loss against the carrying amount;
 *   * registration is idempotent and tenant-scoped;
 *   * the register reconciles to the mapped control accounts.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { depreciationPeriod, depreciationPeriodOfDate } from "../src/lib/depreciation";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/intangible-assets-service");
let businessDayService: typeof import("../src/lib/business-day-service");

const biz = { id: "", location: "" };
const acct = {
  asset: "",
  accumulatedAmortization: "",
  amortizationExpense: "",
  impairmentLoss: "",
  accumulatedImpairment: "",
  cash: "",
  gain: "",
  loss: "",
};
const owner = { id: "" };
let todayIso = "";

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
  databaseName = `pos_intangible_${randomUUID().replaceAll("-", "")}`;
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
  service = await import("../src/lib/intangible-assets-service");
  businessDayService = await import("../src/lib/business-day-service");

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
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM intangible_asset_impairments");
  await db.query("DELETE FROM intangible_asset_amortization_entries");
  await db.query("DELETE FROM intangible_assets");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Intangibles Co', $1) RETURNING id",
    [`ia-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Branch A') RETURNING id",
    [biz.id],
  );
  biz.location = locRow.rows[0].id;

  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  owner.id = ownerRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1600', 'Intangible assets', 'asset'),
            ($1, '1610', 'Accumulated amortization', 'asset'),
            ($1, '1615', 'Accumulated impairment', 'asset'),
            ($1, '5710', 'Amortization expense', 'expense'),
            ($1, '5715', 'Impairment loss', 'expense'),
            ($1, '1100', 'Cash', 'asset'),
            ($1, '4920', 'Gain on asset sale', 'revenue'),
            ($1, '5750', 'Loss on asset sale', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1600") acct.asset = r.id;
    if (r.code === "1610") acct.accumulatedAmortization = r.id;
    if (r.code === "1615") acct.accumulatedImpairment = r.id;
    if (r.code === "5710") acct.amortizationExpense = r.id;
    if (r.code === "5715") acct.impairmentLoss = r.id;
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "4920") acct.gain = r.id;
    if (r.code === "5750") acct.loss = r.id;
  }

  todayIso = await businessDayService.businessToday(biz.id);
});

/** A licence in service since Farvardin 1404 — a schedule that covers past months. */
const inService = depreciationPeriod(1404, 1).startsOn;

async function createFinite(overrides: Record<string, unknown> = {}) {
  return service.createIntangibleAsset({
    businessId: biz.id,
    locationId: biz.location,
    name: "لایسنس نرم‌افزار",
    assetClass: "software",
    acquisitionDate: inService,
    availableForUseDate: inService,
    cost: 1_000_000,
    directlyAttributableCost: 0,
    usefulLifeType: "finite",
    usefulLifeMonths: 3,
    residualValue: 0,
    assetAccountId: acct.asset,
    accumulatedAmortizationAccountId: acct.accumulatedAmortization,
    amortizationExpenseAccountId: acct.amortizationExpense,
    impairmentLossAccountId: acct.impairmentLoss,
    accumulatedImpairmentAccountId: acct.accumulatedImpairment,
    capitalizationPolicyNote: "مجوز دائمی با عمر استفادهٔ سه‌ماهه",
    createdBy: owner.id,
    ...overrides,
  } as Parameters<typeof service.createIntangibleAsset>[0]);
}

async function createIndefinite(overrides: Record<string, unknown> = {}) {
  return service.createIntangibleAsset({
    businessId: biz.id,
    locationId: biz.location,
    name: "علامت تجاری",
    assetClass: "trademark",
    acquisitionDate: inService,
    availableForUseDate: inService,
    cost: 1_000_000,
    usefulLifeType: "indefinite",
    usefulLifeMonths: null,
    residualValue: 0,
    assetAccountId: acct.asset,
    accumulatedAmortizationAccountId: acct.accumulatedAmortization,
    amortizationExpenseAccountId: acct.amortizationExpense,
    impairmentLossAccountId: acct.impairmentLoss,
    accumulatedImpairmentAccountId: acct.accumulatedImpairment,
    capitalizationPolicyNote: "علامت ثبت‌شده با عمر نامحدود؛ بازبینی سالانهٔ کاهش ارزش",
    createdBy: owner.id,
    ...overrides,
  } as Parameters<typeof service.createIntangibleAsset>[0]);
}

function amortize(assetId: string, periodKey: string) {
  return service.postIntangibleAmortization({
    businessId: biz.id,
    intangibleAssetId: assetId,
    periodKey,
    createdBy: owner.id,
  });
}

async function journalFor(sourceType: string, sourceId: string) {
  const { rows } = await db.query<{ id: string; debit: string; credit: string; entry_date: string }>(
    `SELECT je.id, je.entry_date::text AS entry_date,
            COALESCE((SELECT SUM(debit) FROM journal_lines WHERE entry_id = je.id), 0)::text AS debit,
            COALESCE((SELECT SUM(credit) FROM journal_lines WHERE entry_id = je.id), 0)::text AS credit
       FROM journal_entries je
      WHERE je.business_id = $1 AND je.source_type = $2 AND je.source_id = $3`,
    [biz.id, sourceType, sourceId],
  );
  return rows;
}

describe("registration", () => {
  it("capitalizes an explicit, documented asset and posts the acquisition", async () => {
    const asset = await createFinite({ acquisition: { sourceAccountId: acct.cash } });
    expect(asset.code).toBe("IA-0001");
    expect(asset.cost).toBe(1_000_000);
    expect(asset.carryingAmount).toBe(1_000_000);
    expect(asset.accumulatedAmortization).toBe(0);

    const journals = await journalFor("intangible_asset_acquisition", asset.id);
    expect(journals).toHaveLength(1);
    expect(journals[0].debit).toBe(journals[0].credit);
    expect(Number(journals[0].debit)).toBe(1_000_000);

    const reconciliation = await service.getIntangibleReconciliation(biz.id);
    expect(reconciliation.status).toBe("reconciled");
    expect(reconciliation.registerCost).toBe("1000000");
    expect(reconciliation.ledgerCost).toBe("1000000");
  });

  it("refuses a registration without a capitalization policy", async () => {
    await expect(createFinite({ capitalizationPolicyNote: "" })).rejects.toThrow(/سیاست سرمایه‌ای‌سازی/);
  });

  it("refuses an amortization account that is not an expense account", async () => {
    await expect(
      createFinite({ amortizationExpenseAccountId: acct.accumulatedAmortization }),
    ).rejects.toThrow();
  });

  it("is idempotent on the client's key", async () => {
    const first = await createFinite({ idempotencyKey: "licence-2026" });
    const second = await createFinite({ idempotencyKey: "licence-2026", name: "نام دیگر" });
    expect(second.id).toBe(first.id);
    const count = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM intangible_assets");
    expect(count.rows[0].n).toBe("1");
  });

  it("does not let another business read or post against the asset", async () => {
    const asset = await createFinite();
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    expect(await service.getIntangibleAsset(other.rows[0].id, asset.id)).toBeNull();
    await expect(
      service.postIntangibleAmortization({
        businessId: other.rows[0].id,
        intangibleAssetId: asset.id,
        periodKey: "1404-01",
        createdBy: null,
      }),
    ).rejects.toThrow(/intangible_asset_not_found/);
  });
});

describe("amortization", () => {
  it("posts deterministic monthly amounts that land exactly on the residual", async () => {
    const asset = await createFinite({ residualValue: 100_000 });
    const first = await amortize(asset.id, "1404-01");
    const second = await amortize(asset.id, "1404-02");
    const third = await amortize(asset.id, "1404-03");
    expect([first.amount, second.amount, third.amount]).toEqual([300_000, 300_000, 300_000]);

    for (const posting of [first, second, third]) {
      const journals = await journalFor("intangible_asset_amortization", posting.amortizationEntryId);
      expect(journals).toHaveLength(1);
      expect(journals[0].debit).toBe(journals[0].credit);
      expect(Number(journals[0].debit)).toBe(posting.amount);
    }

    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detail?.asset.accumulatedAmortization).toBe(900_000);
    expect(detail?.asset.carryingAmount).toBe(100_000);
    expect(detail?.totals.closingCarrying).toBe(100_000);

    await expect(amortize(asset.id, "1404-03")).rejects.toThrow(/period_already_amortized/);
  });

  it("absorbs rounding in the final month", async () => {
    const asset = await createFinite({ cost: 1_000_000, residualValue: 0 });
    const amounts: number[] = [];
    for (const key of ["1404-01", "1404-02", "1404-03"]) amounts.push((await amortize(asset.id, key)).amount);
    expect(amounts).toEqual([333_333, 333_333, 333_334]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detail?.asset.carryingAmount).toBe(0);
  });

  it("reverses a month, keeps it in history and allows it to be posted again", async () => {
    const asset = await createFinite();
    const posted = await amortize(asset.id, "1404-01");
    const reversal = await service.reverseIntangibleAmortization({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      amortizationEntryId: posted.amortizationEntryId,
      reason: "اشتباه در ماه",
      createdBy: owner.id,
    });
    expect(reversal.amount).toBe(posted.amount);
    expect(reversal.reversalJournalEntryId).toBeTruthy();

    const afterReversal = await service.getIntangibleAsset(biz.id, asset.id);
    expect(afterReversal?.asset.accumulatedAmortization).toBe(0);
    expect(afterReversal?.entries).toHaveLength(1);
    expect(afterReversal?.entries[0].reversedAt).toBeTruthy();

    const rePosted = await amortize(asset.id, "1404-01");
    expect(rePosted.amount).toBe(posted.amount);
    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detail?.asset.accumulatedAmortization).toBe(posted.amount);
  });
});

describe("indefinite life and impairment", () => {
  it("never amortizes an indefinite-life asset", async () => {
    const asset = await createIndefinite();
    await expect(amortize(asset.id, "1404-01")).rejects.toThrow(/indefinite_life_not_amortized/);
    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detail?.schedule).toEqual([]);
    expect(detail?.entries).toEqual([]);
  });

  it("records an impairment against carrying amount and reverses it in full", async () => {
    const asset = await createIndefinite();
    const impairment = await service.assessIntangibleImpairment({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      recoverableAmount: 400_000,
      reason: "افت بازار علامت تجاری",
      createdBy: owner.id,
    });
    expect(impairment.amount).toBe(600_000);
    expect(impairment.netBookValue).toBe(400_000);

    const impaired = await service.getIntangibleAsset(biz.id, asset.id);
    expect(impaired?.asset.accumulatedImpairment).toBe(600_000);
    expect(impaired?.asset.carryingAmount).toBe(400_000);

    const journals = await journalFor("intangible_asset_impairment", impairment.impairmentId);
    expect(journals).toHaveLength(1);
    expect(journals[0].debit).toBe("600000");

    const reversal = await service.reverseIntangibleImpairment({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      impairmentId: impairment.impairmentId,
      reason: "بازیابی ارزش بازار",
      createdBy: owner.id,
    });
    expect(reversal.amount).toBe(600_000);

    const restored = await service.getIntangibleAsset(biz.id, asset.id);
    expect(restored?.asset.accumulatedImpairment).toBe(0);
    expect(restored?.asset.carryingAmount).toBe(1_000_000);
    expect(restored?.impairments).toHaveLength(2);
    expect(restored?.impairments[0].reversedAt).toBeTruthy();
  });

  it("reverses only part of an impairment and leaves the rest outstanding", async () => {
    const asset = await createIndefinite();
    const impairment = await service.assessIntangibleImpairment({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      recoverableAmount: 400_000,
      reason: "افت بازار",
      createdBy: owner.id,
    });
    const reversal = await service.reverseIntangibleImpairment({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      impairmentId: impairment.impairmentId,
      amount: 200_000,
      reason: "بازیابی جزئی",
      createdBy: owner.id,
    });
    expect(reversal.amount).toBe(200_000);
    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detail?.asset.accumulatedImpairment).toBe(400_000);
    expect(detail?.asset.carryingAmount).toBe(600_000);
  });

  it("refuses an assessment that finds no impairment", async () => {
    const asset = await createIndefinite();
    await expect(
      service.assessIntangibleImpairment({
        businessId: biz.id,
        intangibleAssetId: asset.id,
        effectiveDate: todayIso,
        recoverableAmount: 1_000_000,
        reason: "بدون افت",
        createdBy: owner.id,
      }),
    ).rejects.toThrow();
  });
});

describe("disposal", () => {
  it("recognizes a gain, removes cost and both accumulations, and stops amortization", async () => {
    const asset = await createFinite({ cost: 1_000_000, residualValue: 0, usefulLifeMonths: 3 });
    await amortize(asset.id, "1404-01");
    await service.assessIntangibleImpairment({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      recoverableAmount: 500_000,
      reason: "افت ارزش",
      createdBy: owner.id,
    });
    const detailBefore = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detailBefore?.asset.carryingAmount).toBe(500_000);

    const result = await service.disposeIntangibleAsset({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      kind: "sale",
      disposalDate: todayIso,
      proceeds: 650_000,
      proceedsAccountId: acct.cash,
      reason: "فروش لایسنس",
      createdBy: owner.id,
    });
    expect(result.netBookValue).toBe(500_000);
    expect(result.gain).toBe(150_000);
    expect(result.loss).toBe(0);

    const journals = await journalFor("intangible_asset_disposal", asset.id);
    expect(journals).toHaveLength(1);
    expect(journals[0].debit).toBe(journals[0].credit);

    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    expect(detail?.asset.status).toBe("disposed");
    expect(detail?.asset.disposalKind).toBe("sale");
    expect(detail?.asset.disposalProceeds).toBe(650_000);

    await expect(amortize(asset.id, "1404-02")).rejects.toThrow(/intangible_asset_disposed/);
  });

  it("writes off the remaining carrying amount as a loss with no proceeds", async () => {
    const asset = await createFinite({ usefulLifeMonths: 10 });
    const result = await service.disposeIntangibleAsset({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      kind: "write_off",
      disposalDate: todayIso,
      reason: "توقف پروژه",
      createdBy: owner.id,
    });
    expect(result.proceeds).toBe(0);
    expect(result.netBookValue).toBe(1_000_000);
    expect(result.loss).toBe(1_000_000);
    expect(result.gain).toBe(0);
  });

  it("refuses proceeds on a retirement", async () => {
    const asset = await createFinite();
    await expect(
      service.disposeIntangibleAsset({
        businessId: biz.id,
        intangibleAssetId: asset.id,
        kind: "retirement",
        disposalDate: todayIso,
        proceeds: 100_000,
        createdBy: owner.id,
      }),
    ).rejects.toThrow();
  });
});

describe("register ↔ ledger", () => {
  it("stays reconciled across acquisition, amortization and impairment", async () => {
    const asset = await createFinite({ acquisition: { sourceAccountId: acct.cash } });
    await amortize(asset.id, "1404-01");
    await service.assessIntangibleImpairment({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      recoverableAmount: 500_000,
      reason: "افت ارزش",
      createdBy: owner.id,
    });
    const reconciliation = await service.getIntangibleReconciliation(biz.id);
    expect(reconciliation.status).toBe("reconciled");
    expect(reconciliation.registerCost).toBe("1000000");
    expect(reconciliation.registerAccumulatedAmortization).toBe("333333");
    expect(reconciliation.registerAccumulatedImpairment).toBe("166667");
    expect(reconciliation.unmappedCount).toBe(0);
  });

  it("does not double-count a reversed posting", async () => {
    const asset = await createFinite({ acquisition: { sourceAccountId: acct.cash } });
    const posted = await amortize(asset.id, "1404-01");
    await service.reverseIntangibleAmortization({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      amortizationEntryId: posted.amortizationEntryId,
      reason: "اصلاح",
      createdBy: owner.id,
    });
    const reconciliation = await service.getIntangibleReconciliation(biz.id);
    expect(reconciliation.registerAccumulatedAmortization).toBe("0");
    expect(reconciliation.ledgerAccumulatedAmortization).toBe("0");
    expect(reconciliation.status).toBe("reconciled");
  });
});

describe("prospective estimate changes", () => {
  it("records the decision and reprices only the future months", async () => {
    const asset = await createFinite();
    const first = await amortize(asset.id, "1404-01");
    // 1,000,000 over three months floors at 333,333 for the first two months
    // and leaves 333,334 to the final one, so one posted month leaves 666,667
    // carrying — not the 700,000 a rounded 300,000/month would suggest.
    expect(first.amount).toBe(333_333);
    const before = await service.getIntangibleAsset(biz.id, asset.id);
    expect(before?.asset.carryingAmount).toBe(666_667);

    const changed = await service.changeIntangibleEstimate({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      usefulLifeType: "finite",
      usefulLifeMonths: 6,
      residualValue: 100_000,
      reason: "بازنگری عمر مجوز بر اساس برنامهٔ فناوری",
      evidenceReference: "صورت‌جلسهٔ ۱۴۰۵/۰۹",
      createdBy: owner.id,
    });
    expect(changed.estimateChange.previousUsefulLifeMonths).toBe(3);
    expect(changed.estimateChange.newUsefulLifeMonths).toBe(6);
    expect(changed.estimateChange.previousResidualValue).toBe(0);
    expect(changed.estimateChange.newResidualValue).toBe(100_000);
    // The same carrying amount less the new 100,000 residual.
    expect(changed.estimateChange.remainingBase).toBe(566_667);
    expect(changed.asset.usefulLifeMonths).toBe(6);
    expect(changed.asset.residualValue).toBe(100_000);

    // The posted month is untouched — amount and journal.
    const detail = await service.getIntangibleAsset(biz.id, asset.id);
    const posted = detail?.entries.find((entry) => entry.periodKey === "1404-01");
    expect(posted?.amount).toBe(first.amount);
    const journals = await journalFor("intangible_asset_amortization", first.amortizationEntryId);
    expect(journals).toHaveLength(1);
    expect(journals[0].debit).toBe(journals[0].credit);

    // From the effective month the remaining 566,667 spreads over six months:
    // round(566,667 / 6) = 94,445, with the last month absorbing the remainder.
    const currentKey = depreciationPeriodOfDate(todayIso)!.key;
    const next = await service.postIntangibleAmortization({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      periodKey: currentKey,
      createdBy: owner.id,
    });
    expect(next.amount).toBe(94_445);
    const projection = await service.getIntangibleAsset(biz.id, asset.id);
    // Months before the effective date that were never posted keep the OLD
    // plan (the change is prospective), so the revised month to compare is the
    // first forecast after the current one — priced exactly as the posting was.
    const forecast = projection?.schedule.find(
      (row) => row.status === "forecast" && row.periodKey > currentKey,
    );
    expect(forecast?.amortization).toBe(94_445);
  });

  it("is idempotent on the client's key", async () => {
    const asset = await createFinite();
    const first = await service.changeIntangibleEstimate({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      usefulLifeMonths: 6,
      residualValue: 0,
      reason: "بازنگری",
      createdBy: owner.id,
      idempotencyKey: "estimate-1",
    });
    const second = await service.changeIntangibleEstimate({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      usefulLifeMonths: 6,
      residualValue: 0,
      reason: "بازنگری",
      createdBy: owner.id,
      idempotencyKey: "estimate-1",
    });
    expect(second.estimateChange.id).toBe(first.estimateChange.id);
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM intangible_asset_estimate_changes",
    );
    expect(count.rows[0].n).toBe("1");
  });

  it("refuses an effective date in a posted period", async () => {
    const asset = await createFinite();
    await expect(
      service.changeIntangibleEstimate({
        businessId: biz.id,
        intangibleAssetId: asset.id,
        effectiveDate: inService,
        usefulLifeMonths: 6,
        residualValue: 0,
        reason: "گذشته",
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/estimate_effective_in_past/);
  });

  it("refuses a residual above the permitted carrying amount", async () => {
    const asset = await createFinite();
    await amortize(asset.id, "1404-01");
    await expect(
      service.changeIntangibleEstimate({
        businessId: biz.id,
        intangibleAssetId: asset.id,
        effectiveDate: todayIso,
        usefulLifeMonths: 6,
        residualValue: 900_000,
        reason: "بیش از ارزش دفتری",
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/residual_above_carrying_amount/);
  });

  it("refuses a no-op change", async () => {
    const asset = await createFinite();
    await expect(
      service.changeIntangibleEstimate({
        businessId: biz.id,
        intangibleAssetId: asset.id,
        effectiveDate: todayIso,
        usefulLifeType: "finite",
        usefulLifeMonths: 3,
        residualValue: 0,
        reason: "بدون تغییر",
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/estimate_unchanged/);
  });

  it("turns an indefinite asset into an amortizable one from the effective month", async () => {
    const asset = await createIndefinite();
    const changed = await service.changeIntangibleEstimate({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      effectiveDate: todayIso,
      usefulLifeType: "finite",
      usefulLifeMonths: 12,
      residualValue: 0,
      reason: "تعیین عمر مفید بر اساس مجوز جدید",
      createdBy: owner.id,
    });
    expect(changed.estimateChange.previousUsefulLifeType).toBe("indefinite");
    const currentKey = depreciationPeriodOfDate(todayIso)!.key;
    const posted = await service.postIntangibleAmortization({
      businessId: biz.id,
      intangibleAssetId: asset.id,
      periodKey: currentKey,
      createdBy: owner.id,
    });
    expect(posted.amount).toBe(83_333);
  });
});
