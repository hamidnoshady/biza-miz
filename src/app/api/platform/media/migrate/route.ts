import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { maskMediaConfig, validateMediaConfigInput } from "@/lib/media";
import {
  getMediaConfig,
  listMediaMigrationAudits,
  migrateMediaStorage,
  rollbackMediaStorage,
} from "@/lib/media-service";

/**
 * Superadmin-only verified storage migration & rollback endpoint (issue #926 P1.5).
 *
 *   POST { mode: "migrate", ...targetConfig }
 *     Copies all existing media objects to target storage, independently
 *     verifies count + byte_size + sha256 on target, atomically switches
 *     `platform_media_config` while preserving source config for dual-read
 *     fallback & rollback, and never deletes source objects.
 *
 *   POST { mode: "rollback" }
 *     Re-verifies objects on the preserved pre-migration storage and restores
 *     `platform_media_config` atomically.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("media.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const actorEmail = session.email ?? String(session.padmin);
  const ipAddress = (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0);
  const userAgent = request.headers.get("user-agent");

  if (body.mode === "rollback") {
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
  const validated = validateMediaConfigInput({ ...body, enabled: true }, current);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
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
