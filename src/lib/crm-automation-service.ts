/**
 * The CRM's automations: When → If → Then.
 *
 * ## What this is, and what the other automations engine is
 *
 * The workspace already has `ai_automations` (0155): a business-wide engine
 * that fires on a *clock* (shift close, day close) over business-wide facts
 * (A/R, A/P, stock valuation), whose action is an entry in the AI action
 * catalog executed under an approval mode. It answers "when the day closes and
 * receivables are over X, propose Y".
 *
 * A CRM rule answers a different question — "when *this deal* enters this
 * stage, file the follow-up" — and the differences are not incidental:
 *
 * - **Per record, not per business.** A trigger carries an entity (a deal, a
 *   lead, a ticket) and a condition reads fields *of that record*: its value,
 *   its source, its priority, whether anybody owns it. A deal's value is not a
 *   fact about the business, and pushing it into the business-wide fact
 *   document would make every other automation carry it too.
 * - **Deterministic writes, not proposed actions.** Every action here is a SQL
 *   write inside the CRM that the engine performs itself. Nothing is proposed
 *   and nothing is approved: a business with no AI entitlement and no AI
 *   permission gets exactly the same behaviour.
 * - **Governed by CRM permissions.** Writing a rule is `crm.configure` — the
 *   capability that already reshapes the pipeline. Routing this through the
 *   coworker's catalog would mean a CRM manager's rule executes with the
 *   *catalog's* authority, which is how a CRM gains the ability to send.
 *
 * So they are two engines, deliberately, and this header is where that is said
 * rather than left for a reader to guess from two tables named `*automations*`.
 * What they share is the posture, not the code: closed vocabularies that refuse
 * rather than default, an append-only run log, and no capability the module did
 * not already have.
 *
 * ## The one way out of the app
 *
 * `notify_growth` records a signal — a run row and an audit line naming the
 * customer, the rule and the signal. It does **not** reach Growth's sending
 * half: no audience, no segment, no template, no consent check, no campaign, no
 * outbox row. Growth owns campaigns (and the consent that gates them) and reads
 * these signals on its own side (`listCrmGrowthSignals`); the CRM's job is to
 * say "this customer looks at risk" and stop. `crm-app-boundaries.test.ts`
 * reads every CRM file for the names of that sending half, and pins the write
 * surface of *this* file at eight statements over seven tables.
 *
 * ## Firing is not on the critical path
 *
 * The engine runs *after* the write it describes has committed, from each
 * module's own service (`moveDealToStage`, `upsertDeal`, `upsertCase`,
 * `saveLead`) — never inside that write's transaction, because a failing rule
 * must not roll back a salesperson's drag, and never from a route, because the
 * next write path would silently stop firing. It never throws: a rule that
 * cannot be evaluated is logged and skipped, and the record keeps moving.
 *
 * ## Runs are evidence, not a counter
 *
 * Every considered rule writes exactly one run row saying what happened and why
 * — `applied` (with the changes), `skipped` (with the reason: conditions not
 * met, member gone, already owned, record deleted) or `failed` (with the
 * error). The rule's name is denormalised onto the run, so deleting a rule
 * leaves the history of what it did. The rules themselves are audited where
 * they *change* (`automation.config_changed`) rather than on every firing,
 * which would bury the decision log in repetition.
 */

import { query } from "./db";
import { businessToday } from "./business-day-service";
import { recordCrmAudit } from "./crm-audit-service";
import { isUuid } from "./uuid";
import {
  followUpDueAt,
  followUpSubject,
  matchesAutomationConditions,
  validateAutomationDraft,
  type CrmAutomationAction,
  type CrmAutomationConditionValue,
  type CrmAutomationConfigError,
  type CrmAutomationDraft,
  type CrmAutomationEntity,
  type CrmAutomationTrigger,
  type CrmGrowthSignal,
} from "./crm-automation-rules";

