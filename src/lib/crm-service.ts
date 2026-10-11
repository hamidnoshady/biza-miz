/**
 * The CRM app's data layer: the customer file, notes, duplicate detection and
 * merge, consent with its audit trail, activities, deals and cases.
 *
 * `crm-shared.ts` holds the pure vocabulary (stages, statuses, labels, the
 * consent-merge rule); `segments.ts` and `crm-scoring.ts` hold the pure
 * engines. This file is the DB-touching half and, per repo convention, has no
 * direct unit test — its behaviour is pinned by
 * `integration/crm.integration.test.ts`.
 *
 * Three rules run through everything below, and each exists because its
 * absence would be a real bug rather than an untidiness:
 *
 * 1. **Consent changes are never silent.** Every write that touches
 *    `sms_consent`/`marketing_consent` also appends to `crm_consent_events`,
 *    in the same statement path, so "who turned this on?" always has an
 *    answer. That is the whole reason the messaging phase can be trusted.
 * 2. **A merge moves references and archives; it never deletes and never
 *    touches an accounting document.** A posted journal entry stays exactly as
 *    posted — a merge is a directory correction, not a ledger correction.
 * 3. **Nothing about a customer is inferred where it can be read.** RFM is
 *    stored only because quintiles are a whole-population computation; every
 *    other number on the file is derived at read time from the table that owns
 *    it.
 */

import { query, withTenant, withTenantTransaction } from "./db";
import { customerFinancialSummary } from "./crm-accounting-contract";
import {
  defaultPipeline,
  getStage,
  legacyStageKey,
  type PipelineStage,
} from "./crm-pipeline-service";
import { businessToday } from "./business-day-service";
import { getBusinessDek } from "./business-keys";
import { encryptOptional, phoneBlindIndex, phoneKind, phoneLast4 } from "./field-crypto";
import { mobileReachableSql, phonePairKeySql } from "./parties-service";
import { normalizePhone } from "./phone";
import {
  duplicateConfidence,
  mergeConsent,
  mergeTags,
  type ActivityKind,
  type CasePriority,
  type CaseStatus,
  type ConsentChannel,
  type ConsentSource,
  type DealStage,
  type DuplicateReason,
} from "./crm-shared";
import { CASE_BREACH_SQL_CASES, CASE_OPEN_STATUSES, caseBreachSql } from "./crm-case-clock";
import { daysBetween, lifetimeValue, scorePopulation, type CustomerRfmInput, type RfmScore } from "./crm-scoring";
import { customerHealth as healthOf, type CustomerHealth } from "./crm-health";
import { resolveOwner } from "./crm-ownership";
import type { LifecycleStage } from "./crm-scoring";
import {
  movedPartyReferences,
  partyReferenceKey,
  partyReferenceLabels,
  previewPartyReferences,
  type PartyReference,
} from "./party-merge-references";
import { recordCrmAudit } from "./crm-audit-service";
import { runCrmAutomations, type CrmAutomationRunSummary } from "./crm-automation-service";
import { dealStageMoved } from "./crm-automation-rules";
import { isUuid } from "./uuid";

/**
 * A merge was asked to move a reference the live schema cannot support.
 *
 * Thrown rather than swallowed: a merge is irreversible, so a reference that
 * was declared as needing to move and then could not is a reason to refuse the
 * whole operation, not a reason to finish it with one table left behind.
 */
class PartyMergeBlockedError extends Error {
  constructor(readonly references: readonly string[]) {
    super(`party_merge_blocked:${references.join(",")}`);
    this.name = "PartyMergeBlockedError";
  }
}

// ---------------------------------------------------------------------------
// The customer file
// ---------------------------------------------------------------------------

export interface CustomerFile {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  address: string | null;
  birthday: string | null;
  tags: string[];
  notes: string | null;
  smsConsent: boolean;
  marketingConsent: boolean;
  isActive: boolean;
  mergedIntoId: string | null;
  createdAt: string;
  /**
   * The relationship's explainable state — «وضعیت رابطه».
   *
   * Computed from the aggregates on this page rather than from a second
   * scoring pass (see `crm-health.ts`), and it carries its own reasons: the
   * file shows the state *and* the facts behind it, so nobody has to trust a
   * colour.
   */
  health: CustomerHealth;
  /** Purchase aggregates, derived at read time. */
  stats: {
    orderCount: number;
    totalSpentRial: number;
    firstPurchaseDate: string | null;
    lastPurchaseDate: string | null;
    daysSinceLastPurchase: number | null;
    loyaltyPoints: number;
    openCases: number;
    openDeals: number;
    lifetime: ReturnType<typeof lifetimeValue>;
  };
  rfm: {
    recency: number | null;
    frequency: number | null;
    monetary: number | null;
    stage: string | null;
    scoredAt: string | null;
  };
  /**
   * What the books say about this customer, not what the CRM thinks.
   *
   * `receivableRial` comes straight from `ar-service.listCustomerBalances`,
   * which reconstructs it from every journal line posted to A/R. Recomputing
   * it here from orders would produce a second, subtly different number — it
   * would miss manual journal entries and credit notes — and the moment a CRM
   * screen and the trial balance disagree about a debt, the owner cannot tell
   * which one is lying. So the CRM asks accounting and shows its answer.
   * Positive means the customer owes the business.
   */
  accounting: {
    receivableRial: number;
    /** False when the chart of accounts has no A/R account yet. */
    hasLedger: boolean;
    /** The part of the balance past its due date. */
    overdueRial: number;
    /** Oldest aging bucket holding anything — «بیش از ۹۰ روز» and the like. */
    oldestBucketLabel: string | null;
  };
}

/**
 * One customer, with everything the file page shows above the timeline.
 *
 * The aggregates use the same business-day bucketing and the same
 * "completed orders only" rule as `crm-segments-service.ts`, because a
 * customer whose file says «۱۲ خرید» must be in the segment that asks for
 * «حداقل ۱۲ خرید».
 */
