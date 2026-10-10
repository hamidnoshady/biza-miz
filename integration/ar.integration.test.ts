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
let holooImport: typeof import("../src/lib/integrations/holoo/transaction-import-service");
let mappingService: typeof import("../src/lib/integrations/mapping-service");

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
  holooImport = await import("../src/lib/integrations/holoo/transaction-import-service");
  mappingService = await import("../src/lib/integrations/mapping-service");

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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
        idempotencyKey: randomUUID(),
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

  it("requires a client idempotency key: without one there is no submission to de-duplicate", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 10_000,
        idempotencyKey: "",
        createdBy: user.id,
      }),
    ).rejects.toThrow("idempotency_key_required");
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 10_000,
        idempotencyKey: "k".repeat(129),
        createdBy: user.id,
      }),
    ).rejects.toThrow("idempotency_key_required");
  });

  it("serializes a concurrent burst on one key: exactly one voucher, the rest replays", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);
    const key = `ar-${randomUUID()}`;
    const call = () =>
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 100_000,
        receiptDate: "2026-10-04",
        idempotencyKey: key,
        createdBy: user.id,
      });
    // All five race inside the service's transactions; Promise.all rejects if
    // any of them surfaces the old transaction-aborted failure.
    const results = await Promise.all([call(), call(), call(), call(), call()]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(4);
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ar_receipts WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("rejects a key reused with changed intent instead of replaying the original", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash" as const,
      receiptDate: "2026-10-04",
      idempotencyKey: `ar-${randomUUID()}`,
      createdBy: user.id,
    };
    await arService.receivePayment({ ...base, amount: 100_000 });
    await expect(arService.receivePayment({ ...base, amount: 200_000 })).rejects.toThrow("idempotency_conflict");
    // The same intent still replays the original.
    const replay = await arService.receivePayment({ ...base, amount: 100_000 });
    expect(replay.duplicate).toBe(true);
  });

  it("Holoo receipt import survives the crash between posting and writing the mapping", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Holoo Buyer" });
    const { rows: connRows } = await db.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, link_mode, currency_unit, created_by)
       VALUES ($1, $2, 'Holoo', 'holoo', NULL, 'rest_api', 'rial', $3) RETURNING id`,
      [biz.id, biz.locationId, user.id],
    );
    const connectionId = connRows[0].id;
    await mappingService.upsertMapping(biz.id, connectionId, "holoo_customer", "person-1", customer.id);
    const tx: Parameters<typeof holooImport.applyTransactions>[2] = [
      { remoteId: "doc-1", type: "receipt", occurredAt: "2026-10-04T10:00:00", personId: "person-1", amountRial: 250_000n },
    ];
    const first = await holooImport.applyTransactions(biz.id, connectionId, tx, user.id);
    expect(first.imported).toBe(1);
    const receiptId = await mappingService.localIdForRemote(biz.id, connectionId, "holoo_receipt", "doc-1");
    expect(receiptId).toBeTruthy();
    // The crash: the receipt posted but the mapping write never landed.
    await db.query(
      `DELETE FROM integration_mappings WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'holoo_receipt'`,
      [biz.id, connectionId],
    );
    const second = await holooImport.applyTransactions(biz.id, connectionId, tx, user.id);
    expect(second.imported).toBe(1);
    expect(await mappingService.localIdForRemote(biz.id, connectionId, "holoo_receipt", "doc-1")).toBe(receiptId);
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ar_receipts WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("assigns stable sequential voucher numbers per business", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const first = await arService.receivePayment({
      idempotencyKey: randomUUID(),
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash",
      amount: 10_000,
      createdBy: user.id,
    });
    const second = await arService.receivePayment({
      idempotencyKey: randomUUID(),
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
        idempotencyKey: randomUUID(),
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
        idempotencyKey: randomUUID(),
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
        idempotencyKey: randomUUID(),
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
        idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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
      idempotencyKey: randomUUID(),
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

/**
 * Forced contention on one idempotency key (#829 completion). The burst test
 * above *hopes* the calls overlap; these tests *hold* them overlapped: a
 * barrier transaction pins the business's voucher-counter row, both callers
 * provably miss the initial lookup (zero rows mid-hold, both parked past the
 * lookup on the counter lock), and only then is the barrier released — so
 * the loser's `DO NOTHING` + re-read recovery path runs deterministically,
 * not when the scheduler feels generous.
 */
describe("forced contention on one idempotency key (issue #829 completion)", () => {
  /** How many backends on this database are lock-parked inside the counter upsert. */
  async function counterLockWaiters(): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_stat_activity
        WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE '%ar_ap_voucher_counters%'`,
      [databaseName],
    );
    return Number(rows[0].n);
  }

  async function waitForCounterWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if ((await counterLockWaiters()) >= count) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} counter-lock waiters`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function seedCounterRow(): Promise<void> {
    await db.query(
      `INSERT INTO ar_ap_voucher_counters (business_id, last_ar_voucher_number, last_ap_voucher_number)
       VALUES ($1, 0, 0) ON CONFLICT (business_id) DO NOTHING`,
      [biz.id],
    );
  }

  it("both callers miss the first lookup, then recover to one voucher, one posting, no outbox rows", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await seedCounterRow();
    const key = `barrier:${randomUUID()}`;
    const call = () =>
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 100_000,
        receiptDate: "2026-10-04",
        idempotencyKey: key,
        createdBy: user.id,
      });

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    let released = false;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT business_id FROM ar_ap_voucher_counters WHERE business_id = $1 FOR UPDATE`, [biz.id]);

      const a = call();
      const b = call();
      // Both callers missed the initial lookup (there is nothing to find)
      // and are parked *past* it, on the counter upsert — the parked query
      // text proves the position. Nothing has been inserted mid-hold.
      await waitForCounterWaiters(2);
      const midHold = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ar_receipts WHERE business_id = $1`,
        [biz.id],
      );
      expect(Number(midHold.rows[0].n)).toBe(0);

      await holder.query("COMMIT");
      released = true;
      const [first, second] = await Promise.all([a, b]);
      expect(first.id).toBe(second.id);
      expect([first, second].filter((r) => r.duplicate)).toHaveLength(1);
      expect([first, second].filter((r) => !r.duplicate)).toHaveLength(1);
      const winner = first.duplicate ? second : first;

      // One source row, one balanced journal effect.
      const sources = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ar_receipts WHERE business_id = $1 AND idempotency_key = $2`,
        [biz.id, key],
      );
      expect(Number(sources.rows[0].n)).toBe(1);
      const entries = await db.query<{ id: string }>(
        `SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'ar_receipt' AND source_id = $2`,
        [biz.id, winner.id],
      );
      expect(entries.rows).toHaveLength(1);
      const lines = await db.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit::text AS debit, l.credit::text AS credit
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [entries.rows[0].id],
      );
      expect(lines.rows).toEqual([
        { code: "1100", debit: "100000", credit: "0" },
        { code: "1200", debit: "0", credit: "100000" },
      ]);
      // No Holoo connection is configured, and the loser's replay path
      // returns before the enqueue — nothing reaches the outbox.
      const outbox = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM integration_outbox_events WHERE business_id = $1`,
        [biz.id],
      );
      expect(Number(outbox.rows[0].n)).toBe(0);
    } finally {
      if (!released) await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  }, 60_000);

  it("a concurrent caller with changed intent loses with 409 from the race path and posts nothing", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    await seedCounterRow();
    const key = `barrier-conflict:${randomUUID()}`;
    const call = (amount: number) =>
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount,
        receiptDate: "2026-10-04",
        idempotencyKey: key,
        createdBy: user.id,
      });

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    let released = false;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT business_id FROM ar_ap_voucher_counters WHERE business_id = $1 FOR UPDATE`, [biz.id]);

      const a = call(100_000);
      const b = call(200_000);
      // Keep vitest's unhandled-rejection detector quiet if an assertion
      // below fails before the settlement: the outcomes are still observed.
      a.catch(() => {});
      b.catch(() => {});
      // Both lookups missed before either could insert, so the loser cannot
      // take the fast path — its 409 comes from the race-path re-read guard.
      await waitForCounterWaiters(2);
      await holder.query("COMMIT");
      released = true;

      const outcomes = await Promise.allSettled([a, b]);
      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (fulfilled[0].status !== "fulfilled" || rejected[0].status !== "rejected") throw new Error("unreachable");
      expect(fulfilled[0].value.duplicate).toBe(false);
      expect(String(rejected[0].reason)).toContain("idempotency_conflict");

      // Exactly the winner's transfer exists — one row, one posting, and the
      // amount is whichever intent won the race.
      const winnerAmount = fulfilled[0].value.amount;
      expect([100_000, 200_000]).toContain(winnerAmount);
      const sources = await db.query<{ n: string; amount: string }>(
        `SELECT COUNT(*)::text AS n, MIN(amount)::text AS amount FROM ar_receipts WHERE business_id = $1 AND idempotency_key = $2`,
        [biz.id, key],
      );
      expect(Number(sources.rows[0].n)).toBe(1);
      expect(Number(sources.rows[0].amount)).toBe(winnerAmount);
      const entries = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'ar_receipt'`,
        [biz.id],
      );
      expect(Number(entries.rows[0].n)).toBe(1);
    } finally {
      if (!released) await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  }, 60_000);

  it("scopes keys to the business: the same key posts once per tenant and replays per tenant", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const otherBiz = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('AR Other', $1) RETURNING id", [
      `ar-other-${randomUUID().slice(0, 8)}`,
    ]);
    const otherBizId = otherBiz.rows[0].id;
    const otherLoc = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [otherBizId]);
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1110', 'Bank', 'asset'),
              ($1, '1120', 'Card clearing', 'asset'),
              ($1, '1200', 'Accounts Receivable', 'asset'), ($1, '4300', 'Sales', 'revenue')`,
      [otherBizId],
    );
    const otherCustomer = await customersService.createCustomer(otherBizId, { name: "Sara" });

    const key = `tenant:${randomUUID()}`;
    const intentFor = (businessId: string, locationId: string, customerId: string) => ({
      businessId,
      locationId,
      customerId,
      method: "cash" as const,
      amount: 50_000,
      receiptDate: "2026-10-04",
      idempotencyKey: key,
      createdBy: null,
    });
    const first = await arService.receivePayment(intentFor(biz.id, biz.locationId, customer.id));
    const second = await arService.receivePayment(intentFor(otherBizId, otherLoc.rows[0].id, otherCustomer.id));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(second.id).not.toBe(first.id);

    // Each tenant's retry replays its own voucher, never the other's.
    const replay = await arService.receivePayment(intentFor(biz.id, biz.locationId, customer.id));
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(first.id);
    const counts = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ar_receipts WHERE idempotency_key = $1`, [key]);
    expect(Number(counts.rows[0].n)).toBe(2);
  });

  it("rolls everything back when the period lock refuses the posting date", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const year = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
       VALUES ($1, 'test-2026', '2026-01-01', '2027-01-01') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on, status)
       VALUES ($1, $2, 'locked-october', '2026-10-01', '2026-11-01', 'locked')`,
      [biz.id, year.rows[0].id],
    );
    await expect(
      arService.receivePayment({
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        method: "cash",
        amount: 100_000,
        receiptDate: "2026-10-04",
        idempotencyKey: `locked:${randomUUID()}`,
        createdBy: user.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");

    // The source row, the journal effect and the consumed voucher number all
    // rolled back together — a retry after reopening starts clean.
    const leftovers = await db.query<{ receipts: string; entries: string; counters: string }>(
      `SELECT (SELECT COUNT(*) FROM ar_receipts WHERE business_id = $1)::text AS receipts,
              (SELECT COUNT(*) FROM journal_entries WHERE business_id = $1)::text AS entries,
              (SELECT COUNT(*) FROM ar_ap_voucher_counters WHERE business_id = $1)::text AS counters`,
      [biz.id],
    );
    expect(leftovers.rows[0]).toEqual({ receipts: "0", entries: "0", counters: "0" });
  });
});

