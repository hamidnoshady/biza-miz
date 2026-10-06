/**
 * Data-quality issues — «مسائل داده».
 *
 * ## What this is
 *
 * The third pillar of the CRM's data-quality workspace, beside «اشخاص تکراری»
 * (two rows that are one person) and «تطبیق فروشگاه آنلاین» (a stranger's
 * orders that need a name). Those two answer *"is this the same human?"*. This
 * one answers the other half of the question: **"is this record usable?"** — a
 * customer nobody can call, a deal attached to no customer, a lead nobody has
 * touched for a fortnight, work that belongs to nobody.
 *
 * ## Why these four, and not a score
 *
 * Each rule names a concrete gap that blocks work the CRM already does, and each
 * is fixable from the screen it is listed on:
 *
 * | kind | the gap | where it is fixed |
 * |---|---|---|
 * | `missing_contact` | a customer with no phone and no email — unreachable | the directory row |
 * | `unlinked_deal` | an open deal with no customer — its history goes nowhere | the deal board |
 * | `stale_lead` | a lead nobody has touched — the enquiry is quietly dying | the lead list |
 * | `unowned_work` | open work that belongs to nobody — it appears in no one's day | the board / service desk |
 *
 * There is deliberately **no overall quality score**. A percentage tells a
 * business nothing it can act on, and a number that moves when unrelated things
 * change teaches people to ignore it. A list of named gaps, each with a real
 * count and a link, is the same information in a form somebody can work through.
 *
 * ## Rules against the tables that own the facts
 *
 * Every rule is one query returning `count(*) OVER ()` beside a `LIMIT`ed page,
 * the same shape `crm-queues.ts` uses, so a count and its list can never
 * disagree. Nothing here writes: fixing a gap is the screen's job, through the
 * screen's own permission. A rule that fails is dropped with a log rather than
 * thrown — one broken query must not blank the workspace.
 *
 * ## What counts as open
 *
 * `closed_at IS NULL` for deals and the three live statuses for tickets and
 * leads — the same expressions the queues already use, so a deal cannot be
 * «open» on one screen and closed on another. Merged-away parties
 * (`merged_into_id`) are excluded everywhere: a row that has already been merged
 * is not a record with a gap, it is a record that has been dealt with.
 */

import { query } from "./db";
import type { CrmSectionKey } from "./crm-permissions";

/** A lead nobody has touched for this long is not being worked. */
export const STALE_LEAD_DAYS = 14;

/** How many examples each issue shows before it says «و N مورد دیگر». */
export const PREVIEW_LIMIT = 5;

export const CRM_DATA_QUALITY_KINDS = [
  "missing_contact",
  "unlinked_deal",
  "stale_lead",
  "unowned_work",
] as const;

export type CrmDataQualityKind = (typeof CRM_DATA_QUALITY_KINDS)[number];

export interface CrmDataQualityPresentation {
  label: string;
  /** The gap, in a sentence — a list nobody can interrogate is one people ignore. */
  why: string;
  /** What fixing it means. */
  action: string;
  /** The screen that fixes it. */
  section: CrmSectionKey;
}

/**
 * The words and the destination for each rule.
 *
 * Kept beside the SQL for the same reason the queues keep theirs beside their
 * queries — but here rather than in `crm-shared.ts`, because nothing on the
 * client needs to name an issue kind before it has been read: the workspace
 * renders what the API returns. (The queues needed the split because the command
 * field names a queue before any fetch.)
 */
export const CRM_DATA_QUALITY_PRESENTATION: Record<CrmDataQualityKind, CrmDataQualityPresentation> = {
  missing_contact: {
    label: "مشتری بدون راه تماس",
    why: "نه شمارهٔ تماس دارد و نه ایمیل؛ هیچ پیگیری یا پیامی به او نمی‌رسد.",
    action: "شماره یا ایمیل را در پروندهٔ شخص ثبت کنید.",
    section: "directory",
  },
  unlinked_deal: {
    label: "فرصت بی‌مشتری",
    why: "فرصت باز است ولی به هیچ مشتری وصل نیست؛ سابقهٔ خرید و تاریخچه‌اش جایی ثبت نمی‌شود.",
    action: "در تختهٔ فرصت‌ها مشتری را به معامله وصل کنید.",
    section: "deals",
  },
  stale_lead: {
    label: "سرنخ بی‌تحرک",
    why: `سرنخ باز است و بیش از ${STALE_LEAD_DAYS} روز است کاری روی آن ثبت نشده؛ پرس‌وجو آرام از دست می‌رود.`,
    action: "یک کار پیگیری ثبت کنید یا وضعیت سرنخ را روشن کنید.",
    section: "leads",
  },
  unowned_work: {
    label: "کار بدون مسئول",
    why: "کار باز است و نه عضوی دارد و نه نامی؛ در «کارهای من» هیچ‌کس دیده نمی‌شود.",
    action: "از فهرست اعضا مسئول انتخاب کنید.",
    section: "activities",
  },
};

export interface CrmDataQualityIssue {
  id: string;
  title: string;
  subtitle: string;
  /** Where the gap is fixed — never a dead end. */
  href: string;
  /** When it was last touched, when the rule knows. */
  at: string | null;
}

export interface CrmDataQualityGroup {
  key: CrmDataQualityKind;
  label: string;
  why: string;
  action: string;
  section: CrmSectionKey;
  /** A real count, never `items.length`. */
  count: number;
  items: CrmDataQualityIssue[];
}

