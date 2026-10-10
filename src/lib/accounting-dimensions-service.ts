/**
 * «ابعاد حسابداری» — the database half. The rules are `accounting-dimensions.ts`;
 * this module reads and writes the records and applies those rules to a
 * posting inside the caller's transaction.
 *
 * Three jobs:
 *
 *   1. Master data — the settings (which kinds are on, the detail label) and
 *      the value records. Edits are plain CRUD with one exception that matters
 *      for history: a value that has ever been posted to is archived, never
 *      deleted, and its code is never reused (the unique index includes archived
 *      rows).
 *   2. The posting guard — `assertDimensionsPostable`, called by every path that
 *      writes a new attribution (`ledger-service.ts`, `manual-journal-service.ts`,
 *      `expense-service.ts`). One function, one policy, so no path can be
 *      stricter or looser than another.
 *   3. Read helpers for the screens and the importers.
 *
 * Tenancy: every query names the business, and row-level security applies on
 * top, the same way the rest of the ledger is written.
 */
import type { PoolClient } from "pg";
import { query, withTenantTransaction } from "./db";
import {
  DETAIL_DIMENSION_DEFAULT_LABEL,
  DIMENSION_KIND_LABELS,
  DIMENSION_KINDS,
  DIMENSION_KIND_DESCRIPTIONS,
  dimensionIdsByKind,
  dimensionLabelProblem,
  dimensionPostingFailure,
  dimensionValueProblem,
  isDimensionKind,
  isDimensionUuid,
  normalizeDimensionCode,
  parseEffectiveDate,
  type DimensionKind,
  type DimensionPostingFailure,
  type DimensionSettingRecord,
  type DimensionValueFacts,
  type DimensionValueRecord,
  type LineDimensions,
} from "./accounting-dimensions";

export type { DimensionSettingRecord, DimensionValueRecord } from "./accounting-dimensions";

/** Something that runs SQL: a pooled client inside a transaction, or the tenant-scoped `query`. */
type Queryable = Pick<PoolClient, "query">;

/** Refusals carry a stable code the screens translate; `details` says which value and line. */
export class AccountingDimensionError extends Error {
  status: number;
  details: Partial<DimensionPostingFailure> & Record<string, unknown>;
  constructor(code: string, status = 400, details: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.details = details as AccountingDimensionError["details"];
  }
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function pgCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Every kind, in product order. A kind with no row is off: a business that never
 * opened the screen posts exactly as it did before this feature existed.
 */
export async function listDimensionSettings(businessId: string): Promise<DimensionSettingRecord[]> {
  const { rows } = await query<{ kind: string; is_enabled: boolean; label: string | null }>(
    `SELECT kind, is_enabled, label FROM accounting_dimension_settings WHERE business_id = $1`,
    [businessId],
  );
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return DIMENSION_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return {
      kind,
      isEnabled: row?.is_enabled ?? false,
      label: kind === "detail" ? (row?.label ?? null) : null,
      defaultLabel: DIMENSION_KIND_LABELS[kind],
      description: DIMENSION_KIND_DESCRIPTIONS[kind],
    };
  });
}

export interface DimensionSettingChange {
  kind: string;
  isEnabled?: boolean;
  /** Only the detail kind has a configurable name. */
  label?: string | null;
}

/**
 * Switches kinds on and off, and names the detail kind. Switching a kind OFF
 * never touches its values or its history: it only refuses new postings to it,
 * and the screens stop offering it.
 */
