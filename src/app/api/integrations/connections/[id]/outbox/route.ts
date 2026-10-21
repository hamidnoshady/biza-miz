import { canReadConnectionHistory } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";

/**
 * The outbox as a queue manager: every row waiting on (or recently finished
 * for) one connection, newest first — what kind of work it is, its status,
 * how many attempts it has made, and the last error if it is failing.
 *
 * The same rows serve both connection modes, which is what makes one screen
 * able to show both: in `rest_api` mode the app drains them itself on its
 * background tick, in `plugin` mode they are leased and applied by the
 * WordPress plugin on its next run. When the plugin is not running — stale
 * `last_plugin_seen_at`, WP-Cron never firing — this list is exactly what
 * shows the work sitting there and why.
 */
export interface OutboxJobRow {
  id: string;
  entityType: string;
  remoteId: string;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const { id } = await context.params;
  if (!(await canReadConnectionHistory(session, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows } = await query<{
    id: string;
    entity_type: string;
    remote_id: string;
    status: OutboxJobRow["status"];
    attempts: number;
    last_error: string | null;
    next_attempt_at: string | null;
    created_at: string;
  }>(
    `SELECT id, entity_type, remote_id, status, attempts, last_error, next_attempt_at, created_at
       FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2
      ORDER BY created_at DESC
      LIMIT 50`,
    [session.businessId, id],
  );

  return NextResponse.json({
    jobs: rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      remoteId: row.remote_id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
    })),
  });
});
