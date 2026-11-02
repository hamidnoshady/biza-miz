import { listAccessibleConnections } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { summarizePluginHealth } from "@/lib/integrations/plugin-health";
import { cronProbeOffered } from "@/lib/integrations/plugin-cron-probe";
import { assessDomainFreshness } from "@/lib/integrations/sync-freshness";
import { pluginCronWarnAfterMs } from "@/lib/integrations/sync-timing";

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

  // The newest probe this app asked for, per connection (#1206 P0). Without it
  // a probe the plugin never picked up is indistinguishable from one it is
  // running: the app's own record is what makes "requested, nothing back yet"
  // sayable.
  const { rows: probes } = await query<{ connection_id: string; remote_id: string; created_at: Date }>(
    `SELECT DISTINCT ON (connection_id) connection_id, remote_id, created_at
       FROM integration_outbox_events
      WHERE business_id = $1 AND entity_type = 'cron_probe'
      ORDER BY connection_id, created_at DESC`,
    [session.businessId],
  );
  const probeByConnection = new Map(probes.map((row) => [row.connection_id, row]));

  // Per-domain freshness (#1206 P1): what is waiting, and when each domain last
  // moved anything, in each direction. Two grouped reads for the whole page —
  // not a query per domain.
  const { rows: domainOutbound } = await query<{
    connection_id: string;
    entity_type: string;
    backlog: string;
    oldest: Date | null;
    last_sent: Date | null;
  }>(
    `SELECT connection_id, entity_type,
            count(*) FILTER (WHERE status IN ('pending', 'failed', 'processing')) AS backlog,
            min(created_at) FILTER (WHERE status IN ('pending', 'failed', 'processing')) AS oldest,
            max(sent_at) AS last_sent
       FROM integration_outbox_events
      WHERE business_id = $1
      GROUP BY connection_id, entity_type`,
    [session.businessId],
  );
  const { rows: domainInbound } = await query<{
    connection_id: string;
    event_topic: string;
    last_processed: Date | null;
  }>(
    `SELECT connection_id, event_topic, max(processed_at) AS last_processed
       FROM integration_webhook_events
      WHERE business_id = $1 AND status = 'processed'
      GROUP BY connection_id, event_topic`,
    [session.businessId],
  );
  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
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
      // Quiet is not stale: see sync-freshness.ts. Only a backlog that stops
      // moving is graded anything other than what was last exchanged.
      domainFreshness: assessDomainFreshness(
        {
          outbound: domainOutbound
            .filter((row) => row.connection_id === c.id)
            .map((row) => ({
              entity_type: row.entity_type,
              backlog: Number(row.backlog ?? 0),
              oldest: iso(row.oldest),
              last_sent: iso(row.last_sent),
            })),
          inbound: domainInbound
            .filter((row) => row.connection_id === c.id)
            .map((row) => ({ event_topic: row.event_topic, last_processed: iso(row.last_processed) })),
        },
        now,
        { warnAfterMs: pluginCronWarnAfterMs(c.pluginHealth ?? {}) },
      ),
      pluginHealthSummary:
        c.linkMode === "plugin"
          ? summarizePluginHealth(
              { status: c.status, last_plugin_seen_at: c.lastPluginSeenAt, last_sync_at: c.lastSyncAt, plugin_health: c.pluginHealth },
              {
                size: Number(waitingByConnection.get(c.id)?.size ?? 0),
                oldestAt: waitingByConnection.get(c.id)?.oldest ? new Date(waitingByConnection.get(c.id)!.oldest!).toISOString() : null,
              },
              now,
              {
                supported: cronProbeOffered({ link_mode: c.linkMode, capabilities: c.pluginCapabilities }),
                request: probeByConnection.get(c.id)
                  ? {
                      probeId: probeByConnection.get(c.id)!.remote_id,
                      requestedAt: new Date(probeByConnection.get(c.id)!.created_at).toISOString(),
                    }
                  : null,
              },
            )
          : null,
    })),
  });
});
