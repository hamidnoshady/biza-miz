/**
 * The CRM's automations: rows, runs, and the engine that fires them.
 *
 * ## What an automation may do, in one place
 *
 * This file contains **every** write an automation can make, and the list is
 * short on purpose:
 *
 * | action | writes |
 * |---|---|
 * | `create_follow_up` | one row in `crm_activities` (a real follow-up task, so it lands in somebody's day and on the customer's timeline) |
 * | `assign_owner` | the owner columns of `crm_deals`, `crm_cases` or `crm_leads` |
 * | `notify_growth` | one row in `crm_automation_runs` — a *signal*, and the audit entry that says the CRM asked |
 *
 * There is no channel, no template, no recipient and no money here. Growth owns
 * campaigns, consent-checked sends and the outbox; an automation can only tell
 * it that something changed. `crm-app-boundaries.test.ts` reads this file's SQL
 * and refuses any other table, which is what makes that a property rather than a
 * promise.
 *
 * Transactional, it is not: a run is logged after the write it describes, and
 * `runCrmAutomations` swallows its own failures — the same posture as
 * `recordCrmAudit`, and for the same reason. A rule that fails must not fail the
 * deal move that triggered it, and the failure is visible in the run log rather
 * than in a 500 for somebody who was only dragging a card.
 *
 * ## Why this is not the AI automations engine
 *
 * `ai_automations` (0155) is a *business-wide* engine: schedule/event triggers,
 * a fact document over A/R, A/P, inventory, weekday and hour, and actions drawn
 * from the AI action catalog with approval modes, all behind the `ai_assistant`
 * entitlement. A CRM rule is a different animal — it is per-record (this deal,
 * this ticket, this lead), its action is a deterministic CRM write rather than a
 * proposal, and it has to work for a business with no AI entitlement at all,
 * governed by `crm.configure`.
 *
 * Folding them together would mean either giving the CRM the catalog (and with
 * it a path to propose a send — the boundary above) or rewriting a working
 * engine's fact model to carry an entity. So there are two engines, and this is
 * the smaller one. What is shared is the *posture*, copied deliberately:
 * a closed vocabulary, a condition document that rejects unknown fields instead
 * of ignoring them, and an append-only run log.
 */

import { query } from "./db";
import { businessToday } from "./business-day-service";
import { recordCrmAudit } from "./crm-audit-service";
import { isUuid } from "./uuid";
import {
  CRM_AUTOMATION_ACTION_DEFS,
  CRM_AUTOMATION_CONDITION_DEFS,
  CRM_AUTOMATION_TRIGGER_DEFS,
  followUpDueAt,
  followUpSubject,
  matchesAutomationConditions,
  validateAutomationDraft,
  type CrmAutomationAction,
  type CrmAutomationConditionValue,
  type CrmAutomationConfigError,
  type CrmAutomationEntity,
  type CrmAutomationTrigger,
  type CrmGrowthSignal,
} from "./crm-automation-rules";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CrmAutomationActionConfig extends Record<string, unknown> {
  memberId: string | null;
  offsetDays: number | null;
  signal: CrmGrowthSignal | null;
}

