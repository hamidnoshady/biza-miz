import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { publishedPromptFor } from "@/lib/ai-prompt-store";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import { randomUUID } from "node:crypto";
import { brandName } from "@/lib/brand";
import { toolDefinitions } from "@/lib/ai";
import { gatewayChatModel, runSdkTurn, sdkToolsFrom } from "@/lib/ai-sdk-adapter";
import { PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS, platformToolsForRole, runPlatformAssistantTool } from "@/lib/ai-platform-assistant";

/**
 * Superadmin-only AI endpoint. By default it is the read-only playground: the
 * configured LiteLLM alias and published mode prompt, no tools. With
 * `tools: true` it is the platform assistant: a bounded loop over the platform
 * health tools (`ai-platform-assistant.ts`), each gated by the administrator's
 * own capability and audited. Never the tenant chat endpoint; no mutations.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  const body = (await request.json().catch(() => null)) as
    | { mode?: unknown; message?: unknown; history?: unknown; tools?: unknown }
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
  const requestId = randomUUID();
  await platformAudit({
    adminId: session.padmin, action: "ai.playground.requested", entity: "platform_ai_modes", entityId: mode,
    payload: { requestId, modelAlias: model, promptVersions: { base: basePrompt?.version ?? null, mode: modePrompt?.version ?? null } },
  });

  const useTools = body?.tools === true;
  const tools = useTools ? platformToolsForRole(session.role, toolDefinitions("platform")) : [];
  const system = [
    useTools
      ? `You are the ${brandName("fa")} Superadmin platform assistant. You may call only the read-only platform health tools you are given; they never expose orders, customers or financial records, and you cannot change anything. State uncertainty plainly.`
      : `You are in the ${brandName("fa")} Superadmin read-only AI configuration playground. Do not claim to access any tenant, execute tools, or change records. State uncertainty plainly.`,
    basePrompt?.text ?? "",
    modePrompt?.text ?? "",
  ].filter(Boolean).join("\n\n");

  const failed = async (reason: string, status: number, extra: Record<string, unknown> = {}) => {
    await platformAudit({ adminId: session.padmin, action: "ai.playground.failed", entity: "platform_ai_modes", entityId: mode,
      payload: { requestId, modelAlias: model, reason, ...extra } });
    return NextResponse.json({ error: reason }, { status });
  };

  // The Vercel AI SDK drives the step loop; LiteLLM stays the gateway behind it
  // (`ai-sdk-adapter.ts`). The last allowed step offers no tools to the SDK's
  // stop condition, so a turn always ends in an answer or a visible failure.
  let turn;
  try {
    turn = await runSdkTurn({
      model: gatewayChatModel({ baseUrl: gateway.baseUrl, apiKey: gateway.masterKey, model }),
      system,
      messages: [...history, { role: "user", content: message }],
      tools: sdkToolsFrom(tools, async (name, args) => {
        const outcome = await runPlatformAssistantTool(session.role, name, JSON.stringify(args));
        await platformAudit({
          adminId: session.padmin, action: outcome.allowed ? "ai.platform_tool.read" : "ai.platform_tool.denied",
          entity: "platform_ai_modes", entityId: mode, payload: { requestId, tool: name },
        });
        return outcome.content;
      }),
      maxSteps: PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS + 1,
      temperature: runtime.temperature ?? undefined,
      maxOutputTokens: Math.min(runtime.max_output_tokens ?? 512, 1024),
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    const status = (error as { statusCode?: unknown })?.statusCode;
    return failed(typeof status === "number" ? "provider_failed" : "provider_unreachable", 502,
      typeof status === "number" ? { status } : {});
  }
  if (!turn.text.trim()) return failed("invalid_provider_reply", 502);
  await platformAudit({
    adminId: session.padmin,
    action: "ai.playground.test",
    entity: "platform_ai_modes",
    entityId: mode,
    payload: { requestId, modelAlias: model, tokens: turn.totalTokens || null, costUsd: turn.costUsd, tools: turn.toolsUsed },
  });
  return NextResponse.json({
    answer: turn.text.slice(0, 16_000),
    mode,
    modelAlias: model,
    promptVersions: { base: basePrompt?.version ?? null, mode: modePrompt?.version ?? null },
    toolsUsed: turn.toolsUsed,
  });
});
