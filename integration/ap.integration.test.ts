/**
 * Phase 16 exit criterion: "AR and AP aging totals agree with their control
 * account to the Rial." Mirrors ar.integration.test.ts: the AP subledger
 * (ap-service.ts) never keeps its own shadow balance — it reconstructs
 * everything from the same journal lines that make up the accounts_payable
 * control account, attributing each line to a supplier via the purchase,
 * supplier_return, or payment that caused it. This proves that
 * reconstruction against real posted entries, including the liability sign
 * convention (credit raises the balance, debit pays it down — the opposite
 * of AR's asset convention).
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
let apService: typeof import("../src/lib/ap-service");
let installmentsService: typeof import("../src/lib/installments-service");

const biz = { id: "", locationId: "", branchLocationId: "" };
const acct = { cash: "", bank: "", bankClearing: "", inventory: "", accountsPayable: "" };
const user = { id: "" };
const supplier = { id: "" };
/*
 * The party the branch alias is linked to (`suppliers.party_id`) — what the
 * A/P balance rows must carry so the screens can deep-link the supplier's file
 * in the one directory, which is keyed by the party rather than the alias.
 */
const party = { id: "" };

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
  databaseName = `pos_ap_${randomUUID().replaceAll("-", "")}`;

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
  apService = await import("../src/lib/ap-service");
  installmentsService = await import("../src/lib/installments-service");

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
  await db.query("DELETE FROM cheque_events");
  await db.query("DELETE FROM cheques");
  await db.query("DELETE FROM installment_items");
  await db.query("DELETE FROM installments");
  await db.query("DELETE FROM item_supplier_return_items");
  await db.query("DELETE FROM item_supplier_returns");
  await db.query("DELETE FROM item_purchase_items");
  await db.query("DELETE FROM item_purchases");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM ap_payments");
  await db.query("DELETE FROM supplier_returns");
  await db.query("DELETE FROM purchases");
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('AP Co', $1) RETURNING id",
    [`ap-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  const branchRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Branch') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  biz.branchLocationId = branchRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const supplierRow = await db.query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name, phone) VALUES ($1, 'Acme', '0912') RETURNING id",
    [biz.locationId],
  );
  supplier.id = supplierRow.rows[0].id;

  const partyRow = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name, role) VALUES ($1, 'Acme', 'supplier') RETURNING id",
    [biz.id],
  );
  party.id = partyRow.rows[0].id;
  await db.query("UPDATE suppliers SET party_id = $1 WHERE id = $2", [party.id, supplier.id]);

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1110', 'Bank', 'asset'),
            ($1, '1120', 'Card clearing', 'asset'),
            ($1, '1300', 'Inventory', 'asset'), ($1, '2100', 'Accounts Payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1110") acct.bank = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "1300") acct.inventory = r.id;
    if (r.code === "2100") acct.accountsPayable = r.id;
  }
});

let purchaseCounter = 0;

/** Mirrors what postExactPurchaseEntry posts for a credit-settled purchase: Debit Inventory / Credit Accounts Payable. */
async function postCreditPurchase(
  entryDate: string,
  supplierId: string | null,
  amount: number,
  locationId = biz.locationId,
): Promise<string> {
  purchaseCounter += 1;
  const { rows: purchaseRows } = await db.query<{ id: string }>(
    `INSERT INTO purchases (location_id, supplier_id, status, total, settlement_method, note, received_at)
     VALUES ($1, $2, 'received', $3, 'credit', $4, $5) RETURNING id`,
    [locationId, supplierId, amount, `purchase #${purchaseCounter}`, entryDate],
  );
  const purchaseId = purchaseRows[0].id;
  const { rows: entryRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, $3, 'Purchase receipt', 'purchase', $4) RETURNING id`,
    [biz.id, locationId, entryDate, purchaseId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryRows[0].id, acct.inventory, amount, acct.accountsPayable],
  );
  return purchaseId;
}

/** Mirrors postExactOperationalInventoryEntry for a supplier return settled against the payable: Debit Accounts Payable / Credit Inventory. */
async function postSupplierReturn(
  entryDate: string,
  purchaseId: string,
  amount: number,
  settlementMethod: "accounts_payable" | "cash" = "accounts_payable",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO supplier_returns (business_id, location_id, purchase_id, settlement_method, total_value_rial, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'damaged', $6) RETURNING id`,
    [biz.id, biz.locationId, purchaseId, settlementMethod, amount, `return-${randomUUID()}`],
  );
  const returnId = rows[0].id;
  const { rows: entryRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, $3, 'Supplier return', 'supplier_return', $4) RETURNING id`,
    [biz.id, biz.locationId, entryDate, returnId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryRows[0].id, acct.accountsPayable, amount, acct.inventory],
  );
  return returnId;
}

/** Posts one balanced A/P control-account line with its source document linked. */
async function postApJournalLine(input: {
  entryDate: string;
  sourceType: string;
  sourceId: string;
  side: "debit" | "credit";
  amount: number;
  memo?: string;
  locationId?: string;
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [biz.id, input.locationId ?? biz.locationId, input.entryDate, input.memo ?? input.sourceType, input.sourceType, input.sourceId],
  );
  if (input.side === "credit") {
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [rows[0].id, acct.inventory, input.amount, acct.accountsPayable],
    );
  } else {
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [rows[0].id, acct.accountsPayable, input.amount, acct.inventory],
    );
  }
  return rows[0].id;
}

async function postRetailPurchase(supplierId: string, amount: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO item_purchases (business_id, location_id, supplier_id, status, total, received_at)
     VALUES ($1, $2, $3, 'received', $4, '2025-04-01') RETURNING id`,
    [biz.id, biz.locationId, supplierId, amount],
  );
  await postApJournalLine({ entryDate: "2025-04-01", sourceType: "item_purchase", sourceId: rows[0].id, side: "credit", amount });
  return rows[0].id;
}

