/**
 * A verified plan / add-on purchase: applied once, and invoiced once.
 *
 *  • A same-plan purchase extends the period, so a second fulfilment of the SAME
 *    payment (a retry after a partial failure, or the gateway callback racing
 *    the return page) used to read as a second purchase and bought a second
 *    month. The payment now carries `plan_activated_at`, stamped in the
 *    subscription's own transaction, and fulfilment is a per-payment critical
 *    section.
 *  • The purchase used to leave only a `billing_payments` row. It now also
 *    produces the invoice migration 0176 documents (`plan-purchase:<payment>`),
 *    settled by the payment it describes, resumable and idempotent.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let billing: typeof import("../src/lib/billing-service");
let wallet: typeof import("../src/lib/wallet-service");
let subs: typeof import("../src/lib/subscription-service");
let purchaseInvoices: typeof import("../src/lib/purchase-invoice-service");

const BID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function scoped<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(BID, fn);
}

async function verifiedPayment(input: {
  purpose: "plan_purchase" | "addon_purchase" | "top_up";
  amountRial: number;
  featureKey?: string;
  quoteSnapshot?: Record<string, unknown>;
}) {
  const created = await scoped(() =>
    wallet.createPayment({
      businessId: BID,
      gateway: "manual",
      purpose: input.purpose,
      planKey: input.purpose === "plan_purchase" ? "pro" : null,
      featureKey: input.featureKey ?? null,
      amountRial: input.amountRial,
      creditRial: 0,
      description: input.purpose === "plan_purchase" ? "اشتراک پلن «حرفه‌ای»" : "خرید قابلیت «تست»",
      quoteSnapshot: input.quoteSnapshot ?? null,
    }),
  );
  await scoped(() => wallet.settlePayment(created.id, { gatewayStatus: "manual_approved" }));
  return (await scoped(() => wallet.getPaymentById(created.id)))!;
}

function fulfil(p: Awaited<ReturnType<typeof verifiedPayment>>) {
  return scoped(() =>
    billing.fulfilPurchasedPayment({
      id: p.id,
      businessId: p.businessId,
      purpose: p.purpose,
      planKey: p.planKey,
      featureKey: p.featureKey,
    }),
  );
}

async function periodEnd(): Promise<string> {
  const sub = await scoped(() => subs.getBusinessSubscription(BID));
  return sub!.currentPeriodEnd;
}

async function invoicesFor(reference: string) {
  const { rows } = await db.query(`SELECT * FROM billing_invoices WHERE business_id = $1 AND reference = $2`, [BID, reference]);
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_purchase_fulfil_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  dbLib = await import("../src/lib/db");
  billing = await import("../src/lib/billing-service");
  wallet = await import("../src/lib/wallet-service");
  subs = await import("../src/lib/subscription-service");
  purchaseInvoices = await import("../src/lib/purchase-invoice-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO feature_flags (key, name, default_enabled) VALUES ('pf_addon', 'افزونهٔ آزمون', true) ON CONFLICT (key) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه خرید', 'purchase-cafe', 'free')`,
    [BID],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("plan purchase fulfilment", () => {
  let firstPeriodEnd = "";

  it("activates the plan and issues one paid invoice linked to the payment", async () => {
    const payment = await verifiedPayment({
      purpose: "plan_purchase",
      amountRial: 32_700_000,
      quoteSnapshot: {
        planKey: "pro",
        totalRial: 32_700_000,
        subtotalRial: 30_000_000,
        taxRial: 2_700_000,
        lines: [
          { kind: "plan", description: "اشتراک ماهانهٔ پلن حرفه‌ای", quantity: 1, unitAmountRial: 30_000_000, amountRial: 30_000_000, featureKey: null },
        ],
      },
    });
    await fulfil(payment);

    const after = (await scoped(() => wallet.getPaymentById(payment.id)))!;
    expect(after.fulfilmentStatus).toBe("succeeded");
    firstPeriodEnd = await periodEnd();

    const invoices = await invoicesFor(`plan-purchase:${payment.id}`);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "paid", total_rial: "32700000", paid_rial: "32700000", tax_rial: "2700000", subtotal_rial: "30000000" });
    const { rows: lines } = await db.query(`SELECT kind, amount_rial FROM billing_invoice_lines WHERE invoice_id = $1`, [invoices[0].id]);
    expect(lines).toEqual([{ kind: "plan", amount_rial: "30000000" }]);
    const { rows: allocations } = await db.query(
      `SELECT payment_id, amount_rial FROM billing_invoice_payments WHERE invoice_id = $1`,
      [invoices[0].id],
    );
    expect(allocations).toEqual([{ payment_id: payment.id, amount_rial: "32700000" }]);
    const { rows: linked } = await db.query(`SELECT invoice_id FROM billing_payments WHERE id = $1`, [payment.id]);
    expect(linked[0].invoice_id).toBe(invoices[0].id);
  });

  it("fulfilling the same payment again changes nothing", async () => {
    const { rows } = await db.query(`SELECT id FROM billing_payments WHERE business_id = $1 AND purpose = 'plan_purchase'`, [BID]);
    const payment = (await scoped(() => wallet.getPaymentById(rows[0].id)))!;
    await db.query(`UPDATE billing_payments SET fulfilment_status = 'failed' WHERE id = $1`, [payment.id]);
    await fulfil(payment);
    expect(await periodEnd()).toBe(firstPeriodEnd);
    expect(await invoicesFor(`plan-purchase:${payment.id}`)).toHaveLength(1);
  });

  it("a retry after a partial failure does not extend the period a second time", async () => {
    const payment = await verifiedPayment({ purpose: "plan_purchase", amountRial: 30_000_000 });
    // The first attempt got as far as moving the subscription, then failed.
    await dbLib.withoutTenantScope("test", () =>
      billing.activatePurchasedPlan({ businessId: BID, planKey: "pro", paymentId: payment.id }),
    );
    const afterFirstApply = await periodEnd();
    expect(afterFirstApply).toBe(subs.addMonths(firstPeriodEnd, 1));
    await db.query(`UPDATE billing_payments SET fulfilment_status = 'failed', fulfilment_error = 'boom' WHERE id = $1`, [payment.id]);

    await fulfil(payment);
    expect(await periodEnd()).toBe(afterFirstApply);
    const after = (await scoped(() => wallet.getPaymentById(payment.id)))!;
    expect(after.fulfilmentStatus).toBe("succeeded");
    expect(await invoicesFor(`plan-purchase:${payment.id}`)).toHaveLength(1);
  });

  it("two concurrent fulfilments of one payment buy one period", async () => {
    const before = await periodEnd();
    const payment = await verifiedPayment({ purpose: "plan_purchase", amountRial: 30_000_000 });
    await Promise.all([fulfil(payment), fulfil(payment), fulfil(payment)]);
    expect(await periodEnd()).toBe(subs.addMonths(before, 1));
    expect(await invoicesFor(`plan-purchase:${payment.id}`)).toHaveLength(1);
  });

  it("a genuinely new purchase of the same plan still extends it", async () => {
    const before = await periodEnd();
    const payment = await verifiedPayment({ purpose: "plan_purchase", amountRial: 30_000_000 });
    await fulfil(payment);
    expect(await periodEnd()).toBe(subs.addMonths(before, 1));
  });
});

describe("add-on purchase invoice", () => {
  it("invoices the add-on with the quote's tax split and one line for the feature", async () => {
    const payment = await verifiedPayment({
      purpose: "addon_purchase",
      amountRial: 1_090_000,
      featureKey: "pf_addon",
      quoteSnapshot: { featureKey: "pf_addon", totalRial: 1_090_000, subtotalRial: 1_000_000, taxRial: 90_000 },
    });
    await fulfil(payment);
    const invoices = await invoicesFor(`addon-purchase:${payment.id}`);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "paid", total_rial: "1090000", tax_rial: "90000", subtotal_rial: "1000000" });
    const { rows: lines } = await db.query(`SELECT kind, feature_key, amount_rial FROM billing_invoice_lines WHERE invoice_id = $1`, [invoices[0].id]);
    expect(lines).toEqual([{ kind: "addon", feature_key: "pf_addon", amount_rial: "1000000" }]);
  });
});

describe("issuePurchaseInvoice", () => {
  it("is idempotent and resumable", async () => {
    const payment = await verifiedPayment({ purpose: "plan_purchase", amountRial: 30_000_000 });
    const first = await scoped(() => purchaseInvoices.issuePurchaseInvoice(payment.id));
    expect(first.created).toBe(true);
    const second = await scoped(() => purchaseInvoices.issuePurchaseInvoice(payment.id));
    expect(second).toEqual({ invoiceId: first.invoiceId, created: false });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM billing_invoice_payments WHERE invoice_id = $1`, [first.invoiceId]);
    expect(rows[0].n).toBe(1);

    // Resume: an open, unpaid, unlinked invoice (the process died after claiming it).
    await db.query(`UPDATE billing_payments SET invoice_id = NULL WHERE id = $1`, [payment.id]);
    await db.query(`DELETE FROM billing_invoice_payments WHERE invoice_id = $1`, [first.invoiceId]);
    await db.query(`UPDATE billing_invoices SET status = 'open', paid_rial = 0 WHERE id = $1`, [first.invoiceId]);
    const resumed = await scoped(() => purchaseInvoices.issuePurchaseInvoice(payment.id));
    expect(resumed).toEqual({ invoiceId: first.invoiceId, created: false });
    const { rows: invoice } = await db.query(`SELECT status, paid_rial FROM billing_invoices WHERE id = $1`, [first.invoiceId]);
    expect(invoice[0]).toMatchObject({ status: "paid", paid_rial: "30000000" });
    const { rows: link } = await db.query(`SELECT invoice_id FROM billing_payments WHERE id = $1`, [payment.id]);
    expect(link[0].invoice_id).toBe(first.invoiceId);
  });

  it("issues nothing for a top-up or an unverified payment", async () => {
    const topUp = await verifiedPayment({ purpose: "top_up", amountRial: 5_000_000 });
    expect(await scoped(() => purchaseInvoices.issuePurchaseInvoice(topUp.id))).toMatchObject({ invoiceId: null, skipped: "not_a_purchase" });

    const pending = await scoped(() =>
      wallet.createPayment({ businessId: BID, gateway: "manual", purpose: "plan_purchase", planKey: "pro", amountRial: 30_000_000, creditRial: 0, description: "x" }),
    );
    expect(await scoped(() => purchaseInvoices.issuePurchaseInvoice(pending.id))).toMatchObject({ invoiceId: null, skipped: "not_verified" });
    expect(await scoped(() => purchaseInvoices.issuePurchaseInvoice(randomUUID()))).toMatchObject({ invoiceId: null, skipped: "not_found" });
  });
});

describe("backfillPurchaseInvoices", () => {
  it("lists payments with no invoice on a dry run and issues them on apply", async () => {
    // A purchase fulfilled before this fix: verified, succeeded, never invoiced.
    const legacy = await verifiedPayment({ purpose: "plan_purchase", amountRial: 30_000_000 });
    await db.query(`UPDATE billing_payments SET fulfilment_status = 'succeeded', plan_activated_at = now() WHERE id = $1`, [legacy.id]);

    const dry = await purchaseInvoices.backfillPurchaseInvoices({ sinceDays: null, dryRun: true });
    expect(dry.candidates.map((c) => c.paymentId)).toContain(legacy.id);
    expect(dry.issued).toBe(0);
    expect(await invoicesFor(`plan-purchase:${legacy.id}`)).toHaveLength(0);

    const applied = await purchaseInvoices.backfillPurchaseInvoices({ sinceDays: null, dryRun: false });
    expect(applied.failed).toBe(0);
    expect(applied.issued).toBeGreaterThanOrEqual(1);
    expect(await invoicesFor(`plan-purchase:${legacy.id}`)).toHaveLength(1);

    const again = await purchaseInvoices.backfillPurchaseInvoices({ sinceDays: null, dryRun: true });
    expect(again.candidates.map((c) => c.paymentId)).not.toContain(legacy.id);
  });
});

describe("purchaseInvoiceBody", () => {
  it("falls back to one line that adds up when the quote's lines do not", () => {
    const body = purchaseInvoices.purchaseInvoiceBody({
      purpose: "plan_purchase",
      amountRial: 1_090_000,
      description: "اشتراک",
      featureKey: null,
      quoteSnapshot: { taxRial: 90_000, lines: [{ kind: "plan", description: "a", quantity: 1, unitAmountRial: 5, amountRial: 5 }] },
    });
    expect(body).toMatchObject({ subtotalRial: 1_000_000, taxRial: 90_000, totalRial: 1_090_000 });
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].amountRial).toBe(1_000_000);
  });

  it("never reports more tax than the amount charged", () => {
    const body = purchaseInvoices.purchaseInvoiceBody({
      purpose: "addon_purchase",
      amountRial: 100,
      description: "",
      featureKey: "f",
      quoteSnapshot: { taxRial: 9_999 },
    });
    expect(body.taxRial).toBe(100);
    expect(body.subtotalRial).toBe(0);
  });
});
