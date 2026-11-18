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

/** A streamed test turn is bounded in time as well as in tool rounds. */
const PLAYGROUND_TURN_TIMEOUT_MS = 60_000;
/** An explicit tool grant names tools; it never becomes an unbounded list. */
const MAX_AUTHORIZED_TOOLS = 8;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Superadmin-only AI endpoint. By default it is the read-only playground: the
 * configured LiteLLM alias and published mode prompt, no tools. With an
 * explicit `tools` grant it is the platform assistant: a bounded loop over the
 * platform health tools (`ai-platform-assistant.ts`), each gated by the
 * administrator's own capability and audited. Never the tenant chat endpoint;
 * no mutations.
 *
 * ESH-184 — the answer is relayed as SSE (`start`, `delta`, `done`, `error`)
 * while the model runs, so the playground never waits for a complete response.
 * Cancellation aborts the LiteLLM request instead of leaving it running.
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

  // Tools are opt-in per request and narrowed twice: first to what this
  // administrator's role may call, then to the explicit grant the client sent.
  // `tools: true` means "all tools my role already authorises"; a string array
  // names an exact subset. Anything else — especially a name this role cannot
  // call — is refused before provider usage is incurred.
  const roleTools = platformToolsForRole(session.role, toolDefinitions("platform"));
  let tools = roleTools;
  if (body?.tools === undefined || body?.tools === false) {
    tools = [];
  } else if (body.tools !== true) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_AUTHORIZED_TOOLS ||
      body.tools.some((name) => typeof name !== "string" || !name)) {
      return NextResponse.json({ error: "invalid_tools" }, { status: 400 });
    }
    const granted = new Set(body.tools as string[]);
    const offered = new Set(roleTools.map((tool) => tool.function.name));
    const refused = [...granted].filter((name) => !offered.has(name));
    if (refused.length > 0) {
      for (const name of refused) {
        await platformAudit({
          adminId: session.padmin, action: "ai.platform_tool.denied",
          entity: "platform_ai_modes", entityId: mode,
          payload: { requestId, tool: name, reason: "not_authorized_for_role" },
        });
      }
      return NextResponse.json({ error: "tool_not_permitted" }, { status: 403 });
    }
    tools = roleTools.filter((tool) => granted.has(tool.function.name));
  }
  const authorizedToolNames = new Set(tools.map((tool) => tool.function.name));

  await platformAudit({
    adminId: session.padmin, action: "ai.playground.requested", entity: "platform_ai_modes", entityId: mode,
    payload: {
      requestId,
      modelAlias: model,
      promptVersions: { base: basePrompt?.version ?? null, mode: modePrompt?.version ?? null },
      authorizedTools: [...authorizedToolNames],
    },
  });

  const system = [
    tools.length > 0
      ? `You are the ${brandName("fa")} Superadmin platform assistant. You may call only the read-only platform health tools you are given; they never expose orders, customers or financial records, and you cannot change anything. State uncertainty plainly.`
      : `You are in the ${brandName("fa")} Superadmin read-only AI configuration playground. Do not claim to access any tenant, execute tools, or change records. State uncertainty plainly.`,
    basePrompt?.text ?? "",
    modePrompt?.text ?? "",
  ].filter(Boolean).join("\n\n");

  const promptVersions = { base: basePrompt?.version ?? null, mode: modePrompt?.version ?? null };
  const startedAt = Date.now();

  // A stream the browser cancels must stop the upstream LiteLLM call as well.
  // This controller is reachable from `cancel()` below, which the request
  // signal alone is not once the response body has started.
  const cancelController = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timedOut = false;
      const emit = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sse(event, data));
        } catch {
          // The client went away between the check and the enqueue.
          closed = true;
        }
      };
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, PLAYGROUND_TURN_TIMEOUT_MS);

      const auditFailure = async (reason: string, extra: Record<string, unknown> = {}) => {
        try {
          await platformAudit({
            adminId: session.padmin, action: "ai.playground.failed", entity: "platform_ai_modes", entityId: mode,
            payload: { requestId, modelAlias: model, reason, ...extra },
          });
        } catch {
          // Auditing is best-effort on the failure path; the client still gets
          // the error event that explains what happened.
        }
      };

      emit("start", {
        requestId,
        mode,
        modelAlias: model,
        promptVersions,
        tools: [...authorizedToolNames],
        startedAt,
      });

      void (async () => {
        let answer = "";
        try {
          const turn = await runSdkTurn({
            model: gatewayChatModel({ baseUrl: gateway.baseUrl, apiKey: gateway.masterKey, model }),
            system,
            messages: [...history, { role: "user", content: message }],
            tools: sdkToolsFrom(tools, async (name, args) => {
              // The tool set was already narrowed, but re-check the explicit
              // grant here too: execution is the boundary that matters.
              if (!authorizedToolNames.has(name)) {
                await platformAudit({
                  adminId: session.padmin, action: "ai.platform_tool.denied",
                  entity: "platform_ai_modes", entityId: mode, payload: { requestId, tool: name, reason: "not_authorized" },
                });
                return JSON.stringify({ error: "tool_not_permitted" });
              }
              const outcome = await runPlatformAssistantTool(session.role, name, JSON.stringify(args));
              await platformAudit({
                adminId: session.padmin, action: outcome.allowed ? "ai.platform_tool.read" : "ai.platform_tool.denied",
                entity: "platform_ai_modes", entityId: mode, payload: { requestId, tool: name },
              });
              emit("tool", { name, allowed: outcome.allowed });
              return outcome.content;
            }),
            maxSteps: PLATFORM_ASSISTANT_MAX_TOOL_ROUNDS + 1,
            temperature: runtime.temperature ?? undefined,
            maxOutputTokens: Math.min(runtime.max_output_tokens ?? 512, 1024),
            abortSignal: AbortSignal.any([request.signal, timeoutController.signal, cancelController.signal]),
          }, {
            onDelta: (text) => {
              answer += text;
              emit("delta", { content: text });
            },
          });

          if (request.signal.aborted || cancelController.signal.aborted || timedOut) {
            // The browser stopped the turn (or the turn hit its ceiling) after
            // the last delta. It is not a completed test, so it must not be
            // audited as one.
            await auditFailure(timedOut ? "timeout" : "cancelled", { partialChars: answer.length });
            if (timedOut) {
              emit("error", { error: "timeout", requestId, message: "پاسخ در زمان مجاز کامل نشد." });
            }
            return;
          }

          if (!turn.text.trim()) {
            await auditFailure("invalid_provider_reply");
            emit("error", { error: "invalid_provider_reply", requestId });
            return;
          }

          const diagnostics = {
            requestId,
            modelAlias: model,
            promptVersions,
            tokens: turn.totalTokens || null,
            costUsd: turn.costUsd,
            toolsUsed: turn.toolsUsed,
            latencyMs: Date.now() - startedAt,
            finishReason: turn.finishReason,
          };
          await platformAudit({
            adminId: session.padmin,
            action: "ai.playground.test",
            entity: "platform_ai_modes",
            entityId: mode,
            payload: { ...diagnostics, tools: turn.toolsUsed },
          });
          emit("done", { answer: turn.text.slice(0, 16_000), content: turn.text.slice(0, 16_000), ...diagnostics });
        } catch (error) {
          const aborted = request.signal.aborted || cancelController.signal.aborted ||
            (error instanceof Error && error.name === "AbortError");
          if (aborted) {
            // A client cancellation is not a provider failure. The client keeps
            // whatever partial text it already rendered and labels it cancelled.
            await auditFailure(timedOut ? "timeout" : "cancelled", { partialChars: answer.length });
            emit("error", {
              error: timedOut ? "timeout" : "cancelled",
              requestId,
              message: timedOut ? "پاسخ در زمان مجاز کامل نشد." : "درخواست لغو شد.",
            });
            return;
          }
          const status = (error as { statusCode?: unknown })?.statusCode;
          await auditFailure(typeof status === "number" ? "provider_failed" : "provider_unreachable",
            typeof status === "number" ? { status } : {});
          emit("error", {
            error: typeof status === "number" ? "provider_failed" : "provider_unreachable",
            requestId,
            message: "پاسخ مدل دریافت نشد.",
          });
        } finally {
          clearTimeout(timeout);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // Already cancelled by the browser.
            }
          }
        }
      })();
    },
    cancel() {
      // The request signal is wired to the provider by `runSdkTurn`; aborting
      // here is what makes a closed browser tab stop the LiteLLM call too.
      cancelController.abort();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": requestId,
    },
  });
});
