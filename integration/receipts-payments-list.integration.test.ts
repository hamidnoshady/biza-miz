/**
 * «دریافت‌ها / پرداخت‌ها» — the voucher lists behind the ledger's receipts and
 * payments slice. The search used to run in JavaScript after pulling the whole
 * table (and matched the raw string), so typing Arabic-script «علي» missed a
 * customer stored with Persian «علی», and «%» swallowed the entire list as a
 * LIKE wildcard. The filter now runs in SQL with the same normalization the
 * app's pickers use and with wildcards escaped — this pins both.
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
let installments: typeof import("../src/lib/installments-service");
let ar: typeof import("../src/lib/ar-service");
let ap: typeof import("../src/lib/ap-service");

const biz = { id: "", locationId: "" };

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
  databaseName = `pos_vouchers_${randomUUID().replaceAll("-", "")}`;

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
  installments = await import("../src/lib/installments-service");
  ar = await import("../src/lib/ar-service");
  ap = await import("../src/lib/ap-service");

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

async function addCustomer(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, is_active) VALUES ($1, $2, 'customer', true) RETURNING id`,
    [biz.id, name],
  );
  return rows[0].id;
}

async function addReceipt(customerId: string, amount: number, date: string, memo: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ar_receipts (business_id, customer_id, receipt_date, method, amount, memo, idempotency_key)
     VALUES ($1, $2, $3, 'cash', $4, $5, $6) RETURNING id`,
    [biz.id, customerId, date, amount, memo, randomUUID()],
  );
  return rows[0].id;
}

async function addSupplier(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO suppliers (location_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [biz.locationId, name],
  );
  return rows[0].id;
}

async function addPayment(supplierId: string, amount: number, date: string, memo: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ap_payments (business_id, supplier_id, payment_date, method, amount, memo)
     VALUES ($1, $2, $3, 'bank', $4, $5) RETURNING id`,
    [biz.id, supplierId, date, amount, memo],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM ar_receipts");
  await db.query("DELETE FROM ap_payments");
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Voucher Co', $1) RETURNING id",
    [`vouchers-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
});

describe("listReceiptsPage search", () => {
  it("lists every receipt newest-first, regardless of party", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("سارا محمدی");
    await addReceipt(a, 100, "2026-09-10", null);
    await addReceipt(b, 200, "2026-09-15", "تسویه");
    await addReceipt(a, 300, "2026-09-16", null);

    const rows = (await installments.listReceiptsPage(biz.id, {})).rows;
    expect(rows.map((r) => r.amount)).toEqual([300, 200, 100]);
    expect(rows[1].partyName).toBe("سارا محمدی");
  });

  it("filters by party name and by memo", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("سارا محمدی");
    await addReceipt(a, 100, "2026-09-10", "بابت فاکتور ۱۲");
    await addReceipt(b, 200, "2026-09-11", "پیش‌پرداخت");

    expect((await installments.listReceiptsPage(biz.id, { q: "علی" })).rows.map((r) => r.amount)).toEqual([100]);
    expect((await installments.listReceiptsPage(biz.id, { q: "پیش‌پرداخت" })).rows.map((r) => r.amount)).toEqual([200]);
    expect((await installments.listReceiptsPage(biz.id, { q: "چیزی که نیست" })).rows).toEqual([]);
  });

  it("folds Arabic ي/ك and both digit sets, like the app's pickers do", async () => {
    // Stored with Persian letters; searched with Arabic-script ones.
    const a = await addCustomer("علی کریمی");
    await addReceipt(a, 100, "2026-09-10", "فیش ۶۰۳۷");
    await addReceipt(a, 200, "2026-09-11", null);

    // Both rows match on the name alone; the order stays newest-first.
    expect((await installments.listReceiptsPage(biz.id, { q: "علي كر" })).rows.map((r) => r.amount)).toEqual([200, 100]);
    // The memo holds Persian digits; the Latin-digit needle must still find it.
    expect((await installments.listReceiptsPage(biz.id, { q: "6037" })).rows.map((r) => r.amount)).toEqual([100]);
    expect((await installments.listReceiptsPage(biz.id, { q: "۶۰۳۷" })).rows.map((r) => r.amount)).toEqual([100]);
  });

  it("treats LIKE wildcards as literals, not patterns", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("شرکت 100% بازرگانی");
    await addReceipt(a, 100, "2026-09-10", "تسویه");
    await addReceipt(b, 200, "2026-09-10", "تخفیف 50%");

    // «%» must not become the match-everything wildcard — only the literal hit lists.
    expect((await installments.listReceiptsPage(biz.id, { q: "%" })).rows.map((r) => r.amount)).toEqual([200]);
    // …even when the needle is typed with Persian digits (folded to Latin first).
    expect((await installments.listReceiptsPage(biz.id, { q: "۵۰%" })).rows.map((r) => r.amount)).toEqual([200]);
    // «_» in the needle is a literal too — it would otherwise match «علی رضایی».
    expect((await installments.listReceiptsPage(biz.id, { q: "ع_ی" })).rows).toEqual([]);
  });
});

describe("listPaymentsPage search", () => {
  it("lists payments and resolves the supplier alias name", async () => {
    const s = await addSupplier("پخش مواد غذایی آسمان");
    await addPayment(s, 900, "2026-09-09", "قبوض شهریور");
    await addPayment(s, 400, "2026-09-16", null);

    const rows = (await installments.listPaymentsPage(biz.id, {})).rows;
    expect(rows.map((r) => r.amount)).toEqual([400, 900]);
    expect(rows[0].partyName).toBe("پخش مواد غذایی آسمان");

    expect((await installments.listPaymentsPage(biz.id, { q: "آسمان" })).rows.map((r) => r.amount)).toEqual([400, 900]);
    expect((await installments.listPaymentsPage(biz.id, { q: "قبوض" })).rows.map((r) => r.amount)).toEqual([900]);
  });
});

describe("listReceiptsPage (issue #829: cursor pagination + filters)", () => {
  it("pages newest-first without overlap or gaps", async () => {
    const a = await addCustomer("علی رضایی");
    for (let i = 1; i <= 5; i += 1) {
      await addReceipt(a, i * 100, `2026-09-0${i}`, null);
    }

    const first = await installments.listReceiptsPage(biz.id, { limit: 2 });
    expect(first.rows.map((r) => r.amount)).toEqual([500, 400]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await installments.listReceiptsPage(biz.id, { limit: 2, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.amount)).toEqual([300, 200]);
    expect(second.hasMore).toBe(true);

    const third = await installments.listReceiptsPage(biz.id, { limit: 2, cursor: second.nextCursor });
    expect(third.rows.map((r) => r.amount)).toEqual([100]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it("filters by date range, amount range, method and status", async () => {
    const a = await addCustomer("علی رضایی");
    const cashId = await addReceipt(a, 100, "2026-09-10", null);
    await db.query(`UPDATE ar_receipts SET method = 'bank' WHERE id = $1`, [cashId]);
    await addReceipt(a, 500, "2026-09-20", null);
    const reversedId = await addReceipt(a, 900, "2026-09-25", null);
    // reversal_entry_id is a real FK: point it at a real (stub) journal entry.
    const { rows: entryRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
       VALUES ($1, '2026-09-26', 'stub reversal', 'ar_receipt', $2) RETURNING id`,
      [biz.id, reversedId],
    );
    await db.query(`UPDATE ar_receipts SET reversed_at = now(), reversal_entry_id = $2 WHERE id = $1`, [
      reversedId,
      entryRows[0].id,
    ]);

    const byDate = await installments.listReceiptsPage(biz.id, { dateFrom: "2026-09-15", dateTo: "2026-09-30" });
    expect(byDate.rows.map((r) => r.amount).sort()).toEqual([500, 900]);

    const byAmount = await installments.listReceiptsPage(biz.id, { minAmount: 400, maxAmount: 600 });
    expect(byAmount.rows.map((r) => r.amount)).toEqual([500]);

    const byMethod = await installments.listReceiptsPage(biz.id, { method: "bank" });
    expect(byMethod.rows.map((r) => r.amount)).toEqual([100]);

    const active = await installments.listReceiptsPage(biz.id, { status: "active" });
    expect(active.rows.map((r) => r.amount).sort()).toEqual([100, 500]);
    const reversed = await installments.listReceiptsPage(biz.id, { status: "reversed" });
    expect(reversed.rows.map((r) => r.amount)).toEqual([900]);
  });

  it("rejects an invalid cursor and invalid filters with 400 codes", async () => {
    await expect(installments.listReceiptsPage(biz.id, { cursor: "not-a-cursor" })).rejects.toThrow("invalid_cursor");
    await expect(installments.listReceiptsPage(biz.id, { dateFrom: "2026-13-99" })).rejects.toThrow("invalid_date_from");
    await expect(
      installments.listReceiptsPage(biz.id, { method: "cheque" as unknown as "cash" }),
    ).rejects.toThrow("invalid_method");
  });

  it("filters by the named cash account and reads its code/name", async () => {
    const a = await addCustomer("علی رضایی");
    const { rows: acctRows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'Bank', 'asset') RETURNING id`,
      [biz.id],
    );
    const withAccount = await addReceipt(a, 100, "2026-09-10", null);
    await addReceipt(a, 200, "2026-09-11", null);
    await db.query(`UPDATE ar_receipts SET cash_account_id = $2 WHERE id = $1`, [withAccount, acctRows[0].id]);

    const filtered = await installments.listReceiptsPage(biz.id, { cashAccountId: acctRows[0].id });
    expect(filtered.rows.map((r) => r.amount)).toEqual([100]);
    expect(filtered.rows[0].cashAccountId).toBe(acctRows[0].id);
    expect(filtered.rows[0].cashAccount).toEqual({ code: "1110", name: "Bank" });
    expect(filtered.rows[0].bankReference).toBeNull();
  });
});

describe("listPaymentsPage (issue #829: cursor pagination + filters)", () => {
  it("pages newest-first without overlap or gaps", async () => {
    const s = await addSupplier("پخش آسمان");
    for (let i = 1; i <= 4; i += 1) {
      await addPayment(s, i * 100, `2026-09-0${i}`, null);
    }

    const first = await installments.listPaymentsPage(biz.id, { limit: 3 });
    expect(first.rows.map((r) => r.amount)).toEqual([400, 300, 200]);
    expect(first.hasMore).toBe(true);

    const second = await installments.listPaymentsPage(biz.id, { limit: 3, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.amount)).toEqual([100]);
    expect(second.hasMore).toBe(false);
  });
});

/**
 * Seeds the cash/bank/clearing accounts plus the AR/AP offsets, and posts a
 * legacy original entry the way the pre-#829 writers did: a «بانکی» receipt
 * with no named account debited the 1120 clearing account, before the method
 * gained its own 1110 bank default. The voucher rows carry NULL choices, so
 * the only record of the money's path is this entry.
 */
