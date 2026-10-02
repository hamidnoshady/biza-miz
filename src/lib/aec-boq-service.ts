/**
 * Issue #799 §7 — the BOQ/estimate service: estimates, their versions, the
 * measured rows, the approval life cycle and the budget connection.
 *
 * The shapes and the arithmetic live in `aec-boq.ts` (pure); this file is the
 * part that talks to PostgreSQL. It follows `aec-service.ts`'s conventions:
 * every write takes a `WorkspaceOwner`, every read takes a `businessId`, every
 * refusal is an `AecError` code the API guard maps to a status, and the
 * migration's constraints are the backstop rather than the first line.
 *
 * ## What this service deliberately does NOT do
 *
 * It never records what a project *spent*. Actual cost is Accounting's — read
 * through `journal_entries.project_id` by `projectReport`, exactly as the
 * cockpit and the assistant read it. An approved revision proposes a budget;
 * it never competes with the ledger as a second source of truth (§7's rule and
 * the whole reason the cockpit's financial band reads the ledger).
 *
 * ## The one write that reaches outside the BOQ tables
 *
 * `approveEstimateVersion` writes `ai_projects.budget_rial`, because §7 says an
 * approved estimate "establishes the project working budget". It only does so
 * when that column is empty or still holds the total of the revision being
 * superseded — a figure somebody typed by hand is never overwritten, and the
 * caller is told which of the two happened (`budgetSync`). The project register
 * in Wave 3 already treats `budget_rial` as the budget every screen compares
 * against, so this makes the estimate and the cockpit agree rather than adding
 * a second budget.
 */
import {
  BOQ_MAX_TOTAL_RIAL,
  canTransitionEstimateVersion,
  computeBoqItemTotals,
  ESTIMATE_EVENT_LABELS,
  ESTIMATE_VERSION_STATUS_LABELS,
  isEditableEstimateVersion,
  normalizeBoqUnit,
  type EstimateEventAction,
  type EstimateVersionStatus,
} from "./aec-boq";
import { AecError, AEC_INDUSTRY, assertAecIndustry, loadBusinessAecProfile } from "./aec-service";
import { getBusinessIndustry } from "./industry-guard";
import { query, withTenantTransaction } from "./db";
import { recordActivity, type WorkspaceOwner } from "./workspace";

/* ===========================================================================
 * Coercion
 * ======================================================================== */

function trimTo(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | null {
  const text = trimTo(value, max);
  return text === "" ? null : text;
}

function rialAmount(value: unknown, field: string): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[٬,\s]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new AecError(`invalid_${field}`);
  }
  return parsed;
}

/** The stored form of a decimal the columns size at two places. */
function percentText(value: unknown, field: string): string {
  if (value === null || value === undefined || value === "") return "0";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new AecError(`invalid_${field}`);
  return parsed.toFixed(2);
}

function quantityText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "0";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new AecError("invalid_quantity");
  return parsed.toFixed(4);
}

/* ===========================================================================
 * Shapes
 * ======================================================================== */

export interface BoqVersionSummary {
  id: string;
  versionNo: number;
  title: string;
  status: EstimateVersionStatus;
  statusLabel: string;
  itemCount: number;
  totalRial: number;
  isEditable: boolean;
  submittedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  approvedById: string | null;
  approvedByName: string | null;
  createdByName: string;
  createdAt: string;
}

export interface BoqEstimateSummary {
  id: string;
  projectId: string;
  title: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  versions: BoqVersionSummary[];
  /** The revision a screen should open by default: the draft, else the newest. */
  defaultVersionId: string | null;
}

export interface BoqItem {
  id: string;
  sectionId: string | null;
  displayOrder: number;
  itemCode: string;
  description: string;
  unit: string;
  quantity: string;
  materialRateRial: number;
  laborRateRial: number;
  equipmentRateRial: number;
  subcontractRateRial: number;
  wastePercent: string;
  overheadPercent: string;
  markupPercent: string;
  unitPriceRial: number;
  totalRial: number;
  workPackage: string;
  partyId: string | null;
  partyName: string | null;
  notes: string;
}

export interface BoqSection {
  id: string;
  code: string;
  title: string;
  displayOrder: number;
  notes: string;
  subtotalRial: number;
  items: BoqItem[];
}

export interface BoqVersionTree {
  version: BoqVersionSummary;
  sections: BoqSection[];
  /** Items with no chapter — a flat import before anybody grouped it. */
  unsectionedItems: BoqItem[];
  /** Quantity per unit, the BOQ's own summary line. */
  unitTotals: Array<{ unit: string; quantity: string }>;
  totalRial: number;
}

export interface BoqTree {
  estimate: Omit<BoqEstimateSummary, "versions" | "defaultVersionId">;
  versions: BoqVersionSummary[];
  /** The requested revision, or the estimate's default one. */
  versionTree: BoqVersionTree | null;
  events: BoqEvent[];
}

