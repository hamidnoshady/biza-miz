/**
 * Phase 37 & Phase 39 — the gateway half of the AI connection, kept free of the network,
 * the database and `next/*`.
 *
 * A gateway (LiteLLM) fronts many upstream vendors behind one OpenAI-shaped
 * endpoint, so the provider client in ai-service.ts never needs to learn that
 * one exists. What it *does* need is a small set of decisions made before the
 * request goes out — which credential to send and which deployed LiteLLM model
 * alias to ask for. Routing, fallback chains, provider selection and MCP are
 * LiteLLM policy and must not be mirrored into request bodies by the app.
 *
 * Branch/business scope applies to virtual-key resolution only:
 * branch key -> business key -> gateway master key -> none. Model resolution is
 * gateway alias -> platform default; historical per-business model overrides
 * are deliberately ignored.
 */

import type { AiConfig } from "./ai";

export interface AiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  /** The proxy admin key. Server-side only — never serialised to a client. */
  masterKey: string;
  /** Gateway model alias for chat; empty means "use the platform model". */
  chatModel: string;
  /** Gateway model alias for embeddings; empty means "use the chat model". */
  embeddingModel: string;
  /** Mint and use one virtual key per business or branch. */
  virtualKeysEnabled: boolean;
  /** Phase 38b — FX rate turning the gateway's USD cost figures into Rial. */
  usdRialRate: number | null;
  /** Phase 38b — settle turns on the gateway's own reported cost. */
  gatewayCostingEnabled: boolean;
  /** Manual fallback rates used only when gateway costing is disabled. */
  inputCostRialPerMillion: number;
  outputCostRialPerMillion: number;
  /**
   * Optional extra margin the platform adds on top of LiteLLM's reported cost,
   * in percent. Normally 0: cost-plus-margin pricing is configured inside
   * LiteLLM itself, and the platform only converts and decrements. Kept here
   * so an operator can still add a platform-side markup without touching the
   * gateway config.
   */
  revenueMarginPercent: number;
  /**
   * The Rial ceiling reserved from a business's credit for one assistant turn,
   * released back down to LiteLLM's actual reported cost at settlement.
   */
  maxTurnRial: number;

  // ── Issue #812: managed knowledge + Deep Research ────────────────────────
  // Both are *pointers* into the configured AI infrastructure. The app owns no
  // vector table, no embedding model choice and no research runtime of its own;
  // these settings only say where the managed one lives and what its limits are.
  /** Whether the managed knowledge integration is switched on. */
  knowledgeEnabled: boolean;
  /** The knowledge endpoint on the configured AI infrastructure. */
  knowledgeBaseUrl: string;
  /** Credential for that endpoint. Server-side only. */
  knowledgeApiKey: string;
  /** Model/alias the infrastructure embeds with; empty = its own default. */
  knowledgeModel: string;
  /** Upper bound on rows one retrieval may return. */
  knowledgeMaxResults: number;

  /** Whether Deep Research is available to tenants at all. */
  researchEnabled: boolean;
  /** LiteLLM alias the research runtime asks for. */
  researchModelAlias: string;
  /** Maximum retrieval/analysis rounds one research run may take. */
  researchMaxRounds: number;
  /** Hard ceiling on the research corpus size, bytes. */
  researchMaxContextBytes: number;
  /** Hours a research environment lives before it expires. */
  researchTtlHours: number;
  /** Per-run spend cap in Rial; 0 = no cap configured. */
  researchMaxSpendRial: number;
  /** Whether a research run may reach the public web. Off by default. */
  researchExternalWeb: boolean;
  /** Minimum usable source rows a tenant needs before research is offered. */
  researchMinDataReadiness: number;
}

