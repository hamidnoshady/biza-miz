/**
 * Issue #865 — statutory payroll engine, configuration half (DB-touching):
 * versioned rule sets, the component catalogue, employee payroll profiles and
 * recurring items. Every change is audited (append-only change tables), and a
 * rule set is never edited — a new version is entered instead.
 *
 * Employee identity is the canonical team member (`users` + `employees`); the
 * profile only adds payroll fields beside it. Covered by
 * integration/payroll-engine.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { isUuid } from "./uuid";
import { normalizeOptionalIsoDate } from "./iso-date";
import { MAX_RIAL } from "./inventory-exact";
import { parseRialInput } from "./payroll-amounts";
import { clientRunner, inTransaction, poolRunner, type Runner } from "./payroll-db";
import { PayrollError } from "./payroll-errors";
import {
  DEFAULT_COMPONENTS,
  IRAN_RULE_TEMPLATE,
  parsePayrollRuleSet,
  SYSTEM_COMPONENT_KEYS,
  type ComponentKind,
  type PayrollComponentDef,
  type PayrollRuleSet,
} from "./payroll-engine-calc";

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

export interface PayrollRuleSetVersion {
  id: string;
  version: number;
  title: string;
  effectiveFrom: string;
  rules: PayrollRuleSet;
  createdAt: string;
}

interface RuleRow extends Record<string, unknown> {
  id: string;
  version: number;
  title: string;
  effective_from: string;
  rules: unknown;
  created_at: string;
}

const toRuleSet = (r: RuleRow): PayrollRuleSetVersion => {
  const parsed = parsePayrollRuleSet(r.rules);
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    effectiveFrom: r.effective_from,
    rules: parsed.ok ? parsed.value : IRAN_RULE_TEMPLATE,
    createdAt: r.created_at,
  };
};

const RULE_SELECT = `SELECT id, version, title, effective_from::text AS effective_from, rules, created_at::text AS created_at FROM payroll_rule_sets`;

export async function listRuleSets(businessId: string): Promise<PayrollRuleSetVersion[]> {
  const { rows } = await poolRunner<RuleRow>(`${RULE_SELECT} WHERE business_id = $1 ORDER BY version DESC`, [businessId]);
  return rows.map(toRuleSet);
}

/** The version in force on `date`: latest effective_from ≤ date, highest version breaking ties. */
export async function ruleSetFor(run: Runner, businessId: string, date: string): Promise<PayrollRuleSetVersion | null> {
  const { rows } = await run<RuleRow>(
    `${RULE_SELECT} WHERE business_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC, version DESC LIMIT 1`,
    [businessId, date],
  );
  return rows[0] ? toRuleSet(rows[0]) : null;
}

