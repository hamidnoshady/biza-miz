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
import { clientRunner, inTransaction, lockPayroll, poolRunner, type Runner } from "./payroll-db";
import { PayrollError } from "./payroll-errors";
import { asciiDigits, isValidCardNumber, isValidIranianIban, isValidIranianNationalId } from "./parties";
import { usablePaymentAccounts, type ChartAccountRow } from "./payroll-payment-accounts";
import {
  DEFAULT_COMPONENTS,
  IRAN_RULE_TEMPLATE,
  parsePayrollRuleSet,
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
    await lockPayroll(client, params.businessId);
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
  await inTransaction(async (client) => {
    await lockPayroll(client, businessId);
    await ensureCatalogue(client, businessId);
  });
  const { rows } = await poolRunner<ComponentRow>(`${COMPONENT_SELECT} WHERE business_id = $1 ORDER BY kind, code`, [businessId]);
  return rows.map(toComponent);
}

/**
 * The small chart projection payroll needs for component posting mappings. It
 * is intentionally not `/api/ledger/accounts`: payroll readers only see active
 * posting leaves (code, label and class), never balances or ledger activity.
 */
export async function listPayrollPostingAccounts(businessId: string) {
  const { rows } = await poolRunner<{ id: string; code: string; name: string; type: string }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type
       FROM accounts a
      WHERE a.business_id = $1 AND a.is_active
        AND NOT EXISTS (SELECT 1 FROM accounts child WHERE child.business_id = a.business_id AND child.parent_id = a.id AND child.is_active)
      ORDER BY a.code`,
    [businessId],
  );
  return rows;
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
 * Creates (no `id`) or edits a component. A seeded component's `system_key`
 * is fixed and drives calculation. Its code may be renamed, but its kind,
 * statutory flags, effective window and active state cannot be changed. Names
 * and ledger mappings remain business-configurable. Every change is audited.
 */
export async function saveComponent(params: { businessId: string; actorId: string | null; id?: unknown; body: Record<string, unknown> }): Promise<PayrollComponent> {
  const b = params.body;
  return inTransaction(async (client) => {
    await lockPayroll(client, params.businessId);
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
      if (taxable !== before.taxable || insurable !== before.insurable) throw new PayrollError("system_component_locked", 409, "statutory_flags");
      if (from.value !== before.effective_from || to.value !== before.effective_to) throw new PayrollError("system_component_locked", 409, "effective_dates");
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
            `UPDATE payroll_components SET code=$3, name=$4, kind=$5, taxable=$6, insurable=$7,
                    debit_account_code=$8, credit_account_code=$9, effective_from=COALESCE($10::date, effective_from),
                    effective_to=$11, is_active=$12, updated_at=now()
              WHERE business_id=$1 AND id=$2
              RETURNING id, code, name, kind, system_key, taxable, insurable, debit_account_code, credit_account_code,
                        effective_from::text AS effective_from, effective_to::text AS effective_to, is_active`,
            [params.businessId, before.id, code, name.trim(), kind, taxable, insurable, debit, credit, from.value, to.value, isActive],
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
       FROM payroll_component_changes c LEFT JOIN users u ON u.id = c.changed_by AND u.business_id = c.business_id
      WHERE c.business_id = $1 AND c.component_id = $2 ORDER BY c.changed_at DESC, c.id DESC`,
    [businessId, componentId],
  );
  return rows.map((r) => ({ before: r.before, after: r.after, changedByName: r.changed_by_name, changedAt: r.changed_at }));
}

// ---------------------------------------------------------------------------
// Employee profiles
// ---------------------------------------------------------------------------

const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "hourly", "intern"] as const;

export interface CostAllocationShare {
  percent: number;
  locationId?: string | null;
  projectId?: string | null;
  label?: string | null;
}

