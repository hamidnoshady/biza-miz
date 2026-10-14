/**
 * Issue #867 — formal voucher numbering, end to end.
 *
 * Every posted document wears one stable fiscal-year number: one book per
 * source kind (journal RJ, manual MJ, opening OP, summary SV), one sequence
 * per book per fiscal year. The number is assigned inside the posting
 * transaction, pre-existing entries are backfilled in journal order, a
 * renumber is privileged + logged + trigger-guarded, and a summary voucher
 * aggregates a defined source set without touching the journal detail.
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
let ledgerService: typeof import("../src/lib/ledger-service");
let voucherService: typeof import("../src/lib/voucher-numbering-service");

const biz = { id: "", locationId: "" };
const user = { id: "" };
const acct: Record<string, string> = {};

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
  databaseName = `pos_voucher_numbering_${randomUUID().replaceAll("-", "")}`;

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
  ledgerService = await import("../src/lib/ledger-service");
  voucherService = await import("../src/lib/voucher-numbering-service");

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
  for (const table of [
    "voucher_renumber_log",
    "voucher_sequences",
    "summary_voucher_sources",
    "summary_vouchers",
    "journal_lines",
    "journal_entries",
    "fiscal_periods",
    "fiscal_years",
    "accounts",
    "users",
    "locations",
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Voucher Co', $1) RETURNING id",
    [`voucher-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '5100', 'Rent', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) acct[r.code] = r.id;
});

async function post(
  entryDate: string,
  sourceType: string,
  amount = 10_000,
  extra?: { sourceId?: string | null; voucherReference?: string | null },
): Promise<string> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const entryId = await ledgerService.postJournalEntry(
      client,
      extra?.sourceId
        ? {
            businessId: biz.id,
            locationId: biz.locationId,
            entryDate,
            memo: "سند آزمون",
            sourceType,
            sourceId: extra.sourceId,
            createdBy: user.id,
            lines: [
              { accountId: acct["5100"], debit: amount, credit: 0 },
              { accountId: acct["1100"], debit: 0, credit: amount },
            ],
          }
        : {
            businessId: biz.id,
            locationId: biz.locationId,
            entryDate,
            memo: "سند آزمون",
            sourceType,
            sourceId: null,
            createdBy: user.id,
            voucherReference: extra?.voucherReference,
            lines: [
              { accountId: acct["5100"], debit: amount, credit: 0 },
              { accountId: acct["1100"], debit: 0, credit: amount },
            ],
          },
    );
    await client.query("COMMIT");
    return entryId as string;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A legacy row: posted before the numbering existed, straight into the journal. */