export interface CrmAutomationRule extends Record<string, unknown> {
  id: string;
  name: string;
  triggerKey: CrmAutomationTrigger;
  conditions: CrmAutomationConditionValue[];
  actionKey: CrmAutomationAction;
  actionConfig: CrmAutomationActionConfig;
  /** The member the action names, resolved for the screen — null when none. */
  actionMemberName: string | null;
  isActive: boolean;
  createdBy: string;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CrmAutomationOutcome = "applied" | "skipped" | "failed" | "triggered_growth";

export interface CrmAutomationRun extends Record<string, unknown> {
  id: string;
  automationId: string | null;
  automationName: string;
  triggerKey: string;
  entityType: string;
  entityId: string | null;
  outcome: CrmAutomationOutcome;
  detail: Record<string, unknown>;
  at: string;
}

/**
 * The one cross-app read: what the CRM has asked Growth to look at.
 *
 * Growth consumes it; the CRM never writes into Growth's own tables. A signal
 * carries no message text and no audience — it is an observation about a
 * customer, and turning it into a campaign is somebody's decision, with
 * consent checked on Growth's side of the line.
 */
export interface CrmGrowthSignalEntry extends Record<string, unknown> {
  id: string;
  at: string;
  signal: string | null;
  partyId: string | null;
  partyName: string | null;
  ruleName: string;
}

export type CrmAutomationServiceError =
  | CrmAutomationConfigError
  | "automation_member_invalid"
  | "automation_member_inactive"
  | "automation_not_found";

export interface CrmAutomationActor {
  name: string;
  userId?: string | null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The rule, plus the name of the member its action names.
 *
 * The join is on the id inside the config document, cast through `nullif` so a
 * rule without a member does not raise; the alternative is a second round trip
 * per rule from the screen, which is the shape that ends up with the name on the
 * card disagreeing with the name in the config.
 */
const RULE_COLUMNS = `a.id, a.name, a.trigger_key AS "triggerKey", a.conditions,
  a.action_key AS "actionKey", a.action_config AS "actionConfig", a.is_active AS "isActive",
  a.created_by AS "createdBy", a.run_count AS "runCount", a.last_run_at AS "lastRunAt",
  a.created_at AS "createdAt", a.updated_at AS "updatedAt",
  coalesce(nullif(btrim(u.full_name), ''), u.email) AS "actionMemberName"`;

const RULE_FROM = `FROM crm_automations a
  LEFT JOIN users u
    ON u.id = nullif(a.action_config->>'memberId', '')::uuid
   AND u.business_id = a.business_id`;

interface RuleRow extends Record<string, unknown> {
  id: string;
  name: string;
  triggerKey: string;
  conditions: unknown;
  actionKey: string;
  actionConfig: unknown;
  actionMemberName?: string | null;
  isActive: boolean;
  createdBy: string;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A stored row, read back as the closed vocabulary it was written from.
 *
 * The database is not the validator — `validateAutomationDraft` is — but a row
 * can outlive the vocabulary that wrote it (a trigger removed in a later
 * release), and a rule whose trigger no longer exists must not be handed to the
 * engine as though it were understood. Unknown values are dropped here, at the
 * boundary, so the engine only ever sees keys it has code for.
 */
function toRule(row: RuleRow): CrmAutomationRule {
  const conditions = Array.isArray(row.conditions)
    ? (row.conditions as CrmAutomationConditionValue[]).filter(
        (condition) => condition && CRM_AUTOMATION_CONDITION_DEFS[condition.key],
      )
    : [];
  const config = (row.actionConfig ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    name: row.name,
    triggerKey: row.triggerKey as CrmAutomationTrigger,
    conditions,
    actionKey: row.actionKey as CrmAutomationAction,
    actionConfig: {
      memberId: (config.memberId as string | null) ?? null,
      offsetDays: typeof config.offsetDays === "number" ? config.offsetDays : null,
      signal: (config.signal as CrmGrowthSignal | null) ?? null,
    },
    actionMemberName: row.actionMemberName ?? null,
    isActive: Boolean(row.isActive),
    createdBy: row.createdBy,
    runCount: Number(row.runCount ?? 0),
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A business's rules, oldest first — the order the engine evaluates them in. */
export async function listAutomations(businessId: string): Promise<CrmAutomationRule[]> {
  const { rows } = await query<RuleRow>(
    `SELECT ${RULE_COLUMNS} ${RULE_FROM} WHERE a.business_id = $1 ORDER BY a.created_at, a.id`,
    [businessId],
  );
  return rows.map(toRule);
}

export async function getAutomation(
  businessId: string,
  automationId: string,
): Promise<CrmAutomationRule | null> {
  if (!isUuid(automationId)) return null;
  const { rows } = await query<RuleRow>(
    `SELECT ${RULE_COLUMNS} ${RULE_FROM} WHERE a.business_id = $1 AND a.id = $2`,
    [businessId, automationId],
  );
  return rows[0] ? toRule(rows[0]) : null;
}

/**
 * The runs, newest first — what the rules have actually done lately.
 *
 * `skipped` is kept rather than hidden: "why didn't my rule fire" is the
 * question an automation screen gets asked most, and the answer is usually that
 * its conditions did not hold.
 */
export async function listAutomationRuns(
  businessId: string,
  options: { automationId?: string | null; limit?: number } = {},
): Promise<CrmAutomationRun[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const params: unknown[] = [businessId];
  let where = "";
  if (options.automationId && isUuid(options.automationId)) {
    params.push(options.automationId);
    where = ` AND automation_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query<CrmAutomationRun>(
    `SELECT id, automation_id AS "automationId", automation_name AS "automationName",
            trigger_key AS "triggerKey", entity_type AS "entityType", entity_id AS "entityId",
            outcome, detail, at
       FROM crm_automation_runs
      WHERE business_id = $1${where}
      ORDER BY at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({ ...row, detail: (row.detail ?? {}) as Record<string, unknown> }));
}

/** How many rules and runs a business has — the settings screen's summary line. */
export async function automationCounts(
  businessId: string,
): Promise<{ active: number; total: number; appliedLast30: number }> {
  const { rows } = await query<{ active: string; total: string; applied: string }>(
    `SELECT count(*) FILTER (WHERE is_active)::text AS active,
            count(*)::text AS total,
            (SELECT count(*)::text FROM crm_automation_runs r
              WHERE r.business_id = $1
                AND r.outcome IN ('applied', 'triggered_growth')
                AND r.at > now() - interval '30 days') AS applied
       FROM crm_automations WHERE business_id = $1`,
    [businessId],
  );
  return {
    active: Number(rows[0]?.active ?? 0),
    total: Number(rows[0]?.total ?? 0),
    appliedLast30: Number(rows[0]?.applied ?? 0),
  };
}

/**
 * The signals Growth may read. Served under the CRM's own configuration gate:
 * this is CRM data about CRM customers, and the reader is the marketing app, not
 * a browser.
 */
export async function listCrmGrowthSignals(
  businessId: string,
  options: { limit?: number; since?: string | null } = {},
): Promise<CrmGrowthSignalEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const params: unknown[] = [businessId];
  let since = "";
  if (options.since) {
    params.push(options.since);
    since = ` AND r.at >= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query<CrmGrowthSignalEntry>(
    `SELECT r.id, r.at,
            r.detail->>'signal' AS signal,
            nullif(r.detail->>'partyId', '') AS "partyId",
            p.name AS "partyName",
            r.automation_name AS "ruleName"
       FROM crm_automation_runs r
       LEFT JOIN parties p ON p.id = nullif(r.detail->>'partyId', '')::uuid
      WHERE r.business_id = $1 AND r.outcome = 'triggered_growth'${since}
      ORDER BY r.at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SaveAutomationInput {
  id?: string | null;
  name: string;
  triggerKey: string;
  conditions?: CrmAutomationConditionValue[];
  actionKey: string;
  actionConfig?: { memberId?: string | null; offsetDays?: number | null; signal?: string | null };
  isActive?: boolean;
}

/**
 * Create or update a rule.
 *
 * The composition is validated by `validateAutomationDraft` (pure, shared with
 * the test suite); the member is validated here, because "is this somebody who
 * can still sign in to this business" is a query. An inactive member is refused
 * rather than accepted-and-greyed: a rule is authored once and fires for months,
 * and writing work into a departed colleague's queue is a promise nobody keeps.
 */
export async function saveAutomation(
  businessId: string,
  input: SaveAutomationInput,
  actor: CrmAutomationActor,
): Promise<{ ok: true; rule: CrmAutomationRule } | { ok: false; error: CrmAutomationServiceError }> {
  const validated = validateAutomationDraft({
    name: input.name,
    triggerKey: input.triggerKey,
    conditions: input.conditions ?? [],
    actionKey: input.actionKey,
    actionConfig: input.actionConfig ?? {},
  });
  if (!validated.ok) return validated;

  const { value } = validated;
  if (value.actionConfig.memberId) {
    const member = await memberState(businessId, value.actionConfig.memberId);
    if (!member) return { ok: false, error: "automation_member_invalid" };
    if (!member.isActive) return { ok: false, error: "automation_member_inactive" };
  }

  const existing = input.id ? await getAutomation(businessId, input.id) : null;
  if (input.id && !existing) return { ok: false, error: "automation_not_found" };

  const isActive = input.isActive ?? existing?.isActive ?? true;
  const conditions = JSON.stringify(value.conditions);
  const actionConfig = JSON.stringify(value.actionConfig);

  let automationId: string;
  if (existing) {
    await query(
      `UPDATE crm_automations
          SET name = $3, trigger_key = $4, conditions = $5::jsonb, action_key = $6,
              action_config = $7::jsonb, is_active = $8, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        existing.id,
        value.name,
        value.triggerKey,
        conditions,
        value.actionKey,
        actionConfig,
        isActive,
      ],
    );
    automationId = existing.id;
  } else {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_automations
         (business_id, name, trigger_key, conditions, action_key, action_config, is_active, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        businessId,
        value.name,
        value.triggerKey,
        conditions,
        value.actionKey,
        actionConfig,
        isActive,
        actor.name ?? "",
      ],
    );
    automationId = rows[0].id;
  }

  const rule = await getAutomation(businessId, automationId);
  if (!rule) return { ok: false, error: "automation_not_found" };

  await recordCrmAudit({
    businessId,
    kind: "automation.config_changed",
    entityType: "automation",
    entityId: rule.id,
    summary: existing ? `اتوماسیون «${rule.name}» ویرایش شد` : `اتوماسیون «${rule.name}» ساخته شد`,
    detail: {
      trigger: rule.triggerKey,
      action: rule.actionKey,
      conditions: rule.conditions,
      isActive: rule.isActive,
    },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  return { ok: true, rule };
}

/** Turn a rule off, or back on. Off means the engine never even reads it. */
export async function setAutomationActive(
  businessId: string,
  automationId: string,
  isActive: boolean,
  actor: CrmAutomationActor,
): Promise<CrmAutomationRule | null> {
  const existing = await getAutomation(businessId, automationId);
  if (!existing) return null;
  if (existing.isActive === isActive) return existing;

  await query(
    `UPDATE crm_automations SET is_active = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, automationId, isActive],
  );

  await recordCrmAudit({
    businessId,
    kind: "automation.config_changed",
    entityType: "automation",
    entityId: automationId,
    summary: isActive
      ? `اتوماسیون «${existing.name}» روشن شد`
      : `اتوماسیون «${existing.name}» خاموش شد`,
    detail: { isActive },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  return { ...existing, isActive };
}

/**
 * Delete a rule.
 *
 * Its runs stay: `automation_name` is denormalised onto them for exactly this
 * moment, because "what did this rule do before we turned it off" is asked
 * *after* somebody deletes it.
 */
export async function deleteAutomation(
  businessId: string,
  automationId: string,
  actor: CrmAutomationActor,
): Promise<boolean> {
  if (!isUuid(automationId)) return false;
  const existing = await getAutomation(businessId, automationId);
  if (!existing) return false;
  const { rowCount } = await query(
    `DELETE FROM crm_automations WHERE business_id = $1 AND id = $2`,
    [businessId, automationId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await recordCrmAudit({
    businessId,
    kind: "automation.config_changed",
    entityType: "automation",
    entityId: automationId,
    summary: `اتوماسیون «${existing.name}» حذف شد`,
    detail: { deleted: true, trigger: existing.triggerKey, action: existing.actionKey },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** What a trigger hands the engine. */
export interface CrmAutomationEvent {
  trigger: CrmAutomationTrigger;
  entity: CrmAutomationEntity;
  actor: CrmAutomationActor;
}

export interface CrmAutomationRunSummary {
  considered: number;
  applied: number;
  skipped: number;
  failed: number;
  growthSignals: number;
}

/**
 * Fire the rules for one event.
 *
 * Called *after* the write that produced the event has committed, and never from
 * inside that write's transaction: an automation's failure must not roll back the
 * salesperson's move, and a failed statement inside a transaction would poison
 * it for everything after.
 *
 * Rules are evaluated in creation order, sequentially, so a business that writes
 * two rules over the same trigger can reason about which one ran — the same
 * determinism the queues and the AI engine use.
 */
export async function runCrmAutomations(
  businessId: string,
  event: CrmAutomationEvent,
): Promise<CrmAutomationRunSummary> {
  const summary: CrmAutomationRunSummary = {
    considered: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    growthSignals: 0,
  };

  let rules: CrmAutomationRule[];
  try {
    const { rows } = await query<RuleRow>(
      `SELECT ${RULE_COLUMNS} ${RULE_FROM}
        WHERE a.business_id = $1 AND a.trigger_key = $2 AND a.is_active
        ORDER BY a.created_at, a.id`,
      [businessId, event.trigger],
    );
    rules = rows.map(toRule);
  } catch (error) {
    // The engine is not on the critical path: the move happened, and a rule
    // store that cannot be read is not a reason to fail it.
    console.error("crm automations: rules could not be loaded", errorMessage(error));
    return summary;
  }
  summary.considered = rules.length;

  for (const rule of rules) {
    if (!matchesAutomationConditions(rule.conditions, event.entity)) {
      await safeRecordRun(businessId, rule, event, "skipped", { reason: "conditions_not_met" });
      summary.skipped += 1;
      continue;
    }

    // An action this build does not have — a row written by a later release, or
    // one edited outside the API. It is recorded as not-run rather than falling
    // through to whichever branch happens to be last, which would silently turn
    // an unknown action into a Growth signal.
    const definition = CRM_AUTOMATION_ACTION_DEFS[rule.actionKey];
    if (!definition) {
      await safeRecordRun(businessId, rule, event, "skipped", { reason: "action_unknown" });
      summary.skipped += 1;
      continue;
    }
    if (definition.side !== "crm" && definition.side !== "growth") {
      await safeRecordRun(businessId, rule, event, "skipped", { reason: "action_unknown" });
      summary.skipped += 1;
      continue;
    }

    try {
      if (rule.actionKey === "create_follow_up") {
        const detail = await createFollowUp(businessId, rule, event);
        await safeRecordRun(businessId, rule, event, "applied", detail);
        summary.applied += 1;
      } else if (rule.actionKey === "assign_owner") {
        const detail = await assignOwner(businessId, rule, event);
        if (detail.outcome === "skipped") {
          await safeRecordRun(businessId, rule, event, "skipped", detail);
          summary.skipped += 1;
        } else {
          await safeRecordRun(businessId, rule, event, "applied", detail);
          summary.applied += 1;
        }
      } else if (definition.side === "growth") {
        const signal = rule.actionConfig.signal;
        await safeRecordRun(businessId, rule, event, "triggered_growth", {
          signal,
          partyId: event.entity.partyId,
          title: event.entity.title,
        });
        summary.growthSignals += 1;
        // The one automation effect that is a *decision about a customer* rather
        // than an edit to a record: somebody may have to explain, later, why the
        // marketing app was told this customer was at risk.
        await recordCrmAudit({
          businessId,
          kind: "automation.signal_growth",
          entityType: "automation",
          entityId: rule.id,
          partyId: event.entity.partyId,
          summary: `اتوماسیون «${rule.name}» رشد و بازاریابی را دربارهٔ «${event.entity.title}» خبر کرد`,
          detail: { signal, trigger: event.trigger },
          actorUserId: event.actor.userId ?? null,
          actorName: event.actor.name,
        });
      } else {
        // Unreachable for a declared action: the two `side`s above cover the
        // vocabulary, and `toRule` keeps only declared keys. Kept as a refusal
        // rather than an assumption, because the day it becomes reachable is the
        // day an unknown key would otherwise fall into a real action.
        await safeRecordRun(businessId, rule, event, "skipped", { reason: "action_unknown" });
        summary.skipped += 1;
        continue;
      }
      await bumpRule(businessId, rule.id);
    } catch (error) {
      summary.failed += 1;
      await safeRecordRun(businessId, rule, event, "failed", {
        error: errorMessage(error),
        action: rule.actionKey,
      });
    }
  }

  return summary;
}

/**
 * Create the follow-up the rule asked for, as a real activity.
 *
 * A generated follow-up is an ordinary row in the CRM's own work list — visible
 * in «کارها و پیگیریها», on the customer's timeline, and on Today like any
 * other task. An automation that kept its output in its own inbox would be a
 * second place to look for work.
 */
async function createFollowUp(
  businessId: string,
  rule: CrmAutomationRule,
  event: CrmAutomationEvent,
): Promise<Record<string, unknown>> {
  const { entity } = event;
  const assignee = await actionAssignee(businessId, rule, entity);
  const today = await businessToday(businessId);
  const offset = rule.actionConfig.offsetDays ?? 0;
  const dueAt = followUpDueAt(today, offset);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_activities
       (business_id, customer_id, deal_id, case_id, kind, subject, body, due_at,
        assigned_to, assignee_user_id, created_by)
     VALUES ($1, $2, $3, $4, 'task', $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      businessId,
      entity.partyId,
      entity.type === "deal" ? entity.id : null,
      entity.type === "case" ? entity.id : null,
      followUpSubject(event.trigger, entity.title),
      `این کار به‌صورت خودکار توسط اتوماسیون «${rule.name}» ساخته شد.`,
      dueAt,
      assignee.name,
      assignee.userId,
      event.actor.name || "اتوماسیون",
    ],
  );

  return {
    activityId: rows[0]?.id ?? null,
    dueAt,
    offsetDays: offset,
    assignedTo: assignee.userId,
    ...(assignee.fallback ? { assigneeFallback: assignee.fallback } : {}),
  };
}

/**
 * Move a record's owner.
 *
 * Refused when the member has been deactivated since the rule was written, and a
 * no-op when the record already belongs to them — both recorded, because "the
 * rule ran and did nothing" is information somebody looks for.
 */
async function assignOwner(
  businessId: string,
  rule: CrmAutomationRule,
  event: CrmAutomationEvent,
): Promise<Record<string, unknown> & { outcome: "applied" | "skipped" }> {
  const { entity } = event;
  const memberId = rule.actionConfig.memberId;
  const member = memberId ? await memberState(businessId, memberId) : null;
  if (!member) return { outcome: "skipped", reason: "member_missing" };
  if (!member.isActive) return { outcome: "skipped", reason: "member_inactive" };
  if (entity.ownerUserId === member.id) {
    return { outcome: "skipped", reason: "already_owned", memberId: member.id };
  }

  const table =
    entity.type === "deal"
      ? { name: "crm_deals", nameColumn: "owner_user" }
      : entity.type === "case"
        ? { name: "crm_cases", nameColumn: "assigned_to" }
        : { name: "crm_leads", nameColumn: "owner_name" };
  const idColumn = entity.type === "deal" ? "owner_user_id" : entity.type === "case" ? "assignee_user_id" : "owner_user_id";

  const { rowCount } = await query(
    `UPDATE ${table.name}
        SET ${table.nameColumn} = $3, ${idColumn} = $4, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, entity.id, member.name, member.id],
  );
  if ((rowCount ?? 0) === 0) {
    // The record was deleted between the event and the rule firing.
    return { outcome: "skipped", reason: "record_missing" };
  }

  return {
    outcome: "applied",
    memberId: member.id,
    from: entity.ownerUserId ?? null,
    fromName: entity.ownerName ?? null,
  };
}

/**
 * Who a generated follow-up lands on.
 *
 * The rule's chosen member, unless they have been deactivated since; then the
 * record's own owner, and otherwise nobody — in which case the follow-up still
 * exists and the «بدون مسئول» queue picks it up. Never silently dropped, never
 * handed to a person who has left.
 */
async function actionAssignee(
  businessId: string,
  rule: CrmAutomationRule,
  entity: CrmAutomationEntity,
): Promise<{ userId: string | null; name: string; fallback?: string }> {
  const memberId = rule.actionConfig.memberId;
  if (memberId) {
    const member = await memberState(businessId, memberId);
    if (member?.isActive) return { userId: member.id, name: member.name };
    if (entity.ownerUserId) {
      const owner = await memberState(businessId, entity.ownerUserId);
      if (owner?.isActive) return { userId: owner.id, name: owner.name, fallback: "rule_owner_inactive" };
    }
    return { userId: null, name: "", fallback: "rule_owner_inactive" };
  }
  if (entity.ownerUserId) {
    const owner = await memberState(businessId, entity.ownerUserId);
    if (owner?.isActive) return { userId: owner.id, name: owner.name };
  }
  return { userId: null, name: "" };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface MemberState {
  id: string;
  name: string;
  isActive: boolean;
}

/** One member of this business, or null. The `business_id` filter is the tenancy check. */
async function memberState(businessId: string, memberId: string): Promise<MemberState | null> {
  if (!isUuid(memberId)) return null;
  const { rows } = await query<{ id: string; name: string; is_active: boolean }>(
    `SELECT id, coalesce(nullif(btrim(full_name), ''), email) AS name, is_active
       FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, memberId],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, isActive: Boolean(row.is_active) } : null;
}

async function safeRecordRun(
  businessId: string,
  rule: CrmAutomationRule,
  event: CrmAutomationEvent,
  outcome: CrmAutomationOutcome,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO crm_automation_runs
         (business_id, automation_id, automation_name, trigger_key, entity_type, entity_id, outcome, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        businessId,
        rule.id,
        rule.name,
        event.trigger,
        event.entity.type,
        event.entity.id,
        outcome,
        JSON.stringify(detail),
      ],
    );
  } catch (error) {
    console.error("crm automations: run could not be recorded", errorMessage(error));
  }
}

/** Counters, for the screen's «آخرین اجرا» and run count. Only real effects count. */
async function bumpRule(businessId: string, automationId: string): Promise<void> {
  await query(
    `UPDATE crm_automations
        SET run_count = run_count + 1, last_run_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, automationId],
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
