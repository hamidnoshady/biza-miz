/**
 * The A/R (and A/P) hardening issue, proven through the HTTP routes.
 *
 * The service-level behavior is covered in ar.integration.test.ts /
 * ap.integration.test.ts. What this file pins down is the *contract the
 * browser actually meets*, because that is where the original defects were
 * visible:
 *
 *  1. `/accounting/receivables` is readable with `ledger.view` alone — so the
 *     page must not offer a write the API will refuse, and the API must refuse
 *     it anyway when a crafted request asks. Both halves are asserted:
 *     `finance.receivables_manage` is required by the POST, and the same POST
 *     succeeds once the member holds it.
 *  2. A receipt cannot be posted against anything that is not an active,
 *     unmerged customer party — supplier-only, employee-only, deactivated and
 *     merged records are all refused with `customer_not_found` (404), not
 *     written.
 *  3. Impossible calendar dates are refused at both boundaries: the route's
 *     validator and the service's, with `invalid_date` (400), while a real
 *     leap day is accepted.
 *  4. The balance list is a window: `?q=` and `?limit=`/`?offset=` are honored,
 *     `total` counts the match before the window, and the `summary` beside them
 *     is the whole subledger — unchanged by the page. With no `limit` at all
 *     the older callers (the directory's balance column) still get the whole
 *     list.
 *  5. A statement can be drilled into: the entry route answers the journal
 *     entry behind a line, and it is scoped to the business that asked.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/** The fake session the mocked auth hands the routes, with the permissions the case wants. */
const sessionState: { businessId: string; sub: string; locationId: string; permissions: Set<string> } = {
  businessId: "",
  sub: randomUUID(),
  locationId: "",
  permissions: new Set<string>(),
};

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  const sessionFor = () => ({
    businessId: sessionState.businessId,
    locationId: sessionState.locationId,
    activeLocationId: sessionState.locationId,
    sub: sessionState.sub,
    role: "owner",
  });
  return {
    ...actual,
    // The real guard answers `{ session, error }`; the error is the response
    // the route returns untouched. Modelling denial as the real 403 keeps the
    // routes honest — a route that forgot to check `error` would still pass a
    // request through, and this file would catch it.
    requirePermission: vi.fn(async (permission: string) =>
      sessionState.permissions.has(permission)
        ? { session: sessionFor(), error: null }
        : { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) },
    ),
    withTenantScope:
      (handler: (...args: any[]) => Promise<Response>) =>
        (...args: any[]) => (globalThis as any).__withTenant(() => handler(...args)),
  };
});

vi.mock("../src/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/setup-state")>();
  return {
    ...actual,
    resolveActiveLocation: vi.fn(async () => ({ id: sessionState.locationId })),
  };
});

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let arService: typeof import("../src/lib/ar-service");
let partiesService: typeof import("../src/lib/parties-service");
let accountIdsByCode: typeof import("../src/lib/ledger-service").accountIdsByCode;

let customersRoute: typeof import("../src/app/api/ledger/ar/customers/route");
let customerRoute: typeof import("../src/app/api/ledger/ar/customers/[id]/route");
let agingRoute: typeof import("../src/app/api/ledger/ar/aging/route");
let receiptsRoute: typeof import("../src/app/api/ledger/ar/receipts/route");
let suppliersRoute: typeof import("../src/app/api/ledger/ap/suppliers/route");
let entryRoute: typeof import("../src/app/api/ledger/entries/[id]/route");

const biz = { id: "", locationId: "" };
const acct = { cash: "", accountsReceivable: "", revenue: "" };
let orderCounter = 0;

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

function jsonRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

/** Mirrors postExactOrderPaymentEntry: Debit AR / Credit Sales Revenue. */
async function postCreditOrder(entryDate: string, customerId: string | null, amount: number): Promise<{ orderId: string; entryId: string }> {
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
  return { orderId, entryId: entryRows[0].id };
}

