/**
 * Phase 37, Phase 39 & Phase 40 — technical LiteLLM administration API.
 *
 * Exclusively handles LiteLLM connection parameters, model aliases, and
 * business/branch virtual-key management. All billing, money, revenue,
 * allowances and tenant monetization belong strictly to Plan/Billing.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAiRuntimeReadiness, getPlatformAiConfig, type AiRuntimeReadiness } from "@/lib/ai-config";
import { decorateAiConfigWithState } from "@/lib/ai-runtime";
import {
  BusinessLocationMismatchError,
  GatewayProvisioningError,
  getAiGatewayConfig,
  getBusinessGateway,
  listBusinessGateways,
  locationBelongsToBusiness,
  mergeGatewayConfig,
  probeGateway,
  provisionVirtualKey,
  rotateVirtualKey,
  verifyVirtualKey,
  revokeVirtualKey,
  saveAiGatewayConfig,
  toPublicAiGatewayConfig,
  toPublicBusinessGateway,
} from "@/lib/ai-gateway-service";
import {
  isGatewayActive,
  resolveChatModel,
  validateGatewayInput,
  type BusinessGateway,
  type AiGatewayInput,
} from "@/lib/ai-gateway";

/** The fleet-table status filter/vocabulary (issue #748 P1-6). */
type FleetStatus =
  | "ready"
  | "missing_key"
  | "key_sync_error"
  | "entitlement_disabled"
  | "gateway_unavailable";

const FLEET_STATUS_FILTERS = new Set([
  "all",
  "ready",
  "missing_key",
  "key_sync_error",
  "entitlement_disabled",
  "gateway_unavailable",
  "branch_override",
]);

const GATEWAY_LEVEL_REASONS = new Set([
  "platform_disabled",
  "gateway_disabled",
  "missing_base_url",
  "invalid_base_url",
  "missing_runtime_credential",
  "missing_model",
  "invalid_max_output_tokens",
  "configuration_load_failed",
]);

/**
 * The worst-first status a fleet row shows in the console table. A row with
 * a branch override is flagged as such only once nothing worse applies —
 * "has a branch override" is informational, not itself a problem.
 */
function deriveFleetStatus(input: {
  readiness: AiRuntimeReadiness;
  entitled: boolean;
  syncError: string | null;
}): FleetStatus {
  if (input.syncError) return "key_sync_error";
  if (input.readiness.reason === "tenant_virtual_key_missing") return "missing_key";
  if (!input.entitled) return "entitlement_disabled";
  if (input.readiness.reason && GATEWAY_LEVEL_REASONS.has(input.readiness.reason)) return "gateway_unavailable";
  return "ready";
}
import { platformCan } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { query, withoutTenantScope } from "@/lib/db";

