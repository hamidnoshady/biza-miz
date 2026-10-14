/**
 * Phase 37 & Phase 39 — the gateway's server half: the singleton gateway row,
 * each business and branch's slice of it, and the calls to the gateway's own management API.
 *
 * Two rules shape this file.
 *
 * 1. **A gateway failure is never an assistant failure.** Every HTTP call here
 *    returns a result object instead of throwing; the only place that matters
 *    is the request path, and a deployment that was working before the gateway
 *    was introduced must keep working when the gateway container is stopped.
 *    The one exception is provisioning, which is an explicit operator action:
 *    there the operator has asked for something and is entitled to hear why it
 *    did not happen.
 *
 * 2. **Tenant scope is the caller's, not this module's.** Business/branch key
 *    rows carry explicit `business_id` and optional `location_id` and are written
 *    through ordinary `query()`, exactly as Phase 18's credit writes do: from the
 *    platform console the ambient scope is the documented `platform` bypass and
 *    any business/branch may be addressed, while from a business's own settings
 *    page RLS confines the write to the session's business — so a forged
 *    business id is refused rather than merely ignored.
 */
import { query, withoutTenantScope } from "./db";
import {
  defaultGatewayConfig,
  gatewayTurnPricing,
  emptyBusinessGateway,
  gatewayManagementUrl,
  gatewayStatusMessage,
  joinGatewayDetail,
  keyDeleteUrl,
  keyGenerateUrl,
  keyInfoUrl,
  keyUpdateUrl,
  livelinessUrl,
  modelInfoUrl,
  parseGatewayErrorDetail,
  parseGatewayModels,
  parseGeneratedKey,
  parseKeySpend,
  resolveChatModel,
  toPublicGatewayConfig,
  validateGatewayInput,
  virtualKeyAlias,
  type AiGatewayConfig,
  type AiGatewayInput,
  type BusinessGateway,
  type GatewayProbe,
  type PublicAiGatewayConfig,
  type PublicBusinessGateway,
  type AiGatewayTurnPricing,
} from "./ai-gateway";
import {
  defaultPlatformConfig,
  getPlatformAiConfig,
  platformAiConfigFromGatewayRow,
  type PlatformAiGatewayRow,
} from "./ai-config";
import { chatCompletionsUrl } from "./ai";
import { normalizeProviderError, providerErrorReason } from "./ai-provider-errors";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";

