import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { getPromptVersion, isPromptScopeKey, publishedPromptFor } from "@/lib/ai-prompt-store";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import { previewSystemPrompt } from "@/lib/ai-prompt-resolver";
import { isAppKey } from "@/lib/apps";
import { randomUUID } from "node:crypto";
import { brandName } from "@/lib/brand";
import { toolDefinitions } from "@/lib/ai";
import { gatewayChatModel, runSdkTurn, sdkToolsFrom, streamSdkTurn, type SdkTurnInput, type SdkTurnResult } from "@/lib/ai-sdk-adapter";
import { PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS, platformToolsForRole, runPlatformAssistantTool } from "@/lib/ai-platform-assistant";

/**
 * Superadmin-only AI endpoint. By default it is the read-only playground: the
 * configured LiteLLM alias and published mode prompt, no tools. With
 * `tools: true` it is the platform assistant: a bounded loop over the platform
 * health tools (`ai-platform-assistant.ts`), each gated by the administrator's
 * own capability and audited. Never the tenant chat endpoint; no mutations.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;
  const { session } = guard;

  const body = (await request.json().catch(() => null)) as
    | { mode?: unknown; message?: unknown; history?: unknown; tools?: unknown; draftId?: unknown }
    | null;
  const mode = body?.mode;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (typeof mode !== "string" || !(AI_CHAT_MODES as readonly string[]).includes(mode) || !message || message.length > 3000) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Bound the in-memory Superadmin chat context. Client-provided history is
  // data only — never system/tool messages or tenant-scope grants. The server
  // controls the system prompt and decides which tools may be offered.
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

  const draftId = body?.draftId;
  if (draftId !== undefined && (
    typeof draftId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(draftId) ||
    body?.tools === true || history.length > 0
  )) {
    return NextResponse.json({ error: "invalid_draft_test" }, { status: 400 });
  }

  const [runtime, settings, basePrompt, modePrompt, draft] = await Promise.all([
    getPlatformAiMode(mode as AiRuntimeMode),
    getAiGatewayRuntimeSettings(),
    publishedPromptFor("base"),
    publishedPromptFor(`mode:${mode}`),
    typeof draftId === "string" ? getPromptVersion(draftId) : null,
  ]);

  if (draftId !== undefined && (!draft || draft.state !== "draft" || !isPromptScopeKey(draft.scopeKey) ||
    (draft.scopeKey.startsWith("mode:") && draft.scopeKey !== `mode:${mode}`) ||
    (draft.scopeKey.startsWith("app:") && !isAppKey(draft.scopeKey.slice(4))))) {
    return NextResponse.json({ error: "invalid_draft_test" }, { status: 409 });
  }
  const gateway = settings.gateway;
  if (!runtime.is_active || !gateway.enabled || !gateway.baseUrl || !gateway.masterKey) {
    return NextResponse.json({ error: "model_unavailable" }, { status: 409 });
  }
  const model = runtime.model_alias || gateway.chatModel;
  if (!model) return NextResponse.json({ error: "model_unavailable" }, { status: 409 });
  const requestId = randomUUID();
  const startedAt = performance.now();
  const composed = draft && draft.scopeKey !== "base" && !draft.scopeKey.startsWith("mode:")
    ? await previewSystemPrompt(draft.scopeKey, mode as AiRuntimeMode, draft)
    : null;
  const promptVersions = {
    base: draft?.scopeKey === "base" ? draft.version : composed?.layers.base.version ?? basePrompt?.version ?? null,
    mode: draft?.scopeKey === `mode:${mode}` ? draft.version : composed?.layers.mode.version ?? modePrompt?.version ?? null,
  };
  const diagnostics = { requestId, modelAlias: model, promptVersions, draftScope: draft?.scopeKey ?? null, draftVersion: draft?.version ?? null };
  await platformAudit({
    adminId: session.padmin, action: "ai.playground.requested", entity: "platform_ai_modes", entityId: mode,
    payload: { ...diagnostics, draftId: draft?.id ?? null },
  });

  const useTools = body?.tools === true;
  const tools = useTools ? platformToolsForRole(session.role, toolDefinitions("platform")) : [];
  const system = [
    useTools
      ? `You are the ${brandName("fa")} Superadmin platform assistant. You may call only the read-only platform health tools you are given; they never expose orders, customers or financial records, and you cannot change anything. State uncertainty plainly.`
      : `You are in the ${brandName("fa")} Superadmin read-only AI configuration playground. Do not claim to access any tenant, execute tools, or change records. State uncertainty plainly.`,
    ...(composed ? [composed.systemPrompt] : [
      (draft?.scopeKey === "base" ? draft.text : basePrompt?.text) ?? "",
      (draft?.scopeKey === `mode:${mode}` ? draft.text : modePrompt?.text) ?? "",
    ]),
  ].filter(Boolean).join("\n\n");

  const auditFailure = async (reason: string, extra: Record<string, unknown> = {}) => {
    await platformAudit({ adminId: session.padmin, action: "ai.playground.failed", entity: "platform_ai_modes", entityId: mode,
      payload: { requestId, modelAlias: model, reason, ...extra } });
    return reason;
  };

  const timeout = AbortSignal.timeout(30_000);
  const abortSignal = AbortSignal.any([request.signal, timeout]);
  const toolResults: { name: string; allowed: boolean; durationMs: number }[] = [];
  const input: SdkTurnInput = {
    model: gatewayChatModel({ baseUrl: gateway.baseUrl, apiKey: gateway.masterKey, model }),
    system,
    messages: [...history, { role: "user", content: message }],
    tools: sdkToolsFrom(tools, async (name, args) => {
      abortSignal.throwIfAborted();
      const toolStart = performance.now();
      const current = await requirePlatformCapability("ai.config.manage");
      abortSignal.throwIfAborted();
      const outcome = current.session && current.session.padmin === session.padmin && current.session.sessionId === session.sessionId
        ? await runPlatformAssistantTool(current.session.role, name, JSON.stringify(args))
        : { allowed: false, content: JSON.stringify({ error: "tool_not_permitted" }) };
      toolResults.push({ name, allowed: outcome.allowed, durationMs: Math.round(performance.now() - toolStart) });
      await platformAudit({
        adminId: session.padmin, action: outcome.allowed ? "ai.platform_tool.read" : "ai.platform_tool.denied",
        entity: "platform_ai_modes", entityId: mode, payload: { requestId, tool: name },
      });
      return outcome.content;
    }),
    maxSteps: useTools ? PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS + 1 : 1,
    temperature: runtime.temperature ?? undefined,
    maxOutputTokens: Math.min(runtime.max_output_tokens ?? 512, 1024),
    abortSignal,
  };

  async function finished(turn: SdkTurnResult) {
    const result = { ...diagnostics, durationMs: Math.round(performance.now() - startedAt),
      tokens: turn.totalTokens || null, toolsUsed: turn.toolsUsed, toolResults };
    await platformAudit({
      adminId: session.padmin, action: "ai.playground.test", entity: "platform_ai_modes", entityId: mode,
      payload: { ...result, draftId: draft?.id ?? null, costUsd: turn.costUsd, tools: turn.toolsUsed },
    });
    return result;
  }

  async function failed(error: unknown) {
    const status = (error as { statusCode?: unknown } | null)?.statusCode;
    const reason = request.signal.aborted ? "request_cancelled"
      : timeout.aborted ? "provider_timeout"
        : status === 401 || status === 403 ? "provider_auth"
          : status === 429 ? "provider_rate_limited"
            : error instanceof Error && error.message === "invalid_provider_reply" ? "invalid_provider_reply"
              : "provider_failed";
    return auditFailure(reason, typeof status === "number" ? { status } : {});
  }

  if (request.headers.get("accept")?.includes("text/event-stream")) {
    return streamSdkTurn(input, { started: diagnostics, finished, failed });
  }

  try {
    const turn = await runSdkTurn(input);
    if (!turn.text.trim()) throw new Error("invalid_provider_reply");
    return NextResponse.json({ answer: turn.text.slice(0, 16_000), mode, ...await finished(turn) });
  } catch (error) {
    return NextResponse.json({ error: await failed(error) }, { status: 502 });
  }
});
