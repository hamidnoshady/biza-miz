import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
import { chatCompletionsUrl } from "@/lib/ai";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { publishedPromptFor } from "@/lib/ai-prompt-store";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";

/**
 * Superadmin-only read-only AI playground. Tests the actual configured
 * LiteLLM alias and published mode prompt without tenant data or action tools.
 * This is NOT the tenant chat endpoint and cannot make business mutations.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  const body = (await request.json().catch(() => null)) as
    | { mode?: unknown; message?: unknown; history?: unknown }
    | null;
  const mode = body?.mode;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (typeof mode !== "string" || !(AI_CHAT_MODES as readonly string[]).includes(mode) || !message || message.length > 3000) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Bound the in-memory Superadmin chat context. Client-provided history is
  // data only — never system/tool messages or tenant-scope grants. The server
  // controls the system prompt and offers NO tools or function calls.
  const rawHistory = body?.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > 12) {
    return NextResponse.json({ error: "invalid_history" }, { status: 400 });
  }
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let historyChars = 0;
  for (const turn of rawHistory) {
    if (!turn || typeof turn !== "object") return NextResponse.json({ error: "invalid_history" }, { status: 400 });
    const row = turn as Record<string, unknown>;
    if ((row.role !== "user" && row.role !== "assistant") ||
      typeof row.content !== "string" || !row.content.trim() || row.content.length > 4000) {
      return NextResponse.json({ error: "invalid_history" }, { status: 400 });
    }
    historyChars += row.content.length;
    if (historyChars > 16000) return NextResponse.json({ error: "history_too_long" }, { status: 413 });
    history.push({ role: row.role, content: row.content.trim() });
  }

  const [runtime, settings, basePrompt, modePrompt] = await Promise.all([
    getPlatformAiMode(mode as AiRuntimeMode),
    getAiGatewayRuntimeSettings(),
    publishedPromptFor("base"),
    publishedPromptFor(`mode:${mode}`),
  ]);

  const gateway = settings.gateway;
  if (!runtime.is_active || !gateway.enabled || !gateway.baseUrl || !gateway.masterKey) {
    return NextResponse.json({ error: "model_unavailable" }, { status: 409 });
  }
  const model = runtime.model_alias || gateway.chatModel;
  if (!model) return NextResponse.json({ error: "model_unavailable" }, { status: 409 });

  let providerResponse: Response;
  try {
    providerResponse = await fetch(chatCompletionsUrl(gateway.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.masterKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: runtime.temperature ?? undefined,
        max_tokens: Math.min(runtime.max_output_tokens ?? 512, 1024),
        messages: [
          {
            role: "system",
            content: [
              "You are in the بیزا میز Superadmin read-only AI configuration playground. Do not claim to access any tenant, execute tools, or change records. State uncertainty plainly.",
              basePrompt?.text ?? "",
              modePrompt?.text ?? "",
            ].filter(Boolean).join("\n\n"),
          },
          ...history,
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "provider_unreachable" }, { status: 502 });
  }
  if (!providerResponse.ok) {
    return NextResponse.json({ error: "provider_failed" }, { status: 502 });
  }
  const reply = await providerResponse.json().catch(() => null) as
    | { choices?: Array<{ message?: { content?: unknown } }>; usage?: { total_tokens?: unknown } }
    | null;
  const answer = reply?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) {
    return NextResponse.json({ error: "invalid_provider_reply" }, { status: 502 });
  }
  await platformAudit({
    adminId: session.padmin,
    action: "ai.playground.test",
    entity: "platform_ai_modes",
    entityId: mode,
    payload: { modelAlias: model, tokens: Number(reply?.usage?.total_tokens ?? 0) },
  });
  return NextResponse.json({
    answer: answer.slice(0, 16_000),
    mode,
    modelAlias: model,
    promptVersions: { base: basePrompt?.version ?? null, mode: modePrompt?.version ?? null },
  });
});