/** Management calls are operator-facing: fail them fast rather than hang a page. */
const MANAGEMENT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Secrets at rest (issue #748 / migrations 0183 and 0209)
//
// LiteLLM master and tenant virtual keys are read and written only as
// AES-256-GCM ciphertext. Migration 0209 drops their legacy plaintext columns
// after a guarded backfill; the separate knowledge API key still has its own
// legacy read fallback until its cutover.
// ---------------------------------------------------------------------------

/** Encrypt a secret for storage, or `null` for "nothing to store". */
function encryptForStorage(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  if (!trimmedValue) return null;
  return encryptSecret(trimmedValue, resolveEncryptionKey(process.env));
}

/**
 * Decrypt a stored secret. The optional plaintext argument remains only for
 * the managed-knowledge credential, whose separate migration has not yet
 * retired its legacy column. Master and virtual keys pass no plaintext value.
 *
 * A ciphertext that fails to decrypt (rotated `INTEGRATIONS_ENCRYPTION_KEY` /
 * `JWT_SECRET`) is treated as absent rather than thrown: the operator sees a
 * missing-key state and can re-enter the credential instead of every AI
 * request throwing.
 */
function decryptFromStorage(ciphertext: string | null | undefined, plaintext?: string | null): string {
  if (ciphertext) {
    try {
      return decryptSecret(ciphertext, resolveEncryptionKey(process.env));
    } catch (err) {
      console.error("ai gateway secret ciphertext could not be decrypted; treating as absent", err);
      return "";
    }
  }
  return plaintext?.trim() || "";
}

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function optionalNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function textOr(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------
// The deployment-wide gateway row
// ---------------------------------------------------------------------------

type GatewayRow = PlatformAiGatewayRow & {
  embedding_model: string;
  virtual_keys_enabled: boolean;
  // Issue #812 — managed knowledge + Deep Research (migration 0203).
  knowledge_enabled: boolean;
  knowledge_base_url: string;
  knowledge_api_key: string | null;
  knowledge_api_key_ciphertext: string | null;
  knowledge_model: string;
  knowledge_max_results: number;
  research_enabled: boolean;
  research_model_alias: string;
  research_max_rounds: number;
  research_max_context_bytes: number;
  research_ttl_hours: number;
  research_max_spend_rial: number;
  research_external_web: boolean;
  research_min_data_readiness: number;
};

function rowToGateway(row: GatewayRow): AiGatewayConfig {
  const fallback = defaultGatewayConfig();
  return {
    enabled: row.enabled,
    baseUrl: textOr(row.base_url, fallback.baseUrl),
    masterKey: decryptFromStorage(row.master_key_ciphertext),
    chatModel: row.chat_model ?? "",
    embeddingModel: row.embedding_model ?? "",
    virtualKeysEnabled: row.virtual_keys_enabled,
    usdRialRate: optionalNumber(row.usd_rial_rate),
    gatewayCostingEnabled: row.gateway_costing_enabled,
    inputCostRialPerMillion: numberValue(row.input_cost_rial_per_million),
    outputCostRialPerMillion: numberValue(row.output_cost_rial_per_million),
    revenueMarginPercent: Math.max(0, numberValue(row.revenue_margin_percent)),
    maxTurnRial: Math.max(0, numberValue(row.max_turn_rial)),
    knowledgeEnabled: row.knowledge_enabled === true,
    knowledgeBaseUrl: textOr(row.knowledge_base_url, ""),
    knowledgeApiKey: decryptFromStorage(row.knowledge_api_key_ciphertext, row.knowledge_api_key),
    knowledgeModel: textOr(row.knowledge_model, ""),
    knowledgeMaxResults: Math.max(1, Math.min(50, numberValue(row.knowledge_max_results) || 8)),
    researchEnabled: row.research_enabled === true,
    researchModelAlias: textOr(row.research_model_alias, ""),
    researchMaxRounds: Math.max(1, Math.min(200, numberValue(row.research_max_rounds) || 12)),
    researchMaxContextBytes: Math.max(1024, numberValue(row.research_max_context_bytes) || 2_000_000),
    researchTtlHours: Math.max(1, Math.min(720, numberValue(row.research_ttl_hours) || 24)),
    researchMaxSpendRial: Math.max(0, numberValue(row.research_max_spend_rial)),
    researchExternalWeb: row.research_external_web === true,
    researchMinDataReadiness: Math.max(1, numberValue(row.research_min_data_readiness) || 1),
  };
}

const GATEWAY_ROW_SELECT = `
  SELECT enabled, base_url, master_key_ciphertext, chat_model, embedding_model,
         virtual_keys_enabled, temperature, max_output_tokens,
         usd_rial_rate, gateway_costing_enabled,
         input_cost_rial_per_million, output_cost_rial_per_million,
         revenue_margin_percent, max_turn_rial,
         knowledge_enabled, knowledge_base_url, knowledge_api_key, knowledge_api_key_ciphertext,
         knowledge_model, knowledge_max_results,
         research_enabled, research_model_alias, research_max_rounds,
         research_max_context_bytes, research_ttl_hours, research_max_spend_rial,
         research_external_web, research_min_data_readiness
    FROM platform_ai_gateway
   WHERE id = true`;

function gatewayDefaultsFromEnvironment(): AiGatewayConfig {
  const envDefaults = Object.fromEntries(
    Object.entries(envGatewayConfig()).filter(([, value]) => value !== undefined),
  ) as Partial<AiGatewayInput>;
  return { ...defaultGatewayConfig(), ...envDefaults };
}

/** The gateway settings, or explicit LITELLM_* bootstrap defaults if no row exists. */
export async function getAiGatewayConfig(): Promise<AiGatewayConfig> {
  const { rows } = await query<GatewayRow>(GATEWAY_ROW_SELECT);
  return rows[0] ? rowToGateway(rows[0]) : gatewayDefaultsFromEnvironment();
}

/**
 * Read the runtime and gateway view of the singleton together. The platform
 * console uses this to avoid selecting `platform_ai_gateway` twice just to
 * render the same readiness response.
 */
export async function getAiGatewayRuntimeSettings(): Promise<{
  gateway: AiGatewayConfig;
  platform: Awaited<ReturnType<typeof getPlatformAiConfig>>;
}> {
  const { rows } = await query<GatewayRow>(GATEWAY_ROW_SELECT);
  const row = rows[0];
  return row
    ? { gateway: rowToGateway(row), platform: platformAiConfigFromGatewayRow(row) }
    : { gateway: gatewayDefaultsFromEnvironment(), platform: defaultPlatformConfig() };
}

export function toPublicAiGatewayConfig(config: AiGatewayConfig): PublicAiGatewayConfig {
  return toPublicGatewayConfig(config);
}

/** Env-supplied defaults, so a deployment can be configured without a DB round-trip. */
function envGatewayConfig(): Partial<AiGatewayInput> {
  const env = process.env;
  return {
    enabled: env.LITELLM_ENABLED === "true",
    baseUrl: env.LITELLM_BASE_URL?.trim() || undefined,
    masterKey: env.LITELLM_MASTER_KEY?.trim() || undefined,
    chatModel: env.LITELLM_CHAT_MODEL?.trim() || undefined,
    embeddingModel: env.LITELLM_EMBEDDING_MODEL?.trim() || undefined,
  };
}

/**
 * Overlay a partial draft onto the stored settings.
 */
export function mergeGatewayConfig(draft: AiGatewayInput, current: AiGatewayConfig): AiGatewayConfig {
  return {
    enabled: draft.enabled ?? current.enabled,
    baseUrl: (draft.baseUrl ?? current.baseUrl).trim() || current.baseUrl,
    masterKey: draft.masterKey?.trim() || current.masterKey,
    chatModel: draft.chatModel ?? current.chatModel,
    embeddingModel: draft.embeddingModel ?? current.embeddingModel,
    virtualKeysEnabled: draft.virtualKeysEnabled ?? current.virtualKeysEnabled,
    // Billing-owned settings are preserved here for runtime compatibility but
    // are no longer accepted from `/platform/ai` patches.
    usdRialRate: current.usdRialRate,
    gatewayCostingEnabled: current.gatewayCostingEnabled,
    inputCostRialPerMillion: current.inputCostRialPerMillion,
    outputCostRialPerMillion: current.outputCostRialPerMillion,
    revenueMarginPercent: current.revenueMarginPercent,
    maxTurnRial: current.maxTurnRial,
    // Issue #812 — the managed-knowledge and research pointers ARE accepted
    // from `/platform/ai`: they are technical infrastructure settings (where
    // the integration lives, what its limits are), not product pricing.
    knowledgeEnabled: draft.knowledgeEnabled ?? current.knowledgeEnabled,
    knowledgeBaseUrl: (draft.knowledgeBaseUrl ?? current.knowledgeBaseUrl).trim(),
    // An empty submission means "unchanged", exactly like the master key.
    knowledgeApiKey: draft.knowledgeApiKey?.trim() || current.knowledgeApiKey,
    knowledgeModel: (draft.knowledgeModel ?? current.knowledgeModel).trim(),
    knowledgeMaxResults: draft.knowledgeMaxResults ?? current.knowledgeMaxResults,
    researchEnabled: draft.researchEnabled ?? current.researchEnabled,
    researchModelAlias: (draft.researchModelAlias ?? current.researchModelAlias).trim(),
    researchMaxRounds: draft.researchMaxRounds ?? current.researchMaxRounds,
    researchMaxContextBytes: draft.researchMaxContextBytes ?? current.researchMaxContextBytes,
    researchTtlHours: draft.researchTtlHours ?? current.researchTtlHours,
    researchMaxSpendRial: draft.researchMaxSpendRial ?? current.researchMaxSpendRial,
    researchExternalWeb: draft.researchExternalWeb ?? current.researchExternalWeb,
    researchMinDataReadiness: draft.researchMinDataReadiness ?? current.researchMinDataReadiness,
  };
}

/**
 * Persist the gateway settings.
 */
export async function saveAiGatewayConfig(input: AiGatewayInput): Promise<AiGatewayConfig> {
  const current = await getAiGatewayConfig();
  // Validate the complete state that will be persisted, not a partial patch.
  // This lets later edits omit unchanged fields while still preventing an
  // enabled configuration that runtime would immediately reject.
  const errors = validateGatewayInput(mergeGatewayConfig(input, current));
  if (errors.length > 0) throw new Error(errors[0]);
  // An empty submission means "unchanged" (the console always renders the
  // master key masked); a new value is encrypted before it ever reaches a
  // parameter binding. Migration 0209 removes the plaintext storage column.
  const masterKey = input.masterKey?.trim() || current.masterKey || "";
  const masterKeyCiphertext = encryptForStorage(masterKey);
  const knowledgeApiKey = input.knowledgeApiKey?.trim() || current.knowledgeApiKey || "";
  const knowledgeApiKeyCiphertext = encryptForStorage(knowledgeApiKey);
  await query(
    `INSERT INTO platform_ai_gateway
       (id, enabled, base_url, master_key_ciphertext, chat_model, embedding_model,
        virtual_keys_enabled,
        usd_rial_rate, gateway_costing_enabled, input_cost_rial_per_million, output_cost_rial_per_million,
        revenue_margin_percent, max_turn_rial, updated_at,
        knowledge_enabled, knowledge_base_url, knowledge_api_key, knowledge_api_key_ciphertext,
        knowledge_model, knowledge_max_results,
        research_enabled, research_model_alias, research_max_rounds,
        research_max_context_bytes, research_ttl_hours, research_max_spend_rial,
        research_external_web, research_min_data_readiness)
     VALUES
       (true, $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, now(),
        $13, $14, NULL, $15, $16, $17,
        $18, $19, $20, $21, $22, $23, $24, $25)
     ON CONFLICT (id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   base_url = EXCLUDED.base_url,
                   master_key_ciphertext = EXCLUDED.master_key_ciphertext,
                   chat_model = EXCLUDED.chat_model,
                   embedding_model = EXCLUDED.embedding_model,
                   virtual_keys_enabled = EXCLUDED.virtual_keys_enabled,
                   usd_rial_rate = EXCLUDED.usd_rial_rate,
                   gateway_costing_enabled = EXCLUDED.gateway_costing_enabled,
                   input_cost_rial_per_million = EXCLUDED.input_cost_rial_per_million,
                   output_cost_rial_per_million = EXCLUDED.output_cost_rial_per_million,
                   revenue_margin_percent = EXCLUDED.revenue_margin_percent,
                   max_turn_rial = EXCLUDED.max_turn_rial,
                   knowledge_enabled = EXCLUDED.knowledge_enabled,
                   knowledge_base_url = EXCLUDED.knowledge_base_url,
                   knowledge_api_key = NULL,
                   knowledge_api_key_ciphertext = EXCLUDED.knowledge_api_key_ciphertext,
                   knowledge_model = EXCLUDED.knowledge_model,
                   knowledge_max_results = EXCLUDED.knowledge_max_results,
                   research_enabled = EXCLUDED.research_enabled,
                   research_model_alias = EXCLUDED.research_model_alias,
                   research_max_rounds = EXCLUDED.research_max_rounds,
                   research_max_context_bytes = EXCLUDED.research_max_context_bytes,
                   research_ttl_hours = EXCLUDED.research_ttl_hours,
                   research_max_spend_rial = EXCLUDED.research_max_spend_rial,
                   research_external_web = EXCLUDED.research_external_web,
                   research_min_data_readiness = EXCLUDED.research_min_data_readiness,
                   updated_at = now()`,
    [
      input.enabled ?? current.enabled,
      (input.baseUrl ?? current.baseUrl).trim(),
      masterKeyCiphertext,
      (input.chatModel ?? current.chatModel).trim(),
      (input.embeddingModel ?? current.embeddingModel).trim(),
      input.virtualKeysEnabled ?? current.virtualKeysEnabled,
      current.usdRialRate,
      current.gatewayCostingEnabled,
      current.inputCostRialPerMillion,
      current.outputCostRialPerMillion,
      current.revenueMarginPercent,
      Math.round(current.maxTurnRial),
      input.knowledgeEnabled ?? current.knowledgeEnabled,
      (input.knowledgeBaseUrl ?? current.knowledgeBaseUrl).trim(),
      knowledgeApiKeyCiphertext,
      (input.knowledgeModel ?? current.knowledgeModel).trim(),
      input.knowledgeMaxResults ?? current.knowledgeMaxResults,
      input.researchEnabled ?? current.researchEnabled,
      (input.researchModelAlias ?? current.researchModelAlias).trim(),
      input.researchMaxRounds ?? current.researchMaxRounds,
      input.researchMaxContextBytes ?? current.researchMaxContextBytes,
      input.researchTtlHours ?? current.researchTtlHours,
      input.researchMaxSpendRial ?? current.researchMaxSpendRial,
      input.researchExternalWeb ?? current.researchExternalWeb,
      input.researchMinDataReadiness ?? current.researchMinDataReadiness,
    ],
  );
  return getAiGatewayConfig();
}

/**
 * The AI commercial costing settings, written ONLY from the Billing rates
 * console (`/api/platform/billing/rates`). `/platform/ai` keeps the technical
 * connection (models, keys, base URL) and no longer accepts these fields —
 * mergeGatewayConfig preserves them untouched — so this is the one writable
 * path for what an AI turn costs a business.
 */
export interface AiCostingConfig {
  usdRialRate: number | null;
  gatewayCostingEnabled: boolean;
  inputCostRialPerMillion: number;
  outputCostRialPerMillion: number;
  revenueMarginPercent: number;
  maxTurnRial: number;
}

export async function getAiCostingConfig(): Promise<AiCostingConfig> {
  const config = await getAiGatewayConfig();
  return {
    usdRialRate: config.usdRialRate,
    gatewayCostingEnabled: config.gatewayCostingEnabled,
    inputCostRialPerMillion: config.inputCostRialPerMillion,
    outputCostRialPerMillion: config.outputCostRialPerMillion,
    revenueMarginPercent: config.revenueMarginPercent,
    maxTurnRial: config.maxTurnRial,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Math.floor(Number(value));
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export async function saveAiCostingConfig(
  input: Partial<AiCostingConfig>,
): Promise<AiCostingConfig> {
  const current = await getAiCostingConfig();
  const next: AiCostingConfig = {
    usdRialRate:
      input.usdRialRate === undefined
        ? current.usdRialRate
        : input.usdRialRate == null || input.usdRialRate <= 0
          ? null
          : Math.floor(input.usdRialRate),
    gatewayCostingEnabled: input.gatewayCostingEnabled ?? current.gatewayCostingEnabled,
    inputCostRialPerMillion:
      nonNegativeInteger(input.inputCostRialPerMillion) ?? current.inputCostRialPerMillion,
    outputCostRialPerMillion:
      nonNegativeInteger(input.outputCostRialPerMillion) ?? current.outputCostRialPerMillion,
    revenueMarginPercent:
      nonNegativeInteger(input.revenueMarginPercent) ?? current.revenueMarginPercent,
    maxTurnRial: nonNegativeInteger(input.maxTurnRial) ?? current.maxTurnRial,
  };
  await query(
    `INSERT INTO platform_ai_gateway (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  await query(
    `UPDATE platform_ai_gateway
        SET usd_rial_rate = $1,
            gateway_costing_enabled = $2,
            input_cost_rial_per_million = $3,
            output_cost_rial_per_million = $4,
            revenue_margin_percent = $5,
            max_turn_rial = $6,
            updated_at = now()
      WHERE id = true`,
    [
      next.usdRialRate,
      next.gatewayCostingEnabled,
      next.inputCostRialPerMillion,
      next.outputCostRialPerMillion,
      next.revenueMarginPercent,
      next.maxTurnRial,
    ],
  );
  const { publishPriceVersion } = await import("./billing/runtime");
  if (input.inputCostRialPerMillion !== undefined) {
    await publishPriceVersion({
      targetType: "meter",
      targetKey: "ai.input_tokens",
      unit: "token",
      unitAmountRial: next.inputCostRialPerMillion,
      unitSize: 1_000_000,
    });
  }
  if (input.outputCostRialPerMillion !== undefined) {
    await publishPriceVersion({
      targetType: "meter",
      targetKey: "ai.output_tokens",
      unit: "token",
      unitAmountRial: next.outputCostRialPerMillion,
      unitSize: 1_000_000,
    });
  }
  return getAiCostingConfig();
}

// ---------------------------------------------------------------------------
// Business & Branch Gateways
// ---------------------------------------------------------------------------

type BusinessGatewayRow = {
  id?: string;
  business_id: string;
  location_id: string | null;
  virtual_key_ciphertext: string | null;
  key_alias: string | null;
  spend_usd: string | null;
  synced_at: string | null;
  sync_error: string | null;
};

const BUSINESS_GATEWAY_COLUMNS =
  "id, business_id, location_id, virtual_key_ciphertext, key_alias, spend_usd, synced_at, sync_error";

function rowToBusinessGateway(row: BusinessGatewayRow): BusinessGateway {
  const virtualKey = decryptFromStorage(row.virtual_key_ciphertext);
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? null,
    virtualKey: virtualKey || null,
    keyAlias: row.key_alias ?? null,
    spendUsd: numberValue(row.spend_usd),
    syncedAt: row.synced_at,
    syncError: row.sync_error ?? null,
  };
}

/**
 * Get gateway row for a business or a specific branch.
 * If locationId is provided, queries for that branch.
 * If locationId is null/undefined, queries for the business-level gateway (location_id IS NULL).
 */
export async function getBusinessGateway(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  const loc = locationId?.trim() || null;
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT ${BUSINESS_GATEWAY_COLUMNS}
       FROM ai_business_gateway
      WHERE business_id = $1
        AND (
          ($2::uuid IS NOT NULL AND location_id = $2::uuid)
          OR
          ($2::uuid IS NULL AND location_id IS NULL)
        )`,
    [businessId, loc],
  );
  return rows[0] ? rowToBusinessGateway(rows[0]) : null;
}

/** Get gateway row for a specific branch. */
export async function getBranchGateway(
  businessId: string,
  locationId: string,
): Promise<BusinessGateway | null> {
  return getBusinessGateway(businessId, locationId);
}

/** List all branch gateways for a business. */
export async function listBranchGateways(businessId: string): Promise<BusinessGateway[]> {
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT ${BUSINESS_GATEWAY_COLUMNS}
       FROM ai_business_gateway
      WHERE business_id = $1
        AND location_id IS NOT NULL`,
    [businessId],
  );
  return rows.map(rowToBusinessGateway);
}

/** List business/branch gateway rows. Platform scope. */
export async function listBusinessGateways(
  businessId?: string,
  locationId?: string | null,
): Promise<BusinessGateway[]> {
  return withoutTenantScope("platform", async () => {
    let sql = `SELECT ${BUSINESS_GATEWAY_COLUMNS} FROM ai_business_gateway`;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (businessId) {
      params.push(businessId);
      conditions.push(`business_id = $${params.length}`);
    }

    if (locationId !== undefined) {
      if (locationId === null) {
        conditions.push(`location_id IS NULL`);
      } else {
        params.push(locationId);
        conditions.push(`location_id = $${params.length}`);
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(" AND ");
    }

    sql += ` ORDER BY business_id, location_id NULLS FIRST`;
    const { rows } = await query<BusinessGatewayRow>(sql, params);
    return rows.map(rowToBusinessGateway);
  });
}

/**
 * Batch-read only the key rows needed by one paginated console response:
 * one business-default row per visible business plus the selected branch row.
 * It deliberately does not decrypt keys for every tenant in the fleet.
 */
export async function listBusinessGatewaysForConsole(
  businessIds: string[],
  focusedBranch: { businessId: string; locationId: string } | null = null,
): Promise<BusinessGateway[]> {
  const uniqueBusinessIds = [...new Set(businessIds)];
  if (uniqueBusinessIds.length === 0 && !focusedBranch) return [];
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessGatewayRow>(
      `SELECT ${BUSINESS_GATEWAY_COLUMNS}
         FROM ai_business_gateway
        WHERE (business_id = ANY($1::uuid[]) AND location_id IS NULL)
           OR ($2::text <> '' AND $3::text <> ''
               AND business_id::text = $2 AND location_id::text = $3)
        ORDER BY business_id, location_id NULLS FIRST`,
      [uniqueBusinessIds, focusedBranch?.businessId ?? "", focusedBranch?.locationId ?? ""],
    );
    return rows.map(rowToBusinessGateway);
  });
}

/** Return one decryptable virtual key for the optional operator gateway probe. */
export async function getAnyBusinessGatewayWithKey(): Promise<BusinessGateway | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessGatewayRow>(
      `SELECT ${BUSINESS_GATEWAY_COLUMNS}
         FROM ai_business_gateway
        WHERE virtual_key_ciphertext IS NOT NULL
          AND btrim(virtual_key_ciphertext) <> ''
        ORDER BY updated_at DESC
        LIMIT 1`,
    );
    const row = rows[0] ? rowToBusinessGateway(rows[0]) : null;
    return row?.virtualKey ? row : null;
  });
}

/**
 * Ensure an identity-only row exists for a business or branch, without
 * minting a virtual key. Used by callers that need a tracked row to attach
 * a key to later; model/budget/rate-limit policy is never part of this row —
 * LiteLLM owns model access policy entirely.
 */
export async function saveBusinessGateway(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway> {
  const loc = locationId?.trim() || null;
  await query(
    `INSERT INTO ai_business_gateway (business_id, location_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (business_id, location_id)
     DO UPDATE SET updated_at = now()`,
    [businessId, loc],
  );
  return (await getBusinessGateway(businessId, loc)) ?? emptyBusinessGateway(businessId, loc);
}

/** Record a virtual key against a business or branch. Platform scope. */
async function storeVirtualKey(input: {
  businessId: string;
  locationId?: string | null;
  virtualKey: string;
  keyAlias: string;
  syncError?: string | null;
}): Promise<BusinessGateway> {
  const loc = input.locationId?.trim() || null;
  const virtualKeyCiphertext = encryptForStorage(input.virtualKey);
  return withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO ai_business_gateway
         (business_id, location_id, virtual_key_ciphertext, key_alias, synced_at, sync_error, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::text IS NULL THEN now() ELSE NULL END, $5, now())
       ON CONFLICT (business_id, location_id)
       DO UPDATE SET virtual_key_ciphertext = EXCLUDED.virtual_key_ciphertext,
                     key_alias = EXCLUDED.key_alias,
                     synced_at = CASE WHEN $5::text IS NULL THEN now() ELSE ai_business_gateway.synced_at END,
                     sync_error = EXCLUDED.sync_error,
                     updated_at = now()`,
      [
        input.businessId,
        loc,
        virtualKeyCiphertext,
        input.keyAlias,
        input.syncError ?? null,
      ],
    );
    return (await getBusinessGateway(input.businessId, loc)) ?? emptyBusinessGateway(input.businessId, loc);
  });
}

/**
 * Leave a visible, retryable "this business/branch currently has no valid
 * virtual key" row — used when a revoke succeeds but the replacement
 * provisioning that rotation attempted afterwards fails. Never silently
 * drops the row (which would read as "never configured" rather than "needs
 * attention") and never re-uses a key that is already confirmed revoked.
 */
async function recordNoValidKey(input: {
  businessId: string;
  locationId?: string | null;
  keyAlias: string | null;
  syncError: string;
}): Promise<BusinessGateway> {
  const loc = input.locationId?.trim() || null;
  return withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO ai_business_gateway
         (business_id, location_id, virtual_key_ciphertext, key_alias, synced_at, sync_error, updated_at)
       VALUES ($1, $2, NULL, $3, NULL, $4, now())
       ON CONFLICT (business_id, location_id)
       DO UPDATE SET virtual_key_ciphertext = NULL,
                     key_alias = COALESCE(EXCLUDED.key_alias, ai_business_gateway.key_alias),
                     synced_at = NULL,
                     sync_error = EXCLUDED.sync_error,
                     updated_at = now()`,
      [input.businessId, loc, input.keyAlias, input.syncError],
    );
    return (await getBusinessGateway(input.businessId, loc)) ?? emptyBusinessGateway(input.businessId, loc);
  });
}

// ---------------------------------------------------------------------------
// Business ↔ branch integrity (issue #748, P0-3)
//
// The admin API accepts both `businessId` and `locationId` from the console.
// Every branch-level lifecycle action must refuse a location that does not
// actually belong to the given business — a forged or stale pair must never
// reach a provision/verify/rotate/revoke call.
// ---------------------------------------------------------------------------

export class BusinessLocationMismatchError extends Error {
  constructor() {
    super("ai_gateway_location_business_mismatch");
    this.name = "BusinessLocationMismatchError";
  }
}

/** True when `locationId` is null (business-level scope) or genuinely belongs to `businessId`. */
export async function locationBelongsToBusiness(
  businessId: string,
  locationId: string | null,
): Promise<boolean> {
  if (!locationId) return true;
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM locations WHERE id = $1 AND business_id = $2
       ) AS ok`,
      [locationId, businessId],
    );
    return rows[0]?.ok ?? false;
  });
}

