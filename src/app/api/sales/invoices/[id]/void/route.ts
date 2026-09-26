import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { voidRetailInvoice, RetailInvoiceVoidError } from "@/lib/retail-invoice-void-service";
import { MIN_REASON_LENGTH, MAX_REASON_LENGTH } from "@/lib/order-amendments";
import { broadcast } from "@/lib/realtime";

type Context = { params: Promise<{ id: string }> };

/**
 * A void's reversal entries land on the original sale's own date (see
 * retail-invoice-void-service.ts), so — exactly like the café's own
 * amendment route — a month closed since then refuses it here (migration
 * 0024's trigger) instead of the correction silently landing in the current
 * one.
 */
const FISCAL_LOCK_STATUS: Record<string, number> = {
  fiscal_period_locked: 409,
  fiscal_period_soft_closed: 409,
};

/**
 * Voids a completed retail invoice — reverses its ledger postings, restores
 * the inventory it consumed, and reverses any commission/loyalty it produced.
 * See retail-invoice-void-service.ts for exactly what this can and cannot
 * void automatically (gold/watch and batch-tracked cosmetics are refused,
 * with a specific reason, never silently half-voided).
 *
 * Same permission as the café's closed-order amendment
 * (`ordersAmendClosed`) — voiding a completed retail invoice is the retail
 * shape of the same "correct something already paid for" action, so it does
 * not need a second, parallel permission for every role preset to learn.
 */
export const POST = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersAmendClosed);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const reason = (body.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) return NextResponse.json({ error: "reason_required" }, { status: 400 });
  if (reason.length > MAX_REASON_LENGTH) return NextResponse.json({ error: "reason_too_long" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await voidRetailInvoice(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      actorId: session.sub,
      reason,
    });
    await client.query("COMMIT");
    broadcast(location.id, { type: "order.updated", orderId: id });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof RetailInvoiceVoidError) {
      return NextResponse.json({ error: "void_failed", message: err.message }, { status: err.status });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "missing_ledger_account", message: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "";
    const status = FISCAL_LOCK_STATUS[message];
    if (status) return NextResponse.json({ error: message }, { status });
    throw err;
  } finally {
    client.release();
  }
});
