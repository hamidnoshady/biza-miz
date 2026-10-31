/**
 * Issue #903 §4 — the dry-run preview that must precede any central
 * tenant-only logical restore.
 *
 * The prohibition this sits beside is deliberate and stays: on a central
 * deployment a tenant may never run a physical `pg_dump`/`pg_restore` of the
 * shared database (`backup-policy.ts`, issue #807). What this module adds is the
 * *safe alternative* the epic asks for: a preview computed from a signed
 * manifest, which tells an Owner exactly what a restore would change before
 * anything is written.
 *
 * A preview answers, in the tenant's own words and without exposing internal
 * table names it should not learn:
 *
 *  • when the backup was taken, and therefore how much recent data is at risk
 *    (RPO),
 *  • which datasets would be replaced and which current datasets would be kept
 *    untouched (anything the artifact does not contain),
 *  • what the artifact admits it does *not* contain (`partial` never hides),
 *  • every reason this artifact may not be applied at all.
 *
 * It performs no I/O and mutates nothing: the caller feeds it the manifest, the
 * artifact row, the deployment facts and the current row counts. That keeps the
 * policy reviewable — and testable — independently of the engine that will one
 * day execute the restore.
 */
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";
import {
  BACKUP_COMPONENT_KEYS,
  manifestCompleteness,
  manifestRestorability,
  type BackupComponentKey,
  type BackupManifest,
} from "./backup-manifest";

export type RestoreBlockerCode =
  | "artifact_not_owned_by_business"
  | "artifact_signature_invalid"
  | "artifact_manifest_missing"
  | "artifact_expired"
  | "artifact_unavailable_offline"
  | "artifact_unverified_upload"
  | "physical_tenant_restore_forbidden_on_central"
  | "artifact_schema_newer_than_installation"
  | "backup_restore_not_permitted"
  | "mfa_required"
  | "reauthentication_required"
  | "confirmation_required"
  | "restore_busy";

export interface RestoreBlocker {
  code: RestoreBlockerCode;
  /** Already provider-neutral: safe to show a tenant as-is. */
  label: string;
}

/** One place for the copy, so no surface invents a friendlier-but-wrong reason. */
export const RESTORE_BLOCKER_LABELS: Record<RestoreBlockerCode, string> = {
  artifact_not_owned_by_business: "این نسخه به کسب‌وکار شما تعلق ندارد.",
  artifact_signature_invalid: "امضای این نسخه معتبر نیست؛ بازگردانی انجام نمی‌شود.",
  artifact_manifest_missing: "این فایل فهرست معتبر پشتیبان ندارد و قابل بازگردانی نیست.",
  artifact_expired: "مدت نگهداری این نسخه پایان یافته است.",
  artifact_unavailable_offline: "این نسخه در حال حاضر در دسترس نیست (دستگاه آفلاین است).",
  artifact_unverified_upload: "فایل بارگذاری‌شده هنوز تأیید نشده است.",
  physical_tenant_restore_forbidden_on_central:
    "بازگردانی تصویر کامل پایگاه‌داده در استقرار مرکزی برای یک کسب‌وکار مجاز نیست.",
  artifact_schema_newer_than_installation: "این نسخه با نسخهٔ جدیدتری از سامانه ساخته شده است.",
  backup_restore_not_permitted: "شما مجوز بازگردانی اطلاعات کسب‌وکار را ندارید.",
  mfa_required: "برای بازگردانی، تأیید دو مرحله‌ای لازم است.",
  reauthentication_required: "لطفاً پیش از بازگردانی دوباره وارد حساب شوید.",
  confirmation_required: "عبارت تأیید بازگردانی وارد نشده است.",
  restore_busy: "یک بازگردانی دیگر برای این کسب‌وکار در جریان است.",
};

export interface RestoreArtifactFacts {
  ref: string;
  format: "physical_dump" | "logical_snapshot";
  origin: "scheduled" | "manual" | "uploaded";
  capturedAt: string;
  available: boolean;
  integrity: "verified" | "unverified" | "failed";
  completeness: "complete" | "partial";
  /** The inventory state the tenant already sees (`tenant-backup-inventory.ts`). */
  state: string;
  ownedByBusiness: boolean;
}

export interface RestoreActorFacts {
  canRestore: boolean;
  mfaSatisfied: boolean;
  /** ISO instant of the last re-authentication, if any. */
  reauthenticatedAt: string | null;
  /** True while another restore holds this business's durable lock. */
  restoreInProgress?: boolean;
}

