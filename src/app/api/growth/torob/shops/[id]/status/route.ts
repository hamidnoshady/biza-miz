import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readProblemStates, observeTorobShop, readShopObservation } from "@/lib/torob/status-service";
import { TorobShopError } from "@/lib/torob/shop-service";
import { TOROB_OBSERVATION_ERROR_COPY } from "@/lib/torob/observed-state";

/**
 * Issue #894 Wave 4b — «ترب دربارهٔ این فروشگاه چه می‌گوید؟»
 *
 * `GET` is the cached answer: the shop's status and product summary **as Torob
 * last reported them**, plus the page-level problems Torob is currently showing.
 * It never calls Torob, because opening a screen is not a reason to spend a
 * provider's per-shop rate limit on numbers that are recomputed every two days.
 *
 * `POST` is the merchant's explicit refresh, and it reads only: `GET /shop/` and
 * `POST /products/` (a read that happens to be a POST). Nothing on Torob changes,
 * which is why this is `torob.view` rather than `torob.configure` — the same key
 * «پیش‌نمایش فید» uses, because looking is looking.
 *
 * Both answers carry `capabilities`, so no client has to infer which of the three
 * stages is actually known: `feed` is ours, `sent` is a webhook (Wave 6), and
 * `listing` is true only once Torob has answered for this shop.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobView);
  if (error) return error;

  const { id } = await context.params;
  const [observation, problems] = await Promise.all([
    readShopObservation({ businessId: session.businessId, shopId: id }),
    readProblemStates({ businessId: session.businessId, shopId: id, limit: 20 }),
  ]);
  if (!observation) return NextResponse.json({ error: "shop_not_found" }, { status: 404 });

  return NextResponse.json({ ...observation, problems });
});

export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobView);
  if (error) return error;

  const { id } = await context.params;
  try {
    const result = await observeTorobShop({ businessId: session.businessId, shopId: id });
    const [observation, problems] = await Promise.all([
      readShopObservation({ businessId: session.businessId, shopId: id }),
      readProblemStates({ businessId: session.businessId, shopId: id, limit: 20 }),
    ]);

    return NextResponse.json({
      ...observation,
      problems,
      outcome: result.status,
      // A failed read is answered 200 with its reason: the merchant's button did
      // what it was asked to, and Torob's refusal is a state of the channel, not a
      // broken request. The code and its sentence travel together so no client
      // owns a second copy of the vocabulary.
      failure:
        result.status === "failed"
          ? { code: result.error, message: TOROB_OBSERVATION_ERROR_COPY[result.error] }
          : null,
      seen: result.status === "observed" ? result.productsSeen : 0,
      truncated: result.status === "observed" ? result.truncated : false,
      unknownStatuses: result.status === "observed" ? result.unknownStatuses : 0,
    });
  } catch (caught) {
    if (caught instanceof TorobShopError) {
      return NextResponse.json({ error: caught.code }, { status: 404 });
    }
    throw caught;
  }
});
