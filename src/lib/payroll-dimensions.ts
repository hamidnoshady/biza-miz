/**
 * «انتساب حقوق به ابعاد» — payroll cost allocation across accounting
 * dimensions (issue #868, Phase 2), pure rules.
 *
 * The payroll engine (issue #865) already splits a payslip exactly across
 * cost-allocation shares (`allocateExact` in `payroll-engine-calc.ts`): branch
 * and project buckets. This module extends that same model with the four
 * accounting dimensions and gives the classic monthly accrual
 * (`payroll-service.ts`) the identical semantics — one allocation model, one
 * exact splitter, never a second payroll accounting system.
 *
 * ## The model
 *
 *   * Every member may carry a **default** dimension tuple (the `employees`
 *     row). It applies when the run has no explicit allocation for them.
 *   * A run may override per member with **shares**: each share is a whole
 *     number of basis points (shares of one member sum to exactly 10 000) and
 *     its own dimension tuple. The engine's `cost_allocation` shares follow
 *     the same shape.
 *   * The member's salary expense and employer-insurance expense are split
 *     across their shares with the engine's `allocateExact` — the split sums
 *     to the posted amount **to the Rial**, so the attributed lines always
 *     equal the payroll journal amount («بدون خطای رند»).
 *   * Liability legs and payment settlements are never attributed: salary
 *     expense attribution is separate from what the business owes and pays.
 *   * The shares used are written with the run (snapshot), and reversals
 *     mirror the posted lines — posted payroll history never changes.
 */
import { DIMENSION_KINDS, type DimensionKind, type LineDimensions } from "./accounting-dimensions";
import { isUuid } from "./uuid";
import { allocateExact } from "./payroll-engine-calc";

/** One allocation share of one member's payroll cost. */
export interface PayrollAllocationShare {
  /** Integer basis points of the member's cost; one member's shares sum to 10 000. */
  shareBp: number;
  dimensions: LineDimensions;
  label: string | null;
}

export const PAYROLL_MAX_ALLOCATION_SHARES = 20;

export type PayrollAllocationsParse =
  | { ok: true; value: Map<string, PayrollAllocationShare[]> }
  | { ok: false; error: string; field: string };

/**
 * Reads the per-run allocation override from a request body:
 * `[{ userId, shares: [{ shareBp, costCenterId?, …, label? }] }]`.
 *
 * Every member that carries shares must total exactly 10 000 bp; a member
 * with no entry here falls back to their default tuple. A malformed id, a
 * zero share, or a wrong total is refused **by name**, never silently rounded
 * into the run.
 */
export function parsePayrollAllocations(raw: unknown): PayrollAllocationsParse {
  if (raw === undefined || raw === null) return { ok: true, value: new Map() };
  if (!Array.isArray(raw)) return { ok: false, error: "invalid_allocations", field: "allocations" };
  const out = new Map<string, PayrollAllocationShare[]>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "invalid_allocations", field: "allocations" };
    }
    const e = entry as Record<string, unknown>;
    const userId = e.userId;
    if (typeof userId !== "string" || !isUuid(userId)) {
      return { ok: false, error: "invalid_allocations", field: "allocations.userId" };
    }
    if (out.has(userId)) return { ok: false, error: "invalid_allocations", field: "allocations.userId" };
    const sharesRaw = e.shares;
    if (!Array.isArray(sharesRaw) || sharesRaw.length === 0 || sharesRaw.length > PAYROLL_MAX_ALLOCATION_SHARES) {
      return { ok: false, error: "invalid_allocations", field: "allocations.shares" };
    }
    const shares: PayrollAllocationShare[] = [];
    let totalBp = 0;
    for (const shareRaw of sharesRaw) {
      if (typeof shareRaw !== "object" || shareRaw === null) {
        return { ok: false, error: "invalid_allocations", field: "allocations.shares" };
      }
      const s = shareRaw as Record<string, unknown>;
      const shareBp = s.shareBp;
      if (typeof shareBp !== "number" || !Number.isInteger(shareBp) || shareBp <= 0 || shareBp > 10_000) {
        return { ok: false, error: "invalid_allocation_share", field: "allocations.shares.shareBp" };
      }
      const dimensions: LineDimensions = {};
      const FIELD_KEYS = {
        cost_center: "costCenterId",
        profit_center: "profitCenterId",
        department: "departmentId",
        detail: "detailDimensionId",
      } as const;
      for (const kind of DIMENSION_KINDS) {
        const fieldKey = FIELD_KEYS[kind];
        const valueId = s[fieldKey];
        if (valueId === undefined || valueId === null) continue;
        if (typeof valueId !== "string" || !isUuid(valueId)) {
          return { ok: false, error: "invalid_allocations", field: `allocations.shares.${fieldKey}` };
        }
        dimensions[kind] = valueId;
      }
      const label = s.label === undefined || s.label === null ? null : String(s.label).trim().slice(0, 80) || null;
      totalBp += shareBp;
      shares.push({ shareBp, dimensions, label });
    }
    if (totalBp !== 10_000) {
      return { ok: false, error: "allocation_must_total_100", field: "allocations.shares" };
    }
    out.set(userId, shares);
  }
  return { ok: true, value: out };
}