async function postRetailSupplierReturn(
  purchaseId: string,
  amount: number,
  settlementMethod: "accounts_payable" | "cash",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO item_supplier_returns (business_id, location_id, purchase_id, settlement_method, total_value_rial, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'damaged', $6) RETURNING id`,
    [biz.id, biz.locationId, purchaseId, settlementMethod, amount, `item-return-${randomUUID()}`],
  );
  await postApJournalLine({ entryDate: "2025-04-05", sourceType: "item_supplier_return", sourceId: rows[0].id, side: "debit", amount });
  return rows[0].id;
}

describe("listSupplierBalances", () => {
  it("attributes a credit purchase's AP credit to its supplier, with the party behind the alias", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances).toEqual([
      {
        supplierId: supplier.id,
        supplierName: "Acme",
        supplierPhone: "0912",
        supplierPartyId: party.id,
        locationId: biz.locationId,
        locationName: "Main",
        balance: 500_000,
      },
    ]);
  });

  it("lists every supplier record with its balance and party in the directory scope", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    // A supplier we owe nothing to is still a picker option, at zero.
    const settled = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name) VALUES ($1, 'Settled Co') RETURNING id",
      [biz.locationId],
    );

    const directory = await apService.listSupplierDirectory(biz.id);
    expect(directory).toHaveLength(2);
    expect(directory.find((s) => s.supplierId === supplier.id)).toEqual({
      supplierId: supplier.id,
      supplierName: "Acme",
      supplierPhone: "0912",
      supplierPartyId: party.id,
      locationId: biz.locationId,
      locationName: "Main",
      balance: 500_000,
    });
    expect(directory.find((s) => s.supplierId === settled.rows[0].id)?.balance).toBe(0);
  });

  it("groups purchases with no supplier_id under the unknown bucket", async () => {
    await postCreditPurchase("2025-04-01", null, 300_000);

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances).toHaveLength(1);
    expect(balances[0].supplierId).toBe("unknown");
    expect(balances[0].balance).toBe(300_000);
  });

  it("reduces the balance for a supplier return settled against the payable", async () => {
    const purchaseId = await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    await postSupplierReturn("2025-04-05", purchaseId, 100_000);

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances[0].balance).toBe(400_000);
  });

  it("excludes a supplier whose payments fully paid off the balance", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 200_000);
    await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 200_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances).toEqual([]);
  });
});

describe("payBill", () => {
  it("posts Debit Accounts Payable / Credit Cash and records the payment", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);

    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 200_000,
      memo: "test",
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    expect(payment.amount).toBe(200_000);

    const { rows } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit),0) AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.cash],
    );
    expect(Number(rows[0].credit)).toBe(200_000);

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances[0].balance).toBe(300_000);
  });

  it("posts to the bank account for a bank payment (issue #829: bank means 1110, not clearing)", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);

    await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank",
      amount: 100_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });

    const { rows } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit),0) AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.bank],
    );
    expect(Number(rows[0].credit)).toBe(100_000);
  });

  it("posts to the clearing account for a clearing payment", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);

    await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "clearing",
      amount: 100_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });

    const { rows } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit),0) AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.bankClearing],
    );
    expect(Number(rows[0].credit)).toBe(100_000);
  });

  it("rejects a deactivated supplier alias", async () => {
    await db.query(`UPDATE suppliers SET is_active = false WHERE id = $1`, [supplier.id]);
    await expect(
      apService.payBill({
        businessId: biz.id,
        locationId: biz.locationId,
        supplierId: supplier.id,
        method: "cash",
        amount: 10_000,
        clientRequestId: randomUUID(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("supplier_not_found");
  });

  it("rejects a supplier from a different business", async () => {
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherLoc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id",
      [otherBiz.rows[0].id],
    );
    const otherSupplier = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name) VALUES ($1, 'Stranger') RETURNING id",
      [otherLoc.rows[0].id],
    );

    await expect(
      apService.payBill({
        businessId: biz.id,
        locationId: biz.locationId,
        supplierId: otherSupplier.rows[0].id,
        method: "cash",
        amount: 10_000,
        clientRequestId: randomUUID(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("supplier_not_found");
  });

  it("rejects a non-positive amount", async () => {
    await expect(
      apService.payBill({
        businessId: biz.id,
        locationId: biz.locationId,
        supplierId: supplier.id,
        method: "cash",
        amount: 0,
        clientRequestId: randomUUID(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_amount");
  });
});

describe("A/P branch aliases and payment idempotency", () => {
  it("keeps supplier aliases and balances branch-specific and rejects cross-branch payments", async () => {
    const branchAlias = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name, party_id) VALUES ($1, 'Acme Branch', $2) RETURNING id",
      [biz.branchLocationId, party.id],
    );
    await postCreditPurchase("2025-04-01", supplier.id, 100_000, biz.locationId);
    await postCreditPurchase("2025-04-01", branchAlias.rows[0].id, 200_000, biz.branchLocationId);

    const balances = await apService.listSupplierBalances(biz.id);
    expect(balances.map((row) => [row.supplierId, row.locationId, row.locationName, row.balance])).toEqual([
      [branchAlias.rows[0].id, biz.branchLocationId, "Branch", 200_000],
      [supplier.id, biz.locationId, "Main", 100_000],
    ]);

    await expect(apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: branchAlias.rows[0].id,
      method: "cash",
      amount: 50_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    })).rejects.toThrow("supplier_location_mismatch");

    await apService.payBill({
      businessId: biz.id,
      locationId: biz.branchLocationId,
      supplierId: branchAlias.rows[0].id,
      method: "cash",
      amount: 50_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    const after = await apService.listSupplierBalances(biz.id);
    expect(after.find((row) => row.supplierId === branchAlias.rows[0].id)?.balance).toBe(150_000);
    expect(after.find((row) => row.supplierId === supplier.id)?.balance).toBe(100_000);
  });

  it("reuses a matching request key and rejects key reuse with changed payment details", async () => {
    const clientRequestId = `retry:${randomUUID()}`;
    const intent = {
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank" as const,
      amount: 40_000,
      paymentDate: "2025-04-10",
      memo: "batch payment",
      clientRequestId,
      createdBy: user.id,
    };
    const first = await apService.payBill(intent);
    const retry = await apService.payBill(intent);
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(retry.id).toBe(first.id);

    await expect(apService.payBill({ ...intent, amount: 41_000 })).rejects.toThrow("idempotency_conflict");
    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ap_payments WHERE business_id = $1 AND client_request_id = $2",
      [biz.id, clientRequestId],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("serializes concurrent retries into one voucher and one journal posting", async () => {
    const clientRequestId = `concurrent:${randomUUID()}`;
    const intent = {
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash" as const,
      amount: 70_000,
      paymentDate: "2025-04-10",
      clientRequestId,
      createdBy: user.id,
    };
    const results = await Promise.all([apService.payBill(intent), apService.payBill(intent)]);
    expect(results.map((row) => row.id).sort()).toEqual([results[0].id, results[0].id]);
    expect(results.filter((row) => row.duplicate)).toHaveLength(1);
    const count = await db.query<{ payment_count: string; entry_count: string }>(
      `SELECT (SELECT count(*) FROM ap_payments WHERE business_id = $1 AND client_request_id = $2)::text AS payment_count,
              (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_type = 'ap_payment'
                AND source_id = (SELECT id FROM ap_payments WHERE business_id = $1 AND client_request_id = $2))::text AS entry_count`,
      [biz.id, clientRequestId],
    );
    expect(count.rows[0]).toEqual({ payment_count: "1", entry_count: "1" });
  });
});

describe("reverseApPayment", () => {
  it("appends the opposite GL entry, restores supplier balance, and records exact statement links", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 200_000,
      paymentDate: "2025-04-10",
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    const reversal = await apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.locationId,
      paymentId: payment.id,
      actorId: user.id,
      reversalDate: "2025-04-11",
    });

    expect(reversal).toMatchObject({ paymentId: payment.id, reversalDate: "2025-04-11" });
    expect((await apService.listSupplierBalances(biz.id))[0].balance).toBe(500_000);
    const vouchers = await installmentsService.listPayments(biz.id);
    expect(vouchers).toContainEqual(expect.objectContaining({
      id: payment.id,
      partyName: "Acme",
      locationName: "Main",
      reversed: true,
      reversalEntryId: reversal.reversalEntryId,
      reversalDate: "2025-04-11",
    }));
    await expect(apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.locationId,
      paymentId: payment.id,
      actorId: user.id,
      reversalDate: "2025-04-12",
    })).rejects.toThrow("already_reversed");

    const lines = await apService.getSupplierStatement(biz.id, supplier.id);
    expect(lines.map((line) => line.type)).toEqual(["bill", "payment", "payment_reversal"]);
    expect(lines.map((line) => line.balance)).toEqual([500_000, 300_000, 500_000]);
    expect(lines[2]).toMatchObject({
      journalEntryId: reversal.reversalEntryId,
      sourceType: "ap_payment_reversal",
      sourceId: payment.id,
      paymentVoucherId: payment.id,
      attributionStatus: "attributed",
      supplierLocationId: biz.locationId,
      supplierLocationName: "Main",
    });
  });

  it("does not allow a reversal from a different tenant or branch", async () => {
    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 10_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    await expect(apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.branchLocationId,
      paymentId: payment.id,
      actorId: user.id,
    })).rejects.toThrow("supplier_location_mismatch");
    await expect(apService.reverseApPayment({
      businessId: randomUUID(),
      locationId: biz.locationId,
      paymentId: payment.id,
      actorId: user.id,
    })).rejects.toThrow("payment_not_found");
  });

  it("obeys fiscal-period locks for the reversal date", async () => {
    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 10_000,
      paymentDate: "2025-03-10",
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    const year = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
       VALUES ($1, 'test-2025', '2025-01-01', '2026-01-01') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on, status)
       VALUES ($1, $2, 'locked-april', '2025-04-01', '2025-05-01', 'locked')`,
      [biz.id, year.rows[0].id],
    );
    await expect(apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.locationId,
      paymentId: payment.id,
      actorId: user.id,
      reversalDate: "2025-04-15",
    })).rejects.toThrow("fiscal_period_locked");
  });
});

