/**
 * Phase 16 exit criterion: "AR aging totals agree with their control
 * account to the Rial." The AR subledger (ar-service.ts) never keeps its own
 * shadow balance — it reconstructs everything from the same journal lines
 * that make up the accounts_receivable control account, attributing each
 * line to a customer via the order or receipt that caused it. This proves
 * that reconstruction against real posted entries.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { toPersianDigits } from "../src/lib/digits";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let arService: typeof import("../src/lib/ar-service");
let customersService: typeof import("../src/lib/parties-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", bankClearing: "", revenue: "", accountsReceivable: "" };
const user = { id: "" };

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
  databaseName = `pos_ar_${randomUUID().replaceAll("-", "")}`;

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
  arService = await import("../src/lib/ar-service");
  customersService = await import("../src/lib/parties-service");

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
  // journal_lines.account_id is ON DELETE RESTRICT (not CASCADE), and
  // ar_receipts/orders reference customers with RESTRICT too — clear the
  // dependent rows explicitly before cascading the business away.
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM ar_receipts");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('AR Co', $1) RETURNING id",
    [`ar-${randomUUID().slice(0, 8)}`],
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
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "1200") acct.accountsReceivable = r.id;
    if (r.code === "4300") acct.revenue = r.id;
  }
});

let orderCounter = 0;

/** Mirrors what postExactOrderPaymentEntry posts for a credit-method order payment: Debit AR / Credit Sales Revenue. */
async function postCreditOrder(entryDate: string, customerId: string | null, amount: number): Promise<string> {
  orderCounter += 1;
  const { rows: orderRows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
     VALUES ($1, $2, 'completed', $3, $4, $5, $5) RETURNING id`,
    [biz.locationId, orderCounter, customerId, amount, entryDate],
  );
  const orderId = orderRows[0].id;
  const { rows: entryRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, 'Order payment', 'order', $3) RETURNING id`,
    [biz.id, entryDate, orderId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryRows[0].id, acct.accountsReceivable, amount, acct.revenue],
  );
  return orderId;
}

/**
 * A party row with an explicit role set — the shapes `createCustomer` cannot
 * make, and the ones a crafted API request could name: a supplier, an
 * employee, a person who is both, a deactivated record, a merged duplicate.
 */
async function insertParty(
  businessId: string,
  name: string,
  roles: ("customer" | "supplier" | "employee")[],
  options: { isActive?: boolean; mergedIntoId?: string | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles, is_active, merged_into_id)
     VALUES ($1, $2, $3, $4::text[], $5, $6) RETURNING id`,
    [businessId, name, roles[0], roles, options.isActive ?? true, options.mergedIntoId ?? null],
  );
  return rows[0].id;
}

describe("listCustomerBalances", () => {
  it("attributes a credit order's AR debit to its customer", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali", phone: "0912" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);

    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances).toEqual([
      { customerId: customer.id, customerName: "Ali", customerPhone: "0912", balance: 500_000 },
    ]);
  });

  it("groups orders with no customer_id under the unknown bucket", async () => {
    await postCreditOrder("2025-04-01", null, 300_000);

    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances).toHaveLength(1);
    expect(balances[0].customerId).toBe("unknown");
    expect(balances[0].balance).toBe(300_000);
  });

  it("excludes a customer whose receipts fully paid off their balance", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Sara" });
    await postCreditOrder("2025-04-01", customer.id, 200_000);
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 200_000,
      createdBy: user.id,
    });

    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances).toEqual([]);
  });
});

describe("attribution through the document that caused the line", () => {
  it("attributes a cheque's A/R line to the cheque's customer and names the cheque on the statement", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Cheque payer" });
    const { rows: chequeRows } = await db.query<{ id: string }>(
      `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name,
                            amount, issue_date, due_date, counterparty_name, customer_id)
       VALUES ($1, $2, 'receivable', 'on_hand', '123456', 'بانک ملت', 400000, '2025-05-01', '2025-06-01', 'Cheque payer', $3)
       RETURNING id`,
      [biz.id, biz.locationId, customer.id],
    );
    const chequeId = chequeRows[0].id;
    const { rows: entryRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
       VALUES ($1, '2025-05-01', 'چک دریافتی', 'cheque', $2) RETURNING id`,
      [biz.id, chequeId],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 400000, 0), ($1, $3, 0, 400000)`,
      [entryRows[0].id, acct.accountsReceivable, acct.revenue],
    );

    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances).toEqual([
      { customerId: customer.id, customerName: "Cheque payer", customerPhone: null, balance: 400_000 },
    ]);

    const lines = await arService.getCustomerStatement(biz.id, customer.id);
    expect(lines).toHaveLength(1);
    // The cheque's own identifiers, not the memo's words.
    expect(lines[0].source).toMatchObject({ type: "cheque", id: chequeId, label: "چک 123456 — بانک ملت" });
    expect(lines[0].source?.orderId).toBeNull();
  });

  it("keeps a closed-order amendment attributed to the original order and its customer", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Amended" });
    const orderId = await postCreditOrder("2025-04-01", customer.id, 500_000);
    const { rows: orderRows } = await db.query<{ order_number: string }>(
      "SELECT order_number::text AS order_number FROM orders WHERE id = $1",
      [orderId],
    );

    // An amendment voids the sale: the correction posts against the amendment,
    // which points back at the order the customer was billed for.
    const { rows: amendmentRows } = await db.query<{ id: string }>(
      `INSERT INTO order_amendments (business_id, location_id, order_id, kind, reason,
                                     before_snapshot, after_snapshot, previous_total, new_total, entry_date)
       VALUES ($1, $2, $3, 'void', 'فاکتور اشتباه بود', '{}'::jsonb, '{}'::jsonb, 500000, 0, '2025-04-01')
       RETURNING id`,
      [biz.id, biz.locationId, orderId],
    );
    const { rows: entryRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
       VALUES ($1, '2025-04-01', 'ابطال سفارش', 'order_amendment', $2) RETURNING id`,
      [biz.id, amendmentRows[0].id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, 500000), ($1, $3, 500000, 0)`,
      [entryRows[0].id, acct.accountsReceivable, acct.revenue],
    );

    // The balance nets to zero, so the list drops the party entirely…
    expect(await arService.listCustomerBalances(biz.id)).toEqual([]);

    // …and the statement still shows both halves, each on the original order.
    const lines = await arService.getCustomerStatement(biz.id, customer.id);
    expect(lines.map((line) => line.type)).toEqual(["invoice", "invoice"]);
    expect(lines.map((line) => line.balance)).toEqual([500_000, 0]);
    expect(lines[1].source).toMatchObject({
      type: "order_amendment",
      id: amendmentRows[0].id,
      orderId,
    });
    expect(String(lines[1].source?.orderNumber)).toBe(orderRows[0].order_number);
    expect(lines[0].description).toBe(`سفارش #${toPersianDigits(orderRows[0].order_number)}`);
  });
});

