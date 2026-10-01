import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { automationErrorMessage, type AutomationInput } from "@/lib/ai-automations";
import {
  deleteAutomation,
  getAutomation,
  updateAutomation,
} from "@/lib/ai-automations-service";

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const automation = await getAutomation(guard.session.businessId, id);
    if (!automation) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ automation });
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;

    let body: AutomationInput;
    try {
      body = (await request.json()) as AutomationInput;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.approvalMode === "auto" && guard.session.role !== "owner") {
      return NextResponse.json({ error: "owner_required" }, { status: 403 });
    }

    const updated = await updateAutomation(guard.session.businessId, id, body, {
      authorizedBy: guard.session.sub,
    });
    if (!updated.ok) {
      const status = updated.errors.includes("not_found") ? 404 : 400;
      return NextResponse.json(
        {
          error: updated.errors[0],
          errors: updated.errors,
          messages: updated.errors.map(automationErrorMessage),
        },
        { status },
      );
    }
    return NextResponse.json({ automation: updated.automation });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const removed = await deleteAutomation(guard.session.businessId, id);
    if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
