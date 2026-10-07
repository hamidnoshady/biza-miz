import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode, MissingLedgerAccountError, postJournalEntry } from "./ledger-service";
import { isoDateToJalali, jalaliMonthLength, jalaliToIsoDate } from "./jalali";
import { isUuid } from "./uuid";
import { businessToday } from "./business-day-service";
import { normalizePosSearchText } from "./pos-selection";
import { isValidIsoDate } from "./iso-date";
import {
  decodeVoucherCursor,
  encodeVoucherCursor,
  isSettlementMethod,
  settlementCodeForMethod,
  VOUCHER_PAGE_SIZE,
  VOUCHER_PAGE_SIZE_MAX,
  type SettlementMethod,
  type VoucherCursor,
  type VoucherListFilters,
} from "./voucher-shared";

/**
 * Installment schedules (اقساط) — see migrations/0140_installments.sql for the
 * data model and the "schedule posts when the slice settles" contract.
 */

export class InstallmentError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export type InstallmentDirection = "receivable" | "payable";

export interface InstallmentPlanInput {
  businessId: string;
  locationId: string | null;
  direction: InstallmentDirection;
  source: "party" | "invoice";
  partyId?: string | null;
  invoiceOrderId?: string | null;
  /** Integer Rial; ignored (derived from the order) for invoice plans. */
  principal: number;
  downPayment?: number;
  interestPercent?: number;
  lateFeePercent?: number;
  installmentCount: number;
  intervalMonths: number;
  firstDueDate: string; // ISO YYYY-MM-DD
  note?: string | null;
  createdBy: string | null;
}

export interface InstallmentItemRow {
  id: string;
  seq: number;
  dueDate: string;
  amount: number;
  paidAt: string | null;
  paidMethod: SettlementMethod | null;
  paidMemo: string | null;
}

export interface InstallmentPlanRow {
  id: string;
  direction: InstallmentDirection;
  source: "party" | "invoice";
  partyId: string | null;
  partyName: string | null;
  invoiceOrderId: string | null;
  invoiceOrderNumber: number | null;
  principal: number;
  downPayment: number;
  interestPercent: number;
  lateFeePercent: number;
  installmentCount: number;
  intervalMonths: number;
  firstDueDate: string;
  note: string | null;
  createdAt: string;
  paidTotal: number;
  /** Sum of every slice on the schedule — principal net of the down payment, plus interest. */
  scheduledTotal: number;
  /** Sum of the slices still unpaid. */
  remaining: number;
  paidCount: number;
  nextDueDate: string | null;
  status: "open" | "overdue" | "settled";
  items?: InstallmentItemRow[];
}

/** Adds Jalali months to an ISO date, clamping the day into the target month. */
export function addJalaliMonths(iso: string, months: number): string {
  const j = isoDateToJalali(iso);
  if (!j) return iso;
  const total = j.jm - 1 + months;
  const jy = j.jy + Math.floor(total / 12);
  const jm = (total % 12) + 1;
  const jd = Math.min(j.jd, jalaliMonthLength(jy, jm));
  return jalaliToIsoDate(jy, jm, jd);
}

/**
 * `today` is the *business's* today (`businessToday`), not a UTC date slice.
 *
 * A slice due today read «سررسید گذشته» for the first three and a half hours of
 * every Tehran day, because `new Date().toISOString()` was still on yesterday's
 * date — and for a branch whose trading day runs 18:00→03:00 that is most of
 * the shift that would be chasing the payment.
 */
function planStatus(
  paidCount: number,
  count: number,
  nextDueDate: string | null,
  today: string,
): "open" | "overdue" | "settled" {
  if (paidCount >= count) return "settled";
  if (nextDueDate && nextDueDate < today) return "overdue";
  return "open";
}