export interface BoqEvent {
  id: string;
  versionId: string | null;
  action: EstimateEventAction;
  actionLabel: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

/** §30's "BOQ variance": the approved estimate against the ledger's actuals. */
export interface BoqVariance {
  projectId: string;
  projectName: string;
  /** The approved revision's total, in rial. Null = no approved estimate yet. */
  approvedEstimateRial: number | null;
  approvedVersionNo: number | null;
  approvedAt: string | null;
  /** The project register's budget, which an approval keeps in step. */
  budgetRial: number | null;
  /** Actual cost, posted in Accounting — never counted here. */
  spentRial: number;
  /** Estimate minus posted cost. Positive = still to spend, negative = over. */
  remainingRial: number | null;
  /** Sum of the estimate's line totals by chapter, ready for a variance table. */
  bySection: Array<{ title: string; totalRial: number }>;
  /** Revisions in flight: draft/submitted/under_review counts. */
  openVersionCount: number;
  latestVersionNo: number | null;
  latestVersionStatus: EstimateVersionStatus | null;
}

/* ===========================================================================
 * Reading
 * ======================================================================== */

const VERSION_COLUMNS = `
  v.id, v.version_no, v.title, v.status, v.item_count, v.total_rial,
  v.submitted_at, v.reviewed_at, v.approved_at,
  v.approved_by, au.full_name AS approved_by_name,
  v.created_by_name, v.created_at`;

const VERSION_FROM = `
  FROM aec_estimate_versions v
  LEFT JOIN users au ON au.id = v.approved_by`;

type VersionRow = {
  id: string;
  version_no: number;
  title: string;
  status: EstimateVersionStatus;
  item_count: string | number;
  total_rial: string | number;
  submitted_at: string | null;
  reviewed_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  created_by_name: string;
  created_at: string;
};

function toVersionSummary(row: VersionRow): BoqVersionSummary {
  const status = row.status;
  return {
    id: row.id,
    versionNo: Number(row.version_no),
    title: row.title,
    status,
    statusLabel: ESTIMATE_VERSION_STATUS_LABELS[status],
    itemCount: Number(row.item_count ?? 0),
    totalRial: Number(row.total_rial ?? 0),
    isEditable: isEditableEstimateVersion(status),
    // Timestamps cross as the strings PostgreSQL sent: the UI formats them for
    // display (Shamsi via `formatJalali`), and re-parsing them here would only
    // add a second, lossier representation of the same instant.
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    approvedAt: row.approved_at,
    approvedById: row.approved_by,
    approvedByName: row.approved_by_name,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  };
}

type ItemRow = {
  id: string;
  section_id: string | null;
  display_order: number;
  item_code: string;
  description: string;
  unit: string;
  quantity: string;
  material_rate_rial: string | number;
  labor_rate_rial: string | number;
  equipment_rate_rial: string | number;
  subcontract_rate_rial: string | number;
  waste_percent: string;
  overhead_percent: string;
  markup_percent: string;
  unit_price_rial: string | number;
  total_rial: string | number;
  work_package: string;
  party_id: string | null;
  party_name: string | null;
  notes: string;
};

function toItem(row: ItemRow): BoqItem {
  return {
    id: row.id,
    sectionId: row.section_id,
    displayOrder: Number(row.display_order),
    itemCode: row.item_code,
    description: row.description,
    unit: row.unit,
    quantity: row.quantity,
    materialRateRial: Number(row.material_rate_rial ?? 0),
    laborRateRial: Number(row.labor_rate_rial ?? 0),
    equipmentRateRial: Number(row.equipment_rate_rial ?? 0),
    subcontractRateRial: Number(row.subcontract_rate_rial ?? 0),
    wastePercent: row.waste_percent,
    overheadPercent: row.overhead_percent,
    markupPercent: row.markup_percent,
    // Both were computed by the trigger; the service never writes them.
    unitPriceRial: Number(row.unit_price_rial ?? 0),
    totalRial: Number(row.total_rial ?? 0),
    workPackage: row.work_package,
    partyId: row.party_id,
    partyName: row.party_name,
    notes: row.notes,
  };
}

const ITEM_SELECT = `
  SELECT i.id, i.section_id, i.display_order, i.item_code, i.description, i.unit,
         i.quantity::text AS quantity, i.material_rate_rial, i.labor_rate_rial,
         i.equipment_rate_rial, i.subcontract_rate_rial,
         i.waste_percent::text AS waste_percent, i.overhead_percent::text AS overhead_percent,
         i.markup_percent::text AS markup_percent, i.unit_price_rial, i.total_rial,
         i.work_package, i.party_id, party.name AS party_name, i.notes
    FROM aec_boq_items i
    LEFT JOIN parties party ON party.id = i.party_id`;

/**
 * The BOQ is AEC-only, and — this is the wave's second gate — it is gated on
 * the business's own `boq` capability, not merely on its industry: a design
 * office that does not price work is not offered estimates and cannot reach
 * them by URL. The capability is what its presets and its overrides resolve to.
 */
async function assertBoqEnabled(businessId: string): Promise<void> {
  await assertAecIndustry(businessId);
  const profile = await loadBusinessAecProfile(businessId);
  if (!profile.capabilities.includes("boq")) throw new AecError("capability_disabled");
}

export async function listProjectEstimates(
  businessId: string,
  projectId: string,
): Promise<BoqEstimateSummary[]> {
  await assertBoqEnabled(businessId);
  const { rows } = await query<{
    id: string; project_id: string; title: string; note: string;
    created_at: string; updated_at: string;
  }>(
    `SELECT id, project_id, title, note, created_at, updated_at
       FROM aec_estimates
      WHERE business_id = $1 AND project_id = $2
      ORDER BY created_at DESC`,
    [businessId, projectId],
  );
  if (rows.length === 0) return [];

  const { rows: versionRows } = await query<VersionRow & { estimate_id: string }>(
    `SELECT ${VERSION_COLUMNS}, v.estimate_id ${VERSION_FROM}
      WHERE v.business_id = $1 AND v.estimate_id = ANY($2::uuid[])
      ORDER BY v.version_no DESC`,
    [businessId, rows.map((row) => row.id)],
  );

  const byEstimate = new Map<string, BoqVersionSummary[]>();
  for (const row of versionRows) {
    const list = byEstimate.get(row.estimate_id) ?? [];
    list.push(toVersionSummary(row));
    byEstimate.set(row.estimate_id, list);
  }

  return rows.map((row) => {
    const versions = byEstimate.get(row.id) ?? [];
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      versions,
      defaultVersionId: pickDefaultVersion(versions),
    };
  });
}

/** A draft first (that is the revision being worked on), else the newest. */
function pickDefaultVersion(versions: readonly BoqVersionSummary[]): string | null {
  const draft = versions.find((version) => version.isEditable);
  return (draft ?? versions[0])?.id ?? null;
}

export async function loadEstimateTree(
  businessId: string,
  estimateId: string,
  options: { versionId?: string | null } = {},
): Promise<BoqTree> {
  await assertBoqEnabled(businessId);
  const { rows } = await query<{
    id: string; project_id: string; title: string; note: string;
    created_at: string; updated_at: string;
  }>(
    `SELECT id, project_id, title, note, created_at, updated_at
       FROM aec_estimates WHERE business_id = $1 AND id = $2`,
    [businessId, estimateId],
  );
  const estimate = rows[0];
  if (!estimate) throw new AecError("estimate_not_found");

  const { rows: versionRows } = await query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM}
      WHERE v.business_id = $1 AND v.estimate_id = $2
      ORDER BY v.version_no DESC`,
    [businessId, estimateId],
  );
  const versions = versionRows.map(toVersionSummary);
  const wanted = options.versionId
    ? versions.find((version) => version.id === options.versionId) ?? null
    : null;
  if (options.versionId && !wanted) throw new AecError("estimate_version_not_found");
  const chosen = wanted ?? versions.find((version) => version.id === pickDefaultVersion(versions)) ?? null;

  return {
    estimate: {
      id: estimate.id,
      projectId: estimate.project_id,
      title: estimate.title,
      note: estimate.note,
      createdAt: estimate.created_at,
      updatedAt: estimate.updated_at,
    },
    versions,
    versionTree: chosen ? await loadVersionTree(businessId, chosen) : null,
    events: await listEstimateEvents(businessId, estimateId, 20),
  };
}

async function loadVersionTree(
  businessId: string,
  version: BoqVersionSummary,
): Promise<BoqVersionTree> {
  const [{ rows: sectionRows }, { rows: itemRows }] = await Promise.all([
    query<{ id: string; code: string; title: string; display_order: number; notes: string }>(
      `SELECT id, code, title, display_order, notes
         FROM aec_boq_sections
        WHERE business_id = $1 AND version_id = $2
        ORDER BY display_order, created_at`,
      [businessId, version.id],
    ),
    query<ItemRow>(
      `${ITEM_SELECT}
        WHERE i.business_id = $1 AND i.version_id = $2
        ORDER BY i.display_order, i.created_at`,
      [businessId, version.id],
    ),
  ]);

  const items = itemRows.map(toItem);
  const sections: BoqSection[] = sectionRows.map((row) => {
    const own = items.filter((item) => item.sectionId === row.id);
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      displayOrder: Number(row.display_order),
      notes: row.notes,
      subtotalRial: own.reduce((sum, item) => sum + item.totalRial, 0),
      items: own,
    };
  });

  // Quantities add up per unit and NOT across them: 120 m² and 3 tonnes are
  // not one number. This is the summary line a QS reads first.
  const unitQuantities = new Map<string, number>();
  for (const item of items) {
    const unit = item.unit || "—";
    unitQuantities.set(unit, (unitQuantities.get(unit) ?? 0) + Number(item.quantity));
  }

  return {
    version,
    sections,
    unsectionedItems: items.filter((item) => item.sectionId === null),
    unitTotals: [...unitQuantities.entries()].map(([unit, quantity]) => ({
      unit,
      quantity: quantity.toFixed(4),
    })),
    totalRial: items.reduce((sum, item) => sum + item.totalRial, 0),
  };
}

export async function listEstimateEvents(
  businessId: string,
  estimateId: string,
  limit = 20,
): Promise<BoqEvent[]> {
  const { rows } = await query<{
    id: string; version_id: string | null; action: EstimateEventAction;
    summary: string; actor_name: string; created_at: string;
  }>(
    `SELECT id, version_id, action, summary, actor_name, created_at
       FROM aec_estimate_events
      WHERE business_id = $1 AND estimate_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [businessId, estimateId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    versionId: row.version_id,
    action: row.action,
    actionLabel: ESTIMATE_EVENT_LABELS[row.action] ?? row.action,
    summary: row.summary,
    actorName: row.actor_name,
    createdAt: row.created_at,
  }));
}

