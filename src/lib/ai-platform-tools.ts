/**
 * Phase 18b Wave 3 — read-only health tools for the platform support agent.
 *
 * This is intentionally a different realm from tenant ai-tools.ts. The
 * returned shapes contain only platform health data, never orders, customers,
 * financial data, or a tenant-facing mutation surface.
 */
import { query, withoutTenantScope } from "./db";
import type { ToolResult } from "./ai-tools";
import { desktopFleetCompliance } from "./desktop-release-service";

export const PLATFORM_READ_TOOL_NAMES = new Set([
  "get_client_update_status",
  "get_backup_health",
]);

function cap<T>(rows: T[], limit = 100): T[] {
  return rows.slice(0, limit);
}

function lookbackHours(value: unknown): number {
  const hours = Math.trunc(Number(value));
  if (!Number.isFinite(hours)) return 24;
  return Math.min(Math.max(hours, 1), 168);
}

async function clientUpdateStatus() {
  const fleet = await desktopFleetCompliance();
  const outOfDate = fleet.devices.filter((device) => device.compliance === "update_available");
  const reportingProblems = fleet.devices.filter((device) =>
    ["error", "unsupported", "incompatible", "version_mismatch", "stale", "offline"].includes(device.compliance),
  );
  return {
    scope: "platform_health_only",
    connectedClientCount: fleet.devices.length,
    summary: fleet.summary,
    outOfDate: cap(
      outOfDate.map((device) => ({
        siteDeviceId: device.siteDeviceId,
        businessId: device.businessId,
        businessName: device.businessName,
        locationName: device.locationName,
        deviceName: device.deviceName,
        installedVersion: device.installedVersion,
        targetVersion: device.targetRelease?.version ?? null,
        lastReportAt: device.lastReportAt,
      })),
    ),
    reportingProblems: cap(
      reportingProblems.map((device) => ({
        siteDeviceId: device.siteDeviceId,
        businessId: device.businessId,
        businessName: device.businessName,
        locationName: device.locationName,
        deviceName: device.deviceName,
        compliance: device.compliance,
        connectivity: device.connectivity,
        lastReportAt: device.lastReportAt,
        errorCode: device.error?.code ?? null,
      })),
    ),
  };
}

type LatestBackupRow = {
  business_id: string;
  business_name: string;
  business_status: string;
  local_status: string | null;
  local_started_at: string | null;
  cloud_status: string | null;
  cloud_started_at: string | null;
};

type FailedBackupRow = {
  business_id: string;
  business_name: string;
  kind: "local" | "cloud";
  started_at: string;
};

async function backupHealth(args: Record<string, unknown>) {
  const hours = lookbackHours(args.lookbackHours);
  const [latest, failed] = await withoutTenantScope("platform", () =>
    Promise.all([
      query<LatestBackupRow>(
        `SELECT b.id AS business_id,
                b.name AS business_name,
                b.status::text AS business_status,
                local_run.status AS local_status,
                local_run.started_at AS local_started_at,
                cloud_run.status AS cloud_status,
                cloud_run.started_at AS cloud_started_at
           FROM businesses b
           LEFT JOIN LATERAL (
             SELECT br.status, br.started_at
               FROM backup_runs br
              WHERE br.business_id = b.id AND br.kind = 'local'
              ORDER BY br.started_at DESC
              LIMIT 1
           ) local_run ON true
           LEFT JOIN LATERAL (
             SELECT br.status, br.started_at
               FROM backup_runs br
              WHERE br.business_id = b.id AND br.kind = 'cloud'
              ORDER BY br.started_at DESC
              LIMIT 1
           ) cloud_run ON true
          ORDER BY b.name`,
      ),
      query<FailedBackupRow>(
        `SELECT br.business_id, b.name AS business_name, br.kind, br.started_at
           FROM backup_runs br
           JOIN businesses b ON b.id = br.business_id
          WHERE br.status = 'failed'
            AND br.started_at >= now() - make_interval(hours => $1::int)
          ORDER BY br.started_at DESC
          LIMIT 100`,
        [hours],
      ),
    ]),
  );

  return {
    scope: "platform_health_only",
    lookbackHours: hours,
    failedRuns: failed.rows.map((row) => ({
      businessId: row.business_id,
      businessName: row.business_name,
      kind: row.kind,
      startedAt: row.started_at,
    })),
    latestByBusiness: cap(
      latest.rows.map((row) => ({
        businessId: row.business_id,
        businessName: row.business_name,
        businessStatus: row.business_status,
        local: row.local_status
          ? { status: row.local_status, startedAt: row.local_started_at }
          : null,
        cloud: row.cloud_status
          ? { status: row.cloud_status, startedAt: row.cloud_started_at }
          : null,
      })),
    ),
  };
}

/** Executes only the two health tools exposed to platform mode. */
export async function runPlatformReadTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "get_client_update_status":
      return { ok: true, data: await clientUpdateStatus() };
    case "get_backup_health":
      return { ok: true, data: await backupHealth(args) };
    default:
      return { ok: false, data: { error: `ابزار پلتفرم ناشناخته: ${name}` } };
  }
}
