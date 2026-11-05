/**
 * Issue #902 §9 item 3 (last part) — the database half of supplier reconciliation.
 *
 * A statement is recorded once (unique on `provider + statement_reference`), then
 * compared with `billing_vendor_cost_events` for its period. The comparison is
 * `supplier-invoice.ts`; this file reads the ledger, stores the verdict, and is
 * careful about three things:
 *
 *   1. **It only reads the cost events.** No insert, no update, no delete — not
 *      even to "fix" a missing row. A ledger edited to match an invoice cannot
 *      test the next one, and `billing_vendor_cost_events` is the platform's own
 *      evidence about what it was charged.
 *   2. **The window is half-open** `[period_start, period_end)`, matching every
 *      other billing window: a send at exactly midnight belongs to the next
 *      period, once, on both sides of the comparison.
 *   3. **The statement is platform data.** The table is bypass-only RLS, and the
 *      service runs under `withoutTenantScope("platform")`, so no tenant request
 *      can ever reach a supplier's name or a wholesale amount by accident.
 */
import { query, withoutTenantScope } from "../db";
import { billingLog } from "./observability";
import {
  canAccept,
  canReconcile,
  compareSupplierStatement,
  stateForVerdict,
  DEFAULT_SUPPLIER_TOLERANCE_RIAL,
  type SupplierInvoiceState,
  type SupplierVerdict,
} from "./supplier-invoice";

export interface SupplierInvoiceRow {
  id: string;
  provider: string;
  statementReference: string;
  periodStart: string;
  periodEnd: string;
  claimedRial: number;
  recordedRial: number | null;
  recordedEvents: number | null;
  deltaRial: number | null;
  toleranceRial: number | null;
  state: SupplierInvoiceState;
  acceptedReason: string | null;
  note: string | null;
  reconciledAt: string | null;
  createdAt: string;
}

export interface SupplierReconciliation {
  invoice: SupplierInvoiceRow;
  verdict: SupplierVerdict;
  reason: string;
}

