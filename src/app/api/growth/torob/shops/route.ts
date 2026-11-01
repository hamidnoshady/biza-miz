import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import {
  TorobShopError,
  authorizeTorobShopWithToken,
  connectTorobShop,
  revokeTorobShop,
  setTorobShopEnabled,
  torobWebsiteOverview,
  type TorobAuthMode,
  type TorobShop,
} from "@/lib/torob/shop-service";
import { beginPartnerAuthorization } from "@/lib/torob/authorization-service";
import { TorobPartnerError } from "@/lib/torob/shop-generator";
import type { TorobWebsiteKind } from "@/lib/torob/eligibility";

/**
 * Issue #894 Wave 1 — «مدیریت ترب»: which managed websites can publish to Torob,
 * and the four things a merchant may do about it.
 *
 * `GET` returns one row per **managed** website with its Torob state. There is no
 * "add a site" action anywhere in this file, and that is the point: a website is
 * something Website Management created, and this route only ever *reads* that
 * registry (see `listManagedWebsites`) before it writes a shop. A request that
 * names a connection the business does not own is refused as `website_not_found`,
 * because the id it sent is a claim, not a fact.
 *
 * The actions are separated by permission on purpose:
 *
 *   connect / disconnect  → `torob.manage`     (a relationship decision)
 *   authorize             → `torob.manage`     (one step of that relationship: ask
 *                                               Torob for a connection and hand the
 *                                               merchant its approval page)
 *   token                 → `torob.configure`  (a credential; its own key, its own
 *                                               audit entry, never echoed back)
 *   revoke                → `torob.manage`
 *
 * Every write is audited with the numbers it decided on — and never with the
 * token. The audit payload names the shop, the website and the state transition,
 * which is what a reviewer needs and all they may see.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.torobView);
  if (error) return error;

  const websites = await torobWebsiteOverview(session.businessId);
  return NextResponse.json({
    websites,
    // Stated in the payload rather than left to the screen: Wave 1 can report
    // authorization, and cannot report what Torob has indexed. A client that
    // renders a "published" figure from this response would be inventing it.
    capabilities: { authorization: true, feed: false, listing: false, attribution: false },
  });
});

type Action = "connect" | "authorize" | "token" | "revoke" | "enable" | "disable";

const ACTIONS: readonly Action[] = ["connect", "authorize", "token", "revoke", "enable", "disable"];

function isKind(value: unknown): value is TorobWebsiteKind {
  return value === "woocommerce" || value === "eshobe_cms";
}

function audit(businessId: string, userId: string | null, action: string, shopId: string, payload: unknown) {
  return query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'torob_shop', $4, $5::jsonb)`,
    [businessId, userId, action, shopId, JSON.stringify(payload)],
  );
}

/**
 * What a shop looks like once it leaves the server.
 *
 * The row view and the API view are different types on purpose: `eligibility`'s
 * `ExistingTorobShop` carries only the facts that decide state, while a screen
 * needs the publication rule and the credential *hint*. Keeping the narrow one
 * narrow is what stops a future feed writer from reading a token out of a screen's
 * props.
 */
export interface TorobShopView {
  id: string;
  kind: TorobWebsiteKind;
  connectionId: string;
  domain: string;
  authorizationState: TorobShop["authorizationState"];
  authMode: TorobShop["authMode"];
  tokenHint: string | null;
  providerShopId: string | null;
  /** Where the merchant approves the partner request; only while pending. */
  approveUrl: string | null;
  /** Why the last approval attempt failed, already translated by the screen. */
  authorizationError: string | null;
  publicationRule: TorobShop["publicationRule"];
  enabled: boolean;
  health: TorobShop["health"];
  healthReason: string | null;
  lastCheckedAt: string | null;
}

function shaped(shop: TorobShop): TorobShopView {
  // The one place a shop leaves the server. `token_hint` only — never the token,
  // which is the rule the table's CHECK and `readTorobShopToken`'s narrowness
  // both back up.
  return {
    id: shop.id,
    kind: shop.kind,
    connectionId: shop.connectionId,
    domain: shop.domain,
    authorizationState: shop.authorizationState,
    authMode: shop.authMode,
    tokenHint: shop.tokenHint,
    providerShopId: shop.providerShopId,
    approveUrl: shop.approveUrl,
    authorizationError: shop.authorizationError,
    publicationRule: shop.publicationRule,
    enabled: shop.enabled,
    health: shop.health,
    healthReason: shop.healthReason,
    lastCheckedAt: shop.lastCheckedAt,
  };
}

/**
 * Where Torob sends the merchant's browser back to.
 *
 * The tenant's own origin, because that is where the merchant is signed in — and
 * Torob requires https outside loopback, so a deployment behind a proxy must say
 * what its public origin is rather than let this guess from a header.
 */
function returnUrlFor(request: NextRequest): string {
  const configured = process.env.TOROB_RETURN_URL_BASE?.trim().replace(/\/$/, "");
  const base = configured || request.nextUrl.origin;
  return `${base}/api/growth/torob/authorize/callback`;
}

