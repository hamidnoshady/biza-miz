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
import { effectiveFeatures } from "./features";
import { getBusinessIndustry } from "./industry-guard";
import { getInventorySystem } from "./inventory-service";
import { applyLearningPathEvent, migrateLearningPathProgress, type LearningPathDefinition, type LearningPathEvent, type LearningPathEventError, type StoredLearningPathProgress, learningPathById } from "./learning-paths";
import { tourProgressView, type TourInventorySystem, type TourViewer } from "./tours";
import { eligibleTourById, loadTourProgress } from "./tours-service";

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
 * The facts eligibility is decided on, read fresh for this request. Feature
 * flags and the costing system are read only when a path asks about one, the
 * same laziness `tourViewerFor` applies.
 */
export async function learningPathViewerFor(
  businessId: string,
  permissions: ReadonlySet<string>,
  paths: readonly LearningPathDefinition[] = [],
): Promise<TourViewer> {
  const industry = await getBusinessIndustry(businessId);
  const needsFeatures = paths.some(
    (path) =>
      path.eligibility.features?.length ||
      path.eligibility.withoutFeatures?.length ||
      path.steps.some(
        (step) =>
          step.eligibility?.features?.length || step.eligibility?.withoutFeatures?.length,
      ),
  );
  const needsInventory = paths.some(
    (path) =>
      path.eligibility.inventorySystem ||
      path.steps.some((step) => step.eligibility?.inventorySystem),
  );
  const viewer: TourViewer = { permissions, industry };
  if (needsFeatures) viewer.features = await effectiveFeatures(businessId);
  if (needsInventory) {
    viewer.inventorySystem = (await getInventorySystem(businessId)) as TourInventorySystem;
  }
  return viewer;
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

/** Every member's path progress in this business, grouped by user. */
export async function loadLearningPathProgressForBusiness(
  businessId: string,
): Promise<Map<string, Map<string, StoredLearningPathProgress>>> {
  const { rows } = await query<ProgressRow & { user_id: string }>(
    `SELECT ${COLUMNS}, user_id FROM learning_path_progress WHERE business_id = $1`,
    [businessId],
  );
  const byUser = new Map<string, Map<string, StoredLearningPathProgress>>();
  for (const row of rows) {
    const map = byUser.get(row.user_id) ?? new Map<string, StoredLearningPathProgress>();
    map.set(row.path_id, mapRow(row));
    byUser.set(row.user_id, map);
  }
  return byUser;
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
  externallyCompleted: ReadonlySet<string> = new Set(),
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
    const result = applyLearningPathEvent(path, previous, event, now, externallyCompleted);

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

/**
 * Migrates every member's stored progress for `path` within `businessId` to
 * the path's current revision: bumps `path_version`, drops completed ids that
 * no longer exist, withdraws completion when a step has appeared that the
 * member never completed, and nulls a current step that no longer exists.
 *
 * Returns the number of rows that were actually changed. Idempotent.
 */
export type MigrateLearningPathProgressResult = {
  changed: number;
  migrated: number;
};

export async function migrateLearningPathProgressForPath(
  businessId: string,
  pathId: string,
  path: LearningPathDefinition,
): Promise<MigrateLearningPathProgressResult> {
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<ProgressRow & { user_id: string }>(
      `SELECT ${COLUMNS}, user_id FROM learning_path_progress
        WHERE business_id = $1 AND path_id = $2
        FOR UPDATE`,
      [businessId, pathId],
    );

    let changed = 0;
    let migrated = 0;

    for (const row of rows) {
      const stored = mapRow(row);
      const migratedProgress = migrateLearningPathProgress(path, stored);
      if (!migratedProgress) continue;

      migrated++;

      const versionChanged = migratedProgress.pathVersion !== stored.pathVersion;
      const completedChanged =
        JSON.stringify(migratedProgress.completedStepIds.sort()) !==
        JSON.stringify(stored.completedStepIds.sort());
      const currentChanged = migratedProgress.currentStepId !== stored.currentStepId;
      const completedAtChanged = migratedProgress.completedAt !== stored.completedAt;

      if (!versionChanged && !completedChanged && !currentChanged && !completedAtChanged) continue;

      changed++;

      await client.query(
        `UPDATE learning_path_progress
            SET path_version = $4, completed_step_ids = $5::text[], current_step_id = $6,
                completed_at = $7, last_active_at = now()
          WHERE business_id = $1 AND user_id = $2 AND path_id = $3`,
        [
          businessId,
          row.user_id,
          pathId,
          migratedProgress.pathVersion,
          migratedProgress.completedStepIds,
          migratedProgress.currentStepId,
          migratedProgress.completedAt ? iso(new Date()) : null,
        ],
      );
    }

    return { changed, migrated };
  });
}

/**
 * Assigns a learning path to a staff member within `businessId`. Idempotent —
 * assigning the same (member, path) twice is a no-op. Returns true when a new
 * row was inserted, false when the assignment already existed.
 */
