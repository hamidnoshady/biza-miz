import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import {
  customAgentErrorMessage,
  selectableAgentActions,
  selectableAgentTools,
  type CustomAgentInput,
} from "@/lib/ai-custom-agents";
import { createCustomAgent, listCustomAgents } from "@/lib/ai-custom-agents-service";

/**
 * Custom AI agents — a business's own lenses over the dashboard assistant.
 *
 * A manager may list and create them; the GET also returns the selectable tool
 * and action names so the editor can render checkboxes from the live catalogue
 * rather than a hard-coded copy that could drift.
 */
export const GET = withTenantScope(async () => {
  const guard = await requireManager(PERMISSIONS.aiAgentsManage);
  if (guard.error) return guard.error;
  return NextResponse.json({
    agents: await listCustomAgents(guard.session.businessId),
    selectableTools: selectableAgentTools(),
    selectableActions: selectableAgentActions(),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager(PERMISSIONS.aiAgentsManage);
  if (guard.error) return guard.error;

  let body: CustomAgentInput;
  try {
    body = (await request.json()) as CustomAgentInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const created = await createCustomAgent(guard.session.businessId, body, guard.session.sub);
  if (!created.ok) {
    return NextResponse.json(
      {
        error: created.errors[0],
        errors: created.errors,
        messages: created.errors.map(customAgentErrorMessage),
      },
      { status: 400 },
    );
  }
  return NextResponse.json({ agent: created.agent }, { status: 201 });
});
