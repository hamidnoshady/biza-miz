/**
 * Phase 37 & Phase 39 — the gateway half of the AI connection, kept free of the network,
 * the database and `next/*`.
 *
 * A gateway (LiteLLM) fronts many upstream vendors behind one OpenAI-shaped
 * endpoint, so the provider client in ai-service.ts never needs to learn that
 * one exists. What it *does* need is a small set of decisions made before the
 * request goes out — which credential to send and which deployed LiteLLM model
 * alias to ask for. LiteLLM owns upstream selection, routing, retries and
 * fallback policy; the app does not mirror those settings into requests. The
 * POS `/api/mcp` connector is independent and is not LiteLLM proxy MCP.
 *
 * Branch/business scope applies to virtual-key resolution only: when tenant
 * virtual keys are enabled, branch key -> business key -> none (never the
 * shared master key); otherwise the gateway master key is used. Model
 * resolution is gateway alias -> platform default; historical per-business
 * model overrides are deliberately ignored.
 */

import type { AiConfig } from "./ai";

/**
 * The state of a stored AI credential (issue #757 §B).
 *
 * - `absent`        — nothing is stored: the credential was never registered,
 *                     or it was revoked and its record removed.
 * - `present`       — a credential is stored and this deployment's key
 *                     decrypts it, so it is usable.
 * - `undecryptable` — a credential IS stored, but it cannot be decrypted
 *                     (a rotated `INTEGRATIONS_ENCRYPTION_KEY` / `JWT_SECRET`,
 *                     or a corrupted ciphertext).
 *
 * The third state is the reason this type exists: "stored but unreadable" is
 * NOT "absent". Treating it as absent would let the platform mint a
 * replacement credential while the original one is still live inside
 * LiteLLM — an orphaned credential nobody knows about and nobody can revoke.
 */
export type CredentialState = "absent" | "present" | "undecryptable";

export interface AiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  /** The proxy admin key. Server-side only — never serialised to a client. */
  masterKey: string;
  /**
   * Whether the master credential is absent, usable, or stored-but-
   * undecryptable. Never derive this from `masterKey.length`: an
   * undecryptable credential decrypts to an empty string.
   */
  masterKeyState: CredentialState;
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

  // ── Managed knowledge + app-owned Deep Research ─────────────────────────
  // Knowledge retrieval calls an optional external endpoint; the app keeps no
  // local vector store/index. Deep Research orchestration is app-owned, with a
  // LiteLLM alias and platform-configured limits.
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
  /** A master credential is stored (usable or not) — never the credential itself. */
  hasMasterKey: boolean;
  /**
   * Whether the stored master credential can actually be used. An
   * `undecryptable` credential must be shown as "needs recovery", never as
   * "not registered": the operator has to restore the deployment key, not
   * enter a new one.
   */
  masterKeyState: CredentialState;
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
  /**
   * Whether a credential is stored for this row and whether it can be read.
   * `undecryptable` means a credential exists but this deployment cannot
   * decrypt it — the row must be kept (it is the only memory of a possibly
   * live LiteLLM key) and never silently replaced.
   */
  credentialState: CredentialState;
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
  /** A virtual key is stored for this row (usable or not) — never the key itself. */
  hasVirtualKey: boolean;
  /** Whether the stored credential can actually be used. */
  credentialState: CredentialState;
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
    masterKeyState: "absent",
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
    credentialState: "absent",
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
    // Derived from the *stored* credential, not from the decrypted value: a
    // credential that cannot be decrypted is still a credential the operator
    // has to recover, and hiding it would invite a replacement that orphans
    // the live one.
    hasMasterKey: config.masterKeyState !== "absent",
    masterKeyState: config.masterKeyState,
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
// Deleting a virtual key: what the proxy's answer actually proves
// ---------------------------------------------------------------------------

/**
 * What a `/key/delete` response proves about the credential it was asked to
 * remove.
 *
 * - `deleted`       — the proxy confirmed it removed exactly this credential.
 * - `already_absent`— the proxy confirmed the credential was not there.
 * - `unconfirmed`   — the response proves nothing at all.
 *
 * The local `ai_business_gateway` row is the platform's only memory of which
 * credential is live, so `unconfirmed` must keep it. Deleting the row on
 * anything weaker is how a credential gets orphaned inside LiteLLM: still
 * valid, still billable, and unknown to everybody.
 */