export async function createInstallmentPlan(input: InstallmentPlanInput): Promise<{ id: string }> {
  if (input.direction !== "receivable" && input.direction !== "payable") throw new InstallmentError("invalid_direction");
  if (input.source !== "party" && input.source !== "invoice") throw new InstallmentError("invalid_source");
  if (input.source === "invoice" && input.direction !== "receivable") throw new InstallmentError("invalid_source");
  if (!Number.isSafeInteger(input.principal) || input.principal <= 0) throw new InstallmentError("invalid_amount");
  const downPayment = input.downPayment ?? 0;
  if (!Number.isSafeInteger(downPayment) || downPayment < 0) throw new InstallmentError("invalid_down_payment");
  if (!Number.isInteger(input.installmentCount) || input.installmentCount < 1 || input.installmentCount > 120) {
    throw new InstallmentError("invalid_installment_count");
  }
  if (!Number.isInteger(input.intervalMonths) || input.intervalMonths < 1 || input.intervalMonths > 36) {
    throw new InstallmentError("invalid_interval");
  }
  // A shape-only regex accepts impossible dates such as 2026-02-31. PostgreSQL
  // then throws a date parser error which used to escape as a 500 response.
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.firstDueDate);
  if (!dateMatch) throw new InstallmentError("invalid_due_date");
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const parsedDueDate = new Date(Date.UTC(year, month - 1, day));
  if (
    parsedDueDate.getUTCFullYear() !== year ||
    parsedDueDate.getUTCMonth() !== month - 1 ||
    parsedDueDate.getUTCDate() !== day
  ) {
    throw new InstallmentError("invalid_due_date");
  }
  const interestPercent = input.interestPercent ?? 0;
  const lateFeePercent = input.lateFeePercent ?? 0;
  // `Number.isFinite` first: every comparison against NaN is false, so a NaN
  // percent (what `Number("۵")` produces, and what the route forwards) walked
  // straight through a `< 0 || > 100` check and turned every slice amount into
  // NaN, which the insert then failed on with a 500 rather than a message.
  if (
    !Number.isFinite(interestPercent) ||
    !Number.isFinite(lateFeePercent) ||
    interestPercent < 0 ||
    interestPercent > 100 ||
    lateFeePercent < 0 ||
    lateFeePercent > 100
  ) {
    throw new InstallmentError("invalid_percent");
  }

  let partyId = input.partyId?.trim() || null;
  let principal = input.principal;
  let invoiceOrderId: string | null = null;

  if (input.source === "invoice") {
    if (!input.invoiceOrderId) throw new InstallmentError("invoice_required");
    if (!isUuid(input.invoiceOrderId)) throw new InstallmentError("invoice_not_found", 404);
    const { rows } = await query<{
      id: string;
      total: string;
      customer_id: string | null;
      credit_total: string;
      already_scheduled: boolean;
    }>(
      `SELECT o.id, o.total, o.customer_id,
              COALESCE((SELECT sum(p.amount) FROM payments p
                         WHERE p.order_id = o.id AND p.method = 'credit'), 0)::text AS credit_total,
              EXISTS (SELECT 1 FROM installments ip
                       WHERE ip.business_id = $2 AND ip.invoice_order_id = o.id) AS already_scheduled
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE o.id = $1 AND l.business_id = $2 AND o.type = 'retail'`,
      [input.invoiceOrderId, input.businessId],
    );
    if (!rows[0]) throw new InstallmentError("invoice_not_found", 404);
    if (!rows[0].customer_id) throw new InstallmentError("invoice_has_no_customer");
    /*
     * The invoice has to be the one that *raised* the receivable.
     *
     * Settling a slice posts an `ar_receipt` — Debit Cash / Credit A/R — so
     * scheduling an invoice that was already paid in cash credits a receivable
     * nothing ever debited: A/R drifts negative and the customer's statement
     * shows money coming in against an invoice they never owed. Only a
     * credit-settled invoice has a balance to schedule.
     */
    const creditTotal = Number(rows[0].credit_total);
    if (!Number.isSafeInteger(creditTotal) || creditTotal <= 0) throw new InstallmentError("invoice_not_on_credit");
    if (rows[0].already_scheduled) throw new InstallmentError("invoice_already_scheduled", 409);
    invoiceOrderId = rows[0].id;
    partyId = rows[0].customer_id;
    // Split-payment and amended invoices may have a credit portion different
    // from the invoice total. Only that portion ever debited A/R.
    principal = creditTotal;
  } else if (!partyId) {
    throw new InstallmentError("party_required");
  }

  if (partyId) {
    // A non-uuid id raises a Postgres syntax error instead of matching nothing.
    if (!isUuid(partyId)) throw new InstallmentError("party_not_found", 404);
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
      [partyId, input.businessId],
    );
    if (!rows[0]) throw new InstallmentError("party_not_found", 404);
    if (input.direction === "payable") {
      // Settling a payable slice posts an ap_payments row, which needs the
      // party's per-location supplier record — refuse the plan up front
      // rather than at the first slice.
      const { rows: supplierRows } = await query<{ id: string }>(
        `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
          WHERE s.party_id = $1 AND l.business_id = $2
            AND ($3::uuid IS NULL OR s.location_id = $3)
          ORDER BY s.id LIMIT 1`,
        [partyId, input.businessId, input.locationId],
      );
      if (!supplierRows[0]) throw new InstallmentError("supplier_record_missing", 409);
    }
  }

  const financed = principal - downPayment;
  if (financed <= 0) throw new InstallmentError("down_payment_exceeds_principal");
  const withInterest = Math.round(financed * (1 + interestPercent / 100));
  const perItem = Math.floor(withInterest / input.installmentCount);
  if (perItem <= 0) throw new InstallmentError("installment_amount_too_small");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO installments (business_id, location_id, direction, source, party_id, invoice_order_id,
                                 principal, down_payment, interest_percent, late_fee_percent,
                                 installment_count, interval_months, first_due_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        input.businessId,
        input.locationId,
        input.direction,
        input.source,
        partyId,
        invoiceOrderId,
        principal,
        downPayment,
        interestPercent,
        lateFeePercent,
        input.installmentCount,
        input.intervalMonths,
        input.firstDueDate,
        input.note?.trim() || null,
        input.createdBy,
      ],
    );
    const planId = rows[0].id;

    // Interest increases the counterparty balance beyond the principal that was
    // already posted by the invoice/subledger. Accrue that increase now;
    // otherwise settling every slice would over-credit A/R (or over-debit A/P)
    // and leave the ledger negative by exactly the interest amount.
    const interestAmount = withInterest - financed;
    if (interestAmount > 0) {
      const balanceCode = input.direction === "receivable"
        ? WELL_KNOWN_CODES.accountsReceivable
        : WELL_KNOWN_CODES.accountsPayable;
      const interestCode = input.direction === "receivable"
        ? WELL_KNOWN_CODES.otherIncome
        : WELL_KNOWN_CODES.otherExpense;
      const accounts = await accountIdsByCode(client, input.businessId, [balanceCode, interestCode]);
      const { rows: dateRows } = await client.query<{ business_date: string }>(
        `SELECT app_business_date(now(), COALESCE(l.timezone, 'Asia/Tehran'), l.business_day_start_minutes)::text AS business_date
           FROM (SELECT 1) one
           LEFT JOIN locations l ON l.id = $1 AND l.business_id = $2`,
        [input.locationId, input.businessId],
      );
      const balanceAccount = accounts.get(balanceCode)!;
      const interestAccount = accounts.get(interestCode)!;
      await postJournalEntry(client, {
        businessId: input.businessId,
        locationId: input.locationId,
        entryDate: dateRows[0].business_date,
        memo: `سود برنامه اقساط${partyId ? " طرف‌حساب" : ""}`,
        sourceType: "installment_interest",
        sourceId: planId,
        createdBy: input.createdBy,
        postingKind: "installment_interest",
        lines: input.direction === "receivable"
          ? [
              { accountId: balanceAccount, debit: interestAmount, credit: 0 },
              { accountId: interestAccount, debit: 0, credit: interestAmount },
            ]
          : [
              { accountId: interestAccount, debit: interestAmount, credit: 0 },
              { accountId: balanceAccount, debit: 0, credit: interestAmount },
            ],
      });
    }

    for (let seq = 1; seq <= input.installmentCount; seq += 1) {
      const amount = seq === input.installmentCount ? withInterest - perItem * (input.installmentCount - 1) : perItem;
      const dueDate = addJalaliMonths(input.firstDueDate, (seq - 1) * input.intervalMonths);
      await client.query(
        `INSERT INTO installment_items (installment_id, seq, due_date, amount) VALUES ($1, $2, $3, $4)`,
        [planId, seq, dueDate, amount],
      );
    }
    await client.query("COMMIT");
    return { id: planId };
  } catch (err) {
    await client.query("ROLLBACK");
    // The partial unique index is the final guard against two concurrent
    // requests scheduling the same invoice after both passed the friendly
    // pre-check above.
    if ((err as { code?: string; constraint?: string }).code === "23505" &&
        (err as { constraint?: string }).constraint === "idx_installments_invoice_plan") {
      throw new InstallmentError("invoice_already_scheduled", 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

interface PlanDbRow {
  [key: string]: unknown;
  id: string;
  direction: InstallmentDirection;
  plan_today: string | null;
  source: "party" | "invoice";
  party_id: string | null;
  party_name: string | null;
  invoice_order_id: string | null;
  order_number: string | null;
  principal: string;
  down_payment: string;
  interest_percent: string;
  late_fee_percent: string;
  installment_count: string;
  interval_months: string;
  first_due_date: string;
  note: string | null;
  created_at: string;
  paid_total: string | null;
  paid_count: string | null;
  scheduled_total: string | null;
  unpaid_total: string | null;
  next_due_date: string | null;
}

/**
 * `remaining` is the sum of the *unpaid slices*, not `principal - paidTotal`.
 *
 * The schedule's total is the financed amount (principal less the down
 * payment) grossed up by the interest percent, so subtracting payments from the
 * principal was wrong in both directions at once: a plan with a down payment
 * showed a balance still owing after the last slice settled — «تسویه شده» next
 * to a non-zero مانده — and a plan with interest understated what was left.
 * Asking the slices removes the arithmetic entirely.
 */
function mapPlanRow(r: PlanDbRow, today: string, items?: InstallmentItemRow[]): InstallmentPlanRow {
  const count = Number(r.installment_count);
  const paidCount = Number(r.paid_count ?? 0);
  const principal = Number(r.principal);
  const paidTotal = Number(r.paid_total ?? 0);
  const scheduledTotal = Number(r.scheduled_total ?? 0);
  const remaining = Number(r.unpaid_total ?? 0);
  const nextDueDate = r.next_due_date ?? null;
  return {
    id: r.id,
    direction: r.direction,
    source: r.source,
    partyId: r.party_id,
    partyName: r.party_name,
    invoiceOrderId: r.invoice_order_id,
    invoiceOrderNumber: r.order_number ? Number(r.order_number) : null,
    principal,
    downPayment: Number(r.down_payment),
    interestPercent: Number(r.interest_percent),
    lateFeePercent: Number(r.late_fee_percent),
    installmentCount: count,
    intervalMonths: Number(r.interval_months),
    firstDueDate: r.first_due_date,
    note: r.note,
    createdAt: r.created_at,
    paidTotal,
    scheduledTotal,
    remaining,
    paidCount,
    nextDueDate,
    status: planStatus(paidCount, count, nextDueDate, r.plan_today ?? today),
    items,
  };
}

const PLAN_SELECT = `
  SELECT p.id, p.direction, p.source, p.party_id, pa.name AS party_name,
         CASE WHEN p.location_id IS NULL THEN NULL
              ELSE app_business_date(now(), COALESCE(pl.timezone, 'Asia/Tehran'), pl.business_day_start_minutes)::text
          END AS plan_today,
         p.invoice_order_id, o.order_number, p.principal, p.down_payment,
         p.interest_percent, p.late_fee_percent, p.installment_count,
         p.interval_months, p.first_due_date, p.note, p.created_at,
         (SELECT COALESCE(sum(i.amount), 0) FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NOT NULL) AS paid_total,
         (SELECT count(*) FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NOT NULL) AS paid_count,
         (SELECT COALESCE(sum(i.amount), 0) FROM installment_items i
           WHERE i.installment_id = p.id) AS scheduled_total,
         (SELECT COALESCE(sum(i.amount), 0) FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NULL) AS unpaid_total,
         (SELECT min(i.due_date)::text FROM installment_items i
           WHERE i.installment_id = p.id AND i.paid_at IS NULL) AS next_due_date
    FROM installments p
    LEFT JOIN parties pa ON pa.id = p.party_id
    LEFT JOIN orders o ON o.id = p.invoice_order_id
    LEFT JOIN locations pl ON pl.id = p.location_id`;

export async function listInstallmentPlans(
  businessId: string,
  filters: { direction: InstallmentDirection; q?: string; status?: "open" | "settled" | "overdue" | "all" },
): Promise<InstallmentPlanRow[]> {
  const { rows } = await query<PlanDbRow>(
    `${PLAN_SELECT}
     WHERE p.business_id = $1 AND p.direction = $2
     ORDER BY p.created_at DESC, p.id`,
    [businessId, filters.direction],
  );
  const q = filters.q?.trim();
  const today = await businessToday(businessId);
  let plans = rows.map((r) => mapPlanRow(r, today));
  if (q) {
    plans = plans.filter(
      (p) =>
        (p.partyName ?? "").includes(q) ||
        (p.invoiceOrderNumber !== null && String(p.invoiceOrderNumber).includes(q)),
    );
  }
  const status = filters.status ?? "all";
  if (status !== "all") plans = plans.filter((p) => p.status === status);
  return plans;
}

export async function getInstallmentPlan(businessId: string, planId: string): Promise<InstallmentPlanRow | null> {
  if (!isUuid(planId)) return null;
  const { rows } = await query<PlanDbRow>(`${PLAN_SELECT} WHERE p.business_id = $1 AND p.id = $2`, [businessId, planId]);
  if (!rows[0]) return null;
  const { rows: itemRows } = await query<{
    id: string;
    seq: string;
    due_date: string;
    amount: string;
    paid_at: string | null;
    paid_method: SettlementMethod | null;
    paid_memo: string | null;
  }>(
    `SELECT id, seq, due_date::text AS due_date, amount::text AS amount,
            paid_at::text AS paid_at, paid_method, paid_memo
       FROM installment_items WHERE installment_id = $1 ORDER BY seq`,
    [planId],
  );
  return mapPlanRow(rows[0], await businessToday(businessId), itemRows.map((i) => ({
    id: i.id,
    seq: Number(i.seq),
    dueDate: i.due_date,
    amount: Number(i.amount),
    paidAt: i.paid_at,
    paidMethod: i.paid_method,
    paidMemo: i.paid_memo,
  })));
}

/**
 * Settles one slice. Receivable slices post the exact ar_receipt pair
 * (Debit Cash/Bank / Credit A/R); payable slices the ap_payments mirror —
 * in the same transaction that marks the slice paid, so plan and ledger
 * cannot disagree.
 */
export async function payInstallmentItem(params: {
  businessId: string;
  locationId: string | null;
  planId: string;
  itemId: string;
  method: SettlementMethod;
  memo?: string | null;
  createdBy: string | null;
}): Promise<void> {
  // UUID route parameters are untrusted. Passing malformed values to a uuid
  // comparison produces a PostgreSQL parser error instead of a useful 404.
  if (!isUuid(params.planId)) throw new InstallmentError("plan_not_found", 404);
  if (!isUuid(params.itemId)) throw new InstallmentError("item_not_found", 404);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: planRows } = await client.query<{
      id: string;
      direction: InstallmentDirection;
      party_id: string | null;
      party_name: string | null;
      location_id: string | null;
    }>(
      `SELECT p.id, p.direction, p.party_id, p.location_id, pa.name AS party_name
         FROM installments p LEFT JOIN parties pa ON pa.id = p.party_id
        WHERE p.business_id = $1 AND p.id = $2`,
      [params.businessId, params.planId],
    );
    const plan = planRows[0];
    if (!plan) throw new InstallmentError("plan_not_found", 404);
    if (!plan.party_id) throw new InstallmentError("plan_has_no_party");

    const { rows: itemRows } = await client.query<{ id: string; amount: string; paid_at: string | null; seq: string }>(
      `SELECT id, amount::text AS amount, paid_at::text AS paid_at, seq::text AS seq
         FROM installment_items WHERE id = $1 AND installment_id = $2 FOR UPDATE`,
      [params.itemId, params.planId],
    );
    const item = itemRows[0];
    if (!item) throw new InstallmentError("item_not_found", 404);
    if (item.paid_at) throw new InstallmentError("already_paid");
    const amount = Number(item.amount);

    if (!isSettlementMethod(params.method)) throw new InstallmentError("invalid_method");
    const balanceAccountCode = plan.direction === "receivable"
      ? WELL_KNOWN_CODES.accountsReceivable
      : WELL_KNOWN_CODES.accountsPayable;
    // Issue #829: installment slices share the voucher settlement vocabulary.
    // "bank" means money at the bank (1110); deferred/uncleared cheques use the
    // explicit "clearing" method (1120). The old bank->clearing mapping is gone.
    const cashAccountCode = settlementCodeForMethod(params.method);
    // Do not require the opposite subledger account: a receivable settlement
    // must not fail merely because this business has no active A/P account.
    const accounts = await accountIdsByCode(client, params.businessId, [balanceAccountCode, cashAccountCode]);
    const cashAccount = accounts.get(cashAccountCode)!;
    const effectiveLocationId = plan.location_id ?? params.locationId;
    const { rows: dateRows } = await client.query<{ business_date: string }>(
      `SELECT app_business_date(now(), COALESCE(l.timezone, 'Asia/Tehran'), l.business_day_start_minutes)::text AS business_date
         FROM (SELECT 1) one
         LEFT JOIN locations l ON l.id = $1 AND l.business_id = $2`,
      [effectiveLocationId, params.businessId],
    );
    const paymentDate = dateRows[0].business_date;

    const memo = params.memo?.trim() || `قسط ${item.seq} — ${plan.party_name ?? ""}`;

    if (plan.direction === "receivable") {
      const arAccount = accounts.get(WELL_KNOWN_CODES.accountsReceivable)!;
      const { rows: voucherRows } = await client.query<{ voucher_number: string }>(
        `INSERT INTO ar_ap_voucher_counters (business_id, last_ar_voucher_number, last_ap_voucher_number)
         VALUES ($1, 1, 0)
         ON CONFLICT (business_id) DO UPDATE
           SET last_ar_voucher_number = ar_ap_voucher_counters.last_ar_voucher_number + 1
         RETURNING last_ar_voucher_number::text AS voucher_number`,
        [params.businessId],
      );
      const { rows } = await client.query<{ id: string; receipt_date: string }>(
        `INSERT INTO ar_receipts
           (business_id, location_id, customer_id, receipt_date, method, settlement_account_id, voucher_number, amount, memo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, receipt_date::text AS receipt_date`,
        [params.businessId, effectiveLocationId, plan.party_id, paymentDate, params.method, cashAccount, voucherRows[0].voucher_number, amount, memo, params.createdBy],
      );
      await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: effectiveLocationId,
        entryDate: rows[0].receipt_date,
        memo,
        sourceType: "ar_receipt",
        sourceId: rows[0].id,
        createdBy: params.createdBy,
        postingKind: "ar_receipt",
        lines: [
          { accountId: cashAccount, debit: amount, credit: 0 },
          { accountId: arAccount, debit: 0, credit: amount },
        ],
      });
      await client.query(
        `UPDATE installment_items SET paid_at = now(), paid_method = $1, paid_memo = $2, receipt_id = $3 WHERE id = $4`,
        [params.method, params.memo?.trim() || null, rows[0].id, params.itemId],
      );
    } else {
      // ap_payments points at the per-location supplier row, not the party.
      const { rows: supplierRows } = await client.query<{ id: string }>(
        `SELECT s.id FROM suppliers s JOIN locations l ON l.id = s.location_id
          WHERE s.party_id = $1 AND l.business_id = $2
            AND ($3::uuid IS NULL OR s.location_id = $3)
          ORDER BY s.id LIMIT 1`,
        [plan.party_id, params.businessId, effectiveLocationId],
      );
      if (!supplierRows[0]) throw new InstallmentError("supplier_record_missing", 409);
      const apAccount = accounts.get(WELL_KNOWN_CODES.accountsPayable)!;
      const { rows: voucherRows } = await client.query<{ voucher_number: string }>(
        `INSERT INTO ar_ap_voucher_counters (business_id, last_ar_voucher_number, last_ap_voucher_number)
         VALUES ($1, 0, 1)
         ON CONFLICT (business_id) DO UPDATE
           SET last_ap_voucher_number = ar_ap_voucher_counters.last_ap_voucher_number + 1
         RETURNING last_ap_voucher_number::text AS voucher_number`,
        [params.businessId],
      );
      const { rows } = await client.query<{ id: string; payment_date: string }>(
        `INSERT INTO ap_payments
           (business_id, location_id, supplier_id, payment_date, method, settlement_account_id, voucher_number, amount, memo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, payment_date::text AS payment_date`,
        [params.businessId, effectiveLocationId, supplierRows[0].id, paymentDate, params.method, cashAccount, voucherRows[0].voucher_number, amount, memo, params.createdBy],
      );
      await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: effectiveLocationId,
        entryDate: rows[0].payment_date,
        memo,
        sourceType: "ap_payment",
        sourceId: rows[0].id,
        createdBy: params.createdBy,
        postingKind: "ap_payment",
        lines: [
          { accountId: apAccount, debit: amount, credit: 0 },
          { accountId: cashAccount, debit: 0, credit: amount },
        ],
      });
      await client.query(
        `UPDATE installment_items SET paid_at = now(), paid_method = $1, paid_memo = $2, payment_id = $3 WHERE id = $4`,
        [params.method, params.memo?.trim() || null, rows[0].id, params.itemId],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Folds a column into the alphabet `normalizePosSearchText` folds the typed
 * needle into — Arabic ي/ك to Persian ی/ک and both digit sets to ASCII — so a
 * search behaves like the pickers everywhere else in the app («علي» is found
 * by typing «علی», «۱۲» finds «12»). Kept as inline `translate` rather than a
 * stored function: one expression, no migration needed.
 */
const SEARCH_FOLD = "translate(%s, 'يك٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', 'یک01234567890123456789')";

/**
 * The `q` argument as a LIKE pattern, or null when there is nothing to search
 * for. The needle is normalized exactly the way the client-side pickers
 * normalize it (same `normalizePosSearchText`), then the LIKE wildcards it may
 * contain are escaped — «%» must find a literal «%», not swallow the table.
 */
function searchPattern(q: string | undefined): string | null {
  const needle = normalizePosSearchText(q ?? "");
  if (!needle) return null;
  return `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export interface ReceiptListRow {
  id: string;
  date: string;
  method: SettlementMethod;
  amount: number;
  memo: string | null;
  partyId: string;
  partyName: string;
  voucherNumber: number | null;
  locationId: string | null;
  locationName: string | null;
  createdAt: string;
  createdByName: string | null;
  settlementAccountId: string | null;
  settlementAccountCode: string | null;
  settlementAccountName: string | null;
  entryId: string | null;
  reversedAt: string | null;
  reversalEntryId: string | null;
}

export interface PaymentListRow {
  id: string;
  date: string;
  method: SettlementMethod;
  amount: number;
  memo: string | null;
  supplierId: string;
  supplierPartyId: string | null;
  partyName: string;
  voucherNumber: number | null;
  locationId: string | null;
  locationName: string | null;
  createdAt: string;
  createdByName: string | null;
  settlementAccountId: string | null;
  settlementAccountCode: string | null;
  settlementAccountName: string | null;
  entryId: string | null;
  reversedAt: string | null;
  reversalEntryId: string | null;
}

export interface VoucherPage<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface VoucherListParams extends VoucherListFilters {
  limit?: number;
  cursor?: string | null;
}

class VoucherListError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) return VOUCHER_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), VOUCHER_PAGE_SIZE_MAX);
}

function parseCursor(raw: string | null | undefined): VoucherCursor | null {
  if (!raw) return null;
  const cursor = decodeVoucherCursor(raw);
  if (!cursor) throw new VoucherListError("invalid_cursor");
  return cursor;
}

function validateListFilters(filters: VoucherListFilters): void {
  if (filters.dateFrom && !isValidIsoDate(filters.dateFrom)) throw new VoucherListError("invalid_date_from");
  if (filters.dateTo && !isValidIsoDate(filters.dateTo)) throw new VoucherListError("invalid_date_to");
  if (filters.method && !isSettlementMethod(filters.method)) throw new VoucherListError("invalid_method");
  if (filters.status && filters.status !== "all" && filters.status !== "active" && filters.status !== "reversed") {
    throw new VoucherListError("invalid_status");
  }
  for (const key of ["partyId", "locationId", "settlementAccountId"] as const) {
    const value = filters[key];
    if (value && !isUuid(value)) throw new VoucherListError(`invalid_${key}`);
  }
  if (filters.minAmount !== undefined && (!Number.isInteger(filters.minAmount) || filters.minAmount < 0)) {
    throw new VoucherListError("invalid_min_amount");
  }
  if (filters.maxAmount !== undefined && (!Number.isInteger(filters.maxAmount) || filters.maxAmount < 0)) {
    throw new VoucherListError("invalid_max_amount");
  }
}

/**
 * Lists receipt vouchers — the «دریافت‌ها» ledger slice — newest first with
 * keyset pagination. Issue #829: the old version returned the business's
 * entire receipt history in one query; the route now pages through this with
 * a cursor so a large history never ships in one response.
 */
export async function listReceiptsPage(
  businessId: string,
  params: VoucherListParams = {},
): Promise<VoucherPage<ReceiptListRow>> {
  validateListFilters(params);
  const limit = clampLimit(params.limit);
  const cursor = parseCursor(params.cursor);
  const pattern = searchPattern(params.q);
  const values: Array<string | number | null> = [businessId];
  const conditions: string[] = ["r.business_id = $1"];
  const push = (value: string | number | null): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (pattern) {
    const p = push(pattern);
    conditions.push(`(${SEARCH_FOLD.replace("%s", "COALESCE(p.name, 'بدون مشتری مشخص')")} ILIKE ${p} ESCAPE '\\'
             OR ${SEARCH_FOLD.replace("%s", "COALESCE(r.memo, '')")} ILIKE ${p} ESCAPE '\\')`);
  }
  if (params.dateFrom) conditions.push(`r.receipt_date >= ${push(params.dateFrom)}::date`);
  if (params.dateTo) conditions.push(`r.receipt_date <= ${push(params.dateTo)}::date`);
  if (params.method) conditions.push(`r.method = ${push(params.method)}`);
  if (params.partyId) conditions.push(`r.customer_id = ${push(params.partyId)}::uuid`);
  if (params.locationId) conditions.push(`r.location_id = ${push(params.locationId)}::uuid`);
  if (params.settlementAccountId) conditions.push(`r.settlement_account_id = ${push(params.settlementAccountId)}::uuid`);
  if (params.minAmount !== undefined) conditions.push(`r.amount >= ${push(params.minAmount)}`);
  if (params.maxAmount !== undefined) conditions.push(`r.amount <= ${push(params.maxAmount)}`);
  if (params.status === "active") conditions.push(`r.reversed_at IS NULL`);
  if (params.status === "reversed") conditions.push(`r.reversed_at IS NOT NULL`);
  if (cursor) {
    const d = push(cursor.date);
    const c = push(cursor.createdAt);
    const i = push(cursor.id);
    conditions.push(`(r.receipt_date, r.created_at, r.id) < (${d}::date, ${c}::timestamptz, ${i}::uuid)`);
  }
  const fetch = push(limit + 1);

  const { rows } = await query<{
    id: string;
    receipt_date: string;
    method: SettlementMethod;
    amount: string;
    memo: string | null;
    customer_id: string;
    party_name: string | null;
    voucher_number: string | null;
    location_id: string | null;
    location_name: string | null;
    created_at: string;
    created_by_name: string | null;
    settlement_account_id: string | null;
    settlement_account_code: string | null;
    settlement_account_name: string | null;
    entry_id: string | null;
    reversed_at: string | null;
    reversal_entry_id: string | null;
  }>(
    `SELECT r.id, r.receipt_date::text AS receipt_date, r.method, r.amount::text AS amount, r.memo,
            r.customer_id, p.name AS party_name,
            r.voucher_number::text AS voucher_number,
            r.location_id, l.name AS location_name,
            r.created_at::text AS created_at, u.full_name AS created_by_name,
            r.settlement_account_id, a.code AS settlement_account_code, a.name AS settlement_account_name,
            je.id AS entry_id,
            r.reversed_at::text AS reversed_at, r.reversal_entry_id
       FROM ar_receipts r
       LEFT JOIN parties p ON p.id = r.customer_id
       LEFT JOIN locations l ON l.id = r.location_id
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN accounts a ON a.id = r.settlement_account_id
       LEFT JOIN journal_entries je
         ON je.business_id = r.business_id AND je.source_type = 'ar_receipt'
        AND je.source_id = r.id AND je.posting_kind = 'ar_receipt'
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.receipt_date DESC, r.created_at DESC, r.id DESC
      LIMIT ${fetch}`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.id,
      date: r.receipt_date,
      method: r.method,
      amount: Number(r.amount),
      memo: r.memo,
      partyId: r.customer_id,
      partyName: r.party_name ?? "بدون مشتری مشخص",
      voucherNumber: r.voucher_number === null ? null : Number(r.voucher_number),
      locationId: r.location_id,
      locationName: r.location_name,
      createdAt: r.created_at,
      createdByName: r.created_by_name,
      settlementAccountId: r.settlement_account_id,
      settlementAccountCode: r.settlement_account_code,
      settlementAccountName: r.settlement_account_name,
      entryId: r.entry_id,
      reversedAt: r.reversed_at,
      reversalEntryId: r.reversal_entry_id,
    })),
    nextCursor: hasMore && last
      ? encodeVoucherCursor({ date: last.receipt_date, createdAt: last.created_at, id: last.id })
      : null,
    hasMore,
  };
}

/**
 * Lists payment vouchers — the «پرداخت‌ها» ledger slice — newest first with
 * keyset pagination. Same cursor contract as receipts; A/P rows are keyed by
 * the branch supplier alias, so the party filter matches the alias id.
 */
export async function listPaymentsPage(
  businessId: string,
  params: VoucherListParams = {},
): Promise<VoucherPage<PaymentListRow>> {
  validateListFilters(params);
  const limit = clampLimit(params.limit);
  const cursor = parseCursor(params.cursor);
  const pattern = searchPattern(params.q);
  const values: Array<string | number | null> = [businessId];
  const conditions: string[] = ["p.business_id = $1"];
  const push = (value: string | number | null): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (pattern) {
    const ph = push(pattern);
    conditions.push(`(${SEARCH_FOLD.replace("%s", "COALESCE(pa.name, s.name, 'بدون تأمین‌کننده مشخص')")} ILIKE ${ph} ESCAPE '\\'
             OR ${SEARCH_FOLD.replace("%s", "COALESCE(p.memo, '')")} ILIKE ${ph} ESCAPE '\\')`);
  }
  if (params.dateFrom) conditions.push(`p.payment_date >= ${push(params.dateFrom)}::date`);
  if (params.dateTo) conditions.push(`p.payment_date <= ${push(params.dateTo)}::date`);
  if (params.method) conditions.push(`p.method = ${push(params.method)}`);
  if (params.partyId) conditions.push(`p.supplier_id = ${push(params.partyId)}::uuid`);
  if (params.locationId) conditions.push(`p.location_id = ${push(params.locationId)}::uuid`);
  if (params.settlementAccountId) conditions.push(`p.settlement_account_id = ${push(params.settlementAccountId)}::uuid`);
  if (params.minAmount !== undefined) conditions.push(`p.amount >= ${push(params.minAmount)}`);
  if (params.maxAmount !== undefined) conditions.push(`p.amount <= ${push(params.maxAmount)}`);
  if (params.status === "active") conditions.push(`p.reversed_at IS NULL`);
  if (params.status === "reversed") conditions.push(`p.reversed_at IS NOT NULL`);
  if (cursor) {
    const d = push(cursor.date);
    const c = push(cursor.createdAt);
    const i = push(cursor.id);
    conditions.push(`(p.payment_date, p.created_at, p.id) < (${d}::date, ${c}::timestamptz, ${i}::uuid)`);
  }
  const fetch = push(limit + 1);

  const { rows } = await query<{
    id: string;
    payment_date: string;
    method: SettlementMethod;
    amount: string;
    memo: string | null;
    supplier_id: string;
    supplier_party_id: string | null;
    party_name: string | null;
    voucher_number: string | null;
    location_id: string | null;
    location_name: string | null;
    created_at: string;
    created_by_name: string | null;
    settlement_account_id: string | null;
    settlement_account_code: string | null;
    settlement_account_name: string | null;
    entry_id: string | null;
    reversed_at: string | null;
    reversal_entry_id: string | null;
  }>(
    `SELECT p.id, p.payment_date::text AS payment_date, p.method, p.amount::text AS amount, p.memo,
            p.supplier_id, s.party_id AS supplier_party_id,
            COALESCE(pa.name, s.name) AS party_name,
            p.voucher_number::text AS voucher_number,
            p.location_id, l.name AS location_name,
            p.created_at::text AS created_at, u.full_name AS created_by_name,
            p.settlement_account_id, a.code AS settlement_account_code, a.name AS settlement_account_name,
            je.id AS entry_id,
            p.reversed_at::text AS reversed_at, p.reversal_entry_id
       FROM ap_payments p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN parties pa ON pa.id = s.party_id
       LEFT JOIN locations l ON l.id = p.location_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN accounts a ON a.id = p.settlement_account_id
       LEFT JOIN journal_entries je
         ON je.business_id = p.business_id AND je.source_type = 'ap_payment'
        AND je.source_id = p.id AND je.posting_kind = 'ap_payment'
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC
      LIMIT ${fetch}`,
    values,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.id,
      date: r.payment_date,
      method: r.method,
      amount: Number(r.amount),
      memo: r.memo,
      supplierId: r.supplier_id,
      supplierPartyId: r.supplier_party_id,
      partyName: r.party_name ?? "بدون تأمین‌کننده مشخص",
      voucherNumber: r.voucher_number === null ? null : Number(r.voucher_number),
      locationId: r.location_id,
      locationName: r.location_name,
      createdAt: r.created_at,
      createdByName: r.created_by_name,
      settlementAccountId: r.settlement_account_id,
      settlementAccountCode: r.settlement_account_code,
      settlementAccountName: r.settlement_account_name,
      entryId: r.entry_id,
      reversedAt: r.reversed_at,
      reversalEntryId: r.reversal_entry_id,
    })),
    nextCursor: hasMore && last
      ? encodeVoucherCursor({ date: last.payment_date, createdAt: last.created_at, id: last.id })
      : null,
    hasMore,
  };
}

/**
 * Backwards-compatible wrappers kept for the pre-pagination call sites and
 * tests: the first page's rows, oldest contract (id/date/method/amount/memo/
 * partyName). New code uses the `*Page` variants with filters + cursor.
 */
export async function listReceipts(businessId: string, q?: string) {
  const page = await listReceiptsPage(businessId, { q, limit: VOUCHER_PAGE_SIZE_MAX });
  return page.rows.map((r) => ({
    id: r.id,
    date: r.date,
    method: r.method,
    amount: r.amount,
    memo: r.memo,
    partyName: r.partyName,
  }));
}

export async function listPayments(businessId: string, q?: string) {
  const page = await listPaymentsPage(businessId, { q, limit: VOUCHER_PAGE_SIZE_MAX });
  return page.rows.map((r) => ({
    id: r.id,
    date: r.date,
    method: r.method,
    amount: r.amount,
    memo: r.memo,
    partyName: r.partyName,
  }));
}

export { MissingLedgerAccountError };
export { VoucherListError };
