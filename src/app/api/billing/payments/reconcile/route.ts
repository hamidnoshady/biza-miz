import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPaymentById, verifyPayment, listPayments } from "@/lib/wallet-service";
import { fulfilPurchasedPayment } from "@/lib/billing-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * Server-side recovery: reconcile a pending/redirect payment without relying on
 * the browser's callback effect. Bounded retries, preserves exactly-once ledger.
 */
export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const paymentId = String(body.paymentId ?? "");
  if (!paymentId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const existing = await getPaymentById(paymentId);
  if (!existing || existing.businessId !== session.businessId) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

  // If already verified, ensure fulfilment and return
  if (existing.status === "verified") {
    if (existing.fulfilmentStatus !== "succeeded") {
      await fulfilPurchasedPayment({
        id: existing.id,
        businessId: session.businessId,
        purpose: existing.purpose,
        planKey: existing.planKey,
        featureKey: existing.featureKey,
      });
    }
    const updated = await getPaymentById(paymentId);
    return NextResponse.json({ payment: updated });
  }

  // Only reconcile payments that are pending/redirect and have authority
  if (!existing.authority) return NextResponse.json({ error: "payment_not_pending", message: "این پرداخت قابل بازبینی نیست" }, { status: 400 });

  try {
    // Attempt verify with provider; this will mark failed/cancelled if not verified.
    await verifyPayment({ paymentId, authority: existing.authority, status: "OK" });
    let payment = await getPaymentById(paymentId);
    if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
    if (payment.status === "verified" && payment.fulfilmentStatus !== "succeeded") {
      await fulfilPurchasedPayment({
        id: payment.id,
        businessId: session.businessId,
        purpose: payment.purpose,
        planKey: payment.planKey,
        featureKey: payment.featureKey,
      });
      payment = (await getPaymentById(paymentId)) ?? payment;
    }
    return NextResponse.json({ payment });
  } catch (err) {
    if (err instanceof GatewayError) {
      if (err.code === "gateway_unreachable") {
        return NextResponse.json({ error: err.code, message: gatewayErrorMessage(err.code) }, { status: 502 });
      }
      return NextResponse.json({ error: err.code, message: gatewayErrorMessage(err.code) }, { status: 400 });
    }
    throw err;
  }
});

// List pending payments that may need reconciliation
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const pending = await listPayments({ businessId: session.businessId, status: "redirect" as never, limit: 50 });
  const pendingAlso = await listPayments({ businessId: session.businessId, status: "pending" as never, limit: 50 });
  // Also include redirect without explicit status fetch (listPayments with no status includes all, but we already have pending)
  const combined = [...pending, ...pendingAlso].slice(0, 20).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json({ payments: combined });
});
