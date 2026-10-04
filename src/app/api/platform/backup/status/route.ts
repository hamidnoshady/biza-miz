import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  getPlatformBackupHealth,
  listPlatformBackupRuns,
  listPlatformCloudArtifacts,
  listPlatformLocalArtifacts,
  listPlatformRestoreRuns,
  localSchemaSnapshot,
} from "@/lib/platform-backup-service";

/**
 * Everything the backup page shows in one round-trip: the health line, the run
 * history, what is on disk and in the bucket right now, the restore log, and
 * this install's own schema snapshot (the numbers a peer's manifest is compared
 * against, so the page can say "the newest backup is 3 migrations behind"
 * without a second request).
 *
 * Readable under `backup.read` — every admin role holds it (issue #807): the
 * support desk must be able to answer «کپی دیشب را داریم؟» without holding the
 * capability that can change a destination or replace the database. Nothing in
 * the payload is secret. Artifacts are listed even when retention has already
 * pruned the file (`exists: false`), because "we had it, then we did not" is the
 * difference between an operator finding a copy and giving up.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("backup.read");
  if (error) return error;

  const [health, runs, local, cloud, restores, localSchema] = await Promise.all([
    getPlatformBackupHealth(),
    listPlatformBackupRuns(),
    listPlatformLocalArtifacts(),
    listPlatformCloudArtifacts(),
    listPlatformRestoreRuns(10),
    localSchemaSnapshot(),
  ]);
  return NextResponse.json({ health, runs, local, cloud, restores, localSchema });
});
