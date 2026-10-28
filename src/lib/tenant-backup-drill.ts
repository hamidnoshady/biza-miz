/**
 * Issue #903 §12 — automated recovery drills.
 *
 * A backup you have never restored is a hypothesis. The drill is the cheapest
 * way to turn it into evidence: take (or pick) a logical artifact, then walk the
 * exact chain a real recovery walks — decrypt, parse, validate the table set,
 * preview the restore, prove the portable envelope opens it — **without writing
 * anything to the business**.
 *
 * The split matters: `planDrill` is pure and decides what a drill must prove,
 * `runDrill` executes those steps against production machinery and returns a
 * result per step. A drill that skipped a step is a `skipped` result, never a
 * silent pass — and the process exit code follows `ok`.
 *
 * Why it never applies: a drill that restores over live data is a bet that the
 * new data is better than the old. The write path is exercised separately by
 * `applyTenantRestore`'s fault-injection tests and, deliberately, by a human
 * typing the business's name.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseTenantArchive, tenantTableSet } from "./tenant-archive";
import { installedSchemaVersion, resolveOwnedArtifact, tenantBackupInventory } from "./tenant-backup-artifacts-service";
import { currentArtifactCustodyKey } from "./tenant-backup-artifacts-service";
import { exportRecoveryEnvelope, openRecoveryEnvelope } from "./tenant-backup-custody-ops";
import { decryptStagedArtifact, fetchCloudArtifact, planArtifactDownload } from "./tenant-backup-transport";
import { cleanupStagingDir, ensureStagingDir } from "./tenant-backup-storage";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

export const DRILL_STEPS = [
  "artifact_selected",
  "artifact_ready",
  "payload_decrypted",
  "archive_parsed",
  "restore_preview",
  "portable_envelope",
] as const;
export type DrillStep = (typeof DRILL_STEPS)[number];

export type DrillStepResult =
  | { step: DrillStep; status: "ok"; detail: string }
  | { step: DrillStep; status: "failed"; detail: string }
  | { step: DrillStep; status: "skipped"; detail: string };

export interface DrillReport {
  businessId: string;
  ref: string | null;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  steps: DrillStepResult[];
}

/** What a drill proves, in order — pure, so the contract is testable. */
export function drillPlan(): { step: DrillStep; requires: DrillStep | null; why: string }[] {
  return [
    { step: "artifact_selected", requires: null, why: "there is a backup to test at all" },
    { step: "artifact_ready", requires: "artifact_selected", why: "it was verified when it was written" },
    { step: "payload_decrypted", requires: "artifact_ready", why: "custody still opens it" },
    { step: "archive_parsed", requires: "payload_decrypted", why: "it is this build's format, for this business" },
    { step: "restore_preview", requires: "archive_parsed", why: "a restore would be allowed to start" },
    { step: "portable_envelope", requires: "artifact_ready", why: "the tenant can open it without the platform" },
  ];
}

/**
 * Fold step results into a verdict. A single failure fails the drill; a skipped
 * step is reported as skipped and does **not** count as success — the drill
 * says what it proved and what it did not.
 */
export function drillVerdict(steps: DrillStepResult[]): { ok: boolean; missing: DrillStep[] } {
  const missing = DRILL_STEPS.filter((step) => !steps.some((result) => result.step === step && result.status === "ok"));
  return { ok: missing.length === 0, missing };
}

export type DrillPlan = ReturnType<typeof drillPlan>;

export interface RunDrillInput {
  businessId: string;
  /** Omit to drill the newest restorable artifact. */
  ref?: string | null;
  deployment: { role: DeploymentRole; profile: DeploymentProfile };
  /** Required for the portable-envelope step; without it the step is skipped. */
  recoveryPassphrase?: string | null;
  now?: Date;
}

/**
 * Run the drill. Every file it writes is transient and removed in `finally`;
 * every database read is scoped to the business.
 */
