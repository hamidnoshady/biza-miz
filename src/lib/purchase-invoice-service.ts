/**
 * The invoice for a verified plan or add-on purchase.
 *
 * A subscription renewal claims an invoice before it moves money
 * (`renewBusinessSubscription`), but a purchase paid through the gateway or
 * approved by hand only ever produced a `billing_payments` row: the business had
 * a payment and a changed plan, and no invoice — and the platform company's own
 * books (`platform_company_*` triggers, which key on `billing_invoices`) never
 * saw the revenue. Migration 0176 even documents the intended reference,
 * `plan-purchase:<payment id>`; nothing ever wrote it.
 *
 * `issuePurchaseInvoice` closes that: one invoice per verified purchase, claimed
 * by the UNIQUE (business_id, reference) index, then settled by the payment it
 * describes through the same `applyInvoicePayment` every other settlement uses.
 * It is resumable — a failure between the steps leaves an open invoice or an
 * unlinked payment, and running it again finishes exactly that step.
 */
import { getPool, query, withTenant, withoutTenantScope, type PoolClient } from "./db";
import { allocateInvoiceNumber } from "./billing/runtime";
import { billingLog } from "./billing/observability";
import { applyInvoicePayment } from "./subscription-service";

type InvoiceLineKind = "plan" | "addon";

interface PurchasePayment {
  id: string;
  businessId: string;
  purpose: "plan_purchase" | "addon_purchase";
  status: string;
  amountRial: number;
  description: string;
  featureKey: string | null;
  invoiceId: string | null;
  verifiedAt: string | null;
  quoteSnapshot: Record<string, unknown> | null;
}

export interface PurchaseInvoiceResult {
  invoiceId: string | null;
  /** True when this call created the invoice row. */
  created: boolean;
  /** Why no invoice was issued, when `invoiceId` is null. */
  skipped?: "not_found" | "not_a_purchase" | "not_verified";
}

export function purchaseInvoiceReference(purpose: PurchasePayment["purpose"], paymentId: string): string {
  return `${purpose === "plan_purchase" ? "plan-purchase" : "addon-purchase"}:${paymentId}`;
}

interface PurchaseLine {
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unitAmountRial: number;
  amountRial: number;
  featureKey: string | null;
}

/**
 * The invoice body for a payment: tax from the quote it was priced with, the
 * quote's own lines when they add up to the subtotal, otherwise one line that
 * does. The payment's `amount_rial` is the total, always — it is what the
 * business was actually charged.
 */
export function purchaseInvoiceBody(payment: Pick<PurchasePayment, "purpose" | "amountRial" | "description" | "featureKey" | "quoteSnapshot">): {
  subtotalRial: number;
  taxRial: number;
  totalRial: number;
  lines: PurchaseLine[];
} {
  const totalRial = Math.max(0, Math.floor(payment.amountRial));
  const snapshot = payment.quoteSnapshot ?? {};
  const rawTax = Number(snapshot.taxRial);
  const taxRial = Number.isSafeInteger(rawTax) ? Math.min(Math.max(rawTax, 0), totalRial) : 0;
  const subtotalRial = totalRial - taxRial;
  const kind: InvoiceLineKind = payment.purpose === "plan_purchase" ? "plan" : "addon";

  const lines: PurchaseLine[] = [];
  if (Array.isArray(snapshot.lines)) {
    for (const raw of snapshot.lines as unknown[]) {
      const row = raw as Record<string, unknown> | null;
      const amountRial = Number(row?.amountRial);
      const quantity = Number(row?.quantity ?? 1);
      const unitAmountRial = Number(row?.unitAmountRial ?? amountRial);
      if (
        !row ||
        typeof row.description !== "string" ||
        !Number.isSafeInteger(amountRial) ||
        amountRial < 0 ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !Number.isSafeInteger(unitAmountRial) ||
        unitAmountRial < 0
      ) {
        lines.length = 0;
        break;
      }
      lines.push({
        kind: row.kind === "addon" ? "addon" : "plan",
        description: row.description,
        quantity,
        unitAmountRial,
        amountRial,
        featureKey: typeof row.featureKey === "string" ? row.featureKey : null,
      });
    }
  }
  const linesTotal = lines.reduce((sum, line) => sum + line.amountRial, 0);
  if (lines.length === 0 || linesTotal !== subtotalRial) {
    return {
      subtotalRial,
      taxRial,
      totalRial,
      lines: [
        {
          kind,
          description: payment.description || (kind === "plan" ? "اشتراک پلن" : "خرید افزونه"),
          quantity: 1,
          unitAmountRial: subtotalRial,
          amountRial: subtotalRial,
          featureKey: kind === "addon" ? payment.featureKey : null,
        },
      ],
    };
  }
  return { subtotalRial, taxRial, totalRial, lines };
}

