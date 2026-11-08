/**
 * Verified business actions — the database half (issue #972, phase 2).
 *
 * Two functions, and the split is the whole safety argument:
 *
 *  - `recordTourEvidence` is called by the domain endpoint that performed the
 *    write, AFTER the write succeeded, inside the same request and the same
 *    tenant scope. It never throws: a tour must never turn a successful sale
 *    into a failed one, so a broken evidence table costs the member a retry of
 *    the tour step, not the action they just did.
 *  - `hasTourEvidence` is called by the verify route. It answers "did this
 *    member really do it", which is the only thing that can mark an `action`
 *    step seen. Nothing a client sends can create a row here.
 *
 * The row is an upsert (one per business/member/verifier), so usage cannot grow
 * the table and a member who did the thing before this tour started is still
 * telling the truth — the returned `lastAt` lets the UI say "قبلاً هم این کار
 * را انجام داده‌اید" instead of demanding a duplicate write to production.
 */
import { query } from "./db";
import { isTourVerifier, type TourVerifier } from "./tour-verifiers";

export interface TourEvidenceRecord {
  verifier: TourVerifier;
  /** When the member last did this — any time, not only during this tour. */
  lastAt: string;
  count: number;
}

/**
 * Records that `userId` performed `verifier` in `businessId`.
 *
 * Best-effort on purpose: the callers are real business endpoints (product
 * creation, party creation, order creation) and their success must not depend
 * on the learning subsystem. A verifier outside the whitelist is ignored rather
 * than written, so a typo in a caller cannot seed a key the tours never ask for.
 */
export async function recordTourEvidence(input: {
  businessId: string;
  userId: string;
  verifier: TourVerifier;
  /** An opaque row id for support. Never a name, an amount or a payload. */
  entityId?: string | null;
}): Promise<void> {
  if (!isTourVerifier(input.verifier)) return;
  const entityId = input.entityId ? input.entityId.slice(0, 64) : null;
  try {
    await query(
      `INSERT INTO tour_action_evidence (business_id, user_id, verifier, last_entity_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, user_id, verifier) DO UPDATE
         SET last_at = now(),
             count = tour_action_evidence.count + 1,
             last_entity_id = COALESCE(EXCLUDED.last_entity_id, tour_action_evidence.last_entity_id)`,
      [input.businessId, input.userId, input.verifier, entityId],
    );
  } catch {
    // Never fail the business action because the tour could not be credited.
  }
}

/** Whether this member has ever completed `verifier` in this business. */
export async function hasTourEvidence(
  businessId: string,
  userId: string,
  verifier: TourVerifier,
): Promise<TourEvidenceRecord | null> {
  const { rows } = await query<{ last_at: Date | string; count: number }>(
    `SELECT last_at, count FROM tour_action_evidence
      WHERE business_id = $1 AND user_id = $2 AND verifier = $3`,
    [businessId, userId, verifier],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    verifier,
    lastAt: row.last_at instanceof Date ? row.last_at.toISOString() : new Date(row.last_at).toISOString(),
    count: row.count,
  };
}
