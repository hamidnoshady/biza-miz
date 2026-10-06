/**
 * Phase 32 — the database half of the AI coworker.
 *
 * Reads the jobs an owner defined, watches for what should start them, builds
 * each firing's actions through the pure template builders, and either applies
 * them (Phase 31's executors, unchanged) or leaves them in the approval inbox.
 *
 * Three properties this file is responsible for, and which the rest of the
 * feature assumes:
 *
 *   * **Idempotency.** Every firing claims `ai_coworker_runs (job_id,
 *     dedupe_key)` first. Two ticks racing, or one tick retried, produce one
 *     run — which for a job that writes off stock is not a nicety.
 *   * **Facts come from here, decisions from `ai-coworker.ts`.** A builder is
 *     handed values read out of the database at fire time and cannot reach for
 *     anything else, so what a job does is a function of what was true.
 *   * **No new mutation path.** Applying an approved action goes through
 *     `AUTOPILOT_EXECUTORS`, which call the same service functions the route
 *     handlers call, and writes the same `ai_action_audit` row a chat apply
 *     writes — tagged `source = 'coworker'`.
 *
 * Everything here runs inside an ambient tenant scope (a request's
 * `withTenantScope`, or the tick's `withTenant`), so RLS is the boundary.
 */
import { ACTION_CATALOG, type ActionType, type ProposedAction } from "./ai";
import { createAiActionAudit } from "./ai-action-audit";
import { projectExistsForBusiness } from "./ai-projects";
import {
  clampAutopilotSetting,
  type AutopilotCategory,
  type AutopilotCategorySetting,
} from "./ai-autopilot";
import { AUTOPILOT_EXECUTORS, executorTargetLocation } from "./ai-autopilot-executors";
import { isDeferrableDenial, verifyUnattendedAuthority } from "./ai-unattended-authority";
import { autopilotAmountContext } from "./ai-amount-context";
import {
  dedupeKeyForEvent,
  dedupeKeyForManual,
  eventMatchesJob,
  planCoworkerActions,
  runStatusFromActions,
  scheduleDedupeKeyIfDue,
  summarizeRun,
  validateJobInput,
  type CoworkerActionStatus,
  type CoworkerApprovalMode,
  type CoworkerEventKind,
  type CoworkerJobInput,
  type CoworkerRunStatus,
  type CoworkerTriggerKind,
} from "./ai-coworker";
import {
  buildCoworkerActions,
  COWORKER_TEMPLATES,
  isCoworkerTemplateKey,
  validateTemplateParams,
  type CoworkerFactKind,
  type CoworkerFacts,
  type CoworkerTemplateKey,
  type InventoryOnHandFact,
  type LowStockFact,
  type ProductionFormulaFact,
} from "./ai-coworker-templates";
import { compactProactiveFacts, type LocalBusinessClock } from "./ai-proactive";
import { runAccountingReview } from "./accounting-review-service";
import { query } from "./db";
import { recordCoworkerEvent } from "./ai-coworker-events";
import { isFeatureEnabled } from "./features";
// Phase 35 — a job that fires at 02:00 and then waits for approval is the
// clearest case in the product of something the owner cannot be expected to
// discover on their own. Enqueued, never sent inline: the tick in
// notifications-service.ts is what talks to a push service.
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { isModuleEnabled } from "./industry-guard";
import type { ModuleKey } from "./industry-profile";

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface CoworkerJob {
  id: string;
  businessId: string;
  locationId: string | null;
  projectId: string | null;
  templateKey: CoworkerTemplateKey;
  title: string;
  triggerKind: CoworkerTriggerKind;
  eventKind: CoworkerEventKind | null;
  scheduleHour: number | null;
  scheduleWeekday: number | null;
  params: Record<string, unknown>;
  approvalMode: CoworkerApprovalMode;
  enabled: boolean;
  authorizedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  project_id: string | null;
  template_key: string;
  title: string;
  trigger_kind: string;
  event_kind: string | null;
  schedule_hour: number | null;
  schedule_weekday: number | null;
  params: Record<string, unknown>;
  approval_mode: string;
  enabled: boolean;
  authorized_by: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

function toJob(row: JobRow): CoworkerJob {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    projectId: row.project_id,
    templateKey: row.template_key as CoworkerTemplateKey,
    title: row.title,
    triggerKind: row.trigger_kind as CoworkerTriggerKind,
    eventKind: row.event_kind as CoworkerEventKind | null,
    scheduleHour: row.schedule_hour,
    scheduleWeekday: row.schedule_weekday,
    params: row.params ?? {},
    approvalMode: row.approval_mode as CoworkerApprovalMode,
    enabled: row.enabled,
    authorizedBy: row.authorized_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
  };
}

const JOB_COLUMNS = `id, business_id, location_id, project_id, template_key, title, trigger_kind, event_kind,
                     schedule_hour, schedule_weekday, params, approval_mode, enabled, authorized_by,
                     created_at::text AS created_at, updated_at::text AS updated_at,
                     last_run_at::text AS last_run_at`;

export async function listCoworkerJobs(businessId: string): Promise<CoworkerJob[]> {
  const { rows } = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ai_coworker_jobs WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map(toJob);
}

