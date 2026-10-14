/**
 * Phase 37, Phase 39 & Phase 40 — technical LiteLLM administration API.
 *
 * Exclusively handles LiteLLM connection parameters, model aliases, and
 * business/branch virtual-key management. All billing, money, revenue,
 * allowances and tenant monetization belong strictly to Plan/Billing.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAiRuntimeReadiness, type AiRuntimeReadiness } from "@/lib/ai-config";
import { platformCan } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  listAiGatewayFleetPage,
  listAiGatewayLocationPage,
  type FleetQueryRow,
  type LocationQueryRow,
} from "@/lib/platform-ai-gateway-pagination";
import { decorateAiConfigWithState } from "@/lib/ai-runtime";
import {
  BusinessLocationMismatchError,
  GatewayProvisioningError,
  getAiGatewayConfig,
  getAiGatewayRuntimeSettings,
  getAnyBusinessGatewayWithKey,
  getBusinessGateway,
  listBusinessGatewaysForConsole,
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

const MAX_PAGINATION_INT = 2_147_483_647;
const MAX_SEARCH_LENGTH = 100;

/**
 * Keep values passed to PostgreSQL's integer casts finite and bounded. A zero
 * or missing value retains the route's historical default; negative values
 * become the first page, and oversized finite values are clamped before they
 * reach `$n::int`. Non-finite values are invalid input and use the default.
 */
function paginationInteger(raw: string | null, fallback: number, maximum: number): number {
  if (raw === null) return fallback;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.trunc(numeric);
  if (integer === 0) return fallback;
  return Math.min(maximum, Math.max(1, integer));
}

