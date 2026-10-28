import { tenantBackupError } from "@/lib/tenant-backup-contract";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runBackupNow } from "@/lib/backup-service";
import { chargeForFeature, preflightFeatureUse } from "@/lib/billing-guard";
import { backupUseChargeDecision } from "@/lib/backup-billing-settlement";

/**
 * "Backup now": one immediate local backup (+ cloud upload when enabled),
 * the same code path as the scheduler tick. Owner/Manager — the manual
 * trigger is deliberately wider than config editing (Owner-only).
 *
 * Metered, and settled the fair way (issue #903 §7): the route **preflights**
 * entitlement and affordability, runs the work, and only settles a per-use
 * charge once an artifact actually exists. A run that fails (full disk,
 * unreachable dump URL, an empty/aborted attempt) is never charged — the
 * previous behaviour debited a nonrefundable use before doing anything, which
 * the epic calls out explicitly. `backup-billing-settlement.ts` owns that
 * decision; this route only feeds it the outcome.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupManage);
  if (error) return error;

  const preflight = await preflightFeatureUse(session.businessId, "backup");
  if (!preflight.ok) return preflight.response;

  const result = await runBackupNow(session.businessId);

  const outcome =
    result.local.status === "ok" ? "success" : result.local.status === "failed" ? "failed" : "cancelled";
  const decision = backupUseChargeDecision({
    businessId: session.businessId,
    artifactIds: result.local.status === "ok" ? [result.local.runId] : [],
    outcome,
    // A successful run has already streamed the artifact to disk and recorded
    // its checksum (`finishRun`); an empty artifact is not a success.
    verified: result.local.status === "ok" && result.local.sizeBytes > 0,
    destinations: result.cloud.status === "disabled" ? ["local"] : ["local", "cloud"],
    priceRial: preflight.priceRial,
  });

  let charged = false;
  let balanceRial = preflight.balanceRial;
  if (decision.action === "charge") {
    try {
      const gate = await chargeForFeature(session.businessId, "backup", {
        note: "پشتیبان‌گیری دستی",
        userId: session.sub,
        // The run this charge is for. The refund reconciliation (issue #903 §7)
        // matches on it, so a failed run's pre-charge can be reversed exactly.
        metadata: {
          runId: result.local.status === "ok" ? result.local.runId : null,
          source: "backup.run.route",
        },
      });
      if (gate.ok) {
        charged = gate.charged;
        balanceRial = gate.balanceRial ?? balanceRial;
      }
    } catch {
      // The artifact exists and must still be reported. A settlement that could
      // not complete is a reconciliation item, not a failed backup.
      charged = false;
    }
  }

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
  return NextResponse.json(
    {
      result: publicResult,
      charged,
      balanceRial,
      // Why no charge was taken, in the API vocabulary rather than prose.
      settlement: { action: decision.action, reason: decision.reason },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
