import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/menu-validation";
import { listWebsiteOutbox, summarizeWebsiteQueue } from "@/lib/website/catalog-service";

/** The queue page: open rows (pending / failed / dead) by default, `?status=sent|all` otherwise. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId && !isUuid(connectionId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const raw = request.nextUrl.searchParams.get("status");
  const status = raw === "sent" || raw === "all" ? raw : "open";
  const [rows, summary] = await Promise.all([
    listWebsiteOutbox(session.businessId, status, 100, connectionId ?? undefined),
    summarizeWebsiteQueue(session.businessId, connectionId ?? undefined),
  ]);
  return NextResponse.json({ rows, summary });
});