describe("wrong-typed fields fail closed (issue #829 completion)", () => {
  it("rejects non-string memo/date/account with 400 codes and posts nothing", async () => {
    const customer = await customersService.createCustomer(biz.id, { name: "Ali" });
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: customer.id,
      method: "cash" as const,
      amount: 10_000,
      idempotencyKey: `types:${randomUUID()}`,
      createdBy: user.id,
    };
    // The routes check first; these prove the service backstop answers the
    // same controlled codes to internal callers instead of throwing TypeError.
    await expect(arService.receivePayment({ ...base, memo: 123 as unknown as string })).rejects.toThrow("invalid_memo");
    await expect(arService.receivePayment({ ...base, receiptDate: 20261004 as unknown as string })).rejects.toThrow("invalid_date");
    await expect(arService.receivePayment({ ...base, cashAccountId: 123 as unknown as string })).rejects.toThrow("invalid_cash_account");
    const { resolveVoucherCashAccount } = await import("../src/lib/voucher-cash-account");
    const client = await dbLib.getPool().connect();
    try {
      await expect(resolveVoucherCashAccount(client, biz.id, "cash", 123 as unknown as string)).rejects.toThrow("invalid_cash_account");
    } finally {
      client.release();
    }
    const leftovers = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ar_receipts WHERE business_id = $1`, [biz.id]);
    expect(Number(leftovers.rows[0].n)).toBe(0);
  });
});