export async function getCoworkerJob(businessId: string, id: string): Promise<CoworkerJob | null> {
  const { rows } = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ai_coworker_jobs WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export type CoworkerJobResult = { ok: true; job: CoworkerJob } | { ok: false; errors: string[] };

/**
 * Validates in three layers — job shape, template existence, template params —
 * so a bad request comes back naming the thing that was actually wrong.
 */
async function validateForTemplate(
  businessId: string,
  input: Partial<CoworkerJobInput>,
): Promise<string[]> {
  const errors = validateJobInput(input);
  if (!isCoworkerTemplateKey(input.templateKey)) {
    return errors.includes("coworker_template_required") ? errors : [...errors, "coworker_template_unknown"];
  }
  const template = COWORKER_TEMPLATES[input.templateKey];
  if (input.triggerKind && !template.triggers.includes(input.triggerKind)) {
    errors.push("coworker_trigger_unsupported");
  }
  if (template.key === "customer_event_message" && !["customer_birthday", "customer_inactive_3_months", "order_ready"].includes(input.eventKind ?? "")) {
    errors.push("coworker_event_required");
  }
  // The same gate the API guard applies: a module the trade does not have is
  // refused, not merely hidden — see CLAUDE.md's industry-module note.
  if (!(await isModuleEnabled(businessId, template.module as ModuleKey))) {
    errors.push("coworker_module_unavailable");
  }
  // A project label, if given, must name a real project of THIS business. RLS
  // would already stop a cross-tenant read; this turns a made-up or foreign id
  // into a clear error rather than a silently-null label.
  if (input.projectId && !(await projectExistsForBusiness(businessId, input.projectId))) {
    errors.push("coworker_project_not_found");
  }
  errors.push(...validateTemplateParams(input.templateKey, input.params ?? {}));
  return Array.from(new Set(errors));
}

export async function createCoworkerJob(
  businessId: string,
  input: Partial<CoworkerJobInput>,
  actorUserId: string,
): Promise<CoworkerJobResult> {
  const errors = await validateForTemplate(businessId, input);
  if (errors.length > 0) return { ok: false, errors };

  const { rows } = await query<JobRow>(
    `INSERT INTO ai_coworker_jobs
       (business_id, location_id, project_id, template_key, title, trigger_kind, event_kind, schedule_hour,
        schedule_weekday, params, approval_mode, enabled, created_by, authorized_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $13)
     RETURNING ${JOB_COLUMNS}`,
    [
      businessId,
      input.locationId ?? null,
      input.projectId ?? null,
      input.templateKey,
      input.title!.trim().slice(0, 120),
      input.triggerKind,
      input.triggerKind === "event" ? input.eventKind : null,
      input.triggerKind === "schedule" ? input.scheduleHour : null,
      input.triggerKind === "schedule" ? input.scheduleWeekday ?? null : null,
      JSON.stringify(input.params ?? {}),
      input.approvalMode ?? "ask",
      input.enabled ?? true,
      // The human whose authority an unattended apply runs under. Recorded at
      // creation so an automated write is never anonymous, exactly as
      // ai_autopilot_settings.authorized_by is.
      actorUserId,
    ],
  );
  return { ok: true, job: toJob(rows[0]) };
}

export async function updateCoworkerJob(
  businessId: string,
  id: string,
  input: Partial<CoworkerJobInput>,
  actorUserId: string,
): Promise<CoworkerJobResult> {
  const existing = await getCoworkerJob(businessId, id);
  if (!existing) return { ok: false, errors: ["coworker_job_not_found"] };

  const merged: Partial<CoworkerJobInput> = {
    templateKey: existing.templateKey,
    title: input.title ?? existing.title,
    locationId: input.locationId !== undefined ? input.locationId : existing.locationId,
    projectId: input.projectId !== undefined ? input.projectId : existing.projectId,
    triggerKind: input.triggerKind ?? existing.triggerKind,
    eventKind: input.eventKind !== undefined ? input.eventKind : existing.eventKind,
    scheduleHour: input.scheduleHour !== undefined ? input.scheduleHour : existing.scheduleHour,
    scheduleWeekday: input.scheduleWeekday !== undefined ? input.scheduleWeekday : existing.scheduleWeekday,
    params: input.params ?? existing.params,
    approvalMode: input.approvalMode ?? existing.approvalMode,
    enabled: input.enabled ?? existing.enabled,
  };
  // A trigger kind change must clear the other kind's fields or the table's
  // own shape constraint rejects the row.
  if (merged.triggerKind !== "event") merged.eventKind = null;
  if (merged.triggerKind !== "schedule") {
    merged.scheduleHour = null;
    merged.scheduleWeekday = null;
  }

  const errors = await validateForTemplate(businessId, merged);
  if (errors.length > 0) return { ok: false, errors };

  const { rows } = await query<JobRow>(
    `UPDATE ai_coworker_jobs
        SET location_id = $3, project_id = $4, title = $5, trigger_kind = $6, event_kind = $7, schedule_hour = $8,
            schedule_weekday = $9, params = $10::jsonb, approval_mode = $11, enabled = $12,
            authorized_by = $13, updated_at = now()
      WHERE business_id = $1 AND id = $2
      RETURNING ${JOB_COLUMNS}`,
    [
      businessId,
      id,
      merged.locationId ?? null,
      merged.projectId ?? null,
      merged.title!.trim().slice(0, 120),
      merged.triggerKind,
      merged.eventKind,
      merged.scheduleHour,
      merged.scheduleWeekday,
      JSON.stringify(merged.params ?? {}),
      merged.approvalMode,
      merged.enabled,
      // Re-stamped on every edit: whoever last changed the job is whose
      // authority its unattended writes now run under.
      actorUserId,
    ],
  );
  return { ok: true, job: toJob(rows[0]) };
}

export async function deleteCoworkerJob(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM ai_coworker_jobs WHERE business_id = $1 AND id = $2`, [
    businessId,
    id,
  ]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Re-exported so callers of this service have one import for the whole feature. */
export { recordCoworkerEvent };

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface CoworkerRunAction {
  id: string;
  seq: number;
  actionType: ActionType;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  status: CoworkerActionStatus;
  /** Why this one was held rather than applied. Null when it was applied. */
  heldReason: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

export interface CoworkerRun {
  id: string;
  jobId: string;
  jobTitle: string;
  templateKey: CoworkerTemplateKey;
  locationId: string | null;
  triggerSource: string;
  status: CoworkerRunStatus;
  summary: string;
  facts: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  actions: CoworkerRunAction[];
}

const RUN_COLUMNS = `r.id, r.job_id, r.location_id, r.trigger_source, r.status, r.summary,
                     r.facts, r.error, r.created_at::text AS created_at,
                     r.decided_at::text AS decided_at, r.decided_by,
                     j.title AS job_title, j.template_key`;

interface RunRow extends Record<string, unknown> {
  id: string;
  job_id: string;
  location_id: string | null;
  trigger_source: string;
  status: string;
  summary: string;
  facts: Record<string, unknown>;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  job_title: string;
  template_key: string;
}

interface ActionRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  seq: number;
  action_type: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  status: string;
  error: string | null;
  result: Record<string, unknown> | null;
}

/**
 * A held action's reason lives in the `error` column while it is still
 * pending: the column means "what stopped this from being applied", and a
 * cap it exceeded is exactly that. Once applied, it holds a real failure.
 */
function toAction(row: ActionRow): CoworkerRunAction {
  const pending = row.status === "pending";
  return {
    id: row.id,
    seq: row.seq,
    actionType: row.action_type as ActionType,
    title: row.title,
    summary: row.summary,
    payload: row.payload ?? {},
    status: row.status as CoworkerActionStatus,
    heldReason: pending ? row.error : null,
    error: pending ? null : row.error,
    result: row.result,
  };
}

function toRun(row: RunRow, actions: ActionRow[]): CoworkerRun {
  return {
    id: row.id,
    jobId: row.job_id,
    jobTitle: row.job_title,
    templateKey: row.template_key as CoworkerTemplateKey,
    locationId: row.location_id,
    triggerSource: row.trigger_source,
    status: row.status as CoworkerRunStatus,
    summary: row.summary,
    facts: row.facts ?? {},
    error: row.error,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    actions: actions.filter((action) => action.run_id === row.id).map(toAction),
  };
}

export async function listCoworkerRuns(
  businessId: string,
  options: { status?: CoworkerRunStatus; limit?: number } = {},
): Promise<CoworkerRun[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM ai_coworker_runs r JOIN ai_coworker_jobs j ON j.id = r.job_id
      WHERE r.business_id = $1 AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.created_at DESC
      LIMIT ${limit}`,
    [businessId, options.status ?? null],
  );
  if (rows.length === 0) return [];
  const { rows: actions } = await query<ActionRow>(
    `SELECT id, run_id, seq, action_type, title, summary, payload, status, error, result
       FROM ai_coworker_run_actions
      WHERE business_id = $1 AND run_id = ANY($2::uuid[])
      ORDER BY seq`,
    [businessId, rows.map((row) => row.id)],
  );
  return rows.map((row) => toRun(row, actions));
}

