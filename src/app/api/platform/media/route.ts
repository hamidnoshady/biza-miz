import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import {
  detectStorageLocationChange,
  maskMediaConfig,
  validateMediaConfigInput,
} from "@/lib/media";
import {
  countAllStoredMediaAssets,
  getMediaConfig,
  listMediaMigrationAudits,
  listMediaOrphanScans,
  migrateMediaStorage,
  recordMediaMigrationAudit,
  rollbackMediaStorage,
  runMediaOrphanReconcileScan,
  saveMediaConfig,
} from "@/lib/media-service";
import { query } from "@/lib/db";

/** Persian text for the storage-config validation codes, shared by PUT and POST. */
function mediaConfigErrorMessage(code: string): string {
  switch (code) {
    case "endpoint_required":
      return "برای فعال‌سازی، آدرس سرویس S3 لازم است.";
    case "endpoint_invalid":
      return "آدرس سرویس S3 معتبر نیست؛ نمونهٔ درست: https://s3.parspack.com";
    case "endpoint_insecure":
      return "آدرس سرویس S3 باید با https باشد. آدرس http فقط برای سرویس محلی (localhost) یا همان آدرس ذخیره‌شدهٔ فعلی مجاز است.";
    case "bucket_required":
      return "نام باکت لازم است.";
    case "credentials_required":
      return "کلید دسترسی و کلید محرمانه هر دو لازم‌اند.";
    default:
      return "تنظیمات ذخیره‌سازی معتبر نیست.";
  }
}

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const [config, statsRows, migrations, orphanScans] = await Promise.all([
    getMediaConfig(),
    query<{ businesses: string; assets: string; bytes: string }>(
      `SELECT COUNT(DISTINCT business_id) AS businesses, COUNT(*) AS assets, COALESCE(SUM(byte_size), 0) AS bytes
         FROM media_assets`,
    ),
    listMediaMigrationAudits(10),
    listMediaOrphanScans(10),
  ]);
  return NextResponse.json({
    config: maskMediaConfig(config),
    migrationState: config.migrationState ?? "idle",
    canRollback: Boolean(config.previousFallback),
    previousStorage: config.previousFallback
      ? {
          endpoint: config.previousFallback.endpoint,
          region: config.previousFallback.region,
          bucket: config.previousFallback.bucket,
          keyPrefix: config.previousFallback.keyPrefix,
        }
      : null,
    migrations,
    orphanScans,
    usage: {
      businesses: Number(statsRows.rows[0]?.businesses ?? 0),
      assets: Number(statsRows.rows[0]?.assets ?? 0),
      bytes: Number(statsRows.rows[0]?.bytes ?? 0),
    },
  });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("media.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const before = await getMediaConfig();
  const result = validateMediaConfigInput(body, before);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: mediaConfigErrorMessage(result.error) },
      { status: 400 },
    );
  }

  // Issue #926 P1.5: block unsafe direct location overwrites (`endpoint`, `bucket`,
  // `keyPrefix`) whenever stored media assets already exist. Operators must run
  // the verified copy + sha256 migration workflow (`POST /api/platform/media`
  // with `{ mode: "migrate" }`) so existing objects never become unreachable.
  const locationDiff = detectStorageLocationChange(before, result.config);
  if (locationDiff.changed) {
    const counts = await countAllStoredMediaAssets();
    if (counts.totalAssets > 0) {
      await recordMediaMigrationAudit({
        actorEmail: session.email ?? String(session.padmin),
        action: "location_change_blocked",
        status: "blocked",
        sourceSummary: {
          endpoint: before.endpoint,
          region: before.region,
          bucket: before.bucket,
          keyPrefix: before.keyPrefix,
        },
        targetSummary: {
          endpoint: result.config.endpoint,
          region: result.config.region,
          bucket: result.config.bucket,
          keyPrefix: result.config.keyPrefix,
        },
        totalAssets: counts.totalAssets,
        totalBytes: counts.totalBytes,
        errorDetail: `changed:${locationDiff.changedFields.join(",")}`,
        completed: true,
      });
      await platformAudit({
        adminId: session.padmin,
        action: "platform_media.config.location_change_blocked",
        entity: "platform_media_config",
        payload: {
          changedFields: locationDiff.changedFields,
          totalAssets: counts.totalAssets,
          totalBytes: counts.totalBytes,
        },
        ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
        userAgent: request.headers.get("user-agent"),
      });
      return NextResponse.json(
        {
          error: "storage_migration_required",
          message:
            "تغییر مستقیم آدرس، باکت یا پیشوند در حالی که فایل‌های ذخیره‌شده وجود دارند مسدود شده است. از فرایند «مهاجرت امن و تأیید SHA-256» استفاده کنید تا هیچ فایلی غیرقابل‌دسترس نشود.",
          changedFields: locationDiff.changedFields,
          assetCount: counts.totalAssets,
          totalBytes: counts.totalBytes,
        },
        { status: 409 },
      );
    }
  }

  await saveMediaConfig(result.config, session.padmin);
  await recordMediaMigrationAudit({
    actorEmail: session.email ?? String(session.padmin),
    action: "config_saved",
    status: "completed",
    sourceSummary: {
      endpoint: before.endpoint,
      region: before.region,
      bucket: before.bucket,
      keyPrefix: before.keyPrefix,
    },
    targetSummary: {
      endpoint: result.config.endpoint,
      region: result.config.region,
      bucket: result.config.bucket,
      keyPrefix: result.config.keyPrefix,
    },
    completed: true,
  });

  await platformAudit({
    adminId: session.padmin,
    action: "platform_media.config.update",
    entity: "platform_media_config",
    payload: {
      enabled: result.config.enabled,
      endpointSet: Boolean(result.config.endpoint),
      bucket: result.config.bucket,
      keyPrefix: result.config.keyPrefix,
      billingEnabled: result.config.billingEnabled,
      dailyFlatRial: result.config.dailyFlatRial,
      dailyPerGbRial: result.config.dailyPerGbRial,
      freeQuotaMb: result.config.freeQuotaMb,
      enhanceModel: result.config.enhanceModel,
      enhancePriceRial: result.config.enhancePriceRial,
      secretsChanged: { secretAccessKey: before.secretAccessKey !== result.config.secretAccessKey },
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ config: maskMediaConfig(result.config) });
});