/** What a rule looks like coming back out of the database. */
export interface CrmAutomationRule extends Record<string, unknown> {
  id: string;
  name: string;
  triggerKey: CrmAutomationTrigger;
  conditions: CrmAutomationConditionValue[];
  actionKey: CrmAutomationAction;
  /** The normalized document `validateAutomationDraft` produces. */
  actionConfig: { memberId: string | null; offsetDays: number | null; signal: CrmGrowthSignal | null };
  /** That member's name as of now, joined for display; `null` if they are gone. */
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

/** One signal the CRM handed to Growth, with the customer's name attached. */
export interface CrmGrowthSignalRow extends Record<string, unknown> {
  id: string;
  at: string;
  signal: CrmGrowthSignal | null;
  partyId: string | null;
  partyName: string | null;
  ruleName: string;
}

/** The snapshot one recorded event carries into the engine. */
export interface CrmAutomationEvent {
  trigger: CrmAutomationTrigger;
  entity: CrmAutomationEntity;
  actor: { name: string; userId?: string | null };
}

/** What one firing did, for the caller and for a test. */
export interface CrmAutomationRunSummary {
  considered: number;
  applied: number;
  skipped: number;
  failed: number;
  growthSignals: number;
}

/**
 * Every refusal the API can answer with.
 *
 * The validation codes come from `crm-automation-rules.ts`, so the form and the
 * endpoint refuse the same drafts in the same words; the three below need a
 * query (a member that is not in this business, a member who has left, a rule
 * that is not there) and so live here.
 */
export type CrmAutomationServiceError =
  | CrmAutomationConfigError
  | "automation_not_found"
  | "automation_member_invalid"
  | "automation_member_inactive";

const RULE_COLUMNS = `
  a.id, a.name, a.trigger_key AS "triggerKey", a.conditions,
  a.action_key AS "actionKey",
  nullif(a.action_config->>'memberId', '') AS "actionMemberId",
  nullif(a.action_config->>'offsetDays', '')::int AS "offsetDays",
  nullif(a.action_config->>'signal', '') AS signal,
  coalesce(
    nullif(btrim(u.full_name), ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), '')
  ) AS "actionMemberName",
  a.is_active AS "isActive", a.created_by AS "createdBy",
  a.run_count AS "runCount", a.last_run_at AS "lastRunAt",
  a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

/**
 * The rule list's one join.
 *
 * The member's name is joined rather than looked up per row or per render,
 * because every screen that shows a rule shows *who it hands work to* — and a
 * name that arrives with the row cannot drift from the id beside it. The join
 * is on the business as well as the id, so a rule can never borrow another
 * tenant's member name.
 */
const RULE_FROM = `
  FROM crm_automations a
  LEFT JOIN users u
    ON u.business_id = a.business_id
   AND u.id = nullif(a.action_config->>'memberId', '')::uuid`;

const RUN_COLUMNS = `
  r.id, r.automation_id AS "automationId", r.automation_name AS "automationName",
  r.trigger_key AS "triggerKey", r.entity_type AS "entityType",
  r.entity_id AS "entityId", r.outcome, r.detail, r.at`;

function toRule(row: Record<string, unknown>): CrmAutomationRule {
  const signal = typeof row.signal === "string" && row.signal ? (row.signal as CrmGrowthSignal) : null;
  return {
    ...row,
    conditions: Array.isArray(row.conditions) ? (row.conditions as CrmAutomationConditionValue[]) : [],
    actionConfig: {
      memberId: (row.actionMemberId as string | null) ?? null,
      offsetDays: row.offsetDays === null ? null : Number(row.offsetDays),
      signal,
    },
  } as CrmAutomationRule;
}

// ---------------------------------------------------------------- reading

export async function listAutomations(businessId: string): Promise<CrmAutomationRule[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RULE_COLUMNS} ${RULE_FROM}
      WHERE a.business_id = $1
      ORDER BY a.created_at, a.id`,
    [businessId],
  );
  return rows.map(toRule);
}

export async function getAutomation(
  businessId: string,
  id: string,
): Promise<CrmAutomationRule | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RULE_COLUMNS} ${RULE_FROM} WHERE a.business_id = $1 AND a.id = $2`,
    [businessId, id],
  );
  return rows[0] ? toRule(rows[0]) : null;
}

export async function listAutomationRuns(
  businessId: string,
  options: { automationId?: string | null; limit?: number } = {},
): Promise<CrmAutomationRun[]> {
  const { automationId = null, limit = 20 } = options;
  const values: unknown[] = [businessId];
  let filter = "";
  if (automationId && isUuid(automationId)) {
    values.push(automationId);
    filter = ` AND r.automation_id = $${values.length}`;
  }
  values.push(Math.min(Math.max(limit, 1), 200));
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM crm_automation_runs r
      WHERE r.business_id = $1${filter}
      ORDER BY r.at DESC, r.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows as CrmAutomationRun[];
}

/**
 * The signals the CRM has handed to Growth, newest first.
 *
 * This is the consuming side of `notify_growth`: Growth reads these — with the
 * customer's name, which it would otherwise have to join for — and decides what
 * to do, *including* whether the customer's consent allows it. Reading is the
 * whole interface: there is nothing to acknowledge and the CRM waits for
 * nothing, because a rule that needed a campaign to run would be a rule that
 * cannot run in a business that does not do campaigns.
 */
export async function listCrmGrowthSignals(
  businessId: string,
  options: { limit?: number } = {},
): Promise<CrmGrowthSignalRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT r.id, r.at,
            nullif(r.detail->>'signal', '') AS signal,
            nullif(r.detail->>'partyId', '') AS "partyId",
            p.name AS "partyName",
            r.automation_name AS "ruleName"
       FROM crm_automation_runs r
       LEFT JOIN parties p
         ON p.business_id = r.business_id
        AND p.id = nullif(r.detail->>'partyId', '')::uuid
      WHERE r.business_id = $1 AND r.outcome = 'triggered_growth'
      ORDER BY r.at DESC, r.id DESC
      LIMIT $2`,
    [businessId, Math.min(Math.max(options.limit ?? 20, 1), 200)],
  );
  return rows as CrmGrowthSignalRow[];
}

