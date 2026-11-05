import { NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  acceptSupplierInvoice,
  getSupplierInvoice,
  listSupplierInvoices,
  reconcileSupplierInvoice,
  recordSupplierInvoice,
  SupplierInvoiceError,
} from "@/lib/billing/supplier-invoice-service";

/**
 * Issue #902 §9 item 3 — the supplier's invoice, reconciled against our ledger.
 *
 * `GET`  ?id=… — the statements (disputes first), or one of them.
 * `POST` { action: "record" | "reconcile" | "accept", … } — the three steps of a
 *        reconciliation, each capability-guarded and audited.
 *
 * Three actions rather than one "reconcile" button because they are three
 * different decisions: recording a statement is bookkeeping, comparing it is
 * arithmetic, and **accepting** a disagreement is a person choosing to pay money
 * that our own books say we do not owe. The last one requires a reason, and the
 * database refuses it without one.
 */

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  not_disputed: 409,
  reason_required: 400,
  already_accepted: 409,
  bad_period: 400,
  bad_amount: 400,
};

function failure(error: unknown) {
  if (error instanceof SupplierInvoiceError) {
    return NextResponse.json({ error: error.code }, { status: ERROR_STATUS[error.code] ?? 400 });
  }
  throw error;
}

export const GET = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.view");
  if (guard.error) return guard.error;

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const invoice = await getSupplierInvoice(id);
    if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ invoice });
  }
  return NextResponse.json({ invoices: await listSupplierInvoices({ limit: 100 }) });
});

export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = String(body.action ?? "");
  try {
    if (action === "record") {
      const recorded = await recordSupplierInvoice({
        provider: String(body.provider ?? ""),
        statementReference: String(body.statementReference ?? ""),
        periodStart: String(body.periodStart ?? ""),
        periodEnd: String(body.periodEnd ?? ""),
        claimedRial: Number(body.claimedRial),
        note: body.note === undefined ? null : String(body.note),
        platformAdminId: guard.session.padmin,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        action: recorded.created ? "supplier_invoice.recorded" : "supplier_invoice.rerecorded",
        entity: "billing_supplier_invoices",
        entityId: recorded.invoice.id,
        payload: {
          provider: recorded.invoice.provider,
          statementReference: recorded.invoice.statementReference,
          claimedRial: recorded.invoice.claimedRial,
          created: recorded.created,
        },
      });
      return NextResponse.json({ ok: true, invoice: recorded.invoice, created: recorded.created });
    }

    const invoiceId = String(body.id ?? "");
    if (!invoiceId) return NextResponse.json({ error: "missing_id" }, { status: 400 });

    if (action === "reconcile") {
      const tolerance = body.toleranceRial === undefined ? undefined : Number(body.toleranceRial);
      if (tolerance !== undefined && (!Number.isSafeInteger(tolerance) || tolerance < 0)) {
        return NextResponse.json({ error: "bad_amount" }, { status: 400 });
      }
      const result = await reconcileSupplierInvoice({
        invoiceId,
        toleranceRial: tolerance,
        platformAdminId: guard.session.padmin,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        action: "supplier_invoice.reconciled",
        entity: "billing_supplier_invoices",
        entityId: invoiceId,
        payload: {
          provider: result.invoice.provider,
          statementReference: result.invoice.statementReference,
          state: result.invoice.state,
          claimedRial: result.invoice.claimedRial,
          recordedRial: result.invoice.recordedRial,
          deltaRial: result.invoice.deltaRial,
          toleranceRial: result.invoice.toleranceRial,
        },
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === "accept") {
      const invoice = await acceptSupplierInvoice({
        invoiceId,
        reason: String(body.reason ?? ""),
        platformAdminId: guard.session.padmin,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        action: "supplier_invoice.accepted",
        entity: "billing_supplier_invoices",
        entityId: invoiceId,
        payload: {
          provider: invoice.provider,
          statementReference: invoice.statementReference,
          deltaRial: invoice.deltaRial,
          reason: invoice.acceptedReason,
        },
      });
      return NextResponse.json({ ok: true, invoice });
    }

    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
});
