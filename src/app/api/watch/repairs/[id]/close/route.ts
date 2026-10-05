import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermissions } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { closeRepairTicket, getRepairTicket } from "@/lib/repairs-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import type { SettlementMethod } from "@/lib/ledger";

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];

/**
 * Delivers and bills a repair: revenue + parts cost posted together, in one transaction with the status change.
 *
 * Issue #795 Phase 1 (item 8) — closing settles money (cash/bank/A-R,
 * revenue, VAT), so operational inventory authority alone is not enough:
 * the caller needs `payments.take` on top of `inventory.adjust`, the same
 * split the shared retail POS enforces (POS_REQUIRED_PERMISSIONS).
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryAdjust, PERMISSIONS.paymentsTake);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  const ticket = await getRepairTicket(id);
  if (!location || !ticket || ticket.locationId !== location.id) {
    return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
  }

  let body: { paymentMethod?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const paymentMethod = body.paymentMethod as SettlementMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await closeRepairTicket(client, {
      businessId: session.businessId,
      ticketId: id,
      paymentMethod,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