/** Counters for the settings screen: how much this business has automated. */
export async function automationCounts(businessId: string): Promise<{
  active: number;
  total: number;
  appliedLast30: number;
}> {
  const { rows } = await query<{ active: number; total: number; applied: number }>(
    `SELECT count(*) FILTER (WHERE a.is_active)::int AS active,
            count(*)::int AS total,
            (SELECT count(*)::int FROM crm_automation_runs r
              WHERE r.business_id = $1
                AND r.outcome IN ('applied', 'triggered_growth')
                AND r.at > now() - interval '30 days') AS applied
       FROM crm_automations a
      WHERE a.business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  return { active: row?.active ?? 0, total: row?.total ?? 0, appliedLast30: row?.applied ?? 0 };
}

// ---------------------------------------------------------------- writing

export interface SaveAutomationInput extends CrmAutomationDraft {
  id?: string | null;
  isActive?: boolean;
}

/**
 * A member who can actually receive work.
 *
 * The rule is checked at the door, so one that names somebody who has left is
 * refused *when it is written* rather than silently filing nothing for a year.
 * The same check runs when the rule fires, because people leave after a rule was
 * written.
 */
async function activeMemberName(
  businessId: string,
  memberId: string,
): Promise<string | "missing" | "inactive"> {
  if (!isUuid(memberId)) return "missing";
  const { rows } = await query<{ name: string | null; isActive: boolean }>(
    `SELECT coalesce(
              nullif(btrim(full_name), ''),
              nullif(split_part(coalesce(email, ''), '@', 1), '')
            ) AS name,
            coalesce(is_active, true) AS "isActive"
       FROM users
      WHERE business_id = $1 AND id = $2`,
    [businessId, memberId],
  );
  const row = rows[0];
  if (!row) return "missing";
  // Active-only, unlike `resolveOwner`: an existing row keeps the owner it has,
  // but an automation must not *hand work* to somebody who cannot sign in — and
  // quietly reassigning instead would decide a portfolio for the business.
  if (!row.isActive) return "inactive";
  return row.name ?? "missing";
}

export async function saveAutomation(
  businessId: string,
  input: SaveAutomationInput,
  actor: { name: string; userId?: string | null },
): Promise<{ ok: true; rule: CrmAutomationRule } | { ok: false; error: CrmAutomationServiceError }> {
  const draft = validateAutomationDraft(input);
  if (!draft.ok) return draft;

  const { name, triggerKey, conditions, actionKey, actionConfig } = draft.value;
  if (actionConfig.memberId) {
    const member = await activeMemberName(businessId, actionConfig.memberId);
    if (member === "missing") return { ok: false, error: "automation_member_invalid" };
    if (member === "inactive") return { ok: false, error: "automation_member_inactive" };
  }

  const isActive = input.isActive ?? true;
  const config = JSON.stringify(actionConfig);
  const conditionJson = JSON.stringify(conditions);

  let id = input.id ?? null;
  if (id) {
    if (!isUuid(id)) return { ok: false, error: "automation_not_found" };
    const existing = await getAutomation(businessId, id);
    if (!existing) return { ok: false, error: "automation_not_found" };
    await query(
      `UPDATE crm_automations
          SET name = $3, trigger_key = $4, conditions = $5::jsonb, action_key = $6,
              action_config = $7::jsonb, is_active = $8, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, id, name, triggerKey, conditionJson, actionKey, config, isActive],
    );
    await auditConfigChange(businessId, id, name, actor, {
      change: "updated",
      triggerKey,
      actionKey,
      conditionCount: conditions.length,
    });
  } else {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_automations
         (business_id, name, trigger_key, conditions, action_key, action_config,
          is_active, created_by, created_by_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        businessId,
        name,
        triggerKey,
        conditionJson,
        actionKey,
        config,
        isActive,
        actor.name ?? "",
        actor.userId ?? null,
      ],
    );
    id = rows[0]?.id ?? null;
    if (!id) return { ok: false, error: "automation_not_found" };
    await auditConfigChange(businessId, id, name, actor, {
      change: "created",
      triggerKey,
      actionKey,
      conditionCount: conditions.length,
    });
  }

  const rule = await getAutomation(businessId, id);
  return rule ? { ok: true, rule } : { ok: false, error: "automation_not_found" };
}

