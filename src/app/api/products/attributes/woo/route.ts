import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getAccessibleConnection, listAccessibleConnections } from "@/lib/integrations/connection-access";
import { query } from "@/lib/db";
import { readBoundedJson } from "@/lib/product-attributes";
import { queueAttributeEnsure, type AttributeEnsurePayload } from "@/lib/integrations/product-attribute-mappings-service";
import { isUuid } from "@/lib/uuid";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ connections: [], mappings: [] });
  const connections = (await listAccessibleConnections(session)).filter(c => c.provider === "woocommerce" && (!c.locationId || c.locationId === location.id));
  const { rows: mappings } = await query(
    `SELECT m.connection_id, m.definition_id, m.remote_attribute_id, m.taxonomy, m.terms
     FROM integration_woo_attribute_mappings m JOIN item_attribute_definitions d ON d.id = m.definition_id
     WHERE m.business_id = $1 AND d.location_id = $2 AND m.connection_id = ANY($3::uuid[])`,
    [session.businessId, location.id, connections.map(c => c.id)],
  );
  return NextResponse.json({ connections, mappings });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const inventory = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (inventory.error) return inventory.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;
  const body = await readBoundedJson(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const input = body.value as Record<string, unknown>;
  if (!input || input.reviewed !== true || !isUuid(input.connectionId)) return NextResponse.json({ error: "review_required" }, { status: 400 });
  const connection = await getAccessibleConnection(session, input.connectionId);
  const location = await resolveActiveLocation(session);
  if (!connection || connection.provider !== "woocommerce" || !location || (connection.location_id && connection.location_id !== location.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { rows } = await query(`SELECT id FROM item_attribute_definitions WHERE id::text = $1 AND location_id = $2`, [input.definitionId, location.id]);
  if (!rows.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const jobId = await queueAttributeEnsure(session.businessId, connection, { ...input, reviewedBy: session.sub } as unknown as AttributeEnsurePayload);
    return NextResponse.json({ ok: true, jobId, status: "queued" }, { status: 202 });
  } catch (err) {
    const code = err instanceof Error ? err.message : "attribute_mapping_failed";
    if (!new Set(["invalid_attribute_mapping", "attribute_version_conflict", "attribute_options_mismatch", "attribute_mapping_in_progress", "attribute_mapping_conflict", "plugin_job_unsupported"]).has(code)) throw err;
    return NextResponse.json({ error: code }, { status: 409 });
  }
});
