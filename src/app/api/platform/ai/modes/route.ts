import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import { listPlatformAiModes, updatePlatformAiMode } from "@/lib/ai-control-plane";
import { AI_RUNTIME_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";

/**
 * Issue #812 §3/§7 — the three configurable LiteLLM model aliases.
 *
 * This is the whole of what the app decides about routing: which alias a mode
 * asks for. Provider deployments, fallbacks, retries, budgets and TPS/RPS stay
 * in LiteLLM, and nothing here can move them — a blank alias means "the
 * gateway's default chat model", which is what a deployment that has not set
 * aliases up yet keeps doing.
 *
 * Writes take `ai.config.manage`, the existing platform capability for holding
 * the AI configuration. It is deliberately NOT a tenant `settings.manage`: a
 * tenant permission must never be able to change which model every business
 * runs on.
 */
export const GET = async () => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  return NextResponse.json({ modes: await listPlatformAiModes(), runtimeModes: AI_RUNTIME_MODES });
};

export const PUT = async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as
    | { mode?: unknown; modelAlias?: unknown; isActive?: unknown; temperature?: unknown; maxOutputTokens?: unknown }
    | null;
  const mode = body?.mode;
  if (!isRuntimeMode(mode)) {
    return NextResponse.json({ error: "mode_unknown" }, { status: 400 });
  }

  const updated = await updatePlatformAiMode({
    mode,
    modelAlias: typeof body?.modelAlias === "string" ? body.modelAlias : undefined,
    isActive: typeof body?.isActive === "boolean" ? body.isActive : undefined,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    maxOutputTokens: typeof body?.maxOutputTokens === "number" ? body.maxOutputTokens : undefined,
    updatedBy: guard.session.email,
  });
  if (!updated) return NextResponse.json({ error: "mode_update_failed" }, { status: 400 });
  return NextResponse.json({ mode: updated });
};

function isRuntimeMode(value: unknown): value is AiRuntimeMode {
  return typeof value === "string" && (AI_RUNTIME_MODES as readonly string[]).includes(value);
}
