import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { coworkerErrorMessage, type CoworkerJobInput } from "@/lib/ai-coworker";
import { TEMPLATE_PARAM_ERROR_MESSAGES } from "@/lib/ai-coworker-templates";
import { deleteCoworkerJob, updateCoworkerJob } from "@/lib/ai-coworker-service";

function messageFor(code: string): string {
  return TEMPLATE_PARAM_ERROR_MESSAGES[code] ?? coworkerErrorMessage(code);
}

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;

    let body: Partial<CoworkerJobInput>;
    try {
      body = (await request.json()) as Partial<CoworkerJobInput>;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.approvalMode === "auto" && guard.session.role !== "owner") {
      return NextResponse.json({ error: "owner_required" }, { status: 403 });
    }

    const updated = await updateCoworkerJob(guard.session.businessId, id, body, guard.session.sub);
    if (!updated.ok) {
      const status = updated.errors.includes("coworker_job_not_found") ? 404 : 400;
      return NextResponse.json(
        { error: updated.errors[0], errors: updated.errors, messages: updated.errors.map(messageFor) },
        { status },
      );
    }
    return NextResponse.json({ job: updated.job });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const removed = await deleteCoworkerJob(guard.session.businessId, id);
    if (!removed) return NextResponse.json({ error: "coworker_job_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