export type KeyDeleteOutcome = "deleted" | "already_absent" | "unconfirmed";

export interface KeyDeleteClassification {
  outcome: KeyDeleteOutcome;
  /** A short, secret-free explanation for the console and the audit trail. */
  reason: string;
}

/**
 * LiteLLM's own wording for "this key is not in the proxy's key table".
 *
 * `/key/delete` raises `404 {"error": "No keys found"}` when the key does not
 * exist, and `/key/info` raises `404 {"error": {"message": "Key not found in
 * database"}}`. A *route* miss answers `{"detail": "Not Found"}` instead —
 * which says nothing at all about the key, and must never be read as "the
 * key is gone".
 */
const KEY_ABSENT_PATTERNS = [
  /no\s+keys?\s+found/i,
  /key[^.]*\bnot\s+found\b/i,
  /\bnot\s+found\s+in\s+database\b/i,
];

/**
 * The proxy's explanation when it says the key itself is missing, or null
 * when it said something else (including "the endpoint does not exist").
 */
export function keyAbsentSignal(body: unknown): string | null {
  const detail = parseGatewayErrorDetail(body);
  if (!detail) return null;
  return KEY_ABSENT_PATTERNS.some((pattern) => pattern.test(detail)) ? detail : null;
}

/**
 * The `deleted_keys` list of a `/key/delete` response, or null when the body
 * is not the documented shape at all.
 */
function deletedKeysFromResponse(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const list = (body as { deleted_keys?: unknown }).deleted_keys;
  if (!Array.isArray(list)) return null;
  return list.filter((item): item is string => typeof item === "string");
}

/**
 * Decide what LiteLLM's `/key/delete` answer means for ONE credential.
 *
 * The rule is deliberately narrow, because the consequence of being wrong is
 * asymmetric: a false "deleted" orphans a live credential, while a false
 * "unconfirmed" only asks the operator to try again.
 *
 * - **deleted** — a 2xx whose body is the documented `{ deleted_keys: [...] }`
 *   shape *and* names the credential we asked it to remove.
 * - **already_absent** — a 404 whose explanation is about the key itself
 *   ("No keys found", "Key … not found").
 * - **unconfirmed** — everything else: a 2xx with an unreadable body, a 2xx
 *   whose `deleted_keys` does not name our credential (an empty list
 *   included), a 404 that is really a missing route, and every other status.
 *
 * An error response that happens to carry `deleted_keys: []` is *not* a
 * deletion: the status says the request failed, and the body never named the
 * credential. Treating it as one is exactly the bug this function exists to
 * prevent.
 */
