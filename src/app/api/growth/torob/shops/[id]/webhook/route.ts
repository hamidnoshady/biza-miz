import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { TorobShopError } from "@/lib/torob/shop-service";
import { drainWebhookQueue, readWebhookQueue, retryDeadPages } from "@/lib/torob/webhook-service";
import { TOROB_WEBHOOK_ERROR_COPY } from "@/lib/torob/webhook";

/**
 * Issue #894 Wave 5b — «صف اطلاع‌دادن به ترب»: what is waiting, what stopped, why.
 *
 * `GET` reads the queue from our own tables (never Torob). `POST` does one of two
 * things, and both are `torob.configure`:
 *
 *   { action: "drain" }   send what is due now, instead of waiting for the tick
 *   { action: "retry" }   put stopped pages back in the queue
 *
 * The distinction from `/status` (§6e) is worth stating: that route *reads* Torob,
 * this one *tells* Torob something. Telling is a channel setting — the merchant is
 * spending their shop's rate budget — so it is configuration, not viewing.
 *
 * Neither verb can claim more than an acceptance. A successful drain answers
 * `accepted: n`, which means Torob queued n pages for a refresh; whether any of them
 * ends up displayed is Torob's own answer, and it arrives through `/status`.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobView);
  if (error) return error;

  const { id } = await context.params;
  const queue = await readWebhookQueue({ businessId: session.businessId, shopId: id });
  if (!queue) return NextResponse.json({ error: "shop_not_found" }, { status: 404 });

  return NextResponse.json({
    ...queue,
    errorCopy: TOROB_WEBHOOK_ERROR_COPY,
  });
});

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobConfigure);
  if (error) return error;

  const { id } = await context.params;
  let body: { action?: unknown; pageUniques?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "drain" && action !== "retry") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    if (action === "retry") {
      const pageUniques = Array.isArray(body.pageUniques)
        ? body.pageUniques.filter((value): value is string => typeof value === "string").slice(0, 100)
        : undefined;
      const retried = await retryDeadPages({ businessId: session.businessId, shopId: id, pageUniques });
      await audit(session.businessId, session.sub, "torob.webhook.retry", id, { retried, pageUniques: pageUniques ?? null });
      const queue = await readWebhookQueue({ businessId: session.businessId, shopId: id });
      return NextResponse.json({ retried, ...queue, errorCopy: TOROB_WEBHOOK_ERROR_COPY });
    }

    const result = await drainWebhookQueue({ businessId: session.businessId, shopId: id });
    await audit(session.businessId, session.sub, "torob.webhook.drain", id, {
      accepted: result.accepted,
      sentPages: result.sentPages,
      failed: result.failed,
      deadLettered: result.deadLettered,
      stoppedBy: result.stoppedBy,
    });
    const queue = await readWebhookQueue({ businessId: session.businessId, shopId: id });
    return NextResponse.json({
      ...result,
      ...queue,
      errorCopy: TOROB_WEBHOOK_ERROR_COPY,
      // The one sentence this endpoint must never lose: accepted is queued, not shown.
      stoppedCopy: result.stoppedBy ? TOROB_WEBHOOK_ERROR_COPY[result.stoppedBy] : null,
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
