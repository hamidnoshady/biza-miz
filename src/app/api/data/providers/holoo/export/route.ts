import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getConnection } from "@/lib/integrations/connections-service";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { getHolooSettings } from "@/lib/integrations/holoo/connection-service";
import { HOLOO_DATA_TRANSFER_PROFILE } from "@/lib/data-transfer/providers/holoo/profile";
import { HOLOO_EXPORT_SCOPES, buildHolooWorkbookExport } from "@/lib/data-transfer/providers/holoo/export";
import { createProviderExportJob } from "@/lib/data-transfer/provider-export-service";
import { fileResponse, PERMISSIONS as DATA_PERMISSIONS, readBody } from "../../../guard";
import { canAccessHolooConnectionLocation, checkHolooExportScopePermissions, holooLocationAccess, holooTransferOwner } from "../guard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function todayStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Profile-exact Holoo workbook export; job bytes and metadata use Data Transfer history. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await holooTransferOwner(DATA_PERMISSIONS.dataExport);
  if (error) return error;
  const body = await readBody(request);
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const scopes = [...new Set(stringArray(body.scopes))];
  if (!UUID_RE.test(connectionId)) return NextResponse.json({ error: "invalid_connection_id" }, { status: 400 });
  if (!scopes.length) return NextResponse.json({ error: "no_scopes_selected" }, { status: 400 });
  if (scopes.some((scope) => !HOLOO_EXPORT_SCOPES.includes(scope as (typeof HOLOO_EXPORT_SCOPES)[number]))) {
    return NextResponse.json({ error: "unsupported_scope" }, { status: 400 });
  }
  const permission = await checkHolooExportScopePermissions(owner, scopes);
  if (!permission.ok) return NextResponse.json({ error: "forbidden", requires: permission.missing }, { status: 403 });

  const connection = await getConnection(owner.businessId, connectionId);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const locationAccess = await holooLocationAccess(owner);
  if (!canAccessHolooConnectionLocation(locationAccess, connection.location_id ?? null)) {
    return NextResponse.json({ error: "location_scope_mismatch" }, { status: 403 });
  }
  const settings = await getHolooSettings(owner.businessId, connectionId);
  if (!settings) return NextResponse.json({ error: "holoo_connection_not_configured" }, { status: 409 });
  if (settings.schemaProfile !== HOLOO_DATA_TRANSFER_PROFILE.profileKey) {
    return NextResponse.json({ error: "holoo_profile_not_verified" }, { status: 409 });
  }
  const locationId = connection.location_id ?? (await resolveActiveLocation(owner.session))?.id ?? null;

  try {
    const exported = await buildHolooWorkbookExport({
      businessId: owner.businessId,
      connectionId,
      locationId,
      currencyUnit: settings.currencyUnit,
      scopes,
    });
    const fileName = `holoo-${HOLOO_DATA_TRANSFER_PROFILE.profileKey}-${todayStamp()}.xlsx`;
    const metadata = {
      provider: "holoo",
      direction: "export" as const,
      sourceFormat: "app_data",
      connectionId,
      connectionName: connection.name,
      locationId,
      profileKey: HOLOO_DATA_TRANSFER_PROFILE.profileKey,
      profileVersion: HOLOO_DATA_TRANSFER_PROFILE.profileVersion,
      selectedScopes: scopes,
      outcome: "completed" as const,
      counts: { rows: exported.rowCount, skippedMultiRolePersons: exported.skippedMultiRolePersons },
    };
    const job = await createProviderExportJob({
      businessId: owner.businessId,
      fileName,
      contentType: XLSX_CONTENT_TYPE,
      body: exported.body,
      rowCount: exported.rowCount,
      actorUserId: owner.actorUserId,
      actorName: owner.actorName,
      providerMetadata: metadata,
    });
    const warningHeader = exported.skippedMultiRolePersons ? String(exported.skippedMultiRolePersons) : "0";
    return fileResponse(exported.body, XLSX_CONTENT_TYPE, fileName, {
      "X-Export-Job": job.jobId,
      "X-Row-Count": String(exported.rowCount),
      "X-Provider-Warnings": warningHeader,
      "X-Export-Downloadable": String(job.downloadable),
    });
  } catch (caught) {
    const code = caught instanceof Error ? caught.message.split(":", 1)[0] : "provider_export_failed";
    const known = new Set(["location_required", "provider_export_too_large", "unsupported_scope"]);
    return NextResponse.json(
      { error: known.has(code) ? code : "provider_export_failed" },
      { status: code === "provider_export_too_large" ? 413 : code === "location_required" ? 409 : 400 },
    );
  }
});
