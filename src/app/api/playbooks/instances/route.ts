import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listPlaybookInstances } from "@/lib/playbooks/instances";
import type { InstanceState } from "@/lib/playbooks/types";

/** List tenant playbook instances (manage/results). Server-scoped to session business. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireAnyPermission(PERMISSIONS.crmView, PERMISSIONS.growthView);
  if (error) return error;
  const status = request.nextUrl.searchParams.get("status") as InstanceState | null;
  const templateKey = request.nextUrl.searchParams.get("templateKey") ?? undefined;
  const instances = await listPlaybookInstances(session.businessId, { status: status ?? undefined, templateKey });
  return NextResponse.json({ instances });
});