export async function runDrill(input: RunDrillInput): Promise<DrillReport> {
  const startedAt = (input.now ?? new Date()).toISOString();
  const steps: DrillStepResult[] = [];
  let ref = input.ref ?? null;

  // 1. Pick an artifact.
  if (!ref) {
    const inventory = await tenantBackupInventory(input.businessId, {
      profile: input.deployment.profile,
      connectivity: "online",
    });
    const candidate = inventory.items.find((item) => item.restorable && item.format === "logical_snapshot");
    ref = candidate?.ref ?? null;
  }
  if (!ref) {
    steps.push({ step: "artifact_selected", status: "failed", detail: "no restorable logical artifact" });
    return finish(input, ref, startedAt, steps);
  }
  steps.push({ step: "artifact_selected", status: "ok", detail: "artifact selected" });

  const row = await resolveOwnedArtifact(input.businessId, ref);
  if (!row || row.state !== "ready") {
    steps.push({ step: "artifact_ready", status: "failed", detail: "artifact is not ready" });
    return finish(input, ref, startedAt, steps);
  }
  steps.push({ step: "artifact_ready", status: "ok", detail: `state ${row.state}` });

  const suffix = `drill-${ref.slice(0, 8)}`;
  const staging = await ensureStagingDir(input.businessId, suffix);
  try {
    // 2. Fetch the bytes (cloud) or copy them (local), then decrypt.
    let stagedPath: string;
    if (row.destination === "cloud") {
      const fetched = await fetchCloudArtifact({
        businessId: input.businessId,
        ref,
        profile: input.deployment.profile,
        role: input.deployment.role,
        suffix,
      });
      if (!fetched.ok) {
        steps.push({ step: "payload_decrypted", status: "failed", detail: fetched.error });
        return finish(input, ref, startedAt, steps);
      }
      stagedPath = fetched.path;
    } else {
      const plan = await planArtifactDownload({
        businessId: input.businessId,
        ref,
        destination: "local",
        profile: input.deployment.profile,
        role: input.deployment.role,
      });
      if (plan.kind !== "stream") {
        steps.push({ step: "payload_decrypted", status: "failed", detail: plan.kind === "error" ? plan.error : "unreadable" });
        return finish(input, ref, startedAt, steps);
      }
      stagedPath = path.join(staging, row.storageRef);
      await fs.copyFile(plan.path, stagedPath);
    }

    const decrypted = await decryptStagedArtifact({
      businessId: input.businessId,
      ref,
      stagedPath,
      legacyPassphrase: process.env.BACKUP_PASSPHRASE ?? "",
    });
    if (!decrypted.ok) {
      steps.push({ step: "payload_decrypted", status: "failed", detail: decrypted.error });
      return finish(input, ref, startedAt, steps);
    }
    steps.push({ step: "payload_decrypted", status: "ok", detail: "custody opened the artifact" });

    // 3. Parse it as this build's archive, for this business.
    const raw = await fs.readFile(decrypted.path, "utf8");
    const parsed = parseTenantArchive(raw, {
      allowedTables: await tenantTableSet(),
      businessId: input.businessId,
      maxSchemaVersion: await installedSchemaVersion(),
    });
    if (!parsed.ok) {
      steps.push({ step: "archive_parsed", status: "failed", detail: parsed.error });
      return finish(input, ref, startedAt, steps);
    }
    steps.push({
      step: "archive_parsed",
      status: "ok",
      detail: `${parsed.archive.tables.length} tables, schema ${parsed.archive.schemaVersion}`,
    });

    // 4. Would a restore be allowed to start? The preview is the same one an
    //    Owner sees; a blocked preview means the drill must fail here, not later.
    const { previewOwnedRestore } = await import("./tenant-backup-artifacts-service");
    const previewed = await previewOwnedRestore(input.businessId, ref, {
      role: input.deployment.role,
      profile: input.deployment.profile,
      actor: { canRestore: true, mfaSatisfied: true, reauthenticatedAt: new Date().toISOString() },
    });
    if ("error" in previewed) {
      steps.push({ step: "restore_preview", status: "failed", detail: previewed.error });
    } else if (!previewed.preview.canApply) {
      steps.push({
        step: "restore_preview",
        status: "failed",
        detail: previewed.preview.blockers.map((blocker) => blocker.code).join(","),
      });
    } else {
      steps.push({ step: "restore_preview", status: "ok", detail: "a restore would be allowed to start" });
    }

    // 5. Prove the portable envelope opens the artifact's secret.
    if (!input.recoveryPassphrase) {
      steps.push({
        step: "portable_envelope",
        status: "skipped",
        detail: "no recovery passphrase supplied",
      });
    } else {
      const custody = await currentArtifactCustodyKey(input.businessId);
      const envelope = await exportRecoveryEnvelope({
        businessId: input.businessId,
        recoveryPassphrase: input.recoveryPassphrase,
      });
      if (!custody.ok || !envelope.ok) {
        steps.push({
          step: "portable_envelope",
          status: "failed",
          detail: custody.ok ? (envelope.ok ? "unknown" : envelope.error) : custody.error,
        });
      } else {
        const opened = await openRecoveryEnvelope({
          businessId: input.businessId,
          envelope: envelope.envelope,
          recoveryPassphrase: input.recoveryPassphrase,
          keyVersion: envelope.keyVersion,
        });
        steps.push(
          opened.ok
            ? { step: "portable_envelope", status: "ok", detail: `key generation ${opened.keyVersion}` }
            : { step: "portable_envelope", status: "failed", detail: opened.error },
        );
      }
    }

    return finish(input, ref, startedAt, steps);
  } finally {
    await fs.rm(path.join(staging), { recursive: true, force: true }).catch(() => {});
    await cleanupStagingDir(input.businessId, suffix).catch(() => {});
  }
}

function finish(
  input: RunDrillInput,
  ref: string | null,
  startedAt: string,
  steps: DrillStepResult[],
): DrillReport {
  return {
    businessId: input.businessId,
    ref,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: drillVerdict(steps).ok,
    steps,
  };
}
