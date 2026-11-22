/**
 * ESH-200 / #1385 — retention for phone-first signup proofs.
 *
 * `platform_signup_requests` is a proof-in-flight table, not a customer table:
 * once a request is redeemed (or superseded) it exists only as a short support
 * record. Keeping it forever would turn a registration detail into a permanent
 * phone/name archive, which the minimum-data rule in #1385 does not allow.
 *
 * Policy:
 *
 *  - a live request that expired more than a day ago is marked consumed, so a
 *    forgotten tab can never look like an in-flight signup forever;
 *  - a consumed request is deleted after 30 days (a support window, not a
 *    CRM record);
 *  - a live, unexpired request is never touched.
 *
 * The sweep is platform-level: the table has no `business_id`, is
 * `platform_only` under FORCE RLS, and is read through the documented
 * `signup` bypass. It writes one redacted audit row (counts and cutoffs only)
 * so the deletion itself is accountable.
 */
import { withoutTenantScopeTransaction } from "../db";
import { recordSecurityAudit } from "../security-audit";

export const SIGNUP_REQUEST_RETENTION_DAYS = 30;
/** An expired request stops being "live" after this grace period. */
export const SIGNUP_EXPIRED_REQUEST_GRACE_HOURS = 24;
export const SIGNUP_RETENTION_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Rows per DELETE, so a first sweep over a backlog does not hold a long lock. */
export const SIGNUP_RETENTION_BATCH = 500;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SignupRetentionCutoffs {
  /** Live requests whose expiry is before this are marked consumed. */
  expiredBefore: Date;
  /** Consumed requests whose consumption is before this are deleted. */
  deleteBefore: Date;
}

export function signupRetentionCutoffs(now: Date = new Date()): SignupRetentionCutoffs {
  return {
    expiredBefore: new Date(now.getTime() - SIGNUP_EXPIRED_REQUEST_GRACE_HOURS * HOUR_MS),
    deleteBefore: new Date(now.getTime() - SIGNUP_REQUEST_RETENTION_DAYS * DAY_MS),
  };
}

export interface SignupRetentionResult {
  expiredMarked: number;
  deleted: number;
}

/**
 * Apply the policy once.
 *
 * The two statements are one transaction: either the expired rows are marked
 * and the old rows removed, or nothing changed. The audit row is appended
 * afterwards and is best-effort — the retention decision is already committed,
 * and a failed audit must not make the next boot re-delete (the statements are
 * idempotent, but a loud log is the honest signal).
 */
export async function sweepSignupRequests(
  now: Date = new Date(),
): Promise<SignupRetentionResult> {
  const cutoffs = signupRetentionCutoffs(now);

  const result = await withoutTenantScopeTransaction("signup", async (client) => {
    const { rowCount: expiredMarked } = await client.query(
      `UPDATE platform_signup_requests
          SET consumed_at = now()
        WHERE consumed_at IS NULL
          AND expires_at < $1`,
      [cutoffs.expiredBefore.toISOString()],
    );

    let deleted = 0;
    for (let batch = 0; batch < 20; batch += 1) {
      const { rowCount } = await client.query(
        `DELETE FROM platform_signup_requests
          WHERE id IN (
            SELECT id FROM platform_signup_requests
             WHERE consumed_at IS NOT NULL
               AND consumed_at < $1
             LIMIT $2
          )`,
        [cutoffs.deleteBefore.toISOString(), SIGNUP_RETENTION_BATCH],
      );
      deleted += rowCount ?? 0;
      if ((rowCount ?? 0) < SIGNUP_RETENTION_BATCH) break;
    }

    return { expiredMarked: expiredMarked ?? 0, deleted };
  });

  try {
    await recordSecurityAudit({
      realm: "platform",
      action: "auth.signup.retention_sweep",
      entity: "platform_signup_request",
      payload: {
        expiredMarked: result.expiredMarked,
        deleted: result.deleted,
        expiredBefore: cutoffs.expiredBefore.toISOString(),
        deleteBefore: cutoffs.deleteBefore.toISOString(),
      },
    });
  } catch (error) {
    // As above: the rows are already handled. Log ids/counts only.
    console.error("[signup] retention audit write failed", {
      expiredMarked: result.expiredMarked,
      deleted: result.deleted,
      error: error instanceof Error ? error.message : "unknown",
    });
  }

  return result;
}

/** The central background tick. */
export async function runSignupRetentionTick(now: Date = new Date()): Promise<void> {
  await sweepSignupRequests(now);
}
