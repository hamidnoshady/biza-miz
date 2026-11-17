import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import { listPlatformAiModes, updatePlatformAiMode } from "@/lib/ai-control-plane";
import { getAiGatewayConfig, listGatewayModels } from "@/lib/ai-gateway-service";
import { AI_RUNTIME_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";

/**
 * The app-owned runtime-mode → LiteLLM-alias mapping.
 *
 * This is the whole of what the app decides about model selection: which
 * configured alias a mode requests. Provider deployments, routing, fallbacks,
 * retries and proxy-side limits stay in LiteLLM; a blank alias means the
 * platform's default chat alias.
 *
 * Writes take `ai.config.manage`, the existing platform capability for holding
 * the AI configuration. It is deliberately NOT a tenant `settings.manage`: a
 * tenant permission must never be able to change which model every business
 * runs on.
 */
export const GET = async () => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  const [modes, gateway] = await Promise.all([listPlatformAiModes(), getAiGatewayConfig()]);
  // The model catalogue is advisory UI data, never a substitute for LiteLLM's
  // runtime checks. An unavailable proxy must not break the settings page.
  const availableModelAliases = gateway.masterKey ? await listGatewayModels(gateway) : [];
  return NextResponse.json({
    modes,
    runtimeModes: AI_RUNTIME_MODES,
    defaultChatModel: gateway.chatModel,
    availableModelAliases,
  });
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

  // Accept explicit null as "clear this override"; undefined means "leave unchanged".
  // Validate malformed values instead of silently treating them as omitted.
  const temperature = body?.temperature;
  const maxOutputTokens = body?.maxOutputTokens;
  if (temperature !== undefined && temperature !== null && typeof temperature !== "number") {
    return NextResponse.json({ error: "mode_temperature_invalid" }, { status: 400 });
  }
  if (maxOutputTokens !== undefined && maxOutputTokens !== null && typeof maxOutputTokens !== "number") {
    return NextResponse.json({ error: "mode_tokens_invalid" }, { status: 400 });
  }

  const updated = await updatePlatformAiMode({
    mode,
    modelAlias: typeof body?.modelAlias === "string" ? body.modelAlias : undefined,
    isActive: typeof body?.isActive === "boolean" ? body.isActive : undefined,
    temperature: temperature as number | null | undefined,
    maxOutputTokens: maxOutputTokens as number | null | undefined,
    updatedBy: guard.session.email,
  });
  if (!updated) return NextResponse.json({ error: "mode_update_failed" }, { status: 400 });
  return NextResponse.json({ mode: updated });
};

function isRuntimeMode(value: unknown): value is AiRuntimeMode {
  return typeof value === "string" && (AI_RUNTIME_MODES as readonly string[]).includes(value);
}
