import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { getHolooSettings } from "@/lib/integrations/holoo/connection-service";
import { sendPendingHolooOutbox } from "@/lib/integrations/holoo/push-service";
import { HOLOO_DATA_TRANSFER_PROFILE } from "@/lib/data-transfer/providers/holoo/profile";
import { finishProviderSendJob, startProviderSendJob } from "@/lib/data-transfer/provider-export-service";
import { PERMISSIONS as DATA_PERMISSIONS, readBody } from "../../../guard";
import { canAccessHolooConnectionLocation, checkHolooConnectedSendPermissions, holooLocationAccess, holooTransferOwner } from "../guard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_SCOPES = ["sales", "purchases", "receiptPayment"];

/** Trigger the existing, configured Holoo outbox writer; no direct write path lives here. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await holooTransferOwner(DATA_PERMISSIONS.dataExport);
  if (error) return error;
  const body = await readBody(request);
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!UUID_RE.test(connectionId)) return NextResponse.json({ error: "invalid_connection_id" }, { status: 400 });
  const scopeAccess = await checkHolooConnectedSendPermissions(owner);
  if (!scopeAccess.ok) return NextResponse.json({ error: "forbidden", requires: scopeAccess.missing }, { status: 403 });

  const connection = await getConnection(owner.businessId, connectionId);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const locationAccess = await holooLocationAccess(owner);
  if (!canAccessHolooConnectionLocation(locationAccess, connection.location_id ?? null)) {
    return NextResponse.json({ error: "location_scope_mismatch" }, { status: 403 });
  }
  if (connection.status !== "active") return NextResponse.json({ error: "holoo_connection_inactive" }, { status: 409 });
  const settings = await getHolooSettings(owner.businessId, connectionId);
  if (!settings || settings.schemaProfile !== HOLOO_DATA_TRANSFER_PROFILE.profileKey) {
    return NextResponse.json({ error: "holoo_profile_not_verified" }, { status: 409 });
  }
  if (settings.writeMode !== "web_service") {
    // The current canonical profile explicitly forbids direct-SQL writes.
    return NextResponse.json({ error: "holoo_web_service_required" }, { status: 409 });
  }
  if (!settings.hasWebServiceCredentials) return NextResponse.json({ error: "holoo_web_service_credentials_missing" }, { status: 409 });
  if (!settings.companionActivatedAt) return NextResponse.json({ error: "holoo_companion_not_active" }, { status: 409 });

  const metadata = {
    provider: "holoo",
    direction: "export" as const,
    sourceFormat: "connected_outbox",
    connectionId,
    connectionName: connection.name,
    locationId: connection.location_id ?? null,
    profileKey: HOLOO_DATA_TRANSFER_PROFILE.profileKey,
    profileVersion: HOLOO_DATA_TRANSFER_PROFILE.profileVersion,
    selectedScopes: SEND_SCOPES,
  };
  const jobId = await startProviderSendJob({
    businessId: owner.businessId,
    actorUserId: owner.actorUserId,
    actorName: owner.actorName,
    providerMetadata: metadata,
  });

  try {
    const result = await sendPendingHolooOutbox(owner.businessId, connectionId);
    const partial = result.sent < result.attempted || result.remainingDue > 0 || result.retryScheduled > 0 || result.inFlight > 0 || result.deadLettered > 0;
    const completedMetadata = {
      ...metadata,
      outcome: partial ? "partial_failure" as const : "completed" as const,
      counts: result,
    };
    await finishProviderSendJob({
      businessId: owner.businessId,
      jobId,
      actorUserId: owner.actorUserId,
      status: partial ? "failed" : "completed",
      rowCount: result.sent,
      error: partial ? "provider_send_partial" : null,
      providerMetadata: completedMetadata,
    });
    return NextResponse.json({ ok: true, jobId, ...result, outcome: partial ? "partial_failure" : "completed" });
  } catch (caught) {
    const code = caught instanceof Error ? caught.message.split(":", 1)[0] : "provider_send_failed";
    try {
      await finishProviderSendJob({
        businessId: owner.businessId,
        jobId,
        actorUserId: owner.actorUserId,
        status: "failed",
        rowCount: 0,
        error: "provider_send_failed",
        providerMetadata: { ...metadata, outcome: "failed", counts: { errorCode: code } },
      });
    } catch (jobError) {
      console.error("failed to finalize Holoo connected-send job:", jobError instanceof Error ? jobError.message : "unknown");
    }
    const known = new Set([
      "holoo_connection_not_found",
      "holoo_web_service_required",
      "holoo_companion_not_active",
      "holoo_web_service_credentials_missing",
    ]);
    return NextResponse.json({ error: known.has(code) ? code : "provider_send_failed", jobId }, { status: 409 });
  }
});
