import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, platformAudit } from "@/lib/platform-auth";
import {
  PROMPT_SCOPES,
  isPromptScopeKey,
  listPromptVersions,
  publishPromptVersion,
  retirePromptVersion,
  rollbackPromptVersion,
  savePromptDraft,
} from "@/lib/ai-prompt-store";
import { resolveSystemPrompt } from "@/lib/ai-prompt-resolver";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import type { AppKey } from "@/lib/apps";

/**
 * Issue #812 §8 — the Superadmin prompt console.
 *
 * Every write is a draft until it is published, and publishing retires whatever
 * was live for that scope in the same transaction. The runtime therefore never
 * sees a half-edited prompt, and a scope with nothing published resolves to the
 * code default rather than to nothing.
 */
export const GET = async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  const params = request.nextUrl.searchParams;
  const previewScope = params.get("previewScope");
  if (previewScope !== null) {
    const [kind, key] = previewScope.split(":");
    if (!isPromptScopeKey(previewScope) || (kind === "app" && !PROMPT_SCOPES.some((scope) => scope.key === previewScope))) {
      return NextResponse.json({ error: "prompt_scope_unknown" }, { status: 400 });
    }
    const mode = kind === "mode" ? key : params.get("mode") ?? "auto";
    if (!(AI_CHAT_MODES as readonly string[]).includes(mode)) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const resolved = await resolveSystemPrompt({
      mode: "dashboard",
      businessId: "",
      runtimeMode: mode as AiRuntimeMode,
      loadMemory: false,
      appKey: kind === "app" ? key as AppKey : null,
      businessType: kind === "business_type" ? key : null,
      agentKey: kind === "agent" ? key : null,
    });
    return NextResponse.json(resolved, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    scopes: PROMPT_SCOPES,
    versions: await listPromptVersions(),
  });
};

export const POST = async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; scopeKey?: unknown; text?: unknown; notes?: unknown; id?: unknown; targetVersion?: unknown; editDraftId?: unknown; expectedPublishedId?: unknown }
    | null;
  const action = body?.action;
  const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const expected = body?.expectedPublishedId;
  if (expected !== undefined && expected !== null && !isId(expected)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const adminId = guard.session.padmin;
  const audit = (event: string, id: string, scopeKey?: string) => platformAudit({
    adminId,
    action: `ai.prompt.${event}`,
    entity: "ai_prompt_versions",
    entityId: id,
    payload: { scopeKey },
  });

  if (action === "draft") {
    if (!isPromptScopeKey(body?.scopeKey)) {
      return NextResponse.json({ error: "prompt_scope_unknown" }, { status: 400 });
    }
    if (body.editDraftId !== undefined && !isId(body.editDraftId)) {
      return NextResponse.json({ error: "id_required" }, { status: 400 });
    }
    const saved = await savePromptDraft({
      scopeKey: body.scopeKey,
      text: typeof body.text === "string" ? body.text : "",
      notes: typeof body.notes === "string" ? body.notes : "",
      createdBy: guard.session.email,
      editDraftId: body.editDraftId,
    });
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    await audit(body.editDraftId ? "edited" : "drafted", saved.version.id, saved.version.scopeKey);
    return NextResponse.json({ version: saved.version }, { status: 201 });
  }

  if (action === "publish") {
    if (!isId(body?.id)) return NextResponse.json({ error: "id_required" }, { status: 400 });
    const published = await publishPromptVersion({ id: body.id, publishedBy: guard.session.email, expectedPublishedId: expected });
    if (!published.ok) return NextResponse.json({ error: published.error }, { status: 409 });
    await audit("published", published.published.id, published.published.scopeKey);
    return NextResponse.json({ version: published.published, retired: published.retired });
  }

  if (action === "rollback") {
    if (!isPromptScopeKey(body?.scopeKey) || typeof body?.targetVersion !== "number" || !Number.isSafeInteger(body.targetVersion) || body.targetVersion <= 0) {
      return NextResponse.json({ error: "rollback_target_invalid" }, { status: 400 });
    }
    const rolled = await rollbackPromptVersion({
      scopeKey: body.scopeKey,
      targetVersion: body.targetVersion,
      publishedBy: guard.session.email,
      expectedPublishedId: expected,
    });
    if (!rolled.ok) return NextResponse.json({ error: rolled.error }, { status: 409 });
    await audit("rolled_back", rolled.published.id, rolled.published.scopeKey);
    return NextResponse.json({ version: rolled.published, retired: rolled.retired });
  }

  if (action === "retire") {
    if (!isId(body?.id)) return NextResponse.json({ error: "id_required" }, { status: 400 });
    const retired = await retirePromptVersion(body.id);
    if (!retired) return NextResponse.json({ error: "prompt_not_a_draft" }, { status: 409 });
    await audit("retired", body.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action_unknown" }, { status: 400 });
};
