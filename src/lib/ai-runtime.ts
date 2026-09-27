/**
 * Phase 37 & Phase 39 — the one place that turns stored configuration into the `AiConfig`
 * a call actually goes out with.
 *
 * Resolves AI configuration with branch -> business -> platform precedence.
 * In Phase 39 (LiteLLM-only), if the gateway or DB state fails to resolve, we fail closed
 * (enabled: false) to prevent unbilled or uncontrolled vendor execution.
 *
 * Root-cause fix (migration 0168 rebuild): a tenant request whose business has
 * no virtual key yet now mints one on the way through (`ensureVirtualKey`),
 * instead of failing with `tenant_virtual_key_missing` until an operator
 * noticed. The platform console's readiness reads stay pure reads — only a
 * request that is about to authenticate AS the business may mint its key.
 */
import { getPlatformAiConfig, type PlatformAiConfig } from "./ai-config";
import {
  ensureTenantVirtualKey,
  getAiGatewayConfig,
  getBusinessGateway,
} from "./ai-gateway-service";
import { buildGatewayRuntime, isGatewayActive, type AiGatewayConfig, type BusinessGateway } from "./ai-gateway";
import type { AiConfig } from "./ai";

/**
 * The config for a tenant call.
 * `businessId` scopes which virtual key is used; pass null for platform support.
 * `locationId` scopes branch-level model overrides and branch virtual keys.
 *
 * `ensureVirtualKey` (default false) is what a request path that is about to
 * send as this tenant passes: it lazily mints the missing business virtual key
 * (see ensureTenantVirtualKey). Read-only surfaces — the console's readiness
 * list, projections, background digests — leave it off.
 */
export async function resolveAiConfigFor(
  businessId: string | null,
  locationId?: string | null,
  options: { ensureVirtualKey?: boolean } = {},
): Promise<PlatformAiConfig> {
  const config = await getPlatformAiConfig();
  return decorate(config, businessId, locationId, options);
}

/**
 * Apply gateway state to an already-loaded config.
 */
export async function decorateAiConfig(
  config: PlatformAiConfig,
  businessId: string | null,
  locationId?: string | null,
): Promise<PlatformAiConfig> {
  return decorate(config, businessId, locationId, {});
}

async function decorate(
  config: PlatformAiConfig,
  businessId: string | null,
  locationId?: string | null,
  options: { ensureVirtualKey?: boolean } = {},
): Promise<PlatformAiConfig> {
  if (!config.enabled) return { ...config, runtimeUnavailableReason: config.runtimeUnavailableReason ?? "platform_disabled" };

  let gateway;
  let business = null;
  let branch = null;
  try {
    gateway = await getAiGatewayConfig();
    if (!isGatewayActive(gateway)) {
      // Gateway is disabled or has no base_url
      return { ...config, enabled: false, runtimeUnavailableReason: gateway?.enabled ? "missing_base_url" : "gateway_disabled" };
    }
    if (businessId) {
      business = await getBusinessGateway(businessId, null);
      if (locationId) {
        branch = await getBusinessGateway(businessId, locationId);
      }
      // A request-path resolve may lazily mint the missing business key. The
      // branch key stays optional: a branch without its own key correctly
      // rides the business key.
      if (options.ensureVirtualKey && gateway.virtualKeysEnabled && !business?.virtualKey) {
        business = await ensureTenantVirtualKey(businessId, null);
      }
    }
  } catch (err) {
    console.error("ai gateway state unavailable; failing closed", err);
    return { ...config, enabled: false, runtimeUnavailableReason: "configuration_load_failed" };
  }

  return decorateAiConfigWithState(config, gateway, business, branch, businessId);
}

/**
 * Pure decoration: apply already-loaded gateway/business/branch state to a
 * config, with no DB access of its own.
 *
 * `decorate()` above calls this immediately after loading that state itself,
 * for the ordinary per-request resolve path. The platform console's fleet
 * readiness (`/platform/ai` GET, issue #748 P1-5/P1-6) loads the gateway
 * singleton and every business/branch row ONCE up front and calls this
 * directly per business/branch instead, to avoid an N+1 query pattern.
 *
 * `isGatewayActive`'s early exit is intentionally skipped here (the caller is
 * expected to have already handled "gateway inactive" once for the whole
 * fleet) — `buildGatewayRuntime` returns `undefined` for an inactive gateway
 * regardless, so passing one through is still safe, just less specific about
 * *why* it's not ready than `decorate()`'s own explicit check.
 */
export function decorateAiConfigWithState(
  config: PlatformAiConfig,
  gateway: AiGatewayConfig | null | undefined,
  business: BusinessGateway | null,
  branch: BusinessGateway | null,
  businessId: string | null,
): PlatformAiConfig {
  const normalizedGateway = gateway ?? null;
  if (!config.enabled) return { ...config, runtimeUnavailableReason: config.runtimeUnavailableReason ?? "platform_disabled" };
  if (!isGatewayActive(normalizedGateway)) {
    return { ...config, enabled: false, runtimeUnavailableReason: normalizedGateway?.enabled ? "missing_base_url" : "gateway_disabled" };
  }

  const runtime = buildGatewayRuntime({ config, gateway: normalizedGateway, business, branch, tenantScoped: Boolean(businessId) });
  if (!runtime) return config;

  const { model, embeddingModel, body, authKey } = runtime;
  const tenantVirtualKeyRequired = Boolean(businessId && gateway?.virtualKeysEnabled);
  const tenantVirtualKeyResolved = Boolean(runtime.virtualKeyResolved);
  const decorated: AiConfig & Pick<PlatformAiConfig, "tenantVirtualKeyRequired" | "tenantVirtualKeyResolved" | "runtimeUnavailableReason"> = {
    ...config,
    model,
    embeddingModel,
    tenantVirtualKeyRequired,
    tenantVirtualKeyResolved,
    ...(tenantVirtualKeyRequired && !tenantVirtualKeyResolved ? { runtimeUnavailableReason: "tenant_virtual_key_missing" as const } : {}),
    gateway: {
      ...(authKey ? { authKey } : {}),
      body,
    },
  };
  return decorated as PlatformAiConfig;
}
