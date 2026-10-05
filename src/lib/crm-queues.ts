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
import { businessToday } from "./business-day-service";
import { caseSla } from "./crm-case-service";
import { LIFECYCLE_STAGES, type LifecycleStage } from "./crm-scoring";
import { isCasePriority, isCaseStatus, type CasePriority, type CaseStatus } from "./crm-shared";

/** How many rows of a queue the home page previews. The count is never this. */
const PREVIEW_LIMIT = 4;

/** Days without activity after which an open deal counts as stalled. */
const STALLED_DEAL_DAYS = 7;

/** Days since the last interaction after which a VIP counts as needing a call. */
const VIP_SILENCE_DAYS = 30;

/** A new lead is "new" for this long before it becomes a stale enquiry. */
const NEW_LEAD_DAYS = 7;

export const CRM_QUEUE_KEYS = [
  "overdue_follow_ups",
  "due_today",
  "sla_risk",
  "waiting_on_customer",
  "stalled_deals",
  "high_value_open",
  "unassigned_cases",
  "vip_follow_up",
  "at_risk_customers",
  "new_leads",
  "new_identities",
  "possible_duplicates",
] as const;

export type CrmQueueKey = (typeof CRM_QUEUE_KEYS)[number];

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
}

/** The queues a section owns, for the section screens' own headers. */
export function queueKeysForSection(section: string): CrmQueueKey[] {
  switch (section) {
    case "activities":
      return ["overdue_follow_ups", "due_today"];
    case "cases":
      return ["sla_risk", "waiting_on_customer", "unassigned_cases"];
    case "deals":
      return ["stalled_deals", "high_value_open"];
    case "directory":
      return ["at_risk_customers", "vip_follow_up"];
    case "leads":
      return ["new_leads"];
    case "reconciliation":
      return ["new_identities"];
    case "duplicates":
      return ["possible_duplicates"];
    default:
      return [];
  }
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
          AND a.due_at::date < $2::date
        ORDER BY a.due_at, a.id
        LIMIT $3`,
      [businessId, today, limit],
    ).then((result) => ({
      key: "overdue_follow_ups" as const,
      label: "پیگیری‌های عقب‌افتاده",
      why: "کارهایی که موعدشان گذشته و هنوز انجام نشده‌اند.",
      action: "هر کدام را انجام دهید یا موعدش را جابه‌جا کنید.",
      ...result,
    })),

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
          AND a.due_at::date = $2::date
        ORDER BY a.due_at, a.id
        LIMIT $3`,
      [businessId, today, limit],
    ).then((result) => ({
      key: "due_today" as const,
      label: "کارهای امروز",
      why: "کارهایی که موعدشان امروز است.",
      action: "امروز تمامشان کنید تا فردا عقب‌افتاده نشوند.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "stalled_deals" as const,
      label: "فرصت‌های راکد",
      why: `معامله‌های بازی که ${STALLED_DEAL_DAYS} روز است هیچ فعالیتی نداشته‌اند.`,
      action: "تماس بگیرید، یا اگر دیگر واقعی نیست ببندیدش.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "high_value_open" as const,
      label: "فرصت‌های پرارزش باز",
      why: "بیست درصد بالای معامله‌های باز از نظر مبلغ — همیشه ارزش یک نگاه دارند.",
      action: "قدم بعدی هر کدام را مشخص کنید؛ این‌ها بیشترین اثر را دارند.",
      ...result,
    })),

    unassigned_cases: readQueue(
      `SELECT count(*) OVER ()::text AS total, k.id,
              '#' || k.case_number::text || ' · ' || k.subject AS title,
              coalesce(p.name, 'بدون مشتری') || ' · ' || k.priority AS subtitle,
              k.opened_at AS at,
              '${CASES}?case=' || k.id AS href
         FROM crm_cases k
         LEFT JOIN parties p ON p.id = k.customer_id
        WHERE k.business_id = $1
          AND k.status IN ('open', 'in_progress')
          AND k.assignee_user_id IS NULL
          AND btrim(k.assigned_to) = ''
        ORDER BY k.opened_at, k.id
        LIMIT $2`,
      [businessId, limit],
    ).then((result) => ({
      key: "unassigned_cases" as const,
      label: "تیکت‌های بی‌مسئول",
      why: "تیکت‌های بازی که مالکی ندارند، پس کسی خودش را مسئولشان نمی‌داند.",
      action: "به یک عضو تیم واگذار کنید.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "waiting_on_customer" as const,
      label: "منتظر مشتری",
      why: "کار از سمت ما تمام است و منتظر پاسخ مشتری هستیم.",
      action: "یک یادآوری بفرستید؛ یا اگر پاسخ نیامد تیکت را ببندید.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "new_leads" as const,
      label: "سرنخ‌های تازه",
      why: `پرس‌وجوهایی که در ${NEW_LEAD_DAYS} روز گذشته آمده‌اند و هنوز کسی سراغشان نرفته است.`,
      action: "زود تماس بگیرید؛ سرنخ تازه سرد می‌شود.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "new_identities" as const,
      label: "هویت‌های تازهٔ سایت و فروشگاه",
      why: "خریداران آنلاینی که هنوز به پرونده‌ای وصل نشده‌اند یا تطبیقشان قطعی نیست.",
      action: "تطبیق را تأیید کنید تا خریدشان روی پروندهٔ درست بنشیند.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "at_risk_customers" as const,
      label: "مشتریان در معرض ریزش",
      why: "امتیاز رفتاری می‌گوید این‌ها ارزششان را داشته‌اند و حالا دور شده‌اند.",
      action: "تماس شخصی یا پیشنهاد بازگشت؛ پیش از آن‌که فراموش کنند.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "vip_follow_up" as const,
      label: "مشتریان طلایی و وفادار",
      why: `${VIP_SILENCE_DAYS} روز است با بهترین مشتریان تماس نگرفته‌ایم.`,
      action: "یک تماس کوتاه؛ نگه‌داشتن این‌ها ارزان‌تر از جذب تازه است.",
      ...result,
    })),

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
    ).then((result) => ({
      key: "possible_duplicates" as const,
      label: "پرونده‌های مشکوک به تکرار",
      why: "دو پرونده با شمارهٔ تماس یکسان — شاید یک نفر باشند.",
      action: "پیش از ادغام، پیش‌نمایش را ببینید؛ ادغام برگشت‌پذیر نیست.",
      ...result,
    })),
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
 * The SLA queue, computed by the case service's own rule.
 *
 * Deliberately **not** a SQL re-implementation of the response target. The
 * rule is subtle — elapsed time minus everything spent waiting on the customer,
 * paused while the ball is in their court — and a second expression of it in a
 * `WHERE` clause is how a queue comes to contradict the ticket screen beside it.
 * `caseSla` is the same pure function the case list uses.
 *
 * The SQL pre-filter exists only to bound the rows fetched: it selects active
 * cases that *could* breach the shortest target (urgent, 4h) plus the priority
 * needed to apply the real rule exactly. A queue of tens of thousands of open
 * cases is not a state a business reaches before it has other problems, and
 * when it does the pre-filter keeps 99% of them out of memory without ever
 * deciding the answer.
 */
