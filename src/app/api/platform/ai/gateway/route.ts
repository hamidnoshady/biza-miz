/**
 * Phase 37, Phase 39 & Phase 40 — technical LiteLLM administration API.
 *
 * Exclusively handles LiteLLM connection parameters, model aliases, and
 * business/branch virtual-key management. All billing, money, revenue,
 * allowances and tenant monetization belong strictly to Plan/Billing.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAiRuntimeReadiness, getPlatformAiConfig } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
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
  validateGatewayInput,
  type AiGatewayInput,
} from "@/lib/ai-gateway";
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
  const tenantReadiness = await Promise.all(
    businessesRes.rows.map(async (business) => {
      const config = await resolveAiConfigFor(business.id, null);
      return { businessId: business.id, entitled: business.ai_entitled, ...getAiRuntimeReadiness(config) };
    }),
  );

  // The public gateway shape (base URL, aliases, virtual-key toggle,
  // hasMasterKey) is already secret-safe — see toPublicGatewayConfig — so
  // every `ai.read` holder gets it, not only owners. Mutations stay gated
  // server-side by `ai.config.manage` on PUT/POST; the console itself hides
  // the edit controls from a read-only viewer, but that is a UI convenience,
  // not the security boundary.
  const canManage = platformCan(session.role, "ai.config.manage");
  const wantsProbe = request.nextUrl.searchParams.get("probe") === "1";
  const firstVirtualKey = gateways.find((row) => Boolean(row.virtualKey))?.virtualKey ?? null;
  const status = canManage && wantsProbe
    ? await probeGateway(gateway, { platformModel: platform.model, virtualKey: firstVirtualKey })
    : null;

  return NextResponse.json({
    gateway: toPublicAiGatewayConfig(gateway),
    canManage,
    provider: platform.provider,
    platformModel: platform.model,
    platformBaseUrl: gateway.baseUrl,
    providerIsGateway: true,
    active: runtimeReadiness.ready,
    runtimeReadiness,
    tenantReadiness,
    status,
    gateways: gateways.map((row) => toPublicBusinessGateway(row, gateway, platform.model)),
    locations: locationsRes.rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      name: r.name,
    })),
    businesses: businessesRes.rows.map((r) => ({
      businessId: r.id,
      businessName: r.name,
      aiEntitled: r.ai_entitled,
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