/** Enters a new version. Earlier versions — and every run that used them — are untouched. */
export async function createRuleSet(params: {
  businessId: string;
  actorId: string | null;
  title: unknown;
  effectiveFrom: unknown;
  rules: unknown;
}): Promise<PayrollRuleSetVersion> {
  const title = typeof params.title === "string" ? params.title.trim() : "";
  if (title.length < 1 || title.length > 120) throw new PayrollError("invalid_title", 400, "title");
  const date = normalizeOptionalIsoDate(params.effectiveFrom);
  if (!date.ok || !date.value) throw new PayrollError("invalid_effective_date", 400, "effectiveFrom");
  const parsed = parsePayrollRuleSet(params.rules);
  if (!parsed.ok) throw new PayrollError(parsed.error, 400, parsed.field ? { field: parsed.field } : undefined);

  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payroll-rules:${params.businessId}`]);
    const { rows } = await client.query<RuleRow>(
      `INSERT INTO payroll_rule_sets (business_id, version, title, effective_from, rules, created_by)
       VALUES ($1, COALESCE((SELECT max(version) FROM payroll_rule_sets WHERE business_id = $1), 0) + 1, $2, $3, $4, $5)
       RETURNING id, version, title, effective_from::text AS effective_from, rules, created_at::text AS created_at`,
      [params.businessId, title, date.value, JSON.stringify(parsed.value), params.actorId],
    );
    return toRuleSet(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface PayrollComponent extends PayrollComponentDef {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

interface ComponentRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  kind: ComponentKind;
  system_key: string | null;
  taxable: boolean;
  insurable: boolean;
  debit_account_code: string;
  credit_account_code: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

const toComponent = (r: ComponentRow): PayrollComponent => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  systemKey: r.system_key as PayrollComponent["systemKey"],
  taxable: r.taxable,
  insurable: r.insurable,
  debitAccountCode: r.debit_account_code,
  creditAccountCode: r.credit_account_code,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  isActive: r.is_active,
});

const COMPONENT_SELECT = `SELECT id, code, name, kind, system_key, taxable, insurable, debit_account_code, credit_account_code,
       effective_from::text AS effective_from, effective_to::text AS effective_to, is_active FROM payroll_components`;

/** Seeds the default catalogue once per business; never overwrites a business's own edits. */
export async function ensureCatalogue(client: PoolClient, businessId: string): Promise<void> {
  for (const c of DEFAULT_COMPONENTS) {
    await client.query(
      `INSERT INTO payroll_components (business_id, code, name, kind, system_key, taxable, insurable, debit_account_code, credit_account_code)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
        WHERE NOT EXISTS (SELECT 1 FROM payroll_components WHERE business_id = $1 AND (code = $2 OR ($5::text IS NOT NULL AND system_key = $5)))`,
      [businessId, c.code, c.name, c.kind, c.systemKey, c.taxable, c.insurable, c.debitAccountCode, c.creditAccountCode],
    );
  }
}

export async function listComponents(businessId: string): Promise<PayrollComponent[]> {
  await inTransaction((client) => ensureCatalogue(client, businessId));
  const { rows } = await poolRunner<ComponentRow>(`${COMPONENT_SELECT} WHERE business_id = $1 ORDER BY kind, code`, [businessId]);
  return rows.map(toComponent);
}

/** Components in force on `date` (active and inside their effective window). */
export async function componentsFor(run: Runner, businessId: string, date: string): Promise<PayrollComponent[]> {
  const { rows } = await run<ComponentRow>(
    `${COMPONENT_SELECT} WHERE business_id = $1 AND is_active AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY kind, code`,
    [businessId, date],
  );
  return rows.map(toComponent);
}

const ACCOUNT_CODE = /^[0-9]{3,8}$/;

/**
 * Creates (no `id`) or edits a component. The system key of a seeded
 * component is fixed (the calculator relies on it) and a system component
 * cannot be deactivated; everything else — name, flags, accounts, effective
 * window — is the business's. Every change is written to the audit table.
 */
export async function saveComponent(params: { businessId: string; actorId: string | null; id?: unknown; body: Record<string, unknown> }): Promise<PayrollComponent> {
  const b = params.body;
  return inTransaction(async (client) => {
    await ensureCatalogue(client, params.businessId);
    let before: ComponentRow | null = null;
    if (params.id !== undefined) {
      if (!isUuid(params.id)) throw new PayrollError("component_not_found", 404);
      const { rows } = await client.query<ComponentRow>(`${COMPONENT_SELECT} WHERE business_id = $1 AND id = $2 FOR UPDATE`, [params.businessId, params.id]);
      before = rows[0] ?? null;
      if (!before) throw new PayrollError("component_not_found", 404);
    }
    const pick = <T>(key: string, fallback: T): unknown => (b[key] === undefined ? fallback : b[key]);
    const code = pick("code", before?.code);
    const name = pick("name", before?.name);
    const kind = pick("kind", before?.kind);
    const taxable = pick("taxable", before?.taxable ?? false);
    const insurable = pick("insurable", before?.insurable ?? false);
    const debit = pick("debitAccountCode", before?.debit_account_code);
    const credit = pick("creditAccountCode", before?.credit_account_code);
    const isActive = pick("isActive", before?.is_active ?? true);
    const from = normalizeOptionalIsoDate(pick("effectiveFrom", before?.effective_from ?? null));
    const to = normalizeOptionalIsoDate(pick("effectiveTo", before?.effective_to ?? null));

    if (typeof code !== "string" || !/^[A-Z0-9_]{2,32}$/.test(code)) throw new PayrollError("invalid_component_code", 400, "code");
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 120) throw new PayrollError("invalid_component_name", 400, "name");
    if (kind !== "earning" && kind !== "deduction" && kind !== "employer_contribution") throw new PayrollError("invalid_component_kind", 400, "kind");
    if (typeof taxable !== "boolean" || typeof insurable !== "boolean" || typeof isActive !== "boolean") throw new PayrollError("invalid_component_flags");
    if (typeof debit !== "string" || !ACCOUNT_CODE.test(debit)) throw new PayrollError("invalid_account_code", 400, "debitAccountCode");
    if (typeof credit !== "string" || !ACCOUNT_CODE.test(credit)) throw new PayrollError("invalid_account_code", 400, "creditAccountCode");
    if (!from.ok || !to.ok) throw new PayrollError("invalid_effective_date");
    if (from.value && to.value && to.value < from.value) throw new PayrollError("invalid_effective_date", 400, "effectiveTo");
    if (before?.system_key) {
      if (kind !== before.kind) throw new PayrollError("system_component_locked", 409, "kind");
      if (!isActive) throw new PayrollError("system_component_locked", 409, "isActive");
    }
    if (!before && kind === "employer_contribution") throw new PayrollError("system_component_locked", 409, "kind");
    const { rows: accounts } = await client.query<{ code: string }>(
      `SELECT code FROM accounts WHERE business_id = $1 AND code = ANY($2::text[]) AND is_active`,
      [params.businessId, [debit, credit]],
    );
    for (const c of [debit, credit]) {
      if (!accounts.some((a) => a.code === c)) throw new PayrollError("ledger_account_missing", 409, { code: c });
    }

    let saved: ComponentRow;
    try {
      const { rows } = before
        ? await client.query<ComponentRow>(
            `UPDATE payroll_components SET code=$3, name=$4, taxable=$5, insurable=$6, debit_account_code=$7, credit_account_code=$8,
                    effective_from=COALESCE($9::date, effective_from), effective_to=$10, is_active=$11, updated_at=now()
              WHERE business_id=$1 AND id=$2
              RETURNING id, code, name, kind, system_key, taxable, insurable, debit_account_code, credit_account_code,
                        effective_from::text AS effective_from, effective_to::text AS effective_to, is_active`,
            [params.businessId, before.id, code, name.trim(), taxable, insurable, debit, credit, from.value, to.value, isActive],
          )
        : await client.query<ComponentRow>(
            `INSERT INTO payroll_components (business_id, code, name, kind, taxable, insurable, debit_account_code, credit_account_code,
                                             effective_from, effective_to, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, DATE '2000-01-01'),$10,$11)
             RETURNING id, code, name, kind, system_key, taxable, insurable, debit_account_code, credit_account_code,
                       effective_from::text AS effective_from, effective_to::text AS effective_to, is_active`,
            [params.businessId, code, name.trim(), kind, taxable, insurable, debit, credit, from.value, to.value, isActive],
          );
      saved = rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new PayrollError("component_code_taken", 409, "code");
      throw err;
    }
    await client.query(
      `INSERT INTO payroll_component_changes (business_id, component_id, before, after, changed_by) VALUES ($1,$2,$3,$4,$5)`,
      [params.businessId, saved.id, before ? JSON.stringify(toComponent(before)) : null, JSON.stringify(toComponent(saved)), params.actorId],
    );
    return toComponent(saved);
  });
}

export async function listComponentChanges(businessId: string, componentId: string) {
  if (!isUuid(componentId)) return [];
  const { rows } = await poolRunner<{ before: unknown; after: unknown; changed_by_name: string | null; changed_at: string }>(
    `SELECT c.before, c.after, u.full_name AS changed_by_name, c.changed_at::text AS changed_at
       FROM payroll_component_changes c LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.business_id = $1 AND c.component_id = $2 ORDER BY c.changed_at DESC, c.id DESC`,
    [businessId, componentId],
  );
  return rows.map((r) => ({ before: r.before, after: r.after, changedByName: r.changed_by_name, changedAt: r.changed_at }));
}

// ---------------------------------------------------------------------------
// Employee profiles
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "hourly", "intern"] as const;

export interface CostAllocationShare {
  percent: number;
  locationId?: string | null;
  projectId?: string | null;
  label?: string | null;
}

export interface PayrollProfile {
  userId: string;
  fullName: string;
  employeeCode: string | null;
  payrollCode: string | null;
  employmentType: (typeof EMPLOYMENT_TYPES)[number];
  hireDate: string | null;
  terminationDate: string | null;
  baseSalary: string;
  insuranceProfile: { insured: boolean; insuranceNumber?: string | null };
  taxProfile: { exempt: boolean; nationalId?: string | null };
  paymentDestination: { method: "cash" | "bank"; paymentAccountId?: string | null; iban?: string | null; cardNumber?: string | null };
  costAllocation: CostAllocationShare[];
  isActive: boolean;
  /** Whether a profile row exists (false = defaults shown for a team member who has none yet). */
  configured: boolean;
}

interface ProfileRow extends Record<string, unknown> {
  user_id: string;
  full_name: string;
  employee_code: string | null;
  configured: boolean;
  payroll_code: string | null;
  employment_type: PayrollProfile["employmentType"] | null;
  hire_date: string | null;
  termination_date: string | null;
  base_salary: string | null;
  insurance_profile: PayrollProfile["insuranceProfile"] | null;
  tax_profile: PayrollProfile["taxProfile"] | null;
  payment_destination: PayrollProfile["paymentDestination"] | null;
  cost_allocation: CostAllocationShare[] | null;
  is_active: boolean | null;
}

const toProfile = (r: ProfileRow): PayrollProfile => ({
  userId: r.user_id,
  fullName: r.full_name,
  employeeCode: r.employee_code,
  payrollCode: r.payroll_code,
  employmentType: r.employment_type ?? "full_time",
  hireDate: r.hire_date,
  terminationDate: r.termination_date,
  baseSalary: r.base_salary ?? "0",
  insuranceProfile: r.insurance_profile ?? { insured: true },
  taxProfile: r.tax_profile ?? { exempt: false },
  paymentDestination: r.payment_destination ?? { method: "bank" },
  costAllocation: r.cost_allocation ?? [],
  isActive: r.is_active ?? true,
  configured: r.configured,
});

const PROFILE_SELECT = `SELECT u.id AS user_id, u.full_name, e.employee_code, (p.user_id IS NOT NULL) AS configured,
       p.payroll_code, p.employment_type, COALESCE(p.hire_date, e.hired_at)::text AS hire_date,
       p.termination_date::text AS termination_date, p.base_salary::text AS base_salary,
       p.insurance_profile, p.tax_profile, p.payment_destination, p.cost_allocation, p.is_active
  FROM users u
  LEFT JOIN employees e ON e.id = u.id
  LEFT JOIN payroll_employee_profiles p ON p.user_id = u.id AND p.business_id = u.business_id`;

export async function listProfiles(businessId: string): Promise<PayrollProfile[]> {
  const { rows } = await poolRunner<ProfileRow>(`${PROFILE_SELECT} WHERE u.business_id = $1 AND u.is_active ORDER BY u.full_name, u.id`, [businessId]);
  return rows.map(toProfile);
}

export async function getProfile(businessId: string, userId: string): Promise<PayrollProfile | null> {
  if (!isUuid(userId)) return null;
  const { rows } = await poolRunner<ProfileRow>(`${PROFILE_SELECT} WHERE u.business_id = $1 AND u.id = $2`, [businessId, userId]);
  return rows[0] ? toProfile(rows[0]) : null;
}

function optionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) throw new PayrollError("invalid_profile", 400, field);
  return value.trim();
}

/** Validates a cost-allocation list: shares of 0–100 summing to exactly 100 (or an empty list). */
export function parseCostAllocation(raw: unknown): CostAllocationShare[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new PayrollError("invalid_cost_allocation", 400, "costAllocation");
  let total = 0;
  const out: CostAllocationShare[] = [];
  for (const share of raw) {
    if (typeof share !== "object" || share === null) throw new PayrollError("invalid_cost_allocation", 400, "costAllocation");
    const s = share as Record<string, unknown>;
    const percent = s.percent;
    if (typeof percent !== "number" || !(percent > 0) || percent > 100 || Math.abs(percent * 100 - Math.round(percent * 100)) > 1e-9) {
      throw new PayrollError("invalid_cost_allocation", 400, "costAllocation");
    }
    for (const k of ["locationId", "projectId"] as const) {
      if (s[k] !== undefined && s[k] !== null && !isUuid(s[k])) throw new PayrollError("invalid_cost_allocation", 400, `costAllocation.${k}`);
    }
    total += Math.round(percent * 100);
    out.push({
      percent,
      locationId: (s.locationId as string | undefined) ?? null,
      projectId: (s.projectId as string | undefined) ?? null,
      label: optionalText(s.label, 80, "costAllocation.label"),
    });
  }
  if (out.length > 0 && total !== 10_000) throw new PayrollError("allocation_must_total_100", 400, "costAllocation");
  return out;
}

/** Creates or updates a team member's payroll profile, auditing the before/after. */
export async function saveProfile(params: { businessId: string; actorId: string | null; userId: string; body: Record<string, unknown> }): Promise<PayrollProfile> {
  if (!isUuid(params.userId)) throw new PayrollError("staff_not_found", 404);
  const current = await getProfile(params.businessId, params.userId);
  if (!current) throw new PayrollError("staff_not_found", 404);
  const b = params.body;
  const pick = <T>(key: string, fallback: T): unknown => (b[key] === undefined ? fallback : b[key]);

  const payrollCode = optionalText(pick("payrollCode", current.payrollCode), 40, "payrollCode");
  const employmentType = pick("employmentType", current.employmentType);
  if (!EMPLOYMENT_TYPES.includes(employmentType as never)) throw new PayrollError("invalid_profile", 400, "employmentType");
  const hire = normalizeOptionalIsoDate(pick("hireDate", current.hireDate));
  const term = normalizeOptionalIsoDate(pick("terminationDate", current.terminationDate));
  if (!hire.ok) throw new PayrollError("invalid_profile", 400, "hireDate");
  if (!term.ok) throw new PayrollError("invalid_profile", 400, "terminationDate");
  if (hire.value && term.value && term.value < hire.value) throw new PayrollError("invalid_profile", 400, "terminationDate");
  const salary = parseRialInput(pick("baseSalary", current.baseSalary));
  if (salary > MAX_RIAL) throw new PayrollError("amount_out_of_range", 400, "baseSalary");

  const ins = pick("insuranceProfile", current.insuranceProfile) as Record<string, unknown> | null;
  if (typeof ins !== "object" || ins === null || typeof ins.insured !== "boolean") throw new PayrollError("invalid_profile", 400, "insuranceProfile");
  const tax = pick("taxProfile", current.taxProfile) as Record<string, unknown> | null;
  if (typeof tax !== "object" || tax === null || typeof tax.exempt !== "boolean") throw new PayrollError("invalid_profile", 400, "taxProfile");
  const dest = pick("paymentDestination", current.paymentDestination) as Record<string, unknown> | null;
  if (typeof dest !== "object" || dest === null || (dest.method !== "cash" && dest.method !== "bank")) {
    throw new PayrollError("invalid_profile", 400, "paymentDestination");
  }
  if (dest.paymentAccountId !== undefined && dest.paymentAccountId !== null && !isUuid(dest.paymentAccountId)) {
    throw new PayrollError("invalid_profile", 400, "paymentDestination.paymentAccountId");
  }
  const iban = optionalText(dest.iban, 34, "paymentDestination.iban");
  if (iban && !/^IR[0-9]{24}$/.test(iban.replace(/\s/g, "").toUpperCase())) throw new PayrollError("invalid_iban", 400, "paymentDestination.iban");
  const allocation = parseCostAllocation(pick("costAllocation", current.costAllocation));
  const isActive = pick("isActive", current.isActive);
  if (typeof isActive !== "boolean") throw new PayrollError("invalid_profile", 400, "isActive");

  const next = {
    payrollCode,
    employmentType,
    hireDate: hire.value,
    terminationDate: term.value,
    baseSalary: salary.toString(),
    insuranceProfile: { insured: ins.insured, insuranceNumber: optionalText(ins.insuranceNumber, 20, "insuranceProfile.insuranceNumber") },
    taxProfile: { exempt: tax.exempt, nationalId: optionalText(tax.nationalId, 10, "taxProfile.nationalId") },
    paymentDestination: {
      method: dest.method,
      paymentAccountId: (dest.paymentAccountId as string | undefined) ?? null,
      iban: iban ? iban.replace(/\s/g, "").toUpperCase() : null,
      cardNumber: optionalText(dest.cardNumber, 19, "paymentDestination.cardNumber"),
    },
    costAllocation: allocation,
    isActive,
  };

  await inTransaction(async (client) => {
    try {
      await client.query(
        `INSERT INTO payroll_employee_profiles (user_id, business_id, payroll_code, employment_type, hire_date, termination_date, base_salary,
                                                insurance_profile, tax_profile, payment_destination, cost_allocation, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (user_id) DO UPDATE SET payroll_code=EXCLUDED.payroll_code, employment_type=EXCLUDED.employment_type,
           hire_date=EXCLUDED.hire_date, termination_date=EXCLUDED.termination_date, base_salary=EXCLUDED.base_salary,
           insurance_profile=EXCLUDED.insurance_profile, tax_profile=EXCLUDED.tax_profile,
           payment_destination=EXCLUDED.payment_destination, cost_allocation=EXCLUDED.cost_allocation,
           is_active=EXCLUDED.is_active, updated_at=now()`,
        [
          params.userId, params.businessId, next.payrollCode, next.employmentType, next.hireDate, next.terminationDate, next.baseSalary,
          JSON.stringify(next.insuranceProfile), JSON.stringify(next.taxProfile), JSON.stringify(next.paymentDestination),
          JSON.stringify(next.costAllocation), next.isActive,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new PayrollError("payroll_code_taken", 409, "payrollCode");
      throw err;
    }
    await client.query(
      `INSERT INTO payroll_profile_changes (business_id, user_id, before, after, changed_by) VALUES ($1,$2,$3,$4,$5)`,
      [params.businessId, params.userId, current.configured ? JSON.stringify(current) : null, JSON.stringify(next), params.actorId],
    );
  });
  return (await getProfile(params.businessId, params.userId))!;
}

export async function listProfileChanges(businessId: string, userId: string) {
  if (!isUuid(userId)) return [];
  const { rows } = await poolRunner<{ before: unknown; after: unknown; changed_by_name: string | null; changed_at: string }>(
    `SELECT c.before, c.after, u.full_name AS changed_by_name, c.changed_at::text AS changed_at
       FROM payroll_profile_changes c LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.business_id = $1 AND c.user_id = $2 ORDER BY c.changed_at DESC, c.id DESC`,
    [businessId, userId],
  );
  return rows.map((r) => ({ before: r.before, after: r.after, changedByName: r.changed_by_name, changedAt: r.changed_at }));
}

// ---------------------------------------------------------------------------
// Recurring items
// ---------------------------------------------------------------------------

export interface PayrollRecurringItem {
  id: string;
  userId: string;
  componentId: string;
  componentCode: string;
  componentName: string;
  kind: ComponentKind;
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

const ITEM_SELECT = `SELECT i.id, i.user_id, i.component_id, c.code AS component_code, c.name AS component_name, c.kind,
       i.amount::text AS amount, i.effective_from::text AS effective_from, i.effective_to::text AS effective_to, i.note
  FROM payroll_employee_items i JOIN payroll_components c ON c.id = i.component_id`;

type ItemRow = Record<string, unknown> & {
  id: string; user_id: string; component_id: string; component_code: string; component_name: string;
  kind: ComponentKind; amount: string; effective_from: string; effective_to: string | null; note: string | null;
};

const toItem = (r: ItemRow): PayrollRecurringItem => ({
  id: r.id, userId: r.user_id, componentId: r.component_id, componentCode: r.component_code, componentName: r.component_name,
  kind: r.kind, amount: r.amount, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, note: r.note,
});

export async function listItems(businessId: string, userId?: string): Promise<PayrollRecurringItem[]> {
  const { rows } = await poolRunner<ItemRow>(
    `${ITEM_SELECT} WHERE i.business_id = $1 AND ($2::uuid IS NULL OR i.user_id = $2) ORDER BY i.effective_from DESC, i.id`,
    [businessId, userId && isUuid(userId) ? userId : null],
  );
  return rows.map(toItem);
}

/** Recurring items overlapping the Gregorian range [from, to], per user. */
export async function itemsInForce(run: Runner, businessId: string, from: string, to: string): Promise<Map<string, PayrollRecurringItem[]>> {
  const { rows } = await run<ItemRow>(
    `${ITEM_SELECT} WHERE i.business_id = $1 AND i.effective_from <= $3::date AND (i.effective_to IS NULL OR i.effective_to >= $2::date)
      ORDER BY i.user_id, c.code, i.id`,
    [businessId, from, to],
  );
  const out = new Map<string, PayrollRecurringItem[]>();
  for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), toItem(r)]);
  return out;
}

/** Adds a recurring allowance / deduction / benefit for a member. Statutory components cannot be recurring items. */
export async function addItem(params: { businessId: string; actorId: string | null; body: Record<string, unknown> }): Promise<PayrollRecurringItem> {
  const b = params.body;
  if (!isUuid(b.userId)) throw new PayrollError("staff_not_found", 404);
  if (!isUuid(b.componentId)) throw new PayrollError("component_not_found", 404);
  const amount = parseRialInput(b.amount);
  if (amount <= 0n || amount > MAX_RIAL) throw new PayrollError("invalid_amount", 400, "amount");
  const from = normalizeOptionalIsoDate(b.effectiveFrom);
  const to = normalizeOptionalIsoDate(b.effectiveTo);
  if (!from.ok || !from.value || !to.ok || (to.value && to.value < from.value)) throw new PayrollError("invalid_effective_date");
  const note = optionalText(b.note, 200, "note");

  return inTransaction(async (client) => {
    const run = clientRunner(client);
    const { rows: users } = await run<{ id: string }>(`SELECT id FROM users WHERE business_id = $1 AND id = $2`, [params.businessId, b.userId]);
    if (!users[0]) throw new PayrollError("staff_not_found", 404);
    const { rows: comps } = await run<{ kind: string; system_key: string | null }>(
      `SELECT kind, system_key FROM payroll_components WHERE business_id = $1 AND id = $2`,
      [params.businessId, b.componentId],
    );
    const comp = comps[0];
    if (!comp) throw new PayrollError("component_not_found", 404);
    const recurringSystem = ["bonus", "loan_installment"];
    if (comp.kind === "employer_contribution" || (comp.system_key && !recurringSystem.includes(comp.system_key))) {
      throw new PayrollError("component_not_enterable", 400, "componentId");
    }
    const { rows } = await run<{ id: string }>(
      `INSERT INTO payroll_employee_items (business_id, user_id, component_id, amount, effective_from, effective_to, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [params.businessId, b.userId, b.componentId, amount.toString(), from.value, to.value, note, params.actorId],
    );
    const { rows: out } = await run<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [rows[0].id]);
    return toItem(out[0]);
  });
}

/** Ends a recurring item on `effectiveTo` (default: yesterday's history is kept; the row is never deleted). */
export async function endItem(params: { businessId: string; itemId: string; effectiveTo: unknown }): Promise<PayrollRecurringItem> {
  if (!isUuid(params.itemId)) throw new PayrollError("item_not_found", 404);
  const to = normalizeOptionalIsoDate(params.effectiveTo);
  if (!to.ok || !to.value) throw new PayrollError("invalid_effective_date", 400, "effectiveTo");
  const { rows } = await poolRunner<{ id: string }>(
    `UPDATE payroll_employee_items SET effective_to = $3, ended_at = now()
      WHERE business_id = $1 AND id = $2 AND effective_from <= $3::date RETURNING id`,
    [params.businessId, params.itemId, to.value],
  );
  if (!rows[0]) throw new PayrollError("item_not_found", 404);
  const { rows: out } = await poolRunner<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [rows[0].id]);
  return toItem(out[0]);
}

export { SYSTEM_COMPONENT_KEYS };
