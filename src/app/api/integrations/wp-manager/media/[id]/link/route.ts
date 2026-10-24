/** Intentional link, not remote-file ingestion: canonical bytes/storage usage
 * remain unchanged. One connection's remote identity cannot silently replace
 * another mapping or become associated with a different tenant's asset.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query, withTenantTransaction } from "@/lib/db";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import { safeWpExternalUrl } from "@/lib/integrations/wp-media";
import { getWordPressMediaMapping, recordWordPressMediaPush, confirmWordPressMediaSync } from "@/lib/media-service";
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.mediaView, PERMISSIONS.mediaManage, PERMISSIONS.woocommerceManage);
  if (error) return error;
  const { id } = await context.params;
  let body: { connectionId?: string; assetId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!body || typeof body.connectionId !== "string" || typeof body.assetId !== "string" || !uuid.test(body.connectionId) || !uuid.test(body.assetId) || !/^[1-9]\d*$/.test(id)) return NextResponse.json({ error: "invalid_link" }, { status: 400 });
  const { connectionId, assetId } = body as { connectionId: string; assetId: string };
  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  return withTenantTransaction(session.businessId, async () => {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wp-media-connection:${connectionId}`]);
    const { rows: assets } = await query(`SELECT id FROM media_assets WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, [session.businessId, assetId]);
    const { rows: remote } = await query<{ media_url: string; status: string }>(`SELECT media_url, status FROM integration_wp_content WHERE business_id = $1 AND connection_id = $2 AND wp_type = 'attachment' AND remote_id = $3`, [session.businessId, connectionId, id]);
    const url = safeWpExternalUrl(remote[0]?.media_url);
    if (!assets.length || !url || remote[0].status === "trash") return NextResponse.json({ error: "link_target_unavailable" }, { status: 404 });
    const existing = await getWordPressMediaMapping(session.businessId, connectionId, assetId);
    if (existing?.wpMediaId === id && existing.status === "synced") return NextResponse.json({ ok: true, coalesced: true });
    if (existing && existing.lastError !== "remote_attachment_deleted") return NextResponse.json({ error: "mapping_conflict" }, { status: 409 });
    const { rows: reverse } = await query(`SELECT id FROM wordpress_media_mapping WHERE business_id = $1 AND connection_id = $2 AND wp_media_id = $3`, [session.businessId, connectionId, id]);
    if (reverse.length) return NextResponse.json({ error: "remote_already_linked" }, { status: 409 });
    const operationId = `wp-media-link:${connectionId}:${randomUUID()}`;
    await recordWordPressMediaPush({ businessId: session.businessId, mediaAssetId: assetId, connectionId, operationId });
    await confirmWordPressMediaSync(operationId, id, url, { businessId: session.businessId, connectionId });
    await writeIntegrationAudit({ businessId: session.businessId, connectionId, action: "media.remote_linked", entityType: "attachment", remoteId: id });
    return NextResponse.json({ ok: true });
  });
});
