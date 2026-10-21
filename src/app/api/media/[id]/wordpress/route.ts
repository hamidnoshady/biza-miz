import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermissions } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query, withTenantTransaction } from "@/lib/db";
import { listConnections } from "@/lib/integrations/connections-service";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import {
  getMediaAsset,
  getMediaConfig,
  isMediaStorageReady,
  listWordPressMappingsForAsset,
  recordWordPressMediaPush,
  getWordPressMediaMapping,
} from "@/lib/media-service";

/** Canonical media is stored once; the per-connection mapping tracks the
 * remote attachment. Ambiguous retries must use the same Queue operation.
 * Execution-time download URL minting is tracked in #926.
 */

import { canPushWpMedia } from "@/lib/integrations/wp-media";

function canPush(connection: { provider: string; link_mode: string; status: string; plugin_capabilities: Record<string, unknown> | null }): boolean {
  return (
    connection.provider === "woocommerce" &&
    connection.link_mode === "plugin" &&
    connection.status !== "paused" &&
    pluginSupportsJobType(connection.plugin_capabilities, "media_create")
  );
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.mediaView, PERMISSIONS.woocommerceView);
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const [connections, mappings] = await Promise.all([
    listConnections(session.businessId),
    listWordPressMappingsForAsset(session.businessId, id),
  ]);

  const manageAccess = await requirePermissions(PERMISSIONS.mediaManage, PERMISSIONS.woocommerceManage);
  const mappingByConnection = new Map(mappings.map((m) => [m.connectionId, m]));
  const woo = connections
    .filter((c) => c.provider === "woocommerce")
    .map((c) => ({
      id: c.id,
      name: c.name,
      canPush: !manageAccess.error && canPush({
        provider: c.provider,
        link_mode: c.linkMode,
        status: c.status,
        plugin_capabilities: c.pluginCapabilities,
      }),
      mapping: mappingByConnection.get(c.id) ?? null,
    }));

  return NextResponse.json({ ok: true, connections: woo });
});

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.mediaManage, PERMISSIONS.woocommerceManage);
  if (error) return error;
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  if (!canPushWpMedia(asset.mimeType)) {
    return NextResponse.json({ error: "unsupported_kind" }, { status: 400 });
  }

  const { rows: connRows } = await query<{
    id: string;
    provider: string;
    link_mode: string;
    status: string;
    plugin_capabilities: Record<string, unknown> | null;
  }>(
    `SELECT id, provider, link_mode, status, plugin_capabilities
       FROM integration_connections WHERE id = $1 AND business_id = $2`,
    [connectionId, session.businessId],
  );
  const connection = connRows[0];
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }
  if (connection.link_mode !== "plugin") {
    return NextResponse.json({ error: "media_rest_unsupported" }, { status: 409 });
  }
  if (!pluginSupportsJobType(connection.plugin_capabilities, "media_create")) {
    return NextResponse.json({ error: "plugin_media_unsupported" }, { status: 409 });
  }

  const config = await getMediaConfig();
  if (!isMediaStorageReady(config)) {
    return NextResponse.json({ error: "storage_not_configured" }, { status: 503 });
  }
  // Serialize even the first push (there is no mapping row to lock yet).
  // The outbox and mapping must commit together; a unique mapping alone does
  // not stop two jobs from creating two remote attachments.
  const result = await withTenantTransaction(session.businessId, async () => {
    const { rows } = await query(
      `SELECT id FROM media_assets WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [session.businessId, id],
    );
    if (!rows.length) return null;
    const existing = await getWordPressMediaMapping(session.businessId, connectionId, id);
    // Failed/ambiguous jobs retain their operation identity. The Queue retry
    // workflow retries that job rather than creating a second attachment.
    if (existing && existing.lastError !== "remote_attachment_deleted") {
      return { mapping: existing, created: false, remoteId: "" };
    }
    const outboxRemoteId = `asset-${id}-${randomUUID()}`;
    const operationId = `wp-media:${connectionId}:${outboxRemoteId}`;
    const jobPayload = { __mediaAssetId: id, title: asset.fileName, __operationId: operationId };
    await query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
       VALUES ($1, $2, 'media_create', $3, $4::jsonb, $5)`,
      [session.businessId, connectionId, outboxRemoteId, JSON.stringify(jobPayload), operationId],
    );
    const mapping = await recordWordPressMediaPush({ businessId: session.businessId, mediaAssetId: id, connectionId, operationId });
    await writeIntegrationAudit({
      businessId: session.businessId,
      connectionId,
      action: "media.wordpress_push_queued",
      entityType: "media_create",
      remoteId: outboxRemoteId,
    });
    return { mapping, created: true, remoteId: outboxRemoteId };
  });
  if (!result) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  const { mapping } = result;

  return NextResponse.json({ ok: true, mapping, coalesced: !result.created }, { status: result.created ? 201 : 200 });
});
