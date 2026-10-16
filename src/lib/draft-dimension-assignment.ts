/**
 * «تخصیص گروهی ابعاد به اسناد پیش‌نویس» — bulk dimension assignment for
 * unposted journal drafts (issue #868, Phase 5).
 *
 * The contract the ownership document (`docs/engineering/issue-868-ownership.md`)
 * pins down:
 *
 *   * only **unposted drafts** are touched — a posted line is immutable; the
 *     drafts this can edit are exactly the rows in `journal_entry_drafts`,
 *     which disappear the moment `approveDraft` posts them;
 *   * `fill_blank` fills only absent kinds; `overwrite` replaces the kinds the
 *     payload names (an explicit `null` clears one). Unnamed kinds are never
 *     touched;
 *   * the values must pass `assertDimensionsPostable` — a cross-tenant,
 *     archived, wrong-kind, parent, out-of-window or disabled value is
 *     refused with 400 before anything is written;
 *   * every changed line leaves an audit row in
 *     `journal_entry_draft_dimension_audit`, which survives the draft itself;
 *   * a draft approved or deleted mid-flight answers 409
 *     `draft_approval_race`, not a silent partial fill — the same `FOR UPDATE`
 *     lock `approveDraft` takes is taken here first, so the two transactions
 *     serialize rather than interleave;
 *   * `dryRun` previews the exact same resolution without writing;
 *   * the whole non-preview run is one transaction: all of the drafts' lines
 *     change or none do.
 */
import { getPool } from "./db";
import { isUuid } from "./uuid";
import { ManualJournalError } from "./manual-journal-service";
import {
  assertDimensionsPostable,
  dimensionColumnValues,
  dimensionsFromColumns,
} from "./accounting-dimensions-service";
import {
  DIMENSION_KINDS,
  parseLineDimensions,
  type DimensionKind,
  type LineDimensions,
} from "./accounting-dimensions";

/** The kinds this payload names (keys present, even when the value is null). */
function payloadKinds(payload: LineDimensions): DimensionKind[] {
  return DIMENSION_KINDS.filter((kind) => kind in payload);
}

/** How the payload combines with the attribution a line already has. */
export type BulkAssignMode = "fill_blank" | "overwrite";

export interface BulkAssignLineChange {
  lineId: string;
  lineNo: number;
  before: LineDimensions;
  after: LineDimensions;
}

export interface BulkAssignResult {
  dryRun: boolean;
  mode: BulkAssignMode;
  matchedDrafts: number;
  /** Lines whose attribution this run would change (dry-run) or changed. */
  changedLines: BulkAssignLineChange[];
  /** Lines already carrying the values — untouched, reported for the preview. */
  unchangedLines: number;
}

/** Upper bound on one call, so a runaway client cannot lock a whole ledger. */
const MAX_DRAFTS_PER_CALL = 200;

interface LineRow {
  id: string;
  draft_id: string;
  line_no: number;
  cost_center_id: string | null;
  profit_center_id: string | null;
  department_id: string | null;
  detail_dimension_id: string | null;
}

/**
 * The attribution a line should end up with, given its current one and the
 * payload. Pure — the service only decides *whether* to write it.
 */
export function resolveBulkAssignment(
  before: LineDimensions,
  payload: LineDimensions,
  mode: BulkAssignMode,
): LineDimensions {
  const after: LineDimensions = { ...before };
  for (const kind of payloadKinds(payload)) {
    const value = payload[kind];
    if (mode === "fill_blank" && before[kind]) continue;
    if (value === null) delete after[kind];
    else after[kind] = value;
  }
  return after;
}