describe("receivePayment", () => {
  it("posts Debit Cash / Credit Accounts Receivable and records the receipt", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);

    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 200_000,
      memo: "test",
      createdBy: user.id,
    });
    expect(receipt.amount).toBe(200_000);

    const { rows } = await db.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.cash],
    );
    expect(Number(rows[0].debit)).toBe(200_000);

    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances[0].balance).toBe(300_000);
  });

  it("posts to bank-clearing for a bank receipt", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);

    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "bank",
      amount: 100_000,
      createdBy: user.id,
    });

    const { rows } = await db.query<{ debit: string }>(
      `SELECT COALESCE(SUM(debit),0) AS debit FROM journal_lines WHERE account_id = $1`,
      [acct.bankClearing],
    );
    expect(Number(rows[0].debit)).toBe(100_000);
  });

  it("rejects a customer from a different business", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherCustomer = await customersService.createCustomer(other.rows[0].id, { name: "Stranger" });

    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: otherCustomer.id,
        method: "cash",
        amount: 10_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("customer_not_found");
  });

  it("rejects a non-positive amount", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 0,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_amount");
  });
});

describe("getCustomerStatement", () => {
  it("returns invoices and receipts oldest-first with a running balance", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 200_000,
      receiptDate: "2025-04-10",
      createdBy: user.id,
    });

    const lines = await arService.getCustomerStatement(biz.id, customer.id);
    expect(lines.map((l) => l.type)).toEqual(["invoice", "receipt"]);
    expect(lines[0].balance).toBe(500_000);
    expect(lines[1].balance).toBe(300_000);
    // The UI is Persian-first: an invoice line names its order with Persian digits.
    expect(lines[0].description).toMatch(/^سفارش #[۰-۹]+$/);
  });
});

