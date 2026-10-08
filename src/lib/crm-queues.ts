/**
 * Smart queues — «صف‌های هوشمند».
 *
 * ## What this is
 *
 * The CRM's home answers one question: **who needs attention, and why**. That
 * is not a dashboard of totals — a total is the same number every morning and
 * tells nobody what to do. A queue is a *named rule* over the tables that
 * already own the facts, with three things attached to every row it returns:
 *
 *  1. **Why it is here** — the rule, in a sentence, because a prioritised list
 *     nobody can interrogate is a list people learn to ignore.
 *  2. **How big it is** — a real `count(*)`, never `items.length`. The CRM
 *     overview shipped a segment counter that reported the page size as the
 *     total; the same mistake here would say «۳ مورد» for a queue of 900.
 *  3. **One obvious next action** — every item carries a link to the screen
 *     that acts on it (the person's file, the case, the deal), so the queue is
 *     a route into work rather than a report about work.
 *
 * ## Why the rules are code, not user input
 *
 * The vocabulary is a closed list in this file. Nothing a member types reaches
 * a query, so "never generate raw SQL from AI" is not a policy this module
 * follows — it is a property of its shape. A natural-language layer (unbuilt)
 * would have to translate intent into *one of these keys*, and the worst a bad
 * translation could do is show the wrong queue.
 *
 * The user-authored half is `crm-saved-views-service.ts`, whose filter document
 * is validated against a closed vocabulary per entity before it is stored or
 * used. This file does not read it yet: a built-in queue is a rule the product
 * owns, and a saved view is a filter the business owns — merging them before
 * the list screens honour every filter key would produce a view that looks
 * applied and is not. See `docs/crm-relationship-os.md`.
 *
 * ## Reading the SQL
 *
 * Every queue is one query returning `count(*) OVER ()` beside a `LIMIT`ed page.
 * The window function is evaluated before `LIMIT`, which is exactly the
 * "real total plus a preview" shape needed — and writing it as two numbers from
 * one statement is what keeps a count and its list from ever disagreeing.
 */

import { query } from "./db";
import { phonePairKeySql } from "./parties-service";
import { businessToday, businessTimeZone } from "./business-day-service";
import { caseSla } from "./crm-case-service";
import { CASE_BREACH_SQL_CASES, CASE_OPEN_STATUSES, caseBreachSql } from "./crm-case-clock";
import { crmQueueView, type CrmQueueView } from "./crm-queue-views";
import { LIFECYCLE_STAGES, type LifecycleStage } from "./crm-scoring";
import {
  CRM_QUEUE_KEYS,
  CRM_QUEUE_PRESENTATION,
  NEW_LEAD_DAYS,
  STALLED_DEAL_DAYS,
  VIP_SILENCE_DAYS,
  isCasePriority,
  isCaseStatus,
  queueKeysForSection,
  type CasePriority,
  type CaseStatus,
  type CrmQueueKey,
} from "./crm-shared";

/** How many rows of a queue the home page previews. The count is never this. */
const PREVIEW_LIMIT = 4;

// The thresholds and the queue vocabulary live in `crm-shared.ts`: the client
// half (section headers, the command field) has to name a queue without
// importing this module, which reaches the database.
export { CRM_QUEUE_KEYS, queueKeysForSection };
export type { CrmQueueKey };

export interface CrmQueueItem {
  id: string;
  /** The main line — the person, the deal or the ticket. */
  title: string;
  /** The supporting fact that makes it worth attention. */
  subtitle: string;
  /** When it is about time (a due date, a silence), as an ISO timestamp. */
  at?: string | null;
  /** Where the row acts on it. Always inside the CRM. */
  href: string;
}

export interface CrmQueue {
  key: CrmQueueKey;
  label: string;
  /** Why a row is in this queue. Shown under the heading, always. */
  why: string;
  /** Real total, `count(*)`, not the preview length. */
  count: number;
  /** What to do about it, when there is more to it than the list. */
  action: string;
  items: CrmQueueItem[];
  /**
   * The same rows as a filter its owning screen can open, when the rule is
   * expressible in that screen's vocabulary (`crm-queue-views.ts`).
   */
  view: CrmQueueView | null;
}