/* ===========================================================================
 * The estimate itself
 * ======================================================================== */

/** The project an estimate belongs to, refusing a foreign or archived project. */
async function assertProjectOwned(businessId: string, projectId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, projectId],
  );
  if (!rows[0]) throw new AecError("project_not_found");
}

export async function createEstimate(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
): Promise<BoqEstimateSummary> {
  await assertBoqEnabled(owner.businessId);
  await assertProjectOwned(owner.businessId, projectId);
  const title = trimTo(input.title, 200);
  if (!title) throw new AecError("estimate_title_required");

  const { rows } = await query<{ id: string }>(
    `INSERT INTO aec_estimates
       (business_id, project_id, title, note, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [owner.businessId, projectId, title, trimTo(input.note, 2000), owner.actorUserId, owner.actorName ?? ""],
  );
  const estimateId = rows[0].id;

  await recordEstimateEvent(owner, {
    projectId,
    estimateId,
    versionId: null,
    action: "created",
    summary: title,
  });
  // A new estimate arrives with a first draft revision: an estimate with no
  // revision has nowhere to put a line, and asking the user to create "نسخهٔ
  // ۱" before typing anything is a step that exists only because the schema
  // does.
  await createVersionRow(owner, estimateId, { title: "نسخهٔ اول", cloneFrom: null });

  const list = await listProjectEstimates(owner.businessId, projectId);
  const created = list.find((estimate) => estimate.id === estimateId);
  if (!created) throw new AecError("estimate_not_found");
  return created;
}

export async function updateEstimate(
  owner: WorkspaceOwner,
  estimateId: string,
  input: Record<string, unknown>,
): Promise<BoqEstimateSummary> {
  await assertBoqEnabled(owner.businessId);
  const { rows } = await query<{ project_id: string; title: string }>(
    `SELECT project_id, title FROM aec_estimates WHERE business_id = $1 AND id = $2`,
    [owner.businessId, estimateId],
  );
  const estimate = rows[0];
  if (!estimate) throw new AecError("estimate_not_found");

  const title = input.title === undefined ? null : trimTo(input.title, 200);
  if (title !== null && !title) throw new AecError("estimate_title_required");
  await query(
    `UPDATE aec_estimates
        SET title = COALESCE($3, title),
            note = COALESCE($4, note),
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, estimateId, title, input.note === undefined ? null : trimTo(input.note, 2000)],
  );
  await recordEstimateEvent(owner, {
    projectId: estimate.project_id,
    estimateId,
    versionId: null,
    action: "updated",
    summary: title ?? estimate.title,
  });
  const list = await listProjectEstimates(owner.businessId, estimate.project_id);
  const updated = list.find((row) => row.id === estimateId);
  if (!updated) throw new AecError("estimate_not_found");
  return updated;
}

/**
 * Delete an estimate — but never a priced one. A revision that was approved is
 * a historical record (§7), and the ledger may already have been spent against
 * the budget it proposed; deleting its container would take the trail with it.
 */
export async function deleteEstimate(owner: WorkspaceOwner, estimateId: string): Promise<void> {
  await assertBoqEnabled(owner.businessId);
  const { rows } = await query<{ project_id: string; title: string }>(
    `SELECT project_id, title FROM aec_estimates WHERE business_id = $1 AND id = $2`,
    [owner.businessId, estimateId],
  );
  const estimate = rows[0];
  if (!estimate) throw new AecError("estimate_not_found");

  const { rows: approved } = await query<{ id: string }>(
    `SELECT id FROM aec_estimate_versions
      WHERE business_id = $1 AND estimate_id = $2 AND status IN ('approved', 'superseded')
      LIMIT 1`,
    [owner.businessId, estimateId],
  );
  if (approved[0]) throw new AecError("estimate_has_approved_version");

  await recordEstimateEvent(owner, {
    projectId: estimate.project_id,
    estimateId,
    versionId: null,
    action: "deleted",
    summary: estimate.title,
  });
  // The events row is gone with the estimate (ON DELETE CASCADE) — the activity
  // feed is what remembers the deletion, which is the record a colleague needs.
  await recordActivity(owner, {
    projectId: estimate.project_id,
    subjectType: "estimate",
    subjectId: estimateId,
    action: "deleted",
    summary: estimate.title,
  });
  await query(`DELETE FROM aec_estimates WHERE business_id = $1 AND id = $2`, [
    owner.businessId,
    estimateId,
  ]);
}

/* ===========================================================================
 * Versions
 * ======================================================================== */

async function createVersionRow(
  owner: WorkspaceOwner,
  estimateId: string,
  options: { title: string; cloneFrom: string | null },
): Promise<string> {
  return withTenantTransaction(owner.businessId, async () => {
    const { rows: next } = await query<{ next_no: number }>(
      `SELECT COALESCE(max(version_no), 0) + 1 AS next_no
         FROM aec_estimate_versions WHERE business_id = $1 AND estimate_id = $2`,
      [owner.businessId, estimateId],
    );
    const { rows } = await query<{ id: string }>(
      `INSERT INTO aec_estimate_versions
         (business_id, estimate_id, version_no, title, status, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)
       RETURNING id`,
      [
        owner.businessId,
        estimateId,
        Number(next[0]?.next_no ?? 1),
        options.title,
        owner.actorUserId,
        owner.actorName ?? "",
      ],
    );
    const versionId = rows[0].id;

    if (options.cloneFrom) {
      // Copy the sections and their lines, id for id new. `display_order` is
      // carried so the copy reads like the original; the totals are recomputed
      // by the trigger, never copied.
      await query(
        `INSERT INTO aec_boq_sections (business_id, version_id, code, title, display_order, notes)
         SELECT business_id, $3, code, title, display_order, notes
           FROM aec_boq_sections
          WHERE business_id = $1 AND version_id = $2`,
        [owner.businessId, options.cloneFrom, versionId],
      );
      // The section ids changed, so the items are copied by matching each old
      // section to its new one through the display order and title rather than
      // by id.
      await query(
        `INSERT INTO aec_boq_items
           (business_id, version_id, section_id, display_order, item_code, description, unit,
            quantity, material_rate_rial, labor_rate_rial, equipment_rate_rial,
            subcontract_rate_rial, waste_percent, overhead_percent, markup_percent,
            work_package, party_id, notes)
         SELECT i.business_id, $3, ns.id, i.display_order, i.item_code, i.description, i.unit,
                i.quantity, i.material_rate_rial, i.labor_rate_rial, i.equipment_rate_rial,
                i.subcontract_rate_rial, i.waste_percent, i.overhead_percent, i.markup_percent,
                i.work_package, i.party_id, i.notes
           FROM aec_boq_items i
           LEFT JOIN aec_boq_sections os ON os.id = i.section_id
           LEFT JOIN aec_boq_sections ns
                  ON ns.version_id = $3 AND ns.display_order = os.display_order
                 AND ns.title = os.title
          WHERE i.business_id = $1 AND i.version_id = $2`,
        [owner.businessId, options.cloneFrom, versionId],
      );
    }

    return versionId;
  });
}

