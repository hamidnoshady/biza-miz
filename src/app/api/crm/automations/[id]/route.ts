import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteAutomation, setAutomationActive } from "@/lib/crm-automation-service";
import { isUuid } from "@/lib/uuid";

/**
 * One automation: turn it off, turn it on, or delete it.
 *
 * Deactivating is the ordinary way to stop a rule, and it keeps everything: the
 * rule, its counters and its runs. Deleting is for a rule that was a mistake —
 * and even then the runs survive, because `crm_automation_runs` keeps the rule's
 * name rather than pointing at it (`migration 0200`), and "what did this do
 * before we deleted it" is asked afterwards.
 *
 * Both are `crm.configure`: whoever may write a rule may stop it, and nobody
 * else. There is no per-rule ownership — a rule belongs to the business, and one
 * colleague leaving must not leave a rule running that nobody can turn off.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "automation_not_found" }, { status: 404 });

    let body: { isActive?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const automation = await setAutomationActive(session.businessId, id, body.isActive, {
      name: session.fullName,
      userId: session.sub,
    });
    if (!automation) return NextResponse.json({ error: "automation_not_found" }, { status: 404 });
    return NextResponse.json({ automation });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteAutomation(session.businessId, id, {
      name: session.fullName,
      userId: session.sub,
    });
    if (!deleted) return NextResponse.json({ error: "automation_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);
