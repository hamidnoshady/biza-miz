/**
 * Issue #812 §2/§3 — tenant-isolated knowledge, through the configured AI
 * infrastructure.
 *
 * The application used to own a pgvector table (`ai_embeddings`, migration
 * 0113) and a similarity search of its own. That is gone: chunking, embeddings,
 * indexing and vector health belong to LiteLLM / the configured AI
 * infrastructure, not to this codebase, and a second vector stack beside the
 * gateway is exactly the duplication this issue retires.
 *
 * What this module is instead is the *client half* of the managed knowledge
 * integration, and it holds the one rule that cannot move to the gateway:
 *
 *   **Every request names the tenant.**
 *
 * The business id is resolved server-side from the session and is sent as the
 * namespace/path segment AND in the request metadata, so a gateway configured
 * for per-tenant partitioning can only ever answer inside the caller's own
 * namespace. It is never taken from the model, from a request body, or from a
 * client-supplied id. There is no cross-tenant code path here at all — the
 * only way to ask is to name the business you are.
 *
 * Secondary partitioning (branch, app, project, source type, document id) is
 * metadata the caller MAY add; it narrows a search, it never widens one, and it
 * is meaningless without the tenant segment.
 *
 * Degradation: when the integration is not configured, or the gateway answers
 * with an error, retrieval is simply absent for that turn — the same "off"
 * behaviour the old pgvector probe had, with no local fallback table and no
 * failed answer.
 */
import { parseResponseCostHeader } from "./ai-gateway";
import type { AiConfig } from "./ai";

/** The managed-knowledge settings, as the platform console stores them. */
export interface KnowledgeGatewaySettings {
  enabled: boolean;
  /** The configured AI-infrastructure knowledge endpoint (LiteLLM or equivalent). */
  baseUrl: string;
  /** The credential for that endpoint. Never rendered, only sent. */
  apiKey: string;
  /** Optional model/alias the infrastructure should embed with. */
  model: string;
  /** Upper bound on rows one retrieval may return. */
  maxResults: number;
}

/** Metadata partitioning. Everything here is secondary to the tenant segment. */
export interface KnowledgeScope {
  /** The tenant. Required. Resolved from the session, never from a caller. */
  businessId: string;
  locationId?: string | null;
  /** One of the four registry keys, or null for "all apps". */
  appKey?: string | null;
  projectId?: string | null;
  /** e.g. "help" | "policy" | "item" | "project_note". */
  sourceType?: string | null;
  /** A specific source document, when the caller already knows it. */
  sourceRef?: string | null;
}

/** One retrieved chunk, with the reference that makes it checkable. */
export interface KnowledgeHit {
  sourceType: string;
  sourceRef: string;
  /** Names the source — which item, which note, which help page. */
  title: string;
  content: string;
  similarity: number | null;
}

export interface KnowledgeRetrieval {
  hits: KnowledgeHit[];
  /** Prompt tokens the embedding cost, when the gateway reported them. */
  inputTokens: number;
  /** The gateway's own cost figure for the retrieval, USD, when it sent one. */
  costUsd: number | null;
}

const KNOWLEDGE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 50;

/** Clamps a caller-supplied limit into the configured window. */
export function clampKnowledgeLimit(limit: unknown, configured: number): number {
  const ceiling = Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(configured) || DEFAULT_MAX_RESULTS));
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : ceiling;
  if (n < 1) return 1;
  return Math.min(n, ceiling);
}

/** Whether the managed-knowledge integration is usable at all. */
export function isKnowledgeGatewayConfigured(settings: KnowledgeGatewaySettings): boolean {
  return Boolean(settings.enabled && settings.baseUrl.trim() && settings.apiKey.trim());
}