export async function saveDimensionSettings(
  businessId: string,
  actorId: string | null,
  changes: DimensionSettingChange[],
): Promise<DimensionSettingRecord[]> {
  const cleaned = changes.map((change) => {
    if (!isDimensionKind(change.kind)) throw new AccountingDimensionError("unknown_dimension_kind");
    if (change.isEnabled !== undefined && typeof change.isEnabled !== "boolean") {
      throw new AccountingDimensionError("invalid_dimension_setting");
    }
    if (change.label !== undefined && change.label !== null) {
      if (change.kind !== "detail") throw new AccountingDimensionError("label_not_configurable");
      const problem = dimensionLabelProblem(change.label);
      if (problem) throw new AccountingDimensionError(problem);
    }
    return change;
  });

  return withTenantTransaction(businessId, async () => {
    for (const change of cleaned) {
      // Only the fields the caller sent change; the others keep their stored value.
      await query(
        `INSERT INTO accounting_dimension_settings (business_id, kind, is_enabled, label, updated_by)
         VALUES ($1, $2, COALESCE($3::boolean, false), $4, $5)
         ON CONFLICT (business_id, kind) DO UPDATE SET
           is_enabled = COALESCE($3::boolean, accounting_dimension_settings.is_enabled),
           label = CASE WHEN $6::boolean THEN $4 ELSE accounting_dimension_settings.label END,
           updated_at = now(),
           updated_by = $5`,
        [
          businessId,
          change.kind,
          change.isEnabled ?? null,
          change.label === undefined ? null : change.label === null ? null : change.label.trim(),
          actorId,
          change.label !== undefined,
        ],
      );
    }
    return listDimensionSettings(businessId);
  });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

interface ValueRow extends Record<string, unknown> {
  id: string;
  kind: string;
  code: string;
  name: string;
  parent_id: string | null;
  parent_code: string | null;
  parent_name: string | null;
  location_id: string | null;
  location_name: string | null;
  effective_from: string | null;
  effective_to: string | null;
  is_active: boolean;
  has_children: boolean;
  created_at: string;
  updated_at: string;
}

const VALUE_SELECT = `SELECT v.id, v.kind, v.code, v.name, v.parent_id,
         p.code AS parent_code, p.name AS parent_name,
         v.location_id, loc.name AS location_name,
         v.effective_from::text AS effective_from, v.effective_to::text AS effective_to,
         v.is_active,
         EXISTS (SELECT 1 FROM accounting_dimension_values c WHERE c.parent_id = v.id) AS has_children,
         v.created_at::text AS created_at, v.updated_at::text AS updated_at
    FROM accounting_dimension_values v
    LEFT JOIN accounting_dimension_values p ON p.id = v.parent_id
    LEFT JOIN locations loc ON loc.id = v.location_id`;

function toValue(row: ValueRow): DimensionValueRecord {
  return {
    id: row.id,
    kind: row.kind as DimensionKind,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    parentCode: row.parent_code,
    parentName: row.parent_name,
    locationId: row.location_id,
    locationName: row.location_name,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isActive: row.is_active,
    hasChildren: row.has_children,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The value records the screens offer. Bounded: a business with thousands of cost centres has a data problem, not a list. */
export const DIMENSION_VALUE_LIST_CAP = 2000;

export async function listDimensionValues(
  businessId: string,
  options: { kind?: DimensionKind; includeArchived?: boolean } = {},
): Promise<DimensionValueRecord[]> {
  const { rows } = await query<ValueRow>(
    `${VALUE_SELECT}
      WHERE v.business_id = $1
        AND ($2::text IS NULL OR v.kind = $2::text)
        AND ($3::boolean OR v.is_active)
      ORDER BY v.kind, v.code
      LIMIT ${DIMENSION_VALUE_LIST_CAP}`,
    [businessId, options.kind ?? null, options.includeArchived ?? false],
  );
  return rows.map(toValue);
}

export async function getDimensionValue(businessId: string, id: string): Promise<DimensionValueRecord | null> {
  if (!isDimensionUuid(id)) return null;
  const { rows } = await query<ValueRow>(`${VALUE_SELECT} WHERE v.business_id = $1 AND v.id = $2`, [businessId, id]);
  return rows[0] ? toValue(rows[0]) : null;
}

/**
 * The one value of a kind that a code names, archived values included, so an
 * import can say «archived» rather than «unknown». The match is the same
 * expression the unique index uses (`lower(btrim(code))`), so the lookup and
 * the uniqueness rule can never disagree about which value a code means.
 *
 * Accepts an optional `client` so the importer can look codes up inside its
 * own transaction; with no client it uses the tenant-scoped pool.
 */
export async function findDimensionValueByCode(
  businessId: string,
  kind: DimensionKind,
  code: string,
  client?: Queryable,
): Promise<{ id: string; code: string; isActive: boolean } | null> {
  const sql = `SELECT id, code, is_active
                 FROM accounting_dimension_values
                WHERE business_id = $1 AND kind = $2 AND lower(btrim(code)) = lower(btrim($3))
                LIMIT 1`;
  const params = [businessId, kind, code] as const;
  const { rows } = client
    ? await client.query<{ id: string; code: string; is_active: boolean }>(sql, params as unknown as unknown[])
    : await query<{ id: string; code: string; is_active: boolean }>(sql, params as unknown as unknown[]);
  const row = rows[0];
  return row ? { id: row.id, code: row.code, isActive: row.is_active } : null;
}

export interface DimensionValueInput {
  kind: string;
  code: string;
  name: string;
  parentId?: string | null;
  locationId?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
}

function parseInputDates(input: { effectiveFrom?: unknown; effectiveTo?: unknown }): {
  effectiveFrom: string | null;
  effectiveTo: string | null;
} {
  const from = parseEffectiveDate(input.effectiveFrom);
  const to = parseEffectiveDate(input.effectiveTo);
  if (!from.ok || !to.ok) throw new AccountingDimensionError("invalid_effective_date");
  return { effectiveFrom: from.value, effectiveTo: to.value };
}

/** Confirms a parent is a live value of the same kind, and that attaching to it cannot loop. */
async function assertParentUsable(
  businessId: string,
  kind: DimensionKind,
  parentId: string | null,
  selfId: string | null,
): Promise<void> {
  if (!parentId) return;
  if (!isDimensionUuid(parentId)) throw new AccountingDimensionError("invalid_parent");
  if (parentId === selfId) throw new AccountingDimensionError("dimension_cycle", 409);
  const { rows } = await query<{ kind: string; is_active: boolean }>(
    `SELECT kind, is_active FROM accounting_dimension_values WHERE id = $1 AND business_id = $2`,
    [parentId, businessId],
  );
  if (!rows[0] || rows[0].kind !== kind) throw new AccountingDimensionError("invalid_parent");
  if (!rows[0].is_active) throw new AccountingDimensionError("parent_inactive");
  if (selfId) {
    // Walk up from the proposed parent: if the value being edited appears among
    // its ancestors, the move would make it its own ancestor.
    const { rows: loop } = await query<{ found: boolean }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id FROM accounting_dimension_values WHERE id = $1
         UNION ALL
         SELECT v.id, v.parent_id FROM accounting_dimension_values v JOIN ancestors a ON v.id = a.parent_id
       )
       SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2) AS found`,
      [parentId, selfId],
    );
    if (loop[0]?.found) throw new AccountingDimensionError("dimension_cycle", 409);
  }
}

async function assertLocationOfBusiness(businessId: string, locationId: string | null): Promise<void> {
  if (!locationId) return;
  if (!isDimensionUuid(locationId)) throw new AccountingDimensionError("invalid_location");
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE id = $1 AND business_id = $2`,
    [locationId, businessId],
  );
  if (!rows[0]) throw new AccountingDimensionError("invalid_location");
}

function requireKind(kind: unknown): DimensionKind {
  if (!isDimensionKind(kind)) throw new AccountingDimensionError("unknown_dimension_kind");
  return kind;
}

export async function createDimensionValue(
  businessId: string,
  actorId: string | null,
  input: DimensionValueInput,
): Promise<DimensionValueRecord> {
  const kind = requireKind(input.kind);
  const dates = parseInputDates(input);
  const problem = dimensionValueProblem({
    code: typeof input.code === "string" ? input.code : "",
    name: typeof input.name === "string" ? input.name : "",
    ...dates,
  });
  if (problem) throw new AccountingDimensionError(problem);
  const parentId = input.parentId || null;
  const locationId = input.locationId || null;

  return withTenantTransaction(businessId, async () => {
    await assertParentUsable(businessId, kind, parentId, null);
    await assertLocationOfBusiness(businessId, locationId);
    try {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO accounting_dimension_values
           (business_id, kind, code, name, parent_id, location_id, effective_from, effective_to, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10)
         RETURNING id`,
        [
          businessId,
          kind,
          normalizeDimensionCode(input.code),
          input.name.trim(),
          parentId,
          locationId,
          dates.effectiveFrom,
          dates.effectiveTo,
          input.isActive ?? true,
          actorId,
        ],
      );
      const record = await getDimensionValue(businessId, rows[0].id);
      if (!record) throw new AccountingDimensionError("dimension_not_found", 404);
      return record;
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) throw new AccountingDimensionError("dimension_code_exists", 409);
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw new AccountingDimensionError("invalid_parent");
      throw err;
    }
  });
}

export interface DimensionValuePatch {
  code?: string;
  name?: string;
  parentId?: string | null;
  locationId?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  /** `false` archives the value; `true` restores it. */
  isActive?: boolean;
}

/**
 * Edits a value. The kind never changes: a cost centre that becomes a profit
 * centre would silently re-classify every line that already carries it. Archiving
 * a value is a flag change, so a historical posting keeps pointing at the same
 * row and the same name.
 */
export async function updateDimensionValue(
  businessId: string,
  actorId: string | null,
  id: string,
  patch: DimensionValuePatch,
): Promise<DimensionValueRecord> {
  if (!isDimensionUuid(id)) throw new AccountingDimensionError("dimension_not_found", 404);
  return withTenantTransaction(businessId, async () => {
    const current = await getDimensionValue(businessId, id);
    if (!current) throw new AccountingDimensionError("dimension_not_found", 404);

    const code = patch.code !== undefined ? patch.code : current.code;
    const name = patch.name !== undefined ? patch.name : current.name;
    const dates = parseInputDates({
      effectiveFrom: patch.effectiveFrom !== undefined ? patch.effectiveFrom : current.effectiveFrom,
      effectiveTo: patch.effectiveTo !== undefined ? patch.effectiveTo : current.effectiveTo,
    });
    const problem = dimensionValueProblem({ code, name, ...dates });
    if (problem) throw new AccountingDimensionError(problem);

    const parentId = patch.parentId !== undefined ? patch.parentId || null : current.parentId;
    const locationId = patch.locationId !== undefined ? patch.locationId || null : current.locationId;
    if (parentId !== current.parentId) {
      await assertParentUsable(businessId, current.kind, parentId, id);
    }
    await assertLocationOfBusiness(businessId, locationId);

    try {
      await query(
        `UPDATE accounting_dimension_values
            SET code = $3, name = $4, parent_id = $5, location_id = $6,
                effective_from = $7::date, effective_to = $8::date,
                is_active = $9, updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [
          id,
          businessId,
          normalizeDimensionCode(code),
          name.trim(),
          parentId,
          locationId,
          dates.effectiveFrom,
          dates.effectiveTo,
          patch.isActive !== undefined ? patch.isActive : current.isActive,
        ],
      );
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) throw new AccountingDimensionError("dimension_code_exists", 409);
      if (pgCode(err) === FOREIGN_KEY_VIOLATION) throw new AccountingDimensionError("invalid_parent");
      throw err;
    }
    const record = await getDimensionValue(businessId, id);
    if (!record) throw new AccountingDimensionError("dimension_not_found", 404);
    return record;
  });
}

