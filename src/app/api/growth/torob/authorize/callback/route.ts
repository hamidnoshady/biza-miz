import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import {
  completePartnerAuthorization,
  denyPartnerAuthorization,
} from "@/lib/torob/authorization-service";
import { TorobShopError } from "@/lib/torob/shop-service";
import { TorobPartnerError } from "@/lib/torob/shop-generator";

/**
 * Issue #894 Wave 3 — where Torob sends the merchant's browser back.
 *
 * This is a **GET** redirect, not an API call from Torob: the one-time `code`
 * travels through the merchant's own browser, and the document is explicit that
 * this is deliberate — an approval counts only for the browser session that
 * started it. So the caller here is a signed-in merchant, not a server, and the
 * route is session- and permission-gated like every other Growth write.
 *
 * Three guards decide whether the code is spent:
 *
 *   1. **The session.** No session, no confirm: the middleware sends them to sign
 *      in, and `requirePermission` refuses a member who may not manage the
 *      channel.
 *   2. **The tenant.** The shop is resolved by `(business_id, provider_shop_id)`
 *      — the connection id stored when *this* business asked — so a link minted
 *      for another shop resolves to nothing, which is exactly the attack Torob's
 *      document warns about.
 *   3. **The window.** Torob gives the flow 15 minutes; a code that arrives after
 *      that is refused here without being sent, and the row records `expired`.
 *
 * The answer is always a redirect back to «مدیریت ترب» with a short outcome
 * parameter — never a JSON body, because a human is looking at it. The code is
 * never echoed into a URL the browser keeps.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobManage);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const connectionId = params.get("connection_id")?.trim() ?? "";
  const code = params.get("code")?.trim() ?? "";
  const denied = params.get("error") === "denied";

  const answer = (outcome: string) =>
    NextResponse.redirect(new URL(`/growth/torob?torob=${encodeURIComponent(outcome)}`, request.nextUrl.origin));

  // A connection id is required for either branch: without it there is no shop to
  // resolve, and guessing from the session would be the confusion this route exists
  // to avoid.
  if (!connectionId) return answer("invalid_request");

  try {
    if (denied) {
      const shop = await denyPartnerAuthorization({ businessId: session.businessId, connectionId });
      await audit(session.businessId, session.sub, "torob.shop.authorization_denied", shop.id, {
        connectionId,
        to: shop.authorizationState,
      });
      return answer("denied");
    }

    if (!code) return answer("invalid_request");

    const shop = await completePartnerAuthorization({
      businessId: session.businessId,
      connectionId,
      code,
    });
    await audit(session.businessId, session.sub, "torob.shop.authorized", shop.id, {
      connectionId,
      to: shop.authorizationState,
      // Still nothing about Torob's *index*: this row is authorized to publish,
      // which is a different fact from being listed.
      authMode: shop.authMode,
    });
    return answer("connected");
  } catch (caught) {
    if (caught instanceof TorobPartnerError) {
      // Best-effort: the merchant is looking at a redirect, and a failed audit
      // insert must not turn a explained refusal into a broken page.
      await audit(session.businessId, session.sub, "torob.shop.authorization_failed", connectionId, {
        reason: caught.code,
      }).catch(() => undefined);
      return answer(caught.code);
    }
    if (caught instanceof TorobShopError) return answer(caught.code);
    throw caught;
  }
});

function audit(businessId: string, userId: string | null, action: string, entityId: string, payload: unknown) {
  return query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'torob_shop', $4, $5::jsonb)`,
    [businessId, userId, action, entityId, JSON.stringify(payload)],
  );
}
