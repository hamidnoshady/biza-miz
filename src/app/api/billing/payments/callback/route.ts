import { NextResponse, NextRequest } from "next/server";
import { verifyPayment, getPaymentById } from "@/lib/wallet-service";
import { fulfilPurchasedPayment } from "@/lib/billing-service";
import { GatewayError } from "@/lib/payment-gateway";
import { withTenant, withoutTenantScope } from "@/lib/db";

// Canonical gateway return endpoint that does not require browser session.
// Zarinpal redirects here with ?payment=<uuid>&Authority=...&Status=OK|NOK
// This is the supported callback mechanism (#928 P1.3) — not the tenant
// billing route tree's /api/billing/payments/callback suggestion that was
// previously documented but not shipped.
//
// The handler is unauthenticated: the browser arrives from the provider with
// no session cookie that can reliably be mapped to a business.  The payment
// id is *how* the tenant is selected — so the initial lookup runs under a
// documented `withoutTenantScope("payment-callback")` bypass and every later
// statement (verify, fulfil, ledger credit) runs inside `withTenant` for that
// business.  FORCE RLS on `billing_payments` would otherwise make
// `getPaymentById` return null and every real callback would stop at 404.

async function handleCallback(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const paymentId = url.searchParams.get("payment") ?? url.searchParams.getAll("paymentId")[0] ?? "";
  const authority = url.searchParams.get("Authority") ?? url.searchParams.get("authority") ?? "";
  const status = url.searchParams.get("Status") ?? url.searchParams.get("status") ?? "";

  if (!paymentId || !authority) {
    return NextResponse.json({ error: "missing_fields", message: "پارامترهای بازگشت درگاه ناقص است" }, { status: 400 });
  }

  // Identify the tenant first: bypass RLS to see the payment regardless of who called.
  const initial = await withoutTenantScope("payment-callback", () => getPaymentById(paymentId));
  if (!initial) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

  const businessId = initial.businessId;

  try {
    await withTenant(businessId, async () => {
      await verifyPayment({ paymentId, authority, status });
      const payment = await getPaymentById(paymentId);
      if (!payment) return;

      // Fulfil if verified but not yet fulfilled (idempotent)
      if (payment.status === "verified" && payment.fulfilmentStatus !== "succeeded") {
        await fulfilPurchasedPayment({
          id: payment.id,
          businessId: payment.businessId,
          purpose: payment.purpose,
          planKey: payment.planKey,
          featureKey: payment.featureKey,
        });
      }
    });

    const finalPayment = await withoutTenantScope("payment-callback", () => getPaymentById(paymentId));
    const payment = finalPayment ?? initial;
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

export async function GET(req: NextRequest) {
  return handleCallback(req);
}

export const POST = GET;
