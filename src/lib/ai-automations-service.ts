/**
 * Phase D (unified entity model) — persistence and fact-gathering for the
 * Automation engine.
 *
 * The database half of `ai-automations.ts`: CRUD over `ai_automations`
 * (migration 0155), plus `gatherAutomationFacts` — the deterministic read of
 * the run-time facts a condition document is evaluated against — and
 * `previewAutomation`, a dry run that reports whether an automation's
 * conditions currently hold and what it would propose, WITHOUT proposing
 * anything. No provider call, no mutation path: an automation is configuration,
 * and firing it (later) reuses the same guarded executor the chat does.
 */
import { query } from "./db";
import { projectExistsForBusiness } from "./ai-projects";
import {
  localBusinessClock,
  DEFAULT_PROACTIVE_TIMEZONE,
  compactProactiveFacts,
  type LocalBusinessClock,
} from "./ai-proactive";
import { getArAging } from "./ar-service";
import { getApAging } from "./ap-service";
import {
  evaluateConditions,
  validateAutomation,
  type AutomationConditionDoc,
  type AutomationFacts,
  type AutomationInput,
  type AutomationApprovalMode,
  type AutomationEventKind,
  type AutomationTriggerKind,
} from "./ai-automations";
import { ACTION_CATALOG, type ActionType, type ProposedAction } from "./ai";
import { aiActionServiceGate } from "./ai-service-activation";
import {
  evaluateUnattendedAction,
  type AutopilotCategory,
} from "./ai-autopilot";
import { AUTOPILOT_EXECUTORS } from "./ai-autopilot-executors";
import { autopilotAmountContext } from "./ai-amount-context";
import { getAutopilotSettings } from "./ai-autopilot-service";
import { createAiActionAudit } from "./ai-action-audit";
import { dedupeKeyForEvent, dedupeKeyForManual, scheduleDedupeKeyIfDue } from "./ai-coworker";
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { isFeatureEnabled } from "./features";

export interface Automation {
  id: string;
  businessId: string;
  locationId: string | null;
  projectId: string | null;
  name: string;
  triggerKind: AutomationTriggerKind;
  eventKind: AutomationEventKind | null;
  scheduleHour: number | null;
  scheduleWeekday: number | null;
  conditions: AutomationConditionDoc;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
  approvalMode: AutomationApprovalMode;
  enabled: boolean;
  createdBy: string | null;
  authorizedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

interface AutomationRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  project_id: string | null;
  name: string;
  trigger_kind: string;
  event_kind: string | null;
  schedule_hour: number | null;
  schedule_weekday: number | null;
  conditions: AutomationConditionDoc;
  action_type: string;
  action_payload: Record<string, unknown>;
  approval_mode: string;
  enabled: boolean;
  created_by: string | null;
  authorized_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
}

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    projectId: row.project_id,
    name: row.name,
    triggerKind: row.trigger_kind as AutomationTriggerKind,
    eventKind: row.event_kind as AutomationEventKind | null,
    scheduleHour: row.schedule_hour,
    scheduleWeekday: row.schedule_weekday,
    conditions: row.conditions ?? {},
    actionType: row.action_type as ActionType,
    actionPayload: row.action_payload ?? {},
    approvalMode: row.approval_mode as AutomationApprovalMode,
    enabled: row.enabled,
    createdBy: row.created_by,
    authorizedBy: row.authorized_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
  };
}

const COLUMNS =
  "id, business_id, location_id, project_id, name, trigger_kind, event_kind, schedule_hour, schedule_weekday, conditions, action_type, action_payload, approval_mode, enabled, created_by, authorized_by, created_at, updated_at, last_run_at";

export type AutomationResult =
  | { ok: true; automation: Automation }
  | { ok: false; errors: string[] };

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

