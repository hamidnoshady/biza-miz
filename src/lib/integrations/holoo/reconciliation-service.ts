/**
 * Phase 26 (issue #125) Wave 9 — companion-mode reconciliation & monitoring.
 *
 * The trust check: prove the app and Holoo have not drifted apart, and make the
 * connection's health observable. Reconciliation compares the app's shadow
 * documents (those posted after `companion_activated_at`) against Holoo for a
 * period, account-by-account where the trial balance is asked for (Wave 6's
 * pure `trialBalanceDiscrepancies`), and stores the top-level result in the
 * existing `integration_reconciliations` table — the WooCommerce reconciliation
 * page is the template. Monitoring reports connection health, cursor lag,
 * outbox depth and dead letters.
 */
import { query, withoutTenantScope, withTenant } from "../../db";
import { isAppServiceOperational } from "../../service-activation/app-gate-service";
import { getConnection } from "../connections-service";
import { getHolooSettingsRow, holooSqlConfigFor } from "./connection-service";
import { isFeatureEnabled } from "../../features";
import { reconcileTotals } from "../reconciliation";
import { writeIntegrationAudit } from "../audit";
import { connectHolooSql } from "./client";
import { holooAmountToRial } from "./holoo-money";
import { profileForKey } from "./schema-profile";

export const HOLOO_RECONCILIATION_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface HolooReconciliationResult {
  periodStart: string;
  periodEnd: string;
  holooCount: number;
  holooTotalRial: string;
  appCount: number;
  appTotalRial: string;
  differenceRial: string;
  inBalance: boolean;
}

function ident(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function maxIsoDate(a: string, b: string | null): string {
  if (!b) return a;
  const date = b.slice(0, 10);
  return date > a ? date : a;
}

async function localShadowTotals(
  businessId: string,
  after: string,
  before: string,
): Promise<{ count: number; totalRial: bigint }> {
  // Companion reconciliation is sales-document first: compare the orders the
  // POS created after activation with Holoo's invoice table for the same
  // period. The ledger still powers accounting reports; this top-level health
  // check deliberately uses document headers so retail domain-event source ids
  // (which point at items) cannot collapse multiple sales together.
  const { rows } = await query<{ count: string; total: string }>(
    `SELECT count(*)::text AS count, COALESCE(SUM(o.total), 0)::text AS total
       FROM orders o
       JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1
        AND o.status = 'completed'
        AND o.closed_at >= $2::date AND o.closed_at < $3::date`,
    [businessId, after, before],
  );
  return { count: Number(rows[0]?.count ?? 0), totalRial: BigInt(rows[0]?.total ?? "0") };
}

/** Holoo-side totals for the period, read through the matched SQL profile. */
async function holooTotals(
  businessId: string,
  connectionId: string,
  after: string,
  before: string,
): Promise<{ count: number; totalRial: bigint }> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings?.schema_profile) return { count: 0, totalRial: 0n };
  const profile = profileForKey(settings.schema_profile);
  if (!profile) return { count: 0, totalRial: 0n };

  const table = profile.tables.invoices;
  const dateColumn = profile.columns.invoices.date;
  const totalColumn = profile.columns.invoices.total;
  const sql =
    `SELECT COUNT(*) AS ${ident("count")}, COALESCE(SUM(${ident(totalColumn)}), 0) AS ${ident("total")} ` +
    `FROM ${ident(table)} WHERE ${ident(dateColumn)} >= ${literal(after)} AND ${ident(dateColumn)} < ${literal(before)}`;

  const client = await connectHolooSql(holooSqlConfigFor(settings));
  try {
    const rows = await client.query<{ count: number | string; total: number | string }>(sql);
    const count = Number(rows[0]?.count ?? 0);
    const totalRial = holooAmountToRial(rows[0]?.total ?? 0, settings.currency_unit);
    return { count, totalRial };
  } finally {
    await client.close();
  }
}

