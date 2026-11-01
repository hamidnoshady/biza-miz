/**
 * Issue #903 §3 — **the plan-shaped half of the backup policy, and the two
 * thresholds that make "protected" measurable.**
 *
 * 0265 gave the fleet one default. 0269 gave a single business an override. This
 * module adds the layer the epic actually sells on: a *plan* decides the cadence,
 * retention, capacity, alert thresholds and disaster-recovery objectives every
 * business on that plan inherits — «حرفه‌ای» every six hours, the base plan
 * nightly — without an operator touching them one by one.
 *
 * Two rules are the whole design, and both are enforced here rather than by
 * trusting the table:
 *
 * ```text
 * NULL inherits      a missing column is not a zero. "This plan chose 6 hours"
 *                    and "nobody has said anything" must stay distinguishable,
 *                    or a plan pins every business to whatever the default was
 *                    on the day it was created.
 *
 * only tighten      a plan is a sales tier, not a way to sell weaker protection.
 *                    It may run more often, keep fewer bytes, retain less, alert
 *                    sooner, and drill more often — never the reverse. The
 *                    resolver clamps, so a hostile or careless row degrades to
 *                    the fleet's own envelope instead of escaping it.
 * ```
 *
 * The direction of "tighten" differs per field, and that is the part worth
 * reading twice:
 *
 * | field                 | tighter means            | why                        |
 * | --------------------- | ------------------------ | -------------------------- |
 * | interval_hours        | shorter                  | more frequent protection   |
 * | retention_days        | ≤ fleet ceiling          | storage the fleet plans for|
 * | cloud_keep_count      | fewer copies             | same                       |
 * | max_artifact_bytes    | smaller                  | same                       |
 * | protected_copies      | **more** copies kept     | a floor, not a ceiling     |
 * | alert_stale_hours     | shorter window           | the Owner hears sooner     |
 * | alert_failure_streak  | smaller streak           | one failure is enough      |
 * | drill_interval_hours  | shorter                  | proof, more often          |
 * | dr_rpo_hours          | shorter promise          | a better recovery point    |
 *
 * Nothing here is tenant-readable: `tenant_backup_plan_policy` and the threshold
 * columns are `platform_only` under FORCE RLS, so a business is *subject* to a
 * plan and never a reader of it (the same rule as the per-business override).
 */
import { query, withoutTenantScope } from "./db";
import { backupStaleAfterMs } from "./backup";

/** The cadences the CHECK constraint and the scheduler both accept. */
export const POLICY_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

/** Longest stale window an operator may set: a year. Bounded so a typo cannot park a fleet. */
export const MAX_STALE_HOURS = 8760;
/** Most consecutive failures a streak threshold may require before alerting. */
export const MAX_FAILURE_STREAK = 10;
/** Drills: at most hourly, at least weekly. Evidence, not a monitoring loop. */
export const MIN_DRILL_INTERVAL_HOURS = 1;
export const MAX_DRILL_INTERVAL_HOURS = 168;
/** Recovery-point objectives: an hour to a month. */
export const MAX_RPO_HOURS = 720;

/**
 * What one plan may say. Every field is nullable, and `null` means "inherit the
 * fleet row" — never zero, never "unlimited".
 */
export interface BackupPlanPolicyValues {
  intervalHours: number | null;
  retentionDays: number | null;
  keepCount: number | null;
  protectedCopies: number | null;
  maxArtifactBytes: number | null;
  alertStaleHours: number | null;
  alertFailureStreak: number | null;
  drillIntervalHours: number | null;
  drRpoHours: number | null;
}

export const EMPTY_PLAN_POLICY: BackupPlanPolicyValues = {
  intervalHours: null,
  retentionDays: null,
  keepCount: null,
  protectedCopies: null,
  maxArtifactBytes: null,
  alertStaleHours: null,
  alertFailureStreak: null,
  drillIntervalHours: null,
  drRpoHours: null,
};

/**
 * The thresholds in force for one business, already resolved to numbers.
 *
 * `staleAfterHours` is absolute — the caller compares it with the age of the last
 * success — because the alert has to answer "is this stale?" the same way whether
 * it was asked by the dashboard, a job or a test.
 */
