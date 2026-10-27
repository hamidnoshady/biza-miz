/**
 * Service invoices — an engineering/contracting business (issue #799) and a
 * service company bill a client from the same invoice screen every retail trade
 * uses, with described services instead of stocked lines.
 *
 * The claims this file checks:
 *   1. A service invoice is an ordinary `orders` row: numbered, settled in one
 *      step, with one `payments` row per tender slice and a null `item_id`.
 *   2. Each line posts ONE revenue entry (no COGS, no stock) crediting the
 *      revenue account it named, with VAT to 2200 and the debit by tender —
 *      cash, or receivable for a نسیه sale, which needs a customer.
 *   3. A line can only credit one of its trade's own revenue accounts, and a
 *      trade that sells goods cannot write a service line.
 *   4. Voiding the invoice reverses every entry, writes the offsetting payment
 *      and leaves the trial balance at zero — a service line has no stock to
 *      restore and must not trip the "item was deleted" refusal.
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
let invoiceService: typeof import("../src/lib/retail-invoice-service");
let voidService: typeof import("../src/lib/retail-invoice-void-service");
let readService: typeof import("../src/lib/retail-invoice/read-service");

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
  databaseName = `pos_service_invoice_${randomUUID().replaceAll("-", "")}`;

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
  invoiceService = await import("../src/lib/retail-invoice-service");
  voidService = await import("../src/lib/retail-invoice-void-service");
  readService = await import("../src/lib/retail-invoice/read-service");

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

const ACCOUNT_SEED: [string, string, string][] = [
  ["1100", "Cash", "asset"],
  ["1200", "Accounts Receivable", "asset"],
  ["2200", "VAT Payable", "liability"],
  ["4500", "Subscription revenue", "revenue"],
  ["4510", "Implementation revenue", "revenue"],
  ["4610", "Design revenue", "revenue"],
  ["4620", "Supervision revenue", "revenue"],
  ["4630", "Construction revenue", "revenue"],
];

async function seedBusiness(industry: string, seedAccounts = ACCOUNT_SEED) {
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM order_amendments");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Service Co', $1, $2) RETURNING id",
    [`service-${randomUUID().slice(0, 8)}`, industry],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  for (const [code, name, type] of seedAccounts) {
    await db.query("INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4)", [
      biz.id,
      code,
      name,
      type,
    ]);
  }
}

async function createCustomer(name = "کارفرما") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, $2) RETURNING id",
    [biz.id, name],
  );
  return rows[0].id;
}

async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

async function invoice(input: Parameters<typeof invoiceService.createRetailInvoice>[1]) {
  return withTransaction((client) => invoiceService.createRetailInvoice(client, input));
}

/** debit − credit per account code, over the live (un-reversed + reversal) ledger. */
async function balances(): Promise<Record<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, SUM(jl.debit - jl.credit)::text AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code`,
    [biz.id],
  );
  return Object.fromEntries(rows.map((r) => [r.code, BigInt(r.net)]));
}

describe("an architecture/contracting invoice", () => {
  beforeEach(async () => {
    await seedBusiness("architecture_construction");
  });

  it("posts one revenue entry per service line to the account the line named", async () => {
    // 2 × 10,000,000 = 20,000,000 (design, 10% VAT → 2,000,000);
    // 1 × 50,000,000 − 5,000,000 discount = 45,000,000 (execution, 10% VAT → 4,500,000).
    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "architecture_construction",
      tenders: [{ method: "cash" }],
      lines: [
        { kind: "service", description: "طراحی نقشه معماری", quantity: "2", unitPrice: 10_000_000, vatPercent: 10 },
        {
          kind: "service",
          description: "اجرای اسکلت",
          quantity: "1",
          unitPrice: 50_000_000,
          discount: 5_000_000,
          vatPercent: 10,
          revenueCode: "4630",
        },
      ],
    });

    expect(result.subtotal).toBe("70000000");
    expect(result.discount).toBe("5000000");
    expect(result.tax).toBe("6500000");
    expect(result.total).toBe("71500000");
    expect(result.lines.map((l) => l.name)).toEqual(["طراحی نقشه معماری", "اجرای اسکلت"]);

    const books = await balances();
    expect(books["1100"]).toBe(71_500_000n); // cash in
    expect(books["4610"]).toBe(-20_000_000n); // default design revenue
    expect(books["4630"]).toBe(-45_000_000n); // the account the second line named
    expect(books["2200"]).toBe(-6_500_000n); // VAT collected
    expect(Object.values(books).reduce((a, b) => a + b, 0n)).toBe(0n);

    // Exactly the revenue half: no COGS entry, and one entry per line.
    const { rows: entries } = await db.query<{ posting_kind: string }>(
      "SELECT posting_kind FROM journal_entries WHERE business_id = $1",
      [biz.id],
    );
    expect(entries.map((e) => e.posting_kind)).toEqual(["service_sale_revenue", "service_sale_revenue"]);
  });

  it("writes an ordinary order: no catalogue row, a service snapshot, one payment", async () => {
    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "architecture_construction",
      tenders: [{ method: "cash" }],
      lines: [{ kind: "service", description: "نظارت بر اجرا", quantity: "1", unitPrice: 8_000_000, vatPercent: 0, revenueCode: "4620" }],
    });

    const { rows: items } = await db.query<{ item_id: string | null; name_snapshot: string; retail_snapshot: Record<string, unknown> }>(
      "SELECT item_id, name_snapshot, retail_snapshot FROM order_items WHERE order_id = $1",
      [result.orderId],
    );
    expect(items).toHaveLength(1);
    expect(items[0].item_id).toBeNull();
    expect(items[0].name_snapshot).toBe("نظارت بر اجرا");
    expect(items[0].retail_snapshot).toMatchObject({ kind: "service", revenueCode: "4620", quantity: "1", total: "8000000" });
    expect((items[0].retail_snapshot.ledgerEntryIds as string[]).length).toBe(1);

    const { rows: payments } = await db.query<{ amount: string; method: string }>(
      "SELECT amount::text, method::text FROM payments WHERE order_id = $1",
      [result.orderId],
    );
    expect(payments).toEqual([{ amount: "8000000", method: "cash" }]);

    // The read model the invoice screen, the list and the printed document use.
    const detail = await readService.getRetailInvoiceDetail(biz.id, biz.locationId, result.orderId);
    expect(detail?.status).toBe("completed");
    expect(detail?.lines[0]).toMatchObject({ kind: "service", nameSnapshot: "نظارت بر اجرا", itemId: null });
    expect(detail?.total).toBe(8_000_000);
  });

  it("books a credit sale to receivables and requires a client", async () => {
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "architecture_construction",
        tenders: [{ method: "credit" }],
        lines: [{ kind: "service", description: "طراحی", quantity: "1", unitPrice: 1_000_000, vatPercent: 0 }],
      }),
    ).rejects.toThrow();

    const customerId = await createCustomer();
    await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "architecture_construction",
      customerId,
      tenders: [{ method: "cash", amount: "400000" as never }, { method: "credit" }],
      lines: [{ kind: "service", description: "طراحی", quantity: "1", unitPrice: 1_000_000, vatPercent: 0 }],
    });
    const books = await balances();
    expect(books["1100"]).toBe(400_000n);
    expect(books["1200"]).toBe(600_000n);
    expect(books["4610"]).toBe(-1_000_000n);
  });

  it("refuses a revenue account of another trade, a blank description and a goods line — and writes nothing", async () => {
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "architecture_construction" as const,
      tenders: [{ method: "cash" as const }],
    };
    await expect(
      invoice({ ...base, lines: [{ kind: "service", description: "طراحی", quantity: "1", unitPrice: 1_000, vatPercent: 0, revenueCode: "4500" }] }),
    ).rejects.toThrow();
    await expect(
      invoice({ ...base, lines: [{ kind: "service", description: "  ", quantity: "1", unitPrice: 1_000, vatPercent: 0 }] }),
    ).rejects.toThrow();
    await expect(
      invoice({ ...base, lines: [{ kind: "stocked", itemId: randomUUID(), quantity: "1", vatPercent: 0 }] }),
    ).rejects.toThrow();

    const { rows } = await db.query("SELECT 1 FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(rows).toHaveLength(0);
    expect(await balances()).toEqual({});
  });

  it("voids: reverses every entry, offsets the payment and leaves the books at zero", async () => {
    const created = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "architecture_construction",
      tenders: [{ method: "cash" }],
      lines: [
        { kind: "service", description: "طراحی", quantity: "1", unitPrice: 10_000_000, vatPercent: 10 },
        { kind: "service", description: "نظارت", quantity: "1", unitPrice: 2_000_000, vatPercent: 10, revenueCode: "4620" },
      ],
    });

    const result = await withTransaction((client) =>
      voidService.voidRetailInvoice(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: created.orderId,
        actorId: null,
        reason: "اشتباه",
      }),
    );
    expect(result.reversedEntryIds).toHaveLength(2);
    expect(new Set(result.reversedEntryIds).size).toBe(2);

    const books = await balances();
    for (const code of ["1100", "4610", "4620", "2200"]) {
      expect(books[code] ?? 0n, code).toBe(0n);
    }
    const { rows } = await db.query<{ status: string }>("SELECT status::text FROM orders WHERE id = $1", [created.orderId]);
    expect(rows[0].status).toBe("voided");
    const { rows: payments } = await db.query<{ amount: string }>(
      "SELECT amount::text FROM payments WHERE order_id = $1 ORDER BY received_at, id",
      [created.orderId],
    );
    expect(payments.map((p) => Number(p.amount)).sort((a, b) => a - b)).toEqual([-13_200_000, 13_200_000]);
  });

  it("is idempotent under the till's submission key", async () => {
    const input = {
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "architecture_construction" as const,
      tenders: [{ method: "cash" as const }],
      clientRequestId: randomUUID(),
      lines: [{ kind: "service" as const, description: "طراحی", quantity: "1", unitPrice: 1_000_000, vatPercent: 0 }],
    };
    const first = await invoice(input);
    const retry = await invoice(input);
    expect(retry.orderId).toBe(first.orderId);
    expect((await balances())["4610"]).toBe(-1_000_000n);
  });
});

describe("a service company invoice", () => {
  beforeEach(async () => {
    await seedBusiness("service_saas");
  });

  it("defaults to subscription revenue and accepts the implementation account", async () => {
    await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "service_saas",
      tenders: [{ method: "cash" }],
      lines: [
        { kind: "service", description: "اشتراک ماهانه", quantity: "1", unitPrice: 3_000_000, vatPercent: 0 },
        { kind: "service", description: "پیاده‌سازی", quantity: "1", unitPrice: 7_000_000, vatPercent: 0, revenueCode: "4510" },
      ],
    });
    const books = await balances();
    expect(books["4500"]).toBe(-3_000_000n);
    expect(books["4510"]).toBe(-7_000_000n);
    expect(books["1100"]).toBe(10_000_000n);
  });

  it("refuses the engineering revenue accounts", async () => {
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "service_saas",
        tenders: [{ method: "cash" }],
        lines: [{ kind: "service", description: "طراحی", quantity: "1", unitPrice: 1_000, vatPercent: 0, revenueCode: "4610" }],
      }),
    ).rejects.toThrow();
  });
});

describe("a trade that sells goods", () => {
  it("cannot write a service line", async () => {
    await seedBusiness("accessories");
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "accessories",
        tenders: [{ method: "cash" }],
        lines: [{ kind: "service", description: "خدمت", quantity: "1", unitPrice: 1_000, vatPercent: 0 }],
      }),
    ).rejects.toThrow();
  });
});
