import type { BackupRunRow } from "./backup-service";
import type { DeploymentProfile } from "./deployment-mode";

/** Metadata only: successful generation is not proof of availability or restorability. */
export function businessBackupSummary(profile: DeploymentProfile, runs: BackupRunRow[]) {
  const visible = runs.filter((run) => profile !== "local" || run.kind === "local");
  return {
    profile,
    deviceAvailability: profile === "cloud" ? "not_applicable" as const : "unknown" as const,
    metadataOnly: true as const,
    runs: visible.map((run) => ({
      id: run.id, destination: run.kind, trigger: run.trigger,
      status: run.status, scope: run.scope, sizeBytes: run.sizeBytes,
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      hasError: Boolean(run.error),
      availability: "unverified" as const,
    })),
  };
}
export type BusinessBackupSummary = ReturnType<typeof businessBackupSummary>;