export interface BackupThresholds {
  /** Hours without a successful run before it counts as stale. */
  staleAfterHours: number;
  /** Consecutive failures that turn a retry into an alert. */
  failureStreak: number;
  /** How often the drill re-proves restorability. */
  drillIntervalHours: number;
  /** Recovery-point objective in hours, or null when the fleet promises none. */
  rpoHours: number | null;
  /** Where the numbers came from, so a console can say so honestly. */
  source: "managed" | "default";
}

/** What a device without a reachable fleet row protects itself with. */
export const SAFE_BACKUP_THRESHOLDS: BackupThresholds = {
  // The pre-#903 alert: a nightly cadence plus the grace period it always had.
  staleAfterHours: backupStaleAfterMs(24) / 3_600_000,
  failureStreak: 1,
  drillIntervalHours: 24,
  rpoHours: null,
  source: "default",
};

interface PlanPolicyRow extends Record<string, unknown> {
  plan_key: string;
  interval_hours: number | null;
  retention_days: number | null;
  cloud_keep_count: number | null;
  protected_recovery_copies: number | null;
  max_artifact_bytes: string | null;
  alert_stale_hours: number | null;
  alert_failure_streak: number | null;
  drill_interval_hours: number | null;
  dr_rpo_hours: number | null;
  note: string;
  updated_at: Date;
}

/**
 * `?? null` on every column, not just the ones that look optional: the whole
 * layering rule rests on "absent means inherit", so a missing property must
 * never become `undefined` and then arithmetic (`NaN` retention, a cadence of
 * zero). The SELECT always returns every column; this is the guarantee that a
 * narrower read, a partial fixture or a future projection cannot break it.
 */
function mapRow(row: PlanPolicyRow): BackupPlanPolicyValues {
  return {
    intervalHours: row.interval_hours ?? null,
    retentionDays: row.retention_days ?? null,
    keepCount: row.cloud_keep_count ?? null,
    protectedCopies: row.protected_recovery_copies ?? null,
    maxArtifactBytes: row.max_artifact_bytes === null || row.max_artifact_bytes === undefined ? null : Number(row.max_artifact_bytes),
    alertStaleHours: row.alert_stale_hours ?? null,
    alertFailureStreak: row.alert_failure_streak ?? null,
    drillIntervalHours: row.drill_interval_hours ?? null,
    drRpoHours: row.dr_rpo_hours ?? null,
  };
}

const SELECT_COLUMNS = `plan_key, interval_hours, retention_days, cloud_keep_count,
                        protected_recovery_copies, max_artifact_bytes::text AS max_artifact_bytes,
                        alert_stale_hours, alert_failure_streak, drill_interval_hours,
                        dr_rpo_hours, note, updated_at`;

/**
 * One plan's policy, or `null` when it inherits entirely.
 *
 * A read failure is `null` as well: a console that cannot read a policy table
 * must fall back to the fleet row, not refuse to run backups. The same rule the
 * per-business override reader uses.
 */
export async function readBackupPlanPolicy(planKey: string): Promise<BackupPlanPolicyValues | null> {
  try {
    return await withoutTenantScope("tenant-backup-plan-policy", async () => {
      const { rows } = await query<PlanPolicyRow>(
        `SELECT ${SELECT_COLUMNS} FROM tenant_backup_plan_policy WHERE plan_key = $1`,
        [planKey],
      );
      return rows[0] ? mapRow(rows[0]) : null;
    });
  } catch {
    return null;
  }
}

/** Every plan that has a policy, keyed by plan. One query for the whole console. */
export async function listBackupPlanPolicies(): Promise<Record<string, BackupPlanPolicyValues>> {
  return withoutTenantScope("tenant-backup-plan-policy", async () => {
    const { rows } = await query<PlanPolicyRow>(
      `SELECT ${SELECT_COLUMNS} FROM tenant_backup_plan_policy ORDER BY plan_key`,
      [],
    );
    const out: Record<string, BackupPlanPolicyValues> = {};
    for (const row of rows) out[row.plan_key] = mapRow(row);
    return out;
  });
}

/**
 * Write one plan's policy.
 *
 * A field that is absent from the body is left untouched, so a console form can
 * save one number without resetting the rest. Because a SQL `NULL` in this table
 * already means "inherit the fleet", there is nothing for an explicit `null` to
 * clear *to* — clearing is `clearBackupPlanPolicy`, which removes the row.
 */