export async function getCoworkerRun(businessId: string, runId: string): Promise<CoworkerRun | null> {
  const { rows } = await query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM ai_coworker_runs r JOIN ai_coworker_jobs j ON j.id = r.job_id
      WHERE r.business_id = $1 AND r.id = $2`,
    [businessId, runId],
  );
  if (!rows[0]) return null;
  const { rows: actions } = await query<ActionRow>(
    `SELECT id, run_id, seq, action_type, title, summary, payload, status, error, result
       FROM ai_coworker_run_actions WHERE business_id = $1 AND run_id = $2 ORDER BY seq`,
    [businessId, runId],
  );
  return toRun(rows[0], actions);
}

export async function countPendingCoworkerRuns(businessId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ai_coworker_runs
      WHERE business_id = $1 AND status = 'pending_approval'`,
    [businessId],
  );
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

async function loadFacts(
  businessId: string,
  locationId: string | null,
  kinds: readonly CoworkerFactKind[],
): Promise<CoworkerFacts> {
  const facts: CoworkerFacts = {};

  if (kinds.includes("inventory_on_hand") && locationId) {
    // On hand comes from the append-only stock ledger, which is the only place
    // it lives — `inventory_items` carries cost and settings, never a quantity.
    const { rows } = await query<{ id: string; name: string; unit: string; quantity: string; unit_cost: string }>(
      `SELECT i.id, i.name, i.unit,
              trim_scale(COALESCE(sm.total, 0))::text AS quantity,
              COALESCE(i.avg_cost, 0)::text AS unit_cost
         FROM inventory_items i
         LEFT JOIN LATERAL (
           SELECT sum(quantity) AS total FROM stock_movements WHERE inventory_item_id = i.id
         ) sm ON true
        WHERE i.location_id = $1 AND i.is_active`,
      [locationId],
    );
    const onHand: Record<string, InventoryOnHandFact> = {};
    for (const row of rows) {
      onHand[row.id] = {
        id: row.id,
        name: row.name,
        unit: row.unit,
        onHandQty: row.quantity,
        unitCostRial: Number(row.unit_cost),
      };
    }
    facts.onHand = onHand;
  }

  if (kinds.includes("production_formulas") && locationId) {
    const { rows } = await query<{
      id: string;
      name: string;
      output_name: string;
      is_active: boolean;
      batch_cost: string;
    }>(
      `SELECT f.id, f.name, oi.name AS output_name, f.is_active,
              COALESCE(sum(fi.quantity * COALESCE(ii.avg_cost, 0)), 0)::text AS batch_cost
         FROM production_formulas f
         JOIN inventory_items oi ON oi.id = f.output_inventory_item_id
         LEFT JOIN production_formula_inputs fi ON fi.formula_id = f.id
         LEFT JOIN inventory_items ii ON ii.id = fi.inventory_item_id
        WHERE f.location_id = $1
        GROUP BY f.id, f.name, oi.name, f.is_active`,
      [locationId],
    );
    const formulas: Record<string, ProductionFormulaFact> = {};
    for (const row of rows) {
      formulas[row.id] = {
        id: row.id,
        name: row.name,
        outputItemName: row.output_name,
        isActive: row.is_active,
        batchCostRial: Number(row.batch_cost),
      };
    }
    facts.formulas = formulas;
  }

  if (kinds.includes("low_stock") && locationId) {
    const { rows } = await query<{
      id: string;
      name: string;
      unit: string;
      quantity: string;
      reorder_level: string;
      purchase_qty: string;
      total_cost: string;
      supplier_id: string | null;
    }>(
      // The suggested order takes the item back to twice its reorder level,
      // priced at what it last actually cost, and the last supplier who
      // delivered it — all read here, so the builder invents no number and no
      // relationship of its own. Quantities are converted into the item's
      // PURCHASE unit, which is the unit createDraftPurchase expects.
      `SELECT i.id, i.name, i.unit,
              trim_scale(COALESCE(sm.total, 0))::text AS quantity,
              trim_scale(i.reorder_level)::text AS reorder_level,
              trim_scale(GREATEST(
                (i.reorder_level * 2 - COALESCE(sm.total, 0)) / i.purchase_unit_factor, 1
              ))::text AS purchase_qty,
              (GREATEST(
                (i.reorder_level * 2 - COALESCE(sm.total, 0)) / i.purchase_unit_factor, 1
              ) * i.purchase_unit_factor * COALESCE(i.avg_cost, 0))::bigint::text AS total_cost,
              last_supplier.supplier_id
         FROM inventory_items i
         LEFT JOIN LATERAL (
           SELECT sum(quantity) AS total FROM stock_movements WHERE inventory_item_id = i.id
         ) sm ON true
         LEFT JOIN LATERAL (
           SELECT p.supplier_id
             FROM purchase_items pi
             JOIN purchases p ON p.id = pi.purchase_id
            WHERE pi.inventory_item_id = i.id AND p.supplier_id IS NOT NULL
            ORDER BY p.created_at DESC
            LIMIT 1
         ) last_supplier ON true
        WHERE i.location_id = $1 AND i.is_active
          AND i.reorder_level IS NOT NULL AND i.reorder_level > 0
          AND COALESCE(sm.total, 0) <= i.reorder_level
        ORDER BY i.name
        LIMIT 40`,
      [locationId],
    );
    facts.lowStock = rows.map(
      (row): LowStockFact => ({
        id: row.id,
        name: row.name,
        unit: row.unit,
        onHandQty: row.quantity,
        reorderLevel: row.reorder_level,
        suggestedPurchaseQty: row.purchase_qty,
        suggestedTotalCostRial: Number(row.total_cost),
        supplierId: row.supplier_id,
      }),
    );
  }

  if (kinds.includes("accounting_review")) {
    const review = await runAccountingReview(businessId);
    facts.review = review.findings;
    facts.reviewUnavailableChecks = review.unavailableChecks;
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

async function autopilotSettings(businessId: string): Promise<Record<AutopilotCategory, AutopilotCategorySetting>> {
  const { rows } = await query<{
    category: AutopilotCategory;
    enabled: boolean;
    max_amount_rial: string | null;
    max_percent: number | null;
    max_items_per_run: number;
    daily_action_limit: number;
  }>(
    `SELECT category, enabled, max_amount_rial::text AS max_amount_rial, max_percent,
            max_items_per_run, daily_action_limit
       FROM ai_autopilot_settings WHERE business_id = $1`,
    [businessId],
  );
  const map = {} as Record<AutopilotCategory, AutopilotCategorySetting>;
  for (const row of rows) {
    // Clamped on read as well as on write, so lowering a ceiling in a later
    // release narrows every stored setting with no data migration.
    map[row.category] = clampAutopilotSetting(row.category, {
      enabled: row.enabled,
      maxAmountRial: row.max_amount_rial === null ? null : Number(row.max_amount_rial),
      maxPercent: row.max_percent,
      maxItemsPerRun: row.max_items_per_run,
      dailyActionLimit: row.daily_action_limit,
    });
  }
  return map;
}

async function appliedTodayInCategory(businessId: string, category: AutopilotCategory): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ai_action_audit
      WHERE business_id = $1 AND source IN ('autopilot', 'coworker') AND autopilot_category = $2
        AND status IN ('applied', 'reverted')
        AND created_at >= now() - interval '24 hours'`,
    [businessId, category],
  );
  return Number(rows[0]?.count ?? 0);
}

interface ApplyOutcome {
  status: CoworkerActionStatus;
  auditId: string;
  error?: string;
  result?: Record<string, unknown>;
}

/**
 * Runs one action through Phase 31's executor and records it in the same audit
 * trail a chat apply writes — tagged `source = 'coworker'` so the hub's history
 * shows all three ways a change can have been authorised in one list.
 */
async function applyAction(input: {
  businessId: string;
  jobTitle: string;
  action: ProposedAction;
  authorizedBy: string | null;
  authorizedByName: string;
}): Promise<ApplyOutcome> {
  const meta = ACTION_CATALOG[input.action.type];
  const auditId = await createAiActionAudit({
    businessId: input.businessId,
    actorUserId: input.authorizedBy ?? "coworker",
    actorName: `همکار هوشمند (مجوز: ${input.authorizedByName})`,
    prompt: `کار «${input.jobTitle}»`,
    proposal: input.action,
  });
  await query(
    `UPDATE ai_action_audit SET source = 'coworker', autopilot_category = $3
      WHERE id = $1 AND business_id = $2`,
    [auditId, input.businessId, meta.autopilotCategory ?? null],
  );

  const executor = meta.executor ? AUTOPILOT_EXECUTORS[meta.executor] : null;
  if (!executor) {
    await query(
      `UPDATE ai_action_audit SET status = 'failed', result = $3::jsonb WHERE id = $1 AND business_id = $2`,
      [auditId, input.businessId, JSON.stringify({ error: "coworker_executor_missing" })],
    );
    return { status: "failed", auditId, error: "coworker_executor_missing" };
  }

  // Issue #812 §13 — the same central authority gate the autopilot path uses.
  // A coworker job's `authorized_by` is revocable delegation, so the member's
  // CURRENT role, permission overrides, business status, branch scope and the
  // canonical action permission are resolved immediately before the write.
  const authority = await verifyUnattendedAuthority({
    businessId: input.businessId,
    authorizedByUserId: input.authorizedBy,
    actionType: input.action.type,
    targetLocationId: await executorTargetLocation(meta.executor, input.action.payload),
  });
  if (!authority.ok) {
    // A revocable denial leaves the row 'proposed' so a human can still apply
    // it with their own session; a job that never had an authorizer fails.
    if (isDeferrableDenial(authority)) {
      await query(
        `UPDATE ai_action_audit SET deferred_reason = $3 WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
        [auditId, input.businessId, authority.reasonCode],
      );
    }
    return {
      status: "failed",
      auditId,
      error: authority.reasonCode ?? "authority_denied",
    };
  }

  const result = await executor({
    businessId: input.businessId,
    authorizedByUserId: authority.userId,
    payload: input.action.payload,
  });

  await query(
    `UPDATE ai_action_audit
        SET status = $3, result = $4::jsonb, prior_state = $5::jsonb,
            applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
    [
      auditId,
      input.businessId,
      result.ok ? "applied" : "failed",
      JSON.stringify(compactProactiveFacts(result.result)),
      result.priorState === undefined ? null : JSON.stringify(compactProactiveFacts(result.priorState)),
    ],
  );

  return result.ok
    ? { status: "applied", auditId, result: result.result }
    : { status: "failed", auditId, error: result.errorCode ?? "execution_failed" };
}

async function userName(businessId: string, userId: string | null): Promise<string> {
  if (!userId) return "نامشخص";
  const { rows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  return rows[0]?.full_name?.trim() || "نامشخص";
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/**
 * Claims `(job_id, dedupe_key)`. A second caller for the same key gets null and
 * does nothing — which is the whole idempotency story, enforced by the UNIQUE
 * index rather than by a read-then-write this file would have to get right.
 */
async function claimRun(input: {
  businessId: string;
  jobId: string;
  locationId: string | null;
  triggerSource: CoworkerTriggerKind;
  dedupeKey: string;
}): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_coworker_runs (business_id, job_id, location_id, trigger_source, dedupe_key, status)
     VALUES ($1, $2, $3, $4, $5, 'pending_approval')
     ON CONFLICT (job_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [input.businessId, input.jobId, input.locationId, input.triggerSource, input.dedupeKey],
  );
  return rows[0]?.id ?? null;
}

/**
 * One firing: load the facts, build the actions, decide per action whether it
 * may write unattended, apply the ones that may, and leave the rest pending.
 *
 * Returns the run id, or null when the claim was already taken.
 */
export async function fireCoworkerJob(input: {
  businessId: string;
  job: CoworkerJob;
  locationId: string | null;
  triggerSource: CoworkerTriggerKind;
  dedupeKey: string;
  /** Durable event payload; only the matching customer-event template reads it. */
  eventPayload?: Record<string, unknown>;
}): Promise<string | null> {
  const { businessId, job, locationId, triggerSource, dedupeKey } = input;
  const template = COWORKER_TEMPLATES[job.templateKey];
  if (!template) return null;

  const runId = await claimRun({ businessId, jobId: job.id, locationId, triggerSource, dedupeKey });
  if (!runId) return null;

  try {
    const facts = await loadFacts(businessId, locationId, template.facts);
    if (template.key === "customer_event_message") {
      const customerId = input.eventPayload?.customerId;
      const eventKind = input.eventPayload?.eventKind;
      if (typeof customerId === "string" && (eventKind === "customer_birthday" || eventKind === "customer_inactive_3_months" || eventKind === "order_ready")) {
        facts.triggerCustomer = {
          customerId, eventKind,
          ...(typeof input.eventPayload?.orderId === "string" ? { orderId: input.eventPayload.orderId } : {}),
        };
      }
    }
    const built = buildCoworkerActions(job.templateKey, job.params, facts);

    // A run that legitimately had nothing to do is `skipped`, not `failed`, and
    // says so in the owner's own language.
    if (built.actions.length === 0) {
      await query(
        `UPDATE ai_coworker_runs
            SET status = $3, summary = $4, facts = $5::jsonb
          WHERE id = $1 AND business_id = $2`,
        [
          runId,
          businessId,
          built.report ? "reported" : "skipped",
          built.report
            ? `${job.title}: ${built.report.findings.length} مورد برای بررسی پیدا شد.`
            : summarizeRun({ jobTitle: job.title, statuses: [], skipReason: built.skipReason }),
          JSON.stringify(compactProactiveFacts(built.report ?? { skipReason: built.skipReason ?? null })),
        ],
      );
      // A report is worth telling someone about; "nothing to do" is not — a job
      // that correctly finds no stale bread on 300 nights must not produce 300
      // notifications, or the one night it does find something is lost in them.
      if (built.report) {
        await recordNotification({
          businessId,
          locationId,
          eventKey: "ai.coworker.reported",
          severity: "info",
          title: `${job.title}: گزارش آماده است`,
          body: `${built.report.findings.length} مورد برای بررسی پیدا شد.`,
          url: "/dashboard",
          dedupeKey: notificationDedupeKey("ai.coworker.reported", runId),
          payload: { runId, jobId: job.id, findings: built.report.findings.length },
        });
      }
      await touchJob(businessId, job.id);
      return runId;
    }

    const settings = await autopilotSettings(businessId);
    const appliedCounts = new Map<AutopilotCategory, number>();
    for (const category of new Set(
      built.actions
        .map((action) => ACTION_CATALOG[action.type]?.autopilotCategory)
        .filter((category): category is AutopilotCategory => Boolean(category)),
    )) {
      appliedCounts.set(category, await appliedTodayInCategory(businessId, category));
    }

    const contexts = new Map<number, Awaited<ReturnType<typeof autopilotAmountContext>>>();
    for (const [index, action] of built.actions.entries()) {
      contexts.set(index, await autopilotAmountContext(businessId, action));
    }

    const plans = planCoworkerActions({
      approvalMode: job.approvalMode,
      hasAuthorizer: Boolean(job.authorizedBy),
      actions: built.actions,
      settingFor: (type) => {
        const category = ACTION_CATALOG[type]?.autopilotCategory;
        return category ? settings[category] ?? null : null;
      },
      appliedTodayInCategory: (type) => {
        const category = ACTION_CATALOG[type]?.autopilotCategory;
        return category ? appliedCounts.get(category) ?? 0 : 0;
      },
      contextFor: (action) => contexts.get(built.actions.indexOf(action)) ?? {},
    });

    const authorizedByName = await userName(businessId, job.authorizedBy);
    const statuses: CoworkerActionStatus[] = [];

    for (const [index, plan] of plans.entries()) {
      const meta = ACTION_CATALOG[plan.action.type];
      let status: CoworkerActionStatus = "pending";
      let error: string | null = null;
      let auditId: string | null = null;
      let result: Record<string, unknown> | null = null;

      if (plan.decision.decision === "auto_apply") {
        const outcome = await applyAction({
          businessId,
          jobTitle: job.title,
          action: plan.action,
          authorizedBy: job.authorizedBy,
          authorizedByName,
        });
        status = outcome.status;
        error = outcome.error ?? null;
        auditId = outcome.auditId;
        result = outcome.result ?? null;
        if (status === "applied" && meta.autopilotCategory) {
          // Keep the daily counter honest within one run: five write-offs in
          // one night must consume five of the day's allowance, not one.
          appliedCounts.set(meta.autopilotCategory, (appliedCounts.get(meta.autopilotCategory) ?? 0) + 1);
        }
      } else {
        error = plan.decision.reasonFa;
      }

      await query(
        `INSERT INTO ai_coworker_run_actions
           (business_id, run_id, seq, action_type, title, summary, payload, status, audit_id, result, error, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11,
                 CASE WHEN $8 = 'applied' THEN now() ELSE NULL END)`,
        [
          businessId,
          runId,
          index,
          plan.action.type,
          plan.action.title.slice(0, 500),
          plan.action.summary.slice(0, 2_000),
          JSON.stringify(plan.action.payload),
          status,
          auditId,
          result === null ? null : JSON.stringify(compactProactiveFacts(result)),
          error,
        ],
      );
      statuses.push(status);
    }

    const runStatus = runStatusFromActions(statuses);
    const summary = summarizeRun({ jobTitle: job.title, statuses });
    await query(
      `UPDATE ai_coworker_runs SET status = $3, summary = $4, facts = $5::jsonb
        WHERE id = $1 AND business_id = $2`,
      [
        runId,
        businessId,
        runStatus,
        summary,
        JSON.stringify(compactProactiveFacts({ locationId, triggerSource })),
      ],
    );

    // Only the outcomes that need a person. An `applied` run did exactly what
    // the owner pre-approved and is already in the audit tab; notifying about
    // it would be the product telling them what they told it to do.
    if (runStatus === "pending_approval") {
      await recordNotification({
        businessId,
        locationId,
        eventKey: "ai.coworker.pending",
        severity: "important",
        title: `${job.title}: در انتظار تأیید شما`,
        body: summary,
        url: "/dashboard",
        dedupeKey: notificationDedupeKey("ai.coworker.pending", runId),
        payload: { runId, jobId: job.id, actions: statuses.length },
      });
    } else if (runStatus === "failed" || runStatus === "partially_applied") {
      await recordNotification({
        businessId,
        locationId,
        eventKey: "ai.coworker.failed",
        severity: "important",
        title: `${job.title}: اجرا کامل نشد`,
        body: summary,
        url: "/dashboard",
        dedupeKey: notificationDedupeKey("ai.coworker.failed", runId),
        payload: { runId, jobId: job.id },
      });
    }
    await touchJob(businessId, job.id);
    return runId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Logged as well as stored: the run row is what the owner sees, but a
    // failure in a background tick is otherwise invisible to an operator.
    console.error(`coworker job ${job.id} failed:`, message);
    await query(
      `UPDATE ai_coworker_runs SET status = 'failed', error = $3, summary = $4
        WHERE id = $1 AND business_id = $2`,
      [runId, businessId, message.slice(0, 500), `${job.title}: اجرای این کار ناموفق بود.`],
    );
    // A standing instruction that has quietly stopped working is worth more
    // urgency than one that merely needs approving: the owner believes it ran.
    await recordNotification({
      businessId,
      locationId,
      eventKey: "ai.coworker.failed",
      severity: "important",
      title: `${job.title}: اجرای این کار ناموفق بود`,
      body: message.slice(0, 200),
      url: "/dashboard",
      dedupeKey: notificationDedupeKey("ai.coworker.failed", runId),
      payload: { runId, jobId: job.id },
    });
    return runId;
  }
}

async function touchJob(businessId: string, jobId: string): Promise<void> {
  await query(`UPDATE ai_coworker_jobs SET last_run_at = now() WHERE business_id = $1 AND id = $2`, [
    businessId,
    jobId,
  ]);
}

/**
 * Produce the two calendar-driven customer events only while an owner has an
 * eligible event job. The stable source key makes an hourly tick idempotent:
 * birthday is once per customer/local date; inactivity is once per customer's
 * last completed purchase date, until they buy again.
 */
async function enqueueLifecycleCustomerEvents(
  businessId: string,
  clock: LocalBusinessClock,
  wanted: ReadonlySet<CoworkerEventKind>,
): Promise<void> {
  if (wanted.has("customer_birthday")) {
    const [year, month, day] = clock.dateKey.split("-").map(Number);
    if (year && month && day) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM parties
          WHERE business_id = $1 AND role = 'customer' AND is_active AND merged_into_id IS NULL
            AND birthday IS NOT NULL AND EXTRACT(MONTH FROM birthday) = $2 AND EXTRACT(DAY FROM birthday) = $3
          LIMIT 500`, [businessId, month, day],
      );
      for (const customer of rows) await recordCoworkerEvent({
        businessId, locationId: null, kind: "customer_birthday", payload: { customerId: customer.id },
        dedupeKey: `birthday:${customer.id}:${clock.dateKey}`,
      });
    }
  }
  if (wanted.has("customer_inactive_3_months")) {
    const { rows } = await query<{ id: string; last_purchase_date: string }>(
      `SELECT p.id, max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))::text AS last_purchase_date
         FROM parties p
         JOIN orders o ON o.customer_id = p.id AND o.status = 'completed' AND o.closed_at IS NOT NULL
         JOIN locations l ON l.id = o.location_id
        WHERE p.business_id = $1 AND p.role = 'customer' AND p.is_active AND p.merged_into_id IS NULL
        GROUP BY p.id
       HAVING max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) <= ($2::date - interval '3 months')::date
        LIMIT 500`, [businessId, clock.dateKey],
    );
    for (const customer of rows) await recordCoworkerEvent({
      businessId, locationId: null, kind: "customer_inactive_3_months", payload: { customerId: customer.id },
      dedupeKey: `inactive-3m:${customer.id}:${customer.last_purchase_date}`,
    });
  }
}

