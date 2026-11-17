import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/menu-validation";
import {
  retryAllFailedCmsOrderStates,
  syncCmsOrderStatesForBusiness,
} from "@/lib/cms/order-state-outbox-service";

/** `POST /api/cms/website/orders/sync-queue/retry-all` — requeue all failed/dead CMS order-state rows and drain. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId && !isUuid(connectionId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const requeued = await retryAllFailedCmsOrderStates(
    session.businessId,
    connectionId ?? undefined,
  );
  const drained = await syncCmsOrderStatesForBusiness(
    session.businessId,
    50,
    connectionId ?? undefined,
  );
  return NextResponse.json({ requeued, ...drained });
});
