/**
 * Issue #903 §12 — the scheduled half of the recovery drill.
 *
 * `scripts/backup-drill.ts` proved a backup could be opened, but only when a
 * human remembered to run it. This module is what makes it automatic: once a
 * day, for every business that has a restorable logical artifact, run the same
 * drill and write down what it proved.
 *
 * Three properties matter, and each is a decision:
 *
 *  1. **A drill per business per day, not per tick.** The scheduler calls this
 *     every hour; the idempotency check reads `tenant_backup_drills` for the last
 *     run and skips a business that already has one inside `DRILL_INTERVAL_MS`.
 *     That is cheaper and more honest than a distributed lock alone: a lock says
 *     "someone else is running it now", this says "it already ran today".
 *
 *  2. **The envelope step is expected to be skipped.** The platform never holds
 *     the tenant's recovery passphrase (that is the point of §4's custody split),
 *     so a scheduled drill cannot open the portable envelope. Rather than
 *     reporting a failure every night — which trains everyone to ignore the
 *     alert — the job asks the drill to require every step it can prove and
 *     records the rest in `missing_steps`. A failure here means a step that
 *     *should* work did not.
 *
 *  3. **A failure notifies the Owner.** A backup that cannot be opened is only
 *     discovered at the worst moment; a drill exists to discover it early. The
 *     notification rides the existing catalogue event `backup.drill_failed`
 *     (deduped per business per day, like `backup.failed`), so it obeys quiet
 *     hours, preferences and permissions like every other alert.
 */
import { query, withoutTenantScope } from "./db";
import { LOCK_KEYS, withDistributedLock } from "./db-locks";
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile } from "./deployment-mode";
import { DRILL_STEPS, runDrill, type DrillReport, type DrillStep } from "./tenant-backup-drill";

/** Once a day per business. A drill is evidence, not a monitoring loop. */
export const DRILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * What a scheduled drill is asked to prove: everything except the portable
 * envelope, which needs the tenant's passphrase and is deliberately not held
 * here. The script still requires all six, because a human supplies the phrase.
 */
export const SCHEDULED_DRILL_REQUIRED_STEPS: readonly DrillStep[] = DRILL_STEPS.filter(
  (step) => step !== "portable_envelope",
);

export interface DrillRunSummary {
  businessId: string;
  artifactRef: string;
  ok: boolean;
  missingSteps: string[];
  startedAt: string;
  finishedAt: string;
}

export interface ScheduledDrillOutcome {
  /** Businesses with at least one restorable artifact — the drill's candidates. */
  candidates: number;
  drilled: number;
  passed: number;
  failed: number;
  /** Candidates skipped because they already have a drill inside the window. */
  skipped: number;
}

interface LastDrillRow extends Record<string, unknown> {
  finished_at: Date;
  ok: boolean;
}

/**
 * Businesses that have a logical artifact worth drilling. Only `ready` logical
 * snapshots qualify: a physical dump is a site concern and a non-ready artifact
 * is already reported by its own state, so drilling it would produce a second,
 * noisier version of the same failure.
 */
async function drillCandidates(): Promise<{ businessId: string; ref: string | null }[]> {
  const rows = await withoutTenantScope("tenant-backup-drills", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT DISTINCT business_id
         FROM tenant_backup_artifacts
        WHERE state = 'ready' AND format = 'logical_snapshot'`,
      [],
    );
    return result.rows;
  });
  return rows.map((row) => ({ businessId: row.business_id, ref: null }));
}

async function lastDrill(businessId: string): Promise<LastDrillRow | null> {
  return withoutTenantScope("tenant-backup-drills", async () => {
    const result = await query<LastDrillRow>(
      `SELECT finished_at, ok FROM tenant_backup_drills
        WHERE business_id = $1
        ORDER BY finished_at DESC
        LIMIT 1`,
      [businessId],
    );
    return result.rows[0] ?? null;
  });
}

/** Record what the drill proved. Written by the platform; readable by the tenant. */
export async function recordDrillRun(
  report: DrillReport,
  source: "schedule" | "manual" | "ci" = "schedule",
): Promise<DrillRunSummary> {
  const missingSteps = report.missing ?? [];
  await withoutTenantScope("tenant-backup-drills", async () => {
    // `artifact_ref` is NOT NULL in the table and a drill that failed before it
    // picked an artifact has none; an empty string is the honest stand-in and
    // the row's `ok = false` is what a reader keys on.
    await query(
      `INSERT INTO tenant_backup_drills
         (business_id, artifact_ref, source, ok, missing_steps, steps, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        report.businessId,
        report.ref ?? "",
        source,
        report.ok,
        missingSteps,
        JSON.stringify(report.steps),
        report.startedAt,
        report.finishedAt,
      ],
    );
  });
  return {
    businessId: report.businessId,
    artifactRef: report.ref ?? "",
    ok: report.ok,
    missingSteps,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
  };
}