/** How many postings already name this value, across lines, draft lines and expenses. */
export async function dimensionValueUsage(businessId: string, id: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT (
        (SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.business_id = $1 AND $2::uuid IN (jl.cost_center_id, jl.profit_center_id, jl.department_id, jl.detail_dimension_id))
      + (SELECT count(*) FROM journal_entry_draft_lines dl JOIN journal_entry_drafts d ON d.id = dl.draft_id
          WHERE d.business_id = $1 AND $2::uuid IN (dl.cost_center_id, dl.profit_center_id, dl.department_id, dl.detail_dimension_id))
      + (SELECT count(*) FROM expenses e
          WHERE e.business_id = $1 AND $2::uuid IN (e.cost_center_id, e.profit_center_id, e.department_id, e.detail_dimension_id))
      )::text AS n`,
    [businessId, id],
  );
  return Number(rows[0]?.n ?? "0");
}

/**
 * Removes a value that was never used, and archives one that was. Matches the
 * party directory's rule: nothing with history is ever hard-deleted, so no
 * report can lose a row it once showed.
 */
export async function deleteDimensionValue(
  businessId: string,
  id: string,
): Promise<{ deleted: boolean; archived: boolean }> {
  if (!isDimensionUuid(id)) throw new AccountingDimensionError("dimension_not_found", 404);
  return withTenantTransaction(businessId, async () => {
    const current = await getDimensionValue(businessId, id);
    if (!current) throw new AccountingDimensionError("dimension_not_found", 404);
    const used = await dimensionValueUsage(businessId, id);
    if (used > 0 || current.hasChildren) {
      await query(
        `UPDATE accounting_dimension_values SET is_active = false, updated_at = now() WHERE id = $1 AND business_id = $2`,
        [id, businessId],
      );
      return { deleted: false, archived: true };
    }
    await query(`DELETE FROM accounting_dimension_values WHERE id = $1 AND business_id = $2`, [id, businessId]);
    return { deleted: true, archived: false };
  });
}

// ---------------------------------------------------------------------------
// The posting guard
// ---------------------------------------------------------------------------

/**
 * Applies the dimension policy to lines that are about to be posted (or saved
 * as a draft). Runs inside the caller's transaction, so the check and the write
 * see the same settings and values. Does nothing — and runs no query — when no
 * line carries an attribution, which is every posting that predates this feature.
 *
 * Reversals do not call this (see ISSUE_868_PLAN.md §2): they mirror an
 * existing fact, and a fact must be reversible even after its value is archived.
 */
export async function assertDimensionsPostable(
  db: Queryable,
  input: {
    businessId: string;
    locationId: string | null;
    /** `null` means «today», the same default the posting functions use. */
    entryDate: string | null;
    lines: ReadonlyArray<{ dimensions?: LineDimensions | null }>;
  },
): Promise<void> {
  const ids = dimensionIdsByKind(input.lines);
  const allIds = DIMENSION_KINDS.flatMap((kind) => ids[kind]);
  if (allIds.length === 0) return;

  const entryDate =
    input.entryDate ?? (await db.query<{ today: string }>(`SELECT CURRENT_DATE::text AS today`)).rows[0].today;

  const [settings, values, parents] = await Promise.all([
    db.query<{ kind: string; is_enabled: boolean }>(
      `SELECT kind, is_enabled FROM accounting_dimension_settings WHERE business_id = $1`,
      [input.businessId],
    ),
    db.query<{
      id: string;
      kind: string;
      is_active: boolean;
      location_id: string | null;
      effective_from: string | null;
      effective_to: string | null;
    }>(
      `SELECT id, kind, is_active, location_id, effective_from::text AS effective_from, effective_to::text AS effective_to
         FROM accounting_dimension_values WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [input.businessId, allIds],
    ),
    db.query<{ parent_id: string }>(
      `SELECT DISTINCT parent_id FROM accounting_dimension_values
        WHERE business_id = $1 AND parent_id = ANY($2::uuid[])`,
      [input.businessId, allIds],
    ),
  ]);

  const enabledKinds = new Set(
    settings.rows.filter((row) => row.is_enabled && isDimensionKind(row.kind)).map((row) => row.kind as DimensionKind),
  );
  const parentIds = new Set(parents.rows.map((row) => row.parent_id));
  const valueMap = new Map<string, DimensionValueFacts>();
  for (const row of values.rows) {
    valueMap.set(row.id, {
      id: row.id,
      kind: row.kind as DimensionKind,
      isActive: row.is_active,
      locationId: row.location_id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      hasChildren: parentIds.has(row.id),
    });
  }

  const failure = dimensionPostingFailure({
    entryLocationId: input.locationId,
    entryDate,
    enabledKinds,
    values: valueMap,
    lines: input.lines,
  });
  if (failure) {
    throw new AccountingDimensionError(failure.problem, 400, {
      kind: failure.kind,
      valueId: failure.valueId,
      lineIndex: failure.lineIndex,
    });
  }
}

