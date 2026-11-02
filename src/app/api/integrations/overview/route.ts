import { listAccessibleConnections } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { summarizePluginHealth } from "@/lib/integrations/plugin-health";

/**
 * Wave 6 — the panel's monitoring summary: each connection plus the number of
 * pending/failed webhook events and pending/failed/dead outbox events.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;

  const connections = (await listAccessibleConnections(session)).filter((c) => c.provider === "woocommerce");
  const { rows: inbox } = await query<{ connection_id: string; status: string; count: string }>(
    `SELECT connection_id, status, count(*) AS count
       FROM integration_webhook_events WHERE business_id = $1
      GROUP BY connection_id, status`,
    [session.businessId],
  );
  const { rows: outbox } = await query<{ connection_id: string; status: string; count: string }>(
    `SELECT connection_id, status, count(*) AS count
       FROM integration_outbox_events WHERE business_id = $1
      GROUP BY connection_id, status`,
    [session.businessId],
  );

  // The queue's size and how long its oldest job has waited: a plugin that is
  // alive but not draining shows up here, not in last_plugin_seen_at (issue #1149).
  const { rows: waiting } = await query<{ connection_id: string; size: string; oldest: string | null }>(
    `SELECT connection_id, count(*) AS size, min(created_at) AS oldest
       FROM integration_outbox_events
      WHERE business_id = $1 AND status IN ('pending', 'failed', 'processing')
      GROUP BY connection_id`,
    [session.businessId],
  );
  const waitingByConnection = new Map(waiting.map((row) => [row.connection_id, row]));
  const now = new Date();

  const summarize = (rows: { connection_id: string; status: string; count: string }[]) => {
    const byConnection = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const entry = byConnection.get(row.connection_id) ?? {};
      entry[row.status] = Number(row.count);
      byConnection.set(row.connection_id, entry);
    }
    return byConnection;
  };
  const inboxByConnection = summarize(inbox);
  const outboxByConnection = summarize(outbox);

  return NextResponse.json({
    connections: connections.map((c) => ({
      ...c,
      inbox: inboxByConnection.get(c.id) ?? {},
      outbox: outboxByConnection.get(c.id) ?? {},
      pluginHealthSummary:
        c.linkMode === "plugin"
          ? summarizePluginHealth(
              { status: c.status, last_plugin_seen_at: c.lastPluginSeenAt, last_sync_at: c.lastSyncAt, plugin_health: c.pluginHealth },
              {
                size: Number(waitingByConnection.get(c.id)?.size ?? 0),
                oldestAt: waitingByConnection.get(c.id)?.oldest ? new Date(waitingByConnection.get(c.id)!.oldest!).toISOString() : null,
              },
              now,
            )
          : null,
    })),
  });
});
