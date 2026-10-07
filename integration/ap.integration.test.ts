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

const biz = { id: "", locationId: "" };
const acct = { cash: "", bankClearing: "", inventory: "", accountsPayable: "" };
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
  biz.locationId = locRow.rows[0].id;

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
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'),
            ($1, '1300', 'Inventory', 'asset'), ($1, '2100', 'Accounts Payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "1300") acct.inventory = r.id;
    if (r.code === "2100") acct.accountsPayable = r.id;
  }
});

let purchaseCounter = 0;

/** Mirrors what postExactPurchaseEntry posts for a credit-settled purchase: Debit Inventory / Credit Accounts Payable. */
async function postCreditPurchase(entryDate: string, supplierId: string | null, amount: number): Promise<string> {
  purchaseCounter += 1;
  const { rows: purchaseRows } = await db.query<{ id: string }>(
    `INSERT INTO purchases (location_id, supplier_id, status, total, settlement_method, note, received_at)
     VALUES ($1, $2, 'received', $3, 'credit', $4, $5) RETURNING id`,
    [biz.locationId, supplierId, amount, `purchase #${purchaseCounter}`, entryDate],
  );
  const purchaseId = purchaseRows[0].id;
  const { rows: entryRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, 'Purchase receipt', 'purchase', $3) RETURNING id`,
    [biz.id, entryDate, purchaseId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryRows[0].id, acct.inventory, amount, acct.accountsPayable],
  );
  return purchaseId;
}

/** Mirrors postExactOperationalInventoryEntry for a supplier return settled against the payable: Debit Accounts Payable / Credit Inventory. */
async function postSupplierReturn(entryDate: string, purchaseId: string, amount: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO supplier_returns (business_id, location_id, purchase_id, settlement_method, total_value_rial, reason, idempotency_key)
     VALUES ($1, $2, $3, 'accounts_payable', $4, 'damaged', $5) RETURNING id`,
    [biz.id, biz.locationId, purchaseId, amount, `return-${randomUUID()}`],
  );
  const returnId = rows[0].id;
  const { rows: entryRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, 'Supplier return', 'supplier_return', $3) RETURNING id`,
    [biz.id, entryDate, returnId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryRows[0].id, acct.accountsPayable, amount, acct.inventory],
  );
  return returnId;
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

  it("posts to bank-clearing for a bank payment", async () => {
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);

    await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank",
      amount: 100_000,
      createdBy: user.id,
    });

    const { rows } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(credit),0) AS credit FROM journal_lines WHERE account_id = $1`,
      [acct.bankClearing],
    );
    expect(Number(rows[0].credit)).toBe(100_000);
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
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_amount");
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
      createdBy: user.id,
    });

    const lines = await apService.getSupplierStatement(biz.id, supplier.id);
    expect(lines.map((l) => l.type)).toEqual(["bill", "payment"]);
    expect(lines[0].balance).toBe(500_000);
    expect(lines[1].balance).toBe(300_000);
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

describe("listSupplierBalancePage", () => {
  it("pages in SQL and summarises the subledger against its control account", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name) VALUES ($1, 'Beta') RETURNING id",
      [biz.locationId],
    );
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);
    await postCreditPurchase("2025-04-02", other.rows[0].id, 300_000);

    const first = await apService.listSupplierBalancePage(biz.id, { limit: 1, offset: 0 });
    expect(first.suppliers).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.summary.payableTotal).toBe(800_000);
    expect(first.summary.advanceTotal).toBe(0);
    expect(first.summary.netTotal).toBe(800_000);
    // The liability's own sign: the control account reads credit-positive.
    expect(first.summary.controlBalance).toBe(800_000);
    expect(first.summary.reconciles).toBe(true);

    const second = await apService.listSupplierBalancePage(biz.id, { limit: 1, offset: 1 });
    expect(second.suppliers).toHaveLength(1);
    expect(second.summary).toEqual(first.summary);
  });

  it("searches the supplier file's phone and accounting code, not only the name", async () => {
    await db.query("UPDATE parties SET accounting_code = '700011' WHERE id = $1", [party.id]);
    await postCreditPurchase("2025-04-01", supplier.id, 500_000);

    const byPhone = await apService.listSupplierBalancePage(biz.id, { q: "0912", limit: 25, offset: 0 });
    expect(byPhone.suppliers.map((row) => row.supplierId)).toEqual([supplier.id]);

    const byCode = await apService.listSupplierBalancePage(biz.id, { q: "700011", limit: 25, offset: 0 });
    expect(byCode.suppliers.map((row) => row.supplierId)).toEqual([supplier.id]);
    expect(byCode.total).toBe(1);
  });

  it("folds the typed search in SQL, the same way the A/R list does", async () => {
    const jafar = await db.query<{ id: string }>(
      `INSERT INTO suppliers (location_id, name) VALUES ($1, 'جعفر') RETURNING id`,
      [biz.locationId],
    );
    await postCreditPurchase("2025-04-01", jafar.rows[0].id, 150_000);
    const found = await apService.listSupplierBalancePage(biz.id, { q: "جعفر", limit: 25, offset: 0 });
    expect(found.suppliers.map((row) => row.supplierId)).toEqual([jafar.rows[0].id]);
    expect(found.total).toBe(1);
  });
});

describe("date integrity", () => {
  it("rejects impossible calendar dates on the payment and on the aging report", async () => {
    for (const impossible of ["2026-02-29", "2025-02-30", "2026-04-31", "2026-13-01"]) {
      await expect(
        apService.payBill({
          businessId: biz.id,
          locationId: biz.locationId,
          supplierId: supplier.id,
          method: "cash",
          amount: 10_000,
          paymentDate: impossible,
          createdBy: user.id,
        }),
      ).rejects.toThrow("invalid_date");
      await expect(apService.getApAging(biz.id, impossible)).rejects.toThrow("invalid_date");
    }
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ap_payments");
    expect(rows[0].n).toBe(0);
  });

  it("accepts a real leap day", async () => {
    await postCreditPurchase("2024-02-01", supplier.id, 100_000);
    const payment = await apService.payBill({
      businessId: biz.id,
      locationId: biz.locationId,
      supplierId: supplier.id,
      method: "bank",
      amount: 40_000,
      paymentDate: "2024-02-29",
      createdBy: user.id,
    });
    expect(payment.paymentDate).toBe("2024-02-29");
    const aging = await apService.getApAging(biz.id, "2024-02-29");
    expect(aging.asOfDate).toBe("2024-02-29");
    expect(aging.rows[0].total).toBe(60_000);
  });
});
