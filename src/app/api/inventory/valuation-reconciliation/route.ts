/**
 * GH #1567 F1 — fungible stock valuation reconciliation for the active branch.
 *
 *  GET  — the dry run: rows whose stored carrying value drifts from quantity ×
 *         moving average, subledger totals, the GL tie-out and a fingerprint.
 *         Read-only; needs inventory.view + ledger.view (it shows cost).
 *  POST — the authorised repair of exactly that dry run: needs
 *         inventory.adjust + ledger.approve, a reason, the reviewed
 *         fingerprint and an idempotency key. Audited; posts no journal.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import {
  readItemStockValuationReconciliation,
  repairItemStockValuation,
  ValuationRepairError,
} from "@/lib/item-stock-valuation-reconciliation";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryView, PERMISSIONS.ledgerView);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const client = await getPool().connect();
  try {
    const result = await readItemStockValuationReconciliation(client, {
      businessId: session.businessId,
      locationId: location.id,
    });
    return NextResponse.json(result);
  } finally {
    client.release();
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryAdjust, PERMISSIONS.ledgerApprove);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: { reason?: unknown; fingerprint?: unknown; idempotencyKey?: unknown; confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Explicit authorisation, not a default: the operator must confirm.
  if (body.confirm !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await repairItemStockValuation(client, {
      businessId: session.businessId,
      locationId: location.id,
      performedBy: session.sub,
      reason: typeof body.reason === "string" ? body.reason : "",
      fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : "",
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof ValuationRepairError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  } finally {
    client.release();
  }
});