/** Defense in depth: every branch-level lifecycle function calls this before touching a row. */
async function assertLocationBelongsToBusiness(businessId: string, locationId: string | null): Promise<void> {
  if (!(await locationBelongsToBusiness(businessId, locationId))) {
    throw new BusinessLocationMismatchError();
  }
}

/** Forget the virtual key and the row that held it. Platform scope. */
export async function clearVirtualKey(businessId: string, locationId?: string | null): Promise<void> {
  const loc = locationId?.trim() || null;
  await withoutTenantScope("platform", async () => {
    await query(
      `DELETE FROM ai_business_gateway
        WHERE business_id = $1
          AND (
            ($2::uuid IS NOT NULL AND location_id = $2::uuid)
            OR
            ($2::uuid IS NULL AND location_id IS NULL)
          )`,
      [businessId, loc],
    );
  });
}

// ---------------------------------------------------------------------------
// The gateway's own management API
// ---------------------------------------------------------------------------

interface GatewayResponse {
  status: number;
  body: unknown;
}

async function gatewayRequest(
  config: AiGatewayConfig,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<GatewayResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        ...(config.masterKey ? { Authorization: `Bearer ${config.masterKey}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface GatewayCallError {
  code: string;
  message: string;
  /** The proxy's own explanation of the failure, when it sent one. */
  detail: string | null;
}

function stage(input: {
  key: GatewayProbe["stages"][number]["key"];
  label: string;
  ok: boolean;
  skipped?: boolean;
  status?: number | null;
  model?: string | null;
  message?: string | null;
  detail?: string | null;
}): GatewayProbe["stages"][number] {
  return {
    key: input.key,
    label: input.label,
    ok: input.ok,
    ...(input.skipped ? { skipped: true } : {}),
    status: input.status ?? null,
    model: input.model ?? null,
    message: input.message ?? null,
    detail: input.detail ?? null,
  };
}

async function completionProbe(config: AiGatewayConfig, input: { authKey: string; model: string; key: GatewayProbe["stages"][number]["key"]; label: string }): Promise<GatewayProbe["stages"][number]> {
  const model = input.model.trim();
  if (!model) {
    return stage({
      key: input.key,
      label: input.label,
      ok: false,
      model: null,
      message: "نام مستعار مدل گفت‌وگو تنظیم نشده است.",
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const res = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (ok(res.status)) {
      return stage({
        key: input.key,
        label: input.label,
        ok: true,
        status: res.status,
        model,
        message: "تکمیل آزمایشی موفق بود.",
      });
    }
    const err = normalizeProviderError(res.status, text);
    return stage({
      key: input.key,
      label: input.label,
      ok: false,
      status: res.status,
      model,
      message: providerErrorReason(err) ?? gatewayStatusMessage(res.status),
      detail: err.detail ?? err.sanitizedBody,
    });
  } catch {
    return stage({
      key: input.key,
      label: input.label,
      ok: false,
      model,
      message: "درخواست تکمیل آزمایشی به دروازه نرسید.",
    });
  } finally {
    clearTimeout(timer);
  }
}

function asError(status: number, body?: unknown): GatewayCallError {
  if (status === 0) {
    return {
      code: "ai_gateway_unreachable",
      message: "دروازه در دسترس نیست (اتصال برقرار نشد).",
      detail: null,
    };
  }
  return {
    code: status === 401 || status === 403 ? "ai_gateway_auth" : "ai_gateway_error",
    message: gatewayStatusMessage(status),
    detail: parseGatewayErrorDetail(body),
  };
}

/**
 * The one throw of this module: provisioning is an explicit operator action,
 * so the operator is entitled to the code *and* the proxy's own explanation.
 * `message` stays the code so the route's `startsWith("ai_gateway")` contract
 * keeps working; the explanation rides along as `detail`.
 */
export class GatewayProvisioningError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(code: string, detail: string | null) {
    super(code);
    this.name = "GatewayProvisioningError";
    this.code = code;
    this.detail = detail;
  }
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Multi-stage LiteLLM diagnostic — real auth, model and completion checks. */
export async function probeGateway(
  config: AiGatewayConfig,
  options: { platformModel?: string; virtualKey?: string | null } = {},
): Promise<GatewayProbe> {
  const started = Date.now();
  const stages: GatewayProbe["stages"] = [];
  const health = await gatewayRequest(config, livelinessUrl(config.baseUrl), { method: "GET" });
  if (!ok(health.status)) {
    const error = asError(health.status, health.body);
    stages.push(stage({
      key: "server",
      label: "Gateway reachable",
      ok: false,
      status: health.status || null,
      message: error.message,
      detail: error.detail,
    }));
    return {
      ok: false,
      latencyMs: null,
      models: [],
      error: joinGatewayDetail(error.message, error.detail),
      stages,
    };
  }
  stages.push(stage({ key: "server", label: "Gateway reachable", ok: true, status: health.status, message: "دروازه در دسترس است." }));

  if (!config.masterKey) {
    stages.push(stage({ key: "auth", label: "Master key accepted", ok: false, message: "کلید مدیر تنظیم نشده است." }));
    return { ok: false, latencyMs: Date.now() - started, models: [], error: "کلید مدیر تنظیم نشده است.", stages };
  }

  const modelInfo = await gatewayRequest(config, modelInfoUrl(config.baseUrl), { method: "GET" });
  if (!ok(modelInfo.status)) {
    const error = asError(modelInfo.status, modelInfo.body);
    stages.push(stage({ key: "auth", label: "Master key accepted", ok: false, status: modelInfo.status, message: error.message, detail: error.detail }));
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models: [],
      error: joinGatewayDetail(error.message, error.detail),
      stages,
    };
  }
  stages.push(stage({ key: "auth", label: "Master key accepted", ok: true, status: modelInfo.status, message: "کلید مدیر پذیرفته شد." }));

  const models = parseGatewayModels(modelInfo.body);
  const model = config.chatModel.trim() || options.platformModel?.trim() || "";
  const modelOk = Boolean(model) && models.includes(model);
  stages.push(stage({
    key: "model_alias",
    label: "Model alias exists",
    ok: modelOk,
    status: modelInfo.status,
    model: model || null,
    message: modelOk ? "نام مستعار مدل در LiteLLM موجود است." : `مدل ${model || "—"} در /model/info پیدا نشد.`,
    detail: modelOk ? null : `Available: ${models.join(", ") || "none"}`,
  }));
  if (!modelOk) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models,
      error: `مدل ${model || "—"} در LiteLLM پیدا نشد.`,
      stages,
    };
  }

  const masterCompletion = await completionProbe(config, {
    authKey: config.masterKey,
    model,
    key: "master_completion",
    label: "Master-key minimal completion",
  });
  stages.push(masterCompletion);
  if (!masterCompletion.ok) {
    return { ok: false, latencyMs: Date.now() - started, models, error: masterCompletion.message, stages };
  }

  if (options.virtualKey) {
    const virtualCompletion = await completionProbe(config, {
      authKey: options.virtualKey,
      model,
      key: "virtual_key_completion",
      label: "Business virtual-key completion",
    });
    stages.push(virtualCompletion);
  } else {
    stages.push(stage({
      key: "virtual_key_completion",
      label: "Business virtual-key completion",
      ok: true,
      skipped: true,
      model,
      message: "کلید مجازی برای تست سراسری انتخاب نشده است؛ از بخش کسب‌وکارها Verify را اجرا کنید.",
    }));
  }

  const failed = stages.find((item) => !item.ok && !item.skipped);
  return {
    ok: !failed,
    latencyMs: Date.now() - started,
    models,
    error: failed?.message ?? null,
    stages,
  };
}

/** Model aliases the gateway is serving. Empty when the admin key is absent. */
export async function listGatewayModels(config: AiGatewayConfig): Promise<string[]> {
  if (!config.masterKey) return [];
  const res = await gatewayRequest(config, modelInfoUrl(config.baseUrl), { method: "GET" });
  return ok(res.status) ? parseGatewayModels(res.body) : [];
}

export interface VirtualKeyInput {
  businessId: string;
  locationId?: string | null;
}

/**
 * Mint (or refresh) the virtual key for one business or branch and store it.
 *
 * Single-architecture rule (migration 0168): the minted key is an IDENTITY —
 * it carries the alias and business metadata and nothing else. No `models`
 * allowlist (changing the platform's chat alias would otherwise orphan every
 * existing key against the new model), and no max_budget / budget_duration /
 * tpm_limit / rpm_limit (those are LiteLLM's to enforce; a mirrored key budget
 * used to 429 tenants whose platform wallet still had credit). The platform
 * gate — wallet affordability — is the only billing stop on the request path.
 */
export async function provisionVirtualKey(
  config: AiGatewayConfig,
  input: VirtualKeyInput,
): Promise<BusinessGateway> {
  const loc = input.locationId?.trim() || null;
  await assertLocationBelongsToBusiness(input.businessId, loc);
  const alias = virtualKeyAlias(input.businessId, loc);
  const existing = await getBusinessGatewayOrEmpty(input.businessId, loc);

  if (existing?.virtualKey) {
    const res = await gatewayRequest(config, keyUpdateUrl(config.baseUrl), {
      method: "POST",
      // Only the identity metadata is refreshed; the key keeps whatever the
      // proxy itself enforces on it.
      body: { key: existing.virtualKey, key_alias: alias },
    });
    if (!ok(res.status)) {
      const error = asError(res.status, res.body);
      return storeVirtualKey({
        businessId: input.businessId,
        locationId: loc,
        virtualKey: existing.virtualKey,
        keyAlias: alias,
        syncError: joinGatewayDetail(error.message, error.detail),
      });
    }
    return storeVirtualKey({
      businessId: input.businessId,
      locationId: loc,
      virtualKey: existing.virtualKey,
      keyAlias: alias,
    });
  }

  const res = await gatewayRequest(config, keyGenerateUrl(config.baseUrl), {
    method: "POST",
    body: {
      key_alias: alias,
      metadata: {
        business_id: input.businessId,
        ...(loc ? { location_id: loc } : {}),
        source: "cafe-pos",
      },
    },
  });
  if (!ok(res.status)) {
    const error = asError(res.status, res.body);
    throw new GatewayProvisioningError(error.code, error.detail);
  }
  const key = parseGeneratedKey(res.body);
  if (!key) {
    throw new GatewayProvisioningError("ai_gateway_bad_response", parseGatewayErrorDetail(res.body));
  }
  return storeVirtualKey({
    businessId: input.businessId,
    locationId: loc,
    virtualKey: key,
    keyAlias: alias,
  });
}

/**
 * Provision the business-level key immediately after a business is created.
 *
 * Business creation must not be rolled back when LiteLLM is temporarily down:
 * the gateway can be restarted and the admin can retry from the console. When
 * it is configured, however, a new tenant is ready for AI before the create
 * request returns — there is no second manual "generate key" step.
 */
export async function autoProvisionBusinessVirtualKey(businessId: string): Promise<BusinessGateway | null> {
  try {
    const [gateway] = await Promise.all([getAiGatewayConfig(), getPlatformAiConfig()]);
    if (!gateway.virtualKeysEnabled || !gateway.masterKey || !gateway.enabled) return null;

    return await provisionVirtualKey(gateway, {
      businessId,
      locationId: null,
    });
  } catch (error) {
    const syncError = error instanceof Error ? error.message : "ai_gateway_provision_failed";
    // Keep a visible retryable record without exposing the master key or
    // making tenant creation depend on gateway availability.
    try {
      await withoutTenantScope("platform", async () => {
        await query(
          `INSERT INTO ai_business_gateway
             (business_id, location_id, sync_error, updated_at)
           VALUES ($1, NULL, $2, now())
           ON CONFLICT (business_id, location_id)
           DO UPDATE SET sync_error = EXCLUDED.sync_error, updated_at = now()`,
          [businessId, syncError],
        );
      });
    } catch (recordError) {
      console.error("could not record automatic LiteLLM key provisioning failure", recordError);
    }
    console.error("automatic LiteLLM key provisioning failed", { businessId, error: syncError });
    return null;
  }
}

/**
 * Lazily guarantee a business's virtual key on the REQUEST path (the root
 * cause fix for "کلید مجازی این کسب‌وکار صادر نشده است" reaching tenants).
 *
 * A tenant whose key was never minted — created while the gateway was down, or
 * before virtual keys were switched on — used to be refused with
 * `tenant_virtual_key_missing` until an operator noticed. Now the first
 * request mints the key itself: the platform console's per-business readiness
 * read stays a read (it must not mint N keys in one page load), but the
 * request path, which is about to authenticate as this business, may.
 *
 * Failure here is never a hard error: the provisioning attempt is recorded on
 * the row (sync_error) and the turn fails closed exactly as before. A
 * per-process, per-business cooldown keeps a down gateway from adding a 10s
 * management call to every chat turn.
 */
const ensureKeyCooldownMs = 60_000;
const ensureKeyFailures = new Map<string, number>();

export async function ensureTenantVirtualKey(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  const scope = locationId ? `${businessId}:${locationId}` : businessId;
  const existing = await getBusinessGateway(businessId, locationId ?? null);
  if (existing?.virtualKey) return existing;

  const lastFailure = ensureKeyFailures.get(scope);
  if (lastFailure !== undefined && Date.now() - lastFailure < ensureKeyCooldownMs) return existing;

  const gateway = await getAiGatewayConfig();
  if (!gateway.enabled || !gateway.virtualKeysEnabled || !gateway.masterKey) return existing;

  try {
    const row = await provisionVirtualKey(gateway, { businessId, locationId: locationId ?? null });
    ensureKeyFailures.delete(scope);
    return row;
  } catch (error) {
    ensureKeyFailures.set(scope, Date.now());
    console.error("lazy tenant virtual key provisioning failed", {
      businessId,
      locationId: locationId ?? null,
      error: error instanceof Error ? error.message : error,
    });
    return existing;
  }
}

/**
 * Whether LiteLLM's own `/key/delete` response means "this key is gone",
 * either because it just deleted it or because it was already gone. A local
 * key record must never be removed on anything less certain than this.
 */
function keyConfirmedAbsent(status: number, body: unknown): boolean {
  // A clean 404 is unambiguous. Some proxy versions instead answer 200/400
  // with a body naming zero deleted keys — that also means "there was
  // nothing there to delete", i.e. the key is already gone.
  if (status === 404) return true;
  const row = body as { deleted_keys?: unknown } | null;
  if (row && typeof row === "object" && Array.isArray(row.deleted_keys)) {
    return row.deleted_keys.length === 0;
  }
  return false;
}

export interface RevokeKeyResult {
  ok: boolean;
  /** True when nothing needed to be revoked, or LiteLLM confirmed the key no longer exists. */
  alreadyGone: boolean;
  code?: string;
  detail?: string | null;
}

/**
 * Revoke a business or branch's virtual key.
 *
 * The local `ai_business_gateway` row is the platform's only memory of which
 * credential is live; it must never be cleared on anything weaker than LiteLLM
 * *confirming* the key is gone. `gatewayRequest()` turns network failures and
 * HTTP errors into a response object rather than throwing (by design — a
 * gateway outage must never become an assistant-facing exception), which is
 * exactly why this function, and not the caller, has to inspect the status
 * before touching the row: every non-2xx/non-404 outcome — unreachable,
 * 401/403, 5xx, or a malformed body — preserves the row and reports failure.
 */
export async function revokeVirtualKey(
  config: AiGatewayConfig,
  businessId: string,
  locationId?: string | null,
): Promise<RevokeKeyResult> {
  const loc = locationId?.trim() || null;
  await assertLocationBelongsToBusiness(businessId, loc);
  const existing = await getBusinessGatewayOrEmpty(businessId, loc);

  if (!existing?.virtualKey) {
    // Nothing live to revoke at the gateway; any local row is at most a
    // stale sync_error placeholder and is safe to clear.
    await clearVirtualKey(businessId, loc);
    return { ok: true, alreadyGone: true };
  }

  const res = await gatewayRequest(config, keyDeleteUrl(config.baseUrl), {
    method: "POST",
    body: { keys: [existing.virtualKey] },
  });

  if (ok(res.status) || keyConfirmedAbsent(res.status, res.body)) {
    await clearVirtualKey(businessId, loc);
    return { ok: true, alreadyGone: !ok(res.status) };
  }

  // Failure — never delete the local row. Record an actionable sync_error so
  // the console shows the credential still exists and needs a retry.
  const error = asError(res.status, res.body);
  await storeVirtualKey({
    businessId,
    locationId: loc,
    virtualKey: existing.virtualKey,
    keyAlias: existing.keyAlias ?? virtualKeyAlias(businessId, loc),
    syncError: joinGatewayDetail("ابطال کلید مجازی در LiteLLM ناموفق بود؛ کلید محلی حفظ شد.", joinGatewayDetail(error.message, error.detail)),
  });
  return { ok: false, alreadyGone: false, code: error.code, detail: error.detail };
}

/**
 * Rotate a business or branch's virtual key.
 *
 * Transactional at the lifecycle level: the old key is revoked and its
 * removal CONFIRMED before a replacement is ever requested. If revoke fails,
 * rotation stops immediately — the old key, and the local row that names it,
 * are both left exactly as they were, so nothing is orphaned and nothing
 * about the tenant's credential state is lost. If the replacement fails
 * *after* a confirmed revoke, the tenant genuinely has no valid key any more;
 * that state is recorded visibly (not silently dropped) and is retryable —
 * the next call sees no virtual key and provisions a fresh one.
 */
export async function rotateVirtualKey(
  config: AiGatewayConfig,
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway> {
  const loc = locationId?.trim() || null;
  await assertLocationBelongsToBusiness(businessId, loc);
  const existing = await getBusinessGatewayOrEmpty(businessId, loc);

  if (!existing?.virtualKey) {
    // No live key to protect — rotation degrades to plain provisioning.
    return provisionVirtualKey(config, { businessId, locationId: loc });
  }

  const revoked = await revokeVirtualKey(config, businessId, loc);
  if (!revoked.ok) {
    // The old key is still live and its row is untouched (revokeVirtualKey's
    // own guarantee). Refuse to mint a second, parallel credential.
    throw new GatewayProvisioningError(revoked.code ?? "ai_gateway_revoke_failed", revoked.detail ?? null);
  }

  try {
    return await provisionVirtualKey(config, { businessId, locationId: loc });
  } catch (err) {
    const code = err instanceof GatewayProvisioningError ? err.code : "ai_gateway_provision_failed";
    const detail = err instanceof GatewayProvisioningError ? err.detail : err instanceof Error ? err.message : null;
    await recordNoValidKey({
      businessId,
      locationId: loc,
      keyAlias: existing.keyAlias ?? virtualKeyAlias(businessId, loc),
      syncError: joinGatewayDetail(
        "کلید قبلی ابطال شد اما صدور کلید جایگزین ناموفق بود؛ این کسب‌وکار/شعبه اکنون بدون کلید معتبر است.",
        joinGatewayDetail(code, detail),
      ),
    });
    throw err;
  }
}

export async function verifyVirtualKey(
  config: AiGatewayConfig,
  businessId: string,
  locationId?: string | null,
  platformModel?: string,
): Promise<{ gateway: BusinessGateway | null; probe: GatewayProbe }> {
  const loc = locationId?.trim() || null;
  await assertLocationBelongsToBusiness(businessId, loc);
  const existing = await getBusinessGatewayOrEmpty(businessId, loc);
  const model = resolveChatModel({
    platformModel: platformModel || config.chatModel || "",
    gateway: config,
    business: loc ? null : existing,
    branch: loc ? existing : null,
  });
  if (!existing?.virtualKey) {
    return {
      gateway: existing,
      probe: {
        ok: false,
        latencyMs: null,
        models: [],
        error: "کلید مجازی برای این کسب‌وکار وجود ندارد.",
        stages: [
          stage({
            key: "virtual_key_completion",
            label: "Business virtual-key completion",
            ok: false,
            model,
            message: "کلید مجازی برای این کسب‌وکار وجود ندارد.",
          }),
        ],
      },
    };
  }
  const started = Date.now();
  const completion = await completionProbe(config, {
    authKey: existing.virtualKey,
    model,
    key: "virtual_key_completion",
    label: "Business virtual-key completion",
  });
  const probe: GatewayProbe = {
    ok: completion.ok,
    latencyMs: Date.now() - started,
    models: [],
    error: completion.ok ? null : completion.message,
    stages: [completion],
  };
  if (!completion.ok) {
    await storeVirtualKey({
      businessId,
      locationId: loc,
      virtualKey: existing.virtualKey,
      keyAlias: existing.keyAlias ?? virtualKeyAlias(businessId, loc),
      syncError: joinGatewayDetail(completion.message ?? "تست کلید مجازی ناموفق بود.", completion.detail),
    });
  } else {
    await storeVirtualKey({
      businessId,
      locationId: loc,
      virtualKey: existing.virtualKey,
      keyAlias: existing.keyAlias ?? virtualKeyAlias(businessId, loc),
    });
  }
  return { gateway: (await getBusinessGatewayOrEmpty(businessId, loc)) ?? existing, probe };
}

/**
 * Ask the gateway what this key has spent. Diagnostic only.
 */
export async function refreshKeySpend(
  config: AiGatewayConfig,
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  const loc = locationId?.trim() || null;
  await assertLocationBelongsToBusiness(businessId, loc);
  const existing = await getBusinessGatewayOrEmpty(businessId, loc);
  if (!existing?.virtualKey) return existing ?? null;
  const res = await gatewayRequest(config, keyInfoUrl(config.baseUrl, existing.virtualKey), { method: "GET" });
  const spend = ok(res.status) ? parseKeySpend(res.body) : null;
  if (!spend) return existing;
  await withoutTenantScope("platform", async () => {
    await query(
      `UPDATE ai_business_gateway
          SET spend_usd = $3, updated_at = now()
        WHERE business_id = $1
          AND (
            ($2::uuid IS NOT NULL AND location_id = $2::uuid)
            OR
            ($2::uuid IS NULL AND location_id IS NULL)
          )`,
      [businessId, loc, spend.spendUsd],
    );
  });
  return (await getBusinessGateway(businessId, loc)) ?? existing;
}

/** Platform-scoped read used by the provisioning path before a write. */
async function getBusinessGatewayOrEmpty(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  return withoutTenantScope("platform", () => getBusinessGateway(businessId, locationId));
}

// ---------------------------------------------------------------------------
// Costing resolution (settlement support for the billing ledger)
// ---------------------------------------------------------------------------

export interface GatewayCosting {
  usdRialRate: number;
}

export async function resolveGatewayCosting(): Promise<GatewayCosting | null> {
  try {
    const gateway = await getAiGatewayConfig();
    if (!gateway.gatewayCostingEnabled || !gateway.usdRialRate) return null;
    return { usdRialRate: gateway.usdRialRate };
  } catch (err) {
    console.error("ai gateway costing unavailable; settling on the token rates", err);
    return null;
  }
}

export async function resolveGatewayTurnPricing(
  costUsd: number | null | undefined,
  marginPercent: number,
): Promise<AiGatewayTurnPricing | null> {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return null;
  const costing = await resolveGatewayCosting();
  if (!costing) return null;
  if (costUsd === 0) {
    return { costUsd: 0, costRial: 0, chargedRial: 0 };
  }
  const { costRial, chargedRial } = gatewayTurnPricing(costUsd, costing.usdRialRate, marginPercent);
  if (chargedRial <= 0) return null;
  return { costUsd, costRial, chargedRial };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Join a business or branch's gateway row to the model its calls will actually use. */
export function toPublicBusinessGateway(
  business: BusinessGateway,
  config: AiGatewayConfig,
  platformModel: string,
): PublicBusinessGateway {
  return {
    id: business.id,
    businessId: business.businessId,
    locationId: business.locationId,
    keyAlias: business.keyAlias,
    syncedAt: business.syncedAt,
    syncError: business.syncError,
    hasVirtualKey: Boolean(business.virtualKey),
    effectiveModel: resolveChatModel({
      platformModel,
      gateway: config,
      business: business.locationId ? null : business,
      branch: business.locationId ? business : null,
    }),
  };
}

export { defaultGatewayConfig, envGatewayConfig };
export type { AiGatewayConfig, BusinessGateway, GatewayProbe };