describe("payment reversal source state and voucher numbering (issue #829)", () => {
  it("marks the source voucher reversed so the register reads it without a journal join", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 200_000,
      paymentDate: "2025-04-10",
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    const reversal = await apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.locationId,
      paymentId: payment.id,
      actorId: user.id,
      reversalDate: "2025-04-11",
    });

    const detail = await apService.getPaymentDetail(biz.id, payment.id);
    expect(detail).not.toBeNull();
    expect(detail!.reversedAt).toBeTruthy();
    expect(detail!.reversalEntryId).toBe(reversal.reversalEntryId);
    expect(detail!.reversalDate).toBe("2025-04-11");

    const page = await installmentsService.listPaymentsPage(biz.id, { status: "reversed" });
    expect(page.rows.map((row) => row.id)).toContain(payment.id);
    const active = await installmentsService.listPaymentsPage(biz.id, { status: "active" });
    expect(active.rows.map((row) => row.id)).not.toContain(payment.id);
  });

  it("refuses to reverse an installment-linked payment", async () => {
    const plan = await installmentsService.createInstallmentPlan({
      businessId: biz.id,
      locationId: biz.locationId,
      direction: "payable",
      source: "party",
      partyId: party.id,
      principal: 100_000,
      installmentCount: 1,
      intervalMonths: 1,
      firstDueDate: "2025-04-10",
      createdBy: user.id,
    });
    const { rows: itemRows } = await db.query<{ id: string }>(
      "SELECT id FROM installment_items WHERE installment_id = $1",
      [plan.id],
    );
    await installmentsService.payInstallmentItem({
      businessId: biz.id,
      locationId: biz.locationId,
      planId: plan.id,
      itemId: itemRows[0].id,
      method: "cash",
      createdBy: user.id,
    });
    const { rows: paymentRows } = await db.query<{ payment_id: string }>(
      "SELECT payment_id FROM installment_items WHERE id = $1",
      [itemRows[0].id],
    );
    await expect(apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.locationId,
      paymentId: paymentRows[0].payment_id,
      actorId: user.id,
    })).rejects.toThrow("payment_linked_to_installment");
  });

  it("numbers payment vouchers sequentially per business", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    const first = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 10_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    const second = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank",
      amount: 20_000,
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    expect(first.voucherNumber).toBe(1);
    expect(second.voucherNumber).toBe(2);
  });
});

