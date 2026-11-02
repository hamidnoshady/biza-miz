import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { readShopPublication, setProductDecision, setPublicationRule } from "@/lib/torob/shop-publication";
import { TorobShopError } from "@/lib/torob/shop-service";
import { TOROB_SELECTION_BATCH_LIMIT, type PublicationRule, type TorobDecision } from "@/lib/torob/publication";

/**
 * Issue #894 Wave 4 — «چه چیزی به ترب برود؟», one shop at a time.
 *
 * `GET` is the per-shop screen's only read: the products with each one's state,
 * the rule, and the same feed summary the preview shows. `POST` writes the two
 * things a merchant actually decides here:
 *
 *   { rule, includeOutOfStock? }   which rule the shop follows
 *   { productIds, decision }       one product (or a bounded batch), or `null`
 *                                  to go back to whatever the rule says
 *
 * The permission split follows `growth-access.ts`: reading is `torob.view`,
 * writing is `torob.configure` — the channel's configuration, which is what both
 * of these are. Nothing here can authorize a shop, switch the channel on or spend
 * a credential; those are `torob.manage`/`torob.configure` on the shops route.
 *
 * Every decision is audited with the product ids and never with anything the
 * catalogue owns: this table stores a decision, and the audit says who made it.
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobView);
  if (error) return error;

  const { id } = await context.params;
  const search = request.nextUrl.searchParams.get("search") ?? "";
  const page = Number(request.nextUrl.searchParams.get("page") ?? "1");

  const publication = await readShopPublication({
    businessId: session.businessId,
    shopId: id,
    search,
    page,
  });
  if (!publication) return NextResponse.json({ error: "shop_not_found" }, { status: 404 });

  return NextResponse.json({
    ...publication,
    // Stated in the payload rather than inferred by the screen: «در فید ترب» means
    // the platform would send this product, and says nothing about whether Torob
    // has accepted, fetched or indexed it.
    capabilities: { feed: true, sent: false, listing: false },
  });
});

type Body = {
  rule?: unknown;
  includeOutOfStock?: unknown;
  productIds?: unknown;
  productId?: unknown;
  decision?: unknown;
};

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobConfigure);
  if (error) return error;

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Body;

  try {
    if (body.rule !== undefined) {
      if (body.rule !== "all" && body.rule !== "selected") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      if (body.includeOutOfStock !== undefined && typeof body.includeOutOfStock !== "boolean") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const rule: PublicationRule = body.rule;
      await setPublicationRule({
        businessId: session.businessId,
        shopId: id,
        rule,
        ...(typeof body.includeOutOfStock === "boolean" ? { includeOutOfStock: body.includeOutOfStock } : {}),
      });
      await audit(session.businessId, session.sub, "torob.shop.publication_rule", id, {
        rule,
        includeOutOfStock: body.includeOutOfStock ?? null,
      });
      return NextResponse.json({ rule });
    }

    const ids = normaliseIds(body);
    if (ids === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    if (ids.length > TOROB_SELECTION_BATCH_LIMIT) {
      return NextResponse.json({ error: "selection_batch_too_large" }, { status: 400 });
    }

    const decision = normaliseDecision(body.decision);
    if (decision === undefined) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    const result = await setProductDecision({
      businessId: session.businessId,
      shopId: id,
      productIds: ids,
      decision,
      createdBy: session.sub,
    });
    await audit(session.businessId, session.sub, "torob.shop.product_decision", id, {
      decision,
      productIds: ids,
      applied: result.applied,
      // The count of ids that were not this business's catalogue rows. Recorded
      // rather than silently dropped: a client asking about products it does not
      // own is worth seeing in a trail.
      refused: result.skipped,
    });
    return NextResponse.json(result);
  } catch (caught) {
    if (caught instanceof TorobShopError) {
      const status =
        caught.code === "shop_not_found" ? 404 : caught.code === "selection_batch_too_large" ? 400 : 409;
      return NextResponse.json({ error: caught.code }, { status });
    }
    throw caught;
  }
});

/** `productIds` or a single `productId`, as a non-empty list of strings. */
function normaliseIds(body: Body): string[] | null {
  const values = Array.isArray(body.productIds)
    ? body.productIds
    : typeof body.productId === "string"
      ? [body.productId]
      : null;
  if (!values || values.length === 0) return null;
  if (!values.every((value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value))) return null;
  return values as string[];
}

/** `include`/`exclude`, or `null` for "back to the rule"; `undefined` for garbage. */
function normaliseDecision(value: unknown): TorobDecision | null | undefined {
  if (value === "include" || value === "exclude") return value;
  if (value === null) return null;
  return undefined;
}

function audit(businessId: string, userId: string | null, action: string, shopId: string, payload: unknown) {
  return query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'torob_shop', $4, $5::jsonb)`,
    [businessId, userId, action, shopId, JSON.stringify(payload)],
  );
}
