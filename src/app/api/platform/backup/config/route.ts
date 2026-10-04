import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import {
  getPlatformBackupConfig,
  getPlatformBackupConfigMasked,
  savePlatformBackupConfig,
} from "@/lib/platform-backup-service";

/**
 * The console's whole-system backup settings (migration 0132).
 *
 * Readable under `backup.read` — the schedule and the health of the deployment's
 * backups are what the `support` role needs when it tells an Owner "yes, we do
 * have last night's copy" — but every secret is masked by
 * `getPlatformBackupConfigMasked`, so a read never returns a passphrase or an
 * S3 secret.
 *
 * Writes need `backup.configure` (issue #807): changing the destination of a
 * full copy of every tenant's data, or the passphrase it is encrypted with, is
 * custody of that data — a different trust from running and verifying backups,
 * which is what an engineer does day to day.
 *
 * Secrets follow the tenant-side convention exactly: an omitted field keeps what
 * is stored, an empty string clears it. That is what lets the form change the
 * retention count without re-typing a 40-character passphrase.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("backup.read");
  if (error) return error;
  return NextResponse.json({ config: await getPlatformBackupConfigMasked() });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("backup.configure");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // What the switch is being flipped from, for the audit row — read before the
  // write, since the row has to say what changed rather than what it became.
  const before = await getPlatformBackupConfig();
  const result = await savePlatformBackupConfig(body, session.padmin);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await platformAudit({
    adminId: session.padmin,
    action: "platform_backup.config.update",
    entity: "platform_backup_config",
    payload: {
      enabled: result.config.enabled,
      intervalHours: result.config.intervalHours,
      anchorTime: result.config.anchorTime,
      timezone: result.config.timezone,
      localRetention: result.config.localRetention,
      directorySet: Boolean(result.config.directory),
      encryptLocal: result.config.encryptLocal,
      cloudEnabled: result.config.cloud.enabled,
      servingEnabled: result.config.servingEnabled,
      allowInsecurePeers: result.config.allowInsecurePeers,
      allowPrivatePeers: result.config.allowPrivatePeers,
      // Which secrets moved, never what they were.
      secretsChanged: {
        passphrase: before.passphrase !== result.config.passphrase,
        cloudSecretAccessKey: before.cloud.secretAccessKey !== result.config.cloud.secretAccessKey,
      },
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ config: result.config });
});
