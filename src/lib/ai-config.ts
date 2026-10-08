/**
 * Phase 18, 39 & Phase 40 — platform-owned AI provider connection (LiteLLM unified gateway).
 *
 * All platform AI technical connection settings are stored in `platform_ai_gateway`.
 * This module is the runtime's read side: the standard `PlatformAiConfig`
 * reader and the predicates used by runtime resolvers and billing.
 */
import { defaultConfig, type AiConfig } from "./ai";
import { query } from "./db";
import { decryptSecret, resolveEncryptionKey } from "./integrations/secrets";

/** Decrypt the ciphertext-only master key (migration 0209). */
function decryptMasterKey(ciphertext: string | null | undefined): string {
  if (!ciphertext) return "";
  try {
    return decryptSecret(ciphertext, resolveEncryptionKey(process.env));
  } catch (err) {
    console.error("platform AI master key ciphertext could not be decrypted; treating as absent", err);
    return "";
  }
}

export type AiRuntimeUnavailableReason =
  | "platform_disabled"
  | "gateway_disabled"
  | "missing_base_url"
  | "invalid_base_url"
  | "missing_runtime_credential"
  | "tenant_virtual_key_missing"
  | "missing_model"
  | "invalid_max_output_tokens"
  | "configuration_load_failed";

export interface AiRuntimeReadiness {
  ready: boolean;
  reason: AiRuntimeUnavailableReason | null;
  gatewayReady: boolean;
  authenticationReady: boolean;
  virtualKeyRequired: boolean;
  virtualKeyReady: boolean;
  modelReady: boolean;
}

export interface PlatformAiConfig extends AiConfig {
  /** Safe, server-generated detail about configuration resolution. Never contains secrets. */
  runtimeUnavailableReason?: AiRuntimeUnavailableReason;
  /** Whether this is a tenant call for which virtual-key isolation is mandatory. */
  tenantVirtualKeyRequired?: boolean;
  /** Whether the effective runtime credential is a tenant/branch virtual key. */
  tenantVirtualKeyResolved?: boolean;

  /** The provider's own cost per million input tokens, Rial. */
  inputCostRialPerMillion: number;
  /** The provider's own cost per million output tokens, Rial. */
  outputCostRialPerMillion: number;
  /** The revenue margin added on top of cost, percent. 0 = at cost. */
  revenueMarginPercent: number;
  /** Effective sale rate: cost + margin. Derived, never stored. */
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
  creditUnitRial: number;
  maxOutputTokens: number;
  gatewayCostingEnabled: boolean;
  usdRialRate: number | null;
}

export type PlatformAiGatewayRow = {
  enabled: boolean;
  chat_model: string;
  base_url: string;
  master_key_ciphertext: string | null;
  temperature: string | number;
  input_cost_rial_per_million: string | number | null;
  output_cost_rial_per_million: string | number | null;
  revenue_margin_percent: string | number | null;
  max_turn_rial: string | number | null;
  max_output_tokens: number;
  gateway_costing_enabled: boolean;
  usd_rial_rate: string | number | null;
};

function optionalPositiveNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function envNumber(name: string): number {
  return numberValue(process.env[name]);
}

function envKey(): string {
  // AI_API_KEY is deliberately not a fallback: in a LiteLLM-only deployment
  // it is ambiguous whether it is an upstream provider key or the proxy's
  // management key. Only the explicitly-owned LiteLLM variable is accepted.
  return process.env.LITELLM_MASTER_KEY?.trim() || "";
}

export function effectiveRate(costRialPerMillion: number, marginPercent: number): number {
  if (!(costRialPerMillion > 0)) return 0;
  return Math.ceil(costRialPerMillion * (1 + (marginPercent || 0) / 100));
}

export function defaultPlatformConfig(): PlatformAiConfig {
  const base = defaultConfig("litellm");
  const temp = envNumber("AI_TEMPERATURE");
  const maxOutputTokens = envNumber("AI_MAX_OUTPUT_TOKENS");
  return {
    ...base,
    // With no persisted platform_ai_gateway row, LITELLM_* is the single
    // bootstrap namespace for the one supported connection. A stored row is
    // authoritative and is mapped separately below.
    enabled: process.env.LITELLM_ENABLED === "true",
    model: process.env.LITELLM_CHAT_MODEL?.trim() || base.model,
    baseUrl: process.env.LITELLM_BASE_URL?.trim() || base.baseUrl,
    apiKey: envKey(),
    temperature: temp >= 0 && temp <= 2 ? temp : base.temperature,
    inputCostRialPerMillion: envNumber("AI_INPUT_COST_RIAL_PER_MILLION"),
    outputCostRialPerMillion: envNumber("AI_OUTPUT_COST_RIAL_PER_MILLION"),
    revenueMarginPercent: envNumber("AI_REVENUE_MARGIN_PERCENT"),
    inputTokenRialPerMillion: effectiveRate(
      envNumber("AI_INPUT_COST_RIAL_PER_MILLION"),
      envNumber("AI_REVENUE_MARGIN_PERCENT"),
    ),
    outputTokenRialPerMillion: effectiveRate(
      envNumber("AI_OUTPUT_COST_RIAL_PER_MILLION"),
      envNumber("AI_REVENUE_MARGIN_PERCENT"),
    ),
    maxTurnRial: envNumber("AI_MAX_TURN_RIAL"),
    creditUnitRial: 1,
    maxOutputTokens:
      Number.isInteger(maxOutputTokens) && maxOutputTokens >= 64 && maxOutputTokens <= 8192
        ? maxOutputTokens
        : 1000,
    gatewayCostingEnabled: process.env.LITELLM_GATEWAY_COSTING_ENABLED === "true",
    usdRialRate: optionalPositiveNumber(process.env.LITELLM_USD_RIAL_RATE),
  };
}