/**
 * What one assistant turn cost, resolved from the gateway's own reported figure.
 *
 * `resolveGatewayTurnPricing` (ai-gateway-service.ts) reads LiteLLM's
 * `x-litellm-response-cost` header, converts the USD figure to Rial with the
 * operator's FX rate, and applies any platform margin, producing this shape;
 * `settleAiTurn` (ai-wallet-billing.ts) then decrements the wallet by
 * `chargedRial`.
 *
 * Phase J relocated this type here from the now-deleted `ai-billing-service.ts`.
 * It is a pure pricing shape (no money side effects, no schema), so it belongs
 * with the gateway's other framework-free config types rather than with the
 * legacy billing service that once also owned the credit ledger.
 */
export interface AiGatewayTurnPricing {
  costUsd: number;
  costRial: number;
  chargedRial: number;
}

/** Client-safe technical LiteLLM connection settings for `/platform/ai`. */
export interface PublicAiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  virtualKeysEnabled: boolean;
  hasMasterKey: boolean;
  /** Issue #812 — managed knowledge, safe to render (the key is masked). */
  knowledgeEnabled: boolean;
  knowledgeBaseUrl: string;
  knowledgeModel: string;
  knowledgeMaxResults: number;
  hasKnowledgeApiKey: boolean;
  /** Issue #812 — Deep Research limits, safe to render. */
  researchEnabled: boolean;
  researchModelAlias: string;
  researchMaxRounds: number;
  researchMaxContextBytes: number;
  researchTtlHours: number;
  researchMaxSpendRial: number;
  researchExternalWeb: boolean;
  researchMinDataReadiness: number;
}

export interface AiGatewayInput {
  enabled?: boolean;
  baseUrl?: string;
  masterKey?: string;
  chatModel?: string;
  embeddingModel?: string;
  virtualKeysEnabled?: boolean;
  // Issue #812 — managed knowledge + Deep Research pointers. Billing-owned
  // settings (token rates, margin, per-turn ceiling, FX) are deliberately NOT
  // accepted here: product pricing stays in Plans/Billing and joins the
  // runtime through usage settlement.
  knowledgeEnabled?: boolean;
  knowledgeBaseUrl?: string;
  knowledgeApiKey?: string;
  knowledgeModel?: string;
  knowledgeMaxResults?: number;
  researchEnabled?: boolean;
  researchModelAlias?: string;
  researchMaxRounds?: number;
  researchMaxContextBytes?: number;
  researchTtlHours?: number;
  researchMaxSpendRial?: number;
  researchExternalWeb?: boolean;
  researchMinDataReadiness?: number;
}

/** One business or branch's slice of the gateway: its key and its sync state. */
export interface BusinessGateway {
  id?: string;
  businessId: string;
  locationId: string | null;
  virtualKey: string | null;
  keyAlias: string | null;
  spendUsd: number;
  syncedAt: string | null;
  syncError: string | null;
}

/** Client-safe key-lifecycle shape: the virtual key is a bearer credential and stays server-side. */
export interface PublicBusinessGateway {
  id?: string;
  businessId: string;
  locationId: string | null;
  keyAlias: string | null;
  syncedAt: string | null;
  syncError: string | null;
  hasVirtualKey: boolean;
  /** Which gateway/platform model alias tenant calls resolve to. */
  effectiveModel: string;
}

export type GatewayProbeStageKey =
  | "server"
  | "auth"
  | "model_alias"
  | "master_completion"
  | "virtual_key_completion";

export interface GatewayProbeStage {
  key: GatewayProbeStageKey;
  label: string;
  ok: boolean;
  skipped?: boolean;
  status: number | null;
  model: string | null;
  message: string | null;
  detail: string | null;
}

export interface GatewayProbe {
  ok: boolean;
  /** Wall-clock milliseconds for the whole diagnostic. */
  latencyMs: number | null;
  /** Model aliases the gateway is serving, when the admin key allowed listing them. */
  models: string[];
  /** A short, human-readable failure reason — Persian, shown verbatim in the console. */
  error: string | null;
  stages: GatewayProbeStage[];
}

// ---------------------------------------------------------------------------
// Defaults and coercion
// ---------------------------------------------------------------------------

export const DEFAULT_GATEWAY_BASE_URL = "http://litellm:4000/v1";