/**
 * Turn a rule on or off — the ordinary way to stop one, since it keeps the
 * rule, its counters and its runs.
 *
 * Returns the updated rule, or `null` when this business has no such rule: a
 * missing row is not an error a form has to explain, it is a 404.
 */
export async function setAutomationActive(
  businessId: string,
  id: string,
  isActive: boolean,
  actor: { name: string; userId?: string | null },
): Promise<CrmAutomationRule | null> {
  const existing = await getAutomation(businessId, id);
  if (!existing) return null;
  await query(
    `UPDATE crm_automations SET is_active = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, id, isActive],
  );
  await auditConfigChange(businessId, id, existing.name, actor, {
    change: isActive ? "activated" : "deactivated",
    triggerKey: existing.triggerKey,
    actionKey: existing.actionKey,
  });
  return getAutomation(businessId, id);
}

export async function deleteAutomation(
  businessId: string,
  id: string,
  actor: { name: string; userId?: string | null },
): Promise<boolean> {
  const existing = await getAutomation(businessId, id);
  if (!existing) return false;
  await query(`DELETE FROM crm_automations WHERE business_id = $1 AND id = $2`, [businessId, id]);
  await auditConfigChange(businessId, id, existing.name, actor, {
    change: "deleted",
    triggerKey: existing.triggerKey,
    actionKey: existing.actionKey,
  });
  return true;
}

const CHANGE_VERBS: Record<string, string> = {
  created: "ساخته شد",
  updated: "ویرایش شد",
  activated: "فعال شد",
  deactivated: "غیرفعال شد",
  deleted: "حذف شد",
};

/**
 * One audit line per change to a rule — not per firing.
 *
 * The decision log is for the decisions a person has to be able to explain, and
 * "who made the CRM file tasks on its own" is one of them. The firings
 * themselves live in the run log, which is where somebody asking "why did
 * nothing happen yesterday" will actually look.
 */
async function auditConfigChange(
  businessId: string,
  id: string,
  name: string,
  actor: { name: string; userId?: string | null },
  detail: Record<string, unknown>,
): Promise<void> {
  const verb = CHANGE_VERBS[String(detail.change)] ?? "تغییر کرد";
  await recordCrmAudit({
    businessId,
    kind: "automation.config_changed",
    entityType: "automation",
    entityId: id,
    summary: `اتوماسیون «${name}» ${verb}`,
    detail,
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });
}

// ---------------------------------------------------------------- the engine

/**
 * Run every active rule that this event concerns.
 *
 * The order is the order the rules were written, which is the only order a
 * person can predict: two rules that both file a follow-up file them in the
 * order the screen lists them. Each rule's failure is its own — one bad rule
 * does not stop the next, and no rule can stop the write that called this.
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
    rules = await activeRulesForTrigger(businessId, event.trigger);
  } catch (error) {
    console.error("crm automations: rules could not be loaded", errorMessage(error));
    return summary;
  }
  summary.considered = rules.length;
  if (rules.length === 0) return summary;

  for (const rule of rules) {
    if (!matchesAutomationConditions(rule.conditions, event.entity)) {
      summary.skipped += 1;
      await safeRecordRun(businessId, rule, event, "skipped", { reason: "conditions_not_met" });
      continue;
    }

    try {
      if (rule.actionKey === "create_follow_up") {
        const detail = await createFollowUp(businessId, rule, event);
        await safeRecordRun(businessId, rule, event, "applied", detail);
        summary.applied += 1;
      } else if (rule.actionKey === "assign_owner") {
        // The outcome is the run row's own column; the rest is what changed.
        const { outcome, ...detail } = await assignOwner(businessId, rule, event);
        await safeRecordRun(businessId, rule, event, outcome, detail);
        if (outcome === "applied") summary.applied += 1;
        else summary.skipped += 1;
      } else if (rule.actionKey === "notify_growth") {
        await safeRecordRun(businessId, rule, event, "triggered_growth", {
          signal: rule.actionConfig.signal,
          partyId: event.entity.partyId,
          title: event.entity.title,
        });
        summary.growthSignals += 1;
        // The one automation effect that is a *decision about a customer*
        // rather than an edit to a record: somebody may have to explain, later,
        // why Growth was told this customer was at risk.
        await recordCrmAudit({
          businessId,
          kind: "automation.signal_growth",
          entityType: "automation",
          entityId: rule.id,
          summary: `اتوماسیون «${rule.name}» سیگنال رشد را برای «${event.entity.title}» ثبت کرد`,
          detail: { signal: rule.actionConfig.signal, trigger: event.trigger, entityId: event.entity.id },
          actorUserId: event.actor.userId ?? null,
          actorName: event.actor.name,
        });
      } else {
        // A key this version does not carry out: a rule written by a newer
        // version of the app, or a row edited by hand — `saveAutomation`
        // validates the action key, so this is the only way one appears. It is
        // **not** a Growth signal. A trailing `else` that read anything unknown
        // as «signal Growth» would hand a customer to another team because of a
        // typo, and would file an outcome the business cannot explain; so the
        // rule is skipped, with the reason in the log, and no rule counter is
        // bumped — this run did nothing.
        summary.skipped += 1;
        await safeRecordRun(businessId, rule, event, "skipped", { reason: "action_unknown" });
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

async function activeRulesForTrigger(
  businessId: string,
  trigger: CrmAutomationTrigger,
): Promise<CrmAutomationRule[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RULE_COLUMNS} ${RULE_FROM}
      WHERE a.business_id = $1 AND a.trigger_key = $2 AND a.is_active
      ORDER BY a.created_at, a.id`,
    [businessId, trigger],
  );
  return rows.map(toRule);
}