async function addAccount(code: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, 'asset') RETURNING id`,
    [biz.id, code, name],
  );
  return rows[0].id;
}

async function postLegacyEntry(
  kind: "ar_receipt" | "ap_payment",
  sourceId: string,
  moneyAccountId: string,
  offsetAccountId: string,
  amount: number,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, source_type, source_id, posting_kind, memo)
     VALUES ($1, '2026-09-10', $2, $3, $2, 'legacy') RETURNING id`,
    [biz.id, kind, sourceId],
  );
  const entryId = rows[0].id;
  const money = kind === "ar_receipt" ? [amount, 0] : [0, amount];
  const offset = kind === "ar_receipt" ? [0, amount] : [amount, 0];
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
    [entryId, moneyAccountId, ...money, offsetAccountId, ...offset],
  );
}

describe("posted account resolution (issue #829 completion)", () => {
  it("shows a default-choice receipt's actual posted account from the journal, not today's default", async () => {
    const customer = await addCustomer("علی رضایی");
    await addAccount("1100", "صندوق");
    await addAccount("1110", "بانک");
    const clearing = await addAccount("1120", "تنخواه");
    const arAccount = await addAccount("1200", "دریافتنی");
    const receiptId = await addReceipt(customer, 1000, "2026-09-10", null);
    await postLegacyEntry("ar_receipt", receiptId, clearing, arAccount, 1000);

    // The list, the drill-down and the export inherit one read-model: 1120
    // from the entry, even though «بانکی» would resolve to 1110 today.
    const listed = await installments.listReceiptsPage(biz.id, {});
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0].cashAccount).toEqual({ code: "1120", name: "تنخواه" });
    expect((await ar.getReceiptDetail(biz.id, receiptId))?.cashAccount).toEqual({
      code: "1120",
      name: "تنخواه",
    });
    const exported = await collectExport(installments.iterateReceiptsForExport(biz.id, {}));
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0].cashAccount).toEqual({ code: "1120", name: "تنخواه" });
  });

  it("shows a default-choice payment's posted credit account", async () => {
    const supplier = await addSupplier("پخش آسمان");
    await addAccount("1110", "بانک");
    const clearing = await addAccount("1120", "تنخواه");
    const apAccount = await addAccount("2100", "پرداختنی");
    const paymentId = await addPayment(supplier, 2000, "2026-09-10", null);
    await postLegacyEntry("ap_payment", paymentId, clearing, apAccount, 2000);

    const listed = await installments.listPaymentsPage(biz.id, {});
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0].cashAccount).toEqual({ code: "1120", name: "تنخواه" });
    expect((await ap.getPaymentDetail(biz.id, paymentId))?.cashAccount).toEqual({
      code: "1120",
      name: "تنخواه",
    });
  });

  it("leaves entry-less legacy vouchers unresolved instead of guessing", async () => {
    const customer = await addCustomer("علی رضایی");
    const supplier = await addSupplier("پخش آسمان");
    await addAccount("1100", "صندوق");
    const receiptId = await addReceipt(customer, 1000, "2026-09-10", null);
    const paymentId = await addPayment(supplier, 2000, "2026-09-10", null);

    // No entry anywhere: the screen shows a dash, never today's default.
    expect((await installments.listReceiptsPage(biz.id, {})).rows[0].cashAccount).toBeNull();
    expect((await installments.listPaymentsPage(biz.id, {})).rows[0].cashAccount).toBeNull();
    expect((await ar.getReceiptDetail(biz.id, receiptId))?.cashAccount).toBeNull();
    expect((await ap.getPaymentDetail(biz.id, paymentId))?.cashAccount).toBeNull();
  });

  it("prefers the voucher's named account over the journal evidence", async () => {
    // Production postings never disagree — posting debits/credits the
    // resolved choice — so this pins the tiebreak order, not a live shape.
    const customer = await addCustomer("علی رضایی");
    const cash = await addAccount("1100", "صندوق");
    const clearing = await addAccount("1120", "تنخواه");
    const arAccount = await addAccount("1200", "دریافتنی");
    const receiptId = await addReceipt(customer, 1000, "2026-09-10", null);
    await db.query(`UPDATE ar_receipts SET cash_account_id = $2 WHERE id = $1`, [receiptId, cash]);
    await postLegacyEntry("ar_receipt", receiptId, clearing, arAccount, 1000);

    expect((await installments.listReceiptsPage(biz.id, {})).rows[0].cashAccount).toEqual({
      code: "1100",
      name: "صندوق",
    });
    expect((await ar.getReceiptDetail(biz.id, receiptId))?.cashAccount).toEqual({
      code: "1100",
      name: "صندوق",
    });
  });

  it("returns the detail creation timestamp as unambiguous UTC ISO", async () => {
    const customer = await addCustomer("علی رضایی");
    const supplier = await addSupplier("پخش آسمان");
    const receiptId = await addReceipt(customer, 1000, "2026-09-10", null);
    const paymentId = await addPayment(supplier, 2000, "2026-09-10", null);

    // `timestamptz::text` renders `+00`, which JS engines parse
    // inconsistently; the audit timestamp must parse everywhere.
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    expect((await ar.getReceiptDetail(biz.id, receiptId))?.createdAt).toMatch(iso);
    expect((await ap.getPaymentDetail(biz.id, paymentId))?.createdAt).toMatch(iso);
  });
});

