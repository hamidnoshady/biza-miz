/**
 * Issue #902 §9 item 3 (last part) — a supplier's invoice against a real ledger.
 *
 * The pure suite proves the arithmetic. What only the database proves:
 *
 *   1. The comparison reads **exactly** the window the statement claims — half
 *      open, that provider only, no other supplier's rows and nothing a minute
 *      outside the period.
 *   2. A discrepancy is **stored**, not repaired: reconciling writes a verdict and
 *      leaves every cost event untouched (asserted by comparing the ledger
 *      before and after).
 *   3. The statement is **platform-only** at the database: a tenant connection
 *      granted SELECT on the table still reads nothing, because the policy is the
 *      bypass-only form.
 *   4. An accepted statement is final — re-reconciling refuses rather than
 *      overwriting the decision a human made — and the database refuses to accept
 *      one without a reason.
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
let probeRole: string;
let probe: Client;

let dbLib: typeof import("../src/lib/db");
let supplier: typeof import("../src/lib/billing/supplier-invoice-service");

const alpha = { businessId: "" };

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

async function seedBusiness(name: string): Promise<{ businessId: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id };
}

/** One wholesale cost event, as the send path writes it. */
async function costEvent(input: {
  provider?: string;
  amountRial: number;
  occurredAt: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO billing_vendor_cost_events
       (business_id, provider, source_reference, amount_rial, occurred_at, tenant_visible)
     VALUES ($1, $2, $3, $4, $5::timestamptz, false)`,
    [
      alpha.businessId,
      input.provider ?? "kavenegar",
      `message_outbox:${randomUUID()}`,
      input.amountRial,
      input.occurredAt,
    ],
  );
}

async function ledgerSnapshot(): Promise<{ count: string; total: string }> {
  const { rows } = await db.query<{ count: string; total: string }>(
    `SELECT count(*)::text AS count, COALESCE(sum(amount_rial), 0)::text AS total
       FROM billing_vendor_cost_events`,
  );
  return rows[0]!;
}

const PERIOD = { start: "2026-03-01T00:00:00.000Z", end: "2026-04-01T00:00:00.000Z" };

async function record(claimedRial: number, reference = `INV-${randomUUID().slice(0, 8)}`, provider = "kavenegar") {
  return supplier.recordSupplierInvoice({
    provider,
    statementReference: reference,
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
    claimedRial,
  });
}

beforeAll(async () => {
  databaseName = `pos_supplier_inv_${randomUUID().replaceAll("-", "")}`;

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
  supplier = await import("../src/lib/billing/supplier-invoice-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // An unprivileged role that is allowed to read the table: the RLS policy, not
  // a missing grant, is what must keep a tenant out.
  probeRole = `supplier_probe_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await db.query(`CREATE ROLE ${probeRole} NOLOGIN`);
  await db.query(`GRANT SELECT ON billing_supplier_invoices TO ${probeRole}`);
  probe = new Client({ connectionString: urlFor(databaseName) });
  await probe.connect();
  await probe.query(`SET ROLE ${probeRole}`);
}, 180_000);

afterAll(async () => {
  if (probe) await probe.end().catch(() => {});
  if (probeRole) {
    await db?.query(`DROP OWNED BY ${probeRole}`).catch(() => {});
    const admin = new Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`);
    } finally {
      await admin.end();
    }
  }
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
  await db.query("DELETE FROM billing_supplier_invoices");
  await db.query("DELETE FROM billing_vendor_cost_events");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
});

describe("recording a statement", () => {
  it("is idempotent on the supplier's own reference", async () => {
    const first = await record(5_000_000, "INV-2026-03");
    expect(first.created).toBe(true);
    const second = await record(5_000_000, "INV-2026-03");
    // The same invoice twice is the same debt, not two.
    expect(second.created).toBe(false);
    expect(second.invoice.id).toBe(first.invoice.id);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing_supplier_invoices`,
    );
    expect(rows[0]!.n).toBe("1");
    expect(first.invoice.state).toBe("open");
  });

  it("refuses a period that runs backwards, and a negative amount", async () => {
    await expect(
      supplier.recordSupplierInvoice({
        provider: "kavenegar",
        statementReference: "INV-BAD",
        periodStart: PERIOD.end,
        periodEnd: PERIOD.start,
        claimedRial: 1_000,
      }),
    ).rejects.toThrow(/bad_period/);
    await expect(
      supplier.recordSupplierInvoice({
        provider: "kavenegar",
        statementReference: "INV-NEG",
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        claimedRial: -1,
      }),
    ).rejects.toThrow(/bad_amount/);
  });
});

