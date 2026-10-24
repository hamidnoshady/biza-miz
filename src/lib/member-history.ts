/**
 * Issue #1007 — the vocabulary behind «حذف عضو» (hard membership removal).
 *
 * A membership with **no business history** — a wrong person, a test member, a
 * duplicate — can be deleted outright: the row, the login-identity link and the
 * empty personnel file. A membership that has *acted* in the business cannot:
 * orders, shifts, journal entries and the audit trail all attribute their work
 * to it, and every foreign key to `users` is `ON DELETE SET NULL`, so a hard
 * delete would silently orphan "who opened this order" throughout the ledger —
 * exactly why Phase 13 chose offboarding instead of deletion.
 *
 * This module holds the pure half: which flags exist, their Persian labels, the
 * attribution catalog behind the `reservations`/`records` flags, and the "does
 * any of them block deletion" predicate. It is deliberately free of
 * `node:crypto` and database imports so the Team screen (a `"use client"`
 * component) can render the same labels the server refuses with — one copy of
 * the catalogue, the arrangement `roles.ts` and `pin-policy.ts` already follow.
 *
 * The DB reads that fill the flags live in `team-service.ts`
 * (`memberHistoryFlags`), and the refusal order (self / last owner / history)
 * lives in `team.ts` (`hardDeleteRefusal`) beside its sibling `checkLastOwner`.
 */

/**
 * Why a member cannot be hard-deleted. One flag per kind of business history
 * the issue names, plus the ones the removal itself would destroy something
 * through: payroll money owed to the person, a personnel file that carries its
 * own financial record (only an *empty* file is deleted with the member), and —
 * from the code review on this branch — the business operations whose author
 * attribution is `ON DELETE SET NULL` and would silently vanish (reservations
 * first: `POST /api/reservations` writes `created_by` and no audit row).
 */
export interface MemberHistoryFlags {
  /** POS orders the member opened or closed, and payments they received. */
  orders: boolean;
  /** Shifts they worked (or force-closed). */
  shifts: boolean;
  /** Journal entries they posted to the ledger. */
  journal: boolean;
  /** Payroll runs they are on, and advances granted to (or by) them. */
  payroll: boolean;
  /**
   * Audited *business* actions attributed to them. The membership's own
   * account lifecycle (`team.*`) and sign-in security events do not count:
   * those rows are the bookkeeping of an account that is what the delete
   * removes — counting them would make every member undeletable from birth,
   * because creating one writes `team.member_created`.
   */
  audit: boolean;
  /** Their personnel file has financial history (orders, receipts, points…). */
  file: boolean;
  /** Reservations they booked (`reservations.created_by`). */
  reservations: boolean;
  /**
   * Other business operations authored by the member — purchases, stock
   * movements, expenses, returns, transfers, closings, the vertical modules'
   * documents… every transactional attribution the sweep in
   * `MEMBER_HISTORY_RECORD_ATTRIBUTIONS` covers.
   */
  records: boolean;
}

/** Persian name of each flag — the words the refusal sentence strings together. */
export const MEMBER_HISTORY_LABELS: Record<keyof MemberHistoryFlags, string> = {
  orders: "سفارش‌ها و پرداخت‌های ثبت‌شده",
  shifts: "شیفت‌های کاری",
  journal: "اسناد حسابداری",
  payroll: "سوابق حقوق و دستمزد",
  audit: "فعالیت‌های ثبت‌شده در گزارش حسابرسی",
  file: "سوابق مالیِ پروندهٔ پرسنلی",
  reservations: "رزروهای ثبت‌شده",
  records: "عملیات و اسناد",
};

/** The flag order the UI and the refusal sentence list things in. */
export const MEMBER_HISTORY_KEYS = Object.keys(MEMBER_HISTORY_LABELS) as (keyof MemberHistoryFlags)[];

/** True when any flag blocks a hard delete. */
export function memberHasHistory(history: MemberHistoryFlags): boolean {
  return MEMBER_HISTORY_KEYS.some((key) => history[key]);
}

/** The labels of the flags that are set, in catalogue order. */
export function memberHistoryLabels(history: MemberHistoryFlags): string[] {
  return MEMBER_HISTORY_KEYS.filter((key) => history[key]).map((key) => MEMBER_HISTORY_LABELS[key]);
}

/**
 * Attribution catalogue — the class the code review on this branch asked for
 * after finding the reservation hole: a member whose only business activity was
 * booking a reservation passed the six-flag gate, and because
 * `reservations.created_by` is `ON DELETE SET NULL` the hard delete silently
 * erased who booked it. The same shape exists wherever a business operation
 * attributes its author to `users(id)` with `ON DELETE SET NULL`/`CASCADE`
 * (purchases, stock movements, expenses, returns, transfers, closings, the
 * vertical modules' documents…), so the gate sweeps them from these catalogues
 * instead of plugging one column at a time.
 *
 * `member-history.schema-contract.test.ts` pins completeness: every
 * `users(id)`/`platform_users(id)` attribution column in `migrations/` must be
 * either probed here, probed by the six hand-written flags in
 * `team-service.ts`, or listed in that test's `UNCHECKED_ATTRIBUTIONS` with a
 * reason (account identity, personal UI, platform billing, tooling, standing
 * configuration, plain assignments). A migration that adds attribution without
 * classifying it fails that test.
 */