interface IssueRow extends Record<string, unknown> {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  at: unknown;
  count: number;
}

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Customers with neither a phone nor an email — nobody can reach them. */
const MISSING_CONTACT_SQL = `
  SELECT count(*) OVER ()::int AS count, p.id,
         p.name AS title,
         'مشتری از ' || to_char(p.created_at, 'YYYY-MM-DD') AS subtitle,
         '/crm/directory?customer=' || p.id::text AS href,
         p.created_at AS at
    FROM parties p
   WHERE p.business_id = $1
     AND p.is_active
     AND p.merged_into_id IS NULL
     AND p.roles @> ARRAY['customer']::text[]
     AND btrim(coalesce(p.phone, '')) = ''
     AND btrim(coalesce(p.email, '')) = ''
   ORDER BY p.created_at, p.id
   LIMIT $2`;

/** Open deals attached to no customer — their history has nowhere to go. */
const UNLINKED_DEAL_SQL = `
  SELECT count(*) OVER ()::int AS count, d.id,
         d.title AS title,
         coalesce(nullif(btrim(d.owner_user), ''), 'بدون مسئول') ||
           CASE WHEN st.name IS NULL THEN '' ELSE ' · ' || st.name END AS subtitle,
         '/crm/deals?deal=' || d.id::text AS href,
         d.created_at AS at
    FROM crm_deals d
    LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
   WHERE d.business_id = $1
     AND d.customer_id IS NULL
     AND d.closed_at IS NULL
   ORDER BY d.created_at, d.id
   LIMIT $2`;

/** Open leads nobody has touched for a fortnight. */
const STALE_LEAD_SQL = `
  SELECT count(*) OVER ()::int AS count, l.id,
         l.name AS title,
         'آخرین تغییر: ' || to_char(l.updated_at, 'YYYY-MM-DD') AS subtitle,
         '/crm/leads?lead=' || l.id::text AS href,
         l.updated_at AS at
    FROM crm_leads l
   WHERE l.business_id = $1
     AND l.status IN ('new', 'contacted', 'qualified')
     AND l.updated_at < now() - ($3::int * interval '1 day')
   ORDER BY l.updated_at, l.id
   LIMIT $2`;

/**
 * Open work with no member **and** no name.
 *
 * A row carrying a legacy name and no id is *not* listed here: that row's owner
 * exists as text, and the reassignment list is where it belongs. This rule is
 * the honest «nobody».
 */
const UNOWNED_WORK_BASE = `
    SELECT d.id,
           d.title AS title,
           'فرصت · ' || coalesce(st.name, 'بدون مرحله') AS subtitle,
           '/crm/deals?deal=' || d.id::text AS href,
           d.created_at AS at
      FROM crm_deals d
      LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
     WHERE d.business_id = $1
       AND d.owner_user_id IS NULL
       AND btrim(coalesce(d.owner_user, '')) = ''
       AND d.closed_at IS NULL
    UNION ALL
    SELECT k.id,
           k.subject AS title,
           'تیکت · ' || k.status AS subtitle,
           '/crm/cases?case=' || k.id::text AS href,
           k.opened_at AS at
      FROM crm_cases k
     WHERE k.business_id = $1
       AND k.assignee_user_id IS NULL
       AND btrim(coalesce(k.assigned_to, '')) = ''
       AND k.status IN ('open', 'in_progress', 'waiting')`;

const UNOWNED_WORK_SQL = `
  SELECT count(*) OVER ()::int AS count, work.*
    FROM (${UNOWNED_WORK_BASE}) work
   ORDER BY work.at, work.id
   LIMIT $2`;

const RULES: Record<CrmDataQualityKind, { sql: string; params: unknown[] }> = {
  missing_contact: { sql: MISSING_CONTACT_SQL, params: [] },
  unlinked_deal: { sql: UNLINKED_DEAL_SQL, params: [] },
  stale_lead: { sql: STALE_LEAD_SQL, params: [STALE_LEAD_DAYS] },
  unowned_work: { sql: UNOWNED_WORK_SQL, params: [] },
};

/**
 * Every data-quality issue, in the workspace's order.
 *
 * A failing rule is dropped with a log, never thrown: there are four rules
 * behind this screen, and the honest answer to a broken one is the other three.
 */
export async function crmDataQuality(businessId: string): Promise<CrmDataQualityGroup[]> {
  const results = await Promise.all(
    CRM_DATA_QUALITY_KINDS.map(async (key) => {
      const { sql, params } = RULES[key];
      const presentation = CRM_DATA_QUALITY_PRESENTATION[key];
      try {
        // The preview is capped, the count is not: `count(*) OVER ()` is
        // evaluated before `LIMIT`, and the two come from one statement so they
        // can never describe different sets.
        const { rows } = await query<IssueRow>(sql, [businessId, ...params, PREVIEW_LIMIT]);
        return {
          key,
          ...presentation,
          count: rows[0]?.count ?? 0,
          items: rows.map((row) => ({
            id: row.id,
            title: row.title,
            subtitle: row.subtitle,
            href: row.href,
            at: isoOf(row.at),
          })),
        };
      } catch (error) {
        console.error(`[crm-data-quality] rule ${key} failed`, error);
        return null;
      }
    }),
  );
  return results.filter((group): group is CrmDataQualityGroup => group !== null);
}
