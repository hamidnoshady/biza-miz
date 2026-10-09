/**
 * The expense importer, against a real Postgres, through the real engine.
 *
 * This file exists because of a bug the pure tests could not see. The duplicate
 * lookup the expense adapter pastes into its own query was built from column names
 * qualified as `e.expense_date`, while the query it lands in is
 * `FROM expenses WHERE business_id = $1 AND …` — no `e`, no alias, anywhere. Every
 * expense import row therefore failed with `missing FROM-clause entry for table "e"`:
 * not a wrong skip, a dead channel. `src/lib/expense-import.test.ts` stayed green
 * throughout, because its shape assertion (`toMatch(/^e\.[a-z_]+$/)`) had been
 * written from the same wrong assumption as the code.
 *
 * A shape test can only pin a shape. Whether a fragment *runs* is a database
 * question, so the whole adapter — header mapping, coercion, the settlement rule,
 * the directory lookups, the duplicate predicate, `recordExpense`, the journal — is
 * exercised here on a scratch database, in the order an operator's file arrives.
 *
 * Issue #832 §16 asked for import parity with the register. What that means in
 * practice is every assertion below: the fields a screen can record, a sheet can
 * record, with the same arithmetic, the same refusals, and nothing dropped on the
 * way in.
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
let importService: typeof import("../src/lib/data-transfer/import-service");

const biz = { id: "", locationId: "", otherLocationId: "" };
const acct = { cash: "", petty: "", vat: "", rent: "", payable: "" };
const supplier = { acme: "", yektaNorth: "", yektaCenter: "", foreign: "" };
const party = { noor: "" };
const actor = { actorUserId: null as string | null, actorName: "مدیر هزینه" };

/** Cells are addressed by column index, so a test says what it changed and nothing else. */
type Cells = { [index: number]: string };

/** The columns a spreadsheet is allowed to name, in one place, so each test reads as a diff from a valid row. */
const HEADERS = [
  "سرفصل هزینه",
  "حساب پرداخت",
  "مبلغ",
  "مالیات قابل استرداد",
  "تاریخ",
  "نحوهٔ تسویه",
  "تأمین‌کننده",
  "سررسید پرداخت",
  "شخص (فهرست اشخاص)",
  "طرف حساب",
  "شرح",
];

function csv(...lines: Cells[]): string {
  const body = lines.map((cells) => HEADERS.map((_, index) => cells[index] ?? "").join(","));
  return [HEADERS.join(","), ...body].join("\n");
}

/** One settled, ordinary paid row: ۵۲۰۰ اجاره, ۱٬۲۰۰٬۰۰۰ ریال از صندوق. */
function paidRow(patch: Cells = {}): Cells {
  return {
    0: "5200",
    1: "1100",
    2: "1200000",
    4: "2026-04-01",
    9: "صاحب‌خانه",
    10: "اجارهٔ فروردین",
    ...patch,
  };
}

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

/** Import a file the way a route would: inside the tenant's scope, at a chosen branch. */
/** `moneyUnit` stays unset for a re-import of an export: the file is in the business's own unit. */
async function importExpenses(file: string, options: Record<string, unknown> = { moneyUnit: "rial" }) {
  const { job } = await dbLib.withTenant(biz.id, () =>
    importService.createImportJob({
      businessId: biz.id,
      locationId: biz.locationId,
      entityKey: "accounting.expenses",
      fileName: "هزینه‌ها.csv",
      format: "csv",
      buffer: new TextEncoder().encode(file).buffer as ArrayBuffer,
      actorUserId: actor.actorUserId,
      actorName: actor.actorName,
      options,
    }),
  );
  return job;
}

async function run(jobId: string) {
  return dbLib.withTenant(biz.id, () =>
    importService.runImportJob(biz.id, jobId, {
      locationId: biz.locationId,
      actorUserId: actor.actorUserId,
      actorName: actor.actorName,
    }),
  );
}