export interface PayrollProfile {
  userId: string;
  fullName: string;
  /** Canonical personnel code on the shared employee identity. */
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

/** Audit records retain change context without copying identity or bank numbers. */
function profileAuditShape(profile: PayrollProfile) {
  return {
    ...profile,
    insuranceProfile: {
      insured: profile.insuranceProfile.insured,
      insuranceNumberStored: Boolean(profile.insuranceProfile.insuranceNumber),
    },
    taxProfile: {
      exempt: profile.taxProfile.exempt,
      nationalIdStored: Boolean(profile.taxProfile.nationalId),
    },
    paymentDestination: {
      method: profile.paymentDestination.method,
      paymentAccountId: profile.paymentDestination.paymentAccountId ?? null,
      ibanStored: Boolean(profile.paymentDestination.iban),
      cardNumberStored: Boolean(profile.paymentDestination.cardNumber),
    },
  };
}

const PROFILE_SELECT = `SELECT u.id AS user_id, u.full_name, e.employee_code, (p.user_id IS NOT NULL) AS configured,
       p.payroll_code, p.employment_type, COALESCE(p.hire_date, e.hired_at)::text AS hire_date,
       p.termination_date::text AS termination_date, p.base_salary::text AS base_salary,
       p.insurance_profile, p.tax_profile, p.payment_destination, p.cost_allocation, p.is_active
  FROM users u
  LEFT JOIN employees e ON e.id = u.id AND e.business_id = u.business_id
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
function parseCostAllocation(raw: unknown): CostAllocationShare[] {
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

/**
 * Every branch and project an allocation names must be this business's own and
 * usable: an active location, a project that is not archived. Checked with an
 * explicit `business_id` filter (not only RLS), so a foreign id is refused even
 * on a connection whose tenant scope is bypassed. Throws
 * `invalid_cost_allocation` naming the offending field.
 */
export async function assertAllocationReferences(run: Runner, businessId: string, shares: readonly CostAllocationShare[]): Promise<void> {
  const locationIds = [...new Set(shares.map((s) => s.locationId).filter((v): v is string => !!v))];
  const projectIds = [...new Set(shares.map((s) => s.projectId).filter((v): v is string => !!v))];
  if (locationIds.length > 0) {
    const { rows } = await run<{ id: string }>(
      `SELECT id FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[]) AND is_active`,
      [businessId, locationIds],
    );
    const missing = locationIds.find((id) => !rows.some((r) => r.id === id));
    if (missing) throw new PayrollError("invalid_cost_allocation", 400, { field: "costAllocation.locationId", locationId: missing });
  }
  if (projectIds.length > 0) {
    const { rows } = await run<{ id: string }>(
      `SELECT id FROM ai_projects WHERE business_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`,
      [businessId, projectIds],
    );
    const missing = projectIds.find((id) => !rows.some((r) => r.id === id));
    if (missing) throw new PayrollError("invalid_cost_allocation", 400, { field: "costAllocation.projectId", projectId: missing });
  }
}

/** Creates or updates a team member's payroll profile, auditing the before/after. */
export async function saveProfile(params: { businessId: string; actorId: string | null; userId: string; body: Record<string, unknown> }): Promise<PayrollProfile> {
  if (!isUuid(params.userId)) throw new PayrollError("staff_not_found", 404);
  return inTransaction(async (client) => {
    await lockPayroll(client, params.businessId);
    const run = clientRunner(client);
    const { rows: currentRows } = await run<ProfileRow>(`${PROFILE_SELECT} WHERE u.business_id = $1 AND u.id = $2`, [params.businessId, params.userId]);
    const current = currentRows[0] ? toProfile(currentRows[0]) : null;
    if (!current) throw new PayrollError("staff_not_found", 404);
    const b = params.body;
    const pick = <T>(key: string, fallback: T): unknown => (b[key] === undefined ? fallback : b[key]);

    const employeeCode = optionalText(pick("employeeCode", current.employeeCode), 40, "employeeCode");
    const payrollCode = optionalText(pick("payrollCode", current.payrollCode), 40, "payrollCode");
    const rawEmploymentType = pick("employmentType", current.employmentType);
    if (!EMPLOYMENT_TYPES.includes(rawEmploymentType as never)) throw new PayrollError("invalid_profile", 400, "employmentType");
    const employmentType = rawEmploymentType as PayrollProfile["employmentType"];
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
    const destinationMethod = dest.method as PayrollProfile["paymentDestination"]["method"];
    if (dest.paymentAccountId !== undefined && dest.paymentAccountId !== null && !isUuid(dest.paymentAccountId)) {
      throw new PayrollError("invalid_profile", 400, "paymentDestination.paymentAccountId");
    }
    const rawIban = optionalText(dest.iban, 34, "paymentDestination.iban");
    const iban = rawIban ? rawIban.replace(/[\s-]/g, "").toUpperCase() : null;
    if (iban && !isValidIranianIban(iban)) throw new PayrollError("invalid_iban", 400, "paymentDestination.iban");
    if (dest.method === "bank" && !iban) throw new PayrollError("invalid_iban", 400, "paymentDestination.iban");
    const rawCardNumber = optionalText(dest.cardNumber, 32, "paymentDestination.cardNumber");
    const cardNumber = rawCardNumber ? asciiDigits(rawCardNumber) : null;
    if (cardNumber && !isValidCardNumber(cardNumber)) throw new PayrollError("invalid_card_number", 400, "paymentDestination.cardNumber");
    const allocation = parseCostAllocation(pick("costAllocation", current.costAllocation));
    await assertAllocationReferences(run, params.businessId, allocation);
    const isActive = pick("isActive", current.isActive);
    if (typeof isActive !== "boolean") throw new PayrollError("invalid_profile", 400, "isActive");

    const rawInsuranceNumber = optionalText(ins.insuranceNumber, 40, "insuranceProfile.insuranceNumber");
    const insuranceNumber = rawInsuranceNumber ? asciiDigits(rawInsuranceNumber) : null;
    if (ins.insured && (!insuranceNumber || insuranceNumber.length > 20)) {
      throw new PayrollError("invalid_insurance_number", 400, "insuranceProfile.insuranceNumber");
    }
    const rawNationalId = optionalText(tax.nationalId, 24, "taxProfile.nationalId");
    const nationalId = rawNationalId ? asciiDigits(rawNationalId) : null;
    if (nationalId && !isValidIranianNationalId(nationalId)) throw new PayrollError("invalid_national_id", 400, "taxProfile.nationalId");
    if (!tax.exempt && !nationalId) throw new PayrollError("invalid_national_id", 400, "taxProfile.nationalId");

    const paymentAccountId = (dest.paymentAccountId as string | undefined) ?? null;
    if (paymentAccountId) {
      const { rows } = await run<{ id: string; code: string; name: string; parent_id: string | null; type: ChartAccountRow["type"] }>(
        `SELECT id, code, name, parent_id, type::text AS type FROM accounts WHERE business_id = $1 AND is_active`,
        [params.businessId],
      );
      const eligible = usablePaymentAccounts(rows.map((r) => ({ id: r.id, code: r.code, name: r.name, parentId: r.parent_id, type: r.type })))
        .find((account) => account.id === paymentAccountId);
      if (!eligible || (dest.method === "bank" ? eligible.role !== "bank" : eligible.role === "bank")) {
        throw new PayrollError("invalid_payment_account", 400, "paymentDestination.paymentAccountId");
      }
    }

    const next = {
      employeeCode,
      payrollCode,
      employmentType,
      hireDate: hire.value,
      terminationDate: term.value,
      baseSalary: salary.toString(),
      insuranceProfile: { insured: ins.insured, insuranceNumber },
      taxProfile: { exempt: tax.exempt, nationalId },
      paymentDestination: { method: destinationMethod, paymentAccountId, iban, cardNumber },
      costAllocation: allocation,
      isActive,
    };

    // Personnel code is part of the shared employee identity, not a payroll-only
    // shadow field. A supplied null/empty value deliberately clears it; an
    // omitted field preserves the canonical value read above.
    if (employeeCode !== current.employeeCode) {
      const { rows: employeeRows } = await client.query<{ id: string }>(
        `INSERT INTO employees (id, business_id, employee_code) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET employee_code = EXCLUDED.employee_code, updated_at = now()
           WHERE employees.business_id = EXCLUDED.business_id
         RETURNING id`,
        [params.userId, params.businessId, employeeCode],
      );
      if (!employeeRows[0]) throw new PayrollError("staff_not_found", 404);
    }
    if (b.hireDate !== undefined && hire.value !== current.hireDate) {
      const updated = await client.query(
        `UPDATE employees SET hired_at = $3::date, updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [params.userId, params.businessId, hire.value],
      );
      if (updated.rowCount === 0 && hire.value !== null) {
        const { rows: employeeRows } = await client.query<{ id: string }>(
          `INSERT INTO employees (id, business_id, hired_at) VALUES ($1, $2, $3::date)
           ON CONFLICT (id) DO UPDATE SET hired_at = EXCLUDED.hired_at, updated_at = now()
             WHERE employees.business_id = EXCLUDED.business_id
           RETURNING id`,
          [params.userId, params.businessId, hire.value],
        );
        if (!employeeRows[0]) throw new PayrollError("staff_not_found", 404);
      }
    }

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
      [
        params.businessId,
        params.userId,
        current.configured ? JSON.stringify(profileAuditShape(current)) : null,
        JSON.stringify(profileAuditShape({ ...current, ...next, configured: true })),
        params.actorId,
      ],
    );
    const { rows: savedRows } = await run<ProfileRow>(`${PROFILE_SELECT} WHERE u.business_id = $1 AND u.id = $2`, [params.businessId, params.userId]);
    return toProfile(savedRows[0]);
  });
}