export interface MemberAttribution {
  /** The table holding the attribution. */
  table: string;
  /** Its columns that reference `users(id)`. */
  columns: readonly string[];
  /**
   * How the table is scoped to a business. Default: `business_id` on the row.
   * `location` joins `locations` on `location_id` (branch-scoped tables such as
   * orders and reservations); `join` walks a parent row that carries the
   * business (the fixed-asset tables, through `fixed_assets`).
   */
  scope?: { kind: "location" } | { kind: "join"; table: string; on: string };
}

/** `EXISTS (…) OR EXISTS (…)` — one probe per attribution table. */
export function memberAttributionSql(
  attributions: readonly MemberAttribution[],
  userExpr: string,
  businessExpr: string,
): string {
  const probes = attributions.map((a, i) => {
    const row = `a${i}`;
    const join = a.scope?.kind === "join" ? a.scope : null;
    const joinSql = join
      ? ` JOIN ${join.table} j${i} ON j${i}.id = ${row}.${join.on}`
      : a.scope?.kind === "location"
        ? ` JOIN locations l${i} ON l${i}.id = ${row}.location_id`
        : "";
    const whereBusiness = join
      ? `j${i}.business_id = ${businessExpr}`
      : a.scope?.kind === "location"
        ? `l${i}.business_id = ${businessExpr}`
        : `${row}.business_id = ${businessExpr}`;
    const whereUser = a.columns.map((c) => `${row}.${c} = ${userExpr}`).join(" OR ");
    return `EXISTS (SELECT 1 FROM ${a.table} ${row}${joinSql} WHERE ${whereBusiness} AND (${whereUser}))`;
  });
  return probes.length > 0 ? probes.join(" OR ") : "FALSE";
}

export const MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS: readonly MemberAttribution[] = [
  { table: 'reservations', columns: ["created_by"], scope: { kind: 'location' } },
];

