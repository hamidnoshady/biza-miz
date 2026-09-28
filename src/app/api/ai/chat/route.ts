import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { ACTION_CATALOG, buildSystemPrompt, type AgentMode, type PromptContext } from "@/lib/ai";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { createAiActionAudit } from "@/lib/ai-action-audit";
import {
  appendMessage,
  getConversationProjectId,
  getOrCreateConversation,
} from "@/lib/ai-conversations";
import { buildProjectPromptContext, getProject, getProjectPromptContext } from "@/lib/ai-projects";
import { persistChatImageAttachments } from "@/lib/ai-media-persist";
import { createInputRequest } from "@/lib/ai-input-requests-service";
import {
  parseChatAttachments,
  prepareAttachments,
  withAttachmentContext,
} from "@/lib/ai-attachment";
import { taskDirectiveFor } from "@/lib/ai-tasks";
import { agentTurnScope, type AgentTurnScope } from "@/lib/ai-custom-agents";
import { getCustomAgent } from "@/lib/ai-custom-agents-service";
import {
  AiError,
  retrievalReadyForMode,
  runAgentTurn,
  type InboundMessage,
} from "@/lib/ai-service";
import {
  buildToolSignature,
  isCacheableTurn,
  lookupCachedAnswer,
  normalizeRangeDate,
  storeCachedAnswer,
  type CacheHit,
} from "@/lib/ai-answer-cache";
import { embedOne, isEmbeddingAvailable } from "@/lib/ai-embeddings";
import { toolDefinitions } from "@/lib/ai";
import { businessToday } from "@/lib/business-day-service";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { requireFloorAssistant, withTenantScope } from "@/lib/auth";
import { providerErrorReason } from "@/lib/ai-provider-errors";
import { PERMISSIONS } from "@/lib/permissions";
import {
  AI_MODE_DIRECTIVES,
  isAiReasoningMode,
  isAiReasoningModeAvailable,
  type AiReasoningMode,
} from "@/lib/ai-reasoning";

const MAX_MESSAGES = 24;
const MAX_CONTENT = 8_000;

