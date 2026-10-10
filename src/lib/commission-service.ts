/**
 * Phase 27 Wave 7 — sales-staff commission (DB-touching).
 *
 * `commission_rules` is the source of truth the pure engine (commission.ts)
 * evaluates; this file reads/writes it and, when a retail invoice line is
 * settled, turns the computed accrual into a `commission_accruals` row plus a
 * `commission.accrued` domain event that posts the payroll liability. The
 * per-staff report is a SUM of the signed accruals, so it always ties to the
 * liability the events posted — never a second, report-only number.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import {
  commissionBasis,
  computeCommissionAccrual,
  resolveCommissionRule,
  type CommissionRule,
} from "./commission";
import { rialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
// Side-effect import: registers the commission.accrued posting rule.
import "./commission-posting-rules";

export interface CommissionRuleInput {
  employeeId: string;
  kind: "percent" | "fixed";
  basis: "net" | "margin";
  /** Percent rate (0-100) or fixed Rial amount. */
  value: number;
  itemIds?: string[];
  brandIds?: string[];
  categoryIds?: string[];
  activeFrom?: string | null;
  activeTo?: string | null;
  priority?: number;
  isActive?: boolean;
}

interface CommissionRuleRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  employee_id: string;
  kind: "percent" | "fixed";
  basis: "net" | "margin";
  value: string;
  item_ids: string[] | null;
  brand_ids: string[] | null;
  category_ids: string[] | null;
  active_from: string | null;
  active_to: string | null;
  priority: number;
  is_active: boolean;
}

/** A rule as the admin console shows it — engine shape plus its business fields. */
export interface CommissionRuleView extends CommissionRule {
  businessId: string;
  employeeId: string;
  employeeName: string | null;
  activeFrom: string | null;
  activeTo: string | null;
  isActive: boolean;
}

function toEngineRule(row: CommissionRuleRow): CommissionRule {
  return {
    id: row.id,
    kind: row.kind,
    value: Number(row.value),
    basis: row.basis,
    itemIds: row.item_ids?.length ? row.item_ids : null,
    brandIds: row.brand_ids?.length ? row.brand_ids : null,
    categoryIds: row.category_ids?.length ? row.category_ids : null,
    priority: row.priority,
  };
}

function mapRuleView(row: CommissionRuleRow & { employee_name: string | null }): CommissionRuleView {
  return {
    ...toEngineRule(row),
    businessId: row.business_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    activeFrom: row.active_from,
    activeTo: row.active_to,
    isActive: row.is_active,
  };
}

export async function listCommissionRules(
  businessId: string,
  employeeId?: string,
  includeInactive = false,
  client?: PoolClient,
  /**
   * The accrual-time read passes true, so a rule whose active_from/active_to
   * window does not cover today earns nothing. The admin list passes false —
   * a manager must still see (and reactivate) an out-of-window rule.
   */
  onlyEffective = false,
): Promise<CommissionRuleView[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<CommissionRuleRow & { employee_name: string | null }>(
    `SELECT r.*, u.full_name AS employee_name
       FROM commission_rules r
       LEFT JOIN users u ON u.id = r.employee_id
      WHERE r.business_id = $1
        AND ($2::uuid IS NULL OR r.employee_id = $2)
        ${includeInactive ? "" : "AND r.is_active"}
        ${onlyEffective ? "AND (r.active_from IS NULL OR r.active_from <= CURRENT_DATE) AND (r.active_to IS NULL OR r.active_to >= CURRENT_DATE)" : ""}
      ORDER BY r.employee_id, r.priority DESC, r.created_at`,
    [businessId, employeeId ?? null],
  );
  return rows.map(mapRuleView);
}