/**
 * Attach a queue's words to its rows.
 *
 * Every rule does exactly this, and doing it through one function is what keeps
 * a queue's label from being written twice — the presentation lives in
 * `crm-shared.ts`, where a client component can read it without pulling `db`
 * into the browser bundle.
 */
function withQueueMeta(
  key: CrmQueueKey,
  result: { count: number; items: CrmQueueItem[] },
): CrmQueue {
  return { key, ...CRM_QUEUE_PRESENTATION[key], ...result, view: crmQueueView(key) };
}

const CUSTOMER_FILE = (id: string) => `/crm/persons/${id}`;
const ACTIVITIES = "/crm/activities";
const CASES = "/crm/cases";
const DEALS = "/crm/deals";
const DUPLICATES = "/crm/duplicates";
const RECONCILIATION = "/crm/reconciliation";
const LEADS = "/crm/leads";

interface QueueRow extends Record<string, unknown> {
  total: string;
  id: string;
  title: string;
  subtitle: string;
  at: string | null;
  href: string;
}

/**
 * Read one queue: its real total and its preview page.
 *
 * `total` comes from the window function; a row-less result means an empty
 * queue, not a missing one, so the count falls back to zero rather than null.
 */
async function readQueue(sql: string, params: unknown[]): Promise<{ count: number; items: CrmQueueItem[] }> {
  const { rows } = await query<QueueRow>(sql, params);
  return {
    count: Number(rows[0]?.total ?? 0),
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      at: row.at,
      href: row.href,
    })),
  };
}

/**
 * Every queue, newest information first.
 *
 * The queues are read in parallel on purpose: twelve small indexed queries
 * answer one screen, and running them in sequence would make the home page as
 * slow as the sum of its parts for no benefit. Each one is independently
 * correct, and each carries its own total so a failing queue can be dropped
 * rather than taking the page down — see `crmQueues`.
 */