function sanitizeMessages(raw: unknown): InboundMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: InboundMessage[] = [];
  for (const message of raw.slice(-MAX_MESSAGES)) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.slice(0, MAX_CONTENT) });
    }
  }
  return out;
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Metered assistant turn. Validation and the maximum credit reservation happen
 * before the response starts; then the provider's actual text is relayed as
 * SSE while the same server-side tool/confirmation boundaries stay intact.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  let body: {
    mode?: unknown;
    messages?: unknown;
    currentStep?: unknown;
    conversationId?: unknown;
    /** Phase F — start this conversation inside a project workspace. */
    projectId?: unknown;
    attachment?: unknown;
    /** Wave 5 extension — one or more attachments (image and/or PDF). */
    attachments?: unknown;
    allowActions?: unknown;
    /** Phase D — run this dashboard turn as a business-defined custom agent. */
    agentId?: unknown;
    /** Phase 36c — the selected task lens (see ai-tasks.ts). */
    task?: unknown;
    /** Phase 36c — a free-form custom task description, wins over `task`. */
    customTask?: unknown;
    /** Phase 36 Wave 7 — «دوباره بپرس»: build a fresh turn, skip the cache. */
    bypassCache?: unknown;
    /** Product-facing routing mode; provider aliases never reach the tenant. */
    reasoningMode?: unknown;
    /** Optional app focus, which only narrows prompt/tool context. */
    appFocus?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const mode: AgentMode =
    body.mode === "wizard" ? "wizard" : body.mode === "floor" ? "floor" : "dashboard";
  // Dashboard access is a capability, not a manager role. This makes the
  // universal home usable by cashiers/accountants while the effective tool
  // intersection below keeps their data surface narrow.
  const guard =
    mode === "floor"
      ? await requireFloorAssistant()
      : mode === "wizard"
        ? await requireManager()
        : await requireManager(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;
  const effectivePermissions = guard.membership?.permissions ?? new Set();
  const reasoningMode: AiReasoningMode = isAiReasoningMode(body.reasoningMode)
    ? body.reasoningMode
    : "auto";
  if (!isAiReasoningModeAvailable(reasoningMode)) {
    return NextResponse.json(
      { error: "mode_unavailable", mode: reasoningMode, message: "حالت پژوهش عمیق هنوز برای دستیار کسب‌وکار فعال نشده است." },
      { status: 409 },
    );
  }

  const floorLocation = mode === "floor" ? await resolveActiveLocation(session) : null;
  if (mode === "floor" && !floorLocation) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }
  if (
    mode === "floor" &&
    session.role !== "cashier" &&
    session.role !== "waiter"
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ error: "empty_messages" }, { status: 400 });
  }

  // Phase D — an optional custom agent scopes this turn. Only dashboard mode
  // runs as an agent (the floor and wizard surfaces are their own realms). A
  // disabled or unknown agent id is refused rather than silently falling back
  // to the full assistant, so the caller can never think it is scoped when it
  // is not.
  let agentScope: AgentTurnScope | null = null;
  if (mode === "dashboard" && typeof body.agentId === "string" && body.agentId.trim()) {
    const agent = await getCustomAgent(session.businessId, body.agentId.trim());
    if (!agent || !agent.enabled) {
      return NextResponse.json({ error: "agent_unavailable" }, { status: 404 });
    }
    agentScope = agentTurnScope(agent);
  }

  // Wave 5 (issue #145, extended) — only dashboard mode (owner/manager) may
  // attach files (receipt/invoice images and PDF documents), matching
  // expense.categorize's existing scope. Validated images are persisted
  // best-effort in Media Library; PDFs stay one-turn ephemeral. On an invalid
  // data URL the whole request is refused rather than silently dropping the
  // attachment. The legacy single-object shape is still accepted.
  const { attachments, error: attachmentError } = parseChatAttachments(
    mode,
    body.attachments ?? body.attachment,
  );
  if (attachmentError) {
    return NextResponse.json(
      {
        error: "attachment_invalid",
        message: "فرمت یا حجم پیوست پشتیبانی نمی‌شود (تصویر حداکثر ۵ مگابایت، PDF حداکثر ۱۰ مگابایت).",
      },
      { status: 400 },
    );
  }
  // PDF text layers are extracted once, before the turn starts.
  const preparedAttachments = await prepareAttachments(attachments);
  const allowActions = body.allowActions !== false;
  const appFocusValues = new Set([
    "all",
    "accounting",
    "growth",
    "crm",
    "website",
    "workspace",
  ]);
  const appFocus = typeof body.appFocus === "string" && appFocusValues.has(body.appFocus)
    ? body.appFocus
    : "all";
  const appFocusDirective =
    appFocus === "all"
      ? ""
      : `تمرکز این نوبت روی بخش «${appFocus}» است؛ فقط ابزارهای مجاز همین عضو را استفاده کن و این انتخاب هرگز مجوز تازه‌ای ایجاد نمی‌کند.`;
  const taskDirective = [
    AI_MODE_DIRECTIVES[reasoningMode],
    taskDirectiveFor({ task: body.task, customTask: body.customTask, mode }),
    appFocusDirective,
  ]
    .filter(Boolean)
    .join("\n\n");

  const activeLocation = await resolveActiveLocation(session);
  const locationId = floorLocation?.id ?? activeLocation?.id ?? null;
  // Phase 37 & 39 — resolved through the gateway: the virtual key and model alias
  // for THIS business and branch are applied here. Routing/fallback stays in LiteLLM.
  const config = await resolveAiConfigFor(session.businessId, locationId, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: locationId, surface: "chat" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  // Phase B — the pre-request affordability gate replaces the credit
  // reservation. It refuses when the business is in AI debt or its wallet is
  // below the per-turn ceiling; it never holds money up front.
  const requestId = newAiRequestId();
  try {
    await gateAiTurn(session.businessId, config);
  } catch (err) {
    if (err instanceof AiWalletInsufficientError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید." },
        { status: 402 },
      );
    }
    throw err;
  }

  const { rows } = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [
    session.businessId,
  ]);
  const promptContext: PromptContext = {
    mode,
    businessName: rows[0]?.name ?? null,
    currentStep: typeof body.currentStep === "string" ? body.currentStep : null,
    userName: session.fullName,
    role: session.role,
    agent: agentScope
      ? {
          name: agentScope.name,
          instructions: agentScope.instructions,
          actionTypes: agentScope.actionTypes,
        }
      : undefined,
  };
  const latestPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  // Best-effort transcript persistence (Wave 1, issue #141) — sits beside the
  // metered turn below, not inside it: it never touches billing and a
  // failure here must not fail an already-reserved turn.
  const requestedConversationId =
    typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim()
      : null;
  const requestedProjectId =
    typeof body.projectId === "string" && body.projectId.trim()
      ? body.projectId.trim()
      : null;
  if (requestedProjectId && (mode === "dashboard" || mode === "wizard")) {
    const project = await getProject({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: requestedProjectId,
    });
    if (!project) {
      return NextResponse.json({ error: "project_forbidden", message: "به این پروژه دسترسی ندارید." }, { status: 403 });
    }
  }
  let conversationId: string | null = null;
  try {
    const conversation = await getOrCreateConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      mode,
      conversationId: requestedConversationId,
      firstMessageContent: latestPrompt,
      // A project link is set only when a new conversation is started; resuming
      // an existing one keeps whatever project it already carries.
      projectId: requestedProjectId,
    });
    conversationId = conversation.id;
    await appendMessage({ conversationId, role: "user", content: latestPrompt });
  } catch (err) {
    console.error("ai conversation persistence failed", err);
  }

  // Phase F — if this conversation belongs to a project, load the project's
  // standing instruction, notes and remembered facts and render them into the
  // prompt. Best-effort: a failure here degrades to a project-unaware turn, it
  // never fails the turn. Only dashboard/wizard turns carry a project.
  let projectContext: string | null = null;
  // The ambient project id for this turn. When set, project-scoped actions are
  // offered and their resolved id is injected into any proposal payload — the
  // model never names a project id (Phase F pt.2).
  let activeProjectId: string | null = null;
  if (conversationId && (mode === "dashboard" || mode === "wizard")) {
    try {
      const projectId = await getConversationProjectId(session.businessId, conversationId);
      if (projectId) {
        const ctx = await getProjectPromptContext({
          businessId: session.businessId,
          actorUserId: session.sub,
          projectId,
        });
        if (!ctx) {
          return NextResponse.json({ error: "project_forbidden", message: "به این پروژه دسترسی ندارید." }, { status: 403 });
        }
        if (ctx) {
          activeProjectId = projectId;
          projectContext = buildProjectPromptContext(ctx);
          promptContext.projectContext = projectContext;
          // Phase F pt.5 — if the project pins a default agent and the request
          // did not name one of its own, run this turn as the pinned agent. A
          // request-level agentId always wins (it is already resolved above);
          // a disabled/deleted pin resolves to null and the turn stays the full
          // assistant. This can only NARROW the turn, never widen it.
          if (!agentScope && ctx.defaultAgentId) {
            const pinned = await getCustomAgent(session.businessId, ctx.defaultAgentId);
            if (pinned && pinned.enabled) {
              agentScope = agentTurnScope(pinned);
              promptContext.agent = {
                name: agentScope.name,
                instructions: agentScope.instructions,
                actionTypes: agentScope.actionTypes,
              };
            }
          }
          // Only when there is no scoped agent — an agent's action list is its
          // own, and a project does not widen it.
          if (!agentScope) promptContext.projectScoped = true;
        }
      }
    } catch (err) {
      console.error("ai project context load failed", err);
    }
  }

  // Phase G pt.2 — persist any IMAGE attachments this turn carried into the
  // Media Library, tagged with their provenance (from chat, and the
  // conversation/project they belong to). Best-effort and non-blocking: it
  // never throws and the turn proceeds regardless. Only dashboard/wizard turns
  // attach files (the same scope parseChatAttachments enforces), and only when
  // the conversation was actually persisted.
  if (conversationId && attachments.length > 0 && (mode === "dashboard" || mode === "wizard")) {
    void persistChatImageAttachments({
      businessId: session.businessId,
      userId: session.sub,
      conversationId,
      projectId: activeProjectId,
      attachments,
    }).catch((err) => console.error("ai chat attachment persistence failed", err));
  }

  // Phase 36 Wave 7 — the question's embedding, over the shared platform
  // connection, computed once whether this turn is a lookup or a store (a
  // «دوباره بپرس» turn skips the lookup, but its fresh answer is still worth
  // caching). Failed embedding turns the cache off for this turn, never the
  // assistant.
  const bypassCache = body.bypassCache === true;
  // An agent turn is a different assistant — narrower tools, its own
  // instructions — so it never shares the general assistant's answer cache: a
  // cached full-assistant answer must not surface inside a scoped agent, and a
  // scoped agent's answer must not be served to the full assistant.
  // Phase F — a project-scoped turn is shaped by the project's instruction,
  // notes and memory, so it never shares the general answer cache: a generic
  // cached answer must not surface inside a project, and a project-shaped
  // answer must not be served to a project-less turn.
  const cacheCandidate =
    !agentScope &&
    !projectContext &&
    (mode === "dashboard" || mode === "floor") &&
    attachments.length === 0 &&
    latestPrompt.trim();
  let questionEmbedding: number[] | null = null;
  let questionEmbeddingTokens = 0;
  if (cacheCandidate && (await isEmbeddingAvailable(config))) {
    try {
      const embedded = await embedOne(config, latestPrompt);
      questionEmbedding = embedded.vector;
      questionEmbeddingTokens = embedded.inputTokens;
    } catch {
      questionEmbedding = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(sse(event, data));

      void (async () => {
        try {
          // The code-built system prompt for this surface. The ctx is built
          // with the same attachment/retrieval facts runAgentTurn would use.
          // Phase 36c — the turn's task lens rides on top of it, so no invalid
          // task can leak into the prompt.
          const resolvedPrompt = buildSystemPrompt({
            ...promptContext,
            hasAttachment: attachments.length > 0,
            retrieval: await retrievalReadyForMode(config, mode, session.businessId),
          });
          const systemPrompt = taskDirective
            ? `${resolvedPrompt}\n\n${taskDirective}`
            : resolvedPrompt;

          // Wave 7 — a repeated read-only question inside this trading day
          // answers from the cache, labelled, for the price of an embedding.
          let cachedHit: CacheHit | null = null;
          if (questionEmbedding && !bypassCache) {
            try {
              cachedHit = await lookupCachedAnswer(
                {
                  businessId: session.businessId,
                  locationId: floorLocation?.id ?? null,
                  businessDate: await businessToday(session.businessId),
                  toolSignature: null,
                },
                questionEmbedding,
              );
            } catch {
              cachedHit = null;
            }
          }

          if (cachedHit) {
            const settlement = await settleAiTurn({
              businessId: session.businessId,
              requestId,
              config,
              usage: { inputTokens: questionEmbeddingTokens, outputTokens: 0 },
              costUsd: null,
              cacheHit: true,
              attribution: {
                requestType: "chat",
                model: config.model,
                conversationId,
                locationId,
                userId: session.sub,
                metadata: { mode, cached: true },
              },
            });

            if (conversationId) {
              await appendMessage({
                conversationId,
                role: "assistant",
                content: cachedHit.answer,
              }).catch((err) => console.error("ai conversation persistence failed", err));
            }

            emit("done", {
              content: cachedHit.answer,
              proposedAction: null,
              auditId: null,
              conversationId,
              costRial: settlement.chargedRial,
              cached: true,
              cacheNotice: cachedHit.notice,
            });
            return;
          }

          const reply = await runAgentTurn({
            config,
            mode,
            businessId: session.businessId,
            // Phase G — «مالِ من» in the workspace tools is this member and
            // only this member; the model never names a user id.
            actorUserId: session.sub,
            permissions: effectivePermissions,
            systemPrompt,
            floorScope:
              mode === "floor" && floorLocation && (session.role === "cashier" || session.role === "waiter")
                ? {
                    locationId: floorLocation.id,
                    userId: session.sub,
                    role: session.role,
                  }
                : undefined,
            promptContext,
            messages: withAttachmentContext(messages, preparedAttachments),
            attachments: preparedAttachments,
            allowActions,
            // Phase D — when the turn runs as a custom agent, restrict the read
            // tools to its allowlist and the proposable actions to its action
            // list. Both are re-checked in runAgentTurn, so a hand-crafted
            // response naming an out-of-scope action is refused, not applied.
            toolAllowlist: agentScope ? agentScope.toolAllowlist : undefined,
            actionTypes: agentScope ? agentScope.actionTypes : undefined,
            // Phase F pt.2 — a non-agent project turn also offers the
            // project-scoped action(s); runAgentTurn re-checks the enum.
            projectScoped: Boolean(activeProjectId) && !agentScope,
            stream: {
              onDelta: (content) => emit("delta", { content }),
              onToolCalls: () => emit("reset", {}),
            },
            requestId,
            signal: request.signal,
          });

          // Phase F pt.2 — a project-scoped proposal is addressed by the AMBIENT
          // project id, which the model never sees. Inject the resolved id into
          // the payload here so the confirm card, the audit and the apply call
          // all target this project and no other. The action was only offered
          // when activeProjectId was set, so this is the id it belongs to.
          if (
            reply.proposedAction &&
            ACTION_CATALOG[reply.proposedAction.type]?.projectScoped &&
            activeProjectId
          ) {
            reply.proposedAction = {
              ...reply.proposedAction,
              payload: {
                ...reply.proposedAction.payload,
                projectId: activeProjectId,
                // The memory came from the assistant, tagged so the project page
                // can show its provenance. A human's own memory posts 'user'.
                source: "ai",
              },
            };
          }
          // Phase B — settle the REAL cost against the platform wallet. The
          // gateway's reported USD (plus the platform margin) is preferred;
          // the token rates are the fallback when the gateway did not price
          // the turn. No reservation was held, so this is the only debit.
          const settlement = await settleAiTurn({
            businessId: session.businessId,
            requestId,
            config,
            usage: reply.usage,
            costUsd: reply.costUsd,
            attribution: {
              requestType: "chat",
              model: config.model,
              conversationId,
              locationId,
              userId: session.sub,
              metadata: { mode },
            },
          });

          const auditId = reply.proposedAction
            ? await createAiActionAudit({
                businessId: session.businessId,
                actorUserId: session.sub,
                actorName: session.fullName,
                prompt: latestPrompt,
                proposal: reply.proposedAction,
                conversationId,
              })
            : null;

          // Phase E — persist the assistant turn, then attach a typed input
          // request to it when the model raised one. The request row links back
          // to this message so the transcript and the still-open card stay in
          // one join.
          let inputRequestId: string | null = null;
          if (conversationId) {
            const messageId = await appendMessage({
              conversationId,
              role: "assistant",
              content: reply.content,
              proposal: reply.proposedAction,
              auditId,
            }).catch((err) => {
              console.error("ai conversation persistence failed", err);
              return null;
            });
            if (reply.inputRequest && messageId) {
              const created = await createInputRequest({
                conversationId,
                messageId,
                spec: reply.inputRequest,
              }).catch((err) => {
                console.error("ai input request persistence failed", err);
                return null;
              });
              inputRequestId = created?.id ?? null;
            }
          }

          // Wave 7 — cache the answer only when the turn was provably
          // read-only: no proposal and nothing outside the mode's read tools.
          // `storeCachedAnswer` re-checks the same gate, so a future edit to
          // this route cannot forget it. Phase E — an input-request turn is
          // interactive and per-user, never cached: it is treated like a
          // proposal for the cache gate.
          const readToolNames = toolDefinitions(mode, { hasAttachment: false })
            .filter((tool) => tool.function.name !== "propose_action" && tool.function.name !== "request_input")
            .map((tool) => tool.function.name);
          const toolsUsed = reply.toolCalls.map((call) => call.name);
          const turnShape = {
            mode,
            toolsUsed,
            proposedAction: Boolean(reply.proposedAction) || Boolean(reply.inputRequest),
            readToolNames,
          };
          if (questionEmbedding && isCacheableTurn(turnShape)) {
            const toolSignature = buildToolSignature(
              reply.toolCalls.map((call) => ({
                tool: call.name,
                from: normalizeRangeDate(call.dateFrom),
                to: normalizeRangeDate(call.dateTo),
              })),
            );
            await storeCachedAnswer(
              {
                businessId: session.businessId,
                locationId: floorLocation?.id ?? null,
                businessDate: await businessToday(session.businessId),
                toolSignature,
              },
              {
                questionText: latestPrompt,
                questionEmbedding,
                answer: reply.content,
                turn: turnShape,
              },
            ).catch(() => {});
          }

          emit("done", {
            content: reply.content,
            proposedAction: reply.proposedAction,
            // Phase E — the typed input request (spec + its persisted id), so
            // the client can render the card and submit an answer against it.
            inputRequest: reply.inputRequest
              ? { id: inputRequestId, spec: reply.inputRequest }
              : null,
            auditId,
            conversationId,
            // What this turn actually cost, so the client can say so under the
            // reply. It replaces the pre-send estimate card, which charged the
            // user an extra round trip and a tap to show a *guess*.
            costRial: settlement.chargedRial,
          });
        } catch (err) {
          // A turn that failed before the provider answered cost nothing, so
          // nothing is settled.
          if (err instanceof AiError) {
            console.error("ai chat provider error", {
              requestId,
              businessId: session.businessId,
              locationId,
              mode,
              code: err.code,
              status: err.providerError?.status ?? null,
              detail: providerErrorReason(err.providerError),
            });
            emit("error", { error: err.code, message: err.message, requestId });
          } else {
            console.error("ai chat unexpected error", {
              requestId,
              businessId: session.businessId,
              locationId,
              mode,
              error: err instanceof Error ? err.message : String(err),
            });
            emit("error", { error: "ai_unknown", message: "خطای غیرمنتظره در دستیار." });
          }
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
