import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import {
  createAgentAssignment,
  createSystemAgent,
  listAgentAssignments,
  listSystemAgents,
  publishSystemAgent,
  retireSystemAgent,
  updateSystemAgent,
  validateAgentInput,
  type AgentSuggestionCard,
} from "@/lib/ai-system-agents";

/**
 * Issue #812 §9 — the Superadmin system-agent console.
 *
 * This is the only place an agent may be built or versioned. There is no
 * tenant-side agent builder any more, so a business meets an agent exclusively
 * through an assignment made here, and an assignment's requirements are
 * re-checked on every read (`eligibleAgentCards`), so a revoked permission or
 * a disabled app takes a card away immediately.
 *
 * Writes take `ai.config.manage` — the same capability the prompt and mode
 * writes take, because all three change what every business's assistant does.
 */
export const GET = async () => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  const agents = await listSystemAgents();
  const assignments = await listAgentAssignments();
  return NextResponse.json({ agents, assignments });
};

export const POST = async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as
    | { action?: unknown } & Record<string, unknown>
    | null;
  const action = body?.action;

  if (action === "create") {
    const input = {
      agentKey: String(body?.agentKey ?? ""),
      name: String(body?.name ?? ""),
      description: typeof body?.description === "string" ? body.description : "",
      icon: typeof body?.icon === "string" ? body.icon : "",
      instructions: typeof body?.instructions === "string" ? body.instructions : "",
      relevantApps: asStringArray(body?.relevantApps),
      businessTypes: asStringArray(body?.businessTypes),
      requiredFeatures: asStringArray(body?.requiredFeatures),
      requiredPermissions: asStringArray(body?.requiredPermissions),
      allowedTools: asStringArray(body?.allowedTools),
      allowedActions: asStringArray(body?.allowedActions),
      allowedModes: asStringArray(body?.allowedModes) as ("auto" | "instant" | "deep_research")[],
      defaultMode: (typeof body?.defaultMode === "string" ? body.defaultMode : null) as
        | "auto"
        | "instant"
        | "deep_research"
        | null,
      suggestionCards: Array.isArray(body?.suggestionCards)
        ? (body.suggestionCards as AgentSuggestionCard[])
        : [],
      memoryScopes: asStringArray(body?.memoryScopes),
      confirmationPolicy:
        body?.confirmationPolicy && typeof body.confirmationPolicy === "object"
          ? (body.confirmationPolicy as Record<string, unknown>)
          : {},
      createdBy: guard.session.email,
    };
    const invalid = validateAgentInput(input);
    if (invalid) return NextResponse.json({ error: "agent_invalid", message: invalid }, { status: 400 });
    const agent = await createSystemAgent(input);
    return NextResponse.json({ agent }, { status: 201 });
  }

  if (action === "update") {
    if (typeof body?.id !== "string") return NextResponse.json({ error: "id_required" }, { status: 400 });
    const agent = await updateSystemAgent({
      id: body.id,
      patch: {
        name: typeof body?.name === "string" ? body.name : undefined,
        description: typeof body?.description === "string" ? body.description : undefined,
        icon: typeof body?.icon === "string" ? body.icon : undefined,
        instructions: typeof body?.instructions === "string" ? body.instructions : undefined,
        relevantApps: body?.relevantApps ? asStringArray(body.relevantApps) : undefined,
        businessTypes: body?.businessTypes ? asStringArray(body.businessTypes) : undefined,
        requiredFeatures: body?.requiredFeatures ? asStringArray(body.requiredFeatures) : undefined,
        requiredPermissions: body?.requiredPermissions ? asStringArray(body.requiredPermissions) : undefined,
        allowedTools: body?.allowedTools ? asStringArray(body.allowedTools) : undefined,
        allowedActions: body?.allowedActions ? asStringArray(body.allowedActions) : undefined,
        allowedModes: body?.allowedModes
          ? (asStringArray(body.allowedModes) as ("auto" | "instant" | "deep_research")[])
          : undefined,
        defaultMode: (typeof body?.defaultMode === "string" ? body.defaultMode : undefined) as
          | "auto"
          | "instant"
          | "deep_research"
          | undefined,
        suggestionCards: Array.isArray(body?.suggestionCards)
          ? (body.suggestionCards as AgentSuggestionCard[])
          : undefined,
        memoryScopes: body?.memoryScopes ? asStringArray(body.memoryScopes) : undefined,
        confirmationPolicy:
          body?.confirmationPolicy && typeof body.confirmationPolicy === "object"
            ? (body.confirmationPolicy as Record<string, unknown>)
            : undefined,
      },
      updatedBy: guard.session.email,
    });
    if (!agent) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    return NextResponse.json({ agent });
  }

  if (action === "publish") {
    if (typeof body?.id !== "string") return NextResponse.json({ error: "id_required" }, { status: 400 });
    const agent = await publishSystemAgent({ id: body.id, publishedBy: guard.session.email });
    if (!agent) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    return NextResponse.json({ agent });
  }

  if (action === "retire") {
    if (typeof body?.id !== "string") return NextResponse.json({ error: "id_required" }, { status: 400 });
    const agent = await retireSystemAgent(body.id, guard.session.email);
    if (!agent) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    return NextResponse.json({ agent });
  }

  if (action === "assign") {
    const assignment = await createAgentAssignment({
      agentId: String(body?.agentId ?? ""),
      businessId: typeof body?.businessId === "string" ? body.businessId : null,
      businessType: typeof body?.businessType === "string" ? body.businessType : null,
      prompt: String(body?.prompt ?? ""),
      appFocus: typeof body?.appFocus === "string" ? body.appFocus : "all",
      requiredPermissions: asStringArray(body?.requiredPermissions),
      requiredApps: asStringArray(body?.requiredApps),
      requiredFeatures: asStringArray(body?.requiredFeatures),
      preferredMode: (typeof body?.preferredMode === "string" ? body.preferredMode : null) as
        | "auto"
        | "instant"
        | "deep_research"
        | null,
      createdBy: guard.session.email,
    });
    return NextResponse.json({ assignment }, { status: 201 });
  }

  if (action === "assignment-enabled") {
    if (typeof body?.id !== "string" || typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "assignment_invalid" }, { status: 400 });
    }
    const { setAgentAssignmentEnabled } = await import("@/lib/ai-system-agents");
    const assignment = await setAgentAssignmentEnabled({ id: body.id, enabled: body.enabled });
    if (!assignment) return NextResponse.json({ error: "assignment_not_found" }, { status: 404 });
    return NextResponse.json({ assignment });
  }

  return NextResponse.json({ error: "action_unknown" }, { status: 400 });
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
