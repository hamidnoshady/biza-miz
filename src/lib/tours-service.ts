/**
 * Guided tours — the database half (issue #972).
 *
 * Progress is the caller's own: every query is keyed on both the business
 * (RLS) and `userId`, and no function here reads another member's row. The
 * decision rules live in `tours.ts` (`applyTourEvent`); this file only loads,
 * locks and stores. A write takes the member's row `FOR UPDATE` inside one
 * transaction, so two devices sending events at once serialise and both
 * events land (the transitions are monotone unions, see `applyTourEvent`).
 */
import { query, withTenantTransaction } from "./db";
import { effectiveFeatures } from "./features";
import { getBusinessIndustry } from "./industry-guard";
import { getInventorySystem } from "./inventory-service";
import { tourDefinitionById } from "./tour-baseline";
import { publishedTourById } from "./tour-studio-service";
import { hasTourEvidence } from "./tour-evidence-service";
import {
  applyTourEvent,
  migrateTourProgress,
  tourById,
  tourFactsNeeded,
  tourForViewer,
  type TourViewer,
  type StoredTourProgress,
  type TourDefinition,
  type TourEventError,
  type TourProgressEvent,
} from "./tours";

type ProgressRow = {
  tour_id: string;
  tour_version: number;
  seen_step_ids: string[];
  current_step_id: string | null;
  started_at: Date | string;
  last_active_at: Date | string;
  completed_at: Date | string | null;
};