describe("getArAging", () => {
  it("buckets an old unpaid invoice as over90 as of a later date", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-01-01", customer.id, 500_000);

    const aging = await arService.getArAging(biz.id, "2025-04-15");
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0].over90).toBe(500_000);
    expect(aging.rows[0].total).toBe(500_000);
    expect(aging.totals.over90).toBe(500_000);
  });

  it("rejects a malformed asOfDate instead of answering with garbage buckets", async () => {
    // `Date.parse("not-a-date")` is NaN, and every age computed from NaN used
    // to fall through to «over90» — a wrong report that claimed to be right.
    await expect(arService.getArAging(biz.id, "not-a-date")).rejects.toThrow("invalid_date");
    await expect(arService.getArAging(biz.id, "2025-13-45")).rejects.toThrow("invalid_date");
  });

  it("carries an advance payment as negative current, so the row still equals the customer's net balance", async () => {
    // A customer who pays ahead has no open invoice to age. Dropping that
    // credit made this report's «جمع» disagree with the balances list (and
    // with the control account) by exactly the advance.
    const customer = await customersService.createCustomer(biz.id, { name: "Mina" });
    await postCreditOrder("2025-04-01", customer.id, 200_000);
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 500_000,
      receiptDate: "2025-04-05",
      createdBy: user.id,
    });

    const aging = await arService.getArAging(biz.id, "2025-04-15");
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0].current).toBe(-300_000);
    expect(aging.rows[0].total).toBe(-300_000);
  });

  it("shows a customer whose only AR activity is an advance", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Payam" });
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "bank",
      amount: 250_000,
      receiptDate: "2025-03-01",
      createdBy: user.id,
    });

    const aging = await arService.getArAging(biz.id, "2025-03-15");
    expect(aging.rows).toEqual([
      expect.objectContaining({ customerId: customer.id, current: -250_000, total: -250_000 }),
    ]);
  });

  it("keeps the grand total equal to the control account when debts and credits coexist", async () => {
    const debtor = await customersService.createCustomer(biz.id, { name: "Debtor" });
    const creditor = await customersService.createCustomer(biz.id, { name: "Creditor" });
    await postCreditOrder("2025-01-01", debtor.id, 400_000);
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: creditor.id,
      method: "cash",
      amount: 250_000,
      receiptDate: "2025-02-01",
      createdBy: user.id,
    });

    const aging = await arService.getArAging(biz.id, "2025-04-15");
    expect(aging.totals.total).toBe(150_000);

    // The phase-16 exit criterion, checked directly: «جمع کل» IS the control account.
    const { rows } = await db.query<{ balance: string }>(
      `SELECT (COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0))::text AS balance FROM journal_lines WHERE account_id = $1`,
      [acct.accountsReceivable],
    );
    expect(aging.totals.total).toBe(Number(rows[0].balance));
  });
});

describe("receivePayment party integrity", () => {
  const payment = (customerId: string, amount = 10_000) => ({
    businessId: biz.id,
    locationId: biz.locationId,
    customerId,
    method: "cash" as const,
    amount,
    createdBy: user.id,
  });

  it("rejects a supplier-only party", async () => {
    // The FK on ar_receipts.customer_id points at `parties`, which since 0137
    // holds suppliers and employees too — so the database cannot say what the
    // id means and the service has to.
    const supplier = await insertParty(biz.id, "Supplier only", ["supplier"]);
    await expect(arService.receivePayment(payment(supplier))).rejects.toThrow("customer_not_found");
  });

  it("rejects an employee-only party", async () => {
    const employee = await insertParty(biz.id, "Employee only", ["employee"]);
    await expect(arService.receivePayment(payment(employee))).rejects.toThrow("customer_not_found");
  });

  it("rejects an inactive customer", async () => {
    const retired = await insertParty(biz.id, "Retired customer", ["customer"], { isActive: false });
    await expect(arService.receivePayment(payment(retired))).rejects.toThrow("customer_not_found");
  });

  it("rejects a customer merged into another party", async () => {
    const survivor = await customersService.createCustomer(biz.id, { name: "Survivor" });
    const duplicate = await insertParty(biz.id, "Duplicate", ["customer"], { mergedIntoId: survivor.id });
    await expect(arService.receivePayment(payment(duplicate))).rejects.toThrow("customer_not_found");
  });

  it("accepts a party holding the Customer role alongside another, and posts the receipt", async () => {
    const both = await insertParty(biz.id, "Buyer and supplier", ["customer", "supplier"]);
    const receipt = await arService.receivePayment(payment(both));
    expect(receipt.customerId).toBe(both);
    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances).toEqual([
      expect.objectContaining({ customerId: both, balance: -10_000 }),
    ]);
  });

  it("writes nothing when it refuses a party", async () => {
    const supplier = await insertParty(biz.id, "Supplier only", ["supplier"]);
    await expect(arService.receivePayment(payment(supplier))).rejects.toThrow("customer_not_found");
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ar_receipts");
    expect(rows[0].n).toBe(0);
    const { rows: entries } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM journal_entries");
    expect(entries[0].n).toBe(0);
  });
});

