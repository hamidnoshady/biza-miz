/**
 * «قوانین انتساب ابعاد» — the business's mapping rules for operational
 * postings (issue #868, Phase 3), DB-touching.
 *
 * The policy itself is pure (`accounting-dimension-mappings.ts`); this file
 * owns the rows and the one resolution entry point every operational posting
 * goes through. `resolveTradingAttribution` is deliberately the only reader:
 * a purchase, a sale, a COGS leg and their returns must agree on attribution
 * or reports cannot reconcile, so no posting path resolves rules on its own.
 *
 * History is stamped, never recomputed: the returned tuple is written onto the
 * journal lines at posting time. Editing a rule afterwards changes future
 * postings only.
 */
import type { PoolClient } from "pg";
import { query, withTenantTransaction } from "./db";
import {
  DIMENSION_KINDS,
  dimensionPostingFailure,
  isDimensionKind,
  type DimensionKind,
  type DimensionValueFacts,
  type LineDimensions,
} from "./accounting-dimensions";
import { AccountingDimensionError, dimensionsFromColumns } from "./accounting-dimensions-service";
import {
  MAPPING_REF_MAX,
  filterPostable,
  mappingRefProblem,
  mergeExplicitDimensions,
  normalizeMappingDate,
  resolveTradingDimensions,
  type DimensionMappingRule,
  type MappingScope,
  type TradingDocumentRefs,
} from "./accounting-dimension-mappings";
import { isUuid } from "./uuid";

export { AccountingDimensionError };

export interface DimensionMappingRecord {
  id: string;
  scope: MappingScope;
  ref: string;
  dimensions: LineDimensions;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
  createdAt: string;
}

interface MappingRow extends Record<string, unknown> {
  id: string;
  scope: string;
  ref: string;
  cost_center_id: string | null;
  profit_center_id: string | null;
  department_id: string | null;
  detail_dimension_id: string | null;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  note: string | null;
  created_at: string;
}

const MAPPING_COLUMNS = `id, scope, ref, cost_center_id, profit_center_id, department_id, detail_dimension_id,
         is_active, effective_from::text AS effective_from, effective_to::text AS effective_to, note,
         created_at::text AS created_at`;

function toRecord(row: MappingRow): DimensionMappingRecord {
  return {
    id: row.id,
    scope: row.scope as MappingScope,
    ref: row.ref,
    dimensions: dimensionsFromColumns(row),
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    createdAt: row.created_at,
  };
}