export function platformAiConfigFromGatewayRow(row: PlatformAiGatewayRow): PlatformAiConfig {
  const base = defaultConfig("litellm");
  return {
    enabled: row.enabled,
    provider: "litellm",
    model: row.chat_model?.trim() || base.model,
    baseUrl: row.base_url?.trim() || base.baseUrl,
    apiKey: decryptMasterKey(row.master_key_ciphertext),
    temperature: numberValue(row.temperature),
    inputCostRialPerMillion: numberValue(row.input_cost_rial_per_million),
    outputCostRialPerMillion: numberValue(row.output_cost_rial_per_million),
    revenueMarginPercent: numberValue(row.revenue_margin_percent),
    inputTokenRialPerMillion: effectiveRate(
      numberValue(row.input_cost_rial_per_million),
      numberValue(row.revenue_margin_percent),
    ),
    outputTokenRialPerMillion: effectiveRate(
      numberValue(row.output_cost_rial_per_million),
      numberValue(row.revenue_margin_percent),
    ),
    maxTurnRial: numberValue(row.max_turn_rial),
    creditUnitRial: 1,
    maxOutputTokens: row.max_output_tokens || 1000,
    gatewayCostingEnabled: Boolean(row.gateway_costing_enabled),
    usdRialRate: optionalPositiveNumber(row.usd_rial_rate),
  };
}

export async function getPlatformAiConfig(): Promise<PlatformAiConfig> {
  try {
    const { rows } = await query<PlatformAiGatewayRow>(
      `SELECT enabled, chat_model, base_url, master_key_ciphertext, temperature,
              input_cost_rial_per_million, output_cost_rial_per_million,
              revenue_margin_percent, max_turn_rial, max_output_tokens,
              gateway_costing_enabled, usd_rial_rate
         FROM platform_ai_gateway
        WHERE id = true`,
    );
    return rows[0] ? platformAiConfigFromGatewayRow(rows[0]) : defaultPlatformConfig();
  } catch (err) {
    console.error("platform AI config unavailable; failing closed", err);
    return { ...defaultPlatformConfig(), enabled: false, runtimeUnavailableReason: "configuration_load_failed" };
  }
}

function validRuntimeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function getAiRuntimeReadiness(config: PlatformAiConfig): AiRuntimeReadiness {
  const virtualKeyRequired = Boolean(config.tenantVirtualKeyRequired);
  const virtualKeyReady = !virtualKeyRequired || Boolean(config.tenantVirtualKeyResolved);
  const effectiveCredential = config.gateway?.authKey || config.apiKey;
  const modelReady = Boolean(config.model?.trim());
  const baseUrl = config.baseUrl?.trim() || "";

  let reason: AiRuntimeUnavailableReason | null = config.runtimeUnavailableReason ?? null;
  if (!reason && !config.enabled) reason = "platform_disabled";
  if (!reason && !baseUrl) reason = "missing_base_url";
  if (!reason && !validRuntimeBaseUrl(baseUrl)) reason = "invalid_base_url";
  if (!reason && !modelReady) reason = "missing_model";
  if (!reason && virtualKeyRequired && !virtualKeyReady) reason = "tenant_virtual_key_missing";
  if (!reason && !effectiveCredential) reason = "missing_runtime_credential";
  if (!reason && !(config.maxOutputTokens >= 64)) reason = "invalid_max_output_tokens";

  const gatewayReady =
    !reason ||
    !["platform_disabled", "gateway_disabled", "missing_base_url", "invalid_base_url", "configuration_load_failed"].includes(reason);
  const authenticationReady = Boolean(effectiveCredential) && virtualKeyReady;

  return {
    ready: reason === null,
    reason,
    gatewayReady,
    authenticationReady,
    virtualKeyRequired,
    virtualKeyReady,
    modelReady,
  };
}

export function isPlatformAiProviderReady(config: PlatformAiConfig): boolean {
  const readiness = getAiRuntimeReadiness(config);
  return readiness.gatewayReady && readiness.authenticationReady && readiness.modelReady && config.maxOutputTokens >= 64;
}

export function isPlatformAiConfigured(config: PlatformAiConfig): boolean {
  return getAiRuntimeReadiness(config).ready;
}

export function logAiRuntimeUnavailable(
  config: PlatformAiConfig,
  context: { businessId: string | null; locationId?: string | null; surface: string },
): AiRuntimeUnavailableReason | null {
  const reason = getAiRuntimeReadiness(config).reason;
  if (reason) console.warn("AI runtime unavailable", { ...context, reason });
  return reason;
}
