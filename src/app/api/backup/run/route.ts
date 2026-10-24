import { tenantBackupError } from "@/lib/tenant-backup-contract";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runBackupNow } from "@/lib/backup-service";
import { chargeForFeature } from "@/lib/billing-guard";

/**
 * "Backup now": one immediate local backup (+ cloud upload when enabled),
 * the same code path as the scheduler tick. Owner/Manager — the manual
 * trigger is deliberately wider than config editing (Owner-only).
 *
 * Metered: when the super-admin sets a per-use price on the `backup` feature
 * in the plan builder, one use is charged from the business wallet (free
 * during any free-promo window). Unpriced, the gate is a pass-through and the
 * feature flag entitlement is all that applies.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupManage);
  if (error) return error;

  const gate = await chargeForFeature(session.businessId, "backup", {
    note: "پشتیبان‌گیری دستی",
    userId: session.sub,
  });
  if (!gate.ok) return gate.response;

  const result = await runBackupNow(session.businessId);
  const publicResult = {
    local: result.local.status === "ok"
      ? { status: "ok", runId: result.local.runId, sizeBytes: result.local.sizeBytes, mode: result.local.mode }
      : result.local.status === "failed"
        ? { status: "failed", error: tenantBackupError(result.local.error) }
        : { status: result.local.status },
    cloud: result.cloud.status === "failed"
      ? { status: "failed", error: tenantBackupError(result.cloud.error) }
      : { status: result.cloud.status },
  };
  return NextResponse.json({ result: publicResult, charged: gate.charged, balanceRial: gate.balanceRial },
    { headers: { "Cache-Control": "no-store" } });
});