/** The member's default share: one whole slice carrying their default tuple. */
export function defaultShare(dimensions: LineDimensions | null | undefined): PayrollAllocationShare[] {
  if (!dimensions || DIMENSION_KINDS.every((kind) => !dimensions[kind])) return [];
  return [{ shareBp: 10_000, dimensions, label: null }];
}

/** A stable grouping key for a dimension tuple (absent kinds collapse together). */
export function allocationTupleKey(dimensions: LineDimensions | null | undefined): string {
  return DIMENSION_KINDS.map((kind) => dimensions?.[kind] ?? "").join("|");
}

export function dimensionsFromTupleKey(key: string): LineDimensions {
  const parts = key.split("|");
  const out: LineDimensions = {};
  DIMENSION_KINDS.forEach((kind, index) => {
    const valueId = parts[index];
    if (valueId) out[kind] = valueId;
  });
  return out;
}

export interface PayrollExpenseMember {
  userId: string;
  /** The member's gross salary — the amount the salary-expense leg carries. */
  grossRial: bigint;
  /** Employer + unemployment insurance — the employer-insurance expense leg. */
  employerInsuranceExpenseRial: bigint;
}

export interface PayrollExpenseBucket {
  key: string;
  dimensions: LineDimensions;
  grossRial: bigint;
  employerInsuranceExpenseRial: bigint;
}

export interface PayrollExpenseSplit {
  /** Expense buckets grouped by dimension tuple — one entry pair per bucket. */
  buckets: PayrollExpenseBucket[];
  /** What each member's shares were charged — the run's audit snapshot. */
  perMember: Array<{
    userId: string;
    shares: readonly PayrollAllocationShare[];
    grossParts: bigint[];
  }>;
}

/**
 * Splits every member's expense across their shares and groups the result by
 * dimension tuple. Uses the engine's `allocateExact`, so each member's parts
 * sum to their amount to the Rial and the bucket totals equal the payroll
 * journal exactly. A member with no shares and no default lands in the
 * unattributed bucket — the two expense lines every run always had.
 */
export function payrollExpenseSplit(
  members: readonly PayrollExpenseMember[],
  sharesOf: (userId: string) => readonly PayrollAllocationShare[],
): PayrollExpenseSplit {
  const buckets = new Map<string, PayrollExpenseBucket>();
  const perMember: PayrollExpenseSplit["perMember"] = [];
  for (const member of members) {
    const shares = [...sharesOf(member.userId)];
    const effective = shares.length > 0 ? shares : [{ shareBp: 10_000, dimensions: {}, label: null }];
    const percents = effective.map((share) => share.shareBp / 100);
    const grossParts =
      member.grossRial === 0n ? effective.map(() => 0n) : allocateExact(member.grossRial, percents);
    const employerParts =
      member.employerInsuranceExpenseRial === 0n
        ? effective.map(() => 0n)
        : allocateExact(member.employerInsuranceExpenseRial, percents);
    perMember.push({ userId: member.userId, shares: effective, grossParts });
    effective.forEach((share, index) => {
      const key = allocationTupleKey(share.dimensions);
      let bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, (bucket = { key, dimensions: share.dimensions, grossRial: 0n, employerInsuranceExpenseRial: 0n }));
      }
      bucket.grossRial += grossParts[index];
      bucket.employerInsuranceExpenseRial += employerParts[index];
    });
  }
  // Deterministic posting order: the unattributed bucket first, then by key.
  const unattributedKey = allocationTupleKey({});
  const ordered = [...buckets.values()].sort((a, b) =>
    a.key === unattributedKey ? -1 : b.key === unattributedKey ? 1 : a.key.localeCompare(b.key),
  );
  return { buckets: ordered, perMember };
}

/** The kinds a share/employee tuple may carry — exported so callers validate the same set. */
export const PAYROLL_DIMENSION_KINDS: readonly DimensionKind[] = DIMENSION_KINDS;