/**
 * File the follow-up the rule asked for, as a real activity.
 *
 * A generated follow-up is an ordinary row in the CRM's own work list — visible
 * in «کارها و پیگیری‌ها», on the customer's timeline and on Today like any
 * other task. An automation that kept its output in an inbox of its own would
 * be a second place work lives, and the second place is the one nobody checks.
 */
async function createFollowUp(
  businessId: string,
  rule: CrmAutomationRule,
  event: CrmAutomationEvent,
): Promise<Record<string, unknown>> {
  const entity = event.entity;
  const member = await memberFor(businessId, rule, entity);
  const offsetDays = rule.actionConfig.offsetDays ?? 0;
  const dueAt = followUpDueAt(await businessToday(businessId), offsetDays);

  const { rows } = await query<{ id: string }>(
    // The same column set `createActivity` writes, including the rule that
    // `assigned_to` and `created_by` are the *snapshots* and never empty: the id
    // columns are the ownership, the text is what the row will keep saying after
    // the member is renamed or deleted.
    `INSERT INTO crm_activities
       (business_id, customer_id, deal_id, case_id, kind, subject, body,
        due_at, assigned_to, assignee_user_id, created_by, created_by_id)
     VALUES ($1, $2, $3, $4, 'task', $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      businessId,
      entity.partyId,
      entity.type === "deal" ? entity.id : null,
      entity.type === "case" ? entity.id : null,
      followUpSubject(event.trigger, entity.title),
      // The body names the rule, so a task nobody remembers creating explains
      // itself. The reason it exists is context; the work is the subject.
      `این کار به‌صورت خودکار توسط اتوماسیون «${rule.name}» ساخته شد.`,
      dueAt,
      member.name ?? "",
      member.userId,
      event.actor.name ?? "",
      event.actor.userId ?? null,
    ],
  );
  return {
    activityId: rows[0]?.id ?? null,
    assignedTo: member.name,
    dueAt,
    offsetDays,
    assigneeFallback: member.fallback,
  };
}

/**
 * Move a record to the rule's member.
 *
 * The two owner columns are written from one resolution every time — the id the
 * system uses and the name a person reads — because a record whose id and name
 * disagree is worse than one with neither. A record already owned by that same
 * member is left alone rather than re-stamped, which keeps the run log honest
 * about what actually changed.
 */
async function assignOwner(
  businessId: string,
  rule: CrmAutomationRule,
  event: CrmAutomationEvent,
): Promise<Record<string, unknown> & { outcome: "applied" | "skipped" }> {
  const memberId = rule.actionConfig.memberId;
  if (!memberId) return { outcome: "skipped", reason: "member_missing" };

  const member = await activeMemberName(businessId, memberId);
  if (member === "missing") return { outcome: "skipped", reason: "member_missing" };
  if (member === "inactive") return { outcome: "skipped", reason: "member_inactive" };

  const entity = event.entity;
  // "Already owned" means owned by *this* member, and only then is the run a
  // skip: re-stamping the same owner would make a rule look busy. A row whose
  // owner is only a legacy name is *not* skipped — writing both columns from
  // one resolution is exactly what this action is for, and refusing it would
  // leave the record in the half-normalised state the ownership work exists to
  // remove.
  if (entity.ownerUserId === memberId) return { outcome: "skipped", reason: "already_owned" };

  const table =
    entity.type === "deal"
      ? { name: "crm_deals", idColumn: "owner_user_id", nameColumn: "owner_user" }
      : entity.type === "case"
        ? { name: "crm_cases", idColumn: "assignee_user_id", nameColumn: "assigned_to" }
        : { name: "crm_leads", idColumn: "owner_user_id", nameColumn: "owner_name" };

  const { rowCount } = await query(
    `UPDATE ${table.name}
        SET ${table.idColumn} = $3, ${table.nameColumn} = $4, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, entity.id, memberId, member],
  );
  if (!rowCount) return { outcome: "skipped", reason: "record_missing" };
  return { outcome: "applied", assignedTo: member, fromUserId: entity.ownerUserId ?? null };
}