export interface RestorePreviewInput {
  businessId: string;
  artifact: RestoreArtifactFacts;
  manifest: BackupManifest | null;
  /** Result of `verifyBackupManifestSignature`, computed by the caller. */
  manifestSignatureValid: boolean;
  deployment: { role: DeploymentRole; profile: DeploymentProfile };
  /** Migration/application schema this installation runs. */
  currentSchemaVersion: number;
  /** Rows currently held per component, for the datasets this build knows. */
  currentCounts: Partial<Record<BackupComponentKey, number>>;
  actor: RestoreActorFacts;
  now?: Date;
  /** Downtime assumption used for the estimate; overridable per installation. */
  minutesPerMillionRows?: number;
}

export interface RestoreDatasetPlan {
  component: BackupComponentKey;
  incomingRows: number | null;
  currentRows: number | null;
  effect: "replace" | "create" | "clear";
}

export interface RestorePreview {
  /** Always present: a blocked preview is still useful information. */
  artifactRef: string;
  capturedAt: string;
  format: RestoreArtifactFacts["format"];
  targetBusinessId: string;
  datasets: RestoreDatasetPlan[];
  /** Datasets this backup does not contain; the restore leaves them untouched. */
  retained: { component: BackupComponentKey; currentRows: number }[];
  /** Declared but absent from the artifact, so the business knows what it loses. */
  missing: { component: BackupComponentKey; state: "external" | "excluded" | "unavailable" }[];
  affectedRows: number;
  currentRows: number;
  /** Hours of data between the artifact and "now" — what a restore would lose. */
  rpoHours: number;
  estimatedDowntimeMinutes: number;
  completeness: "complete" | "partial";
  requiresCheckpoint: true;
  pausesTenantWrites: true;
  lockKey: string;
  confirmationPhrase: string;
  blockers: RestoreBlocker[];
  canApply: boolean;
}

