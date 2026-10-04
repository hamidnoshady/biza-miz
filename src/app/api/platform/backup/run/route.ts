import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { runPlatformBackupNow } from "@/lib/platform-backup-service";

/**
 * «پشتیبان‌گیری فوری از کل سیستم» — one whole-database dump now, plus the cloud
 * upload when a bucket is configured. The same code path the scheduler tick
 * takes, so a manual run is recorded (and mirrored, and pruned) exactly like a
 * scheduled one rather than being a second, weaker kind of backup.
 *
 * Needs `backup.run` (issue #807) — an engineer may take a backup, because
 * backing up destroys nothing. Restoring is the owner-only half.
 *
 * Deliberately synchronous: the caller is an operator watching a button, and a
 * half-finished background job the console cannot observe would be worse than a
 * slow request. A dump that outlives the request still lands its run row, so a
 * reload shows the truth either way.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("backup.run");
  if (error) return error;

  const result = await runPlatformBackupNow(session.padmin);
  const local = result.local;
  const failed = local.status === "failed";
  const detail = local.status === "failed" ? local.error.slice(0, 300) : null;

  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.run",
    entity: "platform_backup_runs",
    entityId: local.status === "ok" ? local.runId : null,
    payload: {
      localStatus: local.status,
      artifact: local.status === "ok" ? local.artifact : null,
      sizeBytes: local.status === "ok" ? local.sizeBytes : null,
      cloudStatus: result.cloud.status,
      error: detail,
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  if (failed) {
    return NextResponse.json({ error: "backup_failed", detail, result }, { status: 502 });
  }
  // A run already in flight is neither a success nor a failure, and it must not
  // be answered like one: the button's whole job here is to say whether a new
  // copy exists. `runPlatformLocalBackup` returns `busy` instead of queueing,
  // because two concurrent pg_dumps of one database are how a backup turns into
  // an outage.
  if (local.status === "busy") {
    return NextResponse.json(
      { error: "backup_busy", detail: "یک پشتیبان‌گیری دیگر همین حالا در حال اجراست.", result },
      { status: 409 },
    );
  }
  return NextResponse.json({ result });
});
