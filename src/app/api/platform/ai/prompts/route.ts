import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import {
  PROMPT_SCOPES,
  isPromptScopeKey,
  listPromptVersions,
  publishPromptVersion,
  retirePromptVersion,
  rollbackPromptVersion,
  savePromptDraft,
} from "@/lib/ai-prompt-store";

/**
 * Issue #812 §8 — the Superadmin prompt console.
 *
 * Every write is a draft until it is published, and publishing retires whatever
 * was live for that scope in the same transaction. The runtime therefore never
 * sees a half-edited prompt, and a scope with nothing published resolves to the
 * code default rather than to nothing.
 */
export const GET = async () => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  return NextResponse.json({
    scopes: PROMPT_SCOPES,
    versions: await listPromptVersions(),
  });
};

export const POST = async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; scopeKey?: unknown; text?: unknown; notes?: unknown; id?: unknown; targetVersion?: unknown }
    | null;
  const action = body?.action;

  if (action === "draft") {
    if (!isPromptScopeKey(body?.scopeKey)) {
      return NextResponse.json({ error: "prompt_scope_unknown" }, { status: 400 });
    }
    const saved = await savePromptDraft({
      scopeKey: body.scopeKey,
      text: typeof body.text === "string" ? body.text : "",
      notes: typeof body.notes === "string" ? body.notes : "",
      createdBy: guard.session.email,
    });
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    return NextResponse.json({ version: saved.version }, { status: 201 });
  }

  if (action === "publish") {
    if (typeof body?.id !== "string") return NextResponse.json({ error: "id_required" }, { status: 400 });
    const published = await publishPromptVersion({ id: body.id, publishedBy: guard.session.email });
    if (!published.ok) return NextResponse.json({ error: published.error }, { status: 409 });
    return NextResponse.json({ version: published.published, retired: published.retired });
  }

  if (action === "rollback") {
    if (!isPromptScopeKey(body?.scopeKey) || typeof body?.targetVersion !== "number") {
      return NextResponse.json({ error: "rollback_target_invalid" }, { status: 400 });
    }
    const rolled = await rollbackPromptVersion({
      scopeKey: body.scopeKey,
      targetVersion: body.targetVersion,
      publishedBy: guard.session.email,
    });
    if (!rolled.ok) return NextResponse.json({ error: rolled.error }, { status: 409 });
    return NextResponse.json({ version: rolled.published, retired: rolled.retired });
  }

  if (action === "retire") {
    if (typeof body?.id !== "string") return NextResponse.json({ error: "id_required" }, { status: 400 });
    const retired = await retirePromptVersion(body.id);
    if (!retired) return NextResponse.json({ error: "prompt_not_a_draft" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action_unknown" }, { status: 400 });
};
