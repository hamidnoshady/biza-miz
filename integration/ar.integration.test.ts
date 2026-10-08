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
const acct = { cash: "", bank: "", bankClearing: "", revenue: "", accountsReceivable: "" };
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
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1110', 'Bank', 'asset'),
            ($1, '1120', 'Card clearing', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1110") acct.bank = r.id;
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

  it("posts to the bank account for a bank receipt (issue #829: bank means 1110, not clearing)", async () => {
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
      [acct.bank],
    );
    expect(Number(rows[0].debit)).toBe(100_000);
  });

  it("posts to the clearing account for a clearing receipt", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);

    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "clearing",
      amount: 100_000,
      createdBy: user.id,
    });

    const { rows } = await db.query<{ debit: string }>(
      `SELECT COALESCE(SUM(debit),0) AS debit FROM journal_lines WHERE account_id = $1`,
      [acct.bankClearing],
    );
    expect(Number(rows[0].debit)).toBe(100_000);
  });

  it("posts to an explicit cash account when one is given", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);
    const { rows: subRows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type, parent_id)
       VALUES ($1, '1101', 'Petty cash', 'asset', $2) RETURNING id`,
      [biz.id, acct.cash],
    );

    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      cashAccountId: subRows[0].id,
      amount: 100_000,
      createdBy: user.id,
    });
    expect(receipt.cashAccountId).toBe(subRows[0].id);

    const { rows } = await db.query<{ debit: string }>(
      `SELECT COALESCE(SUM(debit),0) AS debit FROM journal_lines WHERE account_id = $1`,
      [subRows[0].id],
    );
    expect(Number(rows[0].debit)).toBe(100_000);
  });

  it("rejects a cash account that is not a cash/bank/clearing account", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        cashAccountId: acct.accountsReceivable,
        amount: 10_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_cash_account");
  });

  it("is idempotent on the client key: a retry returns the original voucher, not a second posting", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);
    const key = `ar-${randomUUID()}`;

    const first = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 100_000,
      idempotencyKey: key,
      createdBy: user.id,
    });
    const second = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 100_000,
      idempotencyKey: key,
      createdBy: user.id,
    });
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM journal_entries WHERE business_id = $1 AND source_type = 'ar_receipt'`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("assigns stable sequential voucher numbers per business", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const first = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 10_000,
      createdBy: user.id,
    });
    const second = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 20_000,
      createdBy: user.id,
    });
    expect(first.voucherNumber).toBe(1);
    expect(second.voucherNumber).toBe(2);
  });

  it("rejects a supplier-only party as the receipt customer", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, 'Vendor', 'supplier') RETURNING id`,
      [biz.id],
    );
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: rows[0].id,
        method: "cash",
        amount: 10_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("customer_not_found");
  });

  it("rejects an inactive or merged customer", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await db.query(`UPDATE parties SET is_active = false WHERE id = $1`, [customer.id]);
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 10_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("customer_not_found");
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

describe("reverseReceipt", () => {
  it("posts the mirror entry, marks the voucher reversed, and restores the balance", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 200_000,
      receiptDate: "2025-04-10",
      createdBy: user.id,
    });

    const result = await arService.reverseReceipt({
      businessId: biz.id,
      receiptId: receipt.id,
      actorId: user.id,
    });
    expect(result.reversalEntryId).toBeTruthy();

    const balances = await arService.listCustomerBalances(biz.id);
    expect(balances[0].balance).toBe(500_000);

    const detail = await arService.getReceiptDetail(biz.id, receipt.id);
    expect(detail).not.toBeNull();
    expect(detail!.reversedAt).toBeTruthy();
    expect(detail!.reversalEntryId).toBe(result.reversalEntryId);
  });

  it("refuses to reverse the same voucher twice", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 50_000,
      createdBy: user.id,
    });
    await arService.reverseReceipt({ businessId: biz.id, receiptId: receipt.id, actorId: user.id });
    await expect(
      arService.reverseReceipt({ businessId: biz.id, receiptId: receipt.id, actorId: user.id }),
    ).rejects.toThrow("already_reversed");
  });

  it("shows the reversal in the customer statement", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);
    const receipt = await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 200_000,
      receiptDate: "2025-04-10",
      createdBy: user.id,
    });
    await arService.reverseReceipt({ businessId: biz.id, receiptId: receipt.id, actorId: user.id });

    const lines = await arService.getCustomerStatement(biz.id, customer.id);
    expect(lines.map((l) => l.type)).toEqual(["invoice", "receipt", "reversal"]);
    expect(lines[2].balance).toBe(500_000);
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