export async function createEstimateVersion(
  owner: WorkspaceOwner,
  estimateId: string,
  input: Record<string, unknown> = {},
): Promise<BoqVersionSummary> {
  await assertBoqEnabled(owner.businessId);
  const { rows } = await query<{ project_id: string; title: string }>(
    `SELECT project_id, title FROM aec_estimates WHERE business_id = $1 AND id = $2`,
    [owner.businessId, estimateId],
  );
  const estimate = rows[0];
  if (!estimate) throw new AecError("estimate_not_found");

  const cloneFromId = optionalText(input.cloneFromVersionId, 64);
  if (cloneFromId) {
    const { rows: source } = await query<{ id: string; status: EstimateVersionStatus }>(
      `SELECT id, status FROM aec_estimate_versions
        WHERE business_id = $1 AND estimate_id = $2 AND id = $3`,
      [owner.businessId, estimateId, cloneFromId],
    );
    if (!source[0]) throw new AecError("estimate_version_not_found");
  }

  const versionId = await createVersionRow(owner, estimateId, {
    title: trimTo(input.title, 200) || "نسخهٔ جدید",
    cloneFrom: cloneFromId,
  });
  await recordEstimateEvent(owner, {
    projectId: estimate.project_id,
    estimateId,
    versionId,
    action: "version_created",
    summary: cloneFromId ? "رونوشت از نسخهٔ پیشین" : estimate.title,
  });

  const tree = await loadEstimateTree(owner.businessId, estimateId, { versionId });
  return tree.versionTree!.version;
}

/* ===========================================================================
 * Saving a draft
 * ======================================================================== */

interface DraftSectionInput {
  code: string;
  title: string;
  notes: string;
}

interface DraftItemInput {
  sectionIndex: number | null;
  itemCode: string;
  description: string;
  unit: string;
  quantity: string;
  materialRateRial: number;
  laborRateRial: number;
  equipmentRateRial: number;
  subcontractRateRial: number;
  wastePercent: string;
  overheadPercent: string;
  markupPercent: string;
  workPackage: string;
  partyId: string | null;
  notes: string;
}

function parseDraftSections(value: unknown): DraftSectionInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AecError("invalid_boq_section");
  return value.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const title = trimTo(row.title, 200);
    if (!title) throw new AecError("invalid_boq_section");
    return { code: trimTo(row.code, 40), title, notes: trimTo(row.notes, 1000) };
  });
}

function parseDraftItems(value: unknown, sectionCount: number): DraftItemInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AecError("invalid_boq_item");
  return value.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const description = trimTo(row.description, 500);
    if (!description) throw new AecError("invalid_boq_item");
    const sectionIndex =
      row.sectionIndex === null || row.sectionIndex === undefined
        ? null
        : Number(row.sectionIndex);
    if (
      sectionIndex !== null &&
      (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= sectionCount)
    ) {
      throw new AecError("invalid_boq_section");
    }
    return {
      sectionIndex,
      itemCode: trimTo(row.itemCode, 40),
      description,
      unit: normalizeBoqUnit(row.unit),
      quantity: quantityText(row.quantity),
      materialRateRial: rialAmount(row.materialRateRial, "material_rate"),
      laborRateRial: rialAmount(row.laborRateRial, "labor_rate"),
      equipmentRateRial: rialAmount(row.equipmentRateRial, "equipment_rate"),
      subcontractRateRial: rialAmount(row.subcontractRateRial, "subcontract_rate"),
      wastePercent: percentText(row.wastePercent, "waste_percent"),
      overheadPercent: percentText(row.overheadPercent, "overhead_percent"),
      markupPercent: percentText(row.markupPercent, "markup_percent"),
      workPackage: trimTo(row.workPackage, 120),
      partyId: optionalText(row.partyId, 64),
      notes: trimTo(row.notes, 1000),
    };
  });
}

/**
 * Replace a draft revision's chapters and lines in one transaction.
 *
 * The editor saves the whole revision, so this is a replace rather than a
 * hundred per-row calls: the lines are deleted and re-inserted in order, which
 * is what makes a drag-reordered row mean something. It is only ever possible
 * on a draft — migration 0196's trigger refuses it for any other status, so a
 * stale browser tab posting to an approved revision fails instead of rewriting
 * history.
 *
 * The line totals are computed here too (with the same exact-arithmetic mirror
 * the form uses) for two reasons: the caller gets a Persian error about an
 * out-of-range line instead of a constraint violation, and the response's tree
 * is already correct rather than a round trip behind.
 */