function knowledgeUrl(baseUrl: string, businessId: string): string {
  // The tenant is a PATH SEGMENT, not a query parameter: a gateway that
  // partitions by namespace then cannot serve a request that forgot to name
  // one, and a mistaken prefix is a 404 rather than another tenant's rows.
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(businessId)}/search`;
}

function scopeMetadata(scope: KnowledgeScope): Record<string, string> {
  const metadata: Record<string, string> = {
    // The tenant, stated twice on purpose: path segment and metadata. A
    // gateway reading either one alone still lands in the right namespace.
    business_id: scope.businessId,
  };
  if (scope.locationId) metadata.location_id = scope.locationId;
  if (scope.appKey) metadata.app_key = scope.appKey;
  if (scope.projectId) metadata.project_id = scope.projectId;
  if (scope.sourceType) metadata.source_type = scope.sourceType;
  if (scope.sourceRef) metadata.source_ref = scope.sourceRef;
  return metadata;
}

function toHits(raw: unknown): KnowledgeHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: KnowledgeHit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const content = typeof row.content === "string" ? row.content : "";
    if (!content.trim()) continue;
    const similarity = typeof row.similarity === "number" && Number.isFinite(row.similarity)
      ? row.similarity
      : null;
    hits.push({
      sourceType: typeof row.sourceType === "string" ? row.sourceType : typeof row.kind === "string" ? row.kind : "",
      sourceRef: typeof row.sourceRef === "string" ? row.sourceRef : typeof row.refId === "string" ? row.refId : "",
      title: typeof row.title === "string" ? row.title : typeof row.sourceLabel === "string" ? row.sourceLabel : "",
      content,
      similarity,
    });
  }
  return hits;
}

/**
 * Renders retrieved knowledge for the model. Every line **names its source**,
 * so a grounded answer can be traced back to the row it came from — an answer
 * an owner cannot check is an answer they cannot trust.
 */
export function formatKnowledgeForPrompt(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((hit, index) => {
    const label = hit.title || hit.sourceRef || hit.sourceType || "منبع";
    return `${index + 1}. [${hit.sourceType || "دانش"}: ${label}] ${hit.content}`;
  });
  return `دانش بازیابی‌شده از داده‌های همین کسب‌وکار (منبع هر مورد ذکر شده است):\n${lines.join("\n")}`;
}

/**
 * Asks the configured AI infrastructure for this tenant's knowledge.
 *
 * Never throws. Any failure — unconfigured, network, timeout, malformed
 * response — is an empty retrieval, which the caller renders as "no knowledge
 * available" rather than a failed turn. A retrieval failure must never take an
 * answer down with it.
 */
export async function retrieveTenantKnowledge(
  settings: KnowledgeGatewaySettings,
  scope: KnowledgeScope,
  query: string,
  options: { limit?: unknown; signal?: AbortSignal } = {},
): Promise<KnowledgeRetrieval> {
  const empty: KnowledgeRetrieval = { hits: [], inputTokens: 0, costUsd: null };
  if (!isKnowledgeGatewayConfigured(settings)) return empty;
  if (!scope.businessId?.trim()) return empty;
  if (!query.trim()) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KNOWLEDGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  try {
    const response = await fetch(knowledgeUrl(settings.baseUrl, scope.businessId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        query,
        limit: clampKnowledgeLimit(options.limit, settings.maxResults),
        ...(settings.model.trim() ? { model: settings.model.trim() } : {}),
        // The tenant identity travels as metadata too, so a gateway configured
        // to partition on it cannot answer from another business's namespace.
        metadata: scopeMetadata(scope),
      }),
      signal,
    });
    if (!response.ok) return empty;

    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return empty;

    const usage = (json.usage ?? {}) as Record<string, unknown>;
    const inputTokens = Number(usage.inputTokens ?? usage.promptTokens ?? usage.totalTokens ?? 0);
    return {
      hits: toHits(json.hits ?? json.results ?? json.data),
      inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.floor(inputTokens) : 0,
      costUsd: parseResponseCostHeader(response.headers.get("x-litellm-response-cost")),
    };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the runtime should declare the knowledge tool for a turn. Probes the
 * platform settings only — there is no local extension to check any more, so
 * "off" means exactly one thing: the integration is not configured.
 */
export function knowledgeReadyFor(settings: KnowledgeGatewaySettings, businessId?: string | null): boolean {
  return Boolean(businessId) && isKnowledgeGatewayConfigured(settings);
}

/**
 * The gateway runtime for one call, resolved from the platform config. Kept as
 * a separate function so the settings row's decryption lives beside the rest of
 * the gateway's secret handling and a caller cannot accidentally invent a key.
 */
export function knowledgeSettingsFromConfig(config: AiConfig): KnowledgeGatewaySettings {
  // Deliberately NOT `config.knowledge ?? {}`: that fallback widens the union to
  // include `{}` and every read below would then have to defend against an
  // empty object. Reading through optional chaining keeps the shape honest.
  const knowledge: Partial<KnowledgeGatewaySettings> | null | undefined = config.knowledge;
  const maxResults = knowledge?.maxResults;
  return {
    enabled: knowledge?.enabled === true,
    baseUrl: typeof knowledge?.baseUrl === "string" ? knowledge.baseUrl : "",
    apiKey: typeof knowledge?.apiKey === "string" ? knowledge.apiKey : "",
    model: typeof knowledge?.model === "string" ? knowledge.model : "",
    maxResults:
      typeof maxResults === "number" && Number.isFinite(maxResults) && maxResults > 0
        ? Math.floor(maxResults)
        : DEFAULT_MAX_RESULTS,
  };
}
