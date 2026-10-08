/**
 * Audit F11 (the non-payroll half) — an expense can be owed, a purchase carries
 * its supplier invoice with VAT, and a voucher names its cash/bank account and
 * the bank's reference. Every figure is asserted to the Rial against the
 * journal the existing posting paths wrote, and every entry must balance:
 *
 * - «پرداخت بعدی»: Debit expense / Credit A/P, attributed to the supplier in
 *   the A/P subledger, and settled by the ordinary `payBill`;
 * - a purchase's VAT: Debit inventory (goods) + Debit input VAT 1220 / Credit
 *   the settlement account (goods + VAT), which the VAT report reads;
 * - a voucher: the chosen cash/bank account takes the money instead of the
 *   method's default, and the reference is stored and listed.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";

/** The owner the purchase routes act as (the edit path is exercised through its real route). */
const session = vi.hoisted(() => ({ businessId: "", locationId: "", sub: "" }));

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  const granted = async () => ({
    session: { businessId: session.businessId, sub: session.sub, role: "owner" },
    error: null,
  });
  return {
    ...actual,
    requirePermission: vi.fn(granted),
    withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  };
});

vi.mock("../src/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn(async () => ({ id: session.locationId })) };
});

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let expenseService: typeof import("../src/lib/expense-service");
let apService: typeof import("../src/lib/ap-service");
let arService: typeof import("../src/lib/ar-service");
let purchaseService: typeof import("../src/lib/purchase-service");
let receiveService: typeof import("../src/lib/purchase-receive-service");
let reportsService: typeof import("../src/lib/reports-service");
let installments: typeof import("../src/lib/installments-service");
let returnService: typeof import("../src/lib/supplier-return-service");
let purchaseRoute: typeof import("../src/app/api/inventory/purchases/[id]/route");
let purchasesRoute: typeof import("../src/app/api/inventory/purchases/route");

const biz = { id: "", locationId: "", otherId: "", otherLocationId: "" };
const acct: Record<string, string> = {};
const user = { id: "" };
const supplier = { id: "", otherBusinessId: "" };
const customer = { id: "" };
const item = { id: "" };

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
  databaseName = `pos_f11_${randomUUID().replaceAll("-", "")}`;
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
  expenseService = await import("../src/lib/expense-service");
  apService = await import("../src/lib/ap-service");
  arService = await import("../src/lib/ar-service");
  purchaseService = await import("../src/lib/purchase-service");
  receiveService = await import("../src/lib/purchase-receive-service");
  reportsService = await import("../src/lib/reports-service");
  installments = await import("../src/lib/installments-service");
  returnService = await import("../src/lib/supplier-return-service");
  purchaseRoute = await import("../src/app/api/inventory/purchases/[id]/route");
  purchasesRoute = await import("../src/app/api/inventory/purchases/route");

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

const CHART: [string, string, string, string | null][] = [
  ["1100", "صندوق", "asset", null],
  ["1110", "بانک", "asset", null],
  ["1119", "بانک ملت", "asset", "1110"],
  ["1120", "کارت‌خوان در راه", "asset", null],
  ["1200", "حساب‌های دریافتنی", "asset", null],
  ["1220", "مالیات بر ارزش افزوده خرید", "asset", null],
  ["1300", "موجودی کالا", "asset", null],
  ["2100", "حساب‌های پرداختنی", "liability", null],
  ["2200", "مالیات بر ارزش افزوده پرداختنی", "liability", null],
  ["5100", "بهای تمام‌شده", "expense", null],
  ["5105", "خرید طی دوره", "expense", null],
  ["5200", "اجاره", "expense", null],
];