async function rawLegacyEntry(entryDate: string, sourceType: string, amount = 10_000): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, created_by)
     VALUES ($1, $2, $3, 'سند قدیمی', $4, NULL, $5) RETURNING id`,
    [biz.id, biz.locationId, entryDate, sourceType, user.id],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [rows[0].id, acct["5100"], amount, acct["1100"]],
  );
  return rows[0].id;
}

async function voucherOf(entryId: string): Promise<string | null> {
  const { rows } = await db.query<{ voucher_number: string | null }>(
    "SELECT voucher_number FROM journal_entries WHERE id = $1",
    [entryId],
  );
  return rows[0].voucher_number;
}

describe("numbering at posting time", () => {
  it("numbers every entry from its own book and fiscal year, keeping the reference", async () => {
    const order1 = await post("2025-06-15", "order", 12_000);
    expect(await voucherOf(order1)).toBe("RJ-1404-000001");

    const order2 = await post("2025-07-01", "order", 3_000);
    expect(await voucherOf(order2)).toBe("RJ-1404-000002");

    // A different book has its own sequence in the same year.
    const manual = await post("2025-06-20", "manual", 5_000, { voucherReference: "OLDSYS/77" });
    expect(await voucherOf(manual)).toBe("MJ-1404-000001");
    const { rows: refRows } = await db.query<{ voucher_reference: string }>(
      "SELECT voucher_reference FROM journal_entries WHERE id = $1",
      [manual],
    );
    expect(refRows[0].voucher_reference).toBe("OLDSYS/77");

    // Opening documents number from the opening book.
    const opening = await post("2025-06-15", "opening", 8_000, { sourceId: randomUUID() });
    expect(await voucherOf(opening)).toBe("OP-1404-000001");

    // A reversal of a manual entry stays in the manual book.
    const reversal = await post("2025-06-21", "manual_reversal", 5_000, { sourceId: manual });
    expect(await voucherOf(reversal)).toBe("MJ-1404-000002");

    // The next fiscal year restarts every sequence.
    const nextYear = await post("2026-04-15", "order", 1_000);
    expect(await voucherOf(nextYear)).toBe("RJ-1405-000001");
  });
});

describe("backfill of pre-existing entries", () => {
  it("numbers unnumbered rows in journal order and never renumbers them", async () => {
    const a = await rawLegacyEntry("2025-06-01", "manual", 1_000);
    const b = await rawLegacyEntry("2025-06-02", "order", 2_000);
    const c = await rawLegacyEntry("2025-06-03", "manual", 3_000);

    // Reading the register backfills the book before it lists it.
    const first = await voucherService.listVoucherRegister(biz.id);
    expect(await voucherOf(a)).toBe("MJ-1404-000001");
    expect(await voucherOf(b)).toBe("RJ-1404-000001");
    expect(await voucherOf(c)).toBe("MJ-1404-000002");

    // A second read — and a second explicit backfill — change nothing.
    const second = await voucherService.listVoucherRegister(biz.id);
    expect(second.rows.map((r) => r.voucherNumber)).toEqual(first.rows.map((r) => r.voucherNumber));
    expect(await voucherService.backfillVoucherNumbers(biz.id)).toEqual({ backfilled: 0 });
    expect(await voucherOf(a)).toBe("MJ-1404-000001");

    // The counter continues where the backfill left it, so a new posting
    // lands on the next free number of its book.
    const fresh = await post("2025-06-15", "manual", 4_000);
    expect(await voucherOf(fresh)).toBe("MJ-1404-000003");
  });
});

describe("renumbering", () => {
  it("is privileged, logged, and the only writer a trigger allows", async () => {
    const entry = await post("2025-06-15", "manual", 9_000);
    expect(await voucherOf(entry)).toBe("MJ-1404-000001");

    const result = await voucherService.renumberEntry({
      businessId: biz.id,
      entryId: entry,
      newSequenceNo: 5,
      reason: "جابه‌جایی با سیستم قبلی",
      actorId: user.id,
    });
    expect(result.voucherNumber).toBe("MJ-1404-000005");

    const log = await voucherService.listRenumberLog(biz.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      entryId: entry,
      fiscalYearLabel: "1404",
      documentType: "manual",
      previousNumber: "MJ-1404-000001",
      newNumber: "MJ-1404-000005",
      reason: "جابه‌جایی با سیستم قبلی",
      performedByName: "Owner",
    });

    // The gap report shows what the renumber left behind — the old number
    // is a gap too, because nothing wears it any more.
    const gaps = await voucherService.voucherGapReport(biz.id, {
      fiscalYearLabel: "1404",
      documentType: "manual",
    });
    expect(gaps.presentCount).toBe(1);
    expect(gaps.gapCount).toBe(4);
    expect(gaps.missing).toEqual([1, 2, 3, 4]);
    expect(gaps.counterMax).toBe(5);

    // The 0217 trigger refuses any other writer of the voucher columns…
    await expect(
      db.query("UPDATE journal_entries SET voucher_number = 'MJ-1404-000009' WHERE id = $1", [entry]),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await voucherOf(entry)).toBe("MJ-1404-000005");
    // …and honours the transaction flag the service itself sets.
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.allow_voucher_renumber', 'on', true)");
      await client.query("UPDATE journal_entries SET voucher_number = 'MJ-1404-000006' WHERE id = $1", [entry]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await voucherOf(entry)).toBe("MJ-1404-000006");
    // A direct change leaves no log row — only the service's renumber does.
    expect(await voucherService.listRenumberLog(biz.id)).toHaveLength(1);
  });

  it("refuses a reason-less renumber, a taken number, and a malformed reference", async () => {
    const first = await post("2025-06-15", "manual", 1_000);
    const second = await post("2025-06-16", "manual", 2_000);
    expect(await voucherOf(second)).toBe("MJ-1404-000002");

    await expect(
      voucherService.renumberEntry({
        businessId: biz.id,
        entryId: first,
        newSequenceNo: 3,
        reason: "   ",
        actorId: user.id,
      }),
    ).rejects.toThrow("reason_required");

    await expect(
      voucherService.renumberEntry({
        businessId: biz.id,
        entryId: first,
        newSequenceNo: 2,
        reason: "برای شمارهٔ گرفته",
        actorId: user.id,
      }),
    ).rejects.toThrow("voucher_number_taken");

    await expect(
      voucherService.renumberEntry({
        businessId: biz.id,
        entryId: first,
        newSequenceNo: 7,
        newReference: "بد فضا",
        reason: "رفرنس نامعتبر",
        actorId: user.id,
      }),
    ).rejects.toThrow("voucher_reference_invalid");

    await expect(
      voucherService.renumberEntry({
        businessId: biz.id,
        entryId: "00000000-0000-0000-0000-000000000000",
        newSequenceNo: 7,
        reason: "سند پیدا نشد",
        actorId: user.id,
      }),
    ).rejects.toThrow("entry_not_found");

    expect(await voucherOf(first)).toBe("MJ-1404-000001");
  });
});

describe("summary vouchers", () => {
  it("aggregates a defined source set — traceable, idempotent, double-inclusion-proof", async () => {
    const juneOne = await post("2025-06-10", "manual", 10_000);
    const juneTwo = await post("2025-06-20", "manual", 20_000);
    await post("2025-07-05", "manual", 30_000);

    const before = (await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1",
      [biz.id],
    )).rows[0].n;

    const summary = await voucherService.generateSummaryVoucher({
      businessId: biz.id,
      label: "خلاصه اسناد دستی خرداد",
      scope: { sourceTypes: ["manual"], from: "2025-06-01", to: "2025-06-30" },
      idempotencyKey: "summary-june",
      actorId: user.id,
    });
    expect(summary.voucherNumber).toBe("SV-1404-000001");
    expect(summary.entryCount).toBe(2);
    expect(summary.totalDebit).toBe("30000");
    expect(summary.totalCredit).toBe("30000");
    expect(summary.idempotent).toBe(false);

    // The journal detail is untouched — same entries, same numbers.
    const after = (await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1",
      [biz.id],
    )).rows[0].n;
    expect(after).toBe(before);
    expect(await voucherOf(juneOne)).toBe("MJ-1404-000001");

    // The detail screen traces every source back to its own number.
    const detail = await voucherService.getSummaryVoucher(biz.id, summary.id);
    expect(detail?.sources).toHaveLength(2);
    expect(detail?.sources.map((s) => s.entryVoucherNumber)).toEqual(["MJ-1404-000001", "MJ-1404-000002"]);
    expect((await voucherService.listSummaryVouchers(biz.id))).toHaveLength(1);

    // A retry with the same key returns the original — no second voucher.
    const retry = await voucherService.generateSummaryVoucher({
      businessId: biz.id,
      label: "خلاصه اسناد دستی خرداد",
      scope: { sourceTypes: ["manual"], from: "2025-06-01", to: "2025-06-30" },
      idempotencyKey: "summary-june",
      actorId: user.id,
    });
    expect(retry.idempotent).toBe(true);
    expect(retry.id).toBe(summary.id);
    expect((await voucherService.listSummaryVouchers(biz.id))).toHaveLength(1);

    // An entry already summarised cannot enter a second summary voucher.
    await expect(
      voucherService.generateSummaryVoucher({
        businessId: biz.id,
        label: "مجموعهٔ دوم",
        scope: { entryIds: [juneOne] },
        actorId: user.id,
      }),
    ).rejects.toThrow("entries_already_summarised");

    // A scope with no constraint is refused — "everything" is not a defined set.
    await expect(
      voucherService.generateSummaryVoucher({
        businessId: biz.id,
        label: "همه",
        scope: {},
        actorId: user.id,
      }),
    ).rejects.toThrow("scope_invalid");

    // An empty range is not a summary.
    await expect(
      voucherService.generateSummaryVoucher({
        businessId: biz.id,
        label: "خالی",
        scope: { sourceTypes: ["manual"], from: "2025-12-01", to: "2025-12-31" },
        actorId: user.id,
      }),
    ).rejects.toThrow("scope_empty");
  });
});

describe("the reviewed register fixes", () => {
  async function postMemo(entryDate: string, memo: string, amount = 10_000): Promise<string> {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const entryId = await ledgerService.postJournalEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        entryDate,
        memo,
        sourceType: "manual",
        sourceId: null,
        createdBy: user.id,
        lines: [
          { accountId: acct["5100"], debit: amount, credit: 0 },
          { accountId: acct["1100"], debit: 0, credit: amount },
        ],
      });
      await client.query("COMMIT");
      return entryId as string;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  it("search matches the number OR the memo — the pattern is bound to both ILIKEs", async () => {
    await postMemo("2025-06-10", "اجاره دفتر");
    await postMemo("2025-06-11", "برق تابستانه");
    await postMemo("2025-06-12", "کرایه خودرو");

    const byMemo = await voucherService.listVoucherRegister(biz.id, { search: "برق" });
    expect(byMemo.total).toBe(1);
    expect(byMemo.rows[0].voucherNumber).toBe("MJ-1404-000002");
    expect(byMemo.rows[0].memo).toBe("برق تابستانه");

    // The other side of the OR: a fragment of the number itself.
    const byNumber = await voucherService.listVoucherRegister(biz.id, { search: "000003" });
    expect(byNumber.total).toBe(1);
    expect(byNumber.rows[0].memo).toBe("کرایه خودرو");

    const none = await voucherService.listVoucherRegister(biz.id, { search: "نه‌چنین" });
    expect(none.total).toBe(0);
  });

  it("fetches the complete filtered register page by page, capped at a page boundary", async () => {
    // 450 legacy rows (unnumbered) inside 1404; the register backfills before it reads.
    await db.query(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, created_by)
       SELECT $1, $2, DATE '2025-04-01' + (i % 320), 'دوره آزمایشی ' || i, 'manual', $3
         FROM generate_series(1, 450) AS i`,
      [biz.id, biz.locationId, user.id],
    );
    for (const [accountId, debit, credit] of [
      [acct["5100"], 100, 0],
      [acct["1100"], 0, 100],
    ] as const) {
      await db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
         SELECT je.id, $1, $2, $3 FROM journal_entries je
          WHERE je.business_id = $4 AND je.source_type = 'manual'`,
        [accountId, debit, credit, biz.id],
      );
    }

    const all = await voucherService.fetchAllVoucherRegisterRows(biz.id, { sourceType: "manual" });
    expect(all).toHaveLength(450);
    const seqs = all.map((r) => r.sequenceNo);
    expect(seqs[0]).toBe(1);
    expect(seqs[449]).toBe(450);
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1];
      if (prev === null || prev === undefined) throw new Error("register row arrived unnumbered");
      expect(seqs[i]).toBe(prev + 1);
    }

    // The hard cap stops the stream at a page boundary (200-row pages), never mid-page.
    const capped = await voucherService.fetchAllVoucherRegisterRows(biz.id, { sourceType: "manual" }, 400);
    expect(capped).toHaveLength(400);
    const lastCapped = capped[399];
    expect(lastCapped?.sequenceNo).toBe(400);
  });

  it("counts an allocated-but-unheld number as a gap, not just a counter readout", async () => {
    await postMemo("2025-06-15", "پایه‌ای");
    // An in-flight posting reserved up to 7 and died before commit: the range is
    // allocated, the rows are unheld, and renumbering may never hand 2..7 out again.
    await db.query(
      `UPDATE voucher_sequences SET last_number = 7
        WHERE business_id = $1 AND fiscal_year_label = '1404' AND document_type = 'manual'`,
      [biz.id],
    );

    const report = await voucherService.voucherGapReport(biz.id, {
      fiscalYearLabel: "1404",
      documentType: "manual",
    });
    expect(report.counterMax).toBe(7);
    expect(report.presentCount).toBe(1);
    expect(report.gapCount).toBe(6);
    expect(report.missing).toEqual([2, 3, 4, 5, 6, 7]);
  });
});
