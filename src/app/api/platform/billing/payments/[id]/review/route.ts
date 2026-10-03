import { NextResponse } from "next/server";
import { requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { getPaymentById } from "@/lib/wallet-service";
import { reviewManualPayment } from "@/lib/billing-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * Super-admin review of a payment (the dedicated per-payment route; the
 * unified manual-review queue calls the same `reviewManualPayment` service):
 *  - approve → settle (posts the wallet credit) and grants plan/addon
 *    entitlements. Used for manual (bank-transfer) gateway payments; also a
 *    recovery path if a gateway webhook never arrived or fulfilment failed.
 *  - reject  → marks the payment failed; no money moves, and never clobbers a
 *    verified payment.
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("payments.review");
    if (guard.error) return guard.error;
    const { id } = await ctx.params;

    let body: { action?: string };
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    if (body.action !== "approve" && body.action !== "reject") {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }
    const action = body.action;

    const payment = await getPaymentById(id);
    if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

    try {
      const status = await reviewManualPayment({
        paymentId: id,
        action,
        platformAdminId: guard.session.padmin,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        businessId: payment.businessId,
        action:
          action === "approve"
            ? "manual_payment.approved"
            : status === "failed"
              ? "manual_payment.rejected"
              : "manual_payment.reject_noop_verified",
        entity: "billing_payments",
        entityId: id,
        payload: { purpose: payment.purpose, amountRial: payment.amountRial, status },
      });
      const updated = await getPaymentById(id);
      return NextResponse.json({
        ok: true,
        status,
        fulfilmentStatus: updated?.fulfilmentStatus ?? payment.fulfilmentStatus,
      });
    } catch (err) {
      if (err instanceof GatewayError) {
        return NextResponse.json(
          { error: err.code, message: gatewayErrorMessage(err.code) },
          { status: 400 },
        );
      }
      throw err;
    }
  },
);
