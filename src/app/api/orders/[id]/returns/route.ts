import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { boundedRialText } from "@/lib/inventory-exact";
import { createCustomerReturn } from "@/lib/customer-return-service";
import {
  isCustomerReturnRefundMethod,
  isUuid,
  normalizeCustomerReturnLines,
  validateCustomerReturnReason,
} from "@/lib/customer-return-domain";
import { getOrderReturnHistory } from "@/lib/customer-return-read-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { recordNotification } from "@/lib/notification-events";
import { notificationDedupeKey } from "@/lib/notifications";
import { tomanText } from "@/lib/ai-labels";
import { broadcast } from "@/lib/realtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorStatus(code: string): number {
  if ([
    "bad_request",
    "invalid_order_id",
    "invalid_refund_method",
    "invalid_rial",
    "rial_out_of_range",
    "invalid_idempotency_key",
    "invalid_return_lines",
    "invalid_return_line",
    "invalid_return_quantity",
    "invalid_quantity",
    "quantity_precision_exceeded",
    "invalid_return_disposition",
    "return_reason_required",
    "return_reason_too_long",
  ].includes(code)) return 400;
  if (code === "completed_order_not_found" || code === "order_item_not_found") return 404;
  if ([
    "refund_exceeds_remaining_refundable_amount",
    "return_quantity_exceeds_sold",
    "historical_cogs_unavailable",
    "invalid_return_cost_basis",
    "idempotency_key_conflict",
    "duplicate_return_line_conflict",
  ].includes(code)) return 409;
  return 0;
}

/** Read return history without widening the shared order-detail/printing response. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const history = await getOrderReturnHistory({
    businessId: session.businessId,
    locationId: location.id,
    orderId: id,
  });
  if (!history) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  return NextResponse.json({ ...history, timeZone: location.timezone });
});

/** Create a customer return in the same transaction as its stock/accounting postings. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.paymentsRefund);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(rawBody)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (Object.keys(rawBody).some((key) => !["refundMethod", "refundAmountRial", "idempotencyKey", "reason", "lines"].includes(key))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const refundMethod = rawBody.refundMethod === undefined ? "cash" : rawBody.refundMethod;
  if (!isCustomerReturnRefundMethod(refundMethod)) {
    return NextResponse.json({ error: "invalid_refund_method" }, { status: 400 });
  }
  if (typeof rawBody.refundAmountRial !== "string") {
    return NextResponse.json({ error: "invalid_rial" }, { status: 400 });
  }
  if (typeof rawBody.idempotencyKey !== "string") {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }

  let refundAmount;
  let reason: string;
  let lines;
  try {
    refundAmount = boundedRialText(rawBody.refundAmountRial);
    reason = validateCustomerReturnReason(rawBody.reason);
    lines = normalizeCustomerReturnLines(rawBody.lines);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : "bad_request";
    return NextResponse.json({ error: code }, { status: errorStatus(code) || 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createCustomerReturn(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      refundMethod,
      refundAmount,
      reason,
      idempotencyKey: rawBody.idempotencyKey,
      createdBy: session.sub,
      sync: { actorRole: session.role },
      lines,
    });
    await client.query("COMMIT");

    // Notifications and realtime are side effects of a committed return. Their
    // failure must not turn a successful refund into a reported failed request;
    // a retry with the same intent is safe, but cannot replace this response.
    if (!result.duplicate) {
      try {
        await recordNotification({
          businessId: session.businessId,
          locationId: location.id,
          eventKey: "payment.refunded",
          severity: "important",
          title: "برگشت وجه به مشتری",
          body: `${tomanText(result.refundAmount)} — ${reason}`,
          url: "/accounting/orders",
          amountRial: result.refundAmount,
          dedupeKey: notificationDedupeKey("payment.refunded", result.id),
          payload: { orderId: id, returnId: result.id },
        });
      } catch (notificationError) {
        console.error("customer return notification failed:", notificationError);
      }
      broadcast(location.id, { type: "order.updated", orderId: id });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = caught instanceof Error ? caught.message : "customer_return_failed";
    const status = errorStatus(code);
    if (status) return NextResponse.json({ error: code }, { status });
    console.error("customer return transaction failed:", caught);
    return NextResponse.json({ error: "customer_return_failed" }, { status: 500 });
  } finally {
    client.release();
  }
});