export async function assignLearningPathToStaff(
  businessId: string,
  pathId: string,
  userId: string,
  actorId: string,
): Promise<boolean> {
  return withTenantTransaction(businessId, async (client) => {
    // Active member of THIS business only; see `assignTourToStaff`.
    const member = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active = true`,
      [userId, businessId],
    );
    if (member.rows.length === 0) return false;
    const { rows } = await client.query<{ inserted: boolean }>(
      `INSERT INTO learning_path_assignments (business_id, user_id, path_id, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, user_id, path_id) DO NOTHING
       RETURNING true AS inserted`,
      [businessId, userId, pathId, actorId],
    );
    return rows.length > 0;
  });
}

/**
 * Removes a staff member's assignment to a learning path. Returns true when a
 * row was deleted, false when no assignment existed.
 */
export async function unassignLearningPathFromStaff(
  businessId: string,
  pathId: string,
  userId: string,
): Promise<boolean> {
  return withTenantTransaction(businessId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM learning_path_assignments
        WHERE business_id = $1 AND user_id = $2 AND path_id = $3`,
      [businessId, userId, pathId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/**
 * The staff members assigned to one learning path, newest assignment first.
 */
export async function listLearningPathAssignments(
  businessId: string,
  pathId: string,
): Promise<{ userId: string; fullName: string | null; assignedAt: string }[]> {
  const { rows } = await query<{ user_id: string; full_name: string | null; assigned_at: Date | string }>(
    `SELECT a.user_id, u.full_name, a.assigned_at
       FROM learning_path_assignments a
       JOIN users u ON u.id = a.user_id
      WHERE a.business_id = $1 AND a.path_id = $2
      ORDER BY a.assigned_at DESC, u.full_name`,
    [businessId, pathId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    assignedAt: iso(row.assigned_at),
  }));
}

/**
 * Every learning-path assignment in this business, newest first, with the
 * member's name. `team.manage`-guarded reporting only.
 */
export async function listAllLearningPathAssignments(
  businessId: string,
): Promise<{ pathId: string; userId: string; fullName: string | null; assignedAt: string }[]> {
  const { rows } = await query<{
    path_id: string;
    user_id: string;
    full_name: string | null;
    assigned_at: Date | string;
  }>(
    `SELECT a.path_id, a.user_id, u.full_name, a.assigned_at
       FROM learning_path_assignments a
       JOIN users u ON u.id = a.user_id
      WHERE a.business_id = $1
      ORDER BY a.assigned_at DESC, u.full_name`,
    [businessId],
  );
  return rows.map((row) => ({
    pathId: row.path_id,
    userId: row.user_id,
    fullName: row.full_name,
    assignedAt: iso(row.assigned_at),
  }));
}

/**
 * The learning paths assigned to one staff member, newest assignment first.
 */
export async function listStaffLearningPathAssignments(
  businessId: string,
  userId: string,
): Promise<{ pathId: string; title: string; assignedAt: string }[]> {
  const { rows } = await query<{ path_id: string; assigned_at: Date | string }>(
    `SELECT a.path_id, a.assigned_at
       FROM learning_path_assignments a
      WHERE a.business_id = $1 AND a.user_id = $2
      ORDER BY a.assigned_at DESC, a.path_id`,
    [businessId, userId],
  );
  return rows.map((row) => ({
    pathId: row.path_id,
    // Paths are code definitions, not a table to join.
    title: learningPathById(row.path_id)?.title ?? row.path_id,
    assignedAt: iso(row.assigned_at),
  }));
}

/**
 * Whether `userId` is assigned `pathId` within `businessId`.
 */
export async function isLearningPathAssignedToStaff(
  businessId: string,
  pathId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT 1 FROM learning_path_assignments
      WHERE business_id = $1 AND user_id = $2 AND path_id = $3`,
    [businessId, userId, pathId],
  );
  return rows.length > 0;
}

/**
 * The tour ids that are completed for this member, restricted to the tours the
 * given paths actually name. A path's `tour` step is done only when the server's
 * own tour progress says completed — the client never claims it.
 */
export async function completedTourIdsForPaths(
  businessId: string,
  userId: string,
  paths: readonly LearningPathDefinition[],
  permissions: ReadonlySet<string>,
): Promise<Set<string>> {
  const targets = [
    ...new Set(
      paths.flatMap((path) =>
        path.steps.filter((step) => step.kind === "tour").map((step) => step.target),
      ),
    ),
  ];
  if (targets.length === 0) return new Set();
  const progress = await loadTourProgress(businessId, userId, targets);
  const completed = new Set<string>();
  await Promise.all(
    targets.map(async (tourId) => {
      const tour = await eligibleTourById(tourId, businessId, permissions);
      if (!tour) return;
      if (tourProgressView(tour, progress.get(tourId) ?? null).status === "completed") {
        completed.add(tourId);
      }
    }),
  );
  return completed;
}