beforeAll(async () => {
  databaseName = `pos_receivables_${randomUUID().replaceAll("-", "")}`;

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
  partiesService = await import("../src/lib/parties-service");
  ({ accountIdsByCode } = await import("../src/lib/ledger-service"));

  customersRoute = await import("../src/app/api/ledger/ar/customers/route");
  customerRoute = await import("../src/app/api/ledger/ar/customers/[id]/route");
  agingRoute = await import("../src/app/api/ledger/ar/aging/route");
  receiptsRoute = await import("../src/app/api/ledger/ar/receipts/route");
  suppliersRoute = await import("../src/app/api/ledger/ap/suppliers/route");
  entryRoute = await import("../src/app/api/ledger/entries/[id]/route");

  (globalThis as any).__withTenant = (fn: () => Promise<unknown>) => dbLib.withTenant(sessionState.businessId, fn);

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

async function seedBusiness(): Promise<{ id: string; locationId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Receivables Co', $1) RETURNING id",
    [`recv-${randomUUID().slice(0, 8)}`],
  );
  const id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [id],
  );
  return { id, locationId: locRow.rows[0].id };
}

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM ar_receipts");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");

  const seeded = await seedBusiness();
  biz.id = seeded.id;
  biz.locationId = seeded.locationId;
  sessionState.businessId = biz.id;
  sessionState.locationId = biz.locationId;
  sessionState.permissions = new Set(["ledger.view"]);

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  sessionState.sub = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '4300', 'Sales', 'revenue'), ($1, '2100', 'Accounts Payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
  acct.cash = byCode.get("1100")!;
  acct.accountsReceivable = byCode.get("1200")!;
  acct.revenue = byCode.get("4300")!;
  expect((await accountIdsByCode(db as never, biz.id, ["1200"])).size).toBe(1);
});