export async function writeBackupPlanPolicy(
  planKey: string,
  input: Partial<BackupPlanPolicyValues> & { note?: string; updatedBy?: string | null },
): Promise<void> {
  const num = (key: keyof BackupPlanPolicyValues): number | null =>
    typeof input[key] === "number" ? (input[key] as number) : null;
  const bytes: number | null = typeof input.maxArtifactBytes === "number" ? input.maxArtifactBytes : null;
  await withoutTenantScope("tenant-backup-plan-policy", async () => {
    await query(
      `INSERT INTO tenant_backup_plan_policy
         (plan_key, interval_hours, retention_days, cloud_keep_count, protected_recovery_copies,
          max_artifact_bytes, alert_stale_hours, alert_failure_streak, drill_interval_hours,
          dr_rpo_hours, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,''),$12,now())
       ON CONFLICT (plan_key) DO UPDATE SET
         interval_hours = COALESCE($2, tenant_backup_plan_policy.interval_hours),
         retention_days = COALESCE($3, tenant_backup_plan_policy.retention_days),
         cloud_keep_count = COALESCE($4, tenant_backup_plan_policy.cloud_keep_count),
         protected_recovery_copies = COALESCE($5, tenant_backup_plan_policy.protected_recovery_copies),
         max_artifact_bytes = COALESCE($6, tenant_backup_plan_policy.max_artifact_bytes),
         alert_stale_hours = COALESCE($7, tenant_backup_plan_policy.alert_stale_hours),
         alert_failure_streak = COALESCE($8, tenant_backup_plan_policy.alert_failure_streak),
         drill_interval_hours = COALESCE($9, tenant_backup_plan_policy.drill_interval_hours),
         dr_rpo_hours = COALESCE($10, tenant_backup_plan_policy.dr_rpo_hours),
         note = COALESCE($11, tenant_backup_plan_policy.note),
         updated_by = $12,
         updated_at = now()`,
      [
        planKey,
        num("intervalHours"),
        num("retentionDays"),
        num("keepCount"),
        num("protectedCopies"),
        bytes === null ? null : String(bytes),
        num("alertStaleHours"),
        num("alertFailureStreak"),
        num("drillIntervalHours"),
        num("drRpoHours"),
        typeof input.note === "string" ? input.note : null,
        input.updatedBy ?? null,
      ],
    );
  });
}

/** Remove a plan's policy entirely: every business on it returns to the fleet row. */
export async function clearBackupPlanPolicy(planKey: string): Promise<void> {
  await withoutTenantScope("tenant-backup-plan-policy", async () => {
    await query(`DELETE FROM tenant_backup_plan_policy WHERE plan_key = $1`, [planKey]);
  });
}

// ---------------------------------------------------------------------------
// Pure resolution — the part worth testing without a database
// ---------------------------------------------------------------------------

/** The fleet numbers a plan is layered onto. */
export interface FleetPolicyNumbers {
  intervalHours: number;
  retentionDays: number;
  maxRetentionDays: number;
  keepCount: number;
  protectedCopies: number;
  maxArtifactBytes: number;
  alertStaleHours: number | null;
  alertFailureStreak: number;
  drillIntervalHours: number;
  drRpoHours: number | null;
}

export interface LayeredPolicyNumbers {
  intervalHours: number;
  retentionDays: number;
  keepCount: number;
  protectedCopies: number;
  maxArtifactBytes: number;
}

function allowedInterval(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return (POLICY_INTERVAL_HOURS as readonly number[]).includes(value) ? value : null;
}

/**
 * The schedule/retention/capacity half: plan over fleet, clamped so the plan can
 * only tighten. Each clamp is named in the table at the top of this file.
 */
export function layerPlanPolicy(
  fleet: FleetPolicyNumbers,
  plan: BackupPlanPolicyValues | null,
): LayeredPolicyNumbers {
  if (!plan) {
    return {
      intervalHours: fleet.intervalHours,
      retentionDays: fleet.retentionDays,
      keepCount: fleet.keepCount,
      protectedCopies: fleet.protectedCopies,
      maxArtifactBytes: fleet.maxArtifactBytes,
    };
  }
  const planInterval = allowedInterval(plan.intervalHours);
  return {
    // More frequent or equal: a plan may shorten the cadence, never lengthen it.
    intervalHours: planInterval !== null ? Math.min(planInterval, fleet.intervalHours) : fleet.intervalHours,
    // Inside the fleet's own ceiling either way.
    retentionDays:
      plan.retentionDays !== null
        ? Math.min(Math.max(1, plan.retentionDays), fleet.maxRetentionDays)
        : fleet.retentionDays,
    keepCount:
      plan.keepCount !== null ? Math.min(Math.max(1, plan.keepCount), fleet.keepCount) : fleet.keepCount,
    // A floor: a plan may protect *more* copies, never fewer than the fleet's.
    protectedCopies:
      plan.protectedCopies !== null
        ? Math.max(Math.max(0, plan.protectedCopies), fleet.protectedCopies)
        : fleet.protectedCopies,
    maxArtifactBytes:
      plan.maxArtifactBytes !== null
        ? Math.min(Math.max(1, plan.maxArtifactBytes), fleet.maxArtifactBytes)
        : fleet.maxArtifactBytes,
  };
}

