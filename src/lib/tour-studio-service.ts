/**
 * The authored tour catalogue — the database half (issue #972, migration 0288).
 *
 * Two tables in the shape of migration 0131's articles: `knowledge_tours` holds
 * one row per tour (its identity, working copy and which revision is live) and
 * `knowledge_tour_revisions` holds immutable content snapshots. Both are
 * platform catalogues with no business_id, so every function here is
 * deployment-wide; member reads are limited to the **published** revision by
 * `publishedToursForPage` / `publishedTourById`.
 *
 * The rules that matter:
 *
 *  - **Content is validated before it is stored** (`parseStudioTourInput` in
 *    `tour-studio.ts`), and again before it is served: a row whose page was
 *    renamed, or whose anchor no longer exists, is skipped by the member lookup
 *    instead of showing a broken spotlight.
 *  - **Revisions are append-only.** Saving appends a revision with the next
 *    version number; publishing and rolling back only move the live pointer
 *    (rollback copies an old revision into a *new* version), so a member's
 *    progress — keyed on the tour id and step ids — survives authoring.
 *  - **Concurrency is explicit.** A save may carry the version the editor read;
 *    a mismatch is a `version_conflict` (409) and never a silent overwrite. The
 *    row is locked `FOR UPDATE` for publish/rollback/archive.
 */
import { query, withoutTenantScopeTransaction } from "./db";
import {
  isServableStudioTour,
  studioTourDefinition,
  type StudioTour,
  type StudioTourContent,
  type StudioTourRevision,
  type StudioTourStatus,
} from "./tour-studio";
import type { TourDefinition, TourEligibility, TourStep } from "./tours";

export type StudioTourErrorCode =
  | "not_found"
  | "version_conflict"
  | "not_draft"
  | "invalid_content";