/** Drains an export iterator the way the route's stream does, chunk by chunk. */
async function collectExport<T>(iterator: AsyncGenerator<T[], void, void>): Promise<{ chunks: number; rows: T[] }> {
  const rows: T[] = [];
  let chunks = 0;
  for await (const chunk of iterator) {
    chunks += 1;
    rows.push(...chunk);
  }
  return { chunks, rows };
}

describe("voucher CSV export queries (issue #829 completion)", () => {
  it("exports the full filtered receipt set, not the visible page", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("سارا محمدی");
    await addReceipt(a, 100, "2026-09-10", null);
    await addReceipt(b, 200, "2026-09-11", "پیش‌پرداخت");
    await addReceipt(a, 300, "2026-09-12", null);

    // No limit/cursor: the whole filtered set, newest first.
    const all = await collectExport(installments.iterateReceiptsForExport(biz.id, {}));
    expect(all.rows.map((r) => r.amount)).toEqual([300, 200, 100]);

    const filtered = await collectExport(installments.iterateReceiptsForExport(biz.id, { q: "پیش‌پرداخت", minAmount: 100 }));
    expect(filtered.rows.map((r) => r.amount)).toEqual([200]);
  });

  it("exports the full filtered payment set", async () => {
    const s = await addSupplier("پخش آسمان");
    await addPayment(s, 400, "2026-09-10", null);
    await addPayment(s, 900, "2026-09-11", "قبوض");

    const exported = await collectExport(installments.iteratePaymentsForExport(biz.id, { q: "قبوض" }));
    expect(exported.rows.map((r) => r.amount)).toEqual([900]);
  });

  it("streams every receipt past the old row cap, in the register's exact order, tenant-scoped", async () => {
    const a = await addCustomer("علی رضایی");
    // 20,001 vouchers in one statement — past any row count the old capped
    // export would have stopped at. Same transaction timestamp for all, so
    // the (date, created_at, id) cursor is exercised on ties too.
    await db.query(
      `INSERT INTO ar_receipts (business_id, customer_id, receipt_date, method, amount, memo, idempotency_key)
       SELECT $1, $2, '2026-01-01'::date + (g % 365), 'cash', 100 + g, NULL, 'bulk-receipt-' || g
         FROM generate_series(1, 20001) AS g`,
      [biz.id, a],
    );
    // Another tenant's rows must not leak into this business's file.
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherCustomer = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role, is_active) VALUES ($1, 'Other', 'customer', true) RETURNING id",
      [otherBiz.rows[0].id],
    );
    await db.query(
      `INSERT INTO ar_receipts (business_id, customer_id, receipt_date, method, amount, idempotency_key)
       VALUES ($1, $2, '2026-06-01', 'cash', 999, 'other-1')`,
      [otherBiz.rows[0].id, otherCustomer.rows[0].id],
    );

    const { chunks, rows } = await collectExport(installments.iterateReceiptsForExport(biz.id, {}));
    expect(chunks).toBeGreaterThan(1);
    expect(rows).toHaveLength(20_001);
    // The exact register order, id for id — no overlap or gap at any chunk
    // boundary — and nothing from the other tenant.
    const { rows: ordered } = await db.query<{ id: string }>(
      `SELECT id FROM ar_receipts WHERE business_id = $1
        ORDER BY receipt_date DESC, created_at DESC, id DESC`,
      [biz.id],
    );
    expect(rows.map((r) => r.id)).toEqual(ordered.map((r) => r.id));
  });

  it("streams every payment across chunk boundaries", async () => {
    const s = await addSupplier("پخش آسمان");
    await db.query(
      `INSERT INTO ap_payments (business_id, supplier_id, payment_date, method, amount, memo)
       SELECT $1, $2, '2026-01-01'::date + (g % 365), 'bank', 100 + g, NULL
         FROM generate_series(1, 2501) AS g`,
      [biz.id, s],
    );

    const { chunks, rows } = await collectExport(installments.iteratePaymentsForExport(biz.id, {}));
    expect(chunks).toBeGreaterThan(1);
    expect(rows).toHaveLength(2_501);
    const { rows: ordered } = await db.query<{ id: string }>(
      `SELECT id FROM ap_payments WHERE business_id = $1
        ORDER BY payment_date DESC, created_at DESC, id DESC`,
      [biz.id],
    );
    expect(rows.map((r) => r.id)).toEqual(ordered.map((r) => r.id));
  });

  it("reads one row past the internal page so `hasMore` stays exact for the iterator", async () => {
    const a = await addCustomer("علی رضایی");
    for (let i = 1; i <= 3; i += 1) {
      await addReceipt(a, i * 100, `2026-09-0${i}`, null);
    }
    // The paging mechanics the export relies on, at a provable size: the
    // internal page carries exactly its size and `hasMore` is exact.
    const capped = await installments.listReceiptsPage(biz.id, {}, { internalPageSize: 2 });
    expect(capped.rows.map((r) => r.amount)).toEqual([300, 200]);
    expect(capped.hasMore).toBe(true);
    const roomy = await installments.listReceiptsPage(biz.id, {}, { internalPageSize: 5 });
    expect(roomy.rows).toHaveLength(3);
    expect(roomy.hasMore).toBe(false);
    // The wire limit stays clamped to the page max no matter what is asked.
    const wire = await installments.listReceiptsPage(biz.id, { limit: 5000 });
    expect(wire.rows).toHaveLength(3);
    expect(wire.hasMore).toBe(false);
  });
});
