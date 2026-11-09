/**
 * Learning paths — the database half (issue #972, item 3).
 *
 * Progress is the caller's own: every query is keyed on both the business
 * (RLS) and `userId`, and no function here reads another member's row. The
 * decision rules live in `learning-paths.ts` (`applyLearningPathEvent`); this
 * file only loads, locks and stores. A write takes the member's row `FOR
 * UPDATE` inside one transaction, so two devices sending events at once
 * serialise and both events land (the transitions are monotone unions, see
 * `applyLearningPathEvent`).
 */
import { query, withTenantTransaction } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { applyLearningPathEvent, type LearningPathDefinition, type LearningPathEvent, type LearningPathEventError, type StoredLearningPathProgress } from "./learning-paths";

type ProgressRow = {
  path_id: string;
  path_version: number;
  completed_step_ids: string[];
  current_step_id: string | null;
  started_at: Date | string;
  last_active_at: Date | string;
  completed_at: Date | string | null;
};

const COLUMNS =
  "path_id, path_version, completed_step_ids, current_step_id, started_at, last_active_at, completed_at";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ProgressRow): StoredLearningPathProgress {
  return {
    pathId: row.path_id,
    pathVersion: row.path_version,
    completedStepIds: row.completed_step_ids ?? [],
    currentStepId: row.current_step_id,
    startedAt: iso(row.started_at),
    lastActiveAt: iso(row.last_active_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

/**
 * The facts eligibility is decided on, read fresh for this request.
 * Feature flags are not part of learning path eligibility today — only
 * permissions — so no extra query is needed.
 */
export async function learningPathViewerFor(
  businessId: string,
  permissions: ReadonlySet<string>,
): Promise<{ permissions: ReadonlySet<string>; industry: string | null }> {
  const industry = await getBusinessIndustry(businessId);
  return { permissions, industry };
}

/** The caller's stored progress for the given paths, keyed by path id. */
export async function loadLearningPathProgress(
  businessId: string,
  userId: string,
  pathIds: readonly string[],
): Promise<Map<string, StoredLearningPathProgress>> {
  if (pathIds.length === 0) return new Map();
  const { rows } = await query<ProgressRow>(
    `SELECT ${COLUMNS} FROM learning_path_progress
      WHERE business_id = $1 AND user_id = $2 AND path_id = ANY($3::text[])`,
    [businessId, userId, [...pathIds]],
  );
  return new Map(rows.map((row) => [row.path_id, mapRow(row)]));
}

export type RecordLearningPathEventResult =
  | { ok: true; progress: StoredLearningPathProgress | null }
  | { ok: false; error: LearningPathEventError };

/** Applies one event to the caller's row. `reset` deletes it; everything else upserts. */
export async function recordLearningPathEvent(
  businessId: string,
  userId: string,
  path: LearningPathDefinition,
  event: LearningPathEvent,
): Promise<RecordLearningPathEventResult> {
  return withTenantTransaction(businessId, async (client) => {
    await client.query(
      `INSERT INTO learning_path_progress (business_id, user_id, path_id, path_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, user_id, path_id) DO NOTHING`,
      [businessId, userId, path.id, path.version],
    );
    const { rows } = await client.query<ProgressRow>(
      `SELECT ${COLUMNS} FROM learning_path_progress
        WHERE business_id = $1 AND user_id = $2 AND path_id = $3
        FOR UPDATE`,
      [businessId, userId, path.id],
    );
    const row = rows[0];
    const previous =
      row && (row.completed_step_ids.length > 0 || row.current_step_id || row.completed_at)
        ? mapRow(row)
        : null;
    const now = new Date().toISOString();
    const result = applyLearningPathEvent(path, previous, event, now);

    if (!result.ok || result.progress === null) {
      await client.query(
        `DELETE FROM learning_path_progress
          WHERE business_id = $1 AND user_id = $2 AND path_id = $3
            AND cardinality(completed_step_ids) = 0 AND current_step_id IS NULL AND completed_at IS NULL`,
        [businessId, userId, path.id],
      );
      if (!result.ok) return result;
      await client.query(
        "DELETE FROM learning_path_progress WHERE business_id = $1 AND user_id = $2 AND path_id = $3",
        [businessId, userId, path.id],
      );
      return { ok: true as const, progress: null };
    }

    const next = result.progress;
    await client.query(
      `UPDATE learning_path_progress
          SET path_version = $4, completed_step_ids = $5::text[], current_step_id = $6,
              started_at = $7, last_active_at = $8, completed_at = $9
        WHERE business_id = $1 AND user_id = $2 AND path_id = $3`,
      [
        businessId,
        userId,
        path.id,
        next.pathVersion,
        next.completedStepIds,
        next.currentStepId,
        previous ? previous.startedAt : next.startedAt,
        next.lastActiveAt,
        next.completedAt,
      ],
    );
    return { ok: true as const, progress: next };
  });
}
