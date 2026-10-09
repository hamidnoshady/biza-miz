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
  await db.query("DELETE FROM ar_receipts");
  await db.query("DELETE FROM ap_payments");
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM locations");
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

describe("voucher CSV export queries (issue #829 completion)", () => {
  it("exports the full filtered receipt set, not the visible page", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("سارا محمدی");
    await addReceipt(a, 100, "2026-09-10", null);
    await addReceipt(b, 200, "2026-09-11", "پیش‌پرداخت");
    await addReceipt(a, 300, "2026-09-12", null);

    // No limit/cursor: the whole filtered set, newest first.
    const all = await installments.listReceiptsForExport(biz.id, {});
    expect(all.rows.map((r) => r.amount)).toEqual([300, 200, 100]);
    expect(all.truncated).toBe(false);

    const filtered = await installments.listReceiptsForExport(biz.id, { q: "پیش‌پرداخت", minAmount: 100 });
    expect(filtered.rows.map((r) => r.amount)).toEqual([200]);
    expect(filtered.truncated).toBe(false);
  });

  it("exports the full filtered payment set", async () => {
    const s = await addSupplier("پخش آسمان");
    await addPayment(s, 400, "2026-09-10", null);
    await addPayment(s, 900, "2026-09-11", "قبوض");

    const exported = await installments.listPaymentsForExport(biz.id, { q: "قبوض" });
    expect(exported.rows.map((r) => r.amount)).toEqual([900]);
    expect(exported.truncated).toBe(false);
  });

  it("signals truncation past the export cap instead of silently cutting rows", async () => {
    const a = await addCustomer("علی رضایی");
    for (let i = 1; i <= 3; i += 1) {
      await addReceipt(a, i * 100, `2026-09-0${i}`, null);
    }
    // The cap mechanics the export relies on, at a provable size: cap+1 rows
    // are read so `hasMore` is exact, and the page carries exactly the cap.
    const capped = await installments.listReceiptsPage(biz.id, {}, { exportCap: 2 });
    expect(capped.rows.map((r) => r.amount)).toEqual([300, 200]);
    expect(capped.hasMore).toBe(true);
    const roomy = await installments.listReceiptsPage(biz.id, {}, { exportCap: 5 });
    expect(roomy.rows).toHaveLength(3);
    expect(roomy.hasMore).toBe(false);
    // The wire limit can never reach the export cap: it clamps to the page max.
    const wire = await installments.listReceiptsPage(biz.id, { limit: 5000 });
    expect(wire.rows).toHaveLength(3);
    expect(wire.hasMore).toBe(false);
  });
});