const COLUMNS =
  "tour_id, tour_version, seen_step_ids, current_step_id, started_at, last_active_at, completed_at";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ProgressRow): StoredTourProgress {
  return {
    tourId: row.tour_id,
    tourVersion: row.tour_version,
    seenStepIds: row.seen_step_ids ?? [],
    currentStepId: row.current_step_id,
    startedAt: iso(row.started_at),
    lastActiveAt: iso(row.last_active_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

/**
 * The facts eligibility is decided on, read fresh for this request. Feature
 * flags and the costing system cost a query each, and the lookup runs every
 * time a page's «آموزش» button mounts, so they are read only when a tour on
 * this page actually asks about them (`tourFactsNeeded`).
 */
export async function tourViewerFor(
  businessId: string,
  permissions: ReadonlySet<string>,
  tours: readonly TourDefinition[] = [],
): Promise<TourViewer> {
  const needs = tourFactsNeeded(tours);
  const [industry, features, inventorySystem] = await Promise.all([
    getBusinessIndustry(businessId),
    needs.features ? effectiveFeatures(businessId) : undefined,
    needs.inventorySystem ? getInventorySystem(businessId) : undefined,
  ]);
  return { permissions, industry, features, inventorySystem };
}

/**
 * The tour with this id as this viewer sees it (narrowed to their steps), only
 * if they may be told it exists. Reads the viewer's facts for that one tour.
 *
 * The id may be a code tour, a tour the super-admin published from the console
 * (migration 0288) or the automatic baseline tour of a page with no authored
 * one; `tour-baseline.ts` owns which catalogue answers, so the lookup, the
 * playback and the progress writes all agree. A published-lookup failure (no
 * database, a transient error) degrades to the code catalogue rather than
 * breaking a tour that ships in source.
 */
export async function eligibleTourById(
  id: string,
  businessId: string,
  permissions: ReadonlySet<string>,
): Promise<TourDefinition | null> {
  const published = await publishedTourById(id).catch(() => null);
  const tour = tourDefinitionById(id, published ? [published] : []);
  if (!tour) return null;
  const viewer = await tourViewerFor(businessId, permissions, [tour]);
  return tourForViewer(tour, viewer);
}

/** The caller's stored progress for the given tours, keyed by tour id. */
export async function loadTourProgress(
  businessId: string,
  userId: string,
  tourIds: readonly string[],
): Promise<Map<string, StoredTourProgress>> {
  if (tourIds.length === 0) return new Map();
  const { rows } = await query<ProgressRow>(
    `SELECT ${COLUMNS} FROM tour_member_progress
      WHERE business_id = $1 AND user_id = $2 AND tour_id = ANY($3::text[])`,
    [businessId, userId, [...tourIds]],
  );
  return new Map(rows.map((row) => [row.tour_id, mapRow(row)]));
}

/**
 * Every member's tour progress in this business, grouped by user. Used only by
 * the `team.manage` assignment report, which is allowed to see its own team's
 * learning state; nothing else may call it.
 */
export async function loadTourProgressForBusiness(
  businessId: string,
): Promise<Map<string, Map<string, StoredTourProgress>>> {
  const { rows } = await query<ProgressRow & { user_id: string }>(
    `SELECT ${COLUMNS}, user_id FROM tour_member_progress WHERE business_id = $1`,
    [businessId],
  );
  const byUser = new Map<string, Map<string, StoredTourProgress>>();
  for (const row of rows) {
    const map = byUser.get(row.user_id) ?? new Map<string, StoredTourProgress>();
    map.set(row.tour_id, mapRow(row));
    byUser.set(row.user_id, map);
  }
  return byUser;
}

export type RecordTourEventResult =
  | { ok: true; progress: StoredTourProgress | null }
  | { ok: false; error: TourEventError };

/** Applies one event to the caller's row. `reset` deletes it; everything else upserts. */
export async function recordTourEvent(
  businessId: string,
  userId: string,
  tour: TourDefinition,
  event: TourProgressEvent,
): Promise<RecordTourEventResult> {
  return withTenantTransaction(businessId, async () => {
    // Take the row lock even for a first write: the no-op insert makes the
    // row exist so concurrent first events queue on it instead of racing.
    await query(
      `INSERT INTO tour_member_progress (business_id, user_id, tour_id, tour_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, user_id, tour_id) DO NOTHING`,
      [businessId, userId, tour.id, tour.version],
    );
    const { rows } = await query<ProgressRow>(
      `SELECT ${COLUMNS} FROM tour_member_progress
        WHERE business_id = $1 AND user_id = $2 AND tour_id = $3
        FOR UPDATE`,
      [businessId, userId, tour.id],
    );
    const row = rows[0];
    // A placeholder row (just inserted, nothing applied yet) is "no progress".
    const previous =
      row && (row.seen_step_ids.length > 0 || row.current_step_id || row.completed_at)
        ? mapRow(row)
        : null;
    const now = new Date().toISOString();
    const result = applyTourEvent(tour, previous, event, now);

    if (!result.ok || result.progress === null) {
      // Either an invalid event, or a reset: in both cases leave no placeholder behind.
      await query(
        `DELETE FROM tour_member_progress
          WHERE business_id = $1 AND user_id = $2 AND tour_id = $3
            AND cardinality(seen_step_ids) = 0 AND current_step_id IS NULL AND completed_at IS NULL`,
        [businessId, userId, tour.id],
      );
      if (!result.ok) return result;
      await query(
        "DELETE FROM tour_member_progress WHERE business_id = $1 AND user_id = $2 AND tour_id = $3",
        [businessId, userId, tour.id],
      );
      return { ok: true as const, progress: null };
    }

    const next = result.progress;
    await query(
      `UPDATE tour_member_progress
          SET tour_version = $4, seen_step_ids = $5::text[], current_step_id = $6,
              started_at = $7, last_active_at = $8, completed_at = $9
        WHERE business_id = $1 AND user_id = $2 AND tour_id = $3`,
      [
        businessId,
        userId,
        tour.id,
        next.tourVersion,
        next.seenStepIds,
        next.currentStepId,
        previous ? previous.startedAt : next.startedAt,
        next.lastActiveAt,
        next.completedAt,
      ],
    );
    return { ok: true as const, progress: next };
  });
}

export type VerifyTourStepResult =
  | { ok: true; progress: StoredTourProgress | null; evidenceAt: string }
  | { ok: false; error: "unknown_step" | "not_verifiable" | "evidence_missing" };

/**
 * Completes one `action` step, if — and only if — the server holds evidence
 * that this member performed the step's verifier (issue #972, phase 2).
 *
 * This is the only path that can record an action step, and it takes no claim
 * from the client: the body names a step id, and everything else is looked up
 * here. `evidenceAt` is returned so the route can be honest about a member who
 * did the thing before the tour started ("قبلاً هم انجام داده‌اید") instead of
 * asking them to write a duplicate record just to finish a lesson.
 */
export async function verifyTourStep(
  businessId: string,
  userId: string,
  tour: TourDefinition,
  stepId: string,
): Promise<VerifyTourStepResult> {
  const step = tour.steps.find((entry) => entry.id === stepId);
  if (!step) return { ok: false, error: "unknown_step" };
  if (step.kind !== "action" || !step.verifier) return { ok: false, error: "not_verifiable" };

  const evidence = await hasTourEvidence(businessId, userId, step.verifier);
  if (!evidence) return { ok: false, error: "evidence_missing" };

  const result = await recordTourEvent(businessId, userId, tour, { type: "verified", stepId });
  if (!result.ok) return { ok: false, error: "not_verifiable" };
  return { ok: true, progress: result.progress, evidenceAt: evidence.lastAt };
}

/**
 * Migrates every member's stored progress for `tour` within `businessId` to
 * the tour's current revision: bumps `tour_version`, drops seen ids that no
 * longer exist, withdraws completion when a step has appeared that the
 * member never saw, and nulls a resume step that no longer exists.
 *
 * Returns the number of rows that were actually changed (version or step set
 * differed). Idempotent — running it again after a successful migration
 * changes nothing.
 */
export type MigrateTourProgressResult = {
  changed: number;
  migrated: number;
};

export async function migrateTourProgressForTour(
  businessId: string,
  tourId: string,
  tour: TourDefinition,
): Promise<MigrateTourProgressResult> {
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<ProgressRow & { user_id: string }>(
      `SELECT ${COLUMNS}, user_id FROM tour_member_progress
        WHERE business_id = $1 AND tour_id = $2
        FOR UPDATE`,
      [businessId, tourId],
    );

    let changed = 0;
    let migrated = 0;

    for (const row of rows) {
      const stored = mapRow(row);
      const migratedProgress = migrateTourProgress(tour, stored);
      if (!migratedProgress) continue;

      migrated++;

      const versionChanged = migratedProgress.tourVersion !== stored.tourVersion;
      const seenChanged =
        JSON.stringify(migratedProgress.seenStepIds.sort()) !==
        JSON.stringify(stored.seenStepIds.sort());
      const currentChanged = migratedProgress.currentStepId !== stored.currentStepId;
      const completedChanged = migratedProgress.completedAt !== stored.completedAt;

      if (!versionChanged && !seenChanged && !currentChanged && !completedChanged) continue;

      changed++;

      await client.query(
        `UPDATE tour_member_progress
            SET tour_version = $4, seen_step_ids = $5::text[], current_step_id = $6,
                completed_at = $7, last_active_at = now()
          WHERE business_id = $1 AND user_id = $2 AND tour_id = $3`,
        [
          businessId,
          row.user_id,
          tourId,
          migratedProgress.tourVersion,
          migratedProgress.seenStepIds,
          migratedProgress.currentStepId,
          migratedProgress.completedAt ? iso(new Date()) : null,
        ],
      );
    }

    return { changed, migrated };
  });
}

/**
 * Assigns a tour to a staff member within `businessId`. Idempotent — assigning
 * the same (member, tour) twice is a no-op. Returns true when a new row was
 * inserted, false when the assignment already existed.
 */
export async function assignTourToStaff(
  businessId: string,
  tourId: string,
  userId: string,
  actorId: string,
): Promise<boolean> {
  return withTenantTransaction(businessId, async (client) => {
    // The person must be an active member of THIS business. The FK alone only
    // proves the id exists somewhere; assigning a foreign or disabled account
    // would create a meaningless (and privacy-adjacent) row.
    const member = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active = true`,
      [userId, businessId],
    );
    if (member.rows.length === 0) return false;
    const { rows } = await client.query<{ inserted: boolean }>(
      `INSERT INTO tour_assignments (business_id, user_id, tour_id, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, user_id, tour_id) DO NOTHING
       RETURNING true AS inserted`,
      [businessId, userId, tourId, actorId],
    );
    return rows.length > 0;
  });
}

/**
 * Removes a staff member's assignment to a tour. Returns true when a row was
 * deleted, false when no assignment existed.
 */
export async function unassignTourFromStaff(
  businessId: string,
  tourId: string,
  userId: string,
): Promise<boolean> {
  return withTenantTransaction(businessId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM tour_assignments
        WHERE business_id = $1 AND user_id = $2 AND tour_id = $3`,
      [businessId, userId, tourId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/**
 * The staff members assigned to one tour, newest assignment first.
 */
export async function listTourAssignments(
  businessId: string,
  tourId: string,
): Promise<{ userId: string; fullName: string | null; assignedAt: string }[]> {
  const { rows } = await query<{ user_id: string; full_name: string | null; assigned_at: Date | string }>(
    `SELECT a.user_id, u.full_name, a.assigned_at
       FROM tour_assignments a
       JOIN users u ON u.id = a.user_id
      WHERE a.business_id = $1 AND a.tour_id = $2
      ORDER BY a.assigned_at DESC, u.full_name`,
    [businessId, tourId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    assignedAt: iso(row.assigned_at),
  }));
}

/**
 * Every tour assignment in this business, newest first, with the member's
 * name. `team.manage`-guarded reporting only.
 */
export async function listAllTourAssignments(
  businessId: string,
): Promise<{ tourId: string; userId: string; fullName: string | null; assignedAt: string }[]> {
  const { rows } = await query<{
    tour_id: string;
    user_id: string;
    full_name: string | null;
    assigned_at: Date | string;
  }>(
    `SELECT a.tour_id, a.user_id, u.full_name, a.assigned_at
       FROM tour_assignments a
       JOIN users u ON u.id = a.user_id
      WHERE a.business_id = $1
      ORDER BY a.assigned_at DESC, u.full_name`,
    [businessId],
  );
  return rows.map((row) => ({
    tourId: row.tour_id,
    userId: row.user_id,
    fullName: row.full_name,
    assignedAt: iso(row.assigned_at),
  }));
}

/**
 * The tours assigned to one staff member, newest assignment first.
 */
export async function listStaffTourAssignments(
  businessId: string,
  userId: string,
): Promise<{ tourId: string; title: string; assignedAt: string }[]> {
  const { rows } = await query<{ tour_id: string; assigned_at: Date | string }>(
    `SELECT a.tour_id, a.assigned_at
       FROM tour_assignments a
      WHERE a.business_id = $1 AND a.user_id = $2
      ORDER BY a.assigned_at DESC, a.tour_id`,
    [businessId, userId],
  );
  return rows.map((row) => ({
    tourId: row.tour_id,
    // Tours are code or console definitions, not a table to join; a published
    // tour whose id is not in this build falls back to its id rather than
    // dropping the assignment.
    title: tourById(row.tour_id)?.title ?? row.tour_id,
    assignedAt: iso(row.assigned_at),
  }));
}

/**
 * Whether `userId` is assigned `tourId` within `businessId`.
 */
export async function isTourAssignedToStaff(
  businessId: string,
  tourId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT 1 FROM tour_assignments
      WHERE business_id = $1 AND user_id = $2 AND tour_id = $3`,
    [businessId, userId, tourId],
  );
  return rows.length > 0;
}