export class SupplierInvoiceError extends Error {
  constructor(public code: "not_found" | "not_disputed" | "reason_required" | "already_accepted" | "bad_period" | "bad_amount") {
    super(code);
  }
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function n(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function toRow(row: Record<string, unknown>): SupplierInvoiceRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    statementReference: String(row.statement_reference),
    periodStart: iso(row.period_start)!,
    periodEnd: iso(row.period_end)!,
    claimedRial: n(row.claimed_rial) ?? 0,
    recordedRial: n(row.recorded_rial),
    recordedEvents: n(row.recorded_events),
    deltaRial: n(row.delta_rial),
    toleranceRial: n(row.tolerance_rial),
    state: row.state as SupplierInvoiceState,
    acceptedReason: (row.accepted_reason as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    reconciledAt: iso(row.reconciled_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

const SELECT_COLUMNS = `id, provider, statement_reference, period_start, period_end, claimed_rial,
            recorded_rial, recorded_events, delta_rial, tolerance_rial, state,
            accepted_reason, note, reconciled_at, created_at`;

/**
 * Record (or re-read) a supplier statement. Idempotent on the supplier's own
 * reference: recording the same invoice twice is the same debt, not two.
 */
export async function recordSupplierInvoice(input: {
  provider: string;
  statementReference: string;
  periodStart: string;
  periodEnd: string;
  claimedRial: number;
  note?: string | null;
  platformAdminId?: string | null;
}): Promise<{ invoice: SupplierInvoiceRow; created: boolean }> {
  const provider = input.provider.trim();
  const reference = input.statementReference.trim();
  const start = new Date(input.periodStart);
  const end = new Date(input.periodEnd);
  if (!provider || !reference) throw new SupplierInvoiceError("bad_period");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new SupplierInvoiceError("bad_period");
  }
  if (!Number.isSafeInteger(input.claimedRial) || input.claimedRial < 0) {
    throw new SupplierInvoiceError("bad_amount");
  }

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<Record<string, unknown>>(
      `INSERT INTO billing_supplier_invoices
         (provider, statement_reference, period_start, period_end, claimed_rial, note)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)
       ON CONFLICT (provider, statement_reference) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [provider, reference, start.toISOString(), end.toISOString(), input.claimedRial, input.note ?? null],
    );
    if (rows[0]) {
      const invoice = toRow(rows[0]);
      billingLog("billing.supplier_invoice.recorded", {
        provider,
        statementReference: reference,
        claimedRial: input.claimedRial,
        platformAdminId: input.platformAdminId ?? null,
      });
      return { invoice, created: true };
    }
    const existing = await readSupplierInvoice(provider, reference);
    if (!existing) throw new SupplierInvoiceError("not_found");
    return { invoice: existing, created: false };
  });
}

async function readSupplierInvoice(provider: string, reference: string): Promise<SupplierInvoiceRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM billing_supplier_invoices
      WHERE provider = $1 AND statement_reference = $2`,
    [provider, reference],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getSupplierInvoice(id: string): Promise<SupplierInvoiceRow | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM billing_supplier_invoices WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRow(rows[0]) : null;
  });
}

/**
 * Compare one statement with our ledger and store the verdict.
 *
 * Repeatable (late cost events are normal) except for an accepted statement,
 * which a human has already decided on — overwriting it would erase the decision
 * while leaving the money paid.
 */
export async function reconcileSupplierInvoice(input: {
  invoiceId: string;
  toleranceRial?: number;
  platformAdminId?: string | null;
}): Promise<SupplierReconciliation> {
  return withoutTenantScope("platform", async () => {
    const invoice = await getSupplierInvoice(input.invoiceId);
    if (!invoice) throw new SupplierInvoiceError("not_found");
    if (!canReconcile(invoice.state)) throw new SupplierInvoiceError("already_accepted");

    // Read-only, over the same half-open window the statement claims.
    const { rows } = await query<{ recorded: string; events: string }>(
      `SELECT COALESCE(sum(amount_rial), 0)::text AS recorded, count(*)::text AS events
         FROM billing_vendor_cost_events
        WHERE provider = $1
          AND occurred_at >= $2::timestamptz
          AND occurred_at < $3::timestamptz`,
      [invoice.provider, invoice.periodStart, invoice.periodEnd],
    );
    const recordedRial = Number(rows[0]?.recorded ?? 0);
    const recordedEvents = Number(rows[0]?.events ?? 0);
    const tolerance = input.toleranceRial ?? DEFAULT_SUPPLIER_TOLERANCE_RIAL;

    const comparison = compareSupplierStatement({
      claimedRial: invoice.claimedRial,
      recordedRial,
      recordedEvents,
      toleranceRial: tolerance,
    });
    const state = stateForVerdict(comparison.verdict);

    const { rows: updated } = await query<Record<string, unknown>>(
      `UPDATE billing_supplier_invoices
          SET recorded_rial = $2,
              recorded_events = $3,
              delta_rial = $4,
              tolerance_rial = $5,
              state = $6,
              reconciled_at = now(),
              reconciled_by = $7,
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [
        invoice.id,
        recordedRial,
        recordedEvents,
        comparison.deltaRial,
        comparison.toleranceRial,
        state,
        input.platformAdminId ?? null,
      ],
    );
    billingLog("billing.supplier_invoice.reconciled", {
      provider: invoice.provider,
      statementReference: invoice.statementReference,
      state,
      deltaRial: comparison.deltaRial,
      toleranceRial: comparison.toleranceRial,
      events: recordedEvents,
    });
    return {
      invoice: toRow(updated[0]!),
      verdict: comparison.verdict,
      reason: comparison.reason,
    };
  });
}

/**
 * Accept a disputed statement, with the reason a human gives for paying it.
 *
 * Only a `disputed` statement can be accepted: accepting a matched one would imply
 * a decision was needed, and an `open` one has not been compared yet.
 */
export async function acceptSupplierInvoice(input: {
  invoiceId: string;
  reason: string;
  platformAdminId?: string | null;
}): Promise<SupplierInvoiceRow> {
  return withoutTenantScope("platform", async () => {
    const invoice = await getSupplierInvoice(input.invoiceId);
    if (!invoice) throw new SupplierInvoiceError("not_found");
    const allowed = canAccept(invoice.state, input.reason);
    if (!allowed.ok) throw new SupplierInvoiceError(allowed.code as "not_disputed" | "reason_required");

    const { rows } = await query<Record<string, unknown>>(
      `UPDATE billing_supplier_invoices
          SET state = 'accepted',
              accepted_reason = $2,
              accepted_by = $3,
              accepted_at = now(),
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [invoice.id, input.reason.trim(), input.platformAdminId ?? null],
    );
    billingLog("billing.supplier_invoice.accepted", {
      provider: invoice.provider,
      statementReference: invoice.statementReference,
      deltaRial: invoice.deltaRial,
    });
    return toRow(rows[0]!);
  });
}

/** The statements, newest period first. Disputes first, because they need a human. */
export async function listSupplierInvoices(input: { limit?: number } = {}): Promise<SupplierInvoiceRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 200);
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM billing_supplier_invoices
        ORDER BY (state = 'disputed') DESC, period_end DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toRow);
  });
}
