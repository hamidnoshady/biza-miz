import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { allowWpMediaCreation } from "@/lib/integrations/wp-media-rate-limit";
import { query, withTenantTransaction } from "@/lib/db";
import { getConnection } from "@/lib/integrations/connections-service";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { parseWpMediaCreateInput } from "@/lib/integrations/wp-media";

/**
 * Add one media attachment to the connected WordPress site.
 *
 * The whole pipeline for this operation existed before this route — the
 * outbox accepts `media_create` (migration 0128), the plugin leases it,
 * sideloads the URL with WordPress's own importer, tags the attachment with
 * the operation id so a retry after an ambiguous timeout cannot create a
 * second copy, and the resulting `add_attachment` hook pushes the new file
 * back into the local mirror. What was missing was the producer: nothing
 * ever enqueued the job, and the media section stayed read-only. This is
 * that producer.
 *
 * Plugin-mode only, and only when the plugin's handshake advertised
 * `media_create`. In REST mode wp/v2 can create media only from an uploaded
 * file body — core has no sideload-by-URL — and fetching an arbitrary URL
 * from this server to re-upload it would hand every tenant an SSRF proxy.
 * The section's UI is capability-driven to match: a store that cannot do
 * this is never shown a button that claims it can.
 */
export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const parsed = parseWpMediaCreateInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const connection = await getConnection(session.businessId, connectionId);
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

  // A fresh remote_id per request: creation is not an update to an existing
  // remote object, so two different files must never coalesce on the outbox's
  // (connection, entity_type, remote_id) uniqueness. Idempotency against
  // retries lives in the operation id, which the plugin checks (and stamps on
  // the attachment) before sideloading.
  const outboxRemoteId = `new-${randomUUID()}`;
  const operationId = `wp-media:${connectionId}:${outboxRemoteId}`;
  const jobPayload = {
    url: parsed.input.url,
    ...(parsed.input.title ? { title: parsed.input.title } : {}),
    __operationId: operationId,
  };

  return withTenantTransaction(session.businessId, async () => {
    if (!await allowWpMediaCreation(session.businessId)) return NextResponse.json({ error: "media_rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
     VALUES ($1, $2, 'media_create', $3, $4::jsonb, $5)`,
    [session.businessId, connectionId, outboxRemoteId, JSON.stringify(jobPayload), operationId],
  );
  await writeIntegrationAudit({
    businessId: session.businessId,
    connectionId,
    action: "content.media_create_queued",
    entityType: "media_create",
    remoteId: outboxRemoteId,
  });

  return NextResponse.json({ ok: true, queued: true });
  });
});
