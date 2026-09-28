/**
 * Settling a bill *with a difference* — the manual «مبلغ دریافتی» flow.
 *
 * A cashier types what the customer actually handed over. Less than the bill
 * leaves the remainder as customer debt (an Accounts-Receivable debit plus a
 * `credit` payments row); more than the bill leaves the excess as customer
 * store credit (the 2410 liability plus an `order.customer_credit_issued`
 * event). Both are real accounting, posted in the same transaction as the
 * payment — not a number painted onto the customer's row.
 *
 * What this pins down, against a real database:
 *
 *  1. the ledger posting — an underpayment's AR debit and an overpayment's
 *     store-credit liability ride the payment entry and keep it balanced;
 *  2. the pay route — the difference requires a named customer, the payments
 *     rows tell one consistent story (a نسیه row for the debt), the order
 *     completes, and the credit surfaces in `storeCreditBalance`;
 *  3. the failure paths — a difference without a customer, and both
 *     difference directions at once, are refused before anything is written.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";
import { rialText, type RialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/** The fake session the mocked auth hands the route — business swapped per seed. */
const sessionState: { businessId: string; sub: string; locationId: string } = {
  businessId: "",
  sub: randomUUID(),
  locationId: "",
};

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      session: {
        businessId: sessionState.businessId,
        locationId: sessionState.locationId,
        activeLocationId: sessionState.locationId,
        sub: sessionState.sub,
        role: "cashier",
      },
      error: null,
    })),
    requirePermission: vi.fn(async () => ({
      session: {
        businessId: sessionState.businessId,
        locationId: sessionState.locationId,
        activeLocationId: sessionState.locationId,
        sub: sessionState.sub,
        role: "cashier",
      },
      error: null,
    })),
    withTenantScope:
      // The same scope wrapper the app runs handlers under, bound to the
      // seeded business — the route's own queries then meet the RLS the
      // production tenant isolation gives them.
       
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
let ledgerService: typeof import("../src/lib/ledger-service");
let loyaltyService: typeof import("../src/lib/loyalty-service");
let payRoute: typeof import("../src/app/api/orders/[id]/pay/route");

const biz = { id: "", locationId: "" };
const acct = {
  cash: "",
  accountsReceivable: "",
  storeCreditPayable: "",
  takeaway: "",
  vatPayable: "",
  tipsPayable: "",
  inventory: "",
  cogs: "",
};

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
  databaseName = `pos_settle_diff_${randomUUID().replaceAll("-", "")}`;

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
  ledgerService = await import("../src/lib/ledger-service");
  loyaltyService = await import("../src/lib/loyalty-service");
  payRoute = await import("../src/app/api/orders/[id]/pay/route");
  // The mocked auth's tenant wrapper delegates to the real one once it exists.
   
  (globalThis as any).__withTenant = (fn: () => Promise<unknown>) =>
    dbLib.withTenant(sessionState.businessId, fn);

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
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM inventory_events");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const seeded = await db.query<{ id: string; location_id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Settle Diff ${randomUUID().slice(0, 6)}`, `settle-diff-${randomUUID().slice(0, 8)}`],
  );
  biz.id = seeded.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = loc.rows[0].id;
  sessionState.businessId = biz.id;
  sessionState.locationId = biz.locationId;

  // The session's user — the pay route stamps it onto payments, inventory
  // events and journal entries, all of which reference users(id).
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'cashier', 'صندوقدار آزمون', 'x') RETURNING id`,
    [biz.id],
  );
  sessionState.sub = user.rows[0].id;

  // The full well-known set the payment entry resolves unconditionally —
  // a missing code is a hard failure by design (ledger_account_missing).
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1110', 'Bank', 'asset'),
            ($1, '1120', 'Card clearing', 'asset'), ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '1230', 'Platform Receivable', 'asset'),
            ($1, '2410', 'Store Credit Payable', 'liability'),
            ($1, '4310', 'Dine-in', 'revenue'), ($1, '4320', 'Takeaway', 'revenue'),
            ($1, '4330', 'Delivery', 'revenue'), ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '2400', 'Tips Payable', 'liability'), ($1, '1300', 'Inventory', 'asset'),
            ($1, '5100', 'COGS', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    "1200": "accountsReceivable",
    "2410": "storeCreditPayable",
    "4320": "takeaway",
    "2200": "vatPayable",
    "2400": "tipsPayable",
    "1300": "inventory",
    "5100": "cogs",
  };
  for (const row of accounts.rows) acct[byCode[row.code]] = row.id;
});

/** A customer in the directory — the person a difference is booked against. */
async function createCustomer(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles) VALUES ($1, 'امیر فهیم', 'customer', ARRAY['customer']) RETURNING id`,
    [biz.id],
  );
  return rows[0].id;
}