/** Technical LiteLLM gateway status, models, readiness and virtual keys. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const platform = await getPlatformAiConfig();
  const platformReadiness = getAiRuntimeReadiness(platform);
  if (platformReadiness.reason === "configuration_load_failed") {
    return NextResponse.json(
      { error: "ai_configuration_load_failed", runtimeReadiness: platformReadiness },
      { status: 503 },
    );
  }

  const params = request.nextUrl.searchParams;
  const search = (params.get("search") ?? "").trim().toLowerCase();
  const statusParamRaw = params.get("status") ?? "all";
  const statusFilter = FLEET_STATUS_FILTERS.has(statusParamRaw) ? statusParamRaw : "all";
  const page = Math.max(1, Math.trunc(Number(params.get("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(params.get("pageSize")) || 20)));
  // The exact (businessId, locationId) the console has selected for the
  // "manage this business/branch" panel — resolved independently of the
  // fleet table's pagination, so a business found via the picker's own
  // search works even when it is not on the fleet table's current page
  // (issue #748 P1-5).
  const focusBusinessId = params.get("businessId")?.trim() || null;
  const focusLocationId = params.get("locationId")?.trim() || null;

  // Issue #748 P1-6: the platform gateway singleton and every business/branch
  // key row are each loaded exactly ONCE here, then every business's
  // readiness is derived from these two already-loaded results in memory
  // (`decorateAiConfigWithState`) — no more one `resolveAiConfigFor` (and its
  // own gateway + business-row queries) per business.
  const [gateway, gateways, locationsRes, businessesRes] = await Promise.all([
    getAiGatewayConfig(),
    listBusinessGateways(),
    withoutTenantScope("platform", () =>
      query<{ id: string; business_id: string; name: string }>(
        `SELECT id, business_id, name FROM locations ORDER BY name`,
      ),
    ),
    withoutTenantScope("platform", () =>
      query<{ id: string; name: string; ai_entitled: boolean }>(
        `SELECT b.id, b.name,
                COALESCE(bf.enabled, ff.default_enabled, false) AS ai_entitled
           FROM businesses b
           LEFT JOIN feature_flags ff ON ff.key = 'ai_assistant'
           LEFT JOIN business_features bf ON bf.business_id = b.id AND bf.flag_key = ff.key
          WHERE b.status <> 'archived' ORDER BY b.name`,
      ),
    ),
  ]);

  const runtimeReadiness = getAiRuntimeReadiness(platform);

  const businessRowByBusiness = new Map<string, BusinessGateway>();
  const branchRowsByBusiness = new Map<string, BusinessGateway[]>();
  const branchRowByKey = new Map<string, BusinessGateway>();
  for (const row of gateways) {
    if (!row.locationId) {
      businessRowByBusiness.set(row.businessId, row);
      continue;
    }
    branchRowByKey.set(`${row.businessId}:${row.locationId}`, row);
    const list = branchRowsByBusiness.get(row.businessId) ?? [];
    list.push(row);
    branchRowsByBusiness.set(row.businessId, list);
  }

  const fleet = businessesRes.rows.map((business) => {
    const businessRow = businessRowByBusiness.get(business.id) ?? null;
    const decorated = decorateAiConfigWithState(platform, gateway, businessRow, null, business.id);
    const readiness = getAiRuntimeReadiness(decorated);
    const hasBranchOverride = (branchRowsByBusiness.get(business.id)?.length ?? 0) > 0;
    const status = deriveFleetStatus({ readiness, entitled: business.ai_entitled, syncError: businessRow?.syncError ?? null });
    return { business, readiness, hasBranchOverride, status };
  });

  let filtered = fleet;
  if (search) filtered = filtered.filter(({ business }) => business.name.toLowerCase().includes(search));
  if (statusFilter === "branch_override") filtered = filtered.filter((row) => row.hasBranchOverride);
  else if (statusFilter !== "all") filtered = filtered.filter((row) => row.status === statusFilter);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageStart = (Math.min(page, totalPages) - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  // The selected business/branch's own row must be present in the response
  // even when it fell outside the current page or the active filter — the
  // console's detail panel and the fleet table share one payload.
  const visibleBusinessIds = new Set(pageItems.map((row) => row.business.id));
  if (focusBusinessId && !visibleBusinessIds.has(focusBusinessId)) {
    const focusRow = fleet.find((row) => row.business.id === focusBusinessId);
    if (focusRow) {
      pageItems.push(focusRow);
      visibleBusinessIds.add(focusBusinessId);
    }
  }

  let branchReadiness: {
    businessId: string;
    locationId: string | null;
    entitled: boolean;
    credentialSource: "branch" | "business" | "master" | "none";
    businessHasKey: boolean;
    branchHasKey: boolean | null;
    inheritedFromBusiness: boolean;
    effectiveModel: string;
    lastVerifiedAt: string | null;
    syncError: string | null;
  } & AiRuntimeReadiness | null = null;
  if (focusBusinessId) {
    const businessMeta = businessesRes.rows.find((r) => r.id === focusBusinessId);
    if (businessMeta) {
      const businessRow = businessRowByBusiness.get(focusBusinessId) ?? null;
      const branchRow = focusLocationId ? (branchRowByKey.get(`${focusBusinessId}:${focusLocationId}`) ?? null) : null;
      const decorated = decorateAiConfigWithState(platform, gateway, businessRow, branchRow, focusBusinessId);
      const readiness = getAiRuntimeReadiness(decorated);
      const credentialSource: "branch" | "business" | "master" | "none" = branchRow?.virtualKey
        ? "branch"
        : businessRow?.virtualKey
          ? "business"
          : gateway.masterKey
            ? "master"
            : "none";
      const effective = branchRow ?? businessRow;
      branchReadiness = {
        businessId: focusBusinessId,
        locationId: focusLocationId,
        entitled: businessMeta.ai_entitled,
        ...readiness,
        credentialSource,
        businessHasKey: Boolean(businessRow?.virtualKey),
        branchHasKey: focusLocationId ? Boolean(branchRow?.virtualKey) : null,
        inheritedFromBusiness: Boolean(focusLocationId) && !branchRow?.virtualKey && Boolean(businessRow?.virtualKey),
        effectiveModel: resolveChatModel({ platformModel: platform.model, gateway, business: businessRow, branch: branchRow }),
        lastVerifiedAt: effective?.syncedAt ?? null,
        syncError: effective?.syncError ?? null,
      };
    }
  }

  // The public gateway shape (base URL, aliases, virtual-key toggle,
  // hasMasterKey) is already secret-safe — see toPublicGatewayConfig — so
  // every `ai.read` holder gets it, not only owners. Mutations stay gated
  // server-side by `ai.config.manage` on PUT/POST; the console itself hides
  // the edit controls from a read-only viewer, but that is a UI convenience,
  // not the security boundary.
  const canManage = platformCan(session.role, "ai.config.manage");
  const wantsProbe = params.get("probe") === "1";
  const firstVirtualKey = gateways.find((row) => Boolean(row.virtualKey))?.virtualKey ?? null;
  const status = canManage && wantsProbe
    ? await probeGateway(gateway, { platformModel: platform.model, virtualKey: firstVirtualKey })
    : null;

  const responseGateways = gateways.filter(
    (row) => visibleBusinessIds.has(row.businessId) && (row.locationId === null || row.businessId === focusBusinessId),
  );
  const responseLocations = locationsRes.rows.filter((r) => visibleBusinessIds.has(r.business_id));

  return NextResponse.json({
    gateway: toPublicAiGatewayConfig(gateway),
    canManage,
    provider: platform.provider,
    platformModel: platform.model,
    platformBaseUrl: gateway.baseUrl,
    providerIsGateway: true,
    active: runtimeReadiness.ready,
    runtimeReadiness,
    tenantReadiness: pageItems.map(({ business, readiness, hasBranchOverride, status: fleetStatus }) => ({
      businessId: business.id,
      entitled: business.ai_entitled,
      hasBranchOverride,
      status: fleetStatus,
      ...readiness,
    })),
    branchReadiness,
    pagination: { page: Math.min(page, totalPages), pageSize, total, totalPages },
    status,
    gateways: responseGateways.map((row) => toPublicBusinessGateway(row, gateway, platform.model)),
    locations: responseLocations.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      name: r.name,
    })),
    businesses: pageItems.map(({ business }) => ({
      businessId: business.id,
      businessName: business.name,
      aiEntitled: business.ai_entitled,
    })),
  });
});


/** Owner/Admin: LiteLLM connection setup and on-demand comprehensive probe. */
export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "probe") {
    const draft = body.gateway;
    if (!draft || typeof draft !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const current = await getAiGatewayConfig();
    const merged = mergeGatewayConfig(draft as AiGatewayInput, current);
    const [platform, gatewayRows] = await Promise.all([getPlatformAiConfig(), listBusinessGateways()]);
    const firstVirtualKey = gatewayRows.find((row) => Boolean(row.virtualKey))?.virtualKey ?? null;
    return NextResponse.json({ status: await probeGateway(merged, { platformModel: platform.model, virtualKey: firstVirtualKey }) });
  }

  if (body.action === "config") {
    const raw = body.gateway;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const input = raw as AiGatewayInput;
    const current = await getAiGatewayConfig();
    const merged = mergeGatewayConfig(input, current);
    const errors = validateGatewayInput(merged);
    if (errors.length > 0) return NextResponse.json({ error: errors[0], errors }, { status: 400 });
    const saved = await saveAiGatewayConfig(input);
    await platformAudit({
      adminId: session.padmin,
      action: "ai.gateway.save",
      entity: "platform_ai_gateway",
      entityId: "true",
      payload: {
        enabled: saved.enabled,
        baseUrl: saved.baseUrl,
        chatModel: saved.chatModel,
        embeddingModel: saved.embeddingModel,
        virtualKeysEnabled: saved.virtualKeysEnabled,
      },
    });
    return NextResponse.json({ gateway: toPublicAiGatewayConfig(saved) });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

/** Engineer/owner: per-business and per-branch virtual-key lifecycle and diagnostics. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = typeof body.businessId === "string" ? body.businessId : "";
  const locationId = typeof body.locationId === "string" && body.locationId ? body.locationId : null;
  if (!businessId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Every branch-level lifecycle action (provision/verify/rotate/revoke) must
  // refuse a location that does not actually belong to this business — see
  // issue #748 P0-3. Checked once here for a clean 400 before any gateway
  // call; ai-gateway-service.ts repeats the same check as defense in depth
  // for any other caller.
  if (locationId && !(await locationBelongsToBusiness(businessId, locationId))) {
    return NextResponse.json({ error: "ai_gateway_location_business_mismatch" }, { status: 400 });
  }

  const platform = await getPlatformAiConfig();
  const gateway = await getAiGatewayConfig();

  if (body.action === "sync_key") {
    if (!isGatewayActive(gateway)) {
      return NextResponse.json({ error: "ai_gateway_disabled" }, { status: 400 });
    }
    if (!gateway.masterKey) {
      return NextResponse.json({ error: "ai_gateway_missing_master_key" }, { status: 400 });
    }
    if (!gateway.virtualKeysEnabled) {
      return NextResponse.json({ error: "ai_gateway_virtual_keys_disabled" }, { status: 400 });
    }

    const existing = await getBusinessGateway(businessId, locationId);
    try {
      const row = await provisionVirtualKey(gateway, {
        businessId,
        locationId,
      });
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: existing?.virtualKey ? "ai.gateway.key.update" : "ai.gateway.key.create",
        entity: "ai_business_gateway",
        entityId: locationId ? `${businessId}:${locationId}` : businessId,
        payload: { keyAlias: row.keyAlias, locationId, syncError: row.syncError },
      });
      return NextResponse.json({ gateway: toPublicBusinessGateway(row, gateway, platform.model) });
    } catch (err) {
      if (err instanceof BusinessLocationMismatchError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof GatewayProvisioningError) {
        return NextResponse.json({ error: err.code, detail: err.detail }, { status: 502 });
      }
      if (err instanceof Error && err.message.startsWith("ai_gateway")) {
        return NextResponse.json({ error: err.message }, { status: 502 });
      }
      throw err;
    }
  }

  if (body.action === "revoke_key") {
    try {
      const result = await revokeVirtualKey(gateway, businessId, locationId);
      if (!result.ok) {
        // The remote revoke failed — the local key row is guaranteed to be
        // untouched (revokeVirtualKey's own contract). Report a non-2xx
        // response so the console shows this as a failure to retry, not a
        // silent success, and audit the failed attempt explicitly.
        await platformAudit({
          adminId: session.padmin,
          businessId,
          action: "ai.gateway.key.revoke_failed",
          entity: "ai_business_gateway",
          entityId: locationId ? `${businessId}:${locationId}` : businessId,
          payload: { locationId, error: result.code, detail: result.detail },
        });
        return NextResponse.json({ error: result.code ?? "ai_gateway_revoke_failed", detail: result.detail }, { status: 502 });
      }
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: "ai.gateway.key.revoke",
        entity: "ai_business_gateway",
        entityId: locationId ? `${businessId}:${locationId}` : businessId,
        payload: { locationId, alreadyGone: result.alreadyGone },
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof BusinessLocationMismatchError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  if (body.action === "verify_key") {
    try {
      const result = await verifyVirtualKey(gateway, businessId, locationId, platform.model);
      if (!result.gateway) return NextResponse.json({ error: "not_found", status: result.probe }, { status: 404 });
      return NextResponse.json({
        gateway: toPublicBusinessGateway(result.gateway, gateway, platform.model),
        status: result.probe,
      });
    } catch (err) {
      if (err instanceof BusinessLocationMismatchError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  if (body.action === "rotate_key") {
    try {
      const row = await rotateVirtualKey(gateway, businessId, locationId);
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: "ai.gateway.key.rotate",
        entity: "ai_business_gateway",
        entityId: locationId ? `${businessId}:${locationId}` : businessId,
        payload: { keyAlias: row.keyAlias, locationId, syncError: row.syncError },
      });
      return NextResponse.json({ gateway: toPublicBusinessGateway(row, gateway, platform.model) });
    } catch (err) {
      if (err instanceof BusinessLocationMismatchError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof GatewayProvisioningError) {
        // Rotation may fail either at the revoke step (old key + row both
        // preserved) or the provision step after a confirmed revoke (row now
        // visibly shows "no valid key"). Either way the attempt is audited so
        // an operator can see it happened, not just that it eventually worked.
        await platformAudit({
          adminId: session.padmin,
          businessId,
          action: "ai.gateway.key.rotate_failed",
          entity: "ai_business_gateway",
          entityId: locationId ? `${businessId}:${locationId}` : businessId,
          payload: { locationId, error: err.code, detail: err.detail },
        });
        return NextResponse.json({ error: err.code, detail: err.detail }, { status: 502 });
      }
      throw err;
    }
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
