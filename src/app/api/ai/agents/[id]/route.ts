import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { customAgentErrorMessage, type CustomAgentInput } from "@/lib/ai-custom-agents";
import {
  deleteCustomAgent,
  getCustomAgent,
  updateCustomAgent,
} from "@/lib/ai-custom-agents-service";

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAgentsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const agent = await getCustomAgent(guard.session.businessId, id);
    if (!agent) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ agent });
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAgentsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;

    let body: CustomAgentInput;
    try {
      body = (await request.json()) as CustomAgentInput;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const updated = await updateCustomAgent(guard.session.businessId, id, body);
    if (!updated.ok) {
      const status = updated.errors.includes("not_found") ? 404 : 400;
      return NextResponse.json(
        {
          error: updated.errors[0],
          errors: updated.errors,
          messages: updated.errors.map(customAgentErrorMessage),
        },
        { status },
      );
    }
    return NextResponse.json({ agent: updated.agent });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireManager(PERMISSIONS.aiAgentsManage);
    if (guard.error) return guard.error;
    const { id } = await context.params;
    const removed = await deleteCustomAgent(guard.session.businessId, id);
    if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