function queueQueries(
  businessId: string,
  today: string,
  timeZone: string,
): Record<Exclude<CrmQueueKey, "sla_risk">, Promise<CrmQueue>> {
  const limit = PREVIEW_LIMIT;

  return {
    overdue_follow_ups: readQueue(
      `SELECT count(*) OVER ()::text AS total, a.id,
              a.subject AS title,
              coalesce(p.name, '') || CASE WHEN a.assigned_to = '' THEN ' · بدون مسئول' ELSE ' · ' || a.assigned_to END AS subtitle,
              a.due_at AS at,
              CASE WHEN a.customer_id IS NULL THEN '${ACTIVITIES}' ELSE '${CUSTOMER_FILE}' || a.customer_id END AS href
         FROM crm_activities a
         LEFT JOIN parties p ON p.id = a.customer_id
        WHERE a.business_id = $1
          AND a.completed_at IS NULL AND a.due_at IS NOT NULL
          -- Calendar day in the BUSINESS zone, the one the today parameter
          -- came from: a session-zone cast here disagrees with it for the
          -- 20:30-24:00 UTC slice of every day (see businessTimeZone).
          AND (a.due_at AT TIME ZONE $4)::date < $2::date
        ORDER BY a.due_at, a.id
        LIMIT $3`,
      [businessId, today, limit, timeZone],
    ).then((result) => withQueueMeta("overdue_follow_ups", result)),

    due_today: readQueue(
      `SELECT count(*) OVER ()::text AS total, a.id,
              a.subject AS title,
              coalesce(p.name, '') || CASE WHEN a.assigned_to = '' THEN ' · بدون مسئول' ELSE ' · ' || a.assigned_to END AS subtitle,
              a.due_at AS at,
              CASE WHEN a.customer_id IS NULL THEN '${ACTIVITIES}' ELSE '${CUSTOMER_FILE}' || a.customer_id END AS href
         FROM crm_activities a
         LEFT JOIN parties p ON p.id = a.customer_id
        WHERE a.business_id = $1
          AND a.completed_at IS NULL AND a.due_at IS NOT NULL
          AND (a.due_at AT TIME ZONE $4)::date = $2::date
        ORDER BY a.due_at, a.id
        LIMIT $3`,
      [businessId, today, limit, timeZone],
    ).then((result) => withQueueMeta("due_today", result)),

    stalled_deals: readQueue(
      `SELECT count(*) OVER ()::text AS total, d.id,
              d.title AS title,
              coalesce(p.name, 'بدون مشتری') || ' · ' || st.name || ' · ' ||
                floor(EXTRACT(EPOCH FROM (now() - coalesce(d.last_activity_at, d.stage_entered_at, d.updated_at, d.created_at))) / 86400)::text || ' روز بی‌خبر' AS subtitle,
              coalesce(d.last_activity_at, d.stage_entered_at, d.updated_at, d.created_at) AS at,
              '${DEALS}?deal=' || d.id AS href
         FROM crm_deals d
         LEFT JOIN parties p ON p.id = d.customer_id
         LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
        WHERE d.business_id = $1
          AND d.closed_at IS NULL
          AND coalesce(d.last_activity_at, d.stage_entered_at, d.updated_at, d.created_at) < now() - ($2 || ' days')::interval
        ORDER BY coalesce(d.last_activity_at, d.stage_entered_at, d.updated_at, d.created_at), d.id
        LIMIT $3`,
      [businessId, String(STALLED_DEAL_DAYS), limit],
    ).then((result) => withQueueMeta("stalled_deals", result)),

    high_value_open: readQueue(
      `WITH threshold AS (
         SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY value_rial) AS cut
           FROM crm_deals
          WHERE business_id = $1 AND closed_at IS NULL AND value_rial > 0
       )
       SELECT count(*) OVER ()::text AS total, d.id,
              d.title AS title,
              coalesce(p.name, 'بدون مشتری') || ' · ' || st.name || ' · ' || d.value_rial::text || ' ریال' AS subtitle,
              d.expected_close_date::timestamptz AS at,
              '${DEALS}?deal=' || d.id AS href
         FROM crm_deals d
         CROSS JOIN threshold t
         LEFT JOIN parties p ON p.id = d.customer_id
         LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
        WHERE d.business_id = $1
          AND d.closed_at IS NULL
          AND t.cut IS NOT NULL
          AND d.value_rial >= t.cut
          AND d.value_rial > 0
        ORDER BY d.value_rial DESC, d.id
        LIMIT $2`,
      [businessId, limit],
    ).then((result) => withQueueMeta("high_value_open", result)),

    unassigned_cases: readQueue(
      `SELECT count(*) OVER ()::text AS total, k.id,
              '#' || k.case_number::text || ' · ' || k.subject AS title,
              coalesce(p.name, 'بدون مشتری') || ' · ' || k.priority AS subtitle,
              k.opened_at AS at,
              '${CASES}?case=' || k.id AS href
         FROM crm_cases k
         LEFT JOIN parties p ON p.id = k.customer_id
        WHERE k.business_id = $1
          AND k.status = ANY($2)
          AND k.assignee_user_id IS NULL
          AND btrim(k.assigned_to) = ''
        ORDER BY k.opened_at, k.id
        LIMIT $3`,
      [businessId, [...CASE_OPEN_STATUSES], limit],
    ).then((result) => withQueueMeta("unassigned_cases", result)),

    /*
     * Work owned by somebody who cannot sign in.
     *
     * Not folded into «بی‌مسئول»: a case whose owner left is *claimed*, and
     * its owner is the reason it is stuck. The queue exists because the id
     * columns make the question answerable — a free-text name would have left
     * a departed colleague's work looking perfectly assigned forever.
     *
     * Reassignment is manual by design; nothing moves a portfolio of real
     * customers on a role change.
     */
    departed_owner: readQueue(
      `SELECT count(*) OVER ()::text AS total, w.id, w.title, w.subtitle, w.at, w.href
         FROM (
           SELECT d.id, d.title AS title,
                  coalesce(p.name, 'بدون مشتری') || ' · معامله · مسئول: ' || u.name AS subtitle,
                  coalesce(d.last_activity_at, d.stage_entered_at, d.updated_at, d.created_at) AS at,
                  '${DEALS}?deal=' || d.id AS href
             FROM crm_deals d
             JOIN (SELECT id, coalesce(nullif(btrim(full_name), ''), email) AS name
                     FROM users WHERE is_active = false) u ON u.id = d.owner_user_id
             LEFT JOIN parties p ON p.id = d.customer_id
            WHERE d.business_id = $1 AND d.closed_at IS NULL
           UNION ALL
           SELECT k.id, '#' || k.case_number::text || ' · ' || k.subject AS title,
                  coalesce(p.name, 'بدون مشتری') || ' · تیکت · مسئول: ' || u.name AS subtitle,
                  k.opened_at AS at,
                  '${CASES}?case=' || k.id AS href
             FROM crm_cases k
             JOIN (SELECT id, coalesce(nullif(btrim(full_name), ''), email) AS name
                     FROM users WHERE is_active = false) u ON u.id = k.assignee_user_id
             LEFT JOIN parties p ON p.id = k.customer_id
            WHERE k.business_id = $1 AND k.status IN ('open', 'in_progress', 'waiting')
         ) AS w
        ORDER BY w.at, w.id
        LIMIT $2`,
      [businessId, limit],
    ).then((result) => withQueueMeta("departed_owner", result)),

    waiting_on_customer: readQueue(
      `SELECT count(*) OVER ()::text AS total, k.id,
              '#' || k.case_number::text || ' · ' || k.subject AS title,
              coalesce(p.name, 'بدون مشتری') || ' · ' ||
                floor(EXTRACT(EPOCH FROM (now() - coalesce(k.waiting_since, k.updated_at))) / 86400)::text || ' روز منتظر مشتری' AS subtitle,
              coalesce(k.waiting_since, k.updated_at) AS at,
              '${CASES}?case=' || k.id AS href
         FROM crm_cases k
         LEFT JOIN parties p ON p.id = k.customer_id
        WHERE k.business_id = $1 AND k.status = 'waiting'
        ORDER BY coalesce(k.waiting_since, k.updated_at), k.id
        LIMIT $2`,
      [businessId, limit],
    ).then((result) => withQueueMeta("waiting_on_customer", result)),

    new_leads: readQueue(
      `SELECT count(*) OVER ()::text AS total, l.id,
              l.name || CASE WHEN l.organization = '' THEN '' ELSE ' · ' || l.organization END AS title,
              'سرنخ تازه · ' || CASE WHEN l.owner_name = '' THEN 'بدون مسئول' ELSE l.owner_name END AS subtitle,
              l.created_at AS at,
              '${LEADS}' AS href
         FROM crm_leads l
        WHERE l.business_id = $1
          AND l.status = 'new'
          AND l.converted_at IS NULL
          AND l.created_at >= now() - ($2 || ' days')::interval
        ORDER BY l.created_at DESC, l.id
        LIMIT $3`,
      [businessId, String(NEW_LEAD_DAYS), limit],
    ).then((result) => withQueueMeta("new_leads", result)),

    new_identities: readQueue(
      `SELECT count(*) OVER ()::text AS total, e.id,
              coalesce(nullif(e.remote_name, ''), e.remote_email, e.remote_phone, e.remote_id) AS title,
              e.provider || ' · ' ||
                CASE e.status WHEN 'needs_review' THEN 'نیازمند بررسی' WHEN 'conflict' THEN 'تعارض اطلاعات' ELSE 'بدون تطبیق' END AS subtitle,
              e.created_at AS at,
              '${RECONCILIATION}' AS href
         FROM crm_external_profiles e
        WHERE e.business_id = $1
          AND e.status IN ('unmapped', 'needs_review', 'conflict')
        ORDER BY e.created_at DESC, e.id
        LIMIT $2`,
      [businessId, limit],
    ).then((result) => withQueueMeta("new_identities", result)),

    at_risk_customers: readQueue(
      `SELECT count(*) OVER ()::text AS total, p.id,
              p.name AS title,
              ${lifecycleCaseSql()} || ' · آخرین تعامل: ' ||
                CASE WHEN p.last_interaction_at IS NULL THEN 'ثبت نشده'
                     ELSE floor(EXTRACT(EPOCH FROM (now() - p.last_interaction_at)) / 86400)::text || ' روز پیش' END AS subtitle,
              p.last_interaction_at AS at,
              '${CUSTOMER_FILE}' || p.id AS href
         FROM parties p
        WHERE p.business_id = $1
          AND p.merged_into_id IS NULL AND p.is_active
          AND p.lifecycle_stage = ANY($2::text[])
        ORDER BY p.last_interaction_at NULLS FIRST, p.id
        LIMIT $3`,
      [businessId, AT_RISK_STAGES, limit],
    ).then((result) => withQueueMeta("at_risk_customers", result)),

    vip_follow_up: readQueue(
      `SELECT count(*) OVER ()::text AS total, p.id,
              p.name AS title,
              ${lifecycleCaseSql()} || ' · آخرین تعامل: ' ||
                CASE WHEN p.last_interaction_at IS NULL THEN 'ثبت نشده'
                     ELSE floor(EXTRACT(EPOCH FROM (now() - p.last_interaction_at)) / 86400)::text || ' روز پیش' END AS subtitle,
              p.last_interaction_at AS at,
              '${CUSTOMER_FILE}' || p.id AS href
         FROM parties p
        WHERE p.business_id = $1
          AND p.merged_into_id IS NULL AND p.is_active
          AND p.lifecycle_stage = ANY($2::text[])
          AND (p.last_interaction_at IS NULL OR p.last_interaction_at < now() - ($3 || ' days')::interval)
        ORDER BY p.last_interaction_at NULLS FIRST, p.id
        LIMIT $4`,
      [businessId, VIP_STAGES, String(VIP_SILENCE_DAYS), limit],
    ).then((result) => withQueueMeta("vip_follow_up", result)),

    possible_duplicates: readQueue(
      // The same `coalesce(phone_bidx, phone_e164)` key `duplicateCandidates()`
      // matches on. A count computed a different way from the list it labels is
      // worse than no count at all — the overview learned that once already.
      `SELECT count(*) OVER ()::text AS total,
              a.id,
              a.name AS title,
              'شمارهٔ مشترک با ' || b.name AS subtitle,
              a.created_at AS at,
              '${DUPLICATES}' AS href
         FROM parties a
         JOIN parties b
           ON b.business_id = a.business_id
          AND ${phonePairKeySql("b")} = ${phonePairKeySql("a")}
          AND a.id < b.id
        WHERE a.business_id = $1
          AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
          AND ${phonePairKeySql("a")} IS NOT NULL
        ORDER BY a.created_at, a.id
        LIMIT $2`,
      [businessId, limit],
    ).then((result) => withQueueMeta("possible_duplicates", result)),
  };
}

