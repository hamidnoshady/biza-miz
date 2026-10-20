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
  recordMediaMigrationAudit,
  saveMediaConfig,
} from "@/lib/media-service";
import { query } from "@/lib/db";

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
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Issue #926 P1.5: block unsafe direct location overwrites (`endpoint`, `bucket`,
  // `keyPrefix`) whenever stored media assets already exist. Operators must run
  // the verified copy + sha256 migration workflow (`POST /api/platform/media/migrate`)
  // so existing objects never become unreachable or broken.
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