export async function saveDraftVersion(
  owner: WorkspaceOwner,
  versionId: string,
  input: Record<string, unknown>,
): Promise<BoqTree> {
  await assertBoqEnabled(owner.businessId);
  const context = await loadVersionContext(owner.businessId, versionId);
  if (!isEditableEstimateVersion(context.status)) throw new AecError("version_not_editable");

  const sections = parseDraftSections(input.sections);
  const items = parseDraftItems(input.items, sections.length);

  for (const item of items) {
    const totals = computeBoqItemTotals(item);
    if (totals.totalRial > BOQ_MAX_TOTAL_RIAL) throw new AecError("boq_total_out_of_range");
    if (item.partyId) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM parties
          WHERE business_id = $1 AND id = $2 AND merged_into_id IS NULL`,
        [owner.businessId, item.partyId],
      );
      if (!rows[0]) throw new AecError("party_not_found");
    }
  }

  await withTenantTransaction(owner.businessId, async () => {
    await query(`DELETE FROM aec_boq_items WHERE business_id = $1 AND version_id = $2`, [
      owner.businessId,
      versionId,
    ]);
    await query(`DELETE FROM aec_boq_sections WHERE business_id = $1 AND version_id = $2`, [
      owner.businessId,
      versionId,
    ]);
    const sectionIds: string[] = [];
    for (const [index, section] of sections.entries()) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO aec_boq_sections (business_id, version_id, code, title, display_order, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [owner.businessId, versionId, section.code, section.title, index, section.notes],
      );
      sectionIds.push(rows[0].id);
    }
    for (const [index, item] of items.entries()) {
      await query(
        `INSERT INTO aec_boq_items
           (business_id, version_id, section_id, display_order, item_code, description, unit,
            quantity, material_rate_rial, labor_rate_rial, equipment_rate_rial,
            subcontract_rate_rial, waste_percent, overhead_percent, markup_percent,
            work_package, party_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12,
                 $13::numeric, $14::numeric, $15::numeric, $16, $17, $18)`,
        [
          owner.businessId,
          versionId,
          item.sectionIndex === null ? null : sectionIds[item.sectionIndex],
          index,
          item.itemCode,
          item.description,
          item.unit,
          item.quantity,
          item.materialRateRial,
          item.laborRateRial,
          item.equipmentRateRial,
          item.subcontractRateRial,
          item.wastePercent,
          item.overheadPercent,
          item.markupPercent,
          item.workPackage,
          item.partyId,
          item.notes,
        ],
      );
    }
  });

  return loadEstimateTree(owner.businessId, context.estimateId, { versionId });
}

/* ===========================================================================
 * The life cycle
 * ======================================================================== */

/**
 * The project an estimate belongs to. The route needs it before it can apply
 * the workspace module's per-project role check — the same two-layer
 * authorization the profile and participant routes use.
 */
export async function estimateProjectId(businessId: string, estimateId: string): Promise<string> {
  const { rows } = await query<{ project_id: string }>(
    `SELECT project_id FROM aec_estimates WHERE business_id = $1 AND id = $2`,
    [businessId, estimateId],
  );
  if (!rows[0]) throw new AecError("estimate_not_found");
  return rows[0].project_id;
}

/** The project and estimate a revision belongs to, for the same reason. */
export async function versionContextProjectId(
  businessId: string,
  versionId: string,
): Promise<{ projectId: string; estimateId: string }> {
  const { rows } = await query<{ project_id: string; estimate_id: string }>(
    `SELECT e.project_id, v.estimate_id
       FROM aec_estimate_versions v
       JOIN aec_estimates e ON e.id = v.estimate_id AND e.business_id = v.business_id
      WHERE v.business_id = $1 AND v.id = $2`,
    [businessId, versionId],
  );
  if (!rows[0]) throw new AecError("estimate_version_not_found");
  return { projectId: rows[0].project_id, estimateId: rows[0].estimate_id };
}

async function loadVersionContext(
  businessId: string,
  versionId: string,
): Promise<{
  versionId: string;
  estimateId: string;
  projectId: string;
  estimateTitle: string;
  projectName: string;
  versionNo: number;
  status: EstimateVersionStatus;
  totalRial: number;
}> {
  const { rows } = await query<{
    version_id: string; estimate_id: string; project_id: string; estimate_title: string;
    project_name: string; version_no: number; status: EstimateVersionStatus; total_rial: string | number;
  }>(
    `SELECT v.id AS version_id, v.estimate_id, e.project_id, e.title AS estimate_title,
            p.name AS project_name, v.version_no, v.status, v.total_rial
       FROM aec_estimate_versions v
       JOIN aec_estimates e ON e.id = v.estimate_id AND e.business_id = v.business_id
       JOIN ai_projects p ON p.id = e.project_id AND p.business_id = e.business_id
      WHERE v.business_id = $1 AND v.id = $2`,
    [businessId, versionId],
  );
  const row = rows[0];
  if (!row) throw new AecError("estimate_version_not_found");
  return {
    versionId: row.version_id,
    estimateId: row.estimate_id,
    projectId: row.project_id,
    estimateTitle: row.estimate_title,
    projectName: row.project_name,
    versionNo: Number(row.version_no),
    status: row.status,
    totalRial: Number(row.total_rial ?? 0),
  };
}

/**
 * Who is doing something. Wider than `WorkspaceOwner` on purpose: an import can
 * run from a schedule, with no user behind it, and its history rows say so
 * rather than inventing an author.
 */
export interface BoqActor {
  businessId: string;
  actorUserId: string | null;
  actorName?: string;
}

async function recordEstimateEvent(
  actor: BoqActor,
  entry: {
    projectId: string;
    estimateId: string;
    versionId: string | null;
    action: EstimateEventAction;
    summary: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO aec_estimate_events
       (business_id, project_id, estimate_id, version_id, action, summary, actor_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor.businessId,
      entry.projectId,
      entry.estimateId,
      entry.versionId,
      entry.action,
      entry.summary.slice(0, 300),
      actor.actorUserId,
      actor.actorName ?? "",
    ],
  );
  // The project's own activity strip needs a user to attribute the row to; an
  // unattended import is recorded in the estimate's history and nowhere else.
  if (actor.actorUserId) {
    await recordActivity(
      { ...actor, actorUserId: actor.actorUserId },
      {
        projectId: entry.projectId,
        subjectType: "estimate",
        subjectId: entry.versionId ?? entry.estimateId,
        action: entry.action,
        summary: entry.summary,
      },
    );
  }
}

function assertTransition(from: EstimateVersionStatus, to: EstimateVersionStatus): void {
  if (!canTransitionEstimateVersion(from, to)) throw new AecError("invalid_estimate_transition");
}

/**
 * Submit a draft for approval.
 *
 * The approval itself is the workspace's own engine — a `workspace_approvals`
 * row of subject type `estimate_version` — rather than a new gate: it means the
 * submission appears in «تأییدها», counts in the dashboard, can be routed to a
 * named approver, and is decided under `workspace.approve`. §24 asks for
 * exactly that: a commercial action must not inherit ordinary task-edit rights.
 */
export async function submitEstimateVersion(
  owner: WorkspaceOwner,
  versionId: string,
  input: Record<string, unknown> = {},
): Promise<BoqVersionSummary> {
  await assertBoqEnabled(owner.businessId);
  const context = await loadVersionContext(owner.businessId, versionId);
  assertTransition(context.status, "submitted");
  if (context.totalRial <= 0) throw new AecError("estimate_empty");

  const approverUserId = optionalText(input.approverUserId, 64);
  const dueDate = optionalText(input.dueDate, 10);
  if (approverUserId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM users WHERE business_id = $1 AND id = $2`,
      [owner.businessId, approverUserId],
    );
    if (!rows[0]) throw new AecError("user_not_found");
  }

  await query(
    `UPDATE aec_estimate_versions
        SET status = 'submitted', submitted_by = $3, submitted_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, versionId, owner.actorUserId],
  );

  const title = `برآورد «${context.estimateTitle}» — نسخهٔ ${context.versionNo}`;
  const { rows: approval } = await query<{ id: string }>(
    `INSERT INTO workspace_approvals
       (business_id, subject_type, subject_id, project_id, title, requested_by,
        approver_user_id, due_date, note)
     VALUES ($1, 'estimate_version', $2, $3, $4, $5, $6, $7::date, $8)
     RETURNING id`,
    [
      owner.businessId,
      versionId,
      context.projectId,
      title,
      owner.actorUserId,
      approverUserId,
      dueDate,
      trimTo(input.note, 1000),
    ],
  );
  await recordEstimateEvent(owner, {
    projectId: context.projectId,
    estimateId: context.estimateId,
    versionId,
    action: "submitted",
    summary: title,
  });
  await recordActivity(owner, {
    projectId: context.projectId,
    subjectType: "approval",
    subjectId: approval[0].id,
    action: "requested",
    summary: title,
  });

  return (await loadVersionSummary(owner.businessId, versionId));
}

async function loadVersionSummary(businessId: string, versionId: string): Promise<BoqVersionSummary> {
  const { rows } = await query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.business_id = $1 AND v.id = $2`,
    [businessId, versionId],
  );
  if (!rows[0]) throw new AecError("estimate_version_not_found");
  return toVersionSummary(rows[0]);
}