/** A party with an explicit role set — the shapes `createCustomer` cannot make. */
async function insertParty(
  name: string,
  roles: ("customer" | "supplier" | "employee")[],
  options: { isActive?: boolean; mergedIntoId?: string | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles, is_active, merged_into_id)
     VALUES ($1, $2, $3, $4::text[], $5, $6) RETURNING id`,
    [biz.id, name, roles[0], roles, options.isActive ?? true, options.mergedIntoId ?? null],
  );
  return rows[0].id;
}

describe("what the page may offer, and what the API enforces", () => {
  it("lets a ledger.view member read every read model", async () => {
    const customer = await partiesService.createCustomer(biz.id, { name: "Ali" });
    await postCreditOrder("2025-04-01", customer.id, 500_000);

    const list = await customersRoute.GET(jsonRequest("/api/ledger/ar/customers?limit=25"));
    expect(list.status).toBe(200);

    const aging = await agingRoute.GET(jsonRequest("/api/ledger/ar/aging?asOfDate=2025-04-15"));
    expect(aging.status).toBe(200);

    const statement = await customerRoute.GET(jsonRequest(`/api/ledger/ar/customers/${customer.id}`), {
      params: Promise.resolve({ id: customer.id }),
    });
    expect(statement.status).toBe(200);

    const suppliers = await suppliersRoute.GET(jsonRequest("/api/ledger/ap/suppliers?limit=25"));
    expect(suppliers.status).toBe(200);
  });

  it("refuses the receive action to a member without finance.receivables_manage, and writes nothing", async () => {
    const customer = await partiesService.createCustomer(biz.id, { name: "Ali" });

    const response = await receiptsRoute.POST(
      jsonRequest("/api/ledger/ar/receipts", {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, method: "cash", amount: 100_000 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ar_receipts");
    expect(rows[0].n).toBe(0);
  });

  it("lets a member with finance.receivables_manage receive, and posts the journal entry", async () => {
    sessionState.permissions = new Set(["ledger.view", "finance.receivables_manage"]);
    const customer = await partiesService.createCustomer(biz.id, { name: "Ali" });
    const order = await postCreditOrder("2025-04-01", customer.id, 500_000);

    const response = await receiptsRoute.POST(
      jsonRequest("/api/ledger/ar/receipts", {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, method: "cash", amount: 200_000, receiptDate: "2025-04-10" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { receipt: { id: string; customerId: string; amount: number } };
    expect(payload.receipt.customerId).toBe(customer.id);
    expect(payload.receipt.amount).toBe(200_000);

    const { rows } = await db.query<{ debit: string }>(
      `SELECT COALESCE(SUM(debit), 0)::text AS debit FROM journal_lines WHERE account_id = $1`,
      [acct.cash],
    );
    expect(Number(rows[0].debit)).toBe(200_000);

    const lines = await arService.getCustomerStatement(biz.id, customer.id);
    expect(lines.map((line) => line.type)).toEqual(["invoice", "receipt"]);
    expect(lines[1].source?.type).toBe("ar_receipt");
    expect(order.orderId).toBeTruthy();
  });
});

describe("party integrity at the route boundary", () => {
  beforeEach(() => {
    sessionState.permissions = new Set(["ledger.view", "finance.receivables_manage"]);
  });

  async function postReceipt(customerId: string): Promise<Response> {
    return receiptsRoute.POST(
      jsonRequest("/api/ledger/ar/receipts", {
        method: "POST",
        body: JSON.stringify({ customerId, method: "cash", amount: 100_000 }),
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("refuses a supplier-only party", async () => {
    const supplier = await insertParty("Supplier only", ["supplier"]);
    const response = await postReceipt(supplier);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "customer_not_found" });
  });

  it("refuses an employee-only party", async () => {
    const employee = await insertParty("Employee only", ["employee"]);
    expect((await postReceipt(employee)).status).toBe(404);
  });

  it("refuses a deactivated customer", async () => {
    const retired = await insertParty("Retired", ["customer"], { isActive: false });
    expect((await postReceipt(retired)).status).toBe(404);
  });

  it("refuses a merged duplicate", async () => {
    const survivor = await insertParty("Survivor", ["customer"]);
    const duplicate = await insertParty("Duplicate", ["customer"], { mergedIntoId: survivor });
    expect((await postReceipt(duplicate)).status).toBe(404);
    expect((await postReceipt(survivor)).status).toBe(201);
  });

  it("accepts a party that holds Customer alongside another role", async () => {
    const both = await insertParty("Buyer and supplier", ["customer", "supplier"]);
    expect((await postReceipt(both)).status).toBe(201);
  });
});

describe("date integrity at the route boundary", () => {
  it("refuses impossible dates on the receipt and on the aging report", async () => {
    sessionState.permissions = new Set(["ledger.view", "finance.receivables_manage"]);
    const customer = await partiesService.createCustomer(biz.id, { name: "Ali" });

    for (const impossible of ["2026-02-29", "2025-02-30", "2026-04-31", "2026-13-01"]) {
      const receipt = await receiptsRoute.POST(
        jsonRequest("/api/ledger/ar/receipts", {
          method: "POST",
          body: JSON.stringify({ customerId: customer.id, method: "cash", amount: 10_000, receiptDate: impossible }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(receipt.status).toBe(400);
      expect(await receipt.json()).toEqual({ error: "invalid_date" });

      const aging = await agingRoute.GET(jsonRequest(`/api/ledger/ar/aging?asOfDate=${impossible}`));
      expect(aging.status).toBe(400);
      expect(await aging.json()).toEqual({ error: "invalid_date" });
    }

    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ar_receipts");
    expect(rows[0].n).toBe(0);
  });

  it("accepts a real leap day, at both boundaries", async () => {
    sessionState.permissions = new Set(["ledger.view", "finance.receivables_manage"]);
    const customer = await partiesService.createCustomer(biz.id, { name: "Ali" });

    const receipt = await receiptsRoute.POST(
      jsonRequest("/api/ledger/ar/receipts", {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, method: "cash", amount: 10_000, receiptDate: "2024-02-29" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(receipt.status).toBe(201);

    const aging = await agingRoute.GET(jsonRequest("/api/ledger/ar/aging?asOfDate=2024-02-29"));
    expect(aging.status).toBe(200);
    expect(((await aging.json()) as { asOfDate: string }).asOfDate).toBe("2024-02-29");
  });
});

describe("the balance list is a window, and the totals are not", () => {
  it("pages and searches, and keeps the summary whole", async () => {
    const ali = await partiesService.createCustomer(biz.id, { name: "Ali" });
    const sara = await partiesService.createCustomer(biz.id, { name: "Sara" });
    const mina = await partiesService.createCustomer(biz.id, { name: "Mina" });
    await postCreditOrder("2025-04-01", ali.id, 500_000);
    await postCreditOrder("2025-04-02", sara.id, 300_000);
    await arService.receivePayment({
      businessId: biz.id,
      locationId: biz.locationId,
      customerId: mina.id,
      method: "cash",
      amount: 100_000,
      receiptDate: "2025-04-03",
      createdBy: sessionState.sub,
    });

    const page = await customersRoute.GET(jsonRequest("/api/ledger/ar/customers?limit=2&offset=0"));
    const payload = (await page.json()) as {
      customers: { customerId: string }[];
      total: number;
      summary: { netTotal: number; controlBalance: number; reconciles: boolean };
    };
    expect(payload.customers).toHaveLength(2);
    expect(payload.total).toBe(3);
    expect(payload.summary.netTotal).toBe(700_000);
    expect(payload.summary.controlBalance).toBe(700_000);
    expect(payload.summary.reconciles).toBe(true);

    const searched = await customersRoute.GET(jsonRequest("/api/ledger/ar/customers?limit=25&q=Sara"));
    const searchedPayload = (await searched.json()) as { customers: { customerId: string }[]; total: number };
    expect(searchedPayload.customers.map((row) => row.customerId)).toEqual([sara.id]);
    expect(searchedPayload.total).toBe(1);
  });

  it("still answers the whole list when no window is asked for", async () => {
    // The directory's balance column and the assistant read this endpoint
    // without `?limit=`. A silent default page would truncate them.
    for (const name of ["Ali", "Sara", "Mina"]) {
      const party = await partiesService.createCustomer(biz.id, { name });
      await postCreditOrder("2025-04-01", party.id, 100_000);
    }
    const response = await customersRoute.GET(jsonRequest("/api/ledger/ar/customers"));
    const payload = (await response.json()) as { customers: unknown[]; total?: number };
    expect(payload.customers).toHaveLength(3);
    expect(payload.total).toBeUndefined();
  });
});

describe("drill-down", () => {
  it("serves the journal entry behind a statement line", async () => {
    const customer = await partiesService.createCustomer(biz.id, { name: "Ali" });
    const { entryId } = await postCreditOrder("2025-04-01", customer.id, 500_000);

    const response = await entryRoute.GET(jsonRequest(`/api/ledger/entries/${entryId}`), {
      params: Promise.resolve({ id: entryId }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      entry: { id: string; lines: { accountCode: string; debit: number; credit: number }[] };
    };
    expect(payload.entry.id).toBe(entryId);
    expect(payload.entry.lines.map((line) => line.accountCode)).toEqual(["1200", "4300"]);
    const debit = payload.entry.lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = payload.entry.lines.reduce((sum, line) => sum + line.credit, 0);
    expect(debit).toBe(credit);
  });

  it("hides another business's entry behind the same 404 as one that does not exist", async () => {
    const other = await seedBusiness();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, '2025-04-01', 'Theirs', 'manual') RETURNING id`,
      [other.id],
    );
    const response = await entryRoute.GET(jsonRequest(`/api/ledger/entries/${rows[0].id}`), {
      params: Promise.resolve({ id: rows[0].id }),
    });
    expect(response.status).toBe(404);

    const malformed = await entryRoute.GET(jsonRequest("/api/ledger/entries/not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(malformed.status).toBe(404);
  });

  it("answers a malformed customer id with 404 and the unknown bucket with a statement", async () => {
    await postCreditOrder("2025-04-01", null, 300_000);

    const malformed = await customerRoute.GET(jsonRequest("/api/ledger/ar/customers/not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: "customer_not_found" });

    const unknown = await customerRoute.GET(jsonRequest("/api/ledger/ar/customers/unknown"), {
      params: Promise.resolve({ id: "unknown" }),
    });
    expect(unknown.status).toBe(200);
    const payload = (await unknown.json()) as { lines: { debit: number }[] };
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].debit).toBe(300_000);
  });
});