export async function listAutomations(businessId: string): Promise<Automation[]> {
  const { rows } = await query<AutomationRow>(
    `SELECT ${COLUMNS} FROM ai_automations WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map(toAutomation);
}

export async function getAutomation(businessId: string, id: string): Promise<Automation | null> {
  const { rows } = await query<AutomationRow>(
    `SELECT ${COLUMNS} FROM ai_automations WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toAutomation(rows[0]) : null;
}

/**
 * `authorizedBy` is the human whose authority an unattended (`auto`) apply runs
 * under. The route sets it to the acting owner's id for an `auto` automation
 * and refuses `auto` without an owner, mirroring the coworker and autopilot.
 */
export async function createAutomation(
  businessId: string,
  input: AutomationInput,
  actor: { userId: string | null; authorizedBy: string | null },
): Promise<AutomationResult> {
  const validation = validateAutomation(input);
  if (!validation.ok) return validation;
  const v = validation.value;

  // A project label, if given, must name a real project of THIS business.
  if (v.projectId && !(await projectExistsForBusiness(businessId, v.projectId))) {
    return { ok: false, errors: ["project_not_found"] };
  }

  try {
    const { rows } = await query<AutomationRow>(
      `INSERT INTO ai_automations
         (business_id, location_id, project_id, name, trigger_kind, event_kind, schedule_hour, schedule_weekday,
          conditions, action_type, action_payload, approval_mode, enabled, created_by, authorized_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15)
       RETURNING ${COLUMNS}`,
      [
        businessId,
        v.locationId,
        v.projectId,
        v.name,
        v.triggerKind,
        v.eventKind,
        v.scheduleHour,
        v.scheduleWeekday,
        JSON.stringify(v.conditions),
        v.actionType,
        JSON.stringify(v.actionPayload),
        v.approvalMode,
        v.enabled,
        actor.userId,
        v.approvalMode === "auto" ? actor.authorizedBy : null,
      ],
    );
    return { ok: true, automation: toAutomation(rows[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: ["name_taken"] };
    throw error;
  }
}

export async function updateAutomation(
  businessId: string,
  id: string,
  input: AutomationInput,
  actor: { authorizedBy: string | null },
): Promise<AutomationResult> {
  const validation = validateAutomation(input);
  if (!validation.ok) return validation;
  const v = validation.value;

  // A project label, if given, must name a real project of THIS business.
  if (v.projectId && !(await projectExistsForBusiness(businessId, v.projectId))) {
    return { ok: false, errors: ["project_not_found"] };
  }

  try {
    const { rows } = await query<AutomationRow>(
      `UPDATE ai_automations
          SET location_id = $3,
              project_id = $4,
              name = $5,
              trigger_kind = $6,
              event_kind = $7,
              schedule_hour = $8,
              schedule_weekday = $9,
              conditions = $10::jsonb,
              action_type = $11,
              action_payload = $12::jsonb,
              approval_mode = $13,
              enabled = $14,
              authorized_by = $15,
              updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [
        businessId,
        id,
        v.locationId,
        v.projectId,
        v.name,
        v.triggerKind,
        v.eventKind,
        v.scheduleHour,
        v.scheduleWeekday,
        JSON.stringify(v.conditions),
        v.actionType,
        JSON.stringify(v.actionPayload),
        v.approvalMode,
        v.enabled,
        v.approvalMode === "auto" ? actor.authorizedBy : null,
      ],
    );
    if (!rows[0]) return { ok: false, errors: ["not_found"] };
    return { ok: true, automation: toAutomation(rows[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: ["name_taken"] };
    throw error;
  }
}

export async function deleteAutomation(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM ai_automations WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Facts + preview
// ---------------------------------------------------------------------------

async function businessTimezone(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string | null }>(
    `SELECT timezone FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.timezone || DEFAULT_PROACTIVE_TIMEZONE;
}

async function stockValuationTotalRial(businessId: string): Promise<number> {
  const { rows } = await query<{ total: string | null }>(
    `SELECT COALESCE(SUM(valuation), 0)::text AS total
       FROM v_inventory_valuation WHERE business_id = $1`,
    [businessId],
  );
  return Math.trunc(Number(rows[0]?.total ?? 0));
}

/**
 * Read the run-time facts a condition document is tested against. Every value
 * is a deterministic read of an existing report at call time — the same numbers
 * the chat's read tools would return — so an automation's decision is
 * reproducible and never depends on a stored, stale figure.
 */
export async function gatherAutomationFacts(
  businessId: string,
  now: Date = new Date(),
): Promise<AutomationFacts> {
  const [ar, ap, stock, timezone] = await Promise.all([
    getArAging(businessId),
    getApAging(businessId),
    stockValuationTotalRial(businessId),
    businessTimezone(businessId),
  ]);
  const clock = localBusinessClock(now, timezone);
  return {
    receivableTotalRial: Math.trunc(ar.totals.total),
    payableTotalRial: Math.trunc(ap.totals.total),
    stockValuationRial: stock,
    weekday: clock.weekday,
    hour: clock.hour,
  };
}

export interface AutomationPreview {
  facts: AutomationFacts;
  conditionsMet: boolean;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
}

/**
 * A dry run: gather the current facts, evaluate the automation's conditions and
 * report whether it WOULD propose its action right now — without proposing
 * anything. This is how the editor answers "would this fire today?".
 */
export async function previewAutomation(
  businessId: string,
  id: string,
  now: Date = new Date(),
): Promise<AutomationPreview | null> {
  const automation = await getAutomation(businessId, id);
  if (!automation) return null;
  const facts = await gatherAutomationFacts(businessId, now);
  return {
    facts,
    conditionsMet: evaluateConditions(automation.conditions, facts),
    actionType: automation.actionType,
    actionPayload: automation.actionPayload,
  };
}

// ---------------------------------------------------------------------------
// Firing — turning a stored automation into a proposal on the same guarded path
// ---------------------------------------------------------------------------
//
// An automation is configuration; firing it must open NO new mutation surface.
// So firing reuses, without exception, the machinery the coworker and autopilot
// already use:
//   * `evaluateUnattendedAction` — the ONE named ceiling. An `auto` automation
//     still passes through the owner's per-category caps; an over-cap payload
//     is HELD for a human, not dropped and not forced through.
//   * `AUTOPILOT_EXECUTORS` — the same role-guarded executor a chat apply runs.
//   * `ai_action_audit` (source = 'automation') — the same history.
//   * `autopilotAmountContext` — caps are measured against DB-read numbers, not
//     the automation's own stored payload.
// The only thing the automation adds is the typed CONDITION deciding WHETHER to
// propose at all, evaluated against the same facts `previewAutomation` shows.

export type AutomationRunOutcome = "applied" | "pending_approval" | "skipped" | "failed";

export interface FireAutomationResult {
  runId: string;
  outcome: AutomationRunOutcome;
}

/**
 * Claims `(automation_id, dedupe_key)`. A second caller for the same key gets
 * null and does nothing — the whole idempotency story, enforced by the UNIQUE
 * index (migration 0156) rather than by a read-then-write. This is what makes a
 * tick that runs twice, or two app instances ticking at once, safe.
 */
async function claimAutomationRun(input: {
  businessId: string;
  automationId: string;
  locationId: string | null;
  triggerSource: AutomationTriggerKind;
  dedupeKey: string;
}): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_automation_runs
       (business_id, automation_id, location_id, trigger_source, dedupe_key, status)
     VALUES ($1, $2, $3, $4, $5, 'skipped')
     ON CONFLICT (automation_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [input.businessId, input.automationId, input.locationId, input.triggerSource, input.dedupeKey],
  );
  return rows[0]?.id ?? null;
}

async function userName(businessId: string, userId: string | null): Promise<string> {
  if (!userId) return "نامشخص";
  const { rows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  return rows[0]?.full_name?.trim() || "نامشخص";
}

/**
 * How many actions in this category have already been applied unattended today,
 * across ALL three unattended features. An automation shares the daily counter
 * with autopilot and the coworker on purpose: "money: at most 3 unattended
 * writes a day" is a statement about the business, not about one feature.
 */
async function appliedTodayInCategory(businessId: string, category: AutopilotCategory): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ai_action_audit
      WHERE business_id = $1 AND source IN ('autopilot', 'coworker', 'automation')
        AND autopilot_category = $2 AND status IN ('applied', 'reverted')
        AND created_at >= now() - interval '24 hours'`,
    [businessId, category],
  );
  return Number(rows[0]?.count ?? 0);
}

async function finishAutomationRun(input: {
  businessId: string;
  runId: string;
  status: AutomationRunOutcome;
  conditionsMet: boolean;
  actionType: ActionType | null;
  auditId: string | null;
  facts: AutomationFacts | null;
  summary: string;
  error?: string | null;
}): Promise<void> {
  await query(
    `UPDATE ai_automation_runs
        SET status = $3, conditions_met = $4, action_type = $5, audit_id = $6,
            facts = $7::jsonb, summary = $8, error = $9, finished_at = now()
      WHERE id = $1 AND business_id = $2`,
    [
      input.runId,
      input.businessId,
      input.status,
      input.conditionsMet,
      input.actionType,
      input.auditId,
      input.facts === null ? null : JSON.stringify(compactProactiveFacts(input.facts)),
      input.summary.slice(0, 2_000),
      input.error?.slice(0, 500) ?? null,
    ],
  );
}

/**
 * One firing of one automation, after its run has been claimed: gather the
 * facts, evaluate the conditions, and — only if they hold — record the action
 * as a proposal and either apply it (when the shared ceiling admits an `auto`
 * automation) or leave it pending for a human.
 *
 * Split from the tick so an integration test can drive it directly with a real
 * automation and a real database, no scheduler and no provider involved — the
 * guardrail equivalence with autopilot is exactly what must be proven.
 */
async function executeAutomationRun(input: {
  businessId: string;
  automation: Automation;
  runId: string;
  now: Date;
}): Promise<AutomationRunOutcome> {
  const { businessId, automation, runId, now } = input;
  try {
    const facts = await gatherAutomationFacts(businessId, now);
    const conditionsMet = evaluateConditions(automation.conditions, facts);

    if (!conditionsMet) {
      // A run that legitimately had nothing to do is 'skipped', not 'failed'.
      await finishAutomationRun({
        businessId, runId, status: "skipped", conditionsMet: false,
        actionType: null, auditId: null, facts,
        summary: `«${automation.name}»: شرط‌ها برقرار نبود؛ اقدامی انجام نشد.`,
      });
      return "skipped";
    }

    const proposal: ProposedAction = {
      type: automation.actionType,
      title: automation.name,
      summary: `اتوماسیون «${automation.name}»`,
      payload: automation.actionPayload,
    };
    const meta = ACTION_CATALOG[automation.actionType];
    const category = meta?.autopilotCategory ?? null;

    // Every firing is recorded in the shared audit trail, tagged 'automation',
    // exactly as a chat, autopilot or coworker write is — one history, five
    // authors.
    const authorizedByName = await userName(businessId, automation.authorizedBy);
    const auditId = await createAiActionAudit({
      businessId,
      actorUserId: automation.authorizedBy ?? "automation",
      actorName: `اتوماسیون (مجوز: ${authorizedByName})`,
      prompt: `اتوماسیون «${automation.name}»`,
      proposal,
    });
    await query(
      `UPDATE ai_action_audit SET source = 'automation', autopilot_category = $3
        WHERE id = $1 AND business_id = $2`,
      [auditId, businessId, category],
    );

    // The shared ceiling — the identical gate autopilot and the coworker use.
    const settings = await getAutopilotSettings(businessId);
    const decision = evaluateUnattendedAction({
      meta,
      payload: proposal.payload,
      approvalMode: automation.approvalMode,
      hasAuthorizer: Boolean(automation.authorizedBy),
      setting: category ? settings[category] ?? null : null,
      appliedTodayInCategory: category ? await appliedTodayInCategory(businessId, category) : 0,
      context: await autopilotAmountContext(businessId, proposal),
    });

    if (decision.decision === "needs_confirmation") {
      // Held for a human: the audit row stays 'proposed' and shows in the hub
      // as an ordinary clickable proposal, with the reason attached — never
      // dropped, never forced through.
      await query(
        `UPDATE ai_action_audit SET deferred_reason = $3
          WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
        [auditId, businessId, decision.reasonCode],
      );
      await finishAutomationRun({
        businessId, runId, status: "pending_approval", conditionsMet: true,
        actionType: automation.actionType, auditId, facts,
        summary: `«${automation.name}»: ${decision.reasonFa}`,
      });
      await recordNotification({
        businessId,
        locationId: automation.locationId,
        eventKey: "ai.automation.pending",
        severity: "important",
        title: `اتوماسیون «${automation.name}»: در انتظار تأیید شما`,
        body: decision.reasonFa,
        url: "/dashboard",
        dedupeKey: notificationDedupeKey("ai.automation.pending", runId),
        payload: { runId, automationId: automation.id },
      });
      return "pending_approval";
    }

    // auto_apply — through the same role-guarded executor a chat apply uses.
    const executor = meta?.executor ? AUTOPILOT_EXECUTORS[meta.executor] : null;
    if (!executor) {
      await query(
        `UPDATE ai_action_audit SET status = 'failed', result = $3::jsonb
          WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
        [auditId, businessId, JSON.stringify({ error: "automation_executor_missing" })],
      );
      await finishAutomationRun({
        businessId, runId, status: "failed", conditionsMet: true,
        actionType: automation.actionType, auditId, facts,
        summary: `«${automation.name}»: اجراکنندهٔ این اقدام موجود نیست.`,
        error: "automation_executor_missing",
      });
      return "failed";
    }

    const serviceGate = await aiActionServiceGate(businessId, automation.actionType);
    if (!serviceGate.allowed) {
      const summary =
        serviceGate.error === "service_disabled"
          ? `«${automation.name}»: سرویس مقصد غیرفعال است؛ اقدام برای تأیید دستی نگه داشته شد.`
          : `«${automation.name}»: بررسی سرویس مقصد در دسترس نیست؛ اقدام برای تلاش دوباره نگه داشته شد.`;
      await query(
        `UPDATE ai_action_audit SET deferred_reason = $3
          WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
        [auditId, businessId, serviceGate.error],
      );
      await finishAutomationRun({
        businessId, runId, status: "pending_approval", conditionsMet: true,
        actionType: automation.actionType, auditId, facts, summary,
      });
      return "pending_approval";
    }

    const result = await executor({
      businessId,
      authorizedByUserId: automation.authorizedBy,
      payload: proposal.payload,
    });
    await query(
      `UPDATE ai_action_audit
          SET status = $3, result = $4::jsonb, prior_state = $5::jsonb,
              applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END
        WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
      [
        auditId,
        businessId,
        result.ok ? "applied" : "failed",
        JSON.stringify(compactProactiveFacts(result.result)),
        result.priorState === undefined ? null : JSON.stringify(compactProactiveFacts(result.priorState)),
      ],
    );

    if (result.ok) {
      await finishAutomationRun({
        businessId, runId, status: "applied", conditionsMet: true,
        actionType: automation.actionType, auditId, facts,
        summary: `«${automation.name}»: اقدام به‌صورت خودکار ثبت شد.`,
      });
      return "applied";
    }

    await finishAutomationRun({
      businessId, runId, status: "failed", conditionsMet: true,
      actionType: automation.actionType, auditId, facts,
      summary: `«${automation.name}»: اجرای اقدام ناموفق بود.`,
      error: result.errorCode ?? "execution_failed",
    });
    await recordNotification({
      businessId,
      locationId: automation.locationId,
      eventKey: "ai.automation.failed",
      severity: "important",
      title: `اتوماسیون «${automation.name}»: اجرا ناموفق بود`,
      body: result.errorCode ?? "execution_failed",
      url: "/dashboard",
      dedupeKey: notificationDedupeKey("ai.automation.failed", runId),
      payload: { runId, automationId: automation.id },
    });
    return "failed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`automation ${automation.id} failed:`, message);
    await finishAutomationRun({
      businessId, runId, status: "failed", conditionsMet: false,
      actionType: automation.actionType, auditId: null, facts: null,
      summary: `«${automation.name}»: اجرای این اتوماسیون ناموفق بود.`,
      error: message,
    });
    await recordNotification({
      businessId,
      locationId: automation.locationId,
      eventKey: "ai.automation.failed",
      severity: "important",
      title: `اتوماسیون «${automation.name}»: اجرا ناموفق بود`,
      body: message.slice(0, 200),
      url: "/dashboard",
      dedupeKey: notificationDedupeKey("ai.automation.failed", runId),
      payload: { runId, automationId: automation.id },
    });
    return "failed";
  } finally {
    await query(`UPDATE ai_automations SET last_run_at = now() WHERE business_id = $1 AND id = $2`, [
      businessId,
      automation.id,
    ]);
  }
}

/**
 * Fire one automation now, claiming its run first. Returns null when the claim
 * was already taken (idempotent no-op), or the outcome otherwise. Shared by the
 * tick and by a manual "run now" from the editor.
 */
export async function fireAutomation(input: {
  businessId: string;
  automation: Automation;
  triggerSource: AutomationTriggerKind;
  dedupeKey: string;
  now?: Date;
}): Promise<FireAutomationResult | null> {
  const runId = await claimAutomationRun({
    businessId: input.businessId,
    automationId: input.automation.id,
    locationId: input.automation.locationId,
    triggerSource: input.triggerSource,
    dedupeKey: input.dedupeKey,
  });
  if (!runId) return null;
  const outcome = await executeAutomationRun({
    businessId: input.businessId,
    automation: input.automation,
    runId,
    now: input.now ?? new Date(),
  });
  return { runId, outcome };
}

/**
 * Run an owner's manual automation once, right now. The dedupe key is the
 * instant, so two rapid taps still produce two runs (a manual "run again" is a
 * deliberate act), but a retried request with the same instant does not.
 */
export async function runAutomationNow(
  businessId: string,
  id: string,
  now: Date = new Date(),
): Promise<FireAutomationResult | null> {
  const automation = await getAutomation(businessId, id);
  if (!automation || !automation.enabled) return null;
  return fireAutomation({
    businessId,
    automation,
    triggerSource: "manual",
    dedupeKey: dedupeKeyForManual(now),
    now,
  });
}

/**
 * The tick for one business, riding the proactive enumeration exactly as the
 * coworker and autopilot do (one tenant walk, not three). Fires every enabled
 * SCHEDULE automation that is due this local business day, and every enabled
 * EVENT automation matching an unprocessed coworker event.
 *
 * It deliberately does NOT mark events processed: the coworker tick owns that
 * (`markEventsProcessed`, in the same business pass). So this tick must run
 * BEFORE the coworker in `runBusinessProactiveJobs`, while the lifecycle events
 * are still unprocessed — the two features read the same rows, and the coworker
 * clears them afterwards. Idempotency across ticks is the per-event run claim
 * (`event:<id>`), not the processed flag.
 */
export async function runAutomationsTick(
  businessId: string,
  clock: LocalBusinessClock,
  now: Date = new Date(),
): Promise<number> {
  if (!(await isFeatureEnabled(businessId, "ai_assistant"))) return 0;

  const automations = (await listAutomations(businessId)).filter((a) => a.enabled);
  if (automations.length === 0) return 0;

  let fired = 0;

  // Scheduled: due once per local business day from its hour onwards.
  for (const automation of automations.filter((a) => a.triggerKind === "schedule")) {
    const baseKey = scheduleDedupeKeyIfDue(
      {
        triggerKind: "schedule",
        scheduleHour: automation.scheduleHour,
        scheduleWeekday: automation.scheduleWeekday,
        enabled: true,
      },
      clock,
    );
    if (!baseKey) continue;
    const result = await fireAutomation({
      businessId, automation, triggerSource: "schedule", dedupeKey: baseKey, now,
    });
    if (result) fired += 1;
  }

  // Event: match unprocessed coworker lifecycle events (shift_open/close,
  // day_close). Read-only here — the coworker tick clears the queue.
  const eventAutomations = automations.filter((a) => a.triggerKind === "event");
  if (eventAutomations.length > 0) {
    const { rows: events } = await query<{ id: string; location_id: string | null; kind: string }>(
      `SELECT id, location_id, kind FROM ai_coworker_events
        WHERE business_id = $1 AND processed_at IS NULL
        ORDER BY occurred_at LIMIT 100`,
      [businessId],
    );
    for (const event of events) {
      for (const automation of eventAutomations) {
        if (automation.eventKind !== event.kind) continue;
        if (automation.locationId !== null && automation.locationId !== event.location_id) continue;
        const result = await fireAutomation({
          businessId, automation, triggerSource: "event",
          dedupeKey: dedupeKeyForEvent(event.id), now,
        });
        if (result) fired += 1;
      }
    }
  }

  return fired;
}
