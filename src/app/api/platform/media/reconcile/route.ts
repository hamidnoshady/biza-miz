import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import {
  listMediaOrphanScans,
  runMediaOrphanReconcileScan,
} from "@/lib/media-service";

/**
 * Superadmin-only storage orphan reconciliation API (issue #926 P1.7).
 *
 *   GET  — Recent scan reports (scheduled + manual).
 *   POST — Run an on-demand read-only scan (`apply: false`, default) or a
 *          gated manual cleanup (`apply: true, backupConfirmed: true`).
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const scans = await listMediaOrphanScans(20);
  return NextResponse.json({ scans });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("media.manage");
  if (error) return error;

  let body: { apply?: unknown; backupConfirmed?: unknown } = {};
  try {
    body = (await request.json()) as { apply?: unknown; backupConfirmed?: unknown };
  } catch {
    body = {};
  }

  const apply = body.apply === true;
  const backupConfirmed = body.backupConfirmed === true;

  if (apply && !backupConfirmed) {
    return NextResponse.json(
      {
        error: "backup_confirmation_required",
        message: "پیش از حذف دائمی فایل‌های بدون مرجع، تهیه و تأیید پشتیبان الزامی است.",
      },
      { status: 400 },
    );
  }

  const scan = await runMediaOrphanReconcileScan({
    mode: apply ? "manual_cleanup" : "manual_scan",
    apply,
    backupConfirmed,
    actorEmail: session.email ?? String(session.padmin),
  });

  await platformAudit({
    adminId: session.padmin,
    action: apply ? "platform_media.orphans.cleanup" : "platform_media.orphans.scan",
    entity: "platform_media_orphan_scans",
    entityId: scan.id || undefined,
    payload: {
      status: scan.status,
      scannedObjects: scan.scannedObjects,
      orphanCount: scan.orphanCount,
      orphanBytes: scan.orphanBytes,
      deletedCount: scan.deletedCount,
      backupConfirmed,
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  const scans = await listMediaOrphanScans(20);
  return NextResponse.json({ ok: true, scan, scans });
});