function toRule(row: MappingRow): DimensionMappingRule {
  return {
    scope: row.scope as MappingScope,
    ref: row.ref,
    dimensions: dimensionsFromColumns(row),
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

export async function listDimensionMappings(
  businessId: string,
  options: { scope?: MappingScope | null } = {},
): Promise<DimensionMappingRecord[]> {
  const scope = options.scope ?? null;
  const { rows } = await query<MappingRow>(
    `SELECT ${MAPPING_COLUMNS} FROM accounting_dimension_mappings
      WHERE business_id = $1 AND ($2::text IS NULL OR scope = $2)
      ORDER BY scope, lower(btrim(ref))`,
    [businessId, scope],
  );
  return rows.map(toRecord);
}

export interface DimensionMappingInput {
  scope: unknown;
  ref: unknown;
  dimensions: LineDimensions;
  isActive?: boolean;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  note?: unknown;
}

function parseMappingInput(raw: DimensionMappingInput): {
  scope: MappingScope;
  ref: string;
  dimensions: LineDimensions;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
} {
  const scope = raw.scope;
  if (scope !== "item" && scope !== "product_category" && scope !== "supplier" && scope !== "sales_channel") {
    throw new AccountingDimensionError("mapping_scope_invalid", 400);
  }
  const ref = typeof raw.ref === "string" ? raw.ref.trim() : "";
  const refProblem = mappingRefProblem(scope, ref);
  if (refProblem) throw new AccountingDimensionError(refProblem, 400);
  const dims: LineDimensions = {};
  for (const kind of DIMENSION_KINDS) {
    const valueId = raw.dimensions?.[kind];
    if (valueId === undefined || valueId === null) continue;
    if (!isUuid(valueId)) throw new AccountingDimensionError("invalid_dimension", 400, { kind });
    dims[kind] = valueId;
  }
  if (DIMENSION_KINDS.every((kind) => !dims[kind])) {
    throw new AccountingDimensionError("mapping_dimensions_required", 400);
  }
  const from = normalizeMappingDate(raw.effectiveFrom);
  const to = normalizeMappingDate(raw.effectiveTo);
  if (!from.ok || !to.ok) throw new AccountingDimensionError("invalid_effective_date", 400);
  if (from.value && to.value && to.value < from.value) {
    throw new AccountingDimensionError("invalid_effective_dates", 400);
  }
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 200) : null;
  return {
    scope,
    ref,
    dimensions: dims,
    isActive: raw.isActive ?? true,
    effectiveFrom: from.value,
    effectiveTo: to.value,
    note,
  };
}

/**
 * A rule's values must be this business's own values of the right kind — the
 * database trigger is the backstop; this names the refusal before it fires.
 */
async function assertMappingValuesPostable(
  businessId: string,
  dimensions: LineDimensions,
): Promise<void> {
  const ids = DIMENSION_KINDS.map((kind) => dimensions[kind]).filter((v): v is string => Boolean(v));
  if (ids.length === 0) return;
  const { rows } = await query<{ id: string; kind: string }>(
    `SELECT id, kind FROM accounting_dimension_values WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, ids],
  );
  const kindById = new Map(rows.map((r) => [r.id, r.kind]));
  for (const kind of DIMENSION_KINDS) {
    const valueId = dimensions[kind];
    if (!valueId) continue;
    const found = kindById.get(valueId);
    if (!found || found !== kind) throw new AccountingDimensionError("dimension_not_found", 400, { kind, valueId });
  }
}

export async function createDimensionMapping(
  businessId: string,
  raw: DimensionMappingInput,
  actorId: string | null,
): Promise<DimensionMappingRecord> {
  const input = parseMappingInput(raw);
  return withTenantTransaction(businessId, async () => {
    await assertMappingValuesPostable(businessId, input.dimensions);
    const { rows } = await query<MappingRow>(
      `INSERT INTO accounting_dimension_mappings
         (business_id, scope, ref, cost_center_id, profit_center_id, department_id, detail_dimension_id,
          is_active, effective_from, effective_to, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING ${MAPPING_COLUMNS}`,
      [
        businessId,
        input.scope,
        input.ref,
        input.dimensions.cost_center ?? null,
        input.dimensions.profit_center ?? null,
        input.dimensions.department ?? null,
        input.dimensions.detail ?? null,
        input.isActive,
        input.effectiveFrom,
        input.effectiveTo,
        input.note,
        actorId,
      ],
    );
    if (!rows[0]) throw new AccountingDimensionError("mapping_ref_exists", 409);
    return toRecord(rows[0]);
  });
}

export async function updateDimensionMapping(
  businessId: string,
  id: string,
  raw: Partial<DimensionMappingInput>,
): Promise<DimensionMappingRecord> {
  if (!isUuid(id)) throw new AccountingDimensionError("mapping_not_found", 404);
  return withTenantTransaction(businessId, async () => {
    const { rows: existing } = await query<MappingRow>(
      `SELECT ${MAPPING_COLUMNS} FROM accounting_dimension_mappings WHERE business_id = $1 AND id = $2`,
      [businessId, id],
    );
    if (!existing[0]) throw new AccountingDimensionError("mapping_not_found", 404);
    const merged = parseMappingInput({
      scope: raw.scope ?? existing[0].scope,
      ref: raw.ref ?? existing[0].ref,
      dimensions: raw.dimensions ?? dimensionsFromColumns(existing[0]),
      isActive: raw.isActive ?? existing[0].is_active,
      effectiveFrom: raw.effectiveFrom ?? existing[0].effective_from,
      effectiveTo: raw.effectiveTo ?? existing[0].effective_to,
      note: raw.note ?? existing[0].note,
    });
    await assertMappingValuesPostable(businessId, merged.dimensions);
    const { rows } = await query<MappingRow>(
      `UPDATE accounting_dimension_mappings
          SET scope = $3, ref = $4,
              cost_center_id = $5, profit_center_id = $6, department_id = $7, detail_dimension_id = $8,
              is_active = $9, effective_from = $10, effective_to = $11, note = $12, updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING ${MAPPING_COLUMNS}`,
      [
        businessId,
        id,
        merged.scope,
        merged.ref,
        merged.dimensions.cost_center ?? null,
        merged.dimensions.profit_center ?? null,
        merged.dimensions.department ?? null,
        merged.dimensions.detail ?? null,
        merged.isActive,
        merged.effectiveFrom,
        merged.effectiveTo,
        merged.note,
      ],
    );
    return toRecord(rows[0]);
  });
}

/**
 * Removes a rule. Rules are configuration, not facts: nothing in the ledger
 * points at them (journal lines carry stamped values, never a rule), so a rule
 * can always be deleted — the postings it produced are untouched.
 */
export async function deleteDimensionMapping(businessId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new AccountingDimensionError("mapping_not_found", 404);
  await query(`DELETE FROM accounting_dimension_mappings WHERE business_id = $1 AND id = $2`, [businessId, id]);
}

// ---------------------------------------------------------------------------
// Resolution at posting time
// ---------------------------------------------------------------------------

export interface ResolveTradingInput {
  businessId: string;
  /** The posting day; `null` means today, the posting functions' own default. */
  entryDate: string | null;
  /** The entry's branch, for the branch-restriction policy. */
  locationId: string | null;
  /** The document's source references. */
  refs?: TradingDocumentRefs | null;
  /**
   * Attribution the caller already carries (a mirror, an amendment, a source
   * document that has attribution). Wins over every rule, per kind.
   */
  explicit?: LineDimensions | null;
}

/**
 * The attribution an operational posting should carry, or `null` for
 * «بدون بُعد».
 *
 * Runs no query at all when the business has no rules and the caller passes no
 * explicit attribution — every posting that predates this feature stays
 * exactly as fast and as unattributed as it was. A rule whose value is not
 * postable for this entry is skipped (a stale rule never blocks a sale); an
 * **explicit** value that is not postable is a caller error and is returned
 * through `assertDimensionsPostable` at the line writer as before.
 */
export async function resolveTradingAttribution(
  db: Pick<PoolClient, "query">,
  input: ResolveTradingInput,
): Promise<LineDimensions | null> {
  const explicit = input.explicit ?? null;
  const refs = input.refs ?? null;
  const wantsMapping = Boolean(
    refs && ((refs.itemRefs?.length ?? 0) > 0 || (refs.categoryRefs?.length ?? 0) > 0 || refs.supplierRef || (refs.channelRefs?.length ?? 0) > 0),
  );
  if (!wantsMapping) return explicit;

  const { rows: anyRules } = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM accounting_dimension_mappings WHERE business_id = $1 LIMIT 1`,
    [input.businessId],
  );
  if (anyRules.length === 0) return explicit;

  const lower = (list: readonly string[] | undefined) => (list ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean);
  const { rows } = await db.query<MappingRow>(
    `SELECT ${MAPPING_COLUMNS} FROM accounting_dimension_mappings
      WHERE business_id = $1
        AND ((scope = 'item' AND lower(btrim(ref)) = ANY($2::text[]))
          OR (scope = 'product_category' AND lower(btrim(ref)) = ANY($3::text[]))
          OR (scope = 'supplier' AND lower(btrim(ref)) = ANY($4::text[]))
          OR (scope = 'sales_channel' AND lower(btrim(ref)) = ANY($5::text[])))`,
    [
      input.businessId,
      lower(refs?.itemRefs),
      lower(refs?.categoryRefs),
      lower(refs?.supplierRef ? [refs.supplierRef] : []),
      lower(refs?.channelRefs),
    ],
  );
  if (rows.length === 0) return explicit;

  const entryDate =
    input.entryDate ?? (await db.query<{ today: string }>(`SELECT CURRENT_DATE::text AS today`)).rows[0].today;

  // Enabled kinds, and the facts the posting policy needs per candidate value.
  const candidateIds = new Set<string>();
  for (const row of rows) {
    for (const kind of DIMENSION_KINDS) {
      const valueId = dimensionsFromColumns(row)[kind];
      if (valueId) candidateIds.add(valueId);
    }
  }
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
      [input.businessId, [...candidateIds]],
    ),
    db.query<{ parent_id: string }>(
      `SELECT DISTINCT parent_id FROM accounting_dimension_values
        WHERE business_id = $1 AND parent_id = ANY($2::uuid[])`,
      [input.businessId, [...candidateIds]],
    ),
  ]);
  const enabledKinds = new Set(
    settings.rows.filter((row) => row.is_enabled && isDimensionKind(row.kind)).map((row) => row.kind as DimensionKind),
  );
  const parentIds = new Set(parents.rows.map((row) => row.parent_id));
  const facts = new Map<string, DimensionValueFacts>();
  for (const row of values.rows) {
    facts.set(row.id, {
      id: row.id,
      kind: row.kind as DimensionKind,
      isActive: row.is_active,
      locationId: row.location_id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      hasChildren: parentIds.has(row.id),
    });
  }

  // A rule whose value is not postable *here* is skipped as if absent: the
  // sale still posts (next rule or unassigned), and the stale rule is fixed
  // on the mapping screen — never by refusing the customer's receipt.
  const postable = (kind: DimensionKind, valueId: string): boolean => {
    const single = [{ dimensions: { [kind]: valueId } }];
    return !dimensionPostingFailure({
      entryLocationId: input.locationId ?? null,
      entryDate,
      enabledKinds,
      values: facts,
      lines: single,
    });
  };

  const mapped = resolveTradingDimensions(rows.map(toRule), refs!, { entryDate, enabledKinds });
  const postableMapped = filterPostable(mapped, postable);
  return mergeExplicitDimensions(explicit, postableMapped);
}

/** The rules as the pure resolver reads them — exported for tests and previews. */
export function mappingRowsToRules(rows: readonly MappingRow[]): DimensionMappingRule[] {
  return rows.map(toRule);
}