/** A reviewer opening a submitted revision: §7's «Under Review» step. */
export async function startEstimateReview(
  owner: WorkspaceOwner,
  versionId: string,
): Promise<BoqVersionSummary> {
  await assertBoqEnabled(owner.businessId);
  const context = await loadVersionContext(owner.businessId, versionId);
  assertTransition(context.status, "under_review");
  await query(
    `UPDATE aec_estimate_versions
        SET status = 'under_review', reviewed_by = $3, reviewed_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, versionId, owner.actorUserId],
  );
  await recordEstimateEvent(owner, {
    projectId: context.projectId,
    estimateId: context.estimateId,
    versionId,
    action: "review_started",
    summary: `${context.estimateTitle} — نسخهٔ ${context.versionNo}`,
  });
  return loadVersionSummary(owner.businessId, versionId);
}

export type BudgetSyncOutcome = "set" | "updated" | "kept_manual" | "already_approved";

/**
 * Approve a revision: §7's "approved estimates establish the project working
 * budget", with the one guard that makes it safe — a hand-entered budget is
 * never overwritten.
 *
 *   * the project's budget is empty             → set it to this total (`set`);
 *   * the budget still equals the total of the  → move it to this total
 *     revision this one supersedes                (`updated`);
 *   * the budget is anything else (typed by a   → leave it alone and say so
 *     person, or from another estimate)           (`kept_manual`).
 */
export async function approveEstimateVersion(
  owner: WorkspaceOwner,
  versionId: string,
  note = "",
): Promise<{ version: BoqVersionSummary; budgetSync: BudgetSyncOutcome; projectBudgetRial: number | null }> {
  await assertBoqEnabled(owner.businessId);
  const context = await loadVersionContext(owner.businessId, versionId);
  assertTransition(context.status, "approved");

  const outcome = await withTenantTransaction(owner.businessId, async () => {
    // Retire whatever this revision replaces, and remember its total so the
    // budget check can tell "the number our own approval wrote" from a figure
    // somebody typed.
    const { rows: previous } = await query<{ id: string; total_rial: string | number }>(
      `UPDATE aec_estimate_versions
          SET status = 'superseded', updated_at = now()
        WHERE business_id = $1 AND estimate_id = $2 AND status = 'approved' AND id <> $3
        RETURNING id, total_rial`,
      [owner.businessId, context.estimateId, versionId],
    );

    await query(
      `UPDATE aec_estimate_versions
          SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, versionId, owner.actorUserId],
    );

    const { rows: project } = await query<{ budget_rial: string | null }>(
      `SELECT budget_rial FROM ai_projects WHERE business_id = $1 AND id = $2`,
      [owner.businessId, context.projectId],
    );
    const current = project[0]?.budget_rial === null || project[0]?.budget_rial === undefined
      ? null
      : Number(project[0].budget_rial);

    let sync: BudgetSyncOutcome;
    let next = current;
    if (current === context.totalRial) {
      sync = "already_approved";
    } else if (current === null) {
      sync = "set";
      next = context.totalRial;
    } else if (previous.some((row) => Number(row.total_rial) === current)) {
      sync = "updated";
      next = context.totalRial;
    } else {
      sync = "kept_manual";
    }
    if (next !== current) {
      await query(
        `UPDATE ai_projects SET budget_rial = $3, updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [owner.businessId, context.projectId, next],
      );
    }

    // The approval the submission filed is decided by this act, whichever route
    // reached it: an approval left pending after its subject was approved would
    // be a second decision waiting to contradict the first.
    await query(
      `UPDATE workspace_approvals
          SET status = 'approved', decided_by = $3, decided_at = now(),
              note = COALESCE(NULLIF($4, ''), note), updated_at = now()
        WHERE business_id = $1 AND subject_type = 'estimate_version' AND subject_id = $2
          AND status = 'pending'`,
      [owner.businessId, versionId, owner.actorUserId, trimTo(note, 1000)],
    );

    await recordEstimateEvent(owner, {
      projectId: context.projectId,
      estimateId: context.estimateId,
      versionId,
      action: "approved",
      summary: `${context.estimateTitle} — نسخهٔ ${context.versionNo}`,
    });
    return { sync, budgetRial: next };
  });

  return {
    version: await loadVersionSummary(owner.businessId, versionId),
    budgetSync: outcome.sync,
    projectBudgetRial: outcome.budgetRial,
  };
}

/** Send a submitted revision back to its author, with the reason recorded. */
export async function returnEstimateVersion(
  owner: WorkspaceOwner,
  versionId: string,
  note = "",
): Promise<BoqVersionSummary> {
  await assertBoqEnabled(owner.businessId);
  const context = await loadVersionContext(owner.businessId, versionId);
  assertTransition(context.status, "draft");
  const reason = trimTo(note, 1000);

  await withTenantTransaction(owner.businessId, async () => {
    await query(
      `UPDATE aec_estimate_versions
          SET status = 'draft', reviewed_by = $3, reviewed_at = now(), updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [owner.businessId, versionId, owner.actorUserId],
    );
    await query(
      `UPDATE workspace_approvals
          SET status = 'rejected', decided_by = $3, decided_at = now(),
              note = COALESCE(NULLIF($4, ''), note), updated_at = now()
        WHERE business_id = $1 AND subject_type = 'estimate_version' AND subject_id = $2
          AND status = 'pending'`,
      [owner.businessId, versionId, owner.actorUserId, reason],
    );
    await recordEstimateEvent(owner, {
      projectId: context.projectId,
      estimateId: context.estimateId,
      versionId,
      action: "returned",
      summary: reason || `${context.estimateTitle} — نسخهٔ ${context.versionNo}`,
    });
  });

  return loadVersionSummary(owner.businessId, versionId);
}

/**
 * Decide a revision through the workspace approval it filed — the path the
 * approvals queue and the notification e-mail take, as opposed to the buttons
 * on the BOQ screen. Both call the same two functions above, so there is one
 * implementation of "approved" and one of "sent back".
 */
