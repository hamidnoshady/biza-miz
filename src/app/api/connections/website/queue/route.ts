import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listWebsiteOutbox, summarizeWebsiteQueue } from "@/lib/website/catalog-service";

/** The queue page: open rows (pending / failed / dead) by default, `?status=sent|all` otherwise. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const raw = request.nextUrl.searchParams.get("status");
  const status = raw === "sent" || raw === "all" ? raw : "open";
  const [rows, summary] = await Promise.all([
    listWebsiteOutbox(session.businessId, status),
    summarizeWebsiteQueue(session.businessId),
  ]);
  return NextResponse.json({ rows, summary });
});