/**
 * The attribution columns of a line, as the insert statements take them. Absent
 * kinds become NULL, so a line without attribution writes exactly what it always
 * wrote.
 */
export function dimensionColumnValues(dimensions: LineDimensions | null | undefined): {
  cost_center_id: string | null;
  profit_center_id: string | null;
  department_id: string | null;
  detail_dimension_id: string | null;
} {
  return {
    cost_center_id: dimensions?.cost_center ?? null,
    profit_center_id: dimensions?.profit_center ?? null,
    department_id: dimensions?.department ?? null,
    detail_dimension_id: dimensions?.detail ?? null,
  };
}

/** The attribution a row carries, with only its non-empty kinds present. */
export function dimensionsFromColumns(row: {
  cost_center_id: string | null;
  profit_center_id: string | null;
  department_id: string | null;
  detail_dimension_id: string | null;
}): LineDimensions {
  const out: LineDimensions = {};
  if (row.cost_center_id) out.cost_center = row.cost_center_id;
  if (row.profit_center_id) out.profit_center = row.profit_center_id;
  if (row.department_id) out.department = row.department_id;
  if (row.detail_dimension_id) out.detail = row.detail_dimension_id;
  return out;
}

/** True when a line carries at least one attribution. */
export function hasDimensions(dimensions: LineDimensions | null | undefined): boolean {
  return !!dimensions && DIMENSION_KINDS.some((kind) => !!dimensions[kind]);
}