/** An open takeaway order for the given total (Rial), no lines — deductForOrder has nothing to consume. */
async function openOrder(totalRial: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, tax, total)
     VALUES ($1, 1, 'takeaway', 'open', $2, 0, 0, $2) RETURNING id`,
    [biz.locationId, totalRial],
  );
  return rows[0].id;
}

function payRequest(orderId: string, body: unknown) {
  return new NextRequest(`http://localhost/api/orders/${orderId}/pay`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function pay(orderId: string, body: unknown) {
  const response = await payRoute.POST(payRequest(orderId, body), {
    params: Promise.resolve({ id: orderId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function linesOfEntry(entryType: string, orderId: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND je.source_type = 'order' AND je.source_id = $2
        AND je.posting_kind = $3
      ORDER BY a.code`,
    [biz.id, orderId, entryType],
  );
  return rows;
}

describe("postExactOrderPaymentEntry — settling with a difference", () => {
  async function post(params: {
    tenders: { settlement: string; amount: RialText }[];
    amount: RialText;
    balanceDue?: RialText;
    customerCredit?: RialText;
  }) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id)
       VALUES ($1, $2, 'sale_consumption', 'order', $3) RETURNING id`,
      [biz.id, biz.locationId, randomUUID()],
    );
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        inventoryEventId: rows[0].id,
        tax: rialText("0"),
        orderChannel: "takeaway",
        ...params,
      } as Parameters<typeof ledgerService.postExactOrderPaymentEntry>[1]);
      await client.query("COMMIT");
      return entryId;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  it("books an underpayment's remainder as an Accounts-Receivable debit, still balanced", async () => {
    const entryId = await post({
      tenders: [{ settlement: "cash", amount: rialText("400000") }],
      amount: rialText("500000"),
      balanceDue: rialText("100000"),
    });
    expect(entryId).toBeTruthy();
    const { rows } = await db.query<{ debit: string; credit: string }>(
      `SELECT sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit
         FROM journal_lines jl WHERE jl.entry_id = $1`,
      [entryId],
    );
    // 400k cash + 100k AR = 500k revenue — both directions of the entry agree.
    expect(rows[0]).toEqual({ debit: "500000", credit: "500000" });
  });

  it("books an overpayment's excess as the store-credit liability, still balanced", async () => {
    const entryId = await post({
      tenders: [{ settlement: "cash", amount: rialText("600000") }],
      amount: rialText("500000"),
      customerCredit: rialText("100000"),
    });
    expect(entryId).toBeTruthy();
    const { rows } = await db.query<{ debit: string; credit: string }>(
      `SELECT sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit
         FROM journal_lines jl WHERE jl.entry_id = $1`,
      [entryId],
    );
    // 600k cash = 500k revenue + 100k owed back to the customer.
    expect(rows[0]).toEqual({ debit: "600000", credit: "600000" });
  });

  it("refuses both directions at once — a settlement is either debt or credit", async () => {
    await expect(
      post({
        tenders: [{ settlement: "cash", amount: rialText("400000") }],
        amount: rialText("500000"),
        balanceDue: rialText("100000"),
        customerCredit: rialText("100000"),
      }),
    ).rejects.toThrow("difference_is_one_sided");
  });

  it("refuses tenders that do not add up to the settled amount", async () => {
    // 350k handed over, but the difference declared as only 100k — the fourth
    // 50k has nowhere to go, and the entry must not be written.
    await expect(
      post({
        tenders: [{ settlement: "cash", amount: rialText("350000") }],
        amount: rialText("500000"),
        balanceDue: rialText("100000"),
      }),
    ).rejects.toThrow("tender_total_mismatch");
  });
});