export async function decideEstimateApproval(
  owner: WorkspaceOwner,
  approvalId: string,
  decision: "approved" | "rejected" | "cancelled",
  note = "",
): Promise<{ versionId: string | null; applied: boolean }> {
  // Deliberately NOT gated on the `boq` capability, unlike every other entry
  // point here: a request that is already in the queue must be decidable even
  // if the business has since switched estimating off, or the queue would keep
  // an item nobody can ever clear.
  await assertAecIndustry(owner.businessId);
  const { rows } = await query<{ subject_id: string; status: string }>(
    `SELECT subject_id, status FROM workspace_approvals
      WHERE business_id = $1 AND id = $2 AND subject_type = 'estimate_version'`,
    [owner.businessId, approvalId],
  );
  const approval = rows[0];
  if (!approval) throw new AecError("approval_not_found");
  if (approval.status !== "pending") return { versionId: approval.subject_id, applied: false };

  if (decision === "approved") {
    await approveEstimateVersion(owner, approval.subject_id, note);
    return { versionId: approval.subject_id, applied: true };
  }
  if (decision === "rejected") {
    await returnEstimateVersion(owner, approval.subject_id, note);
    return { versionId: approval.subject_id, applied: true };
  }
  // Cancelled: the revision keeps its submitted status and the request simply
  // stops waiting — the author decides whether to resubmit.
  await query(
    `UPDATE workspace_approvals
        SET status = 'cancelled', decided_by = $3, decided_at = now(),
            note = COALESCE(NULLIF($4, ''), note), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [owner.businessId, approvalId, owner.actorUserId, trimTo(note, 1000)],
  );
  return { versionId: approval.subject_id, applied: true };
}

/* ===========================================================================
 * The import path (§7: "support Excel/CSV import through the existing
 * data-transfer engine")
 * ======================================================================== */

export interface BoqImportInput {
  projectName: string;
  estimateTitle: string;
  /** A named revision must be a draft; null means "the current draft". */
  versionNo: number | null;
  sectionCode: string;
  sectionTitle: string | null;
  itemCode: string;
  description: string;
  unit: string;
  quantity: unknown;
  materialRateRial: unknown;
  laborRateRial: unknown;
  equipmentRateRial: unknown;
  subcontractRateRial: unknown;
  wastePercent: unknown;
  overheadPercent: unknown;
  markupPercent: unknown;
  workPackage: string;
  partyId: string | null;
  notes: string;
  duplicateStrategy: "update" | "skip" | "create";
}

export interface BoqImportOutcome {
  status: "created" | "updated" | "skipped";
  id?: string;
  reason?: string;
}

/**
 * One measured row from a spreadsheet, in the revision it belongs to.
 *
 * This is the whole of the BOQ's import support: the engine (parsing, mapping,
 * preview, queue, history, the four file formats) is the existing one, and the
 * only thing this adds is the routing decision a BOQ row needs — which
 * estimate, which revision, which chapter — plus the rule that makes importing
 * safe: a row can only land in a DRAFT revision. Naming an approved one is not
 * an error the operator has to guess at; the row comes back with the reason and
 * the rest of the file still lands.
 */
export async function importBoqItem(
  actor: BoqActor,
  input: BoqImportInput,
): Promise<BoqImportOutcome> {
  // Refused rather than thrown: an import row that cannot be placed is a row
  // the operator needs to see a reason for, not a failed file.
  if ((await getBusinessIndustry(actor.businessId)) !== AEC_INDUSTRY) {
    return { status: "skipped", reason: "متره و برآورد فقط برای کسب‌وکارهای عمرانی و پیمانکاری است." };
  }
  const profile = await loadBusinessAecProfile(actor.businessId);
  if (!profile.capabilities.includes("boq")) {
    return {
      status: "skipped",
      reason: "قابلیت متره و برآورد برای این کسب‌وکار روشن نیست.",
    };
  }

  const projectName = input.projectName.trim();
  const { rows: projects } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM ai_projects
      WHERE business_id = $1 AND archived_at IS NULL
        AND lower(btrim(name)) = lower(btrim($2))
      ORDER BY created_at DESC LIMIT 1`,
    [actor.businessId, projectName],
  );
  const project = projects[0];
  if (!project) return { status: "skipped", reason: `پروژهٔ «${projectName}» پیدا نشد.` };

  const estimateTitle = input.estimateTitle.trim() || "برآورد اصلی";
  const { rows: estimates } = await query<{ id: string }>(
    `SELECT id FROM aec_estimates
      WHERE business_id = $1 AND project_id = $2 AND lower(btrim(title)) = lower(btrim($3))
      ORDER BY created_at LIMIT 1`,
    [actor.businessId, project.id, estimateTitle],
  );
  let estimateId = estimates[0]?.id ?? null;
  if (!estimateId) {
    const { rows: created } = await query<{ id: string }>(
      `INSERT INTO aec_estimates (business_id, project_id, title, note, created_by, created_by_name)
       VALUES ($1, $2, $3, 'از ورود فایل ساخته شد', $4, $5) RETURNING id`,
      [actor.businessId, project.id, estimateTitle, actor.actorUserId, actor.actorName ?? ""],
    );
    estimateId = created[0].id;
    await recordEstimateEvent(actor, {
      projectId: project.id,
      estimateId,
      versionId: null,
      action: "created",
      summary: estimateTitle,
    });
  }

  let versionId: string;
  if (input.versionNo !== null) {
    const { rows } = await query<{ id: string; status: EstimateVersionStatus }>(
      `SELECT id, status FROM aec_estimate_versions
        WHERE business_id = $1 AND estimate_id = $2 AND version_no = $3`,
      [actor.businessId, estimateId, input.versionNo],
    );
    const version = rows[0];
    if (!version) {
      return { status: "skipped", reason: `نسخهٔ ${input.versionNo} این برآورد پیدا نشد.` };
    }
    if (!isEditableEstimateVersion(version.status)) {
      return {
        status: "skipped",
        reason: `نسخهٔ ${input.versionNo} در وضعیت «${ESTIMATE_VERSION_STATUS_LABELS[version.status]}» است و قابل تغییر نیست.`,
      };
    }
    versionId = version.id;
  } else {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM aec_estimate_versions
        WHERE business_id = $1 AND estimate_id = $2 AND status = 'draft'
        ORDER BY version_no DESC LIMIT 1`,
      [actor.businessId, estimateId],
    );
    if (rows[0]) versionId = rows[0].id;
    else {
      const { rows: created } = await query<{ id: string }>(
        `INSERT INTO aec_estimate_versions
           (business_id, estimate_id, version_no, title, status, created_by, created_by_name)
         VALUES ($1, $2,
                 (SELECT COALESCE(max(version_no), 0) + 1 FROM aec_estimate_versions
                   WHERE business_id = $1 AND estimate_id = $2),
                 'ورود از فایل', 'draft', $3, $4)
         RETURNING id`,
        [actor.businessId, estimateId, actor.actorUserId, actor.actorName ?? ""],
      );
      versionId = created[0].id;
      await recordEstimateEvent(actor, {
        projectId: project.id,
        estimateId,
        versionId,
        action: "version_created",
        summary: "ورود از فایل",
      });
    }
  }

  let sectionId: string | null = null;
  const sectionTitle = input.sectionTitle?.trim() ?? "";
  if (sectionTitle) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM aec_boq_sections
        WHERE business_id = $1 AND version_id = $2 AND lower(btrim(title)) = lower(btrim($3))
        ORDER BY display_order LIMIT 1`,
      [actor.businessId, versionId, sectionTitle],
    );
    if (rows[0]) sectionId = rows[0].id;
    else {
      const { rows: created } = await query<{ id: string }>(
        `INSERT INTO aec_boq_sections (business_id, version_id, code, title, display_order)
         VALUES ($1, $2, $3, $4,
                 (SELECT COALESCE(max(display_order), -1) + 1 FROM aec_boq_sections
                   WHERE business_id = $1 AND version_id = $2))
         RETURNING id`,
        [actor.businessId, versionId, input.sectionCode.trim(), sectionTitle],
      );
      sectionId = created[0].id;
    }
  }

  const quantity = quantityText(input.quantity);
  const rates = {
    materialRateRial: rialAmount(input.materialRateRial, "material_rate"),
    laborRateRial: rialAmount(input.laborRateRial, "labor_rate"),
    equipmentRateRial: rialAmount(input.equipmentRateRial, "equipment_rate"),
    subcontractRateRial: rialAmount(input.subcontractRateRial, "subcontract_rate"),
    wastePercent: percentText(input.wastePercent, "waste_percent"),
    overheadPercent: percentText(input.overheadPercent, "overhead_percent"),
    markupPercent: percentText(input.markupPercent, "markup_percent"),
  };
  const totals = computeBoqItemTotals({ quantity, ...rates });
  if (totals.totalRial > BOQ_MAX_TOTAL_RIAL) {
    return { status: "skipped", reason: "جمع ردیف از بازهٔ قابل پشتیبانی بزرگ‌تر است." };
  }

  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM aec_boq_items
      WHERE business_id = $1 AND version_id = $2
        AND lower(btrim(item_code)) = lower(btrim($3))
        AND lower(btrim(description)) = lower(btrim($4))
      LIMIT 1`,
    [actor.businessId, versionId, input.itemCode, input.description],
  );
  const match = existing[0];
  if (match && input.duplicateStrategy === "skip") {
    return { status: "skipped", id: match.id, reason: `ردیف «${input.description}» از پیش هست.` };
  }
  if (match && input.duplicateStrategy === "update") {
    await query(
      `UPDATE aec_boq_items
          SET section_id = $3, item_code = $4, description = $5, unit = $6, quantity = $7::numeric,
              material_rate_rial = $8, labor_rate_rial = $9, equipment_rate_rial = $10,
              subcontract_rate_rial = $11, waste_percent = $12::numeric,
              overhead_percent = $13::numeric, markup_percent = $14::numeric,
              work_package = $15, party_id = $16, notes = $17, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        actor.businessId, match.id, sectionId, input.itemCode.trim(), input.description.trim(),
        normalizeBoqUnit(input.unit), quantity, rates.materialRateRial, rates.laborRateRial,
        rates.equipmentRateRial, rates.subcontractRateRial, rates.wastePercent,
        rates.overheadPercent, rates.markupPercent, input.workPackage.trim(), input.partyId,
        input.notes.trim(),
      ],
    );
    return { status: "updated", id: match.id };
  }

  const { rows: inserted } = await query<{ id: string }>(
    `INSERT INTO aec_boq_items
       (business_id, version_id, section_id, display_order, item_code, description, unit, quantity,
        material_rate_rial, labor_rate_rial, equipment_rate_rial, subcontract_rate_rial,
        waste_percent, overhead_percent, markup_percent, work_package, party_id, notes)
     VALUES ($1, $2, $3,
             (SELECT COALESCE(max(display_order), -1) + 1 FROM aec_boq_items
               WHERE business_id = $1 AND version_id = $2),
             $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12::numeric, $13::numeric,
             $14::numeric, $15, $16, $17)
     RETURNING id`,
    [
      actor.businessId, versionId, sectionId, input.itemCode.trim(), input.description.trim(),
      normalizeBoqUnit(input.unit), quantity, rates.materialRateRial, rates.laborRateRial,
      rates.equipmentRateRial, rates.subcontractRateRial, rates.wastePercent,
      rates.overheadPercent, rates.markupPercent, input.workPackage.trim(), input.partyId,
      input.notes.trim(),
    ],
  );
  return { status: "created", id: inserted[0].id };
}

