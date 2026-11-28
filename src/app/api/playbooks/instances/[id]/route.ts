import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPlaybookInstance, transitionPlaybookInstance } from "@/lib/playbooks/instances";
import type { InstanceState } from "@/lib/playbooks/types";
import { canTransition } from "@/lib/playbooks/types";

export const GET = withTenantScope(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireAnyPermission(PERMISSIONS.crmView, PERMISSIONS.growthView);
  if (error) return error;
  const { id } = await params;
  const instance = await getPlaybookInstance(session.businessId, id);
  if (!instance) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ instance });
});

/**
 * Lifecycle transition (pause/resume/cancel/...). Permission re-checked
 * server-side; invalid transitions rejected; audit appended. For Growth-bound
 * instances, actual campaign pause/resume is done through canonical Growth
 * services by the caller/worker; here we record instance state truthfully.
 */
export const POST = withTenantScope(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { to?: InstanceState };

  // manage permission re-checked server-side; canonical app re-checks downstream
  const { session, error } = await requireAnyPermission(PERMISSIONS.partiesManage, PERMISSIONS.crmManage, PERMISSIONS.campaignsManage);
  if (error) return error;

  const instance = await getPlaybookInstance(session.businessId, id);
  if (!instance) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const to = body.to;
  if (!to || !canTransition(instance.status, to)) {
    return NextResponse.json({ error: "invalid_transition", from: instance.status, to }, { status: 409 });
  }
  const updated = await transitionPlaybookInstance(session.businessId, id, to, session.sub);
  return NextResponse.json({ instance: updated });
});