/** Technical LiteLLM gateway status, models, readiness and virtual keys. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  // The platform and gateway views are mapped from the same singleton read.
  let gateway: Awaited<ReturnType<typeof getAiGatewayRuntimeSettings>>["gateway"];
  let platform: Awaited<ReturnType<typeof getAiGatewayRuntimeSettings>>["platform"];
  try {
    ({ gateway, platform } = await getAiGatewayRuntimeSettings());
  } catch (err) {
    console.error("platform AI gateway snapshot unavailable", err);
    return NextResponse.json(
      { error: "ai_configuration_load_failed", runtimeReadiness: { ready: false, reason: "configuration_load_failed" } },
      { status: 503 },
    );
  }
  const platformReadiness = getAiRuntimeReadiness(platform);
  if (platformReadiness.reason === "configuration_load_failed") {
    return NextResponse.json(
      { error: "ai_configuration_load_failed", runtimeReadiness: platformReadiness },
      { status: 503 },
    );
  }

  const params = request.nextUrl.searchParams;
  const rawSearch = (params.get("search") ?? "").trim().slice(0, MAX_SEARCH_LENGTH);
  const escapedSearch = rawSearch.replace(/[!%_]/g, "!$&");
  const searchPattern = escapedSearch ? `%${escapedSearch}%` : "";
  const statusRaw = params.get("status") ?? "all";
  const statusFilter = FLEET_STATUS_FILTERS.has(statusRaw) ? statusRaw : "all";
  const pageSize = paginationInteger(params.get("pageSize"), 20, 100);
  const requestedPage = paginationInteger(params.get("page"), 1, MAX_PAGINATION_INT);
  const focusBusinessId = params.get("businessId")?.trim() || "";
  const focusLocationId = params.get("locationId")?.trim() || "";

  // The global credential is optional when tenant virtual keys are enforced:
  // an existing tenant key can still authenticate, but each business must
  // have its own key. Every other gateway-level readiness failure applies to
  // the whole fleet and can therefore be pushed into the paginated SQL query.
  const gatewayUnavailable = Boolean(
    platformReadiness.reason &&
      GATEWAY_LEVEL_REASONS.has(platformReadiness.reason) &&
      !(platformReadiness.reason === "missing_runtime_credential" && gateway.virtualKeysEnabled),
  );

  // Entitlement, branch-override presence, and sync status are aggregated in
  // one DB query. Search, status filtering, count and pagination happen before
  // rows leave Postgres; a focused business is appended separately so its
  // details remain accessible even when outside the current fleet page/filter.
  const fleetQuery = await listAiGatewayFleetPage({
    gatewayVirtualKeysEnabled: gateway.virtualKeysEnabled,
    gatewayUnavailable,
    masterKeyConfigured: Boolean(gateway.masterKey),
    searchPattern,
    statusFilter,
    focusBusinessId,
    pageSize,
    requestedPage,
  });

  const firstFleetRow = fleetQuery.rows[0];
  const pagination = {
    page: Number(firstFleetRow?.page ?? 1),
    pageSize,
    total: Number(firstFleetRow?.total ?? 0),
    totalPages: Number(firstFleetRow?.total_pages ?? 1),
  };
  const fleetRows = fleetQuery.rows.filter(
    (row): row is FleetQueryRow & { business_id: string; business_name: string; ai_entitled: boolean } =>
      Boolean(row.business_id && row.business_name !== null && row.ai_entitled !== null),
  );
  const visibleBusinessIds = fleetRows.map((row) => row.business_id);
  const locationSearch = (params.get("locationSearch") ?? "").trim().slice(0, MAX_SEARCH_LENGTH);
  const locationPageSize = paginationInteger(params.get("locationPageSize"), 50, 100);
  const requestedLocationPage = paginationInteger(params.get("locationPage"), 1, MAX_PAGINATION_INT);
  const locationPattern = locationSearch
    ? `%${locationSearch.replace(/[!%_]/g, "!$&")}%`
    : "";

  let responseLocations: { id: string; businessId: string; name: string }[] = [];
  let locationPagination = { page: 1, pageSize: locationPageSize, total: 0, totalPages: 1 };
  if (focusBusinessId && visibleBusinessIds.includes(focusBusinessId)) {
    const locationQuery = await listAiGatewayLocationPage({
      businessId: focusBusinessId,
      searchPattern: locationPattern,
      focusLocationId,
      pageSize: locationPageSize,
      requestedPage: requestedLocationPage,
    });
    const firstLocationRow = locationQuery.rows[0];
    locationPagination = {
      page: Number(firstLocationRow?.page ?? 1),
      pageSize: locationPageSize,
      total: Number(firstLocationRow?.total ?? 0),
      totalPages: Number(firstLocationRow?.total_pages ?? 1),
    };
    responseLocations = locationQuery.rows
      .filter((row): row is LocationQueryRow & { id: string; business_id: string; name: string } =>
        Boolean(row.id && row.business_id && row.name !== null),
      )
      .map((row) => ({ id: row.id, businessId: row.business_id, name: row.name }));
  }

  const focusedLocationIsValid = !focusLocationId || responseLocations.some((row) => row.id === focusLocationId);
  const branchRows = await listBusinessGatewaysForConsole(
    visibleBusinessIds,
    focusBusinessId && focusLocationId && focusedLocationIsValid
      ? { businessId: focusBusinessId, locationId: focusLocationId }
      : null,
  );
  const businessRowByBusiness = new Map<string, BusinessGateway>();
  const branchRowByKey = new Map<string, BusinessGateway>();
  for (const row of branchRows) {
    if (!row.locationId) businessRowByBusiness.set(row.businessId, row);
    else branchRowByKey.set(`${row.businessId}:${row.locationId}`, row);
  }

  const tenantReadiness = fleetRows.map((row) => {
    const businessRow = businessRowByBusiness.get(row.business_id) ?? null;
    const decorated = decorateAiConfigWithState(platform, gateway, businessRow, null, row.business_id);
    const readiness = getAiRuntimeReadiness(decorated);
    return {
      businessId: row.business_id,
      entitled: row.ai_entitled,
      hasBranchOverride: Boolean(row.has_branch_override),
      hasBranchSyncError: Boolean(row.has_branch_sync_error),
      status: row.fleet_status ?? "ready",
      ...readiness,
    };
  });

  let branchReadiness: ({
    businessId: string;
    locationId: string | null;
    entitled: boolean;
    credentialSource: "branch" | "business" | "master" | "none";
    businessHasKey: boolean;
    branchHasKey: boolean | null;
    inheritedFromBusiness: boolean;
    effectiveModel: string;
    lastVerifiedAt: string | null;
    businessSyncError: string | null;
    branchSyncError: string | null;
    syncError: string | null;
  } & AiRuntimeReadiness) | null = null;

  const focusBusiness = fleetRows.find((row) => row.business_id === focusBusinessId);
  if (focusBusiness && focusedLocationIsValid) {
    const businessRow = businessRowByBusiness.get(focusBusinessId) ?? null;
    const branchRow = focusLocationId
      ? branchRowByKey.get(`${focusBusinessId}:${focusLocationId}`) ?? null
      : null;
    const decorated = decorateAiConfigWithState(platform, gateway, businessRow, branchRow, focusBusinessId);
    const readiness = getAiRuntimeReadiness(decorated);
    const businessHasKey = Boolean(businessRow?.virtualKey);
    const branchHasKey = focusLocationId ? Boolean(branchRow?.virtualKey) : null;
    const credentialSource: "branch" | "business" | "master" | "none" = !isGatewayActive(gateway)
      ? "none"
      : gateway.virtualKeysEnabled
        ? branchRow?.virtualKey
          ? "branch"
          : businessRow?.virtualKey
            ? "business"
            : "none"
        : gateway.masterKey
          ? "master"
          : "none";
    const credentialRow = !isGatewayActive(gateway) || !gateway.virtualKeysEnabled
      ? null
      : branchRow?.virtualKey
        ? branchRow
        : businessRow?.virtualKey
          ? businessRow
          : null;
    const businessSyncError = businessRow?.syncError ?? null;
    const branchSyncError = branchRow?.syncError ?? null;
    branchReadiness = {
      businessId: focusBusinessId,
      locationId: focusLocationId || null,
      entitled: focusBusiness.ai_entitled,
      ...readiness,
      credentialSource,
      businessHasKey,
      branchHasKey,
      inheritedFromBusiness:
        gateway.virtualKeysEnabled && Boolean(focusLocationId) && !branchHasKey && businessHasKey,
      effectiveModel: resolveChatModel({ platformModel: platform.model, gateway, business: businessRow, branch: branchRow }),
      lastVerifiedAt: credentialRow?.syncedAt ?? null,
      businessSyncError,
      branchSyncError,
      syncError: branchSyncError ?? businessSyncError,
    };
  }

  const canManage = platformCan(session.role, "ai.config.manage");
  const wantsProbe = params.get("probe") === "1";
  const probeKey = canManage && wantsProbe ? await getAnyBusinessGatewayWithKey() : null;
  const status = canManage && wantsProbe
    ? await probeGateway(gateway, { platformModel: platform.model, virtualKey: probeKey?.virtualKey ?? null })
    : null;

  const responseGateways = branchRows.map((row) => toPublicBusinessGateway(row, gateway, platform.model));
  return NextResponse.json({
    gateway: toPublicAiGatewayConfig(gateway),
    canManage,
    provider: platform.provider,
    platformModel: platform.model,
    platformBaseUrl: gateway.baseUrl,
    providerIsGateway: true,
    active: platformReadiness.ready,
    runtimeReadiness: platformReadiness,
    tenantReadiness,
    branchReadiness,
    pagination,
    locationPagination,
    status,
    gateways: responseGateways,
    locations: responseLocations,
    businesses: fleetRows.filter((row) => !row.is_focused).map((row) => ({
      businessId: row.business_id,
      businessName: row.business_name,
      aiEntitled: row.ai_entitled,
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
    const { gateway: current, platform } = await getAiGatewayRuntimeSettings();
    const merged = mergeGatewayConfig(draft as AiGatewayInput, current);
    const firstVirtualKey = await getAnyBusinessGatewayWithKey();
    return NextResponse.json({
      status: await probeGateway(merged, { platformModel: platform.model, virtualKey: firstVirtualKey?.virtualKey ?? null }),
    });
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

  const { platform, gateway } = await getAiGatewayRuntimeSettings();

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