export function defaultGatewayConfig(): AiGatewayConfig {
  return {
    enabled: false,
    baseUrl: DEFAULT_GATEWAY_BASE_URL,
    masterKey: "",
    chatModel: "",
    embeddingModel: "",
    virtualKeysEnabled: false,
    usdRialRate: null,
    gatewayCostingEnabled: false,
    inputCostRialPerMillion: 0,
    outputCostRialPerMillion: 0,
    revenueMarginPercent: 0,
    maxTurnRial: 0,
    knowledgeEnabled: false,
    knowledgeBaseUrl: "",
    knowledgeApiKey: "",
    knowledgeModel: "",
    knowledgeMaxResults: 8,
    researchEnabled: false,
    researchModelAlias: "",
    researchMaxRounds: 12,
    researchMaxContextBytes: 2_000_000,
    researchTtlHours: 24,
    researchMaxSpendRial: 0,
    researchExternalWeb: false,
    researchMinDataReadiness: 1,
  };
}

export function emptyBusinessGateway(businessId: string, locationId: string | null = null): BusinessGateway {
  return {
    businessId,
    locationId,
    virtualKey: null,
    keyAlias: null,
    spendUsd: 0,
    syncedAt: null,
    syncError: null,
  };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * LiteLLM's per-response cost header, in USD.
 */
export function parseResponseCostHeader(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** The gateway's USD figure in integer Rial, rounded once, never negative. */
export function rialFromGatewayUsd(costUsd: number, usdRialRate: number): number {
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const rate = Number.isFinite(usdRialRate) && usdRialRate > 0 ? usdRialRate : 0;
  if (cost <= 0 || rate <= 0) return 0;
  return Math.ceil(cost * rate);
}

/**
 * The settlement figures for one turn priced by the gateway.
 */
export function gatewayTurnPricing(
  costUsd: number,
  usdRialRate: number,
  marginPercent: number,
): { costRial: number; chargedRial: number } {
  const costRial = rialFromGatewayUsd(costUsd, usdRialRate);
  if (costRial <= 0) return { costRial: 0, chargedRial: 0 };
  const margin = Number.isFinite(marginPercent) && marginPercent > 0 ? marginPercent : 0;
  const chargedRial = Math.ceil((costRial * (100 + margin)) / 100);
  return { costRial, chargedRial: Math.max(chargedRial, costRial) };
}

export function toPublicGatewayConfig(config: AiGatewayConfig): PublicAiGatewayConfig {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
    virtualKeysEnabled: config.virtualKeysEnabled,
    hasMasterKey: config.masterKey.length > 0,
    knowledgeEnabled: config.knowledgeEnabled,
    knowledgeBaseUrl: config.knowledgeBaseUrl,
    knowledgeModel: config.knowledgeModel,
    knowledgeMaxResults: config.knowledgeMaxResults,
    hasKnowledgeApiKey: config.knowledgeApiKey.length > 0,
    researchEnabled: config.researchEnabled,
    researchModelAlias: config.researchModelAlias,
    researchMaxRounds: config.researchMaxRounds,
    researchMaxContextBytes: config.researchMaxContextBytes,
    researchTtlHours: config.researchTtlHours,
    researchMaxSpendRial: config.researchMaxSpendRial,
    researchExternalWeb: config.researchExternalWeb,
    researchMinDataReadiness: config.researchMinDataReadiness,
  };
}

// ---------------------------------------------------------------------------
// Gateway REST endpoints
// ---------------------------------------------------------------------------

export function gatewayManagementUrl(baseUrl: string): string {
  const root = trimmed(baseUrl).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root.slice(0, -3) : root;
}

export function livelinessUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/health/liveliness`;
}

export function modelInfoUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/model/info`;
}

export function keyGenerateUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/generate`;
}

export function keyUpdateUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/update`;
}