/**
 * Who the generated work lands on.
 *
 * The rule's member if they are still here; otherwise the record's own owner,
 * because a follow-up about a deal belongs to whoever holds the deal; otherwise
 * nobody — «بدون مسئول» in the work list, where Today's unassigned queue picks
 * it up. Never the person who happened to trigger the rule by dragging a card:
 * that is how a receptionist ends up owning an enterprise deal.
 */
async function memberFor(
  businessId: string,
  rule: CrmAutomationRule,
  entity: CrmAutomationEntity,
): Promise<{ name: string | null; userId: string | null; fallback: string | null }> {
  const memberId = rule.actionConfig.memberId;
  const member = memberId ? await activeMemberName(businessId, memberId) : "missing";
  if (memberId && member !== "missing" && member !== "inactive") {
    return { name: member, userId: memberId, fallback: null };
  }

  // The rule's member cannot take it (they left, or the row is gone). The run
  // says so, whichever happens next: a task that silently changed hands is the
  // kind of thing somebody has to be able to find later.
  const fallback = member === "inactive" ? "rule_owner_inactive" : "rule_owner_missing";
  const owner = await ownerFallback(businessId, entity);
  if (owner) return { name: owner.name, userId: owner.userId, fallback };
  return { name: null, userId: null, fallback };
}

/**
 * The record's own owner, when they can still receive work.
 *
 * Second in line behind the rule's member, and the reason a deactivated
 * colleague does not leave a trail of unowned work: the task moves to whoever
 * holds the deal, ticket or lead.
 */
async function ownerFallback(
  businessId: string,
  entity: CrmAutomationEntity,
): Promise<{ name: string; userId: string } | null> {
  if (!entity.ownerUserId) return null;
  const owner = await activeMemberName(businessId, entity.ownerUserId);
  if (owner === "missing" || owner === "inactive") return null;
  return { name: owner, userId: entity.ownerUserId };
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
         (business_id, automation_id, automation_name, trigger_key, entity_type,
          entity_id, outcome, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        businessId,
        rule.id,
        rule.name,
        event.trigger,
        event.entity.type,
        isUuid(event.entity.id) ? event.entity.id : null,
        outcome,
        JSON.stringify(pruned(detail)),
      ],
    );
  } catch (error) {
    // The run log is evidence *about* the action; failing to write it must not
    // turn a filed follow-up into a failed one.
    console.error("crm automations: run could not be recorded", errorMessage(error));
  }
}

/**
 * Only counters that mean something bump: a run that applied an action or
 * signalled Growth counts, a skip or a failure does not. A rule whose "last
 * run" was a skip has not run in the sense the number is read.
 */
async function bumpRule(businessId: string, id: string): Promise<void> {
  await query(
    `UPDATE crm_automations
        SET run_count = run_count + 1, last_run_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
}

/** Run detail is stored as jsonb, and `undefined` is not a JSON value. */
function pruned(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