/**
 * The threshold half.
 *
 * The stale window has two bounds and both matter: it may not be *shorter* than
 * the cadence implies (that would alert about healthy backups every cycle), and
 * a plan may not make it *longer* than the fleet's. `intervalHours` is the
 * already-layered cadence, so the floor follows the plan's own schedule.
 */
export function layerPlanThresholds(
  fleet: FleetPolicyNumbers,
  plan: BackupPlanPolicyValues | null,
  intervalHours: number,
): BackupThresholds {
  const derivedHours = backupStaleAfterMs(intervalHours) / 3_600_000;
  const fleetWindow = fleet.alertStaleHours ?? derivedHours;
  const planWindow = plan?.alertStaleHours ?? null;
  const staleAfterHours =
    planWindow === null
      ? Math.max(derivedHours, fleetWindow)
      : Math.min(Math.max(derivedHours, planWindow), Math.max(derivedHours, fleetWindow));

  const planStreak = plan?.alertFailureStreak ?? null;
  const failureStreak = Math.max(
    1,
    Math.min(planStreak ?? fleet.alertFailureStreak, fleet.alertFailureStreak),
  );

  const planDrill = plan?.drillIntervalHours ?? null;
  const drillIntervalHours = Math.max(
    MIN_DRILL_INTERVAL_HOURS,
    Math.min(planDrill ?? fleet.drillIntervalHours, fleet.drillIntervalHours),
  );

  const planRpo = plan?.drRpoHours ?? null;
  const rpoHours =
    planRpo === null
      ? fleet.drRpoHours
      : fleet.drRpoHours === null
        ? Math.max(1, planRpo)
        : Math.min(Math.max(1, planRpo), fleet.drRpoHours);

  return { staleAfterHours, failureStreak, drillIntervalHours, rpoHours, source: "managed" };
}

// ---------------------------------------------------------------------------
// Reading what one business actually gets
// ---------------------------------------------------------------------------

interface ThresholdRow extends Record<string, unknown> {
  plan_key: string | null;
  fleet_stale: number | null;
  fleet_streak: number | null;
  fleet_drill: number | null;
  fleet_rpo: number | null;
  plan_stale: number | null;
  plan_streak: number | null;
  plan_drill: number | null;
  plan_rpo: number | null;
  plan_interval: number | null;
}

/**
 * The thresholds in force for one business, in **one** round trip.
 *
 * The drill scheduler asks this for every candidate every hour, so it is a
 * single join rather than the three reads the layered resolver does — and it
 * catches rather than throws: a deployment that has not run migration 0280 yet
 * answers with the safe defaults instead of stopping the drill job.
 */
