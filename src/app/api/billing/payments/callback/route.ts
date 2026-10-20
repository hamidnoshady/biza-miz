import { NextResponse, NextRequest } from "next/server";
import { verifyPayment, getPaymentById } from "@/lib/wallet-service";
import { fulfilPurchasedPayment } from "@/lib/billing-service";
import { GatewayError } from "@/lib/payment-gateway";

// Canonical gateway return endpoint that does not require browser session.
// Zarinpal redirects here with ?payment=<uuid>&Authority=...&Status=OK|NOK
// This is the supported callback mechanism (#928 P1.3) — not the tenant
// billing route tree's /api/billing/payments/callback suggestion that was
// previously documented but not shipped.

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const paymentId = url.searchParams.get("payment") ?? url.searchParams.getAll("paymentId")[0] ?? "";
  const authority = url.searchParams.get("Authority") ?? url.searchParams.get("authority") ?? "";
  const status = url.searchParams.get("Status") ?? url.searchParams.get("status") ?? "";

  if (!paymentId || !authority) {
    return NextResponse.json({ error: "missing_fields", message: "پارامترهای بازگشت درگاه ناقص است" }, { status: 400 });
  }

  const existing = await getPaymentById(paymentId);
  if (!existing) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

  // Verify without tenant scope: callback is unauthenticated but must match
  // payment's business context via authority. Business check happens in verifyPayment.
  try {
    await verifyPayment({ paymentId, authority, status });
    let payment = await getPaymentById(paymentId);
    if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

    // Fulfil if verified but not yet fulfilled (idempotent)
    if (payment.status === "verified" && payment.fulfilmentStatus !== "succeeded") {
      await fulfilPurchasedPayment({
        id: payment.id,
        businessId: payment.businessId,
        purpose: payment.purpose,
        planKey: payment.planKey,
        featureKey: payment.featureKey,
      });
      payment = (await getPaymentById(paymentId)) ?? payment;
    }

    // Redirect to frontend billing page with result status for UX
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
    const target = new URL("/settings/billing", baseUrl);
    target.searchParams.set("payment", payment.id);
    target.searchParams.set("paymentStatus", payment.status);
    if (payment.fulfilmentStatus) target.searchParams.set("fulfilment", payment.fulfilmentStatus);
    return NextResponse.redirect(target.toString(), 302);
  } catch (err) {
    if (err instanceof GatewayError) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
      const target = new URL("/settings/billing", baseUrl);
      target.searchParams.set("payment", paymentId);
      target.searchParams.set("paymentStatus", "failed");
      target.searchParams.set("error", err.code);
      return NextResponse.redirect(target.toString(), 302);
    }
    throw err;
  }
}

export const POST = GET;