beforeEach(async () => {
  // A per-file database: wipe every tenant row (stock movements, lots and
  // events a receipt wrote included) by cascading from the business.
  await db.query("TRUNCATE businesses CASCADE");

  const bizRow = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('F11 Co', $1) RETURNING id", [
    `f11-${randomUUID().slice(0, 8)}`,
  ]);
  biz.id = bizRow.rows[0].id;
  biz.locationId = (await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [biz.id]))
    .rows[0].id;
  const other = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id", [
    `f11o-${randomUUID().slice(0, 8)}`,
  ]);
  biz.otherId = other.rows[0].id;
  biz.otherLocationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Elsewhere') RETURNING id", [biz.otherId])
  ).rows[0].id;

  user.id = (
    await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
      [biz.id],
    )
  ).rows[0].id;

  for (const [code, name, type, parent] of CHART) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type, parent_id)
       VALUES ($1, $2, $3, $4, (SELECT id FROM accounts WHERE business_id = $1 AND code = $5)) RETURNING id`,
      [biz.id, code, name, type, parent],
    );
    acct[code] = rows[0].id;
  }

  supplier.id = (
    await db.query<{ id: string }>("INSERT INTO suppliers (location_id, name, phone) VALUES ($1, 'Acme', '0912') RETURNING id", [
      biz.locationId,
    ])
  ).rows[0].id;
  supplier.otherBusinessId = (
    await db.query<{ id: string }>("INSERT INTO suppliers (location_id, name) VALUES ($1, 'Foreign') RETURNING id", [biz.otherLocationId])
  ).rows[0].id;
  customer.id = (
    await db.query<{ id: string }>("INSERT INTO parties (business_id, name, role) VALUES ($1, 'Buyer', 'customer') RETURNING id", [biz.id])
  ).rows[0].id;
  session.businessId = biz.id;
  session.locationId = biz.locationId;
  session.sub = user.id;
  item.id = (
    await db.query<{ id: string }>(`INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'Coffee', 'kg') RETURNING id`, [
      biz.locationId,
    ])
  ).rows[0].id;
});

async function entryLines(sourceType: string, sourceId: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
      WHERE je.source_type = $1 AND je.source_id = $2
      ORDER BY a.code, jl.debit DESC`,
    [sourceType, sourceId],
  );
  const debit = rows.reduce((s, r) => s + BigInt(r.debit), 0n);
  const credit = rows.reduce((s, r) => s + BigInt(r.credit), 0n);
  expect(debit).toBe(credit);
  return rows.map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }));
}

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe("expense «پرداخت بعدی»", () => {
  it("credits A/P for the supplier, ages as their bill, and is settled by the ordinary A/P payment", async () => {
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: biz.locationId,
      accountId: acct["5200"],
      paymentAccountId: "",
      amount: 7_500_000,
      expenseDate: "2026-09-01",
      memo: "اجارهٔ شهریور",
      createdBy: user.id,
      settlement: "credit",
      supplierId: supplier.id,
      dueDate: "2026-10-01",
    });
    expect(expense).toMatchObject({
      settlement: "credit",
      supplierId: supplier.id,
      supplierName: "Acme",
      dueDate: "2026-10-01",
      paymentAccountCode: "2100",
      amount: 7_500_000,
    });
    expect(await entryLines("expense", expense.id)).toEqual([
      { code: "2100", debit: 0, credit: 7_500_000 },
      { code: "5200", debit: 7_500_000, credit: 0 },
    ]);

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances).toEqual([expect.objectContaining({ supplierId: supplier.id, balance: 7_500_000 })]);
    const statement = await apService.getSupplierStatement(biz.id, supplier.id);
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({
      date: "2026-09-01",
      type: "bill",
      description: "اجارهٔ شهریور",
      debit: 0,
      credit: 7_500_000,
      balance: 7_500_000,
      sourceType: "expense",
    });

    // Settled later through the existing A/P payment path, from a chosen bank account with a reference.
    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank",
      amount: 7_500_000,
      paymentDate: "2026-09-20",
      clientRequestId: `f11-settle:${randomUUID()}`,
      createdBy: user.id,
      cashAccountId: acct["1119"],
      bankReference: "۸۸۷۷۶۶",
    });
    expect(payment).toMatchObject({ cashAccountId: acct["1119"], bankReference: "887766" });
    expect(await entryLines("ap_payment", payment.id)).toEqual([
      { code: "1119", debit: 0, credit: 7_500_000 },
      { code: "2100", debit: 7_500_000, credit: 0 },
    ]);
    expect(await apService.listSupplierBalances(biz.id)).toEqual([]);

    const listed = await expenseService.listExpenses(biz.id);
    expect(listed.totalAmount).toBe(7_500_000);
    expect(listed.expenses[0]).toMatchObject({ settlement: "credit", supplierName: "Acme" });
  });

  it("a paid expense is unchanged: cash/bank credited, no supplier, nothing on A/P", async () => {
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: biz.locationId,
      accountId: acct["5200"],
      paymentAccountId: acct["1100"],
      amount: 250_000,
      expenseDate: "2026-09-02",
      memo: "نظافت",
      createdBy: user.id,
    });
    expect(expense).toMatchObject({ settlement: "paid", supplierId: null, dueDate: null });
    expect(await entryLines("expense", expense.id)).toEqual([
      { code: "1100", debit: 0, credit: 250_000 },
      { code: "5200", debit: 250_000, credit: 0 },
    ]);
    expect(await apService.listSupplierBalances(biz.id)).toEqual([]);
  });

  it("refuses a credit expense without a supplier, or with another business's supplier, and posts nothing", async () => {
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      accountId: acct["5200"],
      paymentAccountId: "",
      amount: 100_000,
      memo: "x",
      createdBy: user.id,
      settlement: "credit" as const,
    };
    await expect(expenseService.recordExpense(base)).rejects.toMatchObject({ message: "supplier_required" });
    await expect(expenseService.recordExpense({ ...base, supplierId: supplier.otherBusinessId })).rejects.toMatchObject({
      message: "supplier_not_found",
      status: 404,
    });
    const { rows } = await db.query("SELECT 1 FROM journal_entries UNION ALL SELECT 1 FROM expenses");
    expect(rows).toHaveLength(0);
  });
});