export async function readEffectiveBackupThresholds(
  businessId: string,
  intervalHours = 24,
): Promise<BackupThresholds> {
  try {
    const row = await withoutTenantScope("tenant-backup-plan-policy", async () => {
      const { rows } = await query<ThresholdRow>(
        `SELECT b.plan::text AS plan_key,
                s.alert_stale_hours AS fleet_stale,
                s.alert_failure_streak AS fleet_streak,
                s.drill_interval_hours AS fleet_drill,
                s.dr_rpo_hours AS fleet_rpo,
                p.alert_stale_hours AS plan_stale,
                p.alert_failure_streak AS plan_streak,
                p.drill_interval_hours AS plan_drill,
                p.dr_rpo_hours AS plan_rpo,
                p.interval_hours AS plan_interval
           FROM platform_tenant_backup_service s
           LEFT JOIN businesses b ON b.id = $1
           LEFT JOIN tenant_backup_plan_policy p ON p.plan_key = b.plan
          WHERE s.id = true`,
        [businessId],
      );
      return rows[0] ?? null;
    });
    if (!row) return { ...SAFE_BACKUP_THRESHOLDS };

    // The plan may shorten the cadence, and the floor for the stale window
    // follows the cadence it actually runs at.
    const planInterval = allowedInterval(row.plan_interval);
    const cadence = planInterval !== null ? Math.min(planInterval, intervalHours) : intervalHours;
    const fleet: FleetPolicyNumbers = {
      intervalHours: cadence,
      retentionDays: 0,
      maxRetentionDays: 0,
      keepCount: 0,
      protectedCopies: 0,
      maxArtifactBytes: 0,
      alertStaleHours: row.fleet_stale,
      alertFailureStreak: row.fleet_streak ?? 1,
      drillIntervalHours: row.fleet_drill ?? SAFE_BACKUP_THRESHOLDS.drillIntervalHours,
      drRpoHours: row.fleet_rpo,
    };
    const plan: BackupPlanPolicyValues | null =
      row.plan_key === null
        ? null
        : {
            ...EMPTY_PLAN_POLICY,
            intervalHours: row.plan_interval,
            alertStaleHours: row.plan_stale,
            alertFailureStreak: row.plan_streak,
            drillIntervalHours: row.plan_drill,
            drRpoHours: row.plan_rpo,
          };
    return layerPlanThresholds(fleet, plan, cadence);
  } catch {
    return { ...SAFE_BACKUP_THRESHOLDS };
  }
}

/** Is a drill due? Pure, so the scheduler's clock stays the caller's. */
export function drillDue(now: Date, lastFinishedAt: Date | null, intervalHours: number): boolean {
  if (!lastFinishedAt) return true;
  const interval = Math.max(MIN_DRILL_INTERVAL_HOURS, intervalHours) * 3_600_000;
  return now.getTime() - lastFinishedAt.getTime() >= interval;
}

// ---------------------------------------------------------------------------
// Console validation
// ---------------------------------------------------------------------------

export type PlanPolicyValidation =
  | { ok: true; value: Partial<BackupPlanPolicyValues> & { note?: string } }
  | { ok: false; error: string };

/**
 * Validate a console body before it reaches SQL.
 *
 * `null` means "inherit" and is passed through; `undefined` means "leave alone";
 * a present number must be one the scheduler, the retention pass and the alert
 * engine can actually use. Doing this here rather than relying on the CHECK
 * constraints keeps a bad value a 400 with a name instead of a 500.
 */
export function validatePlanPolicyBody(input: unknown): PlanPolicyValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "bad_request" };
  }
  const body = input as Record<string, unknown>;
  const allowed = [
    "intervalHours",
    "retentionDays",
    "keepCount",
    "protectedCopies",
    "maxArtifactBytes",
    "alertStaleHours",
    "alertFailureStreak",
    "drillIntervalHours",
    "drRpoHours",
    "note",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return { ok: false, error: "unknown_field" };
  }

  const bounded = (key: string, min: number, max: number): number | null | undefined => {
    const raw = body[key];
    if (raw === undefined || raw === null) return raw as null | undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`invalid_${key}`);
    }
    return parsed;
  };

  const value: Partial<BackupPlanPolicyValues> & { note?: string } = {};
  try {
    const interval = bounded("intervalHours", 1, 24);
    if (
      interval !== undefined &&
      interval !== null &&
      !(POLICY_INTERVAL_HOURS as readonly number[]).includes(interval)
    ) {
      return { ok: false, error: "invalid_intervalHours" };
    }
    value.intervalHours = interval;
    value.retentionDays = bounded("retentionDays", 1, 3650);
    value.keepCount = bounded("keepCount", 1, 500);
    value.protectedCopies = bounded("protectedCopies", 0, 10);
    value.maxArtifactBytes = bounded("maxArtifactBytes", 1, 5 * 1024 ** 4);
    value.alertStaleHours = bounded("alertStaleHours", 1, MAX_STALE_HOURS);
    value.alertFailureStreak = bounded("alertFailureStreak", 1, MAX_FAILURE_STREAK);
    value.drillIntervalHours = bounded("drillIntervalHours", MIN_DRILL_INTERVAL_HOURS, MAX_DRILL_INTERVAL_HOURS);
    value.drRpoHours = bounded("drRpoHours", 1, MAX_RPO_HOURS);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid_value" };
  }

  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.length > 500) {
      return { ok: false, error: "invalid_note" };
    }
    value.note = body.note;
  }
  return { ok: true, value };
}
