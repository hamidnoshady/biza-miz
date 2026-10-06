/**
 * The agent loop: talk to the configured OpenAI-compatible provider, run the
 * read-only tools it asks for, and surface any mutation as a proposed action for
 * human confirmation. Nothing here mutates business data.
 */
import {
  ACTION_CATALOG,
  buildSystemPrompt,
  chatCompletionsUrl,
  isKnownAction,
  KNOWLEDGE_TOOL_NAME,
  toolDefinitions,
  type ActionType,
  type AgentMode,
  type AiConfig,
  type ProposedAction,
  type PromptContext,
  BASE_ACTION_TYPES,
  PROJECT_ACTION_TYPES,
} from "./ai";
import { runReadTool, type FloorReadScope, type ToolResult } from "./ai-tools";
import { validateInputRequest, type InputRequestSpec } from "./ai-input-protocol";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseResponseCostHeader } from "./ai-gateway";
import { normalizeProviderError, tenantProviderErrorMessage, type NormalizedProviderError } from "./ai-provider-errors";
import {
  formatKnowledgeForPrompt,
  knowledgeReadyFor,
  retrieveTenantKnowledge,
  type KnowledgeGatewaySettings,
  type KnowledgeScope,
} from "./ai-knowledge-gateway";
import {
  allowedAiActions,
  filterAiToolsByPermissions,
} from "./ai-capabilities";
import type { Permission } from "./permissions";
import type { AppKey } from "./apps";
import { routeTools } from "./ai-tool-routing";
import {
  parseReceiptExtractionReply,
  RECEIPT_EXTRACTION_SYSTEM_PROMPT,
  RECEIPT_EXTRACTION_USER_PROMPT,
  type ReceiptDraftFields,
} from "./ai-receipt";

export type { ProposedAction };

export interface AgentReply {
  content: string;
  proposedAction: ProposedAction | null;
  /**
   * Phase E — a typed input request the model raised this turn (a choice, a
   * multi-choice or a form). Mutually exclusive with `proposedAction`: a turn
   * either asks the user for input or proposes a write, never both. Null when
   * the turn neither asked nor proposed.
   */
  inputRequest: InputRequestSpec | null;
  usage: AiTokenUsage;
  /**
   * Phase 38b — the gateway's own cost figure for this turn, summed across
   * every provider round (USD). Null whenever the responder did not report
   * one — a direct vendor, or a proxy with cost tracking off — which the
   * settlement reads as "price from the token rates instead", never as free.
   */
  costUsd: number | null;
  /**
   * Phase 36 Wave 7 — every tool this turn invoked, with the date range it was
   * given, so the caller can build the semantic cache's tool signature and
   * decide whether the turn was read-only. Empty for a turn that answered
   * without tools.
   */
  toolCalls: AgentToolCallTrace[];
}

export interface AgentToolCallTrace {
  name: string;
  /** Inclusive business-date range the call read, when the tool took one. */
  dateFrom?: string;
  dateTo?: string;
}

interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A multimodal user-message content part (Wave 5, issue #145). Only ever used
 * for the isolated receipt-extraction call below — the main conversation
 * loop stays plain-text, so an attached image is never resent on every tool
 * round.
 */
type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };


interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ProviderContentPart[] | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
}

export interface AiProviderRequestDiagnostics {
  requestId?: string;
  endpoint: "chat_completions";
  url: string;
  model: string;
  credentialSource: "tenant_virtual_key" | "gateway_master_key" | "platform_key" | "missing";
  streaming: boolean;
  streamOptions: boolean;
  toolCount: number;
  functionToolCount: number;
  mcpToolCount: number;
  toolTypes: string[];
  fallbackCount: number;
  hasFallbacks: boolean;
  hasMcpTools: boolean;
}

