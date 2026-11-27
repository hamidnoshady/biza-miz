import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { CampaignRewardError, redeemCampaignReward } from "@/lib/campaign-reward-service";
import { readJsonObject } from "@/lib/campaign-builder-http";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";

/**
 * Issue #901 — pay a customer's earned campaign reward out.
 *
 * `loyalty.redeem` and not `store_credit.payout`: this is spending a reward the
 * customer earned, the same trust as spending their loyalty points. The money
 * leaves through its own liability (2440) and its own posting, never through
 * the store-credit payout path.
 *
 * `requestKey` is the caller's idempotency key. A retried request with the same
 * key returns the original payout and posts nothing.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyRedeem);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const customerId = body.customerId;
  if (!isUuid(customerId)) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  const amountRial = body.amountRial;
  if (typeof amountRial !== "number" || !Number.isSafeInteger(amountRial) || amountRial <= 0) {
    return NextResponse.json({ error: "amount_invalid" }, { status: 400 });
  }
  const payoutMethod = body.payoutMethod;
  if (payoutMethod !== "cash" && payoutMethod !== "bank") {
    return NextResponse.json({ error: "payout_method_invalid" }, { status: 400 });
  }
  const requestKey = body.requestKey;
  if (typeof requestKey !== "string" || requestKey.trim().length < 8 || requestKey.length > 128) {
    return NextResponse.json({ error: "request_key_invalid" }, { status: 400 });
  }

  // Paying a reward out is a till action: it needs the branch the money leaves
  // from, and that branch's own business date decides the journal's entry date.
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const businessDay = await getBusinessDayStatus(location.id);

  try {
    const result = await redeemCampaignReward(session.businessId, {
      customerId,
      amountRial,
      payoutMethod,
      requestKey,
      actorId: session.sub,
      businessDate: businessDay?.businessDate ?? new Date().toISOString().slice(0, 10),
      locationId: location.id,
    });
    return NextResponse.json({ redemption: result }, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    if (e instanceof CampaignRewardError) {
      return NextResponse.json({ error: e.code, ...(e.details ?? {}) }, { status: e.status });
    }
    throw e;
  }
});
