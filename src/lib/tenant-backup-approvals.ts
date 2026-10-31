/**
 * Issue #903 §3 — "recovery approvals and tenant-only restore".
 *
 * Some businesses want a second pair of eyes before a destructive restore: the
 * Owner asks, the platform answers in writing, and the consent is tied to one
 * artifact and one window. Two rules make that a real control rather than a
 * checkbox:
 *
 *  1. **Named.** An approval records which Superadmin granted it, when, and why.
 *     It is the same audit trail the console shows, not a flag on a row.
 *  2. **Single use and expiring.** One approval authorises one restore of one
 *     reference, and only until its window closes. It is consumed *after* the
 *     restore commits, so a failed attempt (a bad checksum, a busy lock) never
 *     burns the Owner's consent.
 *
 * The feature is **off by default** — `require_restore_approval` is false for
 * every business until a Superadmin turns it on — so no existing restore changes
 * behaviour. Everything here is platform-only; the tenant never reads or writes
 * an approval, it only experiences the refusal.
 */
import { query, withoutTenantScope } from "./db";
import { readBusinessPolicyOverride } from "./tenant-backup-storage";

/** Longest window an approval may be granted for: a week. */
export const MAX_APPROVAL_TTL_MINUTES = 7 * 24 * 60;
export const DEFAULT_APPROVAL_TTL_MINUTES = 24 * 60;

export interface RestoreApproval {
  id: string;
  artifactRef: string;
  approvedBy: string | null;
  approvedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedJournalId: string | null;
  note: string;
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  artifact_ref: string;
  approved_by: string | null;
  approved_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_journal_id: string | null;
  note: string;
}

function mapApproval(row: ApprovalRow): RestoreApproval {
  return {
    id: row.id,
    artifactRef: row.artifact_ref,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at ? row.consumed_at.toISOString() : null,
    consumedJournalId: row.consumed_journal_id,
    note: row.note,
  };
}

/**
 * Does this business require an approval before a destructive restore?
 *
 * A read failure answers `false`: refusing every restore because a policy table
 * could not be read would turn a Superadmin control into an outage. The apply
 * route still re-checks, and the approval row itself is the authoritative "yes".
 */
export async function restoreApprovalRequired(businessId: string): Promise<boolean> {
  const override = await readBusinessPolicyOverride(businessId);
  return override?.require_restore_approval === true;
}

/**
 * The approval that would authorise *this* restore: unconsumed, unexpired, and
 * for this exact reference. A reference from another artifact is not an
 * approval — that is what "tied to one artifact" means.
 */
export async function validRestoreApproval(
  businessId: string,
  artifactRef: string,
  now: Date = new Date(),
): Promise<RestoreApproval | null> {
  const { rows } = await query<ApprovalRow>(
    `SELECT id, artifact_ref, approved_by, approved_at, expires_at, consumed_at,
            consumed_journal_id, note
       FROM tenant_backup_restore_approvals
      WHERE subject_business_id = $1 AND artifact_ref = $2
        AND consumed_at IS NULL AND expires_at > $3
      ORDER BY expires_at DESC
      LIMIT 1`,
    [businessId, artifactRef, now],
  );
  return rows[0] ? mapApproval(rows[0]) : null;
}

export type ApprovalGate =
  | { ok: true; approval: RestoreApproval | null }
  | { ok: false; error: "restore_approval_required" };

/**
 * The gate the apply route calls before it touches anything. When the business
 * does not require an approval, this is a no-op that reports `null`.
 */
export async function checkRestoreApproval(
  businessId: string,
  artifactRef: string,
): Promise<ApprovalGate> {
  if (!(await restoreApprovalRequired(businessId))) return { ok: true, approval: null };
  const approval = await validRestoreApproval(businessId, artifactRef);
  if (!approval) return { ok: false, error: "restore_approval_required" };
  return { ok: true, approval };
}

/**
 * Mark an approval used, once. The conditional `WHERE consumed_at IS NULL` is
 * what makes it single use under concurrency: two applies racing for the same
 * approval get one winner, and the loser sees `false`.
 */