function rowToPayment(row: Record<string, unknown>): PurchasePayment {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    purpose: row.purpose as PurchasePayment["purpose"],
    status: String(row.status),
    amountRial: Number(row.amount_rial),
    description: String(row.description ?? ""),
    featureKey: (row.feature_key as string | null) ?? null,
    invoiceId: (row.invoice_id as string | null) ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at as string).toISOString() : null,
    quoteSnapshot: (row.quote_snapshot as Record<string, unknown> | null) ?? null,
  };
}

async function claimPurchaseInvoice(client: PoolClient, payment: PurchasePayment): Promise<{ invoiceId: string; created: boolean }> {
  const reference = purchaseInvoiceReference(payment.purpose, payment.id);
  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM billing_invoices WHERE business_id = $1 AND reference = $2`,
    [payment.businessId, reference],
  );
  if (existing[0]) return { invoiceId: existing[0].id, created: false };

  const body = purchaseInvoiceBody(payment);
  const number = await allocateInvoiceNumber(client);
  const issuedAt = payment.verifiedAt ?? new Date().toISOString();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO billing_invoices
       (business_id, invoice_number, status, subtotal_rial, discount_rial, tax_rial,
        total_rial, paid_rial, due_at, reference, note)
     VALUES ($1, $2, 'open', $3, 0, $4, $5, 0, $6, $7, $8)
     ON CONFLICT (business_id, reference) DO NOTHING
     RETURNING id`,
    [
      payment.businessId,
      number,
      body.subtotalRial,
      body.taxRial,
      body.totalRial,
      issuedAt,
      reference,
      payment.description || null,
    ],
  );
  if (!rows[0]) {
    const { rows: raced } = await client.query<{ id: string }>(
      `SELECT id FROM billing_invoices WHERE business_id = $1 AND reference = $2`,
      [payment.businessId, reference],
    );
    return { invoiceId: raced[0].id, created: false };
  }
  const invoiceId = rows[0].id;
  let order = 0;
  for (const line of body.lines) {
    await client.query(
      `INSERT INTO billing_invoice_lines
         (invoice_id, kind, description, quantity, unit_amount_rial, amount_rial, feature_key, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [invoiceId, line.kind, line.description, line.quantity, line.unitAmountRial, line.amountRial, line.featureKey, order++],
    );
  }
  return { invoiceId, created: true };
}

/**
 * Issue (or finish issuing) the invoice for one verified purchase. Runs in the
 * caller's tenant scope. Safe to call any number of times for the same payment.
 */
export async function issuePurchaseInvoice(paymentId: string): Promise<PurchaseInvoiceResult> {
  const client = await getPool().connect();
  let payment: PurchasePayment;
  let claimed: { invoiceId: string; created: boolean };
  try {
    await client.query("BEGIN");
    // The payment row lock serialises two callers issuing for one payment.
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM billing_payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return { invoiceId: null, created: false, skipped: "not_found" };
    }
    payment = rowToPayment(rows[0]);
    if (payment.purpose !== "plan_purchase" && payment.purpose !== "addon_purchase") {
      await client.query("ROLLBACK");
      return { invoiceId: null, created: false, skipped: "not_a_purchase" };
    }
    if (payment.status !== "verified") {
      await client.query("ROLLBACK");
      return { invoiceId: null, created: false, skipped: "not_verified" };
    }
    claimed = await claimPurchaseInvoice(client, payment);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Settle the invoice with the payment it describes. A retry after a partial
  // failure finds the invoice already paid, or the allocation already recorded
  // under the same idempotency key, and moves on to linking.
  const { rows: invoiceRows } = await query<{ status: string; total_rial: string; paid_rial: string }>(
    `SELECT status, total_rial, paid_rial FROM billing_invoices WHERE id = $1`,
    [claimed.invoiceId],
  );
  const invoice = invoiceRows[0];
  if (invoice && invoice.status !== "paid" && invoice.status !== "void") {
    const outstanding = Number(invoice.total_rial) - Number(invoice.paid_rial);
    if (outstanding > 0) {
      await applyInvoicePayment(claimed.invoiceId, outstanding, {
        paymentId: payment.id,
        idempotencyKey: `payment:${payment.id}`,
        note: payment.description || null,
      });
    }
  }
  if (!payment.invoiceId) {
    await query(`UPDATE billing_payments SET invoice_id = $2 WHERE id = $1 AND invoice_id IS NULL`, [
      payment.id,
      claimed.invoiceId,
    ]);
  }
  billingLog("billing.purchase_invoice.issued", {
    businessId: payment.businessId,
    paymentId: payment.id,
    invoiceId: claimed.invoiceId,
    created: claimed.created,
  });
  return { invoiceId: claimed.invoiceId, created: claimed.created };
}

export interface PurchaseInvoiceBackfillOptions {
  /** Only payments verified within this many days; `null` = every payment. */
  sinceDays: number | null;
  /** List what would be issued without writing anything. */
  dryRun: boolean;
  limit?: number;
}

export interface PurchaseInvoiceBackfillResult {
  candidates: { paymentId: string; businessId: string; purpose: string; amountRial: number; verifiedAt: string | null }[];
  issued: number;
  failed: number;
}

/**
 * Verified plan/add-on payments that never got an invoice. Background work, so
 * it scopes itself: the list is read under the documented platform bypass and
 * each issue runs inside `withTenant` for its own business.
 */
export async function backfillPurchaseInvoices(
  options: PurchaseInvoiceBackfillOptions,
): Promise<PurchaseInvoiceBackfillResult> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const rows = await withoutTenantScope("purchase-invoice-backfill", async () => {
    const { rows } = await query<{
      id: string;
      business_id: string;
      purpose: string;
      amount_rial: string;
      verified_at: string | null;
    }>(
      `SELECT p.id, p.business_id, p.purpose, p.amount_rial, p.verified_at
         FROM billing_payments p
        WHERE p.purpose IN ('plan_purchase', 'addon_purchase')
          AND p.status = 'verified'
          AND p.fulfilment_status = 'succeeded'
          AND p.invoice_id IS NULL
          AND ($1::int IS NULL OR p.verified_at >= now() - make_interval(days => $1::int))
        ORDER BY p.verified_at NULLS LAST, p.id
        LIMIT $2`,
      [options.sinceDays, limit],
    );
    return rows;
  });
  const candidates = rows.map((r) => ({
    paymentId: r.id,
    businessId: r.business_id,
    purpose: r.purpose,
    amountRial: Number(r.amount_rial),
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
  }));
  if (options.dryRun) return { candidates, issued: 0, failed: 0 };

  let issued = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await withTenant(candidate.businessId, () => issuePurchaseInvoice(candidate.paymentId));
      if (result.invoiceId) issued += 1;
    } catch (error) {
      failed += 1;
      console.error("purchase invoice backfill failed for payment:", candidate.paymentId, error);
    }
  }
  return { candidates, issued, failed };
}