export const MEMBER_HISTORY_RECORD_ATTRIBUTIONS: readonly MemberAttribution[] = [
  { table: 'accounting_dimension_mappings', columns: ["created_by"] },
  { table: 'accounting_dimension_values', columns: ["created_by"] },
  { table: 'aec_document_revisions', columns: ["created_by", "issued_by"] },
  { table: 'aec_documents', columns: ["created_by"] },
  { table: 'aec_estimate_events', columns: ["actor_id"] },
  { table: 'aec_estimate_versions', columns: ["approved_by", "created_by", "reviewed_by", "submitted_by"] },
  { table: 'aec_estimates', columns: ["created_by"] },
  { table: 'aec_transmittals', columns: ["created_by", "issued_by"] },
  { table: 'ap_payments', columns: ["created_by", "reversed_by"] },
  { table: 'ar_receipts', columns: ["created_by", "reversed_by"] },
  { table: 'automotive_vehicle_attributes', columns: ["created_by", "price_changed_by", "sold_by"] },
  { table: 'automotive_vehicle_costs', columns: ["created_by", "voided_by"] },
  { table: 'automotive_vehicle_media', columns: ["created_by"] },
  { table: 'automotive_vehicle_offline_requests', columns: ["acknowledged_by", "requested_by"] },
  { table: 'automotive_vehicle_price_history', columns: ["changed_by"] },
  { table: 'automotive_vehicle_sales', columns: ["reversed_by", "sold_by"] },
  { table: 'automotive_vehicle_transfers', columns: ["cancelled_by", "completed_by", "started_by"] },
  { table: 'backdated_orders', columns: ["created_by"] },
  { table: 'bank_reconciliations', columns: ["completed_by", "created_by"] },
  { table: 'business_day_closures', columns: ["closed_by"] },
  { table: 'cheque_events', columns: ["created_by"] },
  { table: 'cheques', columns: ["created_by"] },
  { table: 'commission_accruals', columns: ["employee_id"] },
  { table: 'crm_activities', columns: ["completed_by_id", "created_by_id"] },
  { table: 'crm_case_events', columns: ["actor_user_id"] },
  { table: 'crm_deal_stage_history', columns: ["changed_by_id"] },
  { table: 'crm_lead_vehicle_links', columns: ["created_by"] },
  { table: 'crm_lead_vehicle_preferences', columns: ["created_by"] },
  { table: 'custom_order_tickets', columns: ["created_by"], scope: { kind: 'location' } },
  { table: 'customer_returns', columns: ["created_by"] },
  { table: 'domain_events', columns: ["created_by"] },
  { table: 'exchange_rate_changes', columns: ["actor_id"] },
  { table: 'exchange_rate_voids', columns: ["voided_by"] },
  { table: 'exchange_rates', columns: ["created_by"] },
  { table: 'expenses', columns: ["created_by", "reversed_by"] },
  { table: 'financial_transfers', columns: ["created_by", "reversed_by"] },
  { table: 'fiscal_periods', columns: ["locked_by", "reopened_by", "soft_closed_by"] },
  { table: 'fiscal_years', columns: ["closed_by"] },
  { table: 'fixed_asset_depreciation_entries', columns: ["created_by", "reversed_by"], scope: { kind: 'join', table: 'fixed_assets', on: 'fixed_asset_id' } },
  { table: 'fixed_asset_estimate_changes', columns: ["changed_by"], scope: { kind: 'join', table: 'fixed_assets', on: 'fixed_asset_id' } },
  { table: 'fixed_asset_transfers', columns: ["transferred_by"], scope: { kind: 'join', table: 'fixed_assets', on: 'fixed_asset_id' } },
  { table: 'fixed_assets', columns: ["archived_by", "created_by", "disposed_by"] },
  { table: 'fx_revaluations', columns: ["created_by"] },
  { table: 'gold_account_movements', columns: ["created_by"] },
  { table: 'gold_prices', columns: ["created_by"] },
  { table: 'installments', columns: ["created_by"] },
  { table: 'inventory_count_scans', columns: ["created_by"] },
  { table: 'inventory_cutovers', columns: ["approved_by"] },
  { table: 'inventory_events', columns: ["created_by"] },
  { table: 'inventory_transfers', columns: ["cancelled_by", "created_by", "received_by", "shipped_by"] },
  { table: 'inventory_write_downs', columns: ["created_by"] },
  { table: 'item_purchases', columns: ["created_by"] },
  { table: 'item_stock_counts', columns: ["counted_by"] },
  { table: 'item_stock_transfers', columns: ["created_by"] },
  { table: 'item_supplier_returns', columns: ["created_by", "reversed_by"] },
  { table: 'journal_entries', columns: ["approved_by", "proposed_by", "reversed_by", "voucher_assigned_by"] },
  { table: 'journal_entry_draft_dimension_audit', columns: ["actor_id"] },
  { table: 'journal_entry_draft_rejections', columns: ["proposed_by", "rejected_by"] },
  { table: 'journal_entry_drafts', columns: ["created_by", "proposed_by"] },
  { table: 'layaway_payments', columns: ["created_by"] },
  { table: 'layaway_plans', columns: ["created_by"] },
  { table: 'ledger_party_attribution_moves', columns: ["actor_id"] },
  { table: 'opening_balance_sets', columns: ["approved_by", "created_by", "posted_by", "reversed_by", "submitted_by"] },
  { table: 'order_amendments', columns: ["created_by"] },
  { table: 'orders', columns: ["amended_by"], scope: { kind: 'location' } },
  { table: 'payroll_engine_runs', columns: ["approved_by", "cancelled_by", "closed_by", "created_by", "paid_by", "posted_by", "reviewed_by"] },
  { table: 'payroll_runs', columns: ["voided_by"] },
  { table: 'periodic_closings', columns: ["created_by"] },
  { table: 'product_price_history', columns: ["actor_id"] },
  { table: 'production_runs', columns: ["produced_by"] },
  { table: 'purchases', columns: ["created_by"], scope: { kind: 'location' } },
  { table: 'repair_tickets', columns: ["created_by"], scope: { kind: 'location' } },
  { table: 'retail_warehouse_documents', columns: ["created_by"] },
  { table: 'serial_preowned_intakes', columns: ["created_by"] },
  { table: 'serial_reservations', columns: ["created_by"] },
  { table: 'serial_returns', columns: ["approved_by", "created_by", "received_by"] },
  { table: 'shareholder_accounts', columns: ["created_by"] },
  { table: 'shareholder_distribution_events', columns: ["actor_id"] },
  { table: 'shareholder_distribution_payments', columns: ["created_by"] },
  { table: 'shareholder_distributions', columns: ["approved_by", "cancelled_by", "created_by", "posted_by", "reversed_by"] },
  { table: 'shareholder_events', columns: ["created_by"] },
  { table: 'stock_counts', columns: ["counted_by"], scope: { kind: 'location' } },
  { table: 'stock_movements', columns: ["created_by"], scope: { kind: 'location' } },
  { table: 'summary_vouchers', columns: ["created_by"] },
  { table: 'supplier_returns', columns: ["created_by"] },
  { table: 'table_sessions', columns: ["closed_by", "opened_by"], scope: { kind: 'location' } },
  { table: 'tax_invoice_events', columns: ["actor_user_id"] },
  { table: 'tax_invoice_submissions', columns: ["prepared_by"] },
  { table: 'voucher_renumber_log', columns: ["performed_by"] },
  { table: 'warehouse_documents', columns: ["created_by"] },
  { table: 'weight_counts', columns: ["created_by"], scope: { kind: 'location' } },
];