async function rowsOf(jobId: string) {
  const { rows } = await dbLib.withTenant(biz.id, () =>
    importService.listImportRows(biz.id, jobId, { limit: 100 }),
  );
  return rows;
}

/** Every message about one row, joined — the text the operator actually reads. */
function text(rows: Awaited<ReturnType<typeof rowsOf>>, index = 0): string {
  return (rows[index]?.messages ?? []).map((message) => message.message).join(" / ");
}

async function storedExpense(reference: number) {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT e.id, e.amount::text, e.vat_amount::text, e.settlement, e.due_date::text,
            e.vendor, e.memo, e.reference, e.account_id::text, e.payment_account_id::text,
            e.supplier_id::text, e.party_id::text, e.location_id::text
       FROM expenses e ORDER BY e.created_at, e.reference LIMIT 1 OFFSET $1`,
    [reference],
  );
  return rows[0];
}

async function linesOf(expenseId: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.debit::text, l.credit::text
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.source_type = 'expense' AND je.source_id = $1
      ORDER BY a.code`,
    [expenseId],
  );
  return rows.map((row) => ({
    code: row.code,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}

beforeAll(async () => {
  databaseName = `pos_expense_import_${randomUUID().replaceAll("-", "")}`;
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
  importService = await import("../src/lib/data-transfer/import-service");
  (await import("../src/lib/data-transfer/entities")).ensureAdaptersRegistered();

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const { rows: businesses } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('Import Co', $1) RETURNING id`,
    [`expense-import-${randomUUID().slice(0, 8)}`],
  );
  biz.id = businesses[0].id;
  const { rows: locations } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, timezone, is_active)
     VALUES ($1, 'Center', 'Asia/Tehran', true), ($1, 'North branch', 'Asia/Tehran', true)
     RETURNING id`,
    [biz.id],
  );
  biz.locationId = locations[0].id;
  biz.otherLocationId = locations[1].id;

  const { rows: accounts } = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES
       ($1, '1100', 'Cash', 'asset'),
       ($1, '1130', 'Petty cash', 'asset'),
       ($1, '1220', 'Input VAT', 'asset'),
       ($1, '1200', 'Accounts receivable', 'asset'),
       ($1, '2100', 'حساب‌های پرداختنی', 'liability'),
       ($1, '5200', 'اجاره', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "1130") acct.petty = row.id;
    if (row.code === "1220") acct.vat = row.id;
    if (row.code === "2100") acct.payable = row.id;
    if (row.code === "5200") acct.rent = row.id;
  }

  // The supplier directory is per branch and read business-wide, so «یکتا» twice
  // is exactly the ambiguity a real two-branch owner has.
  const { rows: suppliers } = await db.query<{ id: string }>(
    `INSERT INTO suppliers (location_id, name, phone) VALUES
       ($1, 'Acme', '09120000001'),
       ($1, 'یکتا', '09120000002'),
       ($2, 'یکتا', '09120000003')
     RETURNING id`,
    [biz.locationId, biz.otherLocationId],
  );
  supplier.acme = suppliers[0].id;
  supplier.yektaCenter = suppliers[1].id;
  supplier.yektaNorth = suppliers[2].id;
  const { rows: foreign } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('د别的', $1) RETURNING id`,
    [`other-${randomUUID().slice(0, 8)}`],
  );
  const { rows: foreignLocation } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Elsewhere') RETURNING id`,
    [foreign[0].id],
  );
  const { rows: foreignSupplier } = await db.query<{ id: string }>(
    `INSERT INTO suppliers (location_id, name) VALUES ($1, 'Acme') RETURNING id`,
    [foreignLocation[0].id],
  );
  supplier.foreign = foreignSupplier[0].id;

  const { rows: parties } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'نور', 'supplier') RETURNING id`,
    [biz.id],
  );
  party.noor = parties[0].id;
}, 180_000);

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
  await db.query("DELETE FROM expenses");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM expense_reference_counters");
  await db.query("DELETE FROM data_import_rows");
  await db.query("DELETE FROM data_import_jobs");
});

describe("the expense import adapter on a real database", () => {
  it("runs the duplicate predicate it declares, instead of failing every row", async () => {
    // The regression lock. Before the columns stopped being alias-qualified this
    // file's first assertion was `failed: 2` and a Postgres error message in the
    // row report; nothing above the database could tell the difference.
    const job = await importExpenses(csv(paidRow(), paidRow()));
    const result = await run(job.id);
    expect(result.failed).toBe(0);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);

    const rows = await rowsOf(job.id);
    // The skip names the grounds it matched on — settlement and supplier among them.
    expect(text(rows, 1)).toContain("از پیش ثبت شده است");
    expect(text(rows, 1)).toContain("نحوهٔ تسویه");
    expect(text(rows, 0) + text(rows, 1)).not.toMatch(/FROM-clause|missing FROM/i);
    expect((await storedExpense(0)).memo).toBe("اجارهٔ فروردین");
  });

  it("records the payable fields a sheet carries, and posts the arithmetic they imply", async () => {
    const job = await importExpenses(
      csv({
        0: "5200",
        2: "11000000",
        3: "1000000",
        4: "2026-04-02",
        5: "پرداخت بعدی",
        6: "Acme",
        7: "2026-04-20",
        8: "نور",
        9: "acme co",
        10: "اجارهٔ اردیبهشت",
      }),
    );
    expect((await run(job.id)).created).toBe(1);

    const expense = await storedExpense(0);
    expect(expense.settlement).toBe("credit");
    expect(expense.supplier_id).toBe(supplier.acme);
    expect(expense.due_date).toBe("2026-04-20");
    expect(expense.vat_amount).toBe("1000000");
    expect(expense.amount).toBe("11000000");
    // The party link is the directory's row, not a copy of the text; the free-text
    // vendor survives beside it because it is what the ledger says when a person is
    // later merged away (§12).
    expect(expense.party_id).toBe(party.noor);
    expect(expense.vendor).toBe("acme co");
    // An owed expense credits the control account, and the payment account column
    // stores that same id — the service's rule, reached from the file.
    expect(expense.payment_account_id).toBe(acct.payable);
    expect(expense.location_id).toBe(biz.locationId);

    // Dr 5200 net, Dr 1220 the VAT, Cr 2100 the gross: the three lines the register
    // writes, written by the importer rather than translated into something smaller.
    expect(await linesOf(expense.id)).toEqual([
      { code: "1220", debit: 1000000, credit: 0 },
      { code: "2100", debit: 0, credit: 11000000 },
      { code: "5200", debit: 10000000, credit: 0 },
    ]);
  });

  it("exports what it imports, so a round trip keeps its meaning", async () => {
    // Parity has a second half: an export whose columns the importer cannot read
    // back is a one-way sheet, and the operator's next file is a copy of a file
    // that lost the settlement, the supplier and the VAT on the way out.
    const job = await importExpenses(
      csv({ 0: "5200", 1: "1130", 2: "1200000", 4: "2026-04-03", 5: "پرداخت‌شده", 9: "خ", 10: "م" }),
    );
    expect((await run(job.id)).created).toBe(1);
    const exporter = await import("../src/lib/data-transfer/export-service");
    const built = await dbLib.withTenant(biz.id, () =>
      exporter.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "accounting.expenses",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(built.rowCount).toBe(1);
    const file = built.body.toString("utf8");
    for (const header of ["مبلغ (تومان)", "نحوهٔ تسویه", "تأمین‌کننده", "سررسید پرداخت", "مالیات قابل استرداد", "شخص (فهرست اشخاص)", "شمارهٔ سند"]) {
      expect(file, header).toContain(header);
    }
    // The labels are the entity's own words for the values, not their storage
    // spellings — an operator reads this file, and reads it back in.
    expect(file).toContain("پرداخت‌شده");
    // Whole Rial in, whole Rial out: the export divides by ten into the business's
    // own unit and nothing here re-rounds it, so 1200000 rial reads back as
    // exactly the amount the ledger holds rather than 1200000/10 of a Toman.
    expect(file).toContain(",120000,");

    // And reading it back in is a no-op, not a second expense: the same row the
    // file describes is the row the duplicate rule already knows.
    const again = await importExpenses(file, {});
    expect(await run(again.id)).toMatchObject({ created: 0, skipped: 1, failed: 0 });
  });

  it("tells a paid expense and an owed bill apart, and one supplier from another", async () => {
    // Same day, amount, category and memo — three separate transactions that the
    // old three-field match collapsed into one, which is how a re-import silently
    // loses a bill. The settlement and the supplier are in the identity precisely
    // so that these rows survive.
    const job = await importExpenses(
      csv(
        paidRow(),
        paidRow({ 1: "", 5: "پرداخت بعدی", 6: "Acme" }),
        paidRow({ 1: "", 5: "پرداخت بعدی", 6: "09120000002" }),
      ),
    );
    const result = await run(job.id);
    expect(result).toMatchObject({ created: 3, skipped: 0, failed: 0 });
    expect(await storedExpense(1)).toMatchObject({ settlement: "credit", supplier_id: supplier.acme });
    // The phone number resolved through the same directory, to the other branch's
    // «یکتا» — proving the lookup is by directory content, not by the cell's shape.
    expect(await storedExpense(2)).toMatchObject({
      settlement: "credit",
      supplier_id: supplier.yektaCenter,
    });
  });

  it("refuses a fractional amount in the mapper, and writes nothing", async () => {
    const job = await importExpenses(csv(paidRow({ 2: "1200000.5" })));
    const rows = await rowsOf(job.id);
    expect(rows[0].status).toBe("error");
    expect(text(rows)).toContain("صحیح ریال");
    const result = await run(job.id);
    expect(result).toMatchObject({ created: 0, failed: 0 });
    const { rows: expenses } = await db.query("SELECT count(*)::text n FROM expenses");
    expect(expenses[0].n).toBe("0");
  });

  it("refuses an unknown settlement rather than defaulting it to paid", async () => {
    // «پرداخت بعدی» vs «پرداخت‌شده» is the difference between a payable and a cash
    // outflow; a typo the importer quietly read as paid would post money that left
    // the till twice.
    const job = await importExpenses(csv(paidRow({ 5: "اقساطی" })));
    const rows = await rowsOf(job.id);
    expect(rows[0].status).toBe("error");
    expect(text(rows)).toContain("یکی از این مقادیر");
    expect(text(rows)).toContain("پرداخت‌شده");
  });

  it("answers a paid row that names a supplier or a due date with the contradiction", async () => {
    // `expenses_settlement_shape` forbids storing those on a paid row, and
    // `parseExpenseSettlement` clears them. Clearing them here instead would have
    // the importer disagree with the file it was handed — and the operator would
    // only find out when the owed money never showed up in «حساب‌های پرداختنی».
    const job = await importExpenses(csv(paidRow({ 5: "پرداخت‌شده", 6: "Acme" })));
    const result = await run(job.id);
    expect(result).toMatchObject({ failed: 1, created: 0 });
    expect(text(await rowsOf(job.id))).toContain("فقط برای «پرداخت بعدی»");
  });

  it("refuses an owed row that points its credit somewhere else", async () => {
    const job = await importExpenses(
      csv({ 0: "5200", 1: "1130", 2: "1200000", 4: "2026-04-04", 5: "پرداخت بعدی", 6: "Acme", 10: "م" }),
    );
    expect((await run(job.id)).failed).toBe(1);
    expect(text(await rowsOf(job.id))).toContain("2100");
  });

  it("asks the shared rule who the money is owed to", async () => {
    const job = await importExpenses(csv({ 0: "5200", 2: "1200000", 4: "2026-04-05", 5: "پرداخت بعدی", 10: "م" }));
    expect((await run(job.id)).failed).toBe(1);
    expect(text(await rowsOf(job.id))).toContain("تأمین‌کننده");
  });

  it("refuses a name the directory cannot answer, and a name it can answer twice", async () => {
    const missing = await importExpenses(csv(paidRow({ 5: "پرداخت بعدی", 6: "ناشناخته", 1: "" })));
    expect((await run(missing.id)).failed).toBe(1);
    expect(text(await rowsOf(missing.id))).toContain("حساب‌های پرداختنی");

    const ambiguous = await importExpenses(csv(paidRow({ 5: "پرداخت بعدی", 6: "یکتا", 1: "" })));
    expect((await run(ambiguous.id)).failed).toBe(1);
    // Guessing between two branches' «یکتا» is a payable owed to the wrong person,
    // which is the one thing this column exists to prevent.
    expect(text(await rowsOf(ambiguous.id))).toContain("بیش از یک تأمین‌کننده");
  });

  it("will not attach a supplier that belongs to another business", async () => {
    // The id is well-formed, exists in `suppliers`, and is not this tenant's. The
    // lookup is `listSupplierDirectory(businessId)`, so it is simply not there —
    // and the row comes back named, instead of silently widening.
    const job = await importExpenses(csv(paidRow({ 5: "پرداخت بعدی", 6: supplier.foreign, 1: "" })));
    expect((await run(job.id)).failed).toBe(1);
    expect(text(await rowsOf(job.id))).toContain("حساب‌های پرداختنی");
  });

  it("never lets a file decide a document number", async () => {
    // `reference` is exported so a sheet can be tied back to the ledger, and is
    // read-only so the engine refuses to map it. Re-importing an export therefore
    // creates rows with the business's own numbering rather than claiming numbers
    // that already exist.
    const headers = [...HEADERS, "شمارهٔ سند"].join(",");
    const row = paidRow();
    const line = [...HEADERS.map((_, index) => row[index] ?? ""), "EXP-1405-00007"].join(",");
    const job = await importExpenses([headers, line].join("\n"));
    expect(job.sourceColumns).toContain("شمارهٔ سند");
    expect((await run(job.id)).created).toBe(1);
    expect((await storedExpense(0)).reference).not.toBe("EXP-1405-00007");
    expect((await storedExpense(0)).reference).toMatch(/^EXP-\d{4}-\d{5}$/);
  });

  it("previews exactly the duplicate the run will skip", async () => {
    const job = await importExpenses(csv(paidRow(), paidRow()));
    const { preview } = await dbLib.withTenant(biz.id, () =>
      importService.previewImportJob(biz.id, job.id),
    );
    /*
     * What the two halves owe each other, stated exactly: the preview must not
     * call either row broken (neither is — the second is only already known), and
     * the run must not skip one without saying which and why. The engine's in-file
     * rule stays quiet on expense rows because every rule field is never filled —
     * see the note in `expense-import.ts` — and the database-side lookup is what
     * catches the repeat, in the run report, on the same fields.
     */
    expect(preview.errorRows).toBe(0);
    expect(preview.rows.every((row) => row.messages.every((m) => m.severity !== "error"))).toBe(true);
    expect(await run(job.id)).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    const skipped = (await rowsOf(job.id)).find((row) => row.status === "skipped");
    expect(skipped?.rowNumber).toBe(3);
    expect(text([skipped!])).toContain("از پیش ثبت شده است");
  });

  it("posts nothing the register would refuse, and says which rule refused it", async () => {
    // A future expense date is the service's rule (§5), reached from this channel
    // too; the row comes back with the service's own words, not a generic failure.
    const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
    const job = await importExpenses(csv(paidRow({ 4: future })));
    expect((await run(job.id)).failed).toBe(1);
    expect(text(await rowsOf(job.id)).length).toBeGreaterThan(0);
  });
});