describe("date integrity", () => {
  const paymentOn = (customerId: string, receiptDate: string) => ({
    businessId: biz.id,
    locationId: biz.locationId,
    customerId,
    method: "cash" as const,
    amount: 10_000,
    receiptDate,
    createdBy: user.id,
  });

  it("rejects impossible calendar dates on the receipt and on the aging report", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    for (const impossible of ["2026-02-29", "2025-02-30", "2026-04-31", "2026-13-01"]) {
      await expect(arService.receivePayment(paymentOn(customer.id, impossible))).rejects.toThrow("invalid_date");
      await expect(arService.getArAging(biz.id, impossible)).rejects.toThrow("invalid_date");
    }
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ar_receipts");
    expect(rows[0].n).toBe(0);
  });

  it("accepts a real leap day and files the receipt on it", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const receipt = await arService.receivePayment(paymentOn(customer.id, "2024-02-29"));
    expect(receipt.receiptDate).toBe("2024-02-29");
    const aging = await arService.getArAging(biz.id, "2024-02-29");
    expect(aging.asOfDate).toBe("2024-02-29");
    expect(aging.rows[0].current).toBe(-10_000);
  });
});

describe("listCustomerBalancePage", () => {
  it("pages, counts and searches in SQL, and the summary does not move with the window", async () => {
    const ali = await customersService.createCustomer(biz.id, { name: "Ali" });
    const sara = await customersService.createCustomer(biz.id, { name: "Sara" });
    const mina = await customersService.createCustomer(biz.id, { name: "Mina" });
    await postCreditOrder("2025-04-01", ali.id, 500_000);
    await postCreditOrder("2025-04-02", sara.id, 300_000);
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: mina.id,
      method: "cash",
      amount: 250_000,
      receiptDate: "2025-04-03",
      createdBy: user.id,
    });

    const first = await arService.listCustomerBalancePage(biz.id, { limit: 2, offset: 0 });
    expect(first.customers).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.summary.receivableTotal).toBe(800_000);
    expect(first.summary.advanceTotal).toBe(250_000);
    expect(first.summary.netTotal).toBe(550_000);
    // The whole point of showing both numbers: the subledger IS the control
    // account, and the screen can prove it rather than assume it.
    expect(first.summary.controlBalance).toBe(550_000);
    expect(first.summary.reconciles).toBe(true);
    expect(first.summary.parties).toBe(3);

    const second = await arService.listCustomerBalancePage(biz.id, { limit: 2, offset: 2 });
    expect(second.customers).toHaveLength(1);
    // Paginating changed the window, never the totals.
    expect(second.summary).toEqual(first.summary);

    const searched = await arService.listCustomerBalancePage(biz.id, { q: "Sar", limit: 25, offset: 0 });
    expect(searched.customers.map((c) => c.customerId)).toEqual([sara.id]);
    expect(searched.total).toBe(1);
  });

  it("folds the search the way the app's pickers fold a typed needle", async () => {
    // Stored with a Persian ی/ک; searched with the Arabic spelling a phone
    // keyboard produces. The fold has to happen on the column, in SQL.
    const ali = await insertParty(biz.id, "علی رضایی", ["customer"]);
    await postCreditOrder("2025-04-01", ali, 100_000);
    const found = await arService.listCustomerBalancePage(biz.id, { q: "علي", limit: 25, offset: 0 });
    expect(found.customers.map((c) => c.customerId)).toEqual([ali]);
    const withDigits = await arService.listCustomerBalancePage(biz.id, { q: "۱۲۳", limit: 25, offset: 0 });
    expect(withDigits.total).toBe(0);
  });

  it("keeps the unattributed bucket in the page and in the summary", async () => {
    await postCreditOrder("2025-04-01", null, 300_000);
    const page = await arService.listCustomerBalancePage(biz.id, { limit: 25, offset: 0 });
    expect(page.customers).toEqual([
      expect.objectContaining({ customerId: "unknown", balance: 300_000 }),
    ]);
    expect(page.summary.unattributedBalance).toBe(300_000);
  });

  it("answers an empty page for a business whose chart has no A/R account", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const page = await arService.listCustomerBalancePage(other.rows[0].id, { limit: 25, offset: 0 });
    expect(page).toEqual({
      customers: [],
      total: 0,
      summary: expect.objectContaining({ netTotal: 0, reconciles: true, parties: 0 }),
    });
  });
});