export async function consumeRestoreApproval(
  approvalId: string,
  journalId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE tenant_backup_restore_approvals
        SET consumed_at = $2, consumed_journal_id = $3
      WHERE id = $1 AND consumed_at IS NULL`,
    [approvalId, now, journalId],
  );
  return (rowCount ?? 0) > 0;
}

export interface GrantApprovalInput {
  businessId: string;
  artifactRef: string;
  approvedBy: string;
  ttlMinutes?: number;
  note?: string;
  now?: Date;
}

/** Grant consent for one artifact. Windows are clamped, never open-ended. */
export async function grantRestoreApproval(input: GrantApprovalInput): Promise<RestoreApproval> {
  const now = input.now ?? new Date();
  const requested = Number.isFinite(input.ttlMinutes) ? Number(input.ttlMinutes) : DEFAULT_APPROVAL_TTL_MINUTES;
  const ttlMinutes = Math.min(Math.max(1, Math.trunc(requested)), MAX_APPROVAL_TTL_MINUTES);
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  const { rows } = await query<ApprovalRow>(
    `INSERT INTO tenant_backup_restore_approvals
       (subject_business_id, artifact_ref, approved_by, approved_at, expires_at, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, artifact_ref, approved_by, approved_at, expires_at, consumed_at,
               consumed_journal_id, note`,
    [input.businessId, input.artifactRef, input.approvedBy, now, expiresAt, input.note ?? ""],
  );
  return mapApproval(rows[0]);
}

/** The console's list: newest first, with the caller's own business only. */
export async function listRestoreApprovals(businessId: string, limit = 20): Promise<RestoreApproval[]> {
  const { rows } = await query<ApprovalRow>(
    `SELECT id, artifact_ref, approved_by, approved_at, expires_at, consumed_at,
            consumed_journal_id, note
       FROM tenant_backup_restore_approvals
      WHERE subject_business_id = $1
      ORDER BY approved_at DESC
      LIMIT $2`,
    [businessId, Math.min(Math.max(1, limit), 100)],
  );
  return rows.map(mapApproval);
}

/**
 * Withdraw a grant that has not been used. A consumed approval cannot be
 * revoked — the restore it authorised already happened, and rewriting that
 * history would be a lie.
 */
export async function revokeRestoreApproval(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM tenant_backup_restore_approvals
      WHERE subject_business_id = $1 AND id = $2 AND consumed_at IS NULL`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Write (or clear) one business's policy override. A field passed as `null`
 * clears that field back to "inherit"; an omitted field is left untouched, so a
 * console form can save one number without resetting the rest.
 */
export interface PolicyOverrideInput {
  intervalHours?: number | null;
  retentionDays?: number | null;
  keepCount?: number | null;
  protectedCopies?: number | null;
  maxArtifactBytes?: number | null;
  requireRestoreApproval?: boolean;
  note?: string;
  updatedBy: string | null;
}

export async function writeBusinessPolicyOverride(
  businessId: string,
  input: PolicyOverrideInput,
): Promise<void> {
  await withoutTenantScope("tenant-backup-business-policy", async () => {
    await query(
      `INSERT INTO tenant_backup_business_policy
         (subject_business_id, interval_hours, retention_days, keep_count, protected_recovery_copies,
          max_artifact_bytes, require_restore_approval, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,false),COALESCE($8,''),$9,now())
       ON CONFLICT (subject_business_id) DO UPDATE SET
         interval_hours = COALESCE($2, tenant_backup_business_policy.interval_hours),
         retention_days = COALESCE($3, tenant_backup_business_policy.retention_days),
         keep_count = COALESCE($4, tenant_backup_business_policy.keep_count),
         protected_recovery_copies = COALESCE($5, tenant_backup_business_policy.protected_recovery_copies),
         max_artifact_bytes = COALESCE($6, tenant_backup_business_policy.max_artifact_bytes),
         require_restore_approval = COALESCE($7, tenant_backup_business_policy.require_restore_approval),
         note = COALESCE($8, tenant_backup_business_policy.note),
         updated_by = $9,
         updated_at = now()`,
      [
        businessId,
        input.intervalHours ?? null,
        input.retentionDays ?? null,
        input.keepCount ?? null,
        input.protectedCopies ?? null,
        input.maxArtifactBytes !== undefined && input.maxArtifactBytes !== null
          ? String(input.maxArtifactBytes)
          : null,
        typeof input.requireRestoreApproval === "boolean" ? input.requireRestoreApproval : null,
        typeof input.note === "string" ? input.note : null,
        input.updatedBy,
      ],
    );
  });
}

/** Delete a business's override entirely, returning it to the fleet policy. */
export async function clearBusinessPolicyOverride(businessId: string): Promise<void> {
  await withoutTenantScope("tenant-backup-business-policy", async () => {
    await query(`DELETE FROM tenant_backup_business_policy WHERE subject_business_id = $1`, [businessId]);
  });
}

/** The cadences the migration's CHECK constraint accepts. */
const POLICY_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

export type PolicyOverrideValidation =
  | { ok: true; value: Omit<PolicyOverrideInput, "updatedBy"> }
  | { ok: false; error: string };

/**
 * Validate a console body before it reaches SQL.
 *
 * The route could let the database's CHECK constraints do this, but then a bad
 * cadence would surface as a 500 and an empty field (meaning "inherit") would be
 * indistinguishable from a value of zero. `null` and `undefined` both mean
 * "leave alone / inherit"; a present number must be one the scheduler can use.
 */
export function validatePolicyOverrideBody(input: unknown): PolicyOverrideValidation {
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
    "requireRestoreApproval",
    "note",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return { ok: false, error: "unknown_field" };
  }

  const value: Omit<PolicyOverrideInput, "updatedBy"> = {};
  const numberOrNull = (key: string, min: number, max: number): number | null | undefined => {
    const raw = body[key];
    if (raw === undefined || raw === null) return raw;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`invalid_${key}`);
    }
    return parsed;
  };

  try {
    const interval = numberOrNull("intervalHours", 1, 24);
    if (interval !== undefined && interval !== null && !(POLICY_INTERVAL_HOURS as readonly number[]).includes(interval)) {
      return { ok: false, error: "invalid_intervalHours" };
    }
    value.intervalHours = interval;
    value.retentionDays = numberOrNull("retentionDays", 1, 3650);
    value.keepCount = numberOrNull("keepCount", 1, 500);
    value.protectedCopies = numberOrNull("protectedCopies", 0, 10);
    value.maxArtifactBytes = numberOrNull("maxArtifactBytes", 1, 5 * 1024 ** 4);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid_value" };
  }

  if (body.requireRestoreApproval !== undefined && typeof body.requireRestoreApproval !== "boolean") {
    return { ok: false, error: "invalid_requireRestoreApproval" };
  }
  if (body.requireRestoreApproval !== undefined) {
    value.requireRestoreApproval = body.requireRestoreApproval as boolean;
  }
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.length > 500) {
      return { ok: false, error: "invalid_note" };
    }
    value.note = body.note;
  }
  return { ok: true, value };
}
