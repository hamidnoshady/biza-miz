import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { getPaymentById, listPayments } from "@/lib/wallet-service";
import { listPlatformMessageTopUpRequests, reviewMessageTopUpRequest } from "@/lib/messaging-billing";
import { reviewManualPayment } from "@/lib/billing-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * The ONE manual payment review queue (migration 0176): bank-transfer payments
 * awaiting super-admin approval AND messaging credit top-up requests, side by
 * side in `/platform/billing`'s payments tab.
 */
export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const url = new URL(req.url);
  const pendingOnly = url.searchParams.get("pendingOnly") !== "0";
  const [payments, topUps] = await Promise.all([
    listPayments({ limit: 100 }),
    listPlatformMessageTopUpRequests(pendingOnly),
  ]);
  return NextResponse.json({
    manualPayments: payments.filter((p) => {
      if (pendingOnly) {
        return p.status === "pending" || (p.status === "verified" && p.fulfilmentStatus === "failed");
      }
      return p.gateway === "manual" || p.status === "pending" || p.fulfilmentStatus === "failed";
    }),
    messageTopUps: topUps,
  });
});

/**
 * Review one manual payment of either kind:
 *   { kind: "payment",       id, action: "approve" | "reject" }
 *   { kind: "message_topup", id, action: "approve" | "reject" }
 */
export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("payments.review");
  if (guard.error) return guard.error;

  let body: { kind?: string; id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  const action = body.action;
  const kind = body.kind === "message_topup" ? "message_topup" : "payment";
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  if (kind === "message_topup") {
    try {
      const request = await reviewMessageTopUpRequest({
        requestId: id,
        status: action === "approve" ? "approved" : "rejected",
        platformAdminId: guard.session.padmin,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        businessId: request.businessId,
        action: action === "approve" ? "manual_payment.approved" : "manual_payment.rejected",
        entity: "message_top_up_requests",
        entityId: id,
        payload: { kind, packageName: request.packageName, creditRial: request.creditAmountRial },
      });
      return NextResponse.json({ ok: true, request });
    } catch (err) {
      if (err instanceof Error && (err.message === "not_found" || err.message === "top_up_not_pending")) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  }

  try {
    const status = await reviewManualPayment({
      paymentId: id,
      action,
      platformAdminId: guard.session.padmin,
    });
    const updated = await getPaymentById(id);
    await platformAudit({
      adminId: guard.session.padmin,
      businessId: updated?.businessId,
      action:
        action === "approve"
          ? "manual_payment.approved"
          : status === "failed"
            ? "manual_payment.rejected"
            : "manual_payment.reject_noop_verified",
      entity: "billing_payments",
      entityId: id,
      payload: { kind: "payment", action, status },
    });
    return NextResponse.json({
      ok: true,
      status,
      fulfilmentStatus: updated?.fulfilmentStatus ?? "succeeded",
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
});