describe("getCustomerStatement isolation", () => {
  it("returns only the requested customer's lines, however much the other customer has", async () => {
    const ali = await customersService.createCustomer(biz.id, { name: "Ali" });
    const sara = await customersService.createCustomer(biz.id, { name: "Sara" });
    await postCreditOrder("2025-04-01", ali.id, 500_000);
    for (let i = 0; i < 5; i += 1) await postCreditOrder("2025-04-02", sara.id, 10_000);

    const aliLines = await arService.getCustomerStatement(biz.id, ali.id);
    expect(aliLines).toHaveLength(1);
    expect(aliLines[0].debit).toBe(500_000);
    // The statement's cost is the statement's own length: B's five rows were
    // never read to answer a question about A.
    const saraLines = await arService.getCustomerStatement(biz.id, sara.id);
    expect(saraLines).toHaveLength(5);
    expect(saraLines.every((line) => line.credit === 0 && line.debit === 10_000)).toBe(true);
  });

  it("answers an id that matches nothing with an empty statement, not the whole book", async () => {
    await postCreditOrder("2025-04-01", null, 300_000);
    expect(await arService.getCustomerStatement(biz.id, randomUUID())).toEqual([]);
    // A malformed id is not a uuid — asking Postgres would raise 22P02 — and
    // it is not the unknown sentinel either, so it is simply empty.
    expect(await arService.getCustomerStatement(biz.id, "not-a-uuid")).toEqual([]);
  });

  it("still serves the unattributed bucket under its own key", async () => {
    await postCreditOrder("2025-04-01", null, 300_000);
    const lines = await arService.getCustomerStatement(biz.id, "unknown");
    expect(lines).toHaveLength(1);
    expect(lines[0].debit).toBe(300_000);
    expect(lines[0].source.type).toBe("order");
  });

  it("carries the source record's own identifiers, never a description to reverse-engineer", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "bank",
      amount: 200_000,
      receiptDate: "2025-04-10",
      createdBy: user.id,
    });

    const lines = await arService.getCustomerStatement(biz.id, customer.id);
    const receiptLine = lines.find((line) => line.type === "receipt")!;
    expect(receiptLine.entryId).toBeTruthy();
    expect(receiptLine.source).toEqual({
      type: "ar_receipt",
      id: receipt.id,
      label: "دریافت بانکی",
      orderId: null,
      orderNumber: null,
    });

    const order = await postCreditOrder("2025-04-01", customer.id, 500_000);
    const invoiceLine = (await arService.getCustomerStatement(biz.id, customer.id)).find((line) => line.type === "invoice")!;
    expect(invoiceLine.source.type).toBe("order");
    expect(invoiceLine.source.id).toBe(order);
    expect(invoiceLine.source.orderId).toBe(order);
    const { rows: orderRows } = await db.query<{ order_number: string }>(
      "SELECT order_number::text AS order_number FROM orders WHERE id = $1",
      [order],
    );
    expect(String(invoiceLine.source.orderNumber)).toBe(orderRows[0].order_number);
  });
});

describe("getArAging scope and buckets", () => {
  it("ignores activity dated after the as-of date", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-05-01", customer.id, 100_000);
    expect((await arService.getArAging(biz.id, "2025-04-15")).rows).toEqual([]);
    expect((await arService.getArAging(biz.id, "2025-05-15")).rows).toHaveLength(1);
  });

  it("places each open invoice in its own bucket, at the 30/60/90 boundaries", async () => {
    const asOf = "2025-04-15";
    const current = await customersService.createCustomer(biz.id, { name: "Current" });
    const thirty = await customersService.createCustomer(biz.id, { name: "Thirty" });
    const sixty = await customersService.createCustomer(biz.id, { name: "Sixty" });
    const ninety = await customersService.createCustomer(biz.id, { name: "Ninety" });
    await postCreditOrder("2025-04-01", current.id, 100_000); // 14 days
    await postCreditOrder("2025-03-01", thirty.id, 200_000); // 45 days
    await postCreditOrder("2025-01-30", sixty.id, 300_000); // 75 days
    await postCreditOrder("2024-12-01", ninety.id, 400_000); // 135 days

    const aging = await arService.getArAging(biz.id, asOf);
    const byName = new Map(aging.rows.map((row) => [row.customerName, row]));
    expect(byName.get("Current")?.current).toBe(100_000);
    expect(byName.get("Thirty")?.d31_60).toBe(200_000);
    expect(byName.get("Sixty")?.d61_90).toBe(300_000);
    expect(byName.get("Ninety")?.over90).toBe(400_000);
    expect(aging.totals.total).toBe(1_000_000);

    const { rows } = await db.query<{ balance: string }>(
      `SELECT (COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0))::text AS balance
         FROM journal_lines WHERE account_id = $1`,
      [acct.accountsReceivable],
    );
    expect(aging.totals.total).toBe(Number(rows[0].balance));
  });
});