/** Lifecycle stages that mean "this relationship is slipping away". */
const AT_RISK_STAGES: readonly LifecycleStage[] = ["at_risk", "cant_lose", "needs_attention"];

/** The stages worth a personal call before they cool off. */
const VIP_STAGES: readonly LifecycleStage[] = ["champion", "loyal"];

/** The Persian label of the row's lifecycle stage, or an empty string. */
function lifecycleCaseSql(): string {
  return `CASE p.lifecycle_stage ${Object.values(LIFECYCLE_STAGES)
    .map((meta) => `WHEN '${meta.key}' THEN '${meta.label}'`)
    .join(" ")} ELSE 'بدون امتیاز' END`;
}

/**
 * The SLA queue — the shared breach rule, evaluated in SQL.
 *
 * This used to be the one queue whose answer lived in JavaScript: it fetched
 * every open case that *might* breach and filtered them with `caseSla`, on the
 * grounds that a `WHERE` clause would be a second expression of a subtle rule
 * («elapsed time minus everything spent waiting on the customer, paused while
 * the ball is in their court») and a queue that contradicts the ticket screen
 * beside it is worse than a slow queue.
 *
 * That reasoning was right about the danger and wrong about the fix. The rule
 * now *has* a SQL expression — `caseBreachSql()` in `crm-case-clock.ts`, built
 * from the same constants and the same waiting expression as the TypeScript —
 * because the service desk's `breached` filter needed to narrow in the database.
 * Both implementations are run over the same fixtures by
 * `integration/crm-case-sla.integration.test.ts`, so using it here does not add
 * a second opinion; it removes one. The queue's rows, its `count(*)`, the row's
 * badge, the SLA panel and the filter a view stores are now one rule.
 *
 * The JavaScript that remains is presentation: the days-late in a subtitle are
 * formatted from the same `caseSla` the screen's badge would use.
 */