/** The exact text the Owner must type; the business name, not a generic "YES". */
export function restoreConfirmationPhrase(businessName: string): string {
  return businessName.trim();
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Compute the preview. Blockers are collected rather than short-circuited, so an
 * operator sees *every* reason at once instead of fixing one and finding the next.
 */
export function previewTenantRestore(input: RestorePreviewInput): RestorePreview {
  const now = input.now ?? new Date();
  const blockers: RestoreBlocker[] = [];
  const add = (code: RestoreBlockerCode) => {
    if (!blockers.some((blocker) => blocker.code === code)) {
      blockers.push({ code, label: RESTORE_BLOCKER_LABELS[code] });
    }
  };

  if (!input.artifact.ownedByBusiness) add("artifact_not_owned_by_business");
  if (!input.manifest) add("artifact_manifest_missing");
  if (input.artifact.origin === "uploaded" && input.artifact.integrity !== "verified") {
    add("artifact_unverified_upload");
  }
  if (input.artifact.state === "expired") add("artifact_expired");
  if (input.artifact.state === "unavailable_offline" || !input.artifact.available) {
    add("artifact_unavailable_offline");
  }
  if (!input.actor.canRestore) add("backup_restore_not_permitted");
  if (!input.actor.mfaSatisfied) add("mfa_required");
  if (!input.actor.reauthenticatedAt) add("reauthentication_required");
  if (input.actor.restoreInProgress) add("restore_busy");
  if (input.deployment.profile === "local" && input.artifact.format === "logical_snapshot") {
    // A Local install's own restores are physical; a logical snapshot there has
    // no verified apply path yet, and pretending otherwise is the failure the
    // epic names.
    add("artifact_unavailable_offline");
  }

  let completeness: "complete" | "partial" = input.artifact.completeness;
  let datasets: RestoreDatasetPlan[] = [];
  let retained: RestorePreview["retained"] = [];
  let missing: RestorePreview["missing"] = [];
  let affectedRows = 0;

  if (input.manifest) {
    if (!input.manifestSignatureValid) add("artifact_signature_invalid");

    const restorability = manifestRestorability(input.manifest, {
      businessId: input.businessId,
      currentSchemaVersion: input.currentSchemaVersion,
      allowPhysical: input.deployment.role === "site",
    });
    if (!restorability.ok) {
      if (restorability.error === "physical_tenant_restore_forbidden_on_central") {
        add("physical_tenant_restore_forbidden_on_central");
      } else if (restorability.error === "artifact_schema_newer_than_installation") {
        add("artifact_schema_newer_than_installation");
      } else if (restorability.error === "artifact_not_owned_by_business") {
        add("artifact_not_owned_by_business");
      } else {
        add("artifact_manifest_missing");
      }
    }
    if (input.manifest.format !== input.artifact.format) {
      // The row and its signed manifest disagree: refuse rather than pick one.
      add("artifact_manifest_missing");
    }

    const completenessReport = manifestCompleteness(input.manifest);
    completeness = completenessReport.status;

    datasets = input.manifest.components
      .filter((component) => component.state === "included")
      .map((component) => {
        const currentRows = input.currentCounts[component.key] ?? null;
        const incomingRows = component.rows;
        return {
          component: component.key,
          incomingRows,
          currentRows,
          effect: (currentRows ?? 0) === 0 ? "create" : (incomingRows ?? 0) === 0 ? "clear" : "replace",
        } satisfies RestoreDatasetPlan;
      })
      .sort((a, b) => a.component.localeCompare(b.component));

    affectedRows = datasets.reduce((total, dataset) => total + (dataset.incomingRows ?? 0), 0);

    const declared = new Set(input.manifest.components.map((component) => component.key));
    retained = (Object.entries(input.currentCounts) as [BackupComponentKey, number][])
      .filter(([component, rows]) => !declared.has(component) && rows > 0)
      .map(([component, currentRows]) => ({ component, currentRows }))
      .sort((a, b) => a.component.localeCompare(b.component));

    missing = input.manifest.components
      .filter((component) => component.state !== "included")
      .map((component) => ({
        component: component.key,
        state: component.state as "external" | "excluded" | "unavailable",
      }))
      .sort((a, b) => a.component.localeCompare(b.component));

    // Every declared component key must be one this build understands, otherwise
    // the artifact would silently skip rows it contains.
    const unknown = input.manifest.components.filter(
      (component) => !(BACKUP_COMPONENT_KEYS as readonly string[]).includes(component.key),
    );
    if (unknown.length > 0) add("artifact_manifest_missing");
  }

  const currentRows = Object.values(input.currentCounts).reduce<number>(
    (total, rows) => total + (typeof rows === "number" ? rows : 0),
    0,
  );
  const captured = Date.parse(input.artifact.capturedAt);
  const rpoHours = Number.isFinite(captured) ? Math.max(0, round((now.getTime() - captured) / 3_600_000)) : 0;
  const perMillion = input.minutesPerMillionRows ?? 2;
  const estimatedDowntimeMinutes = Math.max(1, Math.ceil((affectedRows / 1_000_000) * perMillion));

  return {
    artifactRef: input.artifact.ref,
    capturedAt: input.artifact.capturedAt,
    format: input.artifact.format,
    targetBusinessId: input.businessId,
    datasets,
    retained,
    missing,
    affectedRows,
    currentRows,
    rpoHours,
    estimatedDowntimeMinutes,
    completeness,
    requiresCheckpoint: true,
    pausesTenantWrites: true,
    lockKey: `tenant-restore:${input.businessId}`,
    confirmationPhrase: restoreConfirmationPhrase(input.businessId),
    blockers,
    canApply: blockers.length === 0,
  };
}

/**
 * The stricter gate the apply path must run *after* the preview. Separated so a
 * preview being green can never be mistaken for an authorization: the typed
 * phrase, the approval reference and a fresh re-authentication are all required
 * at the moment of the write.
 */
export type RestoreApplyGuard =
  | { ok: true }
  | { ok: false; error: RestoreBlockerCode };

export function guardTenantRestoreApply(input: {
  preview: RestorePreview;
  typedConfirmation: string;
  /** Platform approval id, required when a Superadmin (not the Owner) applies. */
  approvalRef?: string | null;
  appliesAsPlatformAdmin?: boolean;
  minutesSinceReauthentication: number | null;
}): RestoreApplyGuard {
  if (!input.preview.canApply) {
    return { ok: false, error: input.preview.blockers[0].code };
  }
  if (input.typedConfirmation.trim() !== input.preview.confirmationPhrase) {
    return { ok: false, error: "confirmation_required" };
  }
  if (input.appliesAsPlatformAdmin && !input.approvalRef) {
    return { ok: false, error: "backup_restore_not_permitted" };
  }
  if (input.minutesSinceReauthentication === null || input.minutesSinceReauthentication > 15) {
    return { ok: false, error: "reauthentication_required" };
  }
  return { ok: true };
}