describe("getSupplierStatement", () => {
  it("returns bills and payments oldest-first with a running balance", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 200_000,
      paymentDate: "2025-04-10",
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });

    const lines = await apService.getSupplierStatement(biz.id, supplier.id);
    expect(lines.map((l) => l.type)).toEqual(["bill", "payment"]);
    expect(lines[0].balance).toBe(500_000);
    expect(lines[1].balance).toBe(300_000);
  });
});

describe("payable installment branch behavior and retries", () => {
  async function addSecondAlias() {
    return db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name, party_id) VALUES ($1, 'Acme Branch', $2) RETURNING id",
      [biz.branchLocationId, party.id],
    );
  }

  function installmentInput(locationId: string | null) {
    return {
      businessId: biz.id,
      locationId,
      direction: "payable" as const,
      source: "party" as const,
      partyId: party.id,
      principal: 100_000,
      installmentCount: 1,
      intervalMonths: 1,
      firstDueDate: "2025-04-10",
      createdBy: user.id,
    };
  }

  it("rejects a null-location plan when the party has aliases in multiple branches", async () => {
    await addSecondAlias();
    await expect(installmentsService.createInstallmentPlan(installmentInput(null))).rejects.toThrow("installment_location_required");
  });

  it("uses the sole alias location for a legacy null-location plan when no branch is active", async () => {
    const plan = await installmentsService.createInstallmentPlan(installmentInput(null));
    const { rows: itemRows } = await db.query<{ id: string }>(
      "SELECT id FROM installment_items WHERE installment_id = $1",
      [plan.id],
    );
    await installmentsService.payInstallmentItem({
      businessId: biz.id,
      locationId: null,
      planId: plan.id,
      itemId: itemRows[0].id,
      method: "cash",
      createdBy: user.id,
    });
    const payment = await db.query<{ supplier_id: string; location_id: string }>(
      "SELECT supplier_id, location_id FROM ap_payments WHERE client_request_id = $1",
      [`installment-ap:${plan.id}:${itemRows[0].id}`],
    );
    expect(payment.rows[0]).toEqual({ supplier_id: supplier.id, location_id: biz.locationId });
  });

  it("binds a payable slice to its branch alias and makes retries idempotent", async () => {
    const secondAlias = await addSecondAlias();
    const plan = await installmentsService.createInstallmentPlan(installmentInput(biz.branchLocationId));
    const { rows: itemRows } = await db.query<{ id: string }>(
      "SELECT id FROM installment_items WHERE installment_id = $1",
      [plan.id],
    );
    const itemId = itemRows[0].id;

    await expect(installmentsService.payInstallmentItem({
      businessId: biz.id,
      locationId: biz.locationId,
      planId: plan.id,
      itemId,
      method: "cash",
      createdBy: user.id,
    })).rejects.toThrow("supplier_location_mismatch");

    await Promise.all([1, 2].map(() => installmentsService.payInstallmentItem({
      businessId: biz.id,
      locationId: biz.branchLocationId,
      planId: plan.id,
      itemId,
      method: "cash",
      createdBy: user.id,
    })));

    const { rows: paymentRows } = await db.query<{
      payment_id: string;
      supplier_id: string;
      location_id: string;
      client_request_id: string;
      request_fingerprint: string;
    }>(
      `SELECT p.id AS payment_id, p.supplier_id, p.location_id, p.client_request_id, p.request_fingerprint
         FROM ap_payments p JOIN installment_items i ON i.payment_id = p.id
        WHERE i.id = $1`,
      [itemId],
    );
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]).toMatchObject({
      supplier_id: secondAlias.rows[0].id,
      location_id: biz.branchLocationId,
      client_request_id: `installment-ap:${plan.id}:${itemId}`,
    });
    expect(paymentRows[0].request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await expect(installmentsService.payInstallmentItem({
      businessId: biz.id,
      locationId: biz.branchLocationId,
      planId: plan.id,
      itemId,
      method: "bank",
      createdBy: user.id,
    })).rejects.toThrow("idempotency_conflict");
  });
});