async function readSlaRiskQueue(businessId: string): Promise<CrmQueue> {
  const { rows } = await query<{
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
    `SELECT k.id, k.case_number::text AS "caseNumber", k.subject,
            p.name AS "customerName", k.priority, k.status,
            k.opened_at AS "openedAt", k.first_response_at AS "firstResponseAt",
            k.resolved_at AS "resolvedAt", k.waiting_seconds::text AS "waitingSeconds",
            k.waiting_since AS "waitingSince"
       FROM crm_cases k
       LEFT JOIN parties p ON p.id = k.customer_id
      WHERE k.business_id = $1
        AND k.status IN ('open', 'in_progress')
        AND EXTRACT(EPOCH FROM (now() - k.opened_at)) - k.waiting_seconds > 4 * 3600
      ORDER BY CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               k.opened_at, k.id
      LIMIT 500`,
    [businessId],
  );

  const breached = rows.flatMap((row) => {
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

  return {
    key: "sla_risk",
    label: "خطر از دست رفتن مهلت",
    why: "تیکت‌های بازی که از مهلت پاسخ‌گویی خودشان گذشته‌اند (زمان انتظار مشتری حساب نمی‌شود).",
    action: "پاسخ بدهید یا به عضو دیگری بسپارید.",
    count: breached.length,
    items: breached.slice(0, PREVIEW_LIMIT),
  };
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
  const today = await businessToday(businessId);
  // `sla_risk` is not in this map on purpose: it is the one queue with a rule
  // SQL cannot state without restating it, so it runs through `caseSla`.
  const queries: Record<CrmQueueKey, Promise<CrmQueue>> = {
    ...queueQueries(businessId, today),
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