export function keyDeleteUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/delete`;
}

export function keyInfoUrl(baseUrl: string, key: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/info?key=${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// Parsing gateway responses
// ---------------------------------------------------------------------------

/** `/model/info` returns `{ data: [{ model_name, litellm_params }] }`. */
export function parseGatewayModels(payload: unknown): string[] {
  const row = payload as { data?: unknown } | null;
  const data = row?.data;
  if (!Array.isArray(data)) return [];
  const names = data
    .map((entry) => {
      const item = entry as { model_name?: unknown; id?: unknown };
      if (typeof item.model_name === "string" && item.model_name.trim()) return item.model_name.trim();
      if (typeof item.id === "string" && item.id.trim()) return item.id.trim();
      return "";
    })
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** `/key/generate` answers `{ key: "sk-…", … }`. */
export function parseGeneratedKey(payload: unknown): string | null {
  // LiteLLM has returned both `{key}` and `{token}` over its releases. Some
  // OpenAI-compatible deployments wrap the management response in `data`, so
  // accept that shape too rather than reporting a successful request as a
  // missing key.
  const row = payload as Record<string, unknown> | null;
  if (!row || typeof row !== "object") return null;
  for (const source of [row, row.data as Record<string, unknown> | undefined]) {
    if (!source || typeof source !== "object") continue;
    for (const field of ["key", "token", "api_key"]) {
      const value = source[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/** `/key/info` answers `{ key, info: { spend, max_budget } }`. */
export function parseKeySpend(payload: unknown): {
  spendUsd: number;
  maxBudgetUsd: number | null;
} | null {
  const row = payload as { info?: unknown } | null;
  const source = (row?.info && typeof row.info === "object" ? row.info : row) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!source) return null;
  const spend = Number(source.spend);
  if (!Number.isFinite(spend)) return null;
  const budget = source.max_budget;
  const budgetNumber = typeof budget === "number" ? budget : Number(budget);
  return {
    spendUsd: spend,
    maxBudgetUsd:
      typeof budgetNumber === "number" && Number.isFinite(budgetNumber) && budgetNumber > 0
        ? budgetNumber
        : null,
  };
}

/** Map a management-API status onto a Persian message shown in the console. */
export function gatewayStatusMessage(status: number): string {
  if (status === 401 || status === 403) return "کلید مدیر دروازه پذیرفته نشد.";
  if (status === 404) return "نشانی دروازه یافت نشد (مسیر مدیریت در دسترس نیست).";
  if (status >= 500) return "دروازه در دسترس است اما خطای داخلی داد.";
  return `دروازه پاسخ نامنتظر داد (${status}).`;
}

// ---------------------------------------------------------------------------
// The operator-facing error vocabulary
// ---------------------------------------------------------------------------

/**
 * Persian text for every `ai_gateway_*` code the console can be shown: the
 * codes minted by the gateway calls (`unreachable`, `auth`, …), the ones the
 * service throws when a response cannot be parsed, the validation codes from
 * `validateGatewayInput`, and the pre-flight codes the console route answers
 * before it will even try to mint a key.
 *
 * One table for server and client: the service composes the `sync_error` text
 * stored on a business's row from it, and the console's `errorMessage()`
 * consults it as a fallback so a code never reaches an operator untranslated.
 * A code without an entry here is a bug — `gatewayErrorText` returns
 * `undefined` for it so the console falls back to its generic message rather
 * than showing the raw code.
 */
export const GATEWAY_ERROR_TEXT: Record<string, string> = {
  // Pre-flight: the console route refuses to mint before any network call,
  // because each of these states would produce a key that cannot work (or,
  // for the master key, a call the proxy is guaranteed to refuse).
  ai_gateway_disabled:
    "دروازهٔ هوش مصنوعی فعال نیست. ابتدا آن را در «تنظیمات دروازه» همین صفحه روشن کرده و ذخیره کنید.",
  ai_gateway_missing_master_key:
    "کلید مدیر دروازه ثبت نشده است. آن را در «تنظیمات دروازه» وارد و ذخیره کنید؛ بدون کلید مدیر، دروازه اجازهٔ صدور کلید نمی‌دهد.",
  ai_gateway_virtual_keys_disabled:
    "صدور کلید مجازی در تنظیمات دروازه خاموش است. گزینهٔ «صدور کلید مجازی برای هر کسب‌وکار و شعبه» را روشن کنید تا کلید صادرشده واقعاً به‌کار گرفته شود.",
  // The management calls themselves.
  ai_gateway_unreachable:
    "دروازه در دسترس نیست. نشانی دروازه را در «تنظیمات دروازه» بررسی کنید و مطمئن شوید سرویس LiteLLM در حال اجراست و از سرورِ برنامه قابل دسترسی است.",
  ai_gateway_auth: "کلید مدیر دروازه پذیرفته نشد؛ مقدار آن را در «تنظیمات دروازه» بررسی کنید.",
  ai_gateway_error: "دروازه پاسخ خطا داد؛ جزئیات دروازه را در پیام خطا ببینید.",
  ai_gateway_bad_response: "پاسخ دروازه قابل خواندن نبود و کلیدی در آن یافت نشد.",
  // Validation of the technical gateway settings form.
  ai_gateway_bad_base_url: "نشانی دروازه باید یک نشانی http یا https معتبر باشد.",
  ai_gateway_missing_chat_model: "نام مستعار مدل گفت‌وگو الزامی است.",
  // Business ↔ branch integrity (issue #748).
  ai_gateway_location_business_mismatch:
    "شعبهٔ انتخاب‌شده متعلق به این کسب‌وکار نیست؛ عملیات انجام نشد.",
  // Revoke/rotate lifecycle safety (issue #748).
  ai_gateway_revoke_failed:
    "ابطال کلید مجازی در LiteLLM ناموفق بود؛ کلید فعلی برای حفظ ایمنی دست‌نخورده باقی ماند. دوباره تلاش کنید.",
};

/** The console translation of one `ai_gateway_*` code, when it has one. */
export function gatewayErrorText(code: string | null | undefined): string | undefined {
  return GATEWAY_ERROR_TEXT[code ?? ""];
}

/**
 * The proxy's own explanation of a failure, when it sent one. LiteLLM answers
 * in OpenAI's shape (`error.message`), FastAPI's (`detail`), or a plain string
 * — all three are read so the operator sees the *why* the proxy reported, not
 * just the status number. Long bodies are truncated; this is a console line.
 */
export function parseGatewayErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  const error = row.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
  }
  const detail = row.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 240);
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).msg;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
    }
  }
  return null;
}

/** Attach the proxy's own explanation to a console message. */
export function joinGatewayDetail(message: string, detail: string | null | undefined): string {
  return detail ? `${message} — ${detail}` : message;
}

// ---------------------------------------------------------------------------
// Per-call resolution
// ---------------------------------------------------------------------------

/**
 * The chat model for one call.
 * Precedence: gateway alias -> platform default. Historical business/branch
 * model overrides are intentionally ignored; LiteLLM owns model access policy.
 */
export function resolveChatModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
}): string {
  const { platformModel, gateway } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const alias = trimmed(gateway.chatModel);
  return alias || platformModel;
}

/**
 * The embedding model for one call. Falls through to the chat model.
 */
export function resolveEmbeddingModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
}): string {
  const { platformModel, gateway } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const alias = trimmed(gateway.embeddingModel);
  return alias || trimmed(gateway.chatModel) || platformModel;
}

/**
 * The credential for one call.
 * Precedence: Branch virtual key -> Business virtual key -> Gateway master key -> undefined.
 */
export function resolveGatewayAuthKey(input: {
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
  /** Tenant calls must not fall back to a shared master key when virtual keys are enabled. */
  tenantScoped?: boolean;
}): string | undefined {
  const { gateway, business, branch } = input;
  if (!gateway || !gateway.enabled) return undefined;
  if (gateway.virtualKeysEnabled) {
    if (trimmed(branch?.virtualKey)) return trimmed(branch?.virtualKey);
    if (trimmed(business?.virtualKey)) return trimmed(business?.virtualKey);
    if (input.tenantScoped) return undefined;
  }
  if (trimmed(gateway.masterKey)) return trimmed(gateway.masterKey);
  return undefined;
}

/** LiteLLM `key_alias` for a business or branch — stable, short and traceable. */
export function virtualKeyAlias(businessId: string, locationId?: string | null): string {
  const b = businessId.replace(/-/g, "").slice(0, 16);
  if (locationId) {
    const loc = locationId.replace(/-/g, "").slice(0, 8);
    return `pos-${b}-${loc}`;
  }
  return `pos-${b}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGatewayInput(input: AiGatewayInput): string[] {
  const errors: string[] = [];
  const base = trimmed(input.baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) errors.push("ai_gateway_bad_base_url");

  if (input.enabled === true) {
    if (!trimmed(input.chatModel)) errors.push("ai_gateway_missing_chat_model");
  }

  // Issue #812 — an enabled managed-knowledge integration must actually point
  // somewhere, or every retrieval silently returns nothing and the operator has
  // no way to tell that from "no matching knowledge".
  if (input.knowledgeEnabled === true) {
    if (!/^https?:\/\/.+/i.test(trimmed(input.knowledgeBaseUrl))) {
      errors.push("ai_gateway_bad_knowledge_base_url");
    }
    if (!trimmed(input.knowledgeApiKey)) errors.push("ai_gateway_missing_knowledge_api_key");
  }

  if (input.researchEnabled === true && !input.knowledgeEnabled) {
    errors.push("ai_gateway_research_requires_knowledge");
  }

  if (input.researchMaxRounds !== undefined && (!Number.isInteger(input.researchMaxRounds) || input.researchMaxRounds < 1 || input.researchMaxRounds > 200)) {
    errors.push("ai_gateway_bad_research_max_rounds");
  }
  if (input.researchMaxContextBytes !== undefined && (!Number.isInteger(input.researchMaxContextBytes) || input.researchMaxContextBytes < 1024)) {
    errors.push("ai_gateway_bad_research_max_context_bytes");
  }
  if (input.researchTtlHours !== undefined && (!Number.isInteger(input.researchTtlHours) || input.researchTtlHours < 1 || input.researchTtlHours > 720)) {
    errors.push("ai_gateway_bad_research_ttl_hours");
  }
  if (input.knowledgeMaxResults !== undefined && (!Number.isInteger(input.knowledgeMaxResults) || input.knowledgeMaxResults < 1 || input.knowledgeMaxResults > 50)) {
    errors.push("ai_gateway_bad_knowledge_max_results");
  }
  return errors;
}

