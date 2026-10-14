import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPaymentById, verifyPayment } from "@/lib/wallet-service";
import { fulfilPurchasedPayment } from "@/lib/billing-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * Gateway return (Zarinpal redirects the browser here with ?Authority&Status;
 * our callback adds ?payment=<uuid>). The return page calls this route; it is
 * idempotent — verifying an already-settled payment returns its record, and
 * retries any incomplete post-settlement fulfilment.
 */
export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingManage);
  if (error) return error;

  let body: { paymentId?: string; authority?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const paymentId = String(body.paymentId ?? "");
  const authority = String(body.authority ?? "");
  const status = String(body.status ?? "");
  if (!paymentId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const existing = await getPaymentById(paymentId);
  if (!existing || existing.businessId !== session.businessId) {
    return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
  }

  try {
    await verifyPayment({ paymentId, authority, status });
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

    return NextResponse.json({
      payment: {
        id: payment.id,
        status: payment.status,
        fulfilmentStatus: payment.fulfilmentStatus,
        amountRial: payment.amountRial,
        creditRial: payment.creditRial,
        gatewayRef: payment.gatewayRef,
        purpose: payment.purpose,
      },
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      const clientErrors = new Set([
        "invalid_payment_gateway",
        "authority_mismatch",
        "duplicate_gateway_ref",
        "gateway_ref_mismatch",
        "payment_not_pending",
        "amount_mismatch",
      ]);
      const httpStatus =
        err.code === "payment_not_found"
          ? 404
          : clientErrors.has(err.code)
            ? 400
            : 502;
      return NextResponse.json(
        { error: err.code, message: gatewayErrorMessage(err.code) },
        { status: httpStatus },
      );
    }
    throw err;
  }
});