function credentialSource(config: AiConfig): AiProviderRequestDiagnostics["credentialSource"] {
  const runtime = config as AiConfig & {
    tenantVirtualKeyResolved?: boolean;
    tenantVirtualKeyRequired?: boolean;
  };
  if (config.gateway?.authKey && runtime.tenantVirtualKeyResolved) return "tenant_virtual_key";
  if (config.gateway?.authKey) return "gateway_master_key";
  if (config.apiKey) return "platform_key";
  return "missing";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateJsonSchemaObject(schema: unknown, path: string, errors: string[]): void {
  if (!isRecord(schema)) {
    errors.push(`${path}: parameters must be a JSON object`);
    return;
  }
  if (schema.type !== "object") {
    errors.push(`${path}.type: root schema must be object`);
  }
  const properties = schema.properties;
  if (properties !== undefined && !isRecord(properties)) {
    errors.push(`${path}.properties: must be an object when present`);
  }
  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string")) {
      errors.push(`${path}.required: must be an array of strings`);
    } else if (isRecord(properties)) {
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}.required: ${key} is not defined in properties`);
        }
      }
    }
  }
}

/**
 * Validate the exact function-tool catalogue before it reaches LiteLLM/OpenAI.
 * A single malformed definition makes the entire chat-completions request a 400;
 * failing locally gives operators a precise application error instead.
 */
export function validateOpenAiTools(tools: unknown[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  tools.forEach((tool, index) => {
    const path = `tools[${index}]`;
    if (!isRecord(tool)) {
      errors.push(`${path}: tool must be an object`);
      return;
    }
    if (tool.type !== "function") {
      errors.push(`${path}.type: only OpenAI function tools are allowed in core chat`);
      return;
    }
    if (!isRecord(tool.function)) {
      errors.push(`${path}.function: missing function definition`);
      return;
    }
    const fn = tool.function;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      errors.push(`${path}.function.name: invalid OpenAI function name`);
    } else if (names.has(name)) {
      errors.push(`${path}.function.name: duplicate tool name ${name}`);
    } else {
      names.add(name);
    }
    if (typeof fn.description !== "string" || !fn.description.trim()) {
      errors.push(`${path}.function.description: description is required`);
    }
    validateJsonSchemaObject(fn.parameters, `${path}.function.parameters`, errors);
  });
  return errors;
}

export interface InboundMessage {
  role: "user" | "assistant";
  content: string;
}

/** Supplies data only for the tool names exposed by the active agent mode. */
export type ReadToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

const MAX_TOOL_ROUNDS = 6;
const REQUEST_TIMEOUT_MS = 60_000;

function providerHeaders(config: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Phase 37 — a gateway deployment authenticates the call with the calling
    // business's virtual key when one has been provisioned; every other
    // deployment sends the platform key exactly as it always has.
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
}

interface ProviderStreamCallbacks {
  onDelta?: (content: string) => void;
  onToolCalls?: () => void;
}

interface ProviderStreamDelta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface ProviderStreamChunk {
  choices?: { delta?: ProviderStreamDelta }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function fallbackUsage(messages: ProviderMessage[], content: string): AiTokenUsage {
  return {
    // Some compatible gateways omit usage. Charge a documented conservative
    // fallback rather than letting metered calls bypass the ledger altogether.
    inputTokens: estimateTokens(JSON.stringify(messages)),
    outputTokens: estimateTokens(content),
  };
}

function providerUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  fallback: AiTokenUsage,
): AiTokenUsage {
  const promptTokens = Number(usage?.prompt_tokens);
  const completionTokens = Number(usage?.completion_tokens);
  return Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
    ? {
        inputTokens: Math.max(0, Math.floor(promptTokens)),
        outputTokens: Math.max(0, Math.floor(completionTokens)),
      }
    : fallback;
}

/**
 * Phase 38b — the gateway prices every completion from its own model-cost map
 * and reports the figure on the response. A direct vendor never sets the
 * header, which is exactly the fallback: no figure means the settlement
 * prices from the token rates, never from zero.
 */
function responseCostUsd(response: Response): number | null {
  return parseResponseCostHeader(response.headers.get("x-litellm-response-cost"));
}

/**
 * Reads one OpenAI-compatible SSE response. Tool-call fragments are reassembled
 * before the normal agent loop sees them; visible text is forwarded immediately
 * so the dashboard can render a genuine streamed answer.
 */
async function readStreamingProviderResponse(
  response: Response,
  messages: ProviderMessage[],
  callbacks: ProviderStreamCallbacks,
): Promise<ProviderResult> {
  if (!response.body) throw new AiError("ai_provider", "پاسخ جریانی سرویس هوش مصنوعی نامعتبر بود.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ProviderToolCall>();
  let content = "";
  let buffer = "";
  let sawToolCalls = false;
  let providerReportedUsage: ProviderStreamChunk["usage"];

  function consumeData(raw: string) {
    if (!raw || raw === "[DONE]") return;
    let chunk: ProviderStreamChunk;
    try {
      chunk = JSON.parse(raw) as ProviderStreamChunk;
    } catch {
      return;
    }
    if (chunk.usage) providerReportedUsage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      callbacks.onDelta?.(delta.content);
    }

    if (!delta.tool_calls?.length) return;
    if (!sawToolCalls) {
      sawToolCalls = true;
      // A provider normally emits no natural-language content in a tool turn.
      // If one does, the client clears the provisional text before the next,
      // final response begins.
      callbacks.onToolCalls?.();
    }
    for (const part of delta.tool_calls) {
      const index = Number.isInteger(part.index) ? part.index! : 0;
      const previous = toolCalls.get(index) ?? {
        id: part.id ?? `stream-tool-${index}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (part.id) previous.id = part.id;
      if (part.function?.name) previous.function.name = part.function.name;
      if (part.function?.arguments) previous.function.arguments += part.function.arguments;
      toolCalls.set(index, previous);
    }
  }

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    consumeData(trimmed.slice(5).trim());
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
  } finally {
    reader.releaseLock();
  }

  const assembledToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  const message: ProviderMessage = {
    role: "assistant",
    content: content || null,
    ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
  };
  return {
    message,
    usage: providerUsage(providerReportedUsage, fallbackUsage(messages, content)),
    costUsd: responseCostUsd(response),
  };
}

