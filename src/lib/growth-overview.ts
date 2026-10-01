/**
 * Phase 36b — the Growth & Marketing app's dashboard query.
 *
 * Loyalty, campaigns/gift cards and commission each already had a service and
 * a report (`loyalty-service.ts`, `promotions-service.ts`,
 * `commission-service.ts`), and each already posted to the ledger through the
 * domain-event engine — but nothing could answer the owner's actual question,
 * «بازاریابی‌ام چه خبر؟», in one place. The three facts lived on three flat
 * pages, and the liabilities they created were only visible inside accounting.
 *
 * This file is that one place. It reads only existing tables — no new ledger
 * writes, no second source of truth for any number: every balance in the
 * "bridge" is reconstructed from `journal_lines` the same way the trial
 * balance reconstructs it, because a marketing dashboard that disagrees with
 * the books is worse than no dashboard.
 *
 * Windows are rolling 30-day ranges over the stored Gregorian ISO date
 * convention, labelled in the UI as «۳۰ روز گذشته» — deliberately not a
 * calendar month, so the number means the same thing on any day it is opened.
 */

import { query } from "./db";
import type { SessionPayload } from "./auth";
import { businessToday, getBusinessDayStatus } from "./business-day-service";
import { resolveActiveLocation } from "./setup-state";
import { WELL_KNOWN_CODES } from "./coa-template";
import { customersDueForRepurchase, getDefaultProgram, type DueForRepurchaseRow } from "./loyalty-service";
import {
  accountBalance,
  campaignStateCounts,
  campaignStateOrder,
  classifyCampaign,
  GROWTH_BRIDGE_CODES,
  rollingWindow,
  type CampaignState,
} from "./growth-shared";

// The app's pure half (also imported by its client screens) is re-exported
// here so server callers have one door into the Growth app's data layer.
export { accountBalance, campaignStateCounts, classifyCampaign, GROWTH_BRIDGE_CODES, rollingWindow };
export type { CampaignState };

export interface CampaignSummaryRow {
  id: string;
  name: string;
  kind: string;
  value: number;
  state: CampaignState;
  activeFrom: string | null;
  activeTo: string | null;
}

export interface CampaignPerformanceRow {
  promotionId: string;
  promotionName: string;
  applications: number;
  discountRial: number;
}

export interface StaffAccrualRow {
  employeeId: string;
  employeeName: string;
  amount: number;
}

export interface BridgeRow {
  code: string;
  name: string;
  /** "liability" | "expense" | … — decides how the balance is signed. */
  type: string;
  balance: number;
}

export type GrowthActivityKind = "campaign" | "points" | "gift_card" | "commission";

export interface GrowthActivityRow {
  at: string;
  kind: GrowthActivityKind;
  /** Who/what the row is about: campaign name, customer name, card code, staff name. */
  subject: string;
  /** Points for `points` rows (signed), Rial for the others. */
  amount: number;
  sourceType: string | null;
}

export interface GrowthOverview {
  window: { from: string; to: string };
  /** Repurchase predictions are per-branch, so no selected branch is not a zero result. */
  hasLocation: boolean;
  campaigns: {
    counts: Record<CampaignState, number>;
    list: CampaignSummaryRow[];
    applications: number;
    discountRial: number;
    top: CampaignPerformanceRow[];
  };
  loyalty: {
    programs: number;
    pointsOutstanding: number;
    /** The Rial value the outstanding points would redeem to at the default program's rate — an estimate, labelled as one. */
    pointsValueEstimate: number;
    earned30d: number;
    redeemed30d: number;
    customersWithPoints: number;
    customersTotal: number;
  };
  giftCards: {
    issued30d: number;
    issuedValue30d: number;
    /** The 2420 balance — the real liability, from the ledger. */
    outstandingRial: number;
  };
  /**
   * Compensation data. `null` when the reader lacks `commission.view` —
   * `redactGrowthOverview` (growth-access.ts) removes it on the server.
   */
  commission: {
    accrued30d: number;
    top: StaffAccrualRow[];
  } | null;
  repurchase: {
    due: number;
    sample: DueForRepurchaseRow[];
  };
  /** The Growth app's connection to accounting, as balances: 2410, 2420, 2300, 5210. */
  bridge: BridgeRow[];
  activity: GrowthActivityRow[];
}

/**
 * Everything the Growth dashboard shows, in one call. Reads only — this app
 * manages marketing; the moment it wants to move money it goes through the
 * posting rules its services already own.
 */