function failure(error: unknown) {
  if (error instanceof TorobPartnerError) {
    // 502 rather than 500: Torob answered, and the answer is what the screen has
    // to explain. `not_configured` is ours, and 409 says so without pretending.
    const status = error.code === "not_configured" ? 409 : error.code === "invalid_request" ? 400 : 502;
    return NextResponse.json({ error: error.code }, { status });
  }
  if (error instanceof TorobShopError) {
    const status =
      error.code === "website_not_found" || error.code === "shop_not_found"
        ? 404
        : error.code === "shop_exists"
          ? 409
          : error.code === "token_invalid" || error.code === "token_required"
            ? 400
            : 409;
    return NextResponse.json({ error: error.code }, { status });
  }
  throw error;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    kind?: unknown;
    connectionId?: unknown;
    shopId?: unknown;
    authMode?: unknown;
    token?: unknown;
    publicationRule?: unknown;
  };
  const action = ACTIONS.includes(body.action as Action) ? (body.action as Action) : null;
  if (!action) return NextResponse.json({ error: "bad_action" }, { status: 400 });

  // Two permissions, decided by what the action touches rather than by the
  // route: a pasted merchant token is a credential even though it arrives on the
  // same endpoint as a channel switch.
  const permission = action === "token" ? PERMISSIONS.torobConfigure : PERMISSIONS.torobManage;
  const { session, error } = await requirePermission(permission);
  if (error) return error;
  const businessId = session.businessId;

  try {
    if (action === "connect") {
      if (!isKind(body.kind) || typeof body.connectionId !== "string") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      if (body.authMode !== undefined && body.authMode !== "partner" && body.authMode !== "manual_token") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const publicationRule =
        body.publicationRule === "selected" ? "selected" : body.publicationRule === "all" ? "all" : undefined;

      const { shop, created } = await connectTorobShop({
        businessId,
        kind: body.kind,
        connectionId: body.connectionId,
        authMode: (body.authMode as TorobAuthMode | undefined) ?? "partner",
        manualToken: typeof body.token === "string" ? body.token : null,
        publicationRule,
        createdBy: session.sub,
      });
      if (created) {
        await audit(businessId, session.sub, "torob.shop.connected", shop.id, {
          kind: shop.kind,
          connectionId: shop.connectionId,
          domain: shop.domain,
          authMode: shop.authMode,
          authorizationState: shop.authorizationState,
        });
      }
      return NextResponse.json({ shop: shaped(shop), created });
    }

    if (action === "token") {
      if (typeof body.shopId !== "string" || typeof body.token !== "string") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const before = await shopState(businessId, body.shopId);
      const shop = await authorizeTorobShopWithToken({ businessId, shopId: body.shopId, token: body.token });
      await audit(businessId, session.sub, "torob.shop.token_set", shop.id, {
        from: before,
        to: shop.authorizationState,
        // The hint is what a person can compare against their own records; the
        // token itself must never appear in an audit payload.
        tokenHint: shop.tokenHint,
      });
      return NextResponse.json({ shop: shaped(shop) });
    }

    if (typeof body.shopId !== "string") return NextResponse.json({ error: "bad_request" }, { status: 400 });

    if (action === "authorize") {
      const before = await shopState(businessId, body.shopId);
      const { shop, connection } = await beginPartnerAuthorization({
        businessId,
        shopId: body.shopId,
        returnUrl: returnUrlFor(request),
      });
      await audit(businessId, session.sub, "torob.shop.authorization_requested", shop.id, {
        from: before,
        to: shop.authorizationState,
        // The connection id is Torob's own handle for this shop; the approval URL
        // is a one-time page, so neither it nor the code ever reaches the audit log.
        connectionId: connection.connectionId,
        torobStatus: connection.status,
      });
      return NextResponse.json({ shop: shaped(shop), approveUrl: shop.approveUrl });
    }

    if (action === "revoke") {
      const before = await shopState(businessId, body.shopId);
      const shop = await revokeTorobShop({ businessId, shopId: body.shopId });
      await audit(businessId, session.sub, "torob.shop.revoked", shop.id, {
        from: before,
        to: shop.authorizationState,
        // Recorded because the merchant's Torob shop still exists on their side:
        // the audit says we stopped operating it, not that it was deleted.
        domainKept: shop.domain,
      });
      return NextResponse.json({ shop: shaped(shop) });
    }

    const shop = await setTorobShopEnabled({
      businessId,
      shopId: body.shopId,
      enabled: action === "enable",
    });
    await audit(businessId, session.sub, action === "enable" ? "torob.shop.enabled" : "torob.shop.disabled", shop.id, {
      authorizationState: shop.authorizationState,
      enabled: shop.enabled,
    });
    return NextResponse.json({ shop: shaped(shop) });
  } catch (error) {
    return failure(error);
  }
});

/** The authorization state before a write, for the audit's `from`. */
async function shopState(businessId: string, shopId: string): Promise<string | null> {
  const { rows } = await query<{ authorization_state: string }>(
    `SELECT authorization_state FROM torob_shops WHERE id = $1 AND business_id = $2`,
    [shopId, businessId],
  );
  return rows[0]?.authorization_state ?? null;
}
