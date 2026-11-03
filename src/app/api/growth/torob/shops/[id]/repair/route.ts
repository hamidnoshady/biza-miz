import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { TorobShopError } from "@/lib/torob/shop-service";
import { repairShop } from "@/lib/torob/status-service";

/**
 * Issue #894 Wave 5c — «تعمیر»: one button for a shop that looks stuck.
 *
 * Announce → tell Torob → read Torob back, in that order, each step reported
 * separately. `torob.configure` because the middle step spends the shop's rate
 * budget and the first spends it too (a fill followed by a drain is what sends).
 *
 * What it deliberately is not: a retry of everything. `dead` pages stay dead until
 * somebody looks at the reason — that is the queue's own action on the webhook
 * screen — and a shop that is switched off gets a `stoppedBy` here, not a stream of
 * attempts behind the merchant's back.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.torobConfigure);
  if (error) return error;

  const { id } = await context.params;
  try {
    const result = await repairShop({ businessId: session.businessId, shopId: id });
    await audit(session.businessId, session.sub, "torob.shop.repair", id, {
      queued: result.fill.queued,
      dropped: result.fill.dropped,
      accepted: result.drain?.accepted ?? 0,
      observe: result.observe.status,
    });
    return NextResponse.json(result);
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