export async function getCustomerFile(
  businessId: string,
  customerId: string,
): Promise<CustomerFile | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id, c.name, c.phone, c.phone_e164 AS "phoneE164", c.email, c.address,
            c.birthday::text AS birthday, c.tags, c.notes,
            c.sms_consent AS "smsConsent", c.marketing_consent AS "marketingConsent",
            c.is_active AS "isActive", c.merged_into_id AS "mergedIntoId",
            c.created_at AS "createdAt",
            c.rfm_recency AS "rfmRecency", c.rfm_frequency AS "rfmFrequency",
            c.rfm_monetary AS "rfmMonetary", c.lifecycle_stage AS "lifecycleStage",
            c.rfm_scored_at AS "rfmScoredAt",
            coalesce(os.order_count, 0)::int      AS "orderCount",
            coalesce(os.total_spent, 0)::bigint   AS "totalSpentRial",
            os.first_purchase_date::text          AS "firstPurchaseDate",
            os.last_purchase_date::text           AS "lastPurchaseDate",
            coalesce(ps.points, 0)::int           AS "loyaltyPoints",
            coalesce(oc.open_cases, 0)::int       AS "openCases",
            coalesce(od.open_deals, 0)::int       AS "openDeals"
       FROM parties c
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS order_count,
                coalesce(sum(o.total), 0)::bigint AS total_spent,
                min(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS first_purchase_date,
                max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS last_purchase_date
           FROM orders o
           JOIN locations l ON l.id = o.location_id
          WHERE o.customer_id = c.id AND l.business_id = $1
            AND o.status = 'completed' AND o.closed_at IS NOT NULL
       ) os ON true
       LEFT JOIN LATERAL (
         SELECT greatest(coalesce(sum(points), 0), 0)::int AS points
           FROM customer_points
          WHERE customer_id = c.id AND business_id = $1
            AND (expires_at IS NULL OR expires_at >= current_date)
       ) ps ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS open_cases FROM crm_cases
          WHERE customer_id = c.id AND business_id = $1
            AND status IN ('open', 'in_progress', 'waiting')
       ) oc ON true
       LEFT JOIN LATERAL (
         -- Keyed on the stage row's outcome, not on the legacy stage text.
         -- A business that renamed its stages or added its own still gets a
         -- correct open count; matching on the string 'won' would miss a
         -- custom winning stage entirely and overstate the open pipeline.
         -- COALESCE covers deals written before migration 0157, which have a
         -- stage string but no stage_id yet.
         SELECT count(*)::int AS open_deals FROM crm_deals d
          LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
          WHERE d.customer_id = c.id AND d.business_id = $1
            AND COALESCE(st.outcome, d.stage) NOT IN ('won', 'lost')
       ) od ON true
      WHERE c.business_id = $1 AND c.id = $2
        AND c.roles && ARRAY['customer']::text[]`,
    [businessId, customerId],
  );
  const row = rows[0];
  if (!row) return null;

  const today = await businessToday(businessId);
  // Ask the books rather than recomputing, through the CRM's read-only
  // accounting contract. `available` is false when the business has no A/R
  // account yet, which is a real state for a cash-only cafe — distinct from
  // "has an account and owes nothing", and the UI must not render it as ۰.
  const arBalance = await customerFinancialSummary(businessId, customerId);
  const lastPurchaseDate = (row.lastPurchaseDate as string | null) ?? null;
  const firstPurchaseDate = (row.firstPurchaseDate as string | null) ?? null;
  const orderCount = Number(row.orderCount ?? 0);
  const totalSpentRial = Number(row.totalSpentRial ?? 0);

  const dayDiff = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

  // Computed once and handed to both the stats and the health classifier: two
  // derivations of the same cadence is how a page ends up quoting «هر ۳۰ روز»
  // beside a health state that used a different number.
  const lifetime = lifetimeValue({
    totalSpentRial,
    orderCount,
    activeDays: firstPurchaseDate && lastPurchaseDate ? dayDiff(firstPurchaseDate, lastPurchaseDate) : 0,
  });
  const daysSinceLastPurchase = lastPurchaseDate ? dayDiff(lastPurchaseDate, today) : null;

  return {
    id: row.id as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? null,
    phoneE164: (row.phoneE164 as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    birthday: (row.birthday as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    notes: (row.notes as string | null) ?? null,
    smsConsent: Boolean(row.smsConsent),
    marketingConsent: Boolean(row.marketingConsent),
    isActive: Boolean(row.isActive),
    mergedIntoId: (row.mergedIntoId as string | null) ?? null,
    createdAt: String(row.createdAt),
    stats: {
      orderCount,
      totalSpentRial,
      firstPurchaseDate,
      lastPurchaseDate,
      daysSinceLastPurchase,
      loyaltyPoints: Number(row.loyaltyPoints ?? 0),
      openCases: Number(row.openCases ?? 0),
      openDeals: Number(row.openDeals ?? 0),
      lifetime,
    },
    rfm: {
      recency: (row.rfmRecency as number | null) ?? null,
      frequency: (row.rfmFrequency as number | null) ?? null,
      monetary: (row.rfmMonetary as number | null) ?? null,
      stage: (row.lifecycleStage as string | null) ?? null,
      scoredAt: (row.rfmScoredAt as string | null) ?? null,
    },
    health: healthOf({
      lifecycleStage: (row.lifecycleStage as string | null) ?? null,
      orderCount,
      daysSinceLastPurchase,
      purchaseIntervalDays: lifetime.purchaseIntervalDays,
      openCases: Number(row.openCases ?? 0),
      openDeals: Number(row.openDeals ?? 0),
      overdueRial: arBalance.overdueRial,
    }),
    accounting: {
      receivableRial: arBalance.balanceRial,
      hasLedger: arBalance.available,
      // The collections signal. Owing money is normal; owing money that is
      // past due is the thing a person looking at this file needs to see.
      overdueRial: arBalance.overdueRial,
      oldestBucketLabel: arBalance.oldestBucketLabel,
    },
  };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

interface CustomerNote extends Record<string, unknown> {
  id: string;
  customerId: string;
  body: string;
  isPinned: boolean;
  createdBy: string;
  createdAt: string;
}

const NOTE_COLUMNS = `id, customer_id AS "customerId", body, is_pinned AS "isPinned",
  created_by AS "createdBy", created_at AS "createdAt"`;

export async function listCustomerNotes(
  businessId: string,
  customerId: string,
): Promise<CustomerNote[]> {
  const { rows } = await query<CustomerNote>(
    `SELECT ${NOTE_COLUMNS} FROM customer_notes
      WHERE business_id = $1 AND customer_id = $2
      -- id last, so notes written in the same second keep a stable order.
      ORDER BY is_pinned DESC, created_at DESC, id`,
    [businessId, customerId],
  );
  return rows;
}

/**
 * Add a note.
 *
 * Refuses to write on a customer whose `merged_into_id` is set. A merged
 * customer is archived, not deleted, "kept only for history" (Phase 36c) —
 * but the file page's own merge banner links away to the surviving winner,
 * so writing here is a mistake nobody meant to make, and one the merge never
 * propagates: the note would sit on a record the app steers everyone away
 * from, invisible on the winner's file that the rest of the business now
 * uses. Returns `null` for "no such open customer" so callers can 404/409
 * without a second query.
 */
export async function addCustomerNote(
  businessId: string,
  customerId: string,
  input: { body: string; isPinned?: boolean; createdBy?: string },
): Promise<CustomerNote | null> {
  const { rows } = await query<CustomerNote>(
    `INSERT INTO customer_notes (business_id, customer_id, body, is_pinned, created_by)
     SELECT $1, $2, $3, $4, $5
      WHERE EXISTS (
        SELECT 1 FROM parties WHERE business_id = $1 AND id = $2 AND merged_into_id IS NULL
      )
     RETURNING ${NOTE_COLUMNS}`,
    [businessId, customerId, input.body.trim(), input.isPinned ?? false, input.createdBy ?? ""],
  );
  return rows[0] ?? null;
}

/**
 * Delete one note.
 *
 * `customerId`, when passed, is enforced in the WHERE clause — not merely
 * checked afterwards — so a request addressed to customer A's URL can never
 * remove a note that actually belongs to customer B, even though every note
 * id is already tenant-scoped by `businessId`. The customer file page always
 * passes it; the autopilot reverter (which deletes only the row it just
 * created, by an id nobody else can guess) is the one caller that may omit
 * it.
 */
export async function deleteCustomerNote(
  businessId: string,
  noteId: string,
  customerId?: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM customer_notes WHERE business_id = $1 AND id = $2
       AND ($3::uuid IS NULL OR customer_id = $3)`,
    [businessId, noteId, customerId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Same cross-customer guard as {@link deleteCustomerNote}, for the same reason. */
export async function toggleNotePin(
  businessId: string,
  noteId: string,
  pinned: boolean,
  customerId?: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE customer_notes SET is_pinned = $3 WHERE business_id = $1 AND id = $2
       AND ($4::uuid IS NULL OR customer_id = $4)`,
    [businessId, noteId, pinned, customerId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Consent — every change is an event
// ---------------------------------------------------------------------------

interface ConsentUpdate {
  channel: ConsentChannel;
  granted: boolean;
  source?: ConsentSource;
  note?: string;
  changedBy?: string;
}

/**
 * Set a consent flag and record why.
 *
 * The UPDATE and the audit INSERT are one transaction: a consent change whose
 * event failed to write would be a change nobody can account for, which is
 * exactly the situation the audit exists to prevent. Writing the event first
 * and the flag second would have the same hole in the other direction, so
 * both go in one `withTenant` transaction.
 *
 * No-ops are still recorded when they arrive with a *reason* — a customer
 * confirming "yes, keep sending" is a fact worth having — but a redundant
 * write from a UI toggle that did not actually change anything is dropped, so
 * the trail stays readable.
 */
export async function setConsent(
  businessId: string,
  customerId: string,
  update: ConsentUpdate,
): Promise<{ changed: boolean; smsConsent: boolean; marketingConsent: boolean } | null> {
  const column = update.channel === "sms" ? "sms_consent" : "marketing_consent";

  return withTenant(businessId, async () => {
    // `merged_into_id IS NULL` (plus the `roles`/`is_active` checks already
    // here): a merged customer is archived, not the live record it once
    // was, and this write would never reach the winner the merge banner
    // points everyone at — it would just sit unseen on a row the rest of the
    // app treats as history.
    const { rows: current } = await query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM parties
         WHERE business_id = $1 AND id = $2
           AND roles && ARRAY['customer']::text[] AND is_active AND merged_into_id IS NULL`,
      [businessId, customerId],
    );
    if (!current[0]) return null;

    const before = update.channel === "sms" ? current[0].sms_consent : current[0].marketing_consent;
    const changed = before !== update.granted;
    const hasReason = Boolean(update.note?.trim()) || update.source === "customer_request";

    if (changed) {
      await query(
        `UPDATE parties SET ${column} = $3, updated_at = now()
           WHERE business_id = $1 AND id = $2
             AND roles && ARRAY['customer']::text[] AND is_active AND merged_into_id IS NULL`,
        [businessId, customerId, update.granted],
      );
    }
    if (changed || hasReason) {
      await query(
        `INSERT INTO crm_consent_events (business_id, customer_id, channel, granted, source, note, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          businessId,
          customerId,
          update.channel,
          update.granted,
          update.source ?? "staff",
          update.note?.trim() ?? "",
          update.changedBy ?? "",
        ],
      );
    }

    return {
      changed,
      smsConsent: update.channel === "sms" ? update.granted : current[0].sms_consent,
      marketingConsent:
        update.channel === "email" ? update.granted : current[0].marketing_consent,
    };
  });
}

export interface ConsentEvent extends Record<string, unknown> {
  id: string;
  customerId: string;
  customerName: string;
  channel: string;
  granted: boolean;
  source: string;
  note: string;
  changedBy: string;
  createdAt: string;
}

/** The consent audit trail, business-wide or for one customer. */
export async function listConsentEvents(
  businessId: string,
  options: { customerId?: string; limit?: number } = {},
): Promise<ConsentEvent[]> {
  const params: unknown[] = [businessId];
  let where = "e.business_id = $1";
  if (options.customerId) {
    params.push(options.customerId);
    where += ` AND e.customer_id = $${params.length}`;
  }
  params.push(options.limit ?? 200);
  const { rows } = await query<ConsentEvent>(
    `SELECT e.id, e.customer_id AS "customerId", c.name AS "customerName",
            e.channel, e.granted, e.source, e.note, e.changed_by AS "changedBy",
            e.created_at AS "createdAt"
       FROM crm_consent_events e
       JOIN parties c ON c.id = e.customer_id
        AND c.business_id = e.business_id
        AND c.roles && ARRAY['customer']::text[]
        AND c.is_active
        AND c.merged_into_id IS NULL
      WHERE ${where}
      -- e.id breaks ties: a consent change and its audit row share a
      -- timestamp, and an unstable order makes the history read differently
      -- on each refresh.
      ORDER BY e.created_at DESC, e.id
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Consent coverage — «چقدر از فاز بعد قابل استفاده است». */
export async function consentCoverage(businessId: string): Promise<{
  total: number;
  smsGranted: number;
  emailGranted: number;
  /** Unique live customers with current consent on at least one channel. */
  partiesWithConsent: number;
  withMobile: number;
  withEmail: number;
  smsReachable: number;
  emailReachable: number;
}> {
  const { rows } = await query<Record<string, string>>(
    // `with_mobile` / `sms_reachable` ask "can this number receive an SMS", and
    // used to answer `phone_e164 IS NOT NULL` — which is "parses as an Iranian
    // number" and counted every front-desk landline as reachable. Phase 24
    // Wave 3 gave the classification its own column (`phone_kind`), so the
    // question can be asked honestly, and can go on being asked once the
    // number itself is ciphertext.
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE sms_consent)::text AS sms_granted,
            count(*) FILTER (WHERE marketing_consent)::text AS email_granted,
            count(*) FILTER (WHERE sms_consent OR marketing_consent)::text AS parties_with_consent,
            count(*) FILTER (WHERE ${mobileReachableSql()})::text AS with_mobile,
            count(*) FILTER (WHERE email IS NOT NULL AND btrim(email) <> '')::text AS with_email,
            count(*) FILTER (WHERE sms_consent AND ${mobileReachableSql()})::text AS sms_reachable,
            count(*) FILTER (WHERE marketing_consent AND email IS NOT NULL AND btrim(email) <> '')::text AS email_reachable
       FROM parties
      WHERE business_id = $1
        AND roles && ARRAY['customer']::text[]
        AND is_active
        AND merged_into_id IS NULL`,
    [businessId],
  );
  const row = rows[0] ?? {};
  const n = (key: string) => Number(row[key] ?? 0);
  return {
    total: n("total"),
    smsGranted: n("sms_granted"),
    emailGranted: n("email_granted"),
    partiesWithConsent: n("parties_with_consent"),
    withMobile: n("with_mobile"),
    withEmail: n("with_email"),
    // Consent alone is not reachability: consent plus a number an SMS can
    // actually arrive at is. The gap between these two is what makes a
    // campaign under-deliver, so both are reported.
    smsReachable: n("sms_reachable"),
    emailReachable: n("email_reachable"),
  };
}

// ---------------------------------------------------------------------------
// Duplicates and merge
// ---------------------------------------------------------------------------

interface DuplicateCandidate {
  reason: DuplicateReason;
  confidence: number;
  left: { id: string; name: string; phone: string | null; email: string | null; orderCount: number; createdAt: string };
  right: { id: string; name: string; phone: string | null; email: string | null; orderCount: number; createdAt: string };
}

/**
 * Find probable duplicates.
 *
 * Matching is on the **canonical phone** rather than the typed string, which
 * is the only reason this finds anything at all: `0912…` and `+98912…` are the
 * same customer and different text. Since Phase 24 Wave 3 the canonical form
 * is `coalesce(phone_bidx, phone_e164)` — the blind index where the row has
 * been encrypted, the plaintext canonical form where it has not yet. Both are
 * derived from the same `phone.ts` normalisation, so the two agree; the
 * coalesce is what keeps this working on an install with no master key, and it
 * collapses to `phone_bidx` alone when the plaintext columns are dropped. Email matches case-insensitively; an identical *name* alone
 * is offered at low confidence because «محمد محمدی» is not one person.
 *
 * Nothing here merges. The result is a list of questions for a human.
 */
export async function findDuplicates(
  businessId: string,
  options: { limit?: number } = {},
): Promise<DuplicateCandidate[]> {
  const limit = options.limit ?? 50;
  const candidates: DuplicateCandidate[] = [];

  const selectPair = `
    a.id AS left_id, a.name AS left_name, a.phone AS left_phone, a.email AS left_email,
    a.created_at AS left_created,
    (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.customer_id = a.id AND l.business_id = $1
        AND o.status = 'completed' AND o.closed_at IS NOT NULL)::int AS left_orders,
    b.id AS right_id, b.name AS right_name, b.phone AS right_phone, b.email AS right_email,
    b.created_at AS right_created,
    (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.customer_id = b.id AND l.business_id = $1
        AND o.status = 'completed' AND o.closed_at IS NOT NULL)::int AS right_orders
  `;
  // Operators commonly paste addresses with surrounding spaces, and Persian
  // names arrive with Arabic ي/ك or repeated whitespace. Compare the meaning,
  // not those input artefacts. These expressions intentionally remain stricter
  // than fuzzy matching: a name-only suggestion is already the riskiest kind.
  const emailKey = (alias: string) => `lower(btrim(${alias}.email))`;
  const nameKey = (alias: string) =>
    `lower(regexp_replace(translate(btrim(${alias}.name), 'يىك', 'ییک'), '\\s+', ' ', 'g'))`;

  // `pg` hands back a JS Date for timestamptz. `String(date)` would emit
  // "Sat Aug 29 2026 …", which every other CRM route avoids by letting JSON
  // serialise the Date to ISO. Normalising here keeps one date format across
  // the whole API rather than one screen's worth of exception.
  const isoOf = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);

  const push = (reason: DuplicateReason, row: Record<string, unknown>) => {
    candidates.push({
      reason,
      confidence: duplicateConfidence(reason),
      left: {
        id: row.left_id as string,
        name: row.left_name as string,
        phone: (row.left_phone as string | null) ?? null,
        email: (row.left_email as string | null) ?? null,
        orderCount: Number(row.left_orders ?? 0),
        createdAt: isoOf(row.left_created),
      },
      right: {
        id: row.right_id as string,
        name: row.right_name as string,
        phone: (row.right_phone as string | null) ?? null,
        email: (row.right_email as string | null) ?? null,
        orderCount: Number(row.right_orders ?? 0),
        createdAt: isoOf(row.right_created),
      },
    });
  };

  // `a.id < b.id` yields each unordered pair exactly once — without it every
  // duplicate would be reported twice, mirrored.
  //
  // Phase 24 Wave 3 — matched on `coalesce(phone_bidx, phone_e164)`, which is
  // the same prefer-the-ciphertext-fall-back-to-plaintext rule the read paths
  // use, expressed as a join. Both columns hold one canonical value per
  // number (the blind index is an HMAC *of* the e164 form), and their value
  // spaces cannot collide — 32 hex characters versus `+98…`. When the
  // plaintext columns are dropped this becomes a plain `b.phone_bidx =
  // a.phone_bidx`.
  //
  // Mid-backfill, a pair where only one side has been encrypted yet does not
  // match. That direction is deliberate: the cost is a duplicate suggestion
  // that appears one backfill run later, not a wrong pair offered for merge.
  const leftPhone = phonePairKeySql("a");
  const rightPhone = phonePairKeySql("b");
  const { rows: byPhone } = await query<Record<string, unknown>>(
    `SELECT ${selectPair} FROM parties a JOIN parties b
        ON b.business_id = a.business_id
       AND ${rightPhone} = ${leftPhone}
       AND a.id < b.id
      WHERE a.business_id = $1 AND ${leftPhone} IS NOT NULL
        AND a.roles && ARRAY['customer']::text[] AND b.roles && ARRAY['customer']::text[]
        AND a.is_active AND b.is_active
        AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
      LIMIT $2`,
    [businessId, limit],
  );
  byPhone.forEach((row) => push("phone", row));

  const { rows: byEmail } = await query<Record<string, unknown>>(
    `SELECT ${selectPair} FROM parties a JOIN parties b
        ON b.business_id = a.business_id AND ${emailKey("b")} = ${emailKey("a")} AND a.id < b.id
      WHERE a.business_id = $1 AND a.email IS NOT NULL AND btrim(a.email) <> ''
        AND a.roles && ARRAY['customer']::text[] AND b.roles && ARRAY['customer']::text[]
        AND a.is_active AND b.is_active
        AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
        -- Already reported by the stronger phone rule; reporting the same pair
        -- twice would make the list look worse than the data is.
        AND (${leftPhone} IS NULL OR ${rightPhone} IS NULL OR ${leftPhone} <> ${rightPhone})
      LIMIT $2`,
    [businessId, limit],
  );
  byEmail.forEach((row) => push("email", row));

  const { rows: byName } = await query<Record<string, unknown>>(
    `SELECT ${selectPair} FROM parties a JOIN parties b
        ON b.business_id = a.business_id
       AND ${nameKey("b")} = ${nameKey("a")} AND a.id < b.id
      WHERE a.business_id = $1 AND btrim(a.name) <> ''
        AND a.roles && ARRAY['customer']::text[] AND b.roles && ARRAY['customer']::text[]
        AND a.is_active AND b.is_active
        AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
        AND (${leftPhone} IS NULL OR ${rightPhone} IS NULL OR ${leftPhone} <> ${rightPhone})
        AND (a.email IS NULL OR b.email IS NULL OR ${emailKey("a")} <> ${emailKey("b")})
      LIMIT $2`,
    [businessId, limit],
  );
  byName.forEach((row) => push("name", row));

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

export interface MergePreview {
  winner: { id: string; name: string };
  loser: { id: string; name: string };
  /** Counts keyed by table name; label them with `moveLabels`. */
  moves: Record<string, number>;
  /**
   * Persian labels for the `moves` keys, sent with the preview rather than
   * restated in the dialog. The screen used to keep its own map of nine
   * labels while the merge touched more than twenty tables, so an owner
   * confirming an irreversible action saw a silent subset of it.
   */
  moveLabels: Record<string, string>;
  /** The consent the merged record will end up with, and why. */
  resultingConsent: { smsConsent: boolean; marketingConsent: boolean };
  resultingTags: string[];
}

/**
 * Build the SQL that re-points one declared reference at the winner.
 *
 * Derived from the registry rather than hand-written per table, because a
 * hand-written list is exactly what fell behind every time the platform grew a
 * customer-linked table. Both tenancy shapes are covered: a table with its own
 * `business_id`, and a branch-scoped table that reaches the tenant through
 * `locations`. Table and column names come from a frozen in-repo constant, never
 * from a request, so there is no interpolation of untrusted text here.
 */
function partyReferenceFilter(reference: PartyReference, alias: string): string {
  // `filterSql` is a constant from party-merge-references.ts with `{t}` where
  // the alias goes. It narrows a shared table to the rows that really hold a
  // party id — `integration_mappings.local_id` is a party only on
  // customer-kind rows, and moving a product mapping would corrupt the
  // catalogue.
  if (!reference.filterSql) return "";
  return ` AND (${reference.filterSql.replaceAll("{t}", alias)})`;
}

function movePartyReferenceSql(reference: PartyReference): string {
  if (reference.scope === "location") {
    return `UPDATE ${reference.table} t SET ${reference.column} = $3
              FROM locations l
             WHERE l.id = t.location_id AND l.business_id = $1
               AND t.${reference.column} = $2${partyReferenceFilter(reference, "t")}`;
  }
  if (reference.scope === "parent" && reference.parent) {
    const p = reference.parent;
    return `UPDATE ${reference.table} t SET ${reference.column} = $3
              FROM ${p.table} pt
             WHERE pt.${p.parentColumn} = t.${p.childColumn} AND pt.business_id = $1
               AND t.${reference.column} = $2${partyReferenceFilter(reference, "t")}`;
  }
  return `UPDATE ${reference.table} AS t SET ${reference.column} = $3
           WHERE t.business_id = $1 AND t.${reference.column} = $2${partyReferenceFilter(reference, "t")}`;
}

/**
 * Statements that clear the loser's rows which cannot survive the move.
 *
 * Two shapes, both *declared* in the registry rather than discovered by
 * catching a constraint violation:
 *
 * - **self-edges**: a relationship A→B where B is the winner would become B→B,
 *   which the table's own CHECK forbids;
 * - **collisions**: a row the winner already has an equivalent of, under the
 *   table's unique key. The winner's copy is kept — it belongs to the record
 *   the business chose to survive.
 *
 * Run before the UPDATE, so the move itself can never abort halfway. A merge
 * that fails partway through is the worst available outcome: the operation is
 * irreversible and there is nothing to roll forward to.
 */
function prunePartyReferenceSql(reference: PartyReference): string[] {
  const statements: string[] = [];
  if (reference.scope !== "business") return statements;
  const filter = partyReferenceFilter(reference, "t");

  if (reference.selfEdgeColumn) {
    statements.push(
      `DELETE FROM ${reference.table} AS t
        WHERE t.business_id = $1 AND t.${reference.column} = $2
          AND t.${reference.selfEdgeColumn} = $3${filter}`,
    );
  }
  if (reference.uniqueWithSql && reference.uniqueWithSql.length > 0) {
    const match = reference.uniqueWithSql.map((column) => `w.${column} = t.${column}`).join(" AND ");
    statements.push(
      `DELETE FROM ${reference.table} AS t
        WHERE t.business_id = $1 AND t.${reference.column} = $2${filter}
          AND EXISTS (
            SELECT 1 FROM ${reference.table} w
             WHERE w.business_id = $1 AND w.${reference.column} = $3 AND ${match}
          )`,
    );
  }
  return statements;
}

/** The same shape, as a COUNT — used by the preview and by the moved tally. */
function countPartyReferenceSql(reference: PartyReference): string {
  if (reference.scope === "location") {
    return `SELECT count(*)::text AS count FROM ${reference.table} t
              JOIN locations l ON l.id = t.location_id AND l.business_id = $1
             WHERE t.${reference.column} = $2${partyReferenceFilter(reference, "t")}`;
  }
  if (reference.scope === "parent" && reference.parent) {
    const p = reference.parent;
    return `SELECT count(*)::text AS count FROM ${reference.table} t
              JOIN ${p.table} pt ON pt.${p.parentColumn} = t.${p.childColumn} AND pt.business_id = $1
             WHERE t.${reference.column} = $2${partyReferenceFilter(reference, "t")}`;
  }
  return `SELECT count(*)::text AS count FROM ${reference.table} AS t
           WHERE t.business_id = $1 AND t.${reference.column} = $2${partyReferenceFilter(reference, "t")}`;
}

/**
 * Reference counts for the merge preview — «چه چیزی به کجا می‌رود».
 *
 * Only the references the registry marks `preview` are itemised: an owner
 * confirming a destructive merge needs to see orders, money and open work, not
 * every internal join. The counts are keyed by table so the UI can label them
 * from the same registry the service moved them with.
 */
async function countReferences(
  businessId: string,
  customerId: string,
): Promise<Record<string, number>> {
  const references = previewPartyReferences();
  // Sequential, not Promise.all. This runs inside the merge transaction, where
  // every statement shares one pinned client, and a single pg client cannot
  // execute concurrent queries — firing them in parallel makes them queue
  // anyway while emitting a deprecation warning, and on older drivers
  // interleaves them incorrectly. Two dozen fast COUNTs in sequence is not the
  // bottleneck in an operation that is already rewriting twenty tables.
  const counts: number[] = [];
  for (const reference of references) {
    try {
      const { rows } = await query<{ count: string }>(countPartyReferenceSql(reference), [
        businessId,
        customerId,
      ]);
      counts.push(Number(rows[0]?.count ?? 0));
    } catch {
      // A table that does not exist on this install (an industry table in a
      // trade that never had it) must not take the preview down. The merge
      // itself tolerates the same thing, for the same reason.
      counts.push(0);
    }
  }

  const result: Record<string, number> = {};
  references.forEach((reference, index) => {
    // Registry order, and one entry per table even when two columns of the
    // same table are previewed.
    result[reference.table] = (result[reference.table] ?? 0) + counts[index];
  });
  return result;
}

export async function previewMerge(
  businessId: string,
  winnerId: string,
  loserId: string,
): Promise<MergePreview | null> {
  if (winnerId === loserId) return null;
  const { rows } = await query<{
    id: string;
    name: string;
    tags: string[] | null;
    sms_consent: boolean;
    marketing_consent: boolean;
  }>(
    `SELECT id, name, tags, sms_consent, marketing_consent
       FROM parties
      WHERE business_id = $1 AND id = ANY($2::uuid[])
        AND roles && ARRAY['customer']::text[] AND is_active AND merged_into_id IS NULL`,
    [businessId, [winnerId, loserId]],
  );
  const winner = rows.find((row) => row.id === winnerId);
  const loser = rows.find((row) => row.id === loserId);
  if (!winner || !loser) return null;

  return {
    winner: { id: winner.id, name: winner.name },
    loser: { id: loser.id, name: loser.name },
    moves: await countReferences(businessId, loserId),
    moveLabels: partyReferenceLabels(),
    resultingConsent: {
      // Intersection, not union — see mergeConsent's doc comment.
      smsConsent: mergeConsent(winner.sms_consent, loser.sms_consent),
      marketingConsent: mergeConsent(winner.marketing_consent, loser.marketing_consent),
    },
    resultingTags: mergeTags(winner.tags, loser.tags),
  };
}

interface MergeResult {
  winnerId: string;
  loserId: string;
  moved: Record<string, number>;
}

/**
 * Merge two customer records.
 *
 * What it does, in one transaction:
 * - repoints **every reference the registry classifies as `move`** at the
 *   winner — orders, receipts, cheques, instalments, loyalty, message
 *   recipients, reservations, repairs, layaway, gold accounts, notes,
 *   activities, deals, cases, consent events, relationships, custom field
 *   values, external store profiles and the integration customer mappings.
 *   The list lives in `party-merge-references.ts` and is checked against
 *   PostgreSQL's own foreign-key metadata by an integration test, so a new
 *   customer-linked table cannot be forgotten the way the WooCommerce mapping
 *   was: it fails the suite until somebody states what a merge should do;
 * - unions the tags, **intersects** the consent, and fills any field the winner
 *   left blank from the loser;
 * - archives the loser (`is_active = false`, `merged_into_id = winner`) rather
 *   than deleting it, so nothing that referenced it can dangle;
 * - writes a `crm_merges` row recording exactly what moved.
 *
 * What it deliberately does **not** do: touch a single accounting document. An
 * order that was posted stays posted, with the same total, on the same date, in
 * the same period. Re-pointing `orders.customer_id` changes who the sale is
 * attributed to in the CRM; it changes no journal line, so the trial balance
 * before and after a merge is identical. That property is asserted in the
 * integration test, because it is the one an accountant would ask about.
 *
 * Irreversible, and therefore never automatic: `findDuplicates` proposes, a
 * human disposes. It is also not an `ACTION_CATALOG` entry, so no assistant,
 * autopilot job or MCP client can reach it.
 */
export async function mergeCustomers(
  businessId: string,
  winnerId: string,
  loserId: string,
  options: { mergedBy?: string; mergedByUserId?: string | null } = {},
): Promise<MergeResult | null> {
  if (winnerId === loserId) return null;

  // Captured inside the transaction, read after it, so the audit line can
  // name the two records without a second lookup against rows that are now
  // archived.
  let winnerName = "";
  let loserName = "";

  // Transactional. A merge locks both records, moves twenty-odd references
  // and archives the loser; a failure partway through is the worst available
  // outcome because the operation is irreversible. The FOR UPDATE below also
  // only means anything inside a transaction.
  const result = await withTenantTransaction(businessId, async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      phone: string | null;
      phone_e164: string | null;
      phone_enc: Buffer | null;
      phone_bidx: string | null;
      phone_last4: string | null;
      phone_kind: string | null;
      email: string | null;
      address: string | null;
      birthday: string | null;
      notes: string | null;
      tags: string[] | null;
      sms_consent: boolean;
      marketing_consent: boolean;
      merged_into_id: string | null;
    }>(
      `SELECT id, name, phone, phone_e164, phone_enc, phone_bidx, phone_last4, phone_kind,
              email, address, birthday::text AS birthday,
              notes, tags, sms_consent, marketing_consent, merged_into_id
         FROM parties
        WHERE business_id = $1 AND id = ANY($2::uuid[])
          AND roles && ARRAY['customer']::text[] AND is_active AND merged_into_id IS NULL
        ORDER BY id FOR UPDATE`,
      [businessId, [winnerId, loserId]],
    );
    const winner = rows.find((row) => row.id === winnerId);
    const loser = rows.find((row) => row.id === loserId);
    // A record that already lost a merge must not be merged again — that would
    // produce a chain whose history is unreadable.
    if (!winner || !loser || loser.merged_into_id || winner.merged_into_id) return null;
    winnerName = winner.name;
    loserName = loser.name;

    const moved = await countReferences(businessId, loserId);

    // Re-point every reference the registry classifies as `move`. Driving this
    // from `PARTY_REFERENCES` rather than from a list written here is the whole
    // fix: the hand-written version fell one table behind every integration the
    // platform grew, and the symptom was silent — a WooCommerce customer
    // mapping left pointing at the archived loser, so the next webhook resolved
    // an online order onto a customer who no longer exists.
    //
    // Each statement is scoped by `business_id` (or by the location's business),
    // so a merge can never reach across tenants even if ids leaked into a
    // request. Table and column names come from the frozen registry constant,
    // never from input.
    const unsupported: string[] = [];
    for (const reference of movedPartyReferences()) {
      try {
        // Clear what cannot survive the move first (self-edges, rows the
        // winner already has under a unique key), so the UPDATE itself cannot
        // abort a merge halfway through.
        for (const statement of prunePartyReferenceSql(reference)) {
          await query(statement, [businessId, loserId, winnerId]);
        }
        await query(movePartyReferenceSql(reference), [businessId, loserId, winnerId]);
      } catch (error) {
        // A table that does not exist on this install is fine — industry tables
        // (repairs, gold accounts, layaway) only exist for the trades that have
        // them, and the registry is platform-wide. Anything else is a real
        // failure and must abort the merge rather than leave it half-applied:
        // a partially merged customer is worse than an unmerged one.
        const code = (error as { code?: string }).code;
        if (code === "42P01") continue; // undefined_table
        if (code === "42703") {
          // undefined_column — the registry names a column this schema has not
          // got. Record it and fail, rather than silently skipping a reference
          // somebody declared as needing to move.
          unsupported.push(partyReferenceKey(reference.table, reference.column));
          continue;
        }
        throw error;
      }
    }
    if (unsupported.length > 0) {
      throw new PartyMergeBlockedError(unsupported);
    }

    // Field-level merge: union the tags, intersect the consent, and fill the
    // winner's empty fields from the loser (a blank is not a decision).
    await query(
      `UPDATE parties
          SET tags = $3,
              sms_consent = $4,
              marketing_consent = $5,
              phone = coalesce(nullif(btrim(phone), ''), $6),
              phone_e164 = coalesce(phone_e164, $7),
              phone_enc = CASE WHEN nullif(btrim(phone), '') IS NULL THEN $8 ELSE phone_enc END,
              phone_bidx = CASE WHEN nullif(btrim(phone), '') IS NULL THEN $9 ELSE phone_bidx END,
              phone_last4 = CASE WHEN nullif(btrim(phone), '') IS NULL THEN $10 ELSE phone_last4 END,
              phone_kind = CASE WHEN nullif(btrim(phone), '') IS NULL THEN $11 ELSE phone_kind END,
              email = coalesce(nullif(btrim(email), ''), $12),
              address = coalesce(nullif(btrim(address), ''), $13),
              birthday = coalesce(birthday, $14::date),
              notes = coalesce(nullif(btrim(notes), ''), $15),
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        winnerId,
        mergeTags(winner.tags, loser.tags),
        mergeConsent(winner.sms_consent, loser.sms_consent),
        mergeConsent(winner.marketing_consent, loser.marketing_consent),
        loser.phone,
        loser.phone_e164,
        loser.phone_enc,
        loser.phone_bidx,
        loser.phone_last4,
        loser.phone_kind,
        loser.email,
        loser.address,
        loser.birthday,
        loser.notes,
      ],
    );
    // On plaintext installs phone_enc is NULL on both records. The stale-data
    // trigger correctly clears metadata when the phone changes, so restore the
    // loser's canonical metadata in a second, phone-unchanged statement.
    if (!winner.phone?.trim() && loser.phone) {
      await query(
        `UPDATE parties SET phone_e164 = $3, phone_enc = $4, phone_bidx = $5,
                            phone_last4 = $6, phone_kind = $7
          WHERE business_id = $1 AND id = $2`,
        [businessId, winnerId, loser.phone_e164, loser.phone_enc, loser.phone_bidx, loser.phone_last4, loser.phone_kind],
      );
    }

    // Archive, never delete: an id that was referenced anywhere must stay
    // resolvable, and the merge record itself points at it.
    await query(
      `UPDATE parties SET is_active = false, merged_into_id = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, loserId, winnerId],
    );

    // If the merge lost a consent the winner had, that is a consent *change*
    // and belongs in the audit trail like any other.
    for (const channel of ["sms", "email"] as const) {
      const winnerHad = channel === "sms" ? winner.sms_consent : winner.marketing_consent;
      const loserHad = channel === "sms" ? loser.sms_consent : loser.marketing_consent;
      if (winnerHad && !mergeConsent(winnerHad, loserHad)) {
        await query(
          `INSERT INTO crm_consent_events (business_id, customer_id, channel, granted, source, note, changed_by)
           VALUES ($1, $2, $3, false, 'merge', $4, $5)`,
          [
            businessId,
            winnerId,
            channel,
            `در ادغام با پروندهٔ «${loser.name}» که اجازه نداده بود، لغو شد.`,
            options.mergedBy ?? "",
          ],
        );
      }
    }

    await query(
      `INSERT INTO crm_merges (business_id, winner_id, loser_id, moved_counts, loser_snapshot, merged_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        businessId,
        winnerId,
        loserId,
        JSON.stringify(moved),
        JSON.stringify({
          name: loser.name,
          phone: loser.phone,
          email: loser.email,
          tags: loser.tags ?? [],
        }),
        options.mergedBy ?? "",
      ],
    );

    return { winnerId, loserId, moved };
  });

  if (!result) return null;

  // Outside the transaction, deliberately. A merge is irreversible and has
  // already been committed by this point; a failed audit insert must not be
  // able to roll it back. `recordCrmAudit` swallows its own errors for the
  // same reason.
  await recordCrmAudit({
    businessId,
    kind: "party.merged",
    entityType: "party",
    entityId: result.winnerId,
    partyId: result.winnerId,
    summary: `ادغام پروندهٔ مشتری در «${winnerName}»`,
    detail: { loserId: result.loserId, loserName, moved: result.moved },
    actorUserId: options.mergedByUserId ?? null,
    actorName: options.mergedBy ?? "",
  });

  return result;
}

// ---------------------------------------------------------------------------
// RFM recompute
// ---------------------------------------------------------------------------

/**
 * Recompute every customer's RFM score and lifecycle stage.
 *
 * Whole-population, because quintiles are relative — there is no such thing as
 * scoring one customer. That is also why the result is *stored*: recomputing
 * on every list render would mean reading every order on every page load.
 * Callers refresh it from the CRM dashboard, and every screen treats a null
 * score as "not scored yet" rather than as zero.
 */
interface CustomerPurchaseRow extends Record<string, unknown> {
  customer_id: string;
  name: string;
  last_purchase_date: string | null;
  order_count: number;
  total_spent: string;
  rfm_recency: number | null;
  rfm_frequency: number | null;
  rfm_monetary: number | null;
  lifecycle_stage: string | null;
}

/**
 * The customer purchase population used by CRM analytics.
 *
 * Keep the order aggregation in one query shape for the stored-score reader,
 * the RFM recompute and the overview leaderboard. In particular, the location
 * join belongs *inside* the order aggregation: a LEFT JOIN of `orders` to a
 * non-matching location still counts the order while returning NULL dates,
 * which made a leaked/misassigned order inflate a customer's spend without a
 * valid business-day date.
 */
async function customerPurchaseRows(
  businessId: string,
  options: { storedOnly?: boolean } = {},
): Promise<CustomerPurchaseRow[]> {
  const scoreFilter = options.storedOnly ? "AND c.rfm_scored_at IS NOT NULL" : "";
  const { rows } = await query<CustomerPurchaseRow>(
    `WITH order_stats AS (
       SELECT o.customer_id,
              count(*)::int AS order_count,
              coalesce(sum(o.total), 0)::text AS total_spent,
              min(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))::text AS first_purchase_date,
              max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))::text AS last_purchase_date
         FROM orders o
         JOIN locations l ON l.id = o.location_id AND l.business_id = $1
        WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
          AND o.customer_id IS NOT NULL
        GROUP BY o.customer_id
     )
     SELECT c.id AS customer_id, c.name,
            os.last_purchase_date,
            coalesce(os.order_count, 0)::int AS order_count,
            coalesce(os.total_spent, '0')::text AS total_spent,
            c.rfm_recency, c.rfm_frequency, c.rfm_monetary, c.lifecycle_stage
       FROM parties c
       LEFT JOIN order_stats os ON os.customer_id = c.id
      WHERE c.business_id = $1
        AND c.roles && ARRAY['customer']::text[]
        AND c.is_active
        AND c.merged_into_id IS NULL
        ${scoreFilter}`,
    [businessId],
  );
  return rows;
}

/** Lifetime purchase totals for every live CRM customer, independent of RFM. */
interface CustomerPurchaseSummary {
  customerId: string;
  name: string;
  orderCount: number;
  totalSpentRial: string;
}

export async function customerPurchasePopulation(businessId: string): Promise<CustomerPurchaseSummary[]> {
  const rows = await customerPurchaseRows(businessId);
  return rows.map((row) => ({
    customerId: row.customer_id,
    name: row.name,
    orderCount: Number(row.order_count ?? 0),
    totalSpentRial: String(row.total_spent ?? "0"),
  }));
}

/**
 * Recompute every customer's RFM score and lifecycle stage.
 *
 * Whole-population, because quintiles are relative — there is no such thing as
 * scoring one customer. That is also why the result is *stored*: recomputing
 * on every list render would mean reading every order on every page load.
 * Callers refresh it from the CRM dashboard, and every screen treats a null
 * score as "not scored yet" rather than as zero.
 */
export async function recomputeRfm(businessId: string): Promise<{ scored: number; anchorDate: string }> {
  const anchorDate = await businessToday(businessId);
  const rows = await customerPurchaseRows(businessId);

  const input: CustomerRfmInput[] = rows.map((row) => ({
    customerId: row.customer_id,
    name: row.name,
    lastPurchaseDate: row.last_purchase_date,
    orderCount: Number(row.order_count ?? 0),
    totalSpentRial: Number(row.total_spent ?? 0),
  }));

  const scores = scorePopulation(input, anchorDate);
  if (scores.length === 0) return { scored: 0, anchorDate };

  // One statement rather than N updates: a business with 20k customers would
  // otherwise issue 20k round trips for what is a single derived column set.
  await query(
    `UPDATE parties c
        SET rfm_recency = v.recency, rfm_frequency = v.frequency, rfm_monetary = v.monetary,
            lifecycle_stage = v.stage, rfm_scored_at = now()
       FROM (
         SELECT unnest($2::uuid[]) AS id, unnest($3::int[]) AS recency,
                unnest($4::int[]) AS frequency, unnest($5::int[]) AS monetary,
                unnest($6::text[]) AS stage
       ) v
      WHERE c.business_id = $1 AND c.id = v.id
        AND c.roles && ARRAY['customer']::text[]
        AND c.is_active
        AND c.merged_into_id IS NULL`,
    [
      businessId,
      scores.map((s) => s.customerId),
      scores.map((s) => s.recency),
      scores.map((s) => s.frequency),
      scores.map((s) => s.monetary),
      scores.map((s) => s.stage),
    ],
  );

  return { scored: scores.length, anchorDate };
}

/** The stored scored population — null scores stay out until the owner recomputes. */
export async function scoredPopulation(businessId: string): Promise<RfmScore[]> {
  const anchorDate = await businessToday(businessId);
  const rows = await customerPurchaseRows(businessId, { storedOnly: true });
  return rows.flatMap((row) => {
    if (
      row.rfm_recency === null ||
      row.rfm_frequency === null ||
      row.rfm_monetary === null ||
      !row.lifecycle_stage
    ) {
      return [];
    }
    const recency = Number(row.rfm_recency);
    const frequency = Number(row.rfm_frequency);
    const monetary = Number(row.rfm_monetary);
    const stage = row.lifecycle_stage as LifecycleStage;
    return [
      {
        customerId: row.customer_id,
        name: row.name,
        recencyDays: row.last_purchase_date ? daysBetween(row.last_purchase_date, anchorDate) : null,
        orderCount: Number(row.order_count ?? 0),
        totalSpentRial: Number(row.total_spent ?? 0),
        recency,
        frequency,
        monetary,
        cell: `${recency}${frequency}${monetary}`,
        total: recency + frequency + monetary,
        stage,
      },
    ];
  });
}

/**
 * Keep every canonical form of a phone number in step with the typed one:
 * `phone_e164`, and (Phase 24 Wave 3) the ciphertext and its blind index.
 *
 * Historical note worth keeping, because it explains a data shape you will
 * meet in the wild: the docstring here used to say "called on customer
 * create/update", and it never was — this function had no callers at all, so
 * `phone_e164` was only ever populated by the integrations sync, the merge
 * path and `npm run db:normalize-phones`. Customers typed into the dashboard
 * had a NULL canonical phone, which quietly excluded them from duplicate
 * detection, segment resolution and the SMS-reachable count. The create/update
 * path in `parties-service.ts` now writes all of these itself; this remains
 * for callers that hold only an id and a number.
 */
export async function syncCustomerPhone(
  businessId: string,
  customerId: string,
  phone: string | null,
): Promise<void> {
  const e164 = phone ? normalizePhone(phone).e164 : null;
  const dek = await getBusinessDek(businessId);
  await query(
    `UPDATE parties SET phone_e164 = $3, phone_enc = $4, phone_bidx = $5, phone_last4 = $6, phone_kind = $7
      WHERE business_id = $1 AND id = $2`,
    [
      businessId,
      customerId,
      e164,
      dek ? encryptOptional(phone, dek) : null,
      dek && phone ? phoneBlindIndex(phone, dek) : null,
      phoneLast4(phone),
      phoneKind(phone),
    ],
  );
}

/**
 * Add or remove a single tag, returning the resulting list — or null when the
 * customer does not exist.
 *
 * The array is rewritten by the database from its own current value
 * (`array_append`/`array_remove` on the stored column), never from a value the
 * caller read a moment ago. Two people tagging the same customer at the same
 * instant therefore both keep their tag; a read-modify-write in application
 * code would silently drop one of them.
 */
/**
 * Add or remove one tag.
 *
 * `AND merged_into_id IS NULL`, same reasoning as {@link addCustomerNote}:
 * this is also the assistant's only other write tool (`crm.customer.tag`),
 * and a merged customer is an archived row nobody reads from again — tagging
 * it would silently do nothing anyone downstream would ever see.
 */
export async function setCustomerTag(
  businessId: string,
  customerId: string,
  tag: string,
  action: "add" | "remove",
): Promise<string[] | null> {
  const clean = tag.trim();
  if (!clean) return null;

  const { rows } = await query<{ tags: string[] }>(
    action === "add"
      ? `UPDATE parties
            SET tags = CASE WHEN $3 = ANY(COALESCE(tags, '{}')) THEN tags
                            ELSE array_append(COALESCE(tags, '{}'), $3) END
          WHERE business_id = $1 AND id = $2 AND merged_into_id IS NULL
        RETURNING COALESCE(tags, '{}') AS tags`
      : `UPDATE parties
            SET tags = array_remove(COALESCE(tags, '{}'), $3)
          WHERE business_id = $1 AND id = $2 AND merged_into_id IS NULL
        RETURNING COALESCE(tags, '{}') AS tags`,
    [businessId, customerId, clean],
  );
  return rows[0]?.tags ?? null;
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

interface CrmActivity extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  caseId: string | null;
  kind: ActivityKind;
  subject: string;
  body: string;
  dueAt: string | null;
  completedAt: string | null;
  /** The display snapshot — what the row says the assignee was. */
  assignedTo: string;
  /** The member, when the assignee is one. Null for legacy rows and unassigned work. */
  assigneeUserId: string | null;
  createdBy: string;
  createdAt: string;
}

const ACTIVITY_COLUMNS = `a.id, a.customer_id AS "customerId", c.name AS "customerName",
  a.deal_id AS "dealId", a.case_id AS "caseId", a.kind, a.subject, a.body,
  a.due_at AS "dueAt", a.completed_at AS "completedAt", a.assigned_to AS "assignedTo",
  a.assignee_user_id AS "assigneeUserId",
  a.created_by AS "createdBy", a.created_at AS "createdAt"`;

export async function listActivities(
  businessId: string,
  options: {
    customerId?: string;
    dealId?: string;
    caseId?: string;
    openOnly?: boolean;
    /** Only rows somebody has ticked off — the `done` half of a saved view. */
    completedOnly?: boolean;
    /** An activity kind, so a view can be «تماس‌های عقب‌افتاده». */
    kind?: ActivityKind;
    /** Exact snapshot match — the legacy text filter. */
    assignedTo?: string;
    /** The member whose work to list («کارهای من»). */
    assigneeUserId?: string;
    /**
     * Deliberately unclaimed work. Separate from "not filtering by assignee",
     * which must not mean "only the unowned ones".
     */
    unowned?: boolean;
    /** Free-text over subject/body/assignee — the list's own search box. */
    q?: string;
    /** Only rows whose `dueAt` falls on or before this ISO date (overdue + today). */
    dueOnOrBefore?: string;
    /** Only rows due strictly *before* this ISO date — the `overdue` state. */
    dueBefore?: string;
    /** Only rows due on or after this ISO date — the `planned` state. */
    dueOnOrAfter?: string;
    /**
     * The shop's day a `dueOnOrBefore`/`dueBefore`/`dueOnOrAfter` date means:
     * the branch's timezone and its business-day start, from
     * `businessDayContext`. Supplying them resolves each date to *that day's*
     * own start and end; omitting them keeps the historical comparison, where a
     * date means midnight in the database session's timezone (UTC on a server,
     * i.e. 03:30 in Tehran — the three and a half hours a night in which «امروز»
     * and the shop's today used to disagree).
     */
    dayTimeZone?: string;
    dayStartMinutes?: number | null;
    limit?: number;
  } = {},
): Promise<CrmActivity[]> {
  const params: unknown[] = [businessId];
  let where = "a.business_id = $1";
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    where += ` AND ${fragment.replace("$n", `$${params.length}`)}`;
  };
  // Ids are `uuid` columns: a non-uuid filter raises a Postgres syntax error
  // (a 500) rather than returning nothing, so a junk query string must simply
  // not be applied as a filter.
  if (options.customerId && isUuid(options.customerId)) add("a.customer_id = $n", options.customerId);
  if (options.dealId && isUuid(options.dealId)) add("a.deal_id = $n", options.dealId);
  if (options.caseId && isUuid(options.caseId)) add("a.case_id = $n", options.caseId);
  if (options.assignedTo) add("a.assigned_to = $n", options.assignedTo);
  if (options.kind) add("a.kind = $n", options.kind);
  // «کارهای من» — by member id, never by name: two colleagues can share a name,
  // and a name filter would quietly hand one of them the other's list.
  if (options.assigneeUserId && isUuid(options.assigneeUserId)) {
    add("a.assignee_user_id = $n", options.assigneeUserId);
  } else if (options.unowned) {
    // No id *and* no name — the definition `listCases` argues in full, and the
    // one the queue cards and `unowned_work` already used.
    where += " AND a.assignee_user_id IS NULL AND btrim(coalesce(a.assigned_to, '')) = ''";
  }
  const term = options.q?.trim();
  if (term) {
    // `%` and `_` in a user's search string are literals, not wildcards.
    const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.push(`%${escaped}%`);
    const n = `$${params.length}`;
    where += ` AND (a.subject ILIKE ${n} ESCAPE '\\' OR a.body ILIKE ${n} ESCAPE '\\'`;
    where += ` OR a.assigned_to ILIKE ${n} ESCAPE '\\' OR c.name ILIKE ${n} ESCAPE '\\')`;
  }
  if (options.openOnly) where += " AND a.completed_at IS NULL";
  if (options.completedOnly) where += " AND a.completed_at IS NOT NULL";
  /**
   * The instant an ISO date's day begins, and the one after it begins.
   *
   * With a branch context the day is the shop's: its start is that branch's
   * business-day start (`date + start minutes` as a *local* wall clock, then
   * `AT TIME ZONE` — the same arithmetic `app_business_day_start`, migration
   * 0076, does), and the next day is computed from that date rather than by
   * adding `interval '1 day'` to an instant, which PostgreSQL would resolve in
   * the session's timezone. Without one, the historical expression is emitted
   * unchanged, so a caller holding only a date keeps the behaviour it had.
   */
  const dayStartSql = (isoDate: string): string => {
    const date = params.push(isoDate);
    if (!options.dayTimeZone) return `(($${date})::date)`;
    const zone = params.push(options.dayTimeZone);
    const start = params.push(options.dayStartMinutes ?? null);
    return `((($${date})::date + coalesce($${start}::int, 0) * interval '1 minute') AT TIME ZONE $${zone}::text)`;
  };
  const dayAfterSql = (isoDate: string): string => {
    const date = params.push(isoDate);
    if (!options.dayTimeZone) return `(($${date})::date + 1)`;
    const zone = params.push(options.dayTimeZone);
    const start = params.push(options.dayStartMinutes ?? null);
    return `((($${date})::date + 1 + coalesce($${start}::int, 0) * interval '1 minute') AT TIME ZONE $${zone}::text)`;
  };
  if (options.dueOnOrBefore) {
    // The shop's own day, inclusive: a task due «امروز» is not late until the
    // business day the server resolved has ended — so the bound is where the
    // *next* one starts, in the branch's own zone.
    where += ` AND a.due_at IS NOT NULL AND a.due_at < ${dayAfterSql(options.dueOnOrBefore)}`;
  }
  if (options.dueBefore) {
    where += ` AND a.due_at IS NOT NULL AND a.due_at < ${dayStartSql(options.dueBefore)}`;
  }
  if (options.dueOnOrAfter) {
    where += ` AND a.due_at IS NOT NULL AND a.due_at >= ${dayStartSql(options.dueOnOrAfter)}`;
  }
  // A caller-supplied limit is clamped rather than trusted: `limit=999999` on a
  // shared endpoint is a way to make one screen read a whole table.
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200) || 200, 1), 500);
  params.push(limit);

  const { rows } = await query<CrmActivity>(
    `SELECT ${ACTIVITY_COLUMNS}
       FROM crm_activities a
       LEFT JOIN parties c ON c.id = a.customer_id
      WHERE ${where}
      ORDER BY a.completed_at IS NOT NULL,
               -- Open work: soonest commitment first, and rows with no moeed
               -- after the dated ones rather than interleaved with them by
               -- their creation time (coalescing due_at with created_at put a
               -- note typed last week ahead of a call due tomorrow).
               CASE WHEN a.completed_at IS NULL AND a.due_at IS NULL THEN 1 ELSE 0 END,
               CASE WHEN a.completed_at IS NULL THEN a.due_at END ASC,
               -- Done work reads as history: most recently finished first.
               a.completed_at DESC NULLS LAST,
               a.created_at DESC,
               -- Total order. Bulk-created activities share a timestamp, and
               -- without this they shuffle between identical requests.
               a.id
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

interface CreateActivityInput {
  customerId?: string | null;
  dealId?: string | null;
  caseId?: string | null;
  kind: ActivityKind;
  subject: string;
  body?: string;
  dueAt?: string | null;
  /** The assignee as a **member id**; preferred over the name below. */
  assigneeUserId?: string | null;
  /** A name, for legacy callers and pre-0157 rows. Resolved, never trusted. */
  assignedTo?: string;
  createdBy?: string;
  completed?: boolean;
}

export async function createActivity(
  businessId: string,
  input: CreateActivityInput,
): Promise<CrmActivity> {
  // Whoever is named is a member of *this* business, verified here rather than
  // trusted from the body: the id column is the ownership, the text is the
  // snapshot, and a foreign or misspelled name leaves the row unassigned
  // instead of misattributed (`crm-ownership.ts`).
  const owner = await resolveOwner(businessId, input.assigneeUserId ?? input.assignedTo);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_activities
       (business_id, customer_id, deal_id, case_id, kind, subject, body, due_at,
        assigned_to, assignee_user_id, created_by, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      businessId,
      input.customerId ?? null,
      input.dealId ?? null,
      input.caseId ?? null,
      input.kind,
      input.subject.trim(),
      input.body?.trim() ?? "",
      input.dueAt ?? null,
      owner.name,
      owner.userId,
      input.createdBy ?? "",
      input.completed ? new Date().toISOString() : null,
    ],
  );
  return (await getActivity(businessId, rows[0].id))!;
}

/** One activity by id — the read every write path returns through. */
export async function getActivity(businessId: string, activityId: string): Promise<CrmActivity | null> {
  // `id` is a uuid column: a non-uuid would raise a cast error (a 500) instead
  // of answering "no such row".
  if (!isUuid(activityId)) return null;
  const { rows } = await query<CrmActivity>(
    `SELECT ${ACTIVITY_COLUMNS}
       FROM crm_activities a
       LEFT JOIN parties c ON c.id = a.customer_id
      WHERE a.business_id = $1 AND a.id = $2`,
    [businessId, activityId],
  );
  return rows[0] ?? null;
}

interface UpdateActivityInput {
  kind?: ActivityKind;
  subject?: string;
  body?: string;
  dueAt?: string | null;
  /** The assignee as a member id; `""` unassigns. */
  assigneeUserId?: string | null;
  /** A name, for legacy callers. Resolved to a member when it is unambiguous. */
  assignedTo?: string;
  customerId?: string | null;
  completed?: boolean;
}

/**
 * Edit an activity in place.
 *
 * Only the keys present are written, so the tick-box (`completed` alone) and
 * the edit dialog share one path. Without this a mistyped moeed or a callback
 * that moved to Thursday could only be fixed by deleting the row and losing
 * who logged it and when.
 */
export async function updateActivity(
  businessId: string,
  activityId: string,
  input: UpdateActivityInput,
): Promise<CrmActivity | null> {
  if (!isUuid(activityId)) return null;
  const sets: string[] = [];
  const params: unknown[] = [businessId, activityId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.kind !== undefined) set("kind", input.kind);
  if (input.subject !== undefined) set("subject", input.subject.trim());
  if (input.body !== undefined) set("body", input.body.trim());
  if (input.dueAt !== undefined) set("due_at", input.dueAt);
  // Assignment is one decision, so it writes both columns together: the id when
  // the caller named a member (or a name only one member answers to), and the
  // snapshot either way. Two separate writes are how a row ends up with an id
  // and a stale name beside it.
  if (input.assigneeUserId !== undefined || input.assignedTo !== undefined) {
    const owner = await resolveOwner(businessId, input.assigneeUserId ?? input.assignedTo);
    set("assignee_user_id", owner.userId);
    set("assigned_to", owner.name);
  }
  if (input.customerId !== undefined) set("customer_id", input.customerId);
  if (input.completed !== undefined) {
    set("completed_at", input.completed ? new Date().toISOString() : null);
  }
  if (sets.length === 0) return getActivity(businessId, activityId);

  const { rowCount } = await query(
    `UPDATE crm_activities SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    params,
  );
  if ((rowCount ?? 0) === 0) return null;
  return getActivity(businessId, activityId);
}

export async function deleteActivity(businessId: string, activityId: string): Promise<boolean> {
  if (!isUuid(activityId)) return false;
  const { rowCount } = await query(`DELETE FROM crm_activities WHERE business_id = $1 AND id = $2`, [
    businessId,
    activityId,
  ]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

interface CrmDeal extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  title: string;
  description: string;
  /**
   * The legacy six-value key, kept because every pre-0157 query and report
   * reads it. The canonical identity of a deal's position is `stageId`; this
   * column is mainained in step by the service and is compatibility-only.
   */
  stage: DealStage;
  /** The stage row, when the deal has one. Null only for rows written before migration 0157 or by a caller that did not name a stage. */
  stageId: string | null;
  pipelineId: string | null;
  valueRial: number;
  probability: number | null;
  expectedCloseDate: string | null;
  /** The owner's display name as stored — the snapshot, kept for history. */
  ownerUser: string;
  /** The owner as a member id. Null when nobody is assigned, or when a typed name matched no single member. */
  ownerUserId: string | null;
  source: string;
  closedAt: string | null;
  lostReason: string | null;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEAL_COLUMNS = `d.id, d.customer_id AS "customerId", c.name AS "customerName",
  d.title, d.description, d.stage, d.stage_id AS "stageId", d.pipeline_id AS "pipelineId",
  d.value_rial AS "valueRial", d.probability,
  d.expected_close_date::text AS "expectedCloseDate",
  d.owner_user AS "ownerUser", d.owner_user_id AS "ownerUserId",
  d.source, d.closed_at AS "closedAt", d.lost_reason AS "lostReason",
  d.order_id AS "orderId", d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

export interface ListDealsOptions {
  customerId?: string;
  /** The compatibility key. The canonical filter is `stageId`. */
  stage?: DealStage;
  /** The canonical stage row — what the board and a saved view both hold. */
  stageId?: string | null;
  pipelineId?: string | null;
  /** Free text over the deal's title and its customer's name. */
  q?: string;
  /** A member id. `null` with `unowned: true` means "nobody owns it". */
  ownerUserId?: string | null;
  unowned?: boolean;
  /** Bounds in Rial, already converted — see `crm-deal-views.ts`. */
  minValueRial?: number | null;
  maxValueRial?: number | null;
  openOnly?: boolean;
  limit?: number;
}

/**
 * One page of deals, narrowed by whatever the caller asked for.
 *
 * Every filter is an equality or a bound on a column — no expression is built
 * from user text, and the two free-text fields are matched with `ILIKE` against
 * the title and the customer's name, which is the whole of the "search" a board
 * needs. The saved-view vocabulary (`crm-deal-views.ts`) maps onto exactly these
 * options, which is what lets the deals screen promise that a stored view shows
 * what it says.
 *
 * `unowned` and `ownerUserId` are separate on purpose: a caller asking for a
 * member must not accidentally match every row whose owner is NULL, which is
 * what a naive `= $n` with a null parameter does.
 */
export async function listDeals(
  businessId: string,
  options: ListDealsOptions = {},
): Promise<CrmDeal[]> {
  const params: unknown[] = [businessId];
  let where = "d.business_id = $1";
  if (options.customerId) {
    params.push(options.customerId);
    where += ` AND d.customer_id = $${params.length}`;
  }
  if (options.stage) {
    params.push(options.stage);
    where += ` AND d.stage = $${params.length}`;
  }
  if (options.stageId) {
    params.push(options.stageId);
    where += ` AND d.stage_id = $${params.length}`;
  }
  if (options.pipelineId) {
    params.push(options.pipelineId);
    where += ` AND d.pipeline_id = $${params.length}`;
  }
  if (options.ownerUserId) {
    params.push(options.ownerUserId);
    where += ` AND d.owner_user_id = $${params.length}`;
  } else if (options.unowned) {
    // No id *and* no name — the definition `listCases` argues in full, and the
    // one the queue cards and `unowned_work` already used.
    where += " AND d.owner_user_id IS NULL AND btrim(coalesce(d.owner_user, '')) = ''";
  }
  if (options.q && options.q.trim()) {
    // One parameter, two columns: `%text%` for either the deal or its customer.
    params.push(`%${options.q.trim()}%`);
    where += ` AND (d.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
  }
  if (typeof options.minValueRial === "number") {
    params.push(options.minValueRial);
    where += ` AND d.value_rial >= $${params.length}`;
  }
  if (typeof options.maxValueRial === "number") {
    params.push(options.maxValueRial);
    where += ` AND d.value_rial <= $${params.length}`;
  }
  if (options.openOnly) {
    // Terminal by *outcome*, not by the six legacy keys: a business whose won
    // column is named something else still has deals that are closed.
    where += ` AND NOT EXISTS (
      SELECT 1 FROM crm_pipeline_stages s
       WHERE s.business_id = d.business_id AND s.id = d.stage_id AND s.outcome <> 'open'
    ) AND (d.stage_id IS NOT NULL OR d.stage NOT IN ('won', 'lost'))`;
  }
  params.push(options.limit ?? 200);

  const { rows } = await query<CrmDeal>(
    `SELECT ${DEAL_COLUMNS} FROM crm_deals d
       LEFT JOIN parties c ON c.id = d.customer_id
      WHERE ${where}
      -- d.id breaks ties. Without it the sort is only a partial order, and
      -- Postgres may return equal-timestamped rows in any sequence it likes:
      -- two deals created by the same import, or seeded together, swap places
      -- between identical requests. On the kanban that reorders cards for no
      -- reason, and it made the crm-deals visual baseline flake.
      ORDER BY d.updated_at DESC, d.id
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({ ...row, valueRial: Number(row.valueRial) }));
}

interface UpsertDealInput {
  id?: string;
  customerId?: string | null;
  title: string;
  description?: string;
  /**
   * The canonical stage, as a row id. Preferred wherever a caller knows it:
   * a business with its own stages has no legacy key to name, and resolving
   * `stage` can only ever reach the six seeded ones.
   */
  stageId?: string | null;
  stage?: DealStage;
  valueRial?: number;
  probability?: number | null;
  expectedCloseDate?: string | null;
  /** The owner's display name — the snapshot, kept for history. */
  ownerUser?: string;
  /** The owner as a member id. Preferred wherever the caller has one. */
  ownerUserId?: string | null;
  source?: string;
  lostReason?: string | null;
  orderId?: string | null;
  createdBy?: string;
  /** The author as a member id; the name above stays the snapshot. */
  createdById?: string | null;
}

/**
 * Create or update a deal.
 *
 * `closed_at` is maintained here rather than by the caller: reaching `won` or
 * `lost` *is* closing, and leaving that to each call site is how half the rows
 * end up with a terminal stage and no close date. Moving a deal back out of a
 * terminal stage clears it again, so a mis-click is fully reversible.
 *
 * No ledger write happens on `won`, by design — see the note on `crm_deals` in
 * migration 0118.
 */
export async function upsertDeal(businessId: string, input: UpsertDealInput): Promise<CrmDeal> {
  /**
   * The canonical stage, resolved once.
   *
   * A caller that names `stageId` gets exactly that stage — including one this
   * business invented, which no legacy key can express. A caller that names the
   * legacy `stage` key is resolved onto the default pipeline's stage for that
   * key, so even the old shape writes `stage_id` and a new deal is never born
   * stageless on the canonical board. A key that no longer maps to a stage
   * (renamed away, or removed) falls back to the legacy column alone, exactly
   * as `PATCH /api/crm/deals/[id]` does for a moved stage.
   */
  const explicit = input.stageId ? await resolveStageForWrite(businessId, input.stageId) : null;
  const legacyKey = input.stage ?? "lead";
  const resolved =
    explicit ?? (input.stageId ? null : await resolveLegacyStageForWrite(businessId, legacyKey));
  const stage = resolved ? (legacyStageKey(resolved) as DealStage) : legacyKey;
  const terminal = resolved ? resolved.outcome !== "open" : stage === "won" || stage === "lost";

  /**
   * The owner, resolved once: an id when the caller gave one (or gave a name
   * that matches exactly one member), and the display name either way.
   *
   * Both columns are written from this single resolution, so the id and the
   * snapshot can never disagree about who owns the deal — and a name that
   * matches two members resolves to nobody rather than to the wrong colleague.
   */
  const owner = await resolveOwner(businessId, input.ownerUserId ?? input.ownerUser);

  // The deal as it was, read once for the stage-change trigger below. A primary
  // key read on the edit path, and the only way to tell a move from a re-save.
  const before = input.id && isUuid(input.id) ? await getDeal(businessId, input.id) : null;

  if (input.id) {
    await query(
      `UPDATE crm_deals
          SET customer_id = $3, title = $4, description = $5, stage = $6, value_rial = $7,
              probability = $8, expected_close_date = $9::date,
              owner_user = $10, owner_user_id = $17, source = $11,
              lost_reason = $12, order_id = $13,
              stage_id = COALESCE($15, stage_id),
              pipeline_id = COALESCE($16, pipeline_id),
              stage_entered_at = CASE WHEN $15::uuid IS NOT NULL AND stage_id IS DISTINCT FROM $15::uuid
                                      THEN now() ELSE stage_entered_at END,
              closed_at = CASE WHEN $14 THEN coalesce(closed_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        input.id,
        input.customerId ?? null,
        input.title.trim(),
        input.description?.trim() ?? "",
        stage,
        Math.max(0, Math.round(input.valueRial ?? 0)),
        input.probability ?? null,
        input.expectedCloseDate ?? null,
        owner.name,
        input.source?.trim() ?? "",
        input.lostReason?.trim() || null,
        input.orderId ?? null,
        terminal,
        resolved?.id ?? null,
        resolved?.pipelineId ?? null,
        owner.userId,
      ],
    );
    const updated = (await getDeal(businessId, input.id))!;
    const summary = await fireDealStageTrigger(businessId, before, updated, {
      name: input.createdBy ?? "",
      userId: input.createdById ?? null,
    });
    // A rule may have moved the owner or filed work against this deal, so the
    // caller is handed the row as it stands *now* rather than as it was before
    // the automations ran. Only when one actually did something: an ordinary
    // save with no rules fires nothing and pays nothing.
    if (summary && (summary.applied > 0 || summary.growthSignals > 0)) {
      return (await getDeal(businessId, input.id))!;
    }
    return updated;
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_deals
       (business_id, customer_id, title, description, stage, value_rial, probability,
        expected_close_date, owner_user, source, lost_reason, order_id, closed_at, created_by,
        stage_id, pipeline_id, stage_entered_at, last_activity_at, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12,
             CASE WHEN $13 THEN now() ELSE NULL END, $14, $15, $16,
             CASE WHEN $16::uuid IS NOT NULL THEN now() ELSE NULL END,
             CASE WHEN $16::uuid IS NOT NULL THEN now() ELSE NULL END, $17)
     RETURNING id`,
    [
      businessId,
      input.customerId ?? null,
      input.title.trim(),
      input.description?.trim() ?? "",
      stage,
      Math.max(0, Math.round(input.valueRial ?? 0)),
      input.probability ?? null,
      input.expectedCloseDate ?? null,
      owner.name,
      input.source?.trim() ?? "",
      input.lostReason?.trim() || null,
      input.orderId ?? null,
      terminal,
      input.createdBy ?? "",
      resolved?.id ?? null,
      resolved?.pipelineId ?? null,
      owner.userId,
    ],
  );
  const created = (await getDeal(businessId, rows[0].id))!;
  const summary = await fireDealStageTrigger(businessId, before, created, {
    name: input.createdBy ?? "",
    userId: input.createdById ?? null,
  });
  if (summary && (summary.applied > 0 || summary.growthSignals > 0)) {
    return (await getDeal(businessId, rows[0].id))!;
  }
  return created;
}

/**
 * The stage row for an id, or null.
 *
 * `getStage` is the pipeline service's own read, so a stage id from a browser
 * is verified against this business before it is written — the tenancy check is
 * in the query, not in the caller.
 */
async function resolveStageForWrite(
  businessId: string,
  stageId: string,
): Promise<PipelineStage | null> {
  return getStage(businessId, stageId);
}

/** The default pipeline's stage for a legacy key, or null when nothing matches. */
async function resolveLegacyStageForWrite(
  businessId: string,
  legacyKey: DealStage,
): Promise<PipelineStage | null> {
  const pipeline = await defaultPipeline(businessId);
  return pipeline?.stages.find((stage) => stage.legacyKey === legacyKey) ?? null;
}

/** One deal by id — the read every write path returns through. */
export async function getDeal(businessId: string, dealId: string): Promise<CrmDeal | null> {
  const { rows } = await query<CrmDeal>(
    `SELECT ${DEAL_COLUMNS} FROM crm_deals d
       LEFT JOIN parties c ON c.id = d.customer_id
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, dealId],
  );
  const row = rows[0];
  return row ? { ...row, valueRial: Number(row.valueRial) } : null;
}

export async function moveDealStage(
  businessId: string,
  dealId: string,
  stage: DealStage,
  options: { lostReason?: string } = {},
): Promise<boolean> {
  const terminal = stage === "won" || stage === "lost";
  const { rowCount } = await query(
    `UPDATE crm_deals
        SET stage = $3,
            lost_reason = CASE WHEN $3 = 'lost' THEN $4 ELSE NULL END,
            closed_at = CASE WHEN $5 THEN coalesce(closed_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, dealId, stage, options.lostReason?.trim() ?? null, terminal],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteDeal(businessId: string, dealId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM crm_deals WHERE business_id = $1 AND id = $2`, [
    businessId,
    dealId,
  ]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface CrmCase extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  subject: string;
  body: string;
  status: CaseStatus;
  priority: CasePriority;
  category: string;
  orderId: string | null;
  /** The display snapshot — see `crm-ownership.ts`. */
  assignedTo: string;
  /** The member handling it, or null for legacy/unassigned rows. */
  assigneeUserId: string | null;
  resolution: string;
  openedAt: string;
  resolvedAt: string | null;
  createdBy: string;
}

const CASE_COLUMNS = `k.id, k.customer_id AS "customerId", c.name AS "customerName",
  k.subject, k.body, k.status, k.priority, k.category, k.order_id AS "orderId",
  k.assigned_to AS "assignedTo", k.assignee_user_id AS "assigneeUserId",
  k.resolution, k.opened_at AS "openedAt",
  k.resolved_at AS "resolvedAt", k.created_by AS "createdBy"`;

/**
 * The service desk's read, and the only one — every key of the `cases` filter
 * vocabulary is answered *here*, in the database, so a saved view cannot be a
 * filter that narrows the chips and not the rows.
 *
 * `breachedOnly` is decided by `caseBreachSql()` from `crm-case-clock.ts`, the
 * SQL half of the rule the row's badge and the summary panel use; the two are
 * proven to agree by `integration/crm-case-views.test.ts`. The target hours and
 * the closed statuses travel as parameters so the policy stays in one place.
 */
export async function listCases(
  businessId: string,
  options: {
    customerId?: string;
    status?: CaseStatus;
    priority?: CasePriority;
    /** Free text over the subject, the body and the customer's name. */
    q?: string;
    openOnly?: boolean;
    /** Only tickets that have missed their priority's target. */
    breachedOnly?: boolean;
    /** The member handling them («تیکت‌های من») — by id, not by name. */
    assigneeUserId?: string;
    /**
     * Deliberately unclaimed tickets. Separate from "not filtering by
     * assignee", which must not mean "only the unowned ones": an unclaimed
     * ticket is the one that rots, and it is the reason this option exists.
     */
    unowned?: boolean;
    limit?: number;
  } = {},
): Promise<CrmCase[]> {
  const params: unknown[] = [businessId];
  let where = "k.business_id = $1";
  if (options.customerId) {
    params.push(options.customerId);
    where += ` AND k.customer_id = $${params.length}`;
  }
  if (options.assigneeUserId && isUuid(options.assigneeUserId)) {
    params.push(options.assigneeUserId);
    where += ` AND k.assignee_user_id = $${params.length}`;
  } else if (options.unowned) {
    // «بدون مسئول» means nobody at all. A row carrying a legacy name and no id
    // is *not* unowned — that name is still a claim — and the queue card
    // («تیکت‌های بازی که مالکی ندارند») has always read it that way. One
    // definition, shared with `crm-data-quality.ts`'s `unowned_work` rule.
    where +=
      " AND k.assignee_user_id IS NULL AND btrim(coalesce(k.assigned_to, '')) = ''";
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND k.status = $${params.length}`;
  }
  if (options.priority) {
    params.push(options.priority);
    where += ` AND k.priority = $${params.length}`;
  }
  if (options.q?.trim()) {
    params.push(`%${options.q.trim()}%`);
    where += ` AND (k.subject ILIKE $${params.length} OR k.body ILIKE $${params.length}
              OR c.name ILIKE $${params.length})`;
  }
  if (options.openOnly) {
    params.push([...CASE_OPEN_STATUSES]);
    where += ` AND k.status = ANY($${params.length})`;
  }
  if (options.breachedOnly) {
    params.push(JSON.stringify(CASE_BREACH_SQL_CASES.targets));
    const targets = `$${params.length}`;
    params.push([...CASE_BREACH_SQL_CASES.closed]);
    const closed = `$${params.length}`;
    where += ` AND ${caseBreachSql({ targets, closed })}`;
  }
  params.push(options.limit ?? 200);

  const { rows } = await query<CrmCase>(
    `SELECT ${CASE_COLUMNS} FROM crm_cases k
       LEFT JOIN parties c ON c.id = k.customer_id
      WHERE ${where}
      ORDER BY
        CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        k.opened_at DESC,
        k.id
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

interface UpsertCaseInput {
  id?: string;
  customerId?: string | null;
  subject: string;
  body?: string;
  status?: CaseStatus;
  priority?: CasePriority;
  category?: string;
  /**
   * The order the complaint is about. On update, `undefined` means "leave it
   * as it is" while an explicit `null` clears the link — a caller that did not
   * mention the order must not silently unlink the ticket from it.
   */
  orderId?: string | null;
  /** The handler as a member id; `""` unassigns. */
  assigneeUserId?: string | null;
  /** A name, for legacy callers. Resolved to a member when it is unambiguous. */
  assignedTo?: string;
  resolution?: string;
  createdBy?: string;
  /** The author as a member id; the name above stays the snapshot. */
  createdById?: string | null;
}

/**
 * Fire the stage-change trigger, when the save really moved the deal.
 *
 * Called after the write, never inside one: the engine's own writes are not
 * part of this transaction, and a rule failing must not fail the save. A save
 * that rewrites the stage the deal was already in — an edit to the value, or a
 * board that re-posts what it rendered — is not a move and fires nothing.
 *
 * A brand-new deal has no stage to have left, so its first stage counts as
 * entering it: that is what «وقتی معامله‌ای وارد مرحلهٔ پیشنهاد می‌شود» means
 * to the person who wrote the rule.
 */
async function fireDealStageTrigger(
  businessId: string,
  before: CrmDeal | null,
  after: CrmDeal,
  actor: { name: string; userId: string | null },
): Promise<CrmAutomationRunSummary | null> {
  if (!dealStageMoved(before, after)) return null;
  const stage = after.stageId ? await getStage(businessId, after.stageId) : null;
  return runCrmAutomations(businessId, {
    trigger: "deal_stage_changed",
    entity: {
      type: "deal",
      id: after.id,
      title: after.title,
      partyId: after.customerId,
      valueRial: after.valueRial,
      stageLabel: stage?.name ?? null,
      ownerUserId: after.ownerUserId,
      ownerName: after.ownerUser,
    },
    actor,
  });
}

export async function upsertCase(businessId: string, input: UpsertCaseInput): Promise<CrmCase> {
  const status = input.status ?? "open";
  const resolved = status === "resolved" || status === "closed";

  // Resolved before the write, for the same reason as an activity's: a handler
  // is a member of this business or nobody, and the name beside the id is a
  // snapshot of that decision rather than a second, weaker one.
  const owner = await resolveOwner(businessId, input.assigneeUserId ?? input.assignedTo);

  if (input.id) {
    const orderIdProvided = input.orderId !== undefined;
    await query(
      `UPDATE crm_cases
          SET customer_id = $3, subject = $4, body = $5, status = $6, priority = $7,
              category = $8,
              order_id = CASE WHEN $13 THEN $9::uuid ELSE order_id END,
              assigned_to = $10, assignee_user_id = $14, resolution = $11,
              resolved_at = CASE WHEN $12 THEN coalesce(resolved_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        input.id,
        input.customerId ?? null,
        input.subject.trim(),
        input.body?.trim() ?? "",
        status,
        input.priority ?? "normal",
        input.category?.trim() ?? "",
        input.orderId ?? null,
        owner.name,
        input.resolution?.trim() ?? "",
        resolved,
        orderIdProvided,
        owner.userId,
      ],
    );
    return (await getCase(businessId, input.id))!;
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_cases
       (business_id, customer_id, subject, body, status, priority, category, order_id,
        assigned_to, assignee_user_id, resolution, resolved_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             CASE WHEN $12 THEN now() ELSE NULL END, $13)
     RETURNING id`,
    [
      businessId,
      input.customerId ?? null,
      input.subject.trim(),
      input.body?.trim() ?? "",
      status,
      input.priority ?? "normal",
      input.category?.trim() ?? "",
      input.orderId ?? null,
      owner.name,
      owner.userId,
      input.resolution?.trim() ?? "",
      resolved,
      input.createdBy ?? "",
    ],
  );
  const opened = (await getCase(businessId, rows[0].id))!;
  // Only a ticket that arrives *open* is an event somebody promised to act on.
  // One imported already-resolved, or filed closed by its author, asks nothing
  // of anybody — a rule that assigned it would be inventing work.
  if (!resolved) {
    const summary = await runCrmAutomations(businessId, {
      trigger: "case_opened",
      entity: {
        type: "case",
        id: opened.id,
        title: opened.subject,
        partyId: opened.customerId,
        priority: opened.priority,
        ownerUserId: opened.assigneeUserId,
        ownerName: opened.assignedTo,
      },
      actor: { name: input.createdBy ?? "", userId: input.createdById ?? null },
    });
    // A rule may have assigned this ticket; the caller must see the ticket it
    // will find when it reloads, not the one it looked at a moment ago.
    if (summary.applied > 0 || summary.growthSignals > 0) {
      return (await getCase(businessId, rows[0].id))!;
    }
  }
  return opened;
}

/** One case by id — the read every write path returns through. */
export async function getCase(businessId: string, caseId: string): Promise<CrmCase | null> {
  const { rows } = await query<CrmCase>(
    `SELECT ${CASE_COLUMNS} FROM crm_cases k
       LEFT JOIN parties c ON c.id = k.customer_id
      WHERE k.business_id = $1 AND k.id = $2`,
    [businessId, caseId],
  );
  return rows[0] ?? null;
}

export async function deleteCase(businessId: string, caseId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM crm_cases WHERE business_id = $1 AND id = $2`, [
    businessId,
    caseId,
  ]);
  return (rowCount ?? 0) > 0;
}