describe("purchase supplier invoice and VAT", () => {
  async function draft(invoice: unknown, totalCost = "1000000") {
    return purchaseService.createDraftPurchase({
      locationId: biz.locationId,
      supplierId: supplier.id,
      purchaseDate: "2026-10-03",
      items: [{ inventoryItemId: item.id, purchaseQty: "10", totalCost }],
      createdBy: user.id,
      invoice,
    });
  }

  it("stores the invoice, derives the due date from the terms, and posts the VAT to input VAT on receipt", async () => {
    const { id } = await draft({
      invoiceNumber: "INV-۴۲",
      invoiceDate: "2026-10-01",
      vatAmount: 100_000,
      paymentTermsDays: 30,
    });
    const { rows } = await db.query(
      `SELECT supplier_invoice_number, supplier_invoice_date::text AS d, vat_amount::text AS vat, payment_terms_days, payment_due_date::text AS due, total::text AS total
         FROM purchases WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      supplier_invoice_number: "INV-42",
      d: "2026-10-01",
      vat: "100000",
      payment_terms_days: 30,
      due: "2026-10-31",
      total: "1000000",
    });

    await withClient((client) =>
      receiveService.receivePurchaseInTransaction(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: id,
        settlementMethod: "credit",
        createdBy: user.id,
      }),
    );
    expect(await entryLines("purchase", id)).toEqual([
      { code: "1220", debit: 100_000, credit: 0 },
      { code: "1300", debit: 1_000_000, credit: 0 },
      { code: "2100", debit: 0, credit: 1_100_000 },
    ]);
    expect(await apService.listSupplierBalances(biz.id)).toEqual([
      expect.objectContaining({ supplierId: supplier.id, balance: 1_100_000 }),
    ]);

    // The VAT report reads the same control account, so the purchase's VAT is input VAT.
    const report = await reportsService.getVatReport(biz.id, {});
    expect(report.inputVat).toBe(100_000);
    expect(report.vatReceivableBalance).toBe(100_000);
    expect(report.netPayable).toBe(-100_000);
  });

  it("an explicit due date wins over the terms, and an edit-free draft without an invoice posts exactly as before", async () => {
    const { id } = await draft({ paymentTermsDays: 10, dueDate: "2026-12-15" });
    const due = await db.query("SELECT payment_due_date::text AS due FROM purchases WHERE id = $1", [id]);
    expect(due.rows[0].due).toBe("2026-12-15");

    const plain = await draft(undefined, "500000");
    await withClient((client) =>
      receiveService.receivePurchaseInTransaction(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: plain.id,
        settlementMethod: "cash",
        createdBy: user.id,
      }),
    );
    expect(await entryLines("purchase", plain.id)).toEqual([
      { code: "1100", debit: 0, credit: 500_000 },
      { code: "1300", debit: 500_000, credit: 0 },
    ]);
    expect((await reportsService.getVatReport(biz.id, {})).inputVat).toBe(0);
  });

  it("a periodic-system purchase carries the VAT the same way", async () => {
    await db.query(`INSERT INTO settings (business_id, key, value) VALUES ($1, 'inventory.costing', '{"system":"periodic"}'::jsonb)`, [
      biz.id,
    ]);
    const { id } = await draft({ vatAmount: "90000" }, "1000000");
    await withClient((client) =>
      receiveService.receivePurchaseInTransaction(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: id,
        settlementMethod: "bank",
        createdBy: user.id,
      }),
    );
    expect(await entryLines("purchase", id)).toEqual([
      { code: "1120", debit: 0, credit: 1_090_000 },
      { code: "1220", debit: 90_000, credit: 0 },
      { code: "5105", debit: 1_000_000, credit: 0 },
    ]);
  });

  it("the edit route replaces the invoice block, keeps it when omitted, and the list offers the business's own VAT rate", async () => {
    await db.query(`INSERT INTO settings (business_id, key, value) VALUES ($1, 'tax.config', '{"defaultRate": 10}'::jsonb)`, [biz.id]);
    const { id } = await draft({ invoiceNumber: "A-1", vatAmount: 100_000 });
    const put = (body: unknown) =>
      purchaseRoute.PUT({ json: async () => body } as unknown as NextRequest, { params: Promise.resolve({ id }) });
    const items = [{ inventoryItemId: item.id, purchaseQty: "10", totalCost: "1000000" }];

    const edited = await put({ supplierId: supplier.id, items, invoice: { invoiceNumber: "B-2", vatAmount: 50_000, paymentTermsDays: 5 } });
    expect(edited.status).toBe(200);
    let row = (
      await db.query(
        "SELECT supplier_invoice_number AS n, vat_amount::text AS vat, payment_due_date::text AS due FROM purchases WHERE id = $1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ n: "B-2", vat: "50000", due: "2026-10-08" });

    expect((await put({ supplierId: supplier.id, items, note: "only the note" })).status).toBe(200);
    row = (await db.query("SELECT supplier_invoice_number AS n, vat_amount::text AS vat FROM purchases WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ n: "B-2", vat: "50000" });

    expect((await put({ supplierId: supplier.id, items, invoice: { vatAmount: -1 } })).status).toBe(400);

    const list = await purchasesRoute.GET({ url: "http://t/api/inventory/purchases" } as unknown as NextRequest);
    const data = (await list.json()) as { vatPercent: number; purchases: { id: string; vat_amount: string; supplier_invoice_number: string }[] };
    expect(data.vatPercent).toBe(10);
    expect(data.purchases.find((p) => p.id === id)).toMatchObject({ vat_amount: "50000", supplier_invoice_number: "B-2" });
  });

  it("rejects a malformed invoice before writing anything", async () => {
    await expect(draft({ vatAmount: -5 })).rejects.toMatchObject({ code: "invalid_vat_amount", status: 400 });
    await expect(draft({ invoiceDate: "2026-02-30" })).rejects.toMatchObject({ code: "invalid_invoice_date" });
    expect((await db.query("SELECT 1 FROM purchases")).rows).toHaveLength(0);
  });
});

describe("supplier return of a purchase that carried input VAT", () => {
  /** A received credit purchase of `qty` kg for `goods` Rial with `vat` on its invoice; returns its purchase item and lot. */
  async function receivedPurchase(qty: string, goods: string, vat: number) {
    const { id } = await purchaseService.createDraftPurchase({
      locationId: biz.locationId,
      supplierId: supplier.id,
      purchaseDate: "2026-10-03",
      items: [{ inventoryItemId: item.id, purchaseQty: qty, totalCost: goods }],
      createdBy: user.id,
      invoice: { vatAmount: vat },
    });
    await withClient((client) =>
      receiveService.receivePurchaseInTransaction(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: id,
        settlementMethod: "credit",
        createdBy: user.id,
      }),
    );
    const { rows } = await db.query<{ item_id: string; lot_id: string }>(
      `SELECT pi.id AS item_id, lot.id AS lot_id
         FROM purchase_items pi JOIN inventory_lots lot ON lot.source_type = 'purchase' AND lot.source_id = pi.purchase_id
        WHERE pi.purchase_id = $1`,
      [id],
    );
    return { purchaseId: id, purchaseItemId: rows[0].item_id, lotId: rows[0].lot_id };
  }

  async function giveBack(p: { purchaseId: string; purchaseItemId: string; lotId: string }, quantity: string) {
    return withClient((client) =>
      returnService.createSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: p.purchaseId,
        settlementMethod: "accounts_payable",
        reason: "معیوب",
        idempotencyKey: randomUUID(),
        createdBy: user.id,
        lines: [{ purchaseItemId: p.purchaseItemId, inventoryLotId: p.lotId, quantity: quantity as never }],
      }),
    );
  }

  async function balances() {
    const ap = (await apService.listSupplierBalances(biz.id)).find((s) => s.supplierId === supplier.id)?.balance ?? 0;
    const vat = await reportsService.getVatReport(biz.id, {});
    return { ap, inputVat: vat.inputVat, vatReceivable: vat.vatReceivableBalance };
  }

  it("a partial return reverses its proportional share of the VAT in the same entry", async () => {
    const p = await receivedPurchase("10", "1000000", 100_000);
    const ret = await giveBack(p, "3");
    expect(ret.value).toBe("300000");
    expect(await entryLines("supplier_return", ret.id)).toEqual([
      { code: "1220", debit: 0, credit: 30_000 },
      { code: "1300", debit: 0, credit: 300_000 },
      { code: "2100", debit: 330_000, credit: 0 },
    ]);
    expect(await balances()).toEqual({ ap: 770_000, inputVat: 70_000, vatReceivable: 70_000 });
  });

  it("two partials that add up to the whole purchase reverse exactly the whole VAT, remainder included", async () => {
    // 1,000,000 over 3 kg with 99,999 VAT: a third does not divide evenly in either figure.
    const p = await receivedPurchase("3", "1000000", 99_999);
    const first = await giveBack(p, "1");
    const second = await giveBack(p, "2");
    expect(BigInt(first.value) + BigInt(second.value)).toBe(1_000_000n);

    const firstLines = await entryLines("supplier_return", first.id);
    const secondLines = await entryLines("supplier_return", second.id);
    const vatOf = (lines: { code: string; credit: number }[]) => lines.find((l) => l.code === "1220")!.credit;
    // The first return's share, rounded half-up to the Rial; the second takes exactly what is left.
    const expectedFirst = Number((99_999n * BigInt(first.value) * 2n + 1_000_000n) / 2_000_000n);
    expect(vatOf(firstLines)).toBe(expectedFirst);
    expect(vatOf(secondLines)).toBe(99_999 - expectedFirst);
    expect(firstLines.find((l) => l.code === "2100")!.debit).toBe(Number(first.value) + expectedFirst);
    expect(secondLines.find((l) => l.code === "2100")!.debit).toBe(Number(second.value) + 99_999 - expectedFirst);
    expect(await balances()).toEqual({ ap: 0, inputVat: 0, vatReceivable: 0 });
  });

  it("a full return reverses the whole VAT and clears the payable", async () => {
    const p = await receivedPurchase("10", "1000000", 100_000);
    const ret = await giveBack(p, "10");
    expect(await entryLines("supplier_return", ret.id)).toEqual([
      { code: "1220", debit: 0, credit: 100_000 },
      { code: "1300", debit: 0, credit: 1_000_000 },
      { code: "2100", debit: 1_100_000, credit: 0 },
    ]);
    expect(await balances()).toEqual({ ap: 0, inputVat: 0, vatReceivable: 0 });
  });

  it("a purchase without VAT is returned exactly as before: two lines, 1220 untouched", async () => {
    const p = await receivedPurchase("10", "1000000", 0);
    const ret = await giveBack(p, "4");
    expect(await entryLines("supplier_return", ret.id)).toEqual([
      { code: "1300", debit: 0, credit: 400_000 },
      { code: "2100", debit: 400_000, credit: 0 },
    ]);
    expect(await balances()).toEqual({ ap: 600_000, inputVat: 0, vatReceivable: 0 });
  });
});

describe("receipt/payment voucher account and bank reference", () => {
  it("debits the chosen bank account, stores the reference, and lists both", async () => {
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "bank",
      amount: 3_000_000,
      receiptDate: "2026-10-04",
      createdBy: user.id,
      cashAccountId: acct["1119"],
      bankReference: " 1404-777 ",
    });
    expect(receipt).toMatchObject({ cashAccountId: acct["1119"], bankReference: "1404-777" });
    expect(await entryLines("ar_receipt", receipt.id)).toEqual([
      { code: "1119", debit: 3_000_000, credit: 0 },
      { code: "1200", debit: 0, credit: 3_000_000 },
    ]);

    const listed = await installments.listReceipts(biz.id);
    expect(listed[0]).toMatchObject({ bankReference: "1404-777", cashAccount: { code: "1119", name: "بانک ملت" } });
    // The reference is searchable.
    expect(await installments.listReceipts(biz.id, "777")).toHaveLength(1);
  });

  it("without a choice the method's default account takes it, exactly as before", async () => {
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 40_000,
      receiptDate: "2026-10-04",
      createdBy: user.id,
    });
    expect(receipt).toMatchObject({ cashAccountId: null, bankReference: null });
    expect(await entryLines("ar_receipt", receipt.id)).toEqual([
      { code: "1100", debit: 40_000, credit: 0 },
      { code: "1200", debit: 0, credit: 40_000 },
    ]);
    expect((await installments.listReceipts(biz.id))[0].cashAccount).toBeNull();
  });

  it("refuses an account that is not a cash/bank account of the method, or belongs to another business", async () => {
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      amount: 10_000,
      receiptDate: "2026-10-04",
      createdBy: user.id,
    };
    await expect(arService.receivePayment({ ...base, method: "cash", cashAccountId: acct["1119"] })).rejects.toMatchObject({
      code: "cash_account_method_mismatch",
    });
    await expect(arService.receivePayment({ ...base, method: "bank", cashAccountId: acct["1220"] })).rejects.toMatchObject({
      code: "invalid_cash_account",
    });
    const foreign = await db.query<{ id: string }>(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'Their bank', 'asset') RETURNING id",
      [biz.otherId],
    );
    await expect(arService.receivePayment({ ...base, method: "bank", cashAccountId: foreign.rows[0].id })).rejects.toMatchObject({
      code: "invalid_cash_account",
    });
    await expect(
      arService.receivePayment({ ...base, method: "bank", bankReference: "9".repeat(65) }),
    ).rejects.toMatchObject({ code: "invalid_bank_reference" });
    expect((await db.query("SELECT 1 FROM ar_receipts UNION ALL SELECT 1 FROM journal_entries")).rows).toHaveLength(0);
  });

  it("a payment voucher lists its account and reference", async () => {
    await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank",
      amount: 60_000,
      paymentDate: "2026-10-05",
      clientRequestId: `f11-list:${randomUUID()}`,
      createdBy: user.id,
      cashAccountId: acct["1110"],
      bankReference: "REF-1",
    });
    const listed = await installments.listPayments(biz.id);
    expect(listed[0]).toMatchObject({ bankReference: "REF-1", cashAccount: { code: "1110", name: "بانک" } });
  });

  it("a bank voucher without a choice posts to the bank account, 1110 (issue #829)", async () => {
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "bank",
      amount: 90_000,
      receiptDate: "2026-10-04",
      createdBy: user.id,
    });
    expect(receipt).toMatchObject({ cashAccountId: null, bankReference: null });
    expect(await entryLines("ar_receipt", receipt.id)).toEqual([
      { code: "1110", debit: 90_000, credit: 0 },
      { code: "1200", debit: 0, credit: 90_000 },
    ]);
    expect((await installments.listReceipts(biz.id))[0].cashAccount).toBeNull();
  });

  it("a clearing voucher posts to 1120 and only takes clearing accounts (issue #829)", async () => {
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      amount: 70_000,
      receiptDate: "2026-10-04",
      createdBy: user.id,
    };
    const receipt = await arService.receivePayment({ ...base, method: "clearing" });
    expect(receipt).toMatchObject({ cashAccountId: null, bankReference: null });
    expect(await entryLines("ar_receipt", receipt.id)).toEqual([
      { code: "1120", debit: 70_000, credit: 0 },
      { code: "1200", debit: 0, credit: 70_000 },
    ]);

    // The clearing account is a clearing-method account now, not a bank one.
    const named = await arService.receivePayment({ ...base, method: "clearing", cashAccountId: acct["1120"] });
    expect(named.cashAccountId).toBe(acct["1120"]);
    await expect(arService.receivePayment({ ...base, method: "bank", cashAccountId: acct["1120"] })).rejects.toMatchObject({
      code: "cash_account_method_mismatch",
    });
    await expect(arService.receivePayment({ ...base, method: "clearing", cashAccountId: acct["1119"] })).rejects.toMatchObject({
      code: "cash_account_method_mismatch",
    });
  });
});