async function readSlaRiskQueue(businessId: string): Promise<CrmQueue> {
  const params: unknown[] = [businessId];
  // The same open set the desk's `openOnly` filter means, so «خطر از دست رفتن
  // مهلت» and the link it renders (`?open=1&breached=1`) can only ever name the
  // same rows — a resolved case that answered late is history, not risk.
  params.push([...CASE_OPEN_STATUSES]);
  const open = `$${params.length}`;
  params.push(JSON.stringify(CASE_BREACH_SQL_CASES.targets));
  const targets = `$${params.length}`;
  params.push([...CASE_BREACH_SQL_CASES.closed]);
  const closed = `$${params.length}`;
  params.push(PREVIEW_LIMIT);
  const limit = `$${params.length}`;

  const { rows } = await query<{
    total: string;
    id: string;
    caseNumber: string;
    subject: string;
    customerName: string | null;
    priority: string;
    status: string;
    openedAt: string;
    firstResponseAt: string | null;
    resolvedAt: string | null;
    waitingSeconds: string;
    waitingSince: string | null;
  }>(
    `SELECT count(*) OVER ()::text AS total, k.id, k.case_number::text AS "caseNumber",
            k.subject, p.name AS "customerName", k.priority, k.status,
            k.opened_at AS "openedAt", k.first_response_at AS "firstResponseAt",
            k.resolved_at AS "resolvedAt", k.waiting_seconds::text AS "waitingSeconds",
            k.waiting_since AS "waitingSince"
       FROM crm_cases k
       LEFT JOIN parties p ON p.id = k.customer_id
      WHERE k.business_id = $1
        AND k.status = ANY(${open})
        AND ${caseBreachSql({ targets, closed })}
      ORDER BY CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               k.opened_at, k.id
      LIMIT ${limit}`,
    params,
  );

  const items = rows.flatMap((row) => {
    if (!isCaseStatus(row.status) || !isCasePriority(row.priority)) return [];
    const sla = caseSla({
      priority: row.priority as CasePriority,
      status: row.status as CaseStatus,
      openedAt: row.openedAt,
      firstResponseAt: row.firstResponseAt,
      resolvedAt: row.resolvedAt,
      waitingSeconds: Number(row.waitingSeconds),
      waitingSince: row.waitingSince,
    });
    // The predicate above already decided this; the guard is a refusal to
    // *show* a row the rule calls fine, so a divergence would hide a row rather
    // than invent a lateness. Nothing reaches it while the agreement test holds.
    if (!sla.breached) return [];
    const hoursLate = Math.max(1, Math.round(-sla.remainingSeconds / 3600));
    return [
      {
        id: row.id,
        title: `#${row.caseNumber} · ${row.subject}`,
        subtitle: `${row.customerName ?? "بدون مشتری"} · ${hoursLate} ساعت از مهلت گذشته`,
        at: row.openedAt,
        href: `${CASES}?case=${row.id}`,
      },
    ];
  });

  return withQueueMeta("sla_risk", {
    count: Number(rows[0]?.total ?? 0),
    items,
  });
}