export function classifyKeyDeleteResponse(input: {
  status: number;
  body: unknown;
  /** The credential the request asked the proxy to remove (key value or alias). */
  target: string;
}): KeyDeleteClassification {
  const { status, body, target } = input;
  const wanted = target.trim();

  if (status >= 200 && status < 300) {
    const deleted = deletedKeysFromResponse(body);
    if (!deleted) {
      return { outcome: "unconfirmed", reason: "پاسخ حذف کلید در LiteLLM قابل تفسیر نبود." };
    }
    if (wanted && deleted.some((key) => key.trim() === wanted)) {
      return { outcome: "deleted", reason: "LiteLLM حذف کلید را تأیید کرد." };
    }
    return {
      outcome: "unconfirmed",
      reason: "پاسخ حذف کلید، کلید درخواستی را نام نبرد؛ حذف تأیید نشد.",
    };
  }

  if (status === 404) {
    const absent = keyAbsentSignal(body);
    if (absent) {
      return { outcome: "already_absent", reason: "LiteLLM گفت کلید از پیش در دروازه وجود ندارد." };
    }
    return {
      outcome: "unconfirmed",
      reason: "دروازه ۴۰۴ داد اما دربارهٔ وضعیت همین کلید توضیحی نداد؛ حذف تأیید نشد.",
    };
  }

  return { outcome: "unconfirmed", reason: `دروازه پاسخ خطا داد (${status})؛ حذف تأیید نشد.` };
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
  // A stored credential that this deployment cannot decrypt (issue #757 §B).
  ai_gateway_credential_undecryptable:
    "کلید ذخیره‌شده قابل رمزگشایی نیست؛ کلید رمزگشایی این استقرار (INTEGRATIONS_ENCRYPTION_KEY یا JWT_SECRET) تغییر کرده یا نامعتبر است. تا بازیابی آن، هیچ کلید تازه‌ای صادر نمی‌شود تا اعتبارنامهٔ موجود در LiteLLM بلااستفاده و فراموش‌شده باقی نماند.",
  ai_gateway_credential_recovery_required:
    "بازیابی اعتبارنامه لازم است: کلید ذخیره‌شده قابل رمزگشایی نیست. ابتدا کلید رمزگشایی استقرار را بازیابی کنید یا اعتبارنامه را در LiteLLM با alias ثبت‌شده باطل کنید.",
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

/** Which stored row a call's credential actually came from, or `"none"` when nothing usable exists. */
export type GatewayCredentialSource = "branch" | "business" | "master" | "none";

/**
 * The one place that decides which stored row a call's credential actually
 * comes from, and the one place `resolveGatewayAuthKey` and the platform
 * console's readiness projection (`/platform/ai` route) both have to agree
 * with (issue #757 follow-up — effective-source mismatch).
 *
 * This is a decision about *usability*, not about whether a row exists: a
 * branch row whose credential is stored but undecryptable (issue #757 §B)
 * has `branch.virtualKey === null`, exactly like a branch with no row at
 * all, so it is correctly skipped in favour of a usable business key. Every
 * caller that needs to show *why* — "this branch's key needs recovery" vs
 * "this branch never had its own key" — reads that from the row's own
 * `credentialState`, never from this decision; mixing the two is what used
 * to make the console claim a branch's stored-but-broken credential was the
 * one in effect, when a perfectly usable business key would actually have
 * served the call.
 */
export function resolveEffectiveCredentialSource(input: {
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
  /** Tenant calls must not fall back to a shared master key when virtual keys are enabled. */
  tenantScoped?: boolean;
}): { source: GatewayCredentialSource; key?: string; row: BusinessGateway | null } {
  const { gateway, business, branch } = input;
  if (!gateway || !gateway.enabled) return { source: "none", row: null };
  if (gateway.virtualKeysEnabled) {
    const branchKey = trimmed(branch?.virtualKey);
    if (branchKey) return { source: "branch", key: branchKey, row: branch ?? null };
    const businessKey = trimmed(business?.virtualKey);
    if (businessKey) return { source: "business", key: businessKey, row: business ?? null };
    if (input.tenantScoped) return { source: "none", row: null };
  }
  const masterKey = trimmed(gateway.masterKey);
  if (masterKey) return { source: "master", key: masterKey, row: null };
  return { source: "none", row: null };
}

/**
 * The credential for one call. With virtual keys enabled, tenant calls use
 * branch key -> business key -> undefined (the master key is never a tenant
 * fallback); other calls use the gateway master key.
 */
export function resolveGatewayAuthKey(input: {
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
  /** Tenant calls must not fall back to a shared master key when virtual keys are enabled. */
  tenantScoped?: boolean;
}): string | undefined {
  return resolveEffectiveCredentialSource(input).key;
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
  /**
   * A branch or business credential is *stored* for this tenant but cannot be
   * decrypted by this deployment (issue #757 §B) — distinct from "no
   * credential was ever issued". The caller reports this with its own
   * runtime-unavailable reason rather than the generic "missing" one, so an
   * operator is pointed at key recovery instead of re-provisioning.
   */
  credentialUndecryptable: boolean;
} | undefined {
  if (!input.gateway || !isGatewayActive(input.gateway)) return undefined;
  const gateway = input.gateway;
  // Reserved extension point for a future, explicitly-adopted request-body
  // addition; core chat sends nothing extra. Routing, retries and provider
  // fallback belong to LiteLLM and must never be mirrored from here. The POS
  // `/api/mcp` connector is separate; proxy MCP declarations are not sent.
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
    credentialUndecryptable:
      input.branch?.credentialState === "undecryptable" || input.business?.credentialState === "undecryptable",
    ...(() => {
      const key = resolveGatewayAuthKey({ gateway, business: input.business, branch: input.branch, tenantScoped: input.tenantScoped });
      return key ? { authKey: key } : {};
    })(),
    body,
  };
}