/** The console's "was this business ever drilled, and did it pass?" */
export async function lastDrillSummary(businessId: string): Promise<DrillRunSummary | null> {
  return withoutTenantScope("tenant-backup-drills", async () => {
    const result = await query<{
      artifact_ref: string;
      ok: boolean;
      missing_steps: string[] | null;
      started_at: Date;
      finished_at: Date;
    } & Record<string, unknown>>(
      `SELECT artifact_ref, ok, missing_steps, started_at, finished_at
         FROM tenant_backup_drills
        WHERE business_id = $1
        ORDER BY finished_at DESC
        LIMIT 1`,
      [businessId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      businessId,
      artifactRef: row.artifact_ref,
      ok: row.ok,
      missingSteps: row.missing_steps ?? [],
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at.toISOString(),
    };
  });
}

/**
 * Run the day's drills. Called from the scheduler (server.ts) on an hourly tick;
 * each business drills at most once per `DRILL_INTERVAL_MS`.
 */
export async function runScheduledBackupDrills(now: Date = new Date()): Promise<ScheduledDrillOutcome> {
  const outcome: ScheduledDrillOutcome = { candidates: 0, drilled: 0, passed: 0, failed: 0, skipped: 0 };
  const candidates = await drillCandidates();
  outcome.candidates = candidates.length;

  for (const candidate of candidates) {
    const previous = await lastDrill(candidate.businessId).catch(() => null);
    if (previous && now.getTime() - previous.finished_at.getTime() < DRILL_INTERVAL_MS) {
      outcome.skipped += 1;
      continue;
    }

    const lock = await withDistributedLock(LOCK_KEYS.tenantDrill(candidate.businessId), async () => {
      const deployment = {
        role: deploymentRole(),
        profile: (await readDeploymentProfile(candidate.businessId)).profile,
      };
      // The platform holds no tenant passphrase: the envelope step is skipped by
      // design and recorded as unproven rather than reported as a pass.
      const report = await runDrill({
        businessId: candidate.businessId,
        ref: candidate.ref,
        deployment,
        recoveryPassphrase: null,
        requiredSteps: SCHEDULED_DRILL_REQUIRED_STEPS,
        now,
      });
      await recordDrillRun(report, "schedule");
      return report;
    });

    if (!lock.ok) {
      // Another instance is drilling this business right now. Not an error: the
      // next tick will see its row and skip.
      outcome.skipped += 1;
      continue;
    }

    outcome.drilled += 1;
    const report = lock.value;
    if (report.ok) {
      outcome.passed += 1;
      continue;
    }
    outcome.failed += 1;
    await notifyFailedDrill(candidate.businessId, report).catch((error) => {
      console.error(`drill failure notification failed for business ${candidate.businessId}:`, error);
    });
  }

  return outcome;
}

async function notifyFailedDrill(businessId: string, report: DrillReport): Promise<void> {
  const missing = (report.missing ?? []).join(", ") || "unknown";
  await recordNotification({
    businessId,
    locationId: null,
    eventKey: "backup.drill_failed",
    severity: "critical",
    title: "آزمایش بازیابی پشتیبان ناموفق بود",
    // The codes, not a friendlier story: an operator reading this needs to know
    // which step failed, and the console shows the detail.
    body: `گام‌های تأییدنشده: ${missing}`.slice(0, 200),
    url: "/settings/backup",
    dedupeKey: notificationDedupeKey("backup.drill_failed", businessId, report.startedAt.slice(0, 10)),
    payload: { ref: report.ref, missing },
  });
}