export class StudioTourServiceError extends Error {
  readonly code: StudioTourErrorCode;
  readonly detail: string;
  constructor(code: StudioTourErrorCode, detail = "") {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

const TOUR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Row ids are uuids; a malformed one is a 404, not a database error. */
export function isStudioTourId(value: string): boolean {
  return TOUR_ID.test(value);
}

type TourRow = {
  id: string;
  tour_key: string;
  page_key: string;
  route: string;
  title: string;
  description: string;
  eligibility: TourEligibility | null;
  steps: TourStep[] | null;
  status: StudioTourStatus;
  version: number;
  published_version: number | null;
  updated_by: string;
  updated_at: Date | string;
  published_at: Date | string | null;
};

type RevisionRow = {
  version: number;
  title: string;
  description: string;
  eligibility: TourEligibility | null;
  steps: TourStep[] | null;
  created_by: string;
  created_at: Date | string;
  published_at: Date | string | null;
};

type PublishedRow = {
  tour_key: string;
  page_key: string;
  route: string;
  version: number;
  title: string;
  description: string;
  eligibility: TourEligibility | null;
  steps: TourStep[] | null;
};

const TOUR_COLUMNS =
  "id, tour_key, page_key, route, title, description, eligibility, steps, status, version, published_version, updated_by, updated_at, published_at";

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapTour(row: TourRow): StudioTour {
  return {
    id: row.id,
    tourKey: row.tour_key,
    pageKey: row.page_key,
    route: row.route,
    title: row.title,
    description: row.description,
    eligibility: row.eligibility ?? {},
    steps: row.steps ?? [],
    status: row.status,
    version: row.version,
    publishedVersion: row.published_version,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at)!,
    publishedAt: iso(row.published_at),
  };
}

function mapRevision(row: RevisionRow, liveVersion: number | null): StudioTourRevision {
  return {
    version: row.version,
    title: row.title,
    description: row.description,
    eligibility: row.eligibility ?? {},
    steps: row.steps ?? [],
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    publishedAt: iso(row.published_at),
    live: liveVersion !== null && row.version === liveVersion,
  };
}

function contentOf(row: {
  tour_key: string;
  page_key: string;
  route: string;
  title: string;
  description: string;
  eligibility: TourEligibility | null;
  steps: TourStep[] | null;
}): StudioTourContent {
  return {
    tourKey: row.tour_key,
    pageKey: row.page_key,
    route: row.route,
    title: row.title,
    description: row.description,
    eligibility: row.eligibility ?? {},
    steps: row.steps ?? [],
  };
}

/** A stored tour becomes a catalogue definition only if it still validates. */
function definitionOf(row: PublishedRow | TourRow, version: number): TourDefinition | null {
  const content = contentOf(row);
  if (content.steps.length === 0) return null;
  return isServableStudioTour(content) ? studioTourDefinition(content, version) : null;
}

function platformWrite<T>(fn: () => Promise<T>): Promise<T> {
  return withoutTenantScopeTransaction("platform", fn);
}

// ---------------------------------------------------------------------------
// Console reads
// ---------------------------------------------------------------------------

/** Every authored tour, for the console's list. */
export async function listStudioTours(): Promise<StudioTour[]> {
  const { rows } = await query<TourRow>(
    `SELECT ${TOUR_COLUMNS} FROM knowledge_tours
      ORDER BY page_key, tour_key`,
  );
  return rows.map(mapTour);
}

export async function getStudioTour(id: string): Promise<StudioTour | null> {
  if (!isStudioTourId(id)) return null;
  const { rows } = await query<TourRow>(
    `SELECT ${TOUR_COLUMNS} FROM knowledge_tours WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapTour(rows[0]) : null;
}

/** The revision history, newest first, with the live one marked. */
export async function listStudioTourRevisions(id: string): Promise<StudioTourRevision[]> {
  if (!isStudioTourId(id)) return [];
  const { rows } = await query<RevisionRow & { live_version: number | null }>(
    `SELECT r.version, r.title, r.description, r.eligibility, r.steps,
            r.created_by, r.created_at, r.published_at,
            t.published_version AS live_version
       FROM knowledge_tour_revisions r
       JOIN knowledge_tours t ON t.id = r.tour_id
      WHERE r.tour_id = $1
      ORDER BY r.version DESC`,
    [id],
  );
  return rows.map((row) => mapRevision(row, row.live_version));
}

// ---------------------------------------------------------------------------
// Console writes
// ---------------------------------------------------------------------------

export interface SavedStudioTour {
  id: string;
  version: number;
  created: boolean;
}

/**
 * Saves the working copy: inserts a new tour (version 1) or appends a revision
 * to an existing one. A published tour stays published while it is edited —
 * members keep playing the live revision until the editor publishes again —
 * and the console sees the difference as `version !== publishedVersion`.
 */
export async function saveStudioTour(
  input: StudioTourContent,
  actor: string,
  expectedVersion?: number | null,
): Promise<SavedStudioTour> {
  return platformWrite(async () => {
    const existing = await query<{ id: string; version: number; status: StudioTourStatus }>(
      "SELECT id, version, status FROM knowledge_tours WHERE tour_key = $1 FOR UPDATE",
      [input.tourKey],
    );
    const current = existing.rows[0];

    if (!current) {
      if (expectedVersion !== undefined && expectedVersion !== null) {
        throw new StudioTourServiceError("not_found");
      }
      const { rows } = await query<{ id: string; version: number }>(
        `INSERT INTO knowledge_tours
           (tour_key, page_key, route, title, description, eligibility, steps,
            status, version, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'draft', 1, $8, $8)
         RETURNING id, version`,
        [
          input.tourKey,
          input.pageKey,
          input.route,
          input.title,
          input.description,
          JSON.stringify(input.eligibility),
          JSON.stringify(input.steps),
          actor,
        ],
      );
      const { id, version } = rows[0];
      await insertRevision(id, version, input, actor);
      return { id, version, created: true };
    }

    if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new StudioTourServiceError("version_conflict");
    }

    const { rows } = await query<{ version: number }>(
      `UPDATE knowledge_tours
          SET title = $2, description = $3, eligibility = $4::jsonb, steps = $5::jsonb,
              page_key = $6, route = $7,
              version = version + 1, updated_by = $8, updated_at = now()
        WHERE id = $1
        RETURNING version`,
      [
        current.id,
        input.title,
        input.description,
        JSON.stringify(input.eligibility),
        JSON.stringify(input.steps),
        input.pageKey,
        input.route,
        actor,
      ],
    );
    const version = rows[0].version;
    await insertRevision(current.id, version, input, actor);
    return { id: current.id, version, created: false };
  });
}

async function insertRevision(
  tourId: string,
  version: number,
  input: StudioTourContent,
  actor: string,
): Promise<void> {
  await query(
    `INSERT INTO knowledge_tour_revisions
       (tour_id, version, title, description, eligibility, steps, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      tourId,
      version,
      input.title,
      input.description,
      JSON.stringify(input.eligibility),
      JSON.stringify(input.steps),
      actor,
    ],
  );
}

/** Points members at the working copy's revision. */
export async function publishStudioTour(
  id: string,
  actor: string,
  expectedVersion?: number | null,
): Promise<StudioTour> {
  return platformWrite(async () => {
    const tour = await lockTour(id);
    if (expectedVersion !== undefined && expectedVersion !== null && tour.version !== expectedVersion) {
      throw new StudioTourServiceError("version_conflict");
    }
    const definition = definitionOf(tour, tour.version);
    if (!definition) {
      throw new StudioTourServiceError(
        "invalid_content",
        "the tour is not publishable: check its page, anchors and steps",
      );
    }
    await query(
      `UPDATE knowledge_tours
          SET status = 'published', published_version = version, published_at = coalesce(published_at, now()),
              updated_by = $2, updated_at = now()
        WHERE id = $1`,
      [id, actor],
    );
    await query(
      `UPDATE knowledge_tour_revisions
          SET published_at = coalesce(published_at, now())
        WHERE tour_id = $1 AND version = $2`,
      [id, tour.version],
    );
    return (await getStudioTour(id))!;
  });
}

/**
 * Restores an earlier revision by appending it as a new version and publishing
 * it. Nothing is rewritten: the history keeps both the edit that is being
 * undone and the restore, and step ids a member already saw become seen again.
 */
export async function rollbackStudioTour(
  id: string,
  toVersion: number,
  actor: string,
): Promise<StudioTour> {
  return platformWrite(async () => {
    const tour = await lockTour(id);
    if (!Number.isInteger(toVersion) || toVersion < 1) {
      throw new StudioTourServiceError("not_found");
    }
    const { rows } = await query<RevisionRow>(
      `SELECT version, title, description, eligibility, steps, created_by, created_at, published_at
         FROM knowledge_tour_revisions
        WHERE tour_id = $1 AND version = $2`,
      [id, toVersion],
    );
    const revision = rows[0];
    if (!revision) throw new StudioTourServiceError("not_found");

    const restored: StudioTourContent = {
      tourKey: tour.tour_key,
      pageKey: tour.page_key,
      route: tour.route,
      title: revision.title,
      description: revision.description,
      eligibility: revision.eligibility ?? {},
      steps: revision.steps ?? [],
    };
    if (!isServableStudioTour(restored)) {
      throw new StudioTourServiceError(
        "invalid_content",
        "that revision no longer validates against the current pages and anchors",
      );
    }

    const { rows: updated } = await query<{ version: number }>(
      `UPDATE knowledge_tours
          SET title = $2, description = $3, eligibility = $4::jsonb, steps = $5::jsonb,
              version = version + 1, status = 'published', published_version = version + 1,
              updated_by = $6, updated_at = now(), published_at = coalesce(published_at, now())
        WHERE id = $1
        RETURNING version`,
      [
        id,
        restored.title,
        restored.description,
        JSON.stringify(restored.eligibility),
        JSON.stringify(restored.steps),
        actor,
      ],
    );
    const version = updated[0].version;
    await insertRevision(id, version, restored, actor);
    await query(
      "UPDATE knowledge_tour_revisions SET published_at = now() WHERE tour_id = $1 AND version = $2",
      [id, version],
    );
    return (await getStudioTour(id))!;
  });
}

/** Removes the tour from the member side without deleting its history. */
export async function archiveStudioTour(id: string, actor: string): Promise<StudioTour> {
  return platformWrite(async () => {
    await lockTour(id);
    await query(
      `UPDATE knowledge_tours
          SET status = 'archived', updated_by = $2, updated_at = now()
        WHERE id = $1`,
      [id, actor],
    );
    return (await getStudioTour(id))!;
  });
}

/**
 * Deletes a tour that was never published. A published or archived tour keeps
 * its row (and its history): archive it instead, so "what members were taught"
 * stays answerable.
 */
export async function deleteStudioTourDraft(id: string): Promise<void> {
  return platformWrite(async () => {
    const tour = await lockTour(id);
    if (tour.status !== "draft" || tour.published_version !== null) {
      throw new StudioTourServiceError("not_draft");
    }
    await query("DELETE FROM knowledge_tours WHERE id = $1", [id]);
  });
}

async function lockTour(id: string): Promise<TourRow> {
  if (!isStudioTourId(id)) throw new StudioTourServiceError("not_found");
  const { rows } = await query<TourRow>(
    `SELECT ${TOUR_COLUMNS} FROM knowledge_tours WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw new StudioTourServiceError("not_found");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Member reads (published only, through the one tour runtime)
// ---------------------------------------------------------------------------

const PUBLISHED_SELECT = `
  SELECT t.tour_key, t.page_key, t.route, r.version, r.title, r.description, r.eligibility, r.steps
    FROM knowledge_tours t
    JOIN knowledge_tour_revisions r
      ON r.tour_id = t.id AND r.version = t.published_version
   WHERE t.status = 'published'`;

/** The published tours of one page, as catalogue definitions the member API can serve. */
export async function publishedToursForPage(pageKey: string): Promise<TourDefinition[]> {
  const { rows } = await query<PublishedRow>(
    `${PUBLISHED_SELECT} AND t.page_key = $1 ORDER BY t.tour_key`,
    [pageKey],
  );
  return rows.flatMap((row) => {
    const definition = definitionOf(row, row.version);
    return definition ? [definition] : [];
  });
}

/** One published tour by its id, or null. Drafts and archived tours are invisible here. */
export async function publishedTourById(tourKey: string): Promise<TourDefinition | null> {
  const { rows } = await query<PublishedRow>(`${PUBLISHED_SELECT} AND t.tour_key = $1`, [tourKey]);
  return rows[0] ? definitionOf(rows[0], rows[0].version) : null;
}
