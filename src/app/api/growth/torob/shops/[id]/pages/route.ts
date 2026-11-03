import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { TorobShopError } from "@/lib/torob/shop-service";
import { setPagesOnTorob } from "@/lib/torob/status-service";
import { TOROB_OBSERVATION_ERROR_COPY } from "@/lib/torob/observed-state";

/**
 * Issue #894 Wave 5c — «خاموش/روشن کردن یک محصول در ترب».
 *
 * The only endpoint in this feature that changes what a shopper sees, so it is
 * `torob.configure` and it is narrow: a bounded list of pages, one direction, and
 * an answer that says which pages Torob actually acted on.
 *
 * `active: false` deactivates — Torob stops showing the page but keeps it, so the
 * merchant can turn it back on; it is never a delete, and the copy says so. The
 * body is `{ pageUniques: string[], active: boolean }`, capped at the provider's
 * own 5 000-id limit and at a smaller screening bound here.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobConfigure);
  if (error) return error;

  const { id } = await context.params;
  let body: { pageUniques?: unknown; active?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // The screen sends one page per click; the bound keeps the endpoint from being a
  // catalogue-wide switch that nobody reviewed.
  const pageUniques = Array.isArray(body.pageUniques)
    ? body.pageUniques.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 500)
    : [];
  if (pageUniques.length === 0 || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await setPagesOnTorob({
      businessId: session.businessId,
      shopId: id,
      pageUniques,
      active: body.active,
    });

    if (result.status === "blocked") {
      // A state of the channel, not a broken request: 200 with the reason and its
      // sentence, the same shape `/status` uses for a failed read.
      return NextResponse.json({
        status: "blocked",
        error: result.error,
        message: TOROB_OBSERVATION_ERROR_COPY[result.error],
      });
    }

    await audit(session.businessId, session.sub, "torob.page.toggle", id, {
      active: body.active,
      found: result.found.length,
      missing: result.missing.length,
    });

    return NextResponse.json({
      status: "applied",
      active: body.active,
      found: result.found,
      missing: result.missing,
      // Said in the payload so no client has to invent it: our copy of a page's
      // state is Torob's answer, and the next read is what will show it.
      note: "وضعیت نمایش را ترب تعیین می‌کند؛ برای دیدن نتیجه، وضعیت را از ترب بخوانید.",
    });
  } catch (caught) {
    if (caught instanceof TorobShopError) {
      return NextResponse.json({ error: caught.code }, { status: 404 });
    }
    throw caught;
  }
});

function audit(businessId: string, userId: string | null, action: string, shopId: string, payload: unknown) {
  return query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'torob_shop', $4, $5::jsonb)`,
    [businessId, userId, action, shopId, JSON.stringify(payload)],
  );
}