async function activeLocationIds(businessId: string): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at`,
    [businessId],
  );
  return rows.map((row) => row.id);
}

/** Fires one job by hand, from the dashboard's "run now" or the public API. */
export async function runCoworkerJobNow(
  businessId: string,
  jobId: string,
  now = new Date(),
): Promise<{ ok: true; runIds: string[] } | { ok: false; error: string }> {
  const job = await getCoworkerJob(businessId, jobId);
  if (!job) return { ok: false, error: "coworker_job_not_found" };
  const template = COWORKER_TEMPLATES[job.templateKey];

  const locations =
    template.scope === "business" ? [null] : job.locationId ? [job.locationId] : await activeLocationIds(businessId);

  const runIds: string[] = [];
  for (const locationId of locations) {
    // A manual run always gets a fresh key, so "run it again now" is never
    // swallowed by the idempotency that protects the automatic path.
    const runId = await fireCoworkerJob({
      businessId,
      job,
      locationId,
      triggerSource: "manual",
      dedupeKey: `${dedupeKeyForManual(now)}:${locationId ?? "business"}`,
    });
    if (runId) runIds.push(runId);
  }
  return { ok: true, runIds };
}

/**
 * One business's coworker work for this tick: every queued event, then every
 * scheduled job that has come due today.
 *
 * Gated on the `ai_assistant` entitlement alone — NOT on
 * `ai_proactive_settings.enabled`, which is the credit opt-in. A job's actions
 * are built by a pure template with no provider call, so it spends nothing.
 */
export async function runCoworkerTick(
  businessId: string,
  clock: LocalBusinessClock,
): Promise<number> {
  if (!(await isFeatureEnabled(businessId, "ai_assistant"))) return 0;

  const jobs = await listCoworkerJobs(businessId);
  if (jobs.length === 0) {
    await markEventsProcessed(businessId);
    return 0;
  }

  let fired = 0;
  const eventJobs = jobs.filter((job) => job.enabled && job.triggerKind === "event");
  const lifecycleKinds = new Set(eventJobs
    .filter((job) => job.templateKey === "customer_event_message" && job.eventKind !== null)
    .map((job) => job.eventKind!));
  await enqueueLifecycleCustomerEvents(businessId, clock, lifecycleKinds);

  if (eventJobs.length > 0) {
    const { rows: events } = await query<{ id: string; location_id: string | null; kind: string; payload: Record<string, unknown> }>(
      `SELECT id, location_id, kind, payload FROM ai_coworker_events
        WHERE business_id = $1 AND processed_at IS NULL
        ORDER BY occurred_at
        LIMIT 100`,
      [businessId],
    );
    for (const event of events) {
      for (const job of eventJobs) {
        if (!eventMatchesJob(job, { kind: event.kind as CoworkerEventKind, locationId: event.location_id })) {
          continue;
        }
        const template = COWORKER_TEMPLATES[job.templateKey];
        const runId = await fireCoworkerJob({
          businessId,
          job,
          locationId: template.scope === "business" ? null : event.location_id,
          triggerSource: "event",
          dedupeKey: dedupeKeyForEvent(event.id),
          eventPayload: { ...(event.payload ?? {}), eventKind: event.kind },
        });
        if (runId) fired += 1;
      }
    }
  }

  // Events are marked processed whether or not a job wanted them, and only
  // after the loop, so a crash mid-loop replays them rather than losing them —
  // the run claim is what stops a replay from acting twice.
  await markEventsProcessed(businessId);

  const scheduledJobs = jobs.filter((job) => job.enabled && job.triggerKind === "schedule");
  if (scheduledJobs.length > 0) {
    const locations = await activeLocationIds(businessId);
    for (const job of scheduledJobs) {
      const baseKey = scheduleDedupeKeyIfDue(job, clock);
      if (!baseKey) continue;
      const template = COWORKER_TEMPLATES[job.templateKey];
      const targets =
        template.scope === "business" ? [null] : job.locationId ? [job.locationId] : locations;
      for (const locationId of targets) {
        const runId = await fireCoworkerJob({
          businessId,
          job,
          locationId,
          triggerSource: "schedule",
          dedupeKey: `${baseKey}:${locationId ?? "business"}`,
        });
        if (runId) fired += 1;
      }
    }
  }

  return fired;
}

async function markEventsProcessed(businessId: string): Promise<void> {
  await query(
    `UPDATE ai_coworker_events SET processed_at = now()
      WHERE business_id = $1 AND processed_at IS NULL`,
    [businessId],
  );
  // Keep the queue from growing without bound; a processed event has already
  // produced its run, which is the durable record.
  await query(
    `DELETE FROM ai_coworker_events
      WHERE business_id = $1 AND processed_at < now() - interval '30 days'`,
    [businessId],
  );
}

// ---------------------------------------------------------------------------
// Approving
// ---------------------------------------------------------------------------

export type CoworkerDecision = "approve" | "reject";

export type DecideRunResult =
  | { ok: true; run: CoworkerRun }
  | { ok: false; error: string };

/**
 * The owner's answer to an inbox card.
 *
 * Approving applies exactly the actions still pending, through the identical
 * executor path an auto-applied one took — that equivalence is what lets an
 * over-cap proposal be *held* rather than dropped: nothing about it changes
 * except who said yes.
 */
export async function decideCoworkerRun(input: {
  businessId: string;
  runId: string;
  decision: CoworkerDecision;
  actorUserId: string;
}): Promise<DecideRunResult> {
  const run = await getCoworkerRun(input.businessId, input.runId);
  if (!run) return { ok: false, error: "coworker_run_not_found" };
  if (run.status !== "pending_approval") return { ok: false, error: "coworker_run_already_decided" };

  const pending = run.actions.filter((action) => action.status === "pending");
  const actorName = await userName(input.businessId, input.actorUserId);

  if (input.decision === "reject") {
    // The hold reason is cleared with the decision: `error` means "what stopped
    // this from being applied", and once a human has said no, the answer is
    // that they said no — not the cap it happened to be over.
    await query(
      `UPDATE ai_coworker_run_actions SET status = 'rejected', error = NULL
        WHERE business_id = $1 AND run_id = $2 AND status = 'pending'`,
      [input.businessId, input.runId],
    );
  } else {
    for (const action of pending) {
      const outcome = await applyAction({
        businessId: input.businessId,
        jobTitle: run.jobTitle,
        action: {
          type: action.actionType,
          title: action.title,
          summary: action.summary,
          payload: action.payload,
        },
        // The approving human's own authority, not the job's standing one —
        // they are the one saying yes to this specific write.
        authorizedBy: input.actorUserId,
        authorizedByName: actorName,
      });
      await query(
        `UPDATE ai_coworker_run_actions
            SET status = $3, audit_id = $4, result = $5::jsonb, error = $6,
                applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE NULL END
          WHERE business_id = $1 AND id = $2`,
        [
          input.businessId,
          action.id,
          outcome.status,
          outcome.auditId,
          outcome.result === undefined ? null : JSON.stringify(compactProactiveFacts(outcome.result)),
          outcome.error ?? null,
        ],
      );
    }
  }

  const { rows: statusRows } = await query<{ status: string }>(
    `SELECT status FROM ai_coworker_run_actions WHERE business_id = $1 AND run_id = $2 ORDER BY seq`,
    [input.businessId, input.runId],
  );
  const statuses = statusRows.map((row) => row.status as CoworkerActionStatus);

  await query(
    `UPDATE ai_coworker_runs
        SET status = $3, summary = $4, decided_at = now(), decided_by = $5
      WHERE business_id = $1 AND id = $2`,
    [
      input.businessId,
      input.runId,
      input.decision === "reject" ? "rejected" : runStatusFromActions(statuses),
      summarizeRun({ jobTitle: run.jobTitle, statuses }),
      actorName.slice(0, 200),
    ],
  );

  const updated = await getCoworkerRun(input.businessId, input.runId);
  return updated ? { ok: true, run: updated } : { ok: false, error: "coworker_run_not_found" };
}
