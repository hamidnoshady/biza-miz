import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import { countPendingCoworkerRuns, listCoworkerRuns } from "@/lib/ai-coworker-service";
import type { CoworkerRunStatus } from "@/lib/ai-coworker";

const STATUSES = new Set([
  "pending_approval",
  "applied",
  "partially_applied",
  "rejected",
  "failed",
  "skipped",
  "reported",
]);

export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiManage);
  if (guard.error) return guard.error;

  const requested = request.nextUrl.searchParams.get("status");
  const status = requested && STATUSES.has(requested) ? (requested as CoworkerRunStatus) : undefined;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);

  const [runs, pendingCount] = await Promise.all([
    listCoworkerRuns(guard.session.businessId, { status, limit }),
    countPendingCoworkerRuns(guard.session.businessId),
  ]);
  return NextResponse.json({ runs, pendingCount });
});