describe("reconciling reads exactly the period the statement claims", () => {
  it("sums only that provider's events inside the half-open window", async () => {
    await costEvent({ amountRial: 1_000_000, occurredAt: "2026-03-05T10:00:00.000Z" });
    await costEvent({ amountRial: 500_000, occurredAt: "2026-03-31T23:59:59.000Z" });
    // Outside the window on both ends.
    await costEvent({ amountRial: 99_000, occurredAt: "2026-02-28T23:59:59.000Z" });
    await costEvent({ amountRial: 99_000, occurredAt: "2026-04-01T00:00:00.000Z" });
    // Another supplier's cost is not this statement's business.
    await costEvent({ provider: "smtp", amountRial: 99_000, occurredAt: "2026-03-10T10:00:00.000Z" });

    const { invoice } = await record(1_500_000);
    const result = await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id });

    expect(result.invoice.recordedRial).toBe(1_500_000);
    expect(result.invoice.recordedEvents).toBe(2);
    expect(result.invoice.deltaRial).toBe(0);
    expect(result.invoice.state).toBe("matched");
    expect(result.verdict).toBe("matched");
  });

  it("stores a discrepancy and leaves the ledger exactly as it found it", async () => {
    await costEvent({ amountRial: 1_000_000, occurredAt: "2026-03-05T10:00:00.000Z" });
    const before = await ledgerSnapshot();

    const { invoice } = await record(1_250_000);
    const result = await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id });

    expect(result.invoice).toMatchObject({ state: "disputed", recordedRial: 1_000_000, deltaRial: 250_000 });
    // The verdict is evidence about the ledger, not an edit of it: a ledger
    // adjusted to match one invoice cannot test the next one.
    expect(await ledgerSnapshot()).toEqual(before);

    const again = await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id });
    expect(again.invoice.state).toBe("disputed");
    expect(await ledgerSnapshot()).toEqual(before);
  });

  it("says unexplained — a dispute, not a match — when we recorded nothing", async () => {
    const { invoice } = await record(400_000);
    const result = await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id, toleranceRial: 10_000_000 });
    // A tolerance wide enough to swallow the whole claim must not turn "we have no
    // books for this month" into a pass.
    expect(result.verdict).toBe("unexplained");
    expect(result.invoice.state).toBe("disputed");
    expect(result.invoice.recordedEvents).toBe(0);
  });

  it("honours an explicit tolerance and records the one it used", async () => {
    await costEvent({ amountRial: 1_000_000, occurredAt: "2026-03-05T10:00:00.000Z" });
    const { invoice } = await record(1_005_000);

    const strict = await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id, toleranceRial: 1_000 });
    expect(strict.invoice).toMatchObject({ state: "disputed", toleranceRial: 1_000, deltaRial: 5_000 });

    const loose = await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id, toleranceRial: 10_000 });
    expect(loose.invoice).toMatchObject({ state: "matched", toleranceRial: 10_000 });
  });
});

describe("accepting a difference is final, and needs a reason", () => {
  it("accepts a disputed statement, then refuses to re-reconcile it", async () => {
    await costEvent({ amountRial: 1_000_000, occurredAt: "2026-03-05T10:00:00.000Z" });
    const { invoice } = await record(1_100_000);
    await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id });

    await expect(
      supplier.acceptSupplierInvoice({ invoiceId: invoice.id, reason: "   " }),
    ).rejects.toThrow(/reason_required/);

    const accepted = await supplier.acceptSupplierInvoice({
      invoiceId: invoice.id,
      reason: "تأخیر در ثبت هزینهٔ اسفند؛ مدیر مالی تأیید کرد",
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.acceptedReason).toContain("مدیر مالی");

    // The decision stands: a later pass must not rewrite it.
    await expect(
      supplier.reconcileSupplierInvoice({ invoiceId: invoice.id }),
    ).rejects.toThrow(/already_accepted/);
  });

  it("refuses to accept a statement that already matches", async () => {
    await costEvent({ amountRial: 1_000_000, occurredAt: "2026-03-05T10:00:00.000Z" });
    const { invoice } = await record(1_000_000);
    await supplier.reconcileSupplierInvoice({ invoiceId: invoice.id });
    await expect(
      supplier.acceptSupplierInvoice({ invoiceId: invoice.id, reason: "ok" }),
    ).rejects.toThrow(/not_disputed/);
  });

  it("the database itself refuses an accepted state without a reason", async () => {
    const { invoice } = await record(1_000, "INV-CHECK");
    await expect(
      db.query(
        `UPDATE billing_supplier_invoices
            SET state = 'accepted', recorded_rial = 0, delta_rial = 1000
          WHERE id = $1`,
        [invoice.id],
      ),
    ).rejects.toThrow(/billing_supplier_invoices_state_check|violates check constraint/);
  });
});

describe("the statements are platform data", () => {
  it("are unreadable through a connection that is not the platform", async () => {
    await record(5_000_000, "INV-PRIVATE");
    const { rows } = await probe.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing_supplier_invoices`,
    );
    // The role holds SELECT; the bypass-only policy is what returns nothing.
    expect(rows[0]!.n).toBe("0");

    const viaService = await supplier.listSupplierInvoices();
    expect(viaService).toHaveLength(1);
  });

  it("lists disputes before the rest", async () => {
    await costEvent({ amountRial: 1_000_000, occurredAt: "2026-03-05T10:00:00.000Z" });
    const matched = await record(1_000_000, "INV-MATCHED");
    await supplier.reconcileSupplierInvoice({ invoiceId: matched.invoice.id });
    const disputed = await record(2_000_000, "INV-DISPUTED");
    await supplier.reconcileSupplierInvoice({ invoiceId: disputed.invoice.id });

    const listed = await supplier.listSupplierInvoices();
    expect(listed[0]!.statementReference).toBe("INV-DISPUTED");
    expect(listed.map((row) => row.state)).toEqual(["disputed", "matched"]);
  });
});