export async function listProfileChanges(businessId: string, userId: string) {
  if (!isUuid(userId)) return [];
  const { rows } = await poolRunner<{ before: unknown; after: unknown; changed_by_name: string | null; changed_at: string }>(
    `SELECT c.before, c.after, u.full_name AS changed_by_name, c.changed_at::text AS changed_at
       FROM payroll_profile_changes c LEFT JOIN users u ON u.id = c.changed_by AND u.business_id = c.business_id
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
  createdBy: string | null;
  createdAt: string;
  endedAt: string | null;
}

const ITEM_SELECT = `SELECT i.id, i.user_id, i.component_id, c.code AS component_code, c.name AS component_name, c.kind,
       i.amount::text AS amount, i.effective_from::text AS effective_from, i.effective_to::text AS effective_to, i.note,
       i.created_by, i.created_at::text AS created_at, i.ended_at::text AS ended_at
  FROM payroll_employee_items i JOIN payroll_components c ON c.id = i.component_id AND c.business_id = i.business_id`;

type ItemRow = Record<string, unknown> & {
  id: string; user_id: string; component_id: string; component_code: string; component_name: string;
  kind: ComponentKind; amount: string; effective_from: string; effective_to: string | null; note: string | null;
  created_by: string | null; created_at: string; ended_at: string | null;
};

const toItem = (r: ItemRow): PayrollRecurringItem => ({
  id: r.id, userId: r.user_id, componentId: r.component_id, componentCode: r.component_code, componentName: r.component_name,
  kind: r.kind, amount: r.amount, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, note: r.note,
  createdBy: r.created_by, createdAt: r.created_at, endedAt: r.ended_at,
});

export async function listItems(businessId: string, userId?: string): Promise<PayrollRecurringItem[]> {
  if (userId !== undefined && !isUuid(userId)) throw new PayrollError("invalid_user_id", 400, "userId");
  const { rows } = await poolRunner<ItemRow>(
    `${ITEM_SELECT} WHERE i.business_id = $1 AND ($2::uuid IS NULL OR i.user_id = $2) ORDER BY i.effective_from DESC, i.id`,
    [businessId, userId ?? null],
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
  const effectiveFrom = from.value;
  const effectiveTo = to.value;
  const note = optionalText(b.note, 200, "note");

  return inTransaction(async (client) => {
    await lockPayroll(client, params.businessId);
    const run = clientRunner(client);
    const { rows: users } = await run<{ id: string }>(`SELECT id FROM users WHERE business_id = $1 AND id = $2`, [params.businessId, b.userId]);
    if (!users[0]) throw new PayrollError("staff_not_found", 404);
    const { rows: comps } = await run<{ kind: string; system_key: string | null; is_active: boolean; effective_from: string; effective_to: string | null }>(
      `SELECT kind, system_key, is_active, effective_from::text AS effective_from, effective_to::text AS effective_to
         FROM payroll_components WHERE business_id = $1 AND id = $2`,
      [params.businessId, b.componentId],
    );
    const comp = comps[0];
    if (!comp) throw new PayrollError("component_not_found", 404);
    const recurringSystem = ["bonus", "loan_installment"];
    if (!comp.is_active || comp.kind === "employer_contribution" || (comp.system_key && !recurringSystem.includes(comp.system_key))) {
      throw new PayrollError("component_not_enterable", 400, "componentId");
    }
    if (effectiveFrom < comp.effective_from || (comp.effective_to !== null && (effectiveTo === null || effectiveTo > comp.effective_to))) {
      throw new PayrollError("invalid_effective_date", 400, "effectiveFrom");
    }
    const { rows } = await run<{ id: string }>(
      `INSERT INTO payroll_employee_items (business_id, user_id, component_id, amount, effective_from, effective_to, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [params.businessId, b.userId, b.componentId, amount.toString(), effectiveFrom, effectiveTo, note, params.actorId],
    );
    const { rows: out } = await run<ItemRow>(`${ITEM_SELECT} WHERE i.business_id = $1 AND i.id = $2`, [params.businessId, rows[0].id]);
    const item = toItem(out[0]);
    await run(
      `INSERT INTO payroll_employee_item_changes (business_id, item_id, before, after, changed_by)
       VALUES ($1, $2, NULL, $3, $4)`,
      [params.businessId, item.id, JSON.stringify(item), params.actorId],
    );
    return item;
  });
}