export async function runHolooReconciliation(
  businessId: string,
  connectionId: string,
  createdBy: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<HolooReconciliationResult | null> {
  if (!(await isAppServiceOperational(businessId, "accounting"))) return null;
  const connection = await getConnection(businessId, connectionId);
  if (!connection) return null;
  const settings = await getHolooSettingsRow(businessId, connectionId);
  const effectiveStart = maxIsoDate(periodStart, settings?.companion_activated_at ?? null);

  const [remote, local] = await Promise.all([
    holooTotals(businessId, connectionId, effectiveStart, periodEnd),
    localShadowTotals(businessId, effectiveStart, periodEnd),
  ]);
  const result = reconcileTotals({
    remoteOrderCount: remote.count,
    remoteTotalRial: remote.totalRial,
    localOrderCount: local.count,
    localTotalRial: local.totalRial,
  });

  await query(
    `INSERT INTO integration_reconciliations
       (business_id, connection_id, period_start, period_end,
        remote_order_count, remote_total_rial, local_order_count, local_total_rial, difference_rial, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      businessId,
      connectionId,
      effectiveStart,
      periodEnd,
      result.remoteOrderCount,
      result.remoteTotalRial.toString(),
      result.localOrderCount,
      result.localTotalRial.toString(),
      result.differenceRial.toString(),
      createdBy,
    ],
  );

  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "reconciliation.run",
    payload: { inBalance: result.inBalance, differenceRial: result.differenceRial.toString() },
  });

  return {
    periodStart: effectiveStart,
    periodEnd,
    holooCount: result.remoteOrderCount,
    holooTotalRial: result.remoteTotalRial.toString(),
    appCount: result.localOrderCount,
    appTotalRial: result.localTotalRial.toString(),
    differenceRial: result.differenceRial.toString(),
    inBalance: result.inBalance,
  };
}

export interface HolooHealth {
  status: "active" | "paused" | "error" | "missing";
  lastError: string | null;
  /** Minutes since the last successful pull, or null when never pulled. */
  cursorLagMinutes: number | null;
  outboxDepth: number;
  deadLetters: number;
}

export async function holooHealth(businessId: string, connectionId: string): Promise<HolooHealth> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) return { status: "missing", lastError: null, cursorLagMinutes: null, outboxDepth: 0, deadLetters: 0 };

  const { rows: cursor } = await query<{ last_seen_at: string | null }>(
    `SELECT max(last_seen_at) AS last_seen_at FROM holoo_sync_cursors
      WHERE business_id = $1 AND connection_id = $2`,
    [businessId, connectionId],
  );
  const { rows: outbox } = await query<{ pending: string; dead: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('pending','failed'))::text AS pending,
            count(*) FILTER (WHERE status = 'dead')::text AS dead
       FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2`,
    [businessId, connectionId],
  );

  const cursorLagMinutes = cursor[0]?.last_seen_at
    ? Math.round((Date.now() - new Date(cursor[0].last_seen_at).getTime()) / 60_000)
    : null;

  return {
    status: connection.status,
    lastError: connection.last_error,
    cursorLagMinutes,
    outboxDepth: Number(outbox[0]?.pending ?? 0),
    deadLetters: Number(outbox[0]?.dead ?? 0),
  };
}

/** Nightly reconciliation over the last 24h for every companion-mode connection. */
export async function runHolooReconciliationTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT id, business_id FROM integration_connections WHERE status = 'active' AND provider = 'holoo'`,
    ),
  );
  for (const { business_id, id } of rows) {
    await withTenant(business_id, async () => {
      try {
        if (!(await isFeatureEnabled(business_id, "holoo_companion"))) return;
        const now = new Date();
        const start = new Date(now.getTime() - 24 * 3600 * 1000);
        await runHolooReconciliation(business_id, id, null, start.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
      } catch (err) {
        console.error(`holoo reconciliation tick failed for connection ${id}:`, (err as Error).message);
      }
    });
  }
}
