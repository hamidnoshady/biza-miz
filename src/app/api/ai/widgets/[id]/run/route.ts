import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAiWidget, markAiWidgetRun } from "@/lib/ai-widgets";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { isPlatformAiConfigured } from "@/lib/ai-config";
import { gateAiTurn, newAiRequestId, settleAiTurn, AiWalletInsufficientError } from "@/lib/ai-wallet-billing";
import { buildSystemPrompt, type PromptContext } from "@/lib/ai";
import { runAgentTurn } from "@/lib/ai-service";
import { retrievalReadyForMode } from "@/lib/ai-service";

export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const { id } = await context.params;
  const widget = await getAiWidget(guard.session.businessId, guard.session.sub, id);
  if (!widget) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const locationId = guard.session.locationId ?? null;
  const config = await resolveAiConfigFor(guard.session.businessId, locationId, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) return NextResponse.json({ error: "ai_unavailable" }, { status: 503 });
  try {
    await gateAiTurn(guard.session.businessId, config);
  } catch (error) {
    if (error instanceof AiWalletInsufficientError) return NextResponse.json({ error: "ai_credit_required" }, { status: 402 });
    throw error;
  }

  // A widget's required permissions are an upper bound selected at creation;
  // intersect them with the member's current effective set on every run.
  const permissions = widget.requiredPermissions.length === 0
    ? guard.membership.permissions
    : new Set([...guard.membership.permissions].filter((permission) => widget.requiredPermissions.includes(permission)));
  const promptContext: PromptContext = {
    mode: "dashboard",
    userName: guard.session.fullName,
    role: guard.session.role,
  };
  const systemPrompt = `${buildSystemPrompt({
    ...promptContext,
    retrieval: await retrievalReadyForMode(config, "dashboard", guard.session.businessId),
  })}\n\nاین نوبت از ویجت «${widget.name}» اجرا می‌شود. فقط دادهٔ مجاز را بخوان و پاسخ را در قالب ${widget.outputFormat} بده.`;
  const requestId = newAiRequestId();
  try {
    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      businessId: guard.session.businessId,
      actorUserId: guard.session.sub,
      permissions,
      systemPrompt,
      promptContext,
      messages: [{ role: "user", content: widget.prompt }],
      allowActions: false,
      requestId,
    });
    const settlement = await settleAiTurn({
      businessId: guard.session.businessId,
      requestId,
      config,
      usage: reply.usage,
      costUsd: reply.costUsd,
      attribution: {
        requestType: "chat",
        model: config.model,
        conversationId: null,
        locationId,
        userId: guard.session.sub,
        metadata: { mode: "widget", widgetId: widget.id, sourceApp: widget.sourceApp },
      },
    });
    await markAiWidgetRun(guard.session.businessId, guard.session.sub, widget.id);
    return NextResponse.json({ content: reply.content, costRial: settlement.chargedRial, widgetId: widget.id });
  } catch (error) {
    console.error("ai widget run failed", { requestId, widgetId: widget.id, error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "ai_unknown", message: "اجرای ویجت ممکن نشد." }, { status: 502 });
  }
});