export function isGatewayActive(gateway: AiGatewayConfig | null | undefined): boolean {
  return Boolean(gateway?.enabled) && Boolean(trimmed(gateway?.baseUrl));
}

export function buildGatewayRuntime(input: {
  config: AiConfig;
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
  tenantScoped?: boolean;
}): {
  model: string;
  embeddingModel: string;
  authKey?: string;
  body: Record<string, unknown>;
  virtualKeyResolved: boolean;
} | undefined {
  if (!input.gateway || !isGatewayActive(input.gateway)) return undefined;
  const gateway = input.gateway;
  // Reserved extension point for a future, explicitly-adopted request-body
  // addition; core chat sends nothing extra. Routing, retries, provider
  // fallback and MCP declarations are LiteLLM policy and must never be
  // mirrored into the request body from here.
  const body: Record<string, unknown> = {};
  return {
    model: resolveChatModel({
      platformModel: input.config.model,
      gateway,
      business: input.business,
      branch: input.branch,
    }),
    embeddingModel: resolveEmbeddingModel({
      platformModel: input.config.model,
      gateway,
    }),
    virtualKeyResolved: Boolean(trimmed(input.branch?.virtualKey) || trimmed(input.business?.virtualKey)),
    ...(() => {
      const key = resolveGatewayAuthKey({ gateway, business: input.business, branch: input.branch, tenantScoped: input.tenantScoped });
      return key ? { authKey: key } : {};
    })(),
    body,
  };
}