export async function upsertCommissionRule(
  businessId: string,
  input: CommissionRuleInput,
): Promise<CommissionRuleView> {
  if (!input.employeeId) throw new Error("فروشنده را مشخص کنید.");
  if (!["percent", "fixed"].includes(input.kind)) throw new Error("نوع پورسانت نامعتبر است.");
  if (!["net", "margin"].includes(input.basis)) throw new Error("مبنای پورسانت نامعتبر است.");
  if (!Number.isInteger(input.value) || input.value < 0) {
    throw new Error("مقدار پورسانت باید یک عدد صحیح غیرمنفی باشد.");
  }
  if (input.kind === "percent" && input.value > 100) {
    throw new Error("درصد پورسانت نمی‌تواند بیش از ۱۰۰ باشد.");
  }
  // A fractional priority would fail with a raw SQL error when it meets the
  // integer column; say so in Persian here instead.
  if (input.priority !== undefined && !Number.isInteger(input.priority)) {
    throw new Error("اولویت باید یک عدد صحیح باشد.");
  }

  // The FK to users(id) alone would let a rule name another tenant's user id;
  // RLS guards the business_id column, not which employee it points at.
  const { rows: memberRows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND business_id = $2`,
    [input.employeeId, businessId],
  );
  if (!memberRows[0]) throw new Error("فروشنده یافت نشد.");

  const { rows } = await query<CommissionRuleRow>(
    `INSERT INTO commission_rules
       (business_id, employee_id, kind, basis, value, item_ids, brand_ids, category_ids,
        active_from, active_to, priority, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12)
     RETURNING *`,
    [
      businessId,
      input.employeeId,
      input.kind,
      input.basis,
      input.value,
      input.itemIds ?? [],
      input.brandIds ?? [],
      input.categoryIds ?? [],
      input.activeFrom ?? null,
      input.activeTo ?? null,
      input.priority ?? 0,
      input.isActive ?? true,
    ],
  );

  const { rows: nameRows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1`,
    [input.employeeId],
  );
  return mapRuleView({ ...rows[0], employee_name: nameRows[0]?.full_name ?? null });
}

export interface CommissionLineInput {
  /** Line net (post-discount, pre-VAT), Rial. */
  net: number;
  /** The COGS the sale posted, Rial — required for a margin basis. */
  cost?: number | null;
  itemId: string;
  brandId?: string | null;
  /**
   * The category axis the engine resolves item → brand → category →
   * everything against. A caller that knows the line's category must pass it;
   * it was silently dropped before, so a category-scoped rule could never
   * match even when the caller had the id in hand.
   */
  categoryId?: string | null;
}

/**
 * Accrues commission for one settled invoice line, in the caller's own
 * transaction, so the accrual and the sale can never be half-committed. The
 * selling employee is the line's `created_by`; a line with no employee, or an
 * employee with no matching rule, accrues nothing — which is not an error.
 */
export async function accrueCommissionForLine(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    employeeId: string;
    sourceType: string;
    sourceId: string;
    line: CommissionLineInput;
    createdBy?: string | null;
  },
): Promise<{ amount: number; ruleId: string | null; entryId: string | null }> {
  const rules = await listCommissionRules(input.businessId, input.employeeId, false, client, true);
  if (rules.length === 0) return { amount: 0, ruleId: null, entryId: null };

  const line: Parameters<typeof computeCommissionAccrual>[0] = {
    net: input.line.net,
    cost: input.line.cost ?? null,
    itemId: input.line.itemId,
    brandId: input.line.brandId ?? null,
    categoryId: input.line.categoryId ?? null,
  };
  const accrual = computeCommissionAccrual(line, rules);
  if (accrual.amount <= 0) return { amount: 0, ruleId: accrual.ruleId, entryId: null };

  const rule = resolveCommissionRule(line, rules);
  const basisAmount = rule ? Math.max(0, commissionBasis(line, rule)) : 0;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO commission_accruals
       (business_id, employee_id, rule_id, source_type, source_id, amount, basis_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.businessId,
      input.employeeId,
      accrual.ruleId,
      input.sourceType,
      input.sourceId,
      accrual.amount,
      basisAmount,
    ],
  );

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "commission.accrued",
    payload: {
      accrualId: rows[0].id,
      employeeId: input.employeeId,
      amount: rialText(String(accrual.amount)),
    },
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    createdBy: input.createdBy ?? null,
  });

  // Stamp the entry the event posted onto the accrual row, in the same
  // transaction: commission_accruals.entry_id is the tie-out to the payroll
  // liability, and it was created for exactly this. Leaving it NULL (as it
  // was) makes an auditor re-derive the link from the event payload instead
  // of joining the two tables.
  if (entryId) {
    await client.query(`UPDATE commission_accruals SET entry_id = $2 WHERE id = $1`, [rows[0].id, entryId]);
  }

  return { amount: accrual.amount, ruleId: accrual.ruleId, entryId };
}