function sameDimensions(a: LineDimensions, b: LineDimensions): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function assignDimensionsToDrafts(params: {
  businessId: string;
  actorId: string;
  /** Explicit draft ids — the only selection this first cut accepts. */
  draftIds: readonly string[];
  /** The attribution to stamp; `{}` is refused (it would change nothing). */
  dimensions: unknown;
  mode: BulkAssignMode;
  dryRun: boolean;
}): Promise<BulkAssignResult> {
  const mode = params.mode;
  if (mode !== "fill_blank" && mode !== "overwrite") {
    throw new ManualJournalError("invalid_bulk_assign_mode", 400);
  }

  // Strict parse: unknown keys or non-UUID values are refused, never coerced.
  const parsed = parseLineDimensions(params.dimensions);
  if (!parsed.ok) throw new ManualJournalError("invalid_dimensions", 400);
  const payload = parsed.value;
  if (payloadKinds(payload).length === 0) {
    throw new ManualJournalError("invalid_dimensions", 400);
  }

  const seen = new Set<string>();
  const draftIds: string[] = [];
  for (const id of params.draftIds) {
    if (!isUuid(id)) throw new ManualJournalError("invalid_draft_ids", 400);
    if (seen.has(id)) continue;
    seen.add(id);
    draftIds.push(id);
  }
  if (draftIds.length === 0) throw new ManualJournalError("invalid_draft_ids", 400);
  if (draftIds.length > MAX_DRAFTS_PER_CALL) {
    throw new ManualJournalError("too_many_drafts", 400);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // The values must be postable here and now (issue #868's rule: reject
    // cross-tenant, archived, parent, wrong-kind and out-of-window values).
    // `assertDimensionsPostable` takes FOR SHARE on the settings and the values
    // inside this transaction, so they cannot be archived mid-run.
    await assertDimensionsPostable(client, {
      businessId: params.businessId,
      locationId: null,
      entryDate: null,
      lines: [{ dimensions: payload }],
    });

    // Serialize with `approveDraft`, which locks `FOR UPDATE OF d` before
    // posting and deleting the draft. A targeted draft that is gone here was
    // approved (or rejected) between selection and now.
    const { rows: drafts } = await client.query<{ id: string }>(
      `SELECT d.id
         FROM journal_entry_drafts d
        WHERE d.business_id = $1 AND d.id = ANY($2::uuid[])
        ORDER BY d.id
        FOR UPDATE OF d`,
      [params.businessId, draftIds],
    );
    if (drafts.length !== draftIds.length) {
      throw new ManualJournalError("draft_approval_race", 409);
    }

    const { rows: lineRows } = await client.query<LineRow>(
      `SELECT dl.id, dl.draft_id, dl.line_no,
              dl.cost_center_id, dl.profit_center_id, dl.department_id, dl.detail_dimension_id
         FROM journal_entry_draft_lines dl
        WHERE dl.draft_id = ANY($1::uuid[])
        ORDER BY dl.draft_id, dl.line_no`,
      [draftIds],
    );

    const changedLines: BulkAssignLineChange[] = [];
    let unchangedLines = 0;
    for (const row of lineRows) {
      const before = dimensionsFromColumns(row);
      const after = resolveBulkAssignment(before, payload, mode);
      if (sameDimensions(before, after)) {
        unchangedLines += 1;
        continue;
      }
      changedLines.push({ lineId: row.id, lineNo: row.line_no, before, after });
      if (params.dryRun) continue;

      const cols = dimensionColumnValues(after);
      await client.query(
        `UPDATE journal_entry_draft_lines
            SET cost_center_id = $2, profit_center_id = $3, department_id = $4, detail_dimension_id = $5
          WHERE id = $1`,
        [row.id, cols.cost_center_id, cols.profit_center_id, cols.department_id, cols.detail_dimension_id],
      );
      await client.query(
        `INSERT INTO journal_entry_draft_dimension_audit
           (business_id, draft_id, line_id, line_no, actor_id, action, before, after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          params.businessId,
          row.draft_id,
          row.id,
          row.line_no,
          params.actorId,
          mode === "fill_blank" ? "bulk_fill" : "bulk_overwrite",
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
    }

    if (!params.dryRun) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    return {
      dryRun: params.dryRun,
      mode,
      matchedDrafts: drafts.length,
      changedLines,
      unchangedLines,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
