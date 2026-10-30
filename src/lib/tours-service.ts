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
import {
  applyTourEvent,
  tourFactsNeeded,
  tourForViewer,
  type TourViewer,
  type StoredTourProgress,
  type TourDefinition,
  type TourEventError,
  type TourProgressEvent,
} from "./tours";
import { publishedTourById } from "./tour-catalogue-service";

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
 */
export async function eligibleTourById(
  id: string,
  businessId: string,
  permissions: ReadonlySet<string>,
): Promise<TourDefinition | null> {
  const tour = await publishedTourById(id);
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