describe("POST /api/orders/[id]/pay — settle with a difference", () => {
  it("lets a cashier complete an exact offline/site payment atomically", async () => {
    const previousRole = process.env.DEPLOYMENT_ROLE;
    process.env.DEPLOYMENT_ROLE = "site";
    const orderId = await openOrder(500_000);
    const { status, body } = await (async () => {
      try {
        return await pay(orderId, { payments: [{ method: "cash", amount: 500_000 }] });
      } finally {
        if (previousRole === undefined) delete process.env.DEPLOYMENT_ROLE;
        else process.env.DEPLOYMENT_ROLE = previousRole;
      }
    })();
    expect(status).toBe(200);
    expect(body).toMatchObject({ balanceDue: 0, customerCredit: 0 });

    const { rows } = await db.query<{ status: string; closed_by: string; closed_at: Date | null }>(
      "SELECT status, closed_by::text, closed_at FROM orders WHERE id = $1",
      [orderId],
    );
    expect(rows[0]).toMatchObject({ status: "completed", closed_by: sessionState.sub });
    expect(rows[0].closed_at).toBeInstanceOf(Date);

    const payment = await db.query<{ received_by: string }>(
      "SELECT received_by::text FROM payments WHERE order_id = $1",
      [orderId],
    );
    expect(payment.rows).toEqual([{ received_by: sessionState.sub }]);
    expect((await linesOfEntry("revenue", orderId)).length).toBeGreaterThan(0);

    // A site/local checkout commits its durable outbox event with the primary
    // transaction, so reconnecting cannot manufacture a second payment.
    const sync = await db.query<{ event_type: string; actor_role: string }>(
      "SELECT event_type, actor_role::text FROM sync_events WHERE location_id = $1 AND payload->>'orderId' = $2",
      [biz.locationId, orderId],
    );
    expect(sync.rows).toContainEqual({ event_type: "order.payment.completed", actor_role: "cashier" });
  });

  it("refuses an underpayment without a customer — a balance is a person's", async () => {
    const orderId = await openOrder(500_000);
    const { status, body } = await pay(orderId, { payments: [{ method: "cash", amount: 400_000 }] });
    expect(status).toBe(400);
    expect(body.error).toBe("customer_required");

    const { rows: orderRows } = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(orderRows[0].status).toBe("open");
    const { rows: paymentRows } = await db.query<{ count: string }>(
      "SELECT count(*)::text FROM payments WHERE order_id = $1",
      [orderId],
    );
    expect(paymentRows[0].count).toBe("0");
  });

  it("refuses an overpayment without a customer, writing nothing", async () => {
    const orderId = await openOrder(500_000);
    const { status, body } = await pay(orderId, { payments: [{ method: "cash", amount: 600_000 }] });
    expect(status).toBe(400);
    expect(body.error).toBe("customer_required");
    const { rows } = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(rows[0].status).toBe("open");
  });

  it("books an underpayment as customer debt: a نسیه payments row and an AR debit", async () => {
    const customerId = await createCustomer();
    const orderId = await openOrder(500_000);
    const { status, body } = await pay(orderId, {
      payments: [{ method: "cash", amount: 400_000 }],
      customerId,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ balanceDue: 100_000, customerCredit: 0 });

    // The order completed and carries the customer.
    const { rows: orderRows } = await db.query<{ status: string; customer_id: string }>(
      "SELECT status, customer_id::text FROM orders WHERE id = $1",
      [orderId],
    );
    expect(orderRows[0]).toMatchObject({ status: "completed", customer_id: customerId });

    // Two payments rows: the 400k actually taken, and the 100k remainder as
    // نسیه — the shift's per-method buckets and the AR subledger read one story.
    const { rows: paymentRows } = await db.query<{ method: string; amount: string }>(
      "SELECT method, amount::text FROM payments WHERE order_id = $1 ORDER BY settlement_seq",
      [orderId],
    );
    expect(paymentRows).toEqual([
      { method: "cash", amount: "400000" },
      { method: "credit", amount: "100000" },
    ]);

    // The payment entry carries the AR debit for the remainder.
    const lines = await linesOfEntry("revenue", orderId);
    expect(lines).toContainEqual({ code: "1200", debit: "100000", credit: "0" });
  });

  it("books an overpayment as customer store credit: the liability, the event, and the balance", async () => {
    const customerId = await createCustomer();
    const orderId = await openOrder(500_000);
    const { status, body } = await pay(orderId, {
      payments: [{ method: "cash", amount: 600_000 }],
      customerId,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ balanceDue: 0, customerCredit: 100_000 });

    // One payments row only — the excess is not a payment, it is a liability.
    const { rows: paymentRows } = await db.query<{ method: string; amount: string }>(
      "SELECT method, amount::text FROM payments WHERE order_id = $1",
      [orderId],
    );
    expect(paymentRows).toEqual([{ method: "cash", amount: "600000" }]);

    // The payment entry credits the store-credit payable.
    const lines = await linesOfEntry("revenue", orderId);
    expect(lines).toContainEqual({ code: "2410", debit: "0", credit: "100000" });

    // The event the balance is reconstructed from, and the balance itself.
    const { rows: eventRows } = await db.query<{ event_type: string }>(
      "SELECT event_type FROM domain_events WHERE business_id = $1 AND source_id = $2",
      [biz.id, orderId],
    );
    expect(eventRows).toContainEqual({ event_type: "order.customer_credit_issued" });
    const balance = await dbLib.withTenant(
      biz.id,
      () => loyaltyService.storeCreditBalance(biz.id, customerId),
    );
    expect(balance).toBe(100_000);
  });

  it("refuses to pay an order that is not open", async () => {
    const orderId = await openOrder(500_000);
    await pay(orderId, { payments: [{ method: "cash", amount: 500_000 }] });
    const { status, body } = await pay(orderId, { payments: [{ method: "cash", amount: 500_000 }] });
    expect(status).toBe(409);
    expect(body.error).toBe("order_not_open");
  });
});

describe("settlementDifference — the split of an unequal settlement", () => {
  it("is exactly one side, never both", async () => {
    const { settlementDifference } = await import("../src/lib/payment-methods");
    expect(settlementDifference([{ amount: 500_000 }], 500_000)).toEqual({
      balanceDue: 0,
      customerCredit: 0,
    });
    expect(settlementDifference([{ amount: 400_000 }], 500_000)).toEqual({
      balanceDue: 100_000,
      customerCredit: 0,
    });
    expect(settlementDifference([{ amount: 600_000 }], 500_000)).toEqual({
      balanceDue: 0,
      customerCredit: 100_000,
    });
  });
});