/**
 * Superadmin-only operational workflows over `/api/platform/media` (P1.5 & P1.7):
 *   - `{ mode: "migrate", ...targetConfig }` — verified copy + SHA-256 switch
 *   - `{ mode: "rollback" }` — re-verify & switch back to preserved fallback
 *   - `{ mode: "reconcile", apply?: boolean, backupConfirmed?: boolean }` — orphan scan / gated cleanup
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("media.manage");
  if (error) return error;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const actorEmail = session.email ?? String(session.padmin);
  const ipAddress = (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0);
  const userAgent = request.headers.get("user-agent");

  // Issue #1080 — an explicit mode is mandatory. Before this, anything that was
  // not `reconcile` or `rollback` (including a missing mode, a typo, or a body
  // that merely carried `apply`) fell through to the migration branch below:
  // a malformed request could start a full copy + configuration cutover.
  // Nothing destructive or configuration-changing may happen on a guess.
  const mode = body.mode;
  if (mode !== "migrate" && mode !== "rollback" && mode !== "reconcile") {
    return NextResponse.json(
      {
        error: "invalid_mode",
        message:
          mode === undefined || mode === null || mode === ""
            ? "نوع عملیات مشخص نشده است؛ یکی از «migrate»، «rollback» یا «reconcile» لازم است."
            : "نوع عملیات شناخته‌شده نیست؛ فقط «migrate»، «rollback» یا «reconcile» مجاز است.",
        allowedModes: ["migrate", "rollback", "reconcile"],
      },
      { status: 400 },
    );
  }

  if (mode === "reconcile") {
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
      actorEmail,
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
      ipAddress,
      userAgent,
    });

    const scans = await listMediaOrphanScans(20);
    return NextResponse.json({ ok: true, scan, scans });
  }

  if (mode === "rollback") {
    const rolled = await rollbackMediaStorage({
      actorEmail,
      adminId: session.padmin,
    });
    if (!rolled.ok) {
      return NextResponse.json(
        { error: rolled.error, message: rolled.detail },
        { status: 409 },
      );
    }
    const updated = await getMediaConfig();
    const migrations = await listMediaMigrationAudits(10);
    await platformAudit({
      adminId: session.padmin,
      action: "platform_media.storage.rollback",
      entity: "platform_media_config",
      payload: {
        verifiedAssets: rolled.verifiedAssets,
        bucket: updated.bucket,
        keyPrefix: updated.keyPrefix,
      },
      ipAddress,
      userAgent,
    });
    return NextResponse.json({
      ok: true,
      mode: "rollback",
      verifiedAssets: rolled.verifiedAssets,
      config: maskMediaConfig(updated),
      migrations,
    });
  }

  const current = await getMediaConfig();
  // Issue #1080 — preserve the configured enabled/disabled state. The migration
  // used to force `enabled: true`, silently switching the library on for every
  // tenant as a side effect of moving bytes. Enabling the library is its own
  // explicit action on the PUT path (the console's checkbox), never a migration
  // side effect.
  const validated = validateMediaConfigInput({ ...body, enabled: current.enabled }, current);
  if (!validated.ok) {
    return NextResponse.json(
      { error: validated.error, message: mediaConfigErrorMessage(validated.error) },
      { status: 400 },
    );
  }

  const outcome = await migrateMediaStorage({
    actorEmail,
    adminId: session.padmin,
    target: validated.config,
  });

  if (!outcome.ok) {
    const migrations = await listMediaMigrationAudits(10);
    await platformAudit({
      adminId: session.padmin,
      action: "platform_media.storage.migration_failed",
      entity: "platform_media_config",
      payload: {
        error: outcome.error,
        totalAssets: outcome.totalAssets,
        copiedAssets: outcome.copiedAssets,
        verifiedAssets: outcome.verifiedAssets,
      },
      ipAddress,
      userAgent,
    });
    return NextResponse.json(
      {
        ok: false,
        error: outcome.error,
        message: `مهاجرت انجام نشد و پیکربندی مبدأ دست‌نخورده باقی ماند: ${outcome.detail}`,
        totalAssets: outcome.totalAssets,
        copiedAssets: outcome.copiedAssets,
        verifiedAssets: outcome.verifiedAssets,
        migrations,
      },
      { status: 502 },
    );
  }

  const updated = await getMediaConfig();
  const migrations = await listMediaMigrationAudits(10);
  await platformAudit({
    adminId: session.padmin,
    action: "platform_media.storage.migrated",
    entity: "platform_media_config",
    payload: {
      totalAssets: outcome.totalAssets,
      copiedAssets: outcome.copiedAssets,
      verifiedAssets: outcome.verifiedAssets,
      totalBytes: outcome.totalBytes,
      targetBucket: updated.bucket,
      targetKeyPrefix: updated.keyPrefix,
    },
    ipAddress,
    userAgent,
  });

  return NextResponse.json({
    ok: true,
    mode: "migrate",
    totalAssets: outcome.totalAssets,
    copiedAssets: outcome.copiedAssets,
    verifiedAssets: outcome.verifiedAssets,
    totalBytes: outcome.totalBytes,
    config: maskMediaConfig(updated),
    canRollback: Boolean(updated.previousFallback),
    migrations,
  });
});