/**
 * Every queue, most urgent first.
 *
 * A queue whose query fails is **dropped**, not fatal: the home page is twelve
 * independent questions, and a missing table or a slow index on one of them
 * should cost the reader that queue rather than the whole screen. The failure is
 * logged, because a queue that silently disappears for a week is its own bug.
 */
export async function crmQueues(businessId: string): Promise<CrmQueue[]> {
  // `today` is the business zone's calendar day; the queues that bucket stored
  // timestamps by day must cast in that same zone, or the two disagree for the
  // 3.5 hours of every UTC day that the branch is already tomorrow.
  const [today, timeZone] = await Promise.all([
    businessToday(businessId),
    businessTimeZone(businessId),
  ]);
  // `sla_risk` is not in this map on purpose: it is the one queue with a rule
  // SQL cannot state without restating it, so it runs through `caseSla`.
  const queries: Record<CrmQueueKey, Promise<CrmQueue>> = {
    ...queueQueries(businessId, today, timeZone),
    sla_risk: readSlaRiskQueue(businessId),
  };

  const results = await Promise.all(
    CRM_QUEUE_KEYS.map((key) =>
      queries[key].catch((error: unknown) => {
        console.error("crm queue failed", key, error);
        return null;
      }),
    ),
  );
  return results.filter((queue): queue is CrmQueue => queue !== null);
}
