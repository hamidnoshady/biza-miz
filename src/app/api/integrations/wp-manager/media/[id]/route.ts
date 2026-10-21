import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query, withTenantTransaction } from "@/lib/db";
import { getConnection } from "@/lib/integrations/connections-service";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { allowWpMediaCreation } from "@/lib/integrations/wp-media-rate-limit";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import { safeWpExternalUrl } from "@/lib/integrations/wp-media";
import { editableWpField } from "@/lib/integrations/wp-content-service";

type Context = { params: Promise<{ id: string }> };
export const GET = withTenantScope(async (request: Request, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;
  const { id } = await context.params;
  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (!/^[1-9]\d*$/.test(id) || !connectionId) return NextResponse.json({ error: "invalid_attachment" }, { status: 400 });
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { rows } = await query<{ title: string; status: string; mime_type: string | null; media_url: string | null; payload: Record<string, unknown>; remote_updated_at: string | null }>(`SELECT title, status, mime_type, media_url, payload, remote_updated_at FROM integration_wp_content WHERE business_id = $1 AND connection_id = $2 AND wp_type = 'attachment' AND remote_id = $3`, [session.businessId, connectionId, id]);
  const row = rows[0];
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { rows: mappings } = await query(`SELECT media_asset_id, status, last_error FROM wordpress_media_mapping WHERE business_id = $1 AND connection_id = $2 AND wp_media_id = $3`, [session.businessId, connectionId, id]);
  const { rows: jobs } = await query(`SELECT id, status, last_error, payload->>'action' AS action FROM integration_outbox_events WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'media_update' AND payload->>'attachment_id' = $3 ORDER BY created_at DESC LIMIT 10`, [session.businessId, connectionId, id]);
  return NextResponse.json({ jobs, canTrash: connection.plugin_capabilities?.mediaTrash === true, attachment: { id, title: row.title, status: row.status, mimeType: row.mime_type, url: safeWpExternalUrl(row.media_url), altText: typeof row.payload.alt_text === "string" ? row.payload.alt_text : "", caption: editableWpField(row.payload.excerpt), description: editableWpField(row.payload.content), revision: row.payload.revision ?? null, filename: row.payload.filename ?? null, size: row.payload.filesize ?? null, date: row.payload.date ?? null, updatedAt: row.remote_updated_at, usage: row.payload.usage ?? null, mappings }, canEdit: connection.status !== "paused" && connection.link_mode === "plugin" && pluginSupportsJobType(connection.plugin_capabilities, "media_update") });
});

export const POST = withTenantScope(async (request: Request, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
  if (error) return error;
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof body.connectionId !== "string" || !/^[1-9]\d*$/.test(id)) return NextResponse.json({ error: "invalid_attachment" }, { status: 400 });
  const action = body.action;
  if (!["inspect", "update", "trash", "restore"].includes(String(action))) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  if (action === "trash" && body.confirmRemote !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  const fields: Record<string, string> = {};
  for (const [key, max] of Object.entries({ title: 200, alt_text: 1000, caption: 5000, description: 20000 })) {
    if (key in body) {
      if (typeof body[key] !== "string" || body[key].length > max) return NextResponse.json({ error: "invalid_metadata" }, { status: 400 });
      fields[key] = body[key];
    }
  }
  const connection = await getConnection(session.businessId, body.connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  if (connection.link_mode !== "plugin" || !pluginSupportsJobType(connection.plugin_capabilities, "media_update")) return NextResponse.json({ error: "plugin_media_update_unsupported" }, { status: 409 });
  if (action !== "inspect" && (typeof body.revision !== "string" || !/^[1-9]\d{0,18}$/.test(body.revision))) return NextResponse.json({ error: "refresh_attachment_first" }, { status: 409 });
  return withTenantTransaction(session.businessId, async () => {
    if (!await allowWpMediaCreation(session.businessId)) return NextResponse.json({ error: "media_rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
    const operationId = `wp-media-edit:${connection.id}:${randomUUID()}`;
    const payload = { action, fields, expected_revision: body.revision, acknowledge_usage: body.acknowledgeUsage === true, attachment_id: id, __operationId: operationId };
    const { rows } = await query<{ id: string }>(`INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id) VALUES ($1, $2, 'media_update', $3, $4::jsonb, $5) RETURNING id`, [session.businessId, connection.id, `${id}:${operationId}`, JSON.stringify(payload), operationId]);
    await writeIntegrationAudit({ businessId: session.businessId, connectionId: connection.id, action: `media.${action}_queued`, entityType: "attachment", remoteId: id });
    return NextResponse.json({ ok: true, queued: true, jobId: rows[0].id }, { status: 202 });
  });
});
