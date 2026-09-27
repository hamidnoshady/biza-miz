import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { listConnections } from "@/lib/integrations/connections-service";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import {
  getMediaAsset,
  getMediaConfig,
  isMediaStorageReady,
  listWordPressMappingsForAsset,
  readMediaObjectDownloadUrl,
  recordWordPressMediaPush,
} from "@/lib/media-service";

/**
 * WordPress as a *view* over the central Media Library (migration 0174's
 * `wordpress_media_mapping`) — not a second library. This is the missing
 * producer: the schema and the mapping's whole lifecycle (recordWordPress-
 * MediaPush → confirmWordPressMediaSync/failWordPressMediaSync) already
 * existed, wired to nothing.
 *
 * GET lists which of the business's plugin-mode WooCommerce connections can
 * receive a push (`media_create` capability) and where this asset already
 * stands with each — the asset drawer's "send to WordPress" panel.
 *
 * POST pushes it: a short-lived presigned URL straight to the object in the
 * bucket (the plugin's `media_sideload_image()` runs on the WordPress
 * server, with no session of this app's to send it through `/file`), queued
 * as a `media_create` outbox job exactly like the existing arbitrary-URL
 * producer at `/api/integrations/wp-manager/media`. The difference is what
 * is being pushed — a canonical asset the operator already has in the
 * library, not a URL they typed in — and that a `wordpress_media_mapping`
 * row tracks it afterward, so the drawer can show "already on your site" the
 * next time it opens instead of only "was queued, once, at some point".
 */

const PRESIGN_TTL_SECONDS = 900;

function canPush(connection: { provider: string; link_mode: string; status: string; plugin_capabilities: Record<string, unknown> | null }): boolean {
  return (
    connection.provider === "woocommerce" &&
    connection.link_mode === "plugin" &&
    connection.status !== "paused" &&
    pluginSupportsJobType(connection.plugin_capabilities, "media_create")
  );
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const [connections, mappings] = await Promise.all([
    listConnections(session.businessId),
    listWordPressMappingsForAsset(session.businessId, id),
  ]);

  const mappingByConnection = new Map(mappings.map((m) => [m.connectionId, m]));
  const woo = connections
    .filter((c) => c.provider === "woocommerce")
    .map((c) => ({
      id: c.id,
      name: c.name,
      canPush: canPush({
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
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
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
  if (asset.kind !== "image" && asset.kind !== "video") {
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
  const download = await readMediaObjectDownloadUrl(session.businessId, id, config, PRESIGN_TTL_SECONDS);
  if (!download) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  // A fresh remote_id per push, same reasoning as the arbitrary-URL producer:
  // this creates a new WordPress object, so it must never coalesce with an
  // earlier push on the outbox's (connection, entity_type, remote_id)
  // uniqueness. `wordpress_media_mapping`'s own UNIQUE(connection_id,
  // media_asset_id) is what makes *this* endpoint idempotent per asset —
  // recordWordPressMediaPush resets the existing row rather than doubling it.
  const outboxRemoteId = `asset-${id}-${randomUUID()}`;
  const operationId = `wp-media:${connectionId}:${outboxRemoteId}`;
  const jobPayload = {
    url: download.url,
    title: download.asset.fileName,
    __operationId: operationId,
  };

  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
     VALUES ($1, $2, 'media_create', $3, $4::jsonb, $5)`,
    [session.businessId, connectionId, outboxRemoteId, JSON.stringify(jobPayload), operationId],
  );
  const mapping = await recordWordPressMediaPush({
    businessId: session.businessId,
    mediaAssetId: id,
    connectionId,
    operationId,
  });
  await writeIntegrationAudit({
    businessId: session.businessId,
    connectionId,
    action: "media.wordpress_push_queued",
    entityType: "media_create",
    remoteId: outboxRemoteId,
  });

  return NextResponse.json({ ok: true, mapping }, { status: 201 });
});
