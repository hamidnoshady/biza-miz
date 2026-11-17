import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/menu-validation";
import {
  retryCmsOrderStateRow,
  syncCmsOrderStatesForBusiness,
} from "@/lib/cms/order-state-outbox-service";

/** `POST /api/cms/website/orders/sync-queue/[id]/retry` — requeue one failed/dead order-state row and drain. */
export const POST = withTenantScope(async (
  _request: Request,
  context: { params: Promise<{ id: string }> },
) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const ok = await retryCmsOrderStateRow(session.businessId, id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const drained = await syncCmsOrderStatesForBusiness(session.businessId, 20);
  return NextResponse.json({ ok: true, ...drained });
});