/** One completed provider round: its message, tokens, and any gateway cost. */
interface ProviderResult {
  message: ProviderMessage;
  usage: AiTokenUsage;
  costUsd: number | null;
}

async function callProvider(
  config: AiConfig,
  messages: ProviderMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  stream?: ProviderStreamCallbacks,
  requestId?: string,
  parentSignal?: AbortSignal,
): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const url = chatCompletionsUrl(config.baseUrl);
  const toolErrors = validateOpenAiTools(tools);
  const requestDiagnostics: AiProviderRequestDiagnostics = {
    ...(requestId ? { requestId } : {}),
    endpoint: "chat_completions",
    url,
    model: config.model,
    credentialSource: credentialSource(config),
    streaming: Boolean(stream),
    streamOptions: Boolean(stream),
    toolCount: tools.length,
    functionToolCount: tools.length,
    mcpToolCount: 0,
    toolTypes: tools.length > 0 ? ["function"] : [],
    fallbackCount: 0,
    hasFallbacks: false,
    hasMcpTools: false,
  };
  if (toolErrors.length > 0) {
    throw new AiError(
      "ai_invalid_tools",
      "تعریف ابزارهای هوش مصنوعی معتبر نیست و درخواست ارسال نشد.",
      toolErrors.join("; "),
      undefined,
      requestDiagnostics,
    );
  }

  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      stream: Boolean(stream),
    };
    if (stream) {
      // OpenAI-compatible APIs include final usage in the terminal stream
      // chunk when this option is supported; a conservative fallback remains
      // in place for gateways that omit it.
      body.stream_options = { include_usage: true };
    }
    // Some OpenAI-compatible providers reject an explicit empty tools array.
    // MCP and per-request LiteLLM fallbacks are intentionally not merged here:
    // routing/fallback/provider tools are gateway policy, and optional MCP must
    // never make ordinary tenant chat invalid.
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    res = await fetch(url, {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify(body),
      signal,
    });
    // Some OpenAI-compatible gateways accept streaming but not the optional
    // usage trailer. Retry the same non-mutating provider request once without
    // it; the documented conservative usage fallback still protects billing.
    if (stream && res.status === 400) {
      const fallbackBody = { ...body };
      delete fallbackBody.stream_options;
      requestDiagnostics.streamOptions = false;
      res = await fetch(url, {
        method: "POST",
        headers: providerHeaders(config),
        body: JSON.stringify(fallbackBody),
        signal,
      });
    }
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.", undefined, undefined, requestDiagnostics);
    }
    throw new AiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.", undefined, undefined, requestDiagnostics);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const providerError = normalizeProviderError(res.status, body);
    if (res.status === 401 || res.status === 403) {
      throw new AiError("ai_auth", tenantProviderErrorMessage(res.status), body, providerError, requestDiagnostics);
    }
    // The gateway's own throttles (RPM/TPM per deployment, per-key budgets)
    // answer 429. It is a transient, self-healing state — and since migration
    // 0168 the platform no longer mirrors key budgets, a 429 with wallet
    // credit left really is a proxy-side throttle, not a billing stop.
    if (res.status === 429) {
      throw new AiError("ai_rate_limited", tenantProviderErrorMessage(res.status), body, providerError, requestDiagnostics);
    }
    throw new AiError("ai_provider", tenantProviderErrorMessage(res.status), body, providerError, requestDiagnostics);
  }

  if (stream && res.headers.get("content-type")?.includes("text/event-stream")) {
    return readStreamingProviderResponse(res, messages, stream);
  }

  const json = (await res.json()) as {
    choices?: { message?: ProviderMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new AiError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");

  return {
    message,
    usage: providerUsage(json.usage, fallbackUsage(messages, textOf(message.content))),
    costUsd: responseCostUsd(res),
  };
}

/** The assistant's own replies are always plain text; only a user turn ever carries multimodal parts. */
function textOf(content: ProviderMessage["content"]): string {
  return typeof content === "string" ? content : "";
}

export class AiError extends Error {
  /**
   * Phase 6 of issue #812 — provider usage/cost already incurred before this
   * failure. A multi-round turn pays the provider on every round, so a
   * timeout, network break or cancellation after round N has already spent
   * real money. Losing that figure undercharges the business/platform ledger.
   *
   * The value is attached by `runAgentTurn` as the failure propagates out of
   * the loop, so a caller can settle exactly what was incurred and no more.
   * `settleAiTurn` is idempotent per request id, so settling here and then
   * settling the same id again can never double-charge.
   */
  public accruedUsage?: AiTurnAccrual;
  constructor(
    public code: string,
    message: string,
    public detail?: string,
    public providerError?: NormalizedProviderError,
    public requestDiagnostics?: AiProviderRequestDiagnostics,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** Usage/cost a failed turn had already incurred with the provider. */
export interface AiTurnAccrual {
  usage: AiTokenUsage;
  costUsd: number | null;
}

/**
 * Reads the accrual off any thrown value. Only `runAgentTurn` writes it, so a
 * failure raised before the provider was ever reached (validation, an unknown
 * tool) answers null and the caller settles nothing.
 */
export function accruedUsageOf(err: unknown): AiTurnAccrual | null {
  if (!err || typeof err !== "object") return null;
  const accrued = (err as { accruedUsage?: unknown }).accruedUsage;
  if (!accrued || typeof accrued !== "object") return null;
  const usage = (accrued as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number((usage as { inputTokens?: unknown }).inputTokens);
  const outputTokens = Number((usage as { outputTokens?: unknown }).outputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const costUsd = (accrued as { costUsd?: unknown }).costUsd;
  return {
    usage: { inputTokens, outputTokens },
    costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null,
  };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toProposedAction(args: Record<string, unknown>): ProposedAction | null {
  if (!isKnownAction(args.type)) return null;
  const payload =
    args.payload && typeof args.payload === "object"
      ? (args.payload as Record<string, unknown>)
      : {};
  return {
    type: args.type,
    title: typeof args.title === "string" ? args.title : "پیشنهاد تغییر",
    summary: typeof args.summary === "string" ? args.summary : "",
    payload,
  };
}

/**
 * A file attached to one turn only (Wave 5, issue #145, extended to PDFs).
 * Nothing here is ever persisted — not to the conversation transcript, not to
 * any table or object storage. An image is used for exactly one isolated
 * vision call; a PDF has its text extracted server-side and travels inline.
 * `kind` is optional so callers predating the PDF extension keep working —
 * it is derived from the data URL when absent.
 */
export interface ChatAttachment {
  kind?: "image" | "pdf";
  dataUrl?: string;
  /** PDF only — the extracted text layer, ready to hand to the model. */
  extractedText?: string | null;
  /** PDF only — the extraction hit MAX_PDF_TEXT_CHARS. */
  truncated?: boolean;
  name?: string;
}

/** Derives the kind for legacy attachments that only carry a data URL. */
export function attachmentKind(attachment: ChatAttachment): "image" | "pdf" {
  if (attachment.kind) return attachment.kind;
  return attachment.dataUrl?.startsWith("data:application/pdf") ? "pdf" : "image";
}

/** Normalizes the legacy single-attachment option into the attachment list. */
function normalizeAttachments(
  attachments: ChatAttachment[] | undefined,
  legacy: ChatAttachment | undefined,
): ChatAttachment[] {
  const list = attachments && attachments.length > 0 ? attachments : legacy ? [legacy] : [];
  return list.map((attachment) => ({
    ...attachment,
    kind: attachmentKind(attachment),
  }));
}

interface ReceiptExtractionResult {
  fields: ReceiptDraftFields | null;
  usage: AiTokenUsage;
  costUsd: number | null;
}

/**
 * One isolated, non-streaming, tool-less provider call that asks the same
 * configured platform provider (both defaults are vision-capable models) to
 * read a receipt image and return structured JSON. Deliberately its own
 * request rather than folding the image into the main conversation loop —
 * that would resend the image bytes on every later tool round.
 */
async function extractReceiptDraft(config: AiConfig, dataUrl: string, signal?: AbortSignal): Promise<ReceiptExtractionResult> {
  const convo: ProviderMessage[] = [
    { role: "system", content: RECEIPT_EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: RECEIPT_EXTRACTION_USER_PROMPT },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  try {
    const result = await callProvider(config, convo, [], undefined, undefined, signal);
    return {
      fields: parseReceiptExtractionReply(textOf(result.message.content)),
      usage: result.usage,
      costUsd: result.costUsd,
    };
  } catch {
    return { fields: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null };
  }
}

/** Wave 7 — the signature-relevant shape of one tool call: name + date range. */
function traceOf(name: string, args: Record<string, unknown>): AgentToolCallTrace {
  const trace: AgentToolCallTrace = { name };
  if (typeof args.dateFrom === "string") trace.dateFrom = args.dateFrom;
  if (typeof args.dateTo === "string") trace.dateTo = args.dateTo;
  return trace;
}

/**
 * Run one user turn to completion: resolve any read-tool calls server-side, and
 * stop as soon as the model proposes an action (returned for confirmation) or
 * produces a plain text answer.
 */export async function runAgentTurn(opts: {
  config: AiConfig;
  mode: AgentMode;
  /** Tenant turns provide this. Platform support supplies executeReadTool instead. */
  businessId?: string;
  /** Present only for the cashier/waiter assistant; it constrains all floor reads. */
  floorScope?: FloorReadScope;
  /**
   * Phase G — the signed-in member. The workspace read tools resolve «مالِ من»
   * from this and from nothing else; a model-supplied user id is never
   * accepted. Absent, those tools decline instead of widening their scope.
   */
  actorUserId?: string;
  /** Effective permissions resolved for this request. When present, the
   * catalogue and executor both enforce the same fail-closed intersection. */
  permissions?: ReadonlySet<Permission>;
  /**
   * A separate read-tool realm can supply its own executor. It is deliberately
   * invoked only after the tool name is checked against toolDefinitions(mode).
   */
  executeReadTool?: ReadToolRunner;
  /** Optional callbacks turn the provider response into a live UI stream. */
  stream?: ProviderStreamCallbacks;
  /** Server-generated id used only for sanitized diagnostics/log correlation. */
  requestId?: string;
  /** Disconnect/cancel signal from a browser request; aborts provider work too. */
  signal?: AbortSignal;
  promptContext: PromptContext;
  /**
   * An explicit system prompt for this turn; when absent the code-built one
   * (`buildSystemPrompt`) is used.
   */
  systemPrompt?: string;
  /**
   * Issue #812 §2 — the managed-knowledge integration settings and this turn's
   * tenant scope. When absent or unconfigured the knowledge tool is not
   * declared at all, which is the whole degradation story: no local vector
   * table, no local fallback.
   */
  knowledge?: {
    settings: KnowledgeGatewaySettings;
    scope: KnowledgeScope;
  };
  messages: InboundMessage[];
  /** Wave 5 (issue #145) — a receipt/invoice image attached to this turn only. */
  attachment?: ChatAttachment;
  /** Wave 5 extension — one or more attachments (images and/or PDFs). */
  attachments?: ChatAttachment[];
  /**
   * Wave 5 (issue #145) — the composer's "allow action in this message"
   * toggle. Only drops propose_action from this turn's own tool list; no
   * change to the confirm-before-apply architecture itself.
   */
  allowActions?: boolean;
  /**
   * Phase 31 — restricts which action types this turn may propose. Narrows the
   * tool schema the model sees AND is re-checked against the returned proposal,
   * so a hand-crafted response naming another action is refused rather than
   * treated as executable.
   */
  actionTypes?: ActionType[];
  /**
   * Phase D — a custom agent's read-tool allowlist. When present, the dashboard
   * read surface is intersected with it (see `toolDefinitions`), so the turn can
   * call only the read tools this agent was granted. Paired with `actionTypes`
   * (the agent's action allowlist) it fully scopes what the agent may do.
   */
  toolAllowlist?: string[];
  /**
   * Issue #812 §11 — App Focus. When the member has focused the turn on one
   * app, the live tool catalogue is narrowed to that app's tools plus the
   * always-on set, through the same `routeTools` the routing module exports.
   *
   * This is the narrowing the issue asks for and it has to be real: a prompt
   * line saying "focus on Accounting" is guidance the model may ignore, while a
   * catalogue without the CRM tools is a fact it cannot. `undefined`/`null`
   * means "no focus" and sends everything, which is what a turn with no app
   * context does today.
   */
  appFocus?: AppKey | null;
  /**
   * Phase F pt.2 — the turn's conversation belongs to a project, so
   * project-scoped actions (project.memory.add) join `propose_action`'s enum.
   * The ambient project id is injected by the caller, never by the model.
   */
  projectScoped?: boolean;
}): Promise<AgentReply> {
  const { config, mode, businessId, floorScope, promptContext, messages } = opts;
  const allowActions = opts.allowActions ?? true;
  const attachments = normalizeAttachments(opts.attachments, opts.attachment);
  const hasAttachment = attachments.length > 0;

  // Issue #812 §2 — the knowledge tool is declared only when the configured
  // AI-infrastructure knowledge integration is switched on and this turn
  // actually belongs to a tenant. There is no local probe and no local
  // fallback: "off" means exactly one thing, and it is not an error.
  const knowledge = opts.knowledge;
  const retrievalReady = Boolean(
    knowledge && knowledgeReadyFor(knowledge.settings, knowledge.scope.businessId),
  );

  const permissionActionTypes = opts.permissions
    ? allowedAiActions(
        opts.actionTypes ?? (opts.projectScoped ? PROJECT_ACTION_TYPES : BASE_ACTION_TYPES),
        opts.permissions,
      )
    : opts.actionTypes;
  const catalogue = toolDefinitions(mode, {
    hasAttachment,
    actionTypes: permissionActionTypes,
    retrieval: retrievalReady,
    toolAllowlist: opts.toolAllowlist,
    projectScoped: opts.projectScoped,
    // Issue #808 §8 — the wizard surface follows the business's own step list.
    industry: promptContext.industry,
  }).filter((tool) => allowActions || tool.function.name !== "propose_action");
  // Issue #812 §11 — App Focus narrows the catalogue the model can see, not
  // just the prompt. `routeTools` returns null for "no focus", so an unfocused
  // turn is byte-for-byte what it was before.
  const appRouted = opts.appFocus ? routeTools(catalogue.map((tool) => tool.function.name), [opts.appFocus]) : null;
  const appNarrowed = appRouted
    ? catalogue.filter((tool) => appRouted.includes(tool.function.name))
    : catalogue;
  // Filtering happens before provider serialization and again in the executor.
  // A newly-added tool without a registry entry therefore cannot accidentally
  // become available to a tenant member.
  const tools = opts.permissions
    ? filterAiToolsByPermissions(appNarrowed, opts.permissions)
    : appNarrowed;
  const allowedActionTypes = permissionActionTypes ? new Set<string>(permissionActionTypes) : null;
  const canPropose = tools.some((tool) => tool.function.name === "propose_action");
  const canRequestInput = tools.some((tool) => tool.function.name === "request_input");
  const allowedReadToolNames = new Set(
    tools
      .map((tool) => tool.function.name)
      .filter((name) => name !== "propose_action" && name !== "request_input"),
  );
  const toolRunner: ReadToolRunner | null =
    opts.executeReadTool ??
    (businessId
      ? (name, args) =>
          runReadTool(name, args, businessId, floorScope, opts.actorUserId, opts.permissions)
      : null);
  const usage: AiTokenUsage = { inputTokens: 0, outputTokens: 0 };
  let costUsd: number | null = null;
  const toolTrace: AgentToolCallTrace[] = [];

  const systemContent =
    opts.systemPrompt?.trim() ||
    buildSystemPrompt({ ...promptContext, hasAttachment, retrieval: retrievalReady });

  const convo: ProviderMessage[] = [
    { role: "system" as const, content: systemContent },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Issue #812 §16 — every round bills the provider before the next one
  // starts, so the accruals must survive a failure in any later round. The
  // loop is wrapped once, here, rather than at each call site: whatever throws
  // leaves carrying what it cost, and `settleAiTurn`'s per-request-id
  // idempotency keeps the eventual settlement single.
  try {
    return await runToolLoop();
  } catch (err) {
    if (usage.inputTokens > 0 || usage.outputTokens > 0 || costUsd !== null) {
      const accrual: AiTurnAccrual = { usage: { ...usage }, costUsd };
      if (err instanceof AiError) {
        err.accruedUsage = accrual;
      } else {
        try {
          (err as { accruedUsage?: AiTurnAccrual }).accruedUsage = accrual;
        } catch {
          // A frozen/sealed error object cannot carry the figure; the caller
          // then settles nothing, exactly as before this change.
        }
      }
    }
    throw err;
  }

  async function runToolLoop(): Promise<AgentReply> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callProvider(config, convo, tools, opts.stream, opts.requestId, opts.signal);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    if (result.costUsd !== null) costUsd = (costUsd ?? 0) + result.costUsd;
    const message = result.message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return {
        content: textOf(message.content).trim() || "متوجه نشدم؛ لطفاً دوباره بپرسید.",
        proposedAction: null,
        inputRequest: null,
        usage,
        costUsd,
        toolCalls: toolTrace,
      };
    }

    // A proposed action ends the turn immediately — we never auto-execute it.
    const proposal = canPropose
      ? toolCalls.find((c) => c.function.name === "propose_action")
      : undefined;
    if (proposal) {
      const parsed = toProposedAction(parseArgs(proposal.function.arguments));
      const inAllowlist = parsed && (!allowedActionTypes || allowedActionTypes.has(parsed.type));
      // Phase F pt.2 — a project-scoped action is valid only when the turn is
      // inside a project. This backstops the enum: a hand-crafted response that
      // names project.memory.add on a project-less turn is refused, not applied.
      const projectOk = parsed && (!ACTION_CATALOG[parsed.type]?.projectScoped || opts.projectScoped);
      const action = parsed && inAllowlist && projectOk ? parsed : null;
      const text = textOf(message.content).trim() || (action ? action.summary : "پیشنهاد آماده است.");
      return { content: text, proposedAction: action, inputRequest: null, usage, costUsd, toolCalls: toolTrace };
    }

    // Phase E — a structured input request also ends the turn: the model is
    // waiting on the user, so there is nothing more to generate. A malformed
    // spec (the model got the shape wrong) is dropped and the loop continues,
    // so a bad request_input degrades to an ordinary answer rather than a dead
    // turn.
    const inputCall = canRequestInput
      ? toolCalls.find((c) => c.function.name === "request_input")
      : undefined;
    if (inputCall) {
      const validation = validateInputRequest(parseArgs(inputCall.function.arguments));
      if (validation.ok) {
        const text = textOf(message.content).trim() || validation.spec.prompt;
        return {
          content: text,
          proposedAction: null,
          inputRequest: validation.spec,
          usage,
          costUsd,
          toolCalls: toolTrace,
        };
      }
      // Fall through: feed the tool an error so the model can ask again in
      // prose or fix the spec, rather than silently ending the turn.
      convo.push({ role: "assistant", content: textOf(message.content), tool_calls: toolCalls });
      convo.push({
        role: "tool",
        tool_call_id: inputCall.id,
        content: JSON.stringify({ ok: false, error: "invalid_input_request", details: validation.errors }),
      });
      continue;
    }

    // Otherwise every call must be a read tool — run them and feed results back.
    convo.push({ role: "assistant", content: textOf(message.content), tool_calls: toolCalls });
    for (const call of toolCalls) {
      let result: ToolResult;
      const callArgs = parseArgs(call.function.arguments);
      if (call.function.name === "draft_expense_from_receipt" && allowedReadToolNames.has(call.function.name)) {
        // Images still go through the isolated vision call. A PDF's text was
        // already extracted by the route and travels here — the model reads
        // the same structured draft out of it, and the same
        // "check before you propose" note applies.
        const image = attachments.find((item) => item.kind === "image" && item.dataUrl);
        const pdf = attachments.find(
          (item) => item.kind === "pdf" && typeof item.extractedText === "string" && item.extractedText,
        );
        if (image) {
          const extraction = await extractReceiptDraft(config, image.dataUrl!, opts.signal);
          usage.inputTokens += extraction.usage.inputTokens;
          usage.outputTokens += extraction.usage.outputTokens;
          if (extraction.costUsd !== null) costUsd = (costUsd ?? 0) + extraction.costUsd;
          result = extraction.fields
            ? {
                ok: true,
                data: {
                  ...extraction.fields,
                  note: "این یک استخراج خودکار و تخمینی است؛ پیش از تأیید نهایی مقادیر را با کاربر بررسی کن.",
                },
              }
            : { ok: false, data: { error: "استخراج اطلاعات از تصویر پیوست ممکن نشد؛ می‌توانی مقادیر را از کاربر بپرسی." } };
        } else if (pdf) {
          result = {
            ok: true,
            data: {
              source: "pdf",
              receiptText: pdf.extractedText,
              note: "این متن از سند PDF استخراج شده است؛ مبالغ و تاریخ را از داخل همین متن بخوان، هرگز عددی حدس نزن و پیش از پیشنهاد نهایی مقادیر را با کاربر چک کن.",
            },
          };
        } else if (attachments.some((item) => item.kind === "pdf")) {
          result = {
            ok: false,
            data: {
              error:
                "سند PDF پیوست متن قابل استخراج نداشت (احتمالاً اسکن تصویری است)؛ این را به کاربر بگو و مقادیر را از او بپرس.",
            },
          };
        } else {
          result = { ok: false, data: { error: "پیوستی برای این پیام وجود ندارد." } };
        }
      } else if (
        call.function.name === KNOWLEDGE_TOOL_NAME &&
        allowedReadToolNames.has(call.function.name) &&
        retrievalReady &&
        knowledge
      ) {
        // Issue #812 §2/§3 — the tenant is named by the server, never by the
        // model and never by the request body. Retrieval is confined to this
        // business's namespace; app/project/source are secondary filters that
        // can only narrow it.
        const fallbackQuestion = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const searchQuery =
          typeof callArgs.query === "string" && callArgs.query.trim() ? callArgs.query : fallbackQuestion;
        if (!searchQuery.trim()) {
          result = { ok: false, data: { error: "عبارت جست‌وجو خالی است." } };
        } else {
          const retrieval = await retrieveTenantKnowledge(
            knowledge.settings,
            knowledge.scope,
            searchQuery,
            { limit: callArgs.limit, signal: opts.signal },
          );
          // The retrieval's own tokens and gateway cost belong to this turn's
          // settlement, exactly as a provider round's do.
          usage.inputTokens += retrieval.inputTokens;
          if (retrieval.costUsd !== null) costUsd = (costUsd ?? 0) + retrieval.costUsd;
          result = retrieval.hits.length === 0
            ? {
                ok: true,
                data: { results: [], note: "چیزی نزدیک این عبارت در دانش این کسب‌وکار پیدا نشد." },
              }
            : {
                ok: true,
                data: { count: retrieval.hits.length, knowledge: formatKnowledgeForPrompt(retrieval.hits) },
              };
        }
      } else if (allowedReadToolNames.has(call.function.name) && toolRunner) {
        result = await toolRunner(call.function.name, callArgs);
      } else {
        result = { ok: false, data: { error: `ابزار ناشناخته: ${call.function.name}` } };
      }
      if (allowedReadToolNames.has(call.function.name)) {
        toolTrace.push(traceOf(call.function.name, callArgs));
      }
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.data),
      });
    }
    }

    return {
      content: "برای پاسخ به این درخواست به مراحل زیادی نیاز بود. لطفاً سؤال را ساده‌تر بپرسید.",
      proposedAction: null,
      inputRequest: null,
      usage,
      costUsd,
      toolCalls: toolTrace,
    };
  }
}