/** Ends a recurring item on `effectiveTo`; the row and its before/after audit are retained. */
export async function endItem(params: {
  businessId: string;
  itemId: string;
  effectiveTo: unknown;
  actorId: string | null;
}): Promise<PayrollRecurringItem> {
  if (!isUuid(params.itemId)) throw new PayrollError("item_not_found", 404);
  const to = normalizeOptionalIsoDate(params.effectiveTo);
  if (!to.ok || !to.value) throw new PayrollError("invalid_effective_date", 400, "effectiveTo");
  const effectiveTo = to.value;
  return inTransaction(async (client) => {
    await lockPayroll(client, params.businessId);
    const run = clientRunner(client);
    const { rows: beforeRows } = await run<ItemRow>(`${ITEM_SELECT} WHERE i.business_id = $1 AND i.id = $2 FOR UPDATE OF i`, [params.businessId, params.itemId]);
    const before = beforeRows[0];
    if (!before) throw new PayrollError("item_not_found", 404);
    if (effectiveTo < before.effective_from) throw new PayrollError("invalid_effective_date", 400, "effectiveTo");
    if (before.effective_to === effectiveTo && before.ended_at !== null) return toItem(before);

    await run(
      `UPDATE payroll_employee_items SET effective_to = $3, ended_at = now()
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.itemId, effectiveTo],
    );
    const { rows: afterRows } = await run<ItemRow>(`${ITEM_SELECT} WHERE i.business_id = $1 AND i.id = $2`, [params.businessId, params.itemId]);
    const item = toItem(afterRows[0]);
    await run(
      `INSERT INTO payroll_employee_item_changes (business_id, item_id, before, after, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.businessId, item.id, JSON.stringify(toItem(before)), JSON.stringify(item), params.actorId],
    );
    return item;
  });
}

/** Read-only history for one item; a foreign or missing id reveals no rows. */
export async function listItemChanges(businessId: string, itemId: string) {
  if (!isUuid(itemId)) return [];
  const { rows } = await poolRunner<{
    before: unknown;
    after: unknown;
    changed_by: string | null;
    changed_by_name: string | null;
    changed_at: string;
  }>(
    `SELECT c.before, c.after, c.changed_by, u.full_name AS changed_by_name, c.changed_at::text AS changed_at
       FROM payroll_employee_item_changes c
       JOIN payroll_employee_items i ON i.id = c.item_id AND i.business_id = c.business_id
       LEFT JOIN users u ON u.id = c.changed_by AND u.business_id = c.business_id
      WHERE c.business_id = $1 AND c.item_id = $2
      ORDER BY c.changed_at DESC, c.id DESC`,
    [businessId, itemId],
  );
  return rows.map((row) => ({ before: row.before, after: row.after, changedBy: row.changed_by, changedByName: row.changed_by_name, changedAt: row.changed_at }));
}