export async function growthOverview(
  businessId: string,
  opts: { locationId: string | null; today: string },
): Promise<GrowthOverview> {
  const { from, to } = rollingWindow(opts.today);

  const [
    promoRows,
    perfRows,
    pointActivityRows,
    pointBalanceRows,
    customerRows,
    programRows,
    giftCardRows,
    commissionRows,
    accountRows,
    activityRows,
    repurchase,
  ] = await Promise.all([
    query<{
      id: string;
      name: string;
      kind: string;
      value: string;
      active_from: string | null;
      active_to: string | null;
      is_active: boolean;
    }>(
      `SELECT id, name, kind, value, active_from::text, active_to::text, is_active
         FROM promotions
        WHERE business_id = $1
        ORDER BY created_at DESC`,
      [businessId],
    ),
    query<{ promotion_id: string; promotion_name: string | null; applications: number; discount: string }>(
      `SELECT pa.promotion_id, p.name AS promotion_name,
              COUNT(*)::int AS applications,
              COALESCE(SUM(pa.discount_rial), 0)::text AS discount
         FROM promotion_applications pa
         LEFT JOIN promotions p ON p.id = pa.promotion_id
        WHERE pa.business_id = $1
          AND pa.created_at::date >= $2 AND pa.created_at::date <= $3
        GROUP BY pa.promotion_id, p.name`,
      [businessId, from, to],
    ),
    query<{
      earned: number;
      redeemed: number;
    }>(
      `SELECT
              COALESCE(SUM(points) FILTER (WHERE points > 0 AND created_at::date >= $2 AND created_at::date <= $3), 0)::int AS earned,
              COALESCE(-SUM(points) FILTER (WHERE points < 0 AND created_at::date >= $2 AND created_at::date <= $3), 0)::int AS redeemed
         FROM customer_points
        WHERE business_id = $1`,
      [businessId, from, to],
    ),
    // A customer who earned and then redeemed every point is not "a customer
    // with points". Neither is one whose expiring lot lapsed. Calculate the
    // live balance in the same expiry-aware shape the customer screen uses.
    query<{
      outstanding: string;
      customers_with_points: number;
    }>(
      `SELECT COALESCE(SUM(balance), 0)::text AS outstanding,
              COUNT(*) FILTER (WHERE balance > 0)::int AS customers_with_points
         FROM (
           SELECT customer_id,
                  COALESCE(SUM(points) FILTER (WHERE expires_at IS NULL OR expires_at >= $2::date), 0) AS balance
             FROM customer_points
            WHERE business_id = $1
            GROUP BY customer_id
         ) point_balances`,
      [businessId, opts.today],
    ),
    // Compare point holders with actual, live customers — `parties` also holds
    // suppliers and staff, and a person may hold several roles.
    query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM parties
        WHERE business_id = $1
          AND roles && ARRAY['customer']::text[]
          AND is_active
          AND merged_into_id IS NULL`,
      [businessId],
    ),
    query<{ programs: number }>(
      `SELECT COUNT(*)::int AS programs FROM loyalty_programs WHERE business_id = $1 AND is_active`,
      [businessId],
    ),
    query<{ issued: number; value: string }>(
      `SELECT COUNT(*)::int AS issued, COALESCE(SUM(initial_value), 0)::text AS value
         FROM gift_cards
        WHERE business_id = $1 AND created_at::date >= $2 AND created_at::date <= $3`,
      [businessId, from, to],
    ),
    query<{ employee_id: string; employee_name: string | null; amount: string }>(
      `SELECT a.employee_id, COALESCE(u.full_name, 'نامشخص') AS employee_name,
              COALESCE(SUM(a.amount), 0)::text AS amount
         FROM commission_accruals a
         LEFT JOIN users u ON u.id = a.employee_id
        WHERE a.business_id = $1
          AND a.created_at::date >= $2 AND a.created_at::date <= $3
        GROUP BY a.employee_id, u.full_name
        ORDER BY COALESCE(SUM(a.amount), 0) DESC`,
      [businessId, from, to],
    ),
    query<{ code: string; name: string; type: string; debit: string; credit: string }>(
      `SELECT a.code, a.name, a.type::text, COALESCE(SUM(jl.debit), 0)::text AS debit, COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
        WHERE a.business_id = $1 AND a.code = ANY($2::text[])
        GROUP BY a.id
        ORDER BY a.code`,
      [businessId, [...GROWTH_BRIDGE_CODES]],
    ),
    query<{
      at: string;
      kind: GrowthActivityKind;
      subject: string | null;
      amount: string;
      source_type: string | null;
    }>(
      `(SELECT pa.created_at AS at, 'campaign' AS kind, p.name AS subject, pa.discount_rial::text AS amount, NULL::text AS source_type
          FROM promotion_applications pa
          LEFT JOIN promotions p ON p.id = pa.promotion_id
         WHERE pa.business_id = $1
         ORDER BY pa.created_at DESC LIMIT 5)
        UNION ALL
       (SELECT cp.created_at, 'points' AS kind, c.name AS subject, cp.points::text AS amount, cp.source_type
          FROM customer_points cp
          JOIN parties c ON c.id = cp.customer_id
         WHERE cp.business_id = $1
         ORDER BY cp.created_at DESC LIMIT 5)
        UNION ALL
       (SELECT gc.created_at, 'gift_card' AS kind, gc.code AS subject, gc.initial_value::text AS amount, NULL::text AS source_type
          FROM gift_cards gc
         WHERE gc.business_id = $1
         ORDER BY gc.created_at DESC LIMIT 5)
        UNION ALL
       (SELECT ca.created_at, 'commission' AS kind, COALESCE(u.full_name, 'نامشخص') AS subject, ca.amount::text AS amount, ca.source_type
          FROM commission_accruals ca
          LEFT JOIN users u ON u.id = ca.employee_id
         WHERE ca.business_id = $1
         ORDER BY ca.created_at DESC LIMIT 5)
        ORDER BY at DESC
        LIMIT 8`,
      [businessId],
    ),
    opts.locationId
      ? customersDueForRepurchase(businessId, opts.locationId, opts.today)
      : Promise.resolve([] as DueForRepurchaseRow[]),
  ]);

  const campaignList: CampaignSummaryRow[] = promoRows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: Number(row.value),
    state: classifyCampaign(
      { isActive: row.is_active, activeFrom: row.active_from, activeTo: row.active_to },
      opts.today,
    ),
    activeFrom: row.active_from,
    activeTo: row.active_to,
  }));
  // Running first, then scheduled, held and finished — `CAMPAIGN_STATES`'s own
  // order, the same one the campaigns list's filter bar offers.
  campaignList.sort(
    (a, b) => campaignStateOrder(a.state) - campaignStateOrder(b.state) || a.name.localeCompare(b.name),
  );

  const performance: CampaignPerformanceRow[] = perfRows.rows
    .map((row) => ({
      promotionId: row.promotion_id,
      promotionName: row.promotion_name ?? row.promotion_id,
      applications: Number(row.applications),
      discountRial: Number(row.discount),
    }))
    .sort((a, b) => b.discountRial - a.discountRial || b.applications - a.applications);

  const commissionAccruals: StaffAccrualRow[] = commissionRows.rows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? "نامشخص",
    amount: Number(row.amount),
  }));

  const bridge: BridgeRow[] = accountRows.rows.map((row) => ({
    code: row.code,
    name: row.name,
    type: row.type,
    balance: accountBalance(row.type, Number(row.debit), Number(row.credit)),
  }));

  const pointActivity = pointActivityRows.rows[0] ?? { earned: 0, redeemed: 0 };
  const pointBalances = pointBalanceRows.rows[0] ?? { outstanding: "0", customers_with_points: 0 };
  const outstandingPoints = Number(pointBalances.outstanding);
  const program = await getDefaultProgram(businessId);

  return {
    window: { from, to },
    hasLocation: Boolean(opts.locationId),
    campaigns: {
      counts: campaignStateCounts(campaignList.map((c) => c.state)),
      list: campaignList.slice(0, 6),
      applications: performance.reduce((sum, row) => sum + row.applications, 0),
      discountRial: performance.reduce((sum, row) => sum + row.discountRial, 0),
      top: performance.slice(0, 3),
    },
    loyalty: {
      programs: programRows.rows[0]?.programs ?? 0,
      pointsOutstanding: outstandingPoints,
      pointsValueEstimate: outstandingPoints * (program?.pointValueRial ?? 0),
      earned30d: pointActivity.earned,
      redeemed30d: pointActivity.redeemed,
      customersWithPoints: pointBalances.customers_with_points,
      customersTotal: customerRows.rows[0]?.total ?? 0,
    },
    giftCards: {
      issued30d: giftCardRows.rows[0]?.issued ?? 0,
      issuedValue30d: Number(giftCardRows.rows[0]?.value ?? 0),
      outstandingRial:
        bridge.find((row) => row.code === WELL_KNOWN_CODES.giftCardPayable)?.balance ?? 0,
    },
    commission: {
      accrued30d: commissionAccruals.reduce((sum, row) => sum + row.amount, 0),
      top: commissionAccruals.slice(0, 3),
    },
    repurchase: {
      due: repurchase.length,
      sample: repurchase.slice(0, 5),
    },
    bridge,
    activity: activityRows.rows.map((row) => ({
      at: new Date(row.at).toISOString(),
      kind: row.kind,
      subject: row.subject ?? "—",
      amount: Number(row.amount),
      sourceType: row.source_type ?? null,
    })),
  };
}

/**
 * The overview for whoever is asking, resolving *their* branch and *their*
 * business day first.
 *
 * `api/growth/overview` and `api/growth/accounting` both answer with this data
 * and both had to get there the same way — resolve the active location, read
 * that branch's open business day, fall back to the business's own «امروز»
 * when there is no branch or no open day — and both wrote those four lines out
 * by hand. Two copies of a date fallback is two chances for one endpoint to
 * report «۳۰ روز گذشته» ending on a different day from the other, which is
 * exactly the kind of disagreement this file exists to prevent. The two routes
 * differ in who may call them and in how much of the answer they return; that
 * is all they should differ in.
 */
export async function growthOverviewForSession(session: SessionPayload): Promise<GrowthOverview> {
  const location = await resolveActiveLocation(session);
  const businessDay = location ? await getBusinessDayStatus(location.id) : null;
  return growthOverview(session.businessId, {
    locationId: location?.id ?? null,
    today: businessDay?.businessDate ?? (await businessToday(session.businessId)),
  });
}