describe("canonical A/P source attribution and reconciliation", () => {
  it("attributes each automatic source, keeps intentional/conditional exceptions visible, and reconciles to GL 2100", async () => {
    const purchaseId = await postCreditPurchase("2025-04-01", supplier.id, 100_000);
    await postSupplierReturn("2025-04-02", purchaseId, 10_000, "accounts_payable");
    await postSupplierReturn("2025-04-03", purchaseId, 5_000, "cash");

    const retailPurchaseId = await postRetailPurchase(supplier.id, 200_000);
    await postRetailSupplierReturn(retailPurchaseId, 20_000, "accounts_payable");
    await postRetailSupplierReturn(retailPurchaseId, 7_000, "cash");

    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "cash",
      amount: 30_000,
      paymentDate: "2025-04-06",
      clientRequestId: randomUUID(),
      createdBy: user.id,
    });
    await apService.reverseApPayment({
      businessId: biz.id,
      locationId: biz.locationId,
      paymentId: payment.id,
      actorId: user.id,
      reversalDate: "2025-04-07",
    });

    const { rows: chequeRows } = await db.query<{ id: string }>(
      `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name, amount, issue_date, due_date, counterparty_name)
       VALUES ($1, $2, 'receivable', 'bounced', $3, 'Test Bank', 50000, '2025-04-02', '2025-04-20', 'Customer')
       RETURNING id`,
      [biz.id, biz.locationId, `CH-${randomUUID().slice(0, 8)}`],
    );
    const chequeId = chequeRows[0].id;
    await db.query(
      `INSERT INTO cheque_events (business_id, cheque_id, event, occurred_on, endorsed_to_supplier_id)
       VALUES ($1, $2, 'endorsed', '2025-04-04', $3), ($1, $2, 'bounced', '2025-04-08', NULL)`,
      [biz.id, chequeId, supplier.id],
    );
    await postApJournalLine({ entryDate: "2025-04-04", sourceType: "cheque", sourceId: chequeId, side: "debit", amount: 50_000 });
    await postApJournalLine({ entryDate: "2025-04-08", sourceType: "cheque", sourceId: chequeId, side: "credit", amount: 50_000 });

    const { rows: planRows } = await db.query<{ id: string }>(
      `INSERT INTO installments
         (business_id, location_id, direction, source, party_id, principal, installment_count, interval_months, first_due_date)
       VALUES ($1, $2, 'payable', 'party', $3, 100000, 1, 1, '2025-04-01') RETURNING id`,
      [biz.id, biz.locationId, party.id],
    );
    await postApJournalLine({ entryDate: "2025-04-09", sourceType: "installment_interest", sourceId: planRows[0].id, side: "credit", amount: 80_000 });

    const intentionalUnknownSources: [string, "debit" | "credit", number][] = [
      ["manual", "credit", 9_000],
      ["manual_adjustment", "debit", 2_000],
      ["opening", "credit", 15_000],
      ["holoo_import", "debit", 1_000],
    ];
    for (const [sourceType, side, amount] of intentionalUnknownSources) {
      await postApJournalLine({ entryDate: "2025-04-10", sourceType, sourceId: randomUUID(), side, amount });
    }

    const supplierLines = await apService.getSupplierStatement(biz.id, supplier.id);
    const unknownLines = await apService.getSupplierStatement(biz.id, "unknown");
    const supplierSources = new Set(supplierLines.map((line) => line.sourceType));
    for (const sourceType of [
      "purchase", "supplier_return", "item_purchase", "item_supplier_return",
      "ap_payment", "ap_payment_reversal", "cheque", "installment_interest",
    ]) expect(supplierSources.has(sourceType)).toBe(true);

    expect(supplierLines.every((line) => line.attributionStatus === "attributed")).toBe(true);
    for (const sourceType of ["manual", "manual_adjustment", "opening", "holoo_import"]) {
      expect(unknownLines.find((line) => line.sourceType === sourceType)?.attributionStatus).toBe("intentional_unknown");
    }
    expect(unknownLines.find((line) => line.sourceType === "supplier_return")?.attributionStatus).toBe("conditional_missing");
    expect(unknownLines.find((line) => line.sourceType === "item_supplier_return")?.attributionStatus).toBe("conditional_missing");
    expect(supplierLines.every((line) => line.journalEntryId && line.journalLineId && line.sourceId)).toBe(true);
    expect(unknownLines.every((line) => line.journalEntryId && line.journalLineId && line.sourceId)).toBe(true);
    expect(unknownLines.every((line) => line.locationName === "Main")).toBe(true);

    const balances = await apService.listSupplierBalances(biz.id);
    const supplierTotal = balances.filter((row) => row.supplierId !== "unknown").reduce((sum, row) => sum + row.balance, 0);
    const unknownTotal = balances.find((row) => row.supplierId === "unknown")?.balance ?? 0;
    const control = await db.query<{ balance: string }>(
      "SELECT COALESCE(sum(jl.credit - jl.debit), 0)::text AS balance FROM journal_lines jl WHERE jl.account_id = $1",
      [acct.accountsPayable],
    );
    expect(supplierTotal).toBe(350_000);
    expect(unknownTotal).toBe(9_000);
    expect(supplierTotal + unknownTotal).toBe(Number(control.rows[0].balance));
  });
});

describe("getApAging", () => {
  it("buckets an old unpaid bill as over90 as of a later date", async () => {
    await postCreditPurchase("2025-01-01", supplier.id, 500_000);

    const aging = await apService.getApAging(biz.id, "2025-04-15");
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0].over90).toBe(500_000);
    expect(aging.rows[0].total).toBe(500_000);
    expect(aging.totals.over90).toBe(500_000);
  });
});