/* ===========================================================================
 * §30's BOQ variance
 * ======================================================================== */

/**
 * What the estimate says against what the ledger holds, for one project.
 *
 * The numbers that represent posted financial facts (spent) come from
 * Accounting's `projectReport`; nothing here recomputes them, which is the
 * issue's rule for AI and reporting alike.
 */
export async function boqVariance(
  businessId: string,
  projectId: string,
): Promise<BoqVariance | null> {
  await assertBoqEnabled(businessId);
  const { rows: projectRows } = await query<{ id: string; name: string; budget_rial: string | null }>(
    `SELECT p.id, p.name, p.budget_rial
       FROM ai_projects p
      WHERE p.business_id = $1 AND p.id = $2 AND p.archived_at IS NULL`,
    [businessId, projectId],
  );
  const project = projectRows[0];
  if (!project) return null;

  const { rows: versions } = await query<{
    id: string; version_no: number; status: EstimateVersionStatus; total_rial: string | number;
    approved_at: string | null;
  }>(
    `SELECT v.id, v.version_no, v.status, v.total_rial, v.approved_at
       FROM aec_estimate_versions v
       JOIN aec_estimates e ON e.id = v.estimate_id
      WHERE v.business_id = $1 AND e.project_id = $2
      ORDER BY v.version_no DESC`,
    [businessId, projectId],
  );

  const approved = versions.find((row) => row.status === "approved") ?? null;
  const bySection: Array<{ title: string; totalRial: number }> = [];
  if (approved) {
    const { rows } = await query<{ title: string; total_rial: string | number }>(
      `SELECT COALESCE(NULLIF(s.title, ''), 'بدون فصل') AS title,
              COALESCE(sum(i.total_rial), 0) AS total_rial
         FROM aec_boq_items i
         LEFT JOIN aec_boq_sections s ON s.id = i.section_id
        WHERE i.business_id = $1 AND i.version_id = $2
        GROUP BY 1
        ORDER BY 1`,
      [businessId, approved.id],
    );
    for (const row of rows) bySection.push({ title: row.title, totalRial: Number(row.total_rial) });
  }

  const spentRow = await query<{ spent: string }>(
    `SELECT COALESCE(sum(jl.debit), 0) AS spent
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.business_id = $1 AND je.project_id = $2`,
    [businessId, projectId],
  );
  const spentRial = Number(spentRow.rows[0]?.spent ?? 0);
  const approvedTotal = approved ? Number(approved.total_rial) : null;

  return {
    projectId: project.id,
    projectName: project.name,
    approvedEstimateRial: approvedTotal,
    approvedVersionNo: approved ? Number(approved.version_no) : null,
    approvedAt: approved?.approved_at ?? null,
    budgetRial: project.budget_rial === null ? null : Number(project.budget_rial),
    spentRial,
    remainingRial: approvedTotal === null ? null : approvedTotal - spentRial,
    bySection,
    openVersionCount: versions.filter((row) => row.status !== "approved" && row.status !== "superseded").length,
    latestVersionNo: versions[0] ? Number(versions[0].version_no) : null,
    latestVersionStatus: versions[0]?.status ?? null,
  };
}

/**
 * The approved total per project, for the workspace roll-up and the assistant.
 * One query, no by-section detail: this is the number a caller wants when the
 * question is "what did we price this at".
 */
export async function approvedEstimateTotals(
  businessId: string,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const { rows } = await query<{ project_id: string; total_rial: string | number }>(
    `SELECT e.project_id, v.total_rial
       FROM aec_estimate_versions v
       JOIN aec_estimates e ON e.id = v.estimate_id
      WHERE v.business_id = $1 AND v.status = 'approved' AND e.project_id = ANY($2::uuid[])`,
    [businessId, [...projectIds]],
  );
  return new Map(rows.map((row) => [row.project_id, Number(row.total_rial)]));
}