/**
 * Retires (or revives) a rule without deleting history: accrued rows keep
 * pointing at it, and a mistaken rule stops earning the moment it is
 * deactivated. Deleting would NULL out the accruals' rule_id, so the editor
 * toggles instead. The business_id clause is belt-and-braces on top of RLS —
 * the id alone must never reactivate a rule from another tenant.
 */
export async function setCommissionRuleActive(
  businessId: string,
  ruleId: string,
  isActive: boolean,
): Promise<void> {
  const { rowCount } = await query(
    `UPDATE commission_rules SET is_active = $3 WHERE id = $1 AND business_id = $2`,
    [ruleId, businessId, isActive],
  );
  if (!rowCount) throw new Error("قانون پورسانت یافت نشد.");
}

export interface StaffCommissionRow {
  employeeId: string;
  employeeName: string;
  amount: number;
  basisAmount: number;
  lineCount: number;
}

/** The per-staff leaderboard: Σ signed accruals per employee, newest period first by amount. */
export async function staffCommissionReport(
  businessId: string,
  opts?: { from?: string | null; to?: string | null },
  /** Optional source branch for branch-scoped AI reads; omitted for the central commission screen. */
  locationId?: string | null,
): Promise<StaffCommissionRow[]> {
  const { rows } = await query<{
    employee_id: string;
    employee_name: string | null;
    amount: string;
    basis_amount: string;
    line_count: string;
  }>(
    `SELECT a.employee_id, COALESCE(u.full_name, 'نامشخص') AS employee_name,
            COALESCE(SUM(a.amount), 0)::text AS amount,
            COALESCE(SUM(a.basis_amount), 0)::text AS basis_amount,
            COUNT(*)::text AS line_count
       FROM commission_accruals a
       LEFT JOIN users u ON u.id = a.employee_id
       LEFT JOIN order_items oi ON a.source_type = 'order_item' AND oi.id = a.source_id
       LEFT JOIN orders o ON a.source_type = 'retail_invoice' AND o.id = a.source_id
       LEFT JOIN order_amendments am ON a.source_type = 'order_amendment' AND am.id = a.source_id
       LEFT JOIN serial_returns sr ON a.source_type = 'serial_return' AND sr.id = a.source_id
       LEFT JOIN journal_entries je ON je.id = a.entry_id
      WHERE a.business_id = $1
        AND ($2::date IS NULL OR a.created_at::date >= $2::date)
        AND ($3::date IS NULL OR a.created_at::date <= $3::date)
        AND ($4::uuid IS NULL OR $4 = COALESCE(oi.location_id, o.location_id, am.location_id, sr.location_id, je.location_id))
      GROUP BY a.employee_id, u.full_name
      ORDER BY COALESCE(SUM(a.amount), 0) DESC`,
    [businessId, opts?.from ?? null, opts?.to ?? null, locationId ?? null],
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? "نامشخص",
    amount: Number(r.amount),
    basisAmount: Number(r.basis_amount),
    lineCount: Number(r.line_count),
  }));
}

export interface SalesStaff {
  id: string;
  fullName: string;
}

/** The active members a rule can name as its selling employee, for the rule editor's picker. */
export async function listSalesStaff(businessId: string): Promise<SalesStaff[]> {
  const { rows } = await query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM users WHERE business_id = $1 AND is_active ORDER BY full_name`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}
