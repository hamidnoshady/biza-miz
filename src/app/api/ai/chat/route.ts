import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import {
  ACTION_CATALOG,
  buildSystemPrompt,
  type ActionType,
  type AgentMode,
  type PromptContext,
} from "@/lib/ai";
import { getBusinessIndustry } from "@/lib/industry-guard";
import type { AppKey } from "@/lib/apps";
import { eligibleAgentCards, type EligibleAgentCard } from "@/lib/ai-system-agents";
import {
  BASE_PROMPT_SCOPE,
  promptLayerKeys,
  resolveSystemPrompt,
  type ResolvedPromptLayers,
} from "@/lib/ai-prompt-resolver";
import {
  getPlatformAiMode,
  isAiRuntimeModeAvailable,
  normalizeAiRuntimeMode,
  type AiRuntimeMode,
} from "@/lib/ai-runtime-modes";
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
import {
  AiError,
  accruedUsageOf,
  runAgentTurn,
  type InboundMessage,
} from "@/lib/ai-service";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { requireFloorAssistant, withTenantScope } from "@/lib/auth";
import { providerErrorReason } from "@/lib/ai-provider-errors";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";
import {
  knowledgeReadyFor,
  knowledgeSettingsFromConfig,
} from "@/lib/ai-knowledge-gateway";

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
    /**
     * Issue #812 §9 — the assignment id of a Superadmin-assigned suggestion
     * card. A tenant never names an agent directly: the card carries the agent,
     * its prompt and its requirements, and eligibility is re-checked here.
     */
    suggestionId?: unknown;
    /** Phase 36c — the selected task lens (see ai-tasks.ts). */
    task?: unknown;
    /** Phase 36c — a free-form custom task description, wins over `task`. */
    customTask?: unknown;
    /** Product-facing routing mode; provider aliases never reach the tenant. */
    /** Issue #812 §7 — one of auto | instant | deep_research. */
    runtimeMode?: unknown;
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
  // Issue #812 §11 — every path names its capability explicitly, and none of
  // them is widened. `requireManager(permission)` is `requirePermission(permission)`
  // under a compatibility name, so writing the capability out is what stops the
  // next edit from silently re-defaulting this route to `settings.manage`.
  //
  //   floor    — `floorAssistant`, the till's own assistant permission.
  //   dashboard — `ai.use`: using the assistant is not administering it, so the
  //               universal home is reachable by cashiers and accountants while
  //               the effective-tool intersection below keeps their data
  //               surface narrow.
  //   wizard    — still `settings.manage`. The setup wizard edits the business's
  //               own configuration, which is a management act; dropping it to
  //               `ai.use` here would hand every assistant user a wizard.
  const guard =
    mode === "floor"
      ? await requireFloorAssistant()
      : mode === "wizard"
        ? await requireManager(PERMISSIONS.settingsManage)
        : await requireManager(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;
  const effectivePermissions = guard.membership?.permissions ?? new Set();
  // Issue #812 §5/§6 — whether Superadmin has switched Deep Research on for this
  // platform. Read once per request, before the mode gate below.
  const deepResearchEnabled = (await getPlatformAiMode("deep_research")).is_active;
  // Issue #812 §7 — the three user-facing runtime modes. A stored `thinking`
  // value normalizes to `auto` rather than silently doing nothing.
  const runtimeMode: AiRuntimeMode = normalizeAiRuntimeMode(body.runtimeMode);
  if (!isAiRuntimeModeAvailable(runtimeMode, deepResearchEnabled)) {
    return NextResponse.json(
      { error: "mode_unavailable", mode: runtimeMode, message: "پژوهش عمیق روی این سکو فعال نیست." },
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
  let agentCard: EligibleAgentCard | null = null;
  const suggestionId = typeof body.suggestionId === "string" ? body.suggestionId.trim() : "";
  if (mode === "dashboard" && suggestionId) {
    const cards = await eligibleAgentCards({
      businessId: session.businessId,
      businessType: await getBusinessIndustry(session.businessId),
      permissions: [...effectivePermissions],
      enabledApps: [],
      enabledFeatures: [],
    });
    agentCard = cards.find((card) => card.assignmentId === suggestionId) ?? null;
    if (!agentCard) {
      return NextResponse.json({ error: "suggestion_unavailable" }, { status: 404 });
    }
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
  // Issue #812 §7/§8 — the runtime mode's own directive is layer 2 of the
  // resolver, not part of the task directive. What is left here is the task
  // lens and the app focus, both of which narrow rather than widen.
  const taskDirective = [
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

  // Issue #812 §2 — the managed knowledge integration for this tenant, read
  // from the platform gateway settings. Resolved once per request, before the
  // stream starts, so a settings failure degrades to "no knowledge" rather
  // than a failed turn.
  const knowledgeSettings = knowledgeSettingsFromConfig(config);
  // The tool is offered only in dashboard mode and only for a tenant: the floor
  // and wizard surfaces are their own realms, and a platform support turn has
  // no tenant namespace to search.
  const knowledgeReady =
    mode === "dashboard" && knowledgeReadyFor(knowledgeSettings, session.businessId);

  // Phase B — the pre-request affordability gate replaces the credit
  // reservation. It refuses when the business is in AI debt or its wallet is
  // below the per-turn ceiling; it never holds money up front.
  const requestId = newAiRequestId();
  // Issue #812 §21 — which prompt layer versions shaped this turn, recorded on
  // the settlement so a change in behaviour is attributable to a publish.
  let promptLayers: ResolvedPromptLayers | null = null;
  /** The empty layer set, so the attribution call needs no null branch. */
  const EMPTY_PROMPT_LAYERS: ResolvedPromptLayers = {
    base: { version: null, scopeKey: BASE_PROMPT_SCOPE },
    mode: { version: null, scopeKey: "mode:auto" },
    agent: null,
    businessType: null,
    app: null,
    memoryScopes: [],
    toolCatalogue: false,
  };
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
    // Issue #812 §15 — the tenant's own display unit. Storage stays integer
    // Rial; only the unit the business chose is spoken and written, so a
    // «ریال» business is never told «تومان».
    currencyDisplay: await resolveBusinessMoneyUnit(session.businessId),
    // Issue #808 §8 — wizard turns are scoped to the steps this industry walks,
    // in the prompt and in `propose_action`'s enum (see ai-service.ts).
    industry: mode === "wizard" ? await getBusinessIndustry(session.businessId) : null,
    currentStep: typeof body.currentStep === "string" ? body.currentStep : null,
    userName: session.fullName,
    role: session.role,
    // Issue #812 §9 — the system agent's own narrowing allowlists. The tool
    // intersection in `runAgentTurn` still applies the member's permissions and
    // the app/location scope on top of these, so this can only narrow.
    agent: agentCard
      ? {
          id: agentCard.agentId,
          name: agentCard.agentName,
          instructions: agentCard.prompt,
          actionTypes: [],
        }
      : undefined,
    agentAllowlist: agentCard
      ? { tools: agentCard.allowedTools, actions: agentCard.allowedActions }
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
          // Issue #812 §4 — a project no longer pins an agent. There is no
          // tenant agent to pin, and a system agent reaches a project through a
          // Superadmin assignment, never through a project setting.
          // Only when there is no scoped agent — an agent's action list is its
          // own, and a project does not widen it.
          if (!agentCard) promptContext.projectScoped = true;
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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(sse(event, data));

      void (async () => {
        try {
          // The code-built system prompt for this surface. The ctx is built
          // with the same attachment/retrieval facts runAgentTurn would use.
          // Phase 36c — the turn's task lens rides on top of it, so no invalid
          // task can leak into the prompt.
          // Issue #812 §8 — the ONE prompt resolver. It composes the platform
          // base policy, the runtime mode, the system agent, the business-type
          // and app fragments, this tenant's layered memory, the project
          // context and this turn's task, and only then the tool catalogue.
          // A published platform prompt version replaces one layer's text and
          // nothing else; an unpublished scope falls back to the code default.
          const resolved = await resolveSystemPrompt({
            ...promptContext,
            runtimeMode,
            businessId: session.businessId,
            agentKey: agentCard?.agentKey ?? null,
            businessType: promptContext.industry,
            appKey: appFocus === "all" ? null : (appFocus as AppKey | null),
            hasAttachment: attachments.length > 0,
            // Issue #812 §2 — the knowledge tool is offered only when the
            // managed, tenant-isolated knowledge integration is configured.
            retrieval: knowledgeReady,
            taskContext: taskDirective || null,
          });
          promptLayers = resolved.layers;
          const systemPrompt = resolved.systemPrompt;

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
            toolAllowlist: agentCard?.allowedTools ?? undefined,
            actionTypes: (agentCard?.allowedActions ?? undefined) as ActionType[] | undefined,
            // Phase F pt.2 — a non-agent project turn also offers the
            // project-scoped action(s); runAgentTurn re-checks the enum.
            projectScoped: Boolean(activeProjectId) && !agentCard,
            stream: {
              onDelta: (content) => emit("delta", { content }),
              onToolCalls: () => emit("reset", {}),
            },
            requestId,
            signal: request.signal,
            // Issue #812 §2/§3 — the managed knowledge integration and this
            // turn's tenant scope. The business id comes from the session, so
            // retrieval can only ever see this tenant's namespace.
            knowledge: knowledgeReady
              ? {
                  settings: knowledgeSettings,
                  scope: {
                    businessId: session.businessId,
                    locationId,
                    appKey: appFocus === "all" ? null : appFocus,
                    projectId: activeProjectId,
                  },
                }
              : undefined,
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
              // §12 — the issue's named attribution, as columns. A mode is not
              // decoration: `auto`, `instant` and `deep_research` resolve
              // different LiteLLM aliases and therefore different prices, so a
              // usage report that cannot slice by mode cannot explain its own
              // numbers. The same holds for the system agent and the suggestion
              // card that invoked it.
              runtimeMode,
              systemAgentId: agentCard?.agentId ?? null,
              suggestionId: agentCard?.assignmentId ?? null,
              promptLayers: promptLayerKeys(promptLayers ?? EMPTY_PROMPT_LAYERS),
              metadata: { mode, runtimeMode },
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
          // Issue #812 §16 — a turn that failed *after* the provider was
          // reached still cost money, and that cost is never lost: whatever the
          // failed turn had already accrued is settled here, against the same
          // request id the successful path would have used. Settlement is
          // idempotent per request id, so this can never double-charge.
          const accrued = accruedUsageOf(err);
          if (accrued) {
            try {
              await settleAiTurn({
                businessId: session.businessId,
                requestId,
                config,
                usage: accrued.usage,
                costUsd: accrued.costUsd,
                attribution: {
                  requestType: "chat",
                  model: config.model,
                  conversationId,
                  locationId,
                  userId: session.sub,
                  note: "failed_turn",
                  // §12 — a failed turn carries the same attribution as a
                  // successful one. §16's whole point is that a partial or
                  // failed call still costs money and still has to be
                  // attributable, so the dimensions are filled in here too
                  // rather than only on the happy path.
                  runtimeMode,
                  systemAgentId: agentCard?.agentId ?? null,
                  suggestionId: agentCard?.assignmentId ?? null,
                  promptLayers: promptLayerKeys(promptLayers ?? EMPTY_PROMPT_LAYERS),
                  metadata: { mode, runtimeMode, status: "failed" },
                },
              });
            } catch (settleErr) {
              console.error("ai chat failed-turn settlement failed", {
                requestId,
                error: settleErr instanceof Error ? settleErr.message : String(settleErr),
              });
            }
          }
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
