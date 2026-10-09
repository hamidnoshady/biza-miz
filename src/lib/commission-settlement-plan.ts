/**
 * What a settlement run would contain, decided from the rows the database
 * hands it (issue #869). Pure: no SQL, no clock. The service loads the rows
 * under lock, calls `planSettlement`, and writes exactly what comes back.
 *
 * The rule the whole lifecycle depends on is the one payroll already keeps
 * (#835): a member is paid only when their net unclaimed commission is
 * strictly positive. A member whose returns outweigh their sales keeps every
 * row unclaimed, so the negative balance nets against their next sales
 * instead of being paid out as a debt, and nothing is stranded.
 *
 * Rows are snapshotted, not referenced: names, rule terms and the source sale
 * are copied into the line, so the run reads the same after the rule is edited,
 * the member is renamed or the user is deleted.
 */
import { createHash } from "node:crypto";

export interface PlanRule {
  kind: "percent" | "fixed";
  basis: "net" | "margin";
  /** Percent (0–100) or fixed Rial, as integer text. */
  value: string;
  priority: number;
  itemIds: readonly string[];
  brandIds: readonly string[];
  categoryIds: readonly string[];
  activeFrom: string | null;
  activeTo: string | null;
  isActive: boolean;
}

export interface PlanAccrual {
  id: string;
  employeeId: string;
  /** Signed: a reversal is negative. Never zero (the accrual writer never stores one). */
  amount: bigint;
  basisAmount: bigint;
  ruleId: string | null;
  rule: PlanRule | null;
  sourceType: string;
  sourceId: string | null;
  orderNumber: string | null;
  itemName: string | null;
  locationId: string | null;
  /** The business date the sale posted on (YYYY-MM-DD). */
  saleDate: string;
  entryId: string | null;
  /** ISO timestamp, used only to order rows inside a day. */
  createdAt: string;
}

export interface PlanCarry {
  id: string;
  fromRunId: string;
  fromRunNumber: number;
  employeeId: string;
  employeeName: string;
  /** Positive: what a closed run left owing this member. */
  amount: bigint;
}

export interface PlanPerson {
  id: string;
  fullName: string;
  employeeCode: string | null;
  role: string | null;
  isActive: boolean;
}

export interface PlanInput {
  accruals: readonly PlanAccrual[];
  carries: readonly PlanCarry[];
  people: readonly PlanPerson[];
  /** Inclusive window the run was asked for (YYYY-MM-DD). Rows dated on or before `periodTo` are candidates. */
  periodFrom: string;
  periodTo: string;
  /** Rows in the window that a payroll run has already claimed. They are excluded, and the warning names how many. */
  claimedByPayroll: number;
}

export interface PlanLine {
  ordinal: number;
  lineKind: "accrual" | "carry_forward";
  accrualId: string | null;
  carryId: string | null;
  carriedFromRunId: string | null;
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  employeeRole: string | null;
  employeeActive: boolean;
  ruleId: string | null;
  ruleVersion: string | null;
  ruleTerms: Record<string, unknown> | null;
  sourceType: string;
  sourceId: string | null;
  sourceLabel: string;
  sourceOrderNumber: string | null;
  sourceItemName: string | null;
  locationId: string | null;
  saleDate: string | null;
  entryId: string | null;
  basisAmount: bigint;
  amount: bigint;
}

export type PlanWarning =
  | { code: "balance_not_positive"; employees: { employeeId: string; fullName: string; net: string; rows: number }[] }
  | { code: "claimed_by_payroll"; rows: number }
  | { code: "earlier_rows_included"; rows: number; before: string }
  | { code: "inactive_member"; employees: { employeeId: string; fullName: string }[] }
  | { code: "rule_missing"; rows: number };

export interface PlanMember {
  employeeId: string;
  fullName: string;
  net: bigint;
  lineCount: number;
}

export interface SettlementPlan {
  members: PlanMember[];
  lines: PlanLine[];
  accrualIds: string[];
  carryIds: string[];
  /** Σ of the lines, which equals Σ of the members' nets. */
  total: bigint;
  warnings: PlanWarning[];
}

/** A short, stable fingerprint of the terms that decided an amount. */
export function ruleVersionOf(rule: PlanRule | null): string | null {
  if (!rule) return null;
  const terms = ruleTermsOf(rule);
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex").slice(0, 16);
}

/** The rule's terms in a fixed key order, so the same rule always serialises the same way. */
export function ruleTermsOf(rule: PlanRule): Record<string, unknown> {
  return {
    kind: rule.kind,
    basis: rule.basis,
    value: rule.value,
    priority: rule.priority,
    itemIds: [...rule.itemIds].sort(),
    brandIds: [...rule.brandIds].sort(),
    categoryIds: [...rule.categoryIds].sort(),
    activeFrom: rule.activeFrom,
    activeTo: rule.activeTo,
    isActive: rule.isActive,
  };
}

/** A line's source in words. Carries and reversals say what they are, not just their table. */
export function sourceLabelFor(sourceType: string, orderNumber: string | null): string {
  switch (sourceType) {
    case "order_item":
      return orderNumber ? `سفارش ${orderNumber}` : "فروش";
    case "serial_return":
      return "برگشت کالا";
    case "order_amendment":
      return "ابطال یا اصلاح فاکتور";
    default:
      return sourceType;
  }
}

function accrualOrder(a: PlanAccrual, b: PlanAccrual): number {
  if (a.saleDate !== b.saleDate) return a.saleDate < b.saleDate ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareMembers(a: PlanMember, b: PlanMember): number {
  const byName = a.fullName.localeCompare(b.fullName, "fa");
  if (byName !== 0) return byName;
  return a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0;
}

export function planSettlement(input: PlanInput): SettlementPlan {
  const people = new Map(input.people.map((person) => [person.id, person]));

  // Group every candidate row by the member it belongs to.
  const groups = new Map<string, { accruals: PlanAccrual[]; carries: PlanCarry[]; net: bigint }>();
  const groupOf = (employeeId: string) => {
    let group = groups.get(employeeId);
    if (!group) {
      group = { accruals: [], carries: [], net: 0n };
      groups.set(employeeId, group);
    }
    return group;
  };
  for (const accrual of input.accruals) {
    const group = groupOf(accrual.employeeId);
    group.accruals.push(accrual);
    group.net += accrual.amount;
  }
  for (const carry of input.carries) {
    const group = groupOf(carry.employeeId);
    group.carries.push(carry);
    group.net += carry.amount;
  }

  const members: PlanMember[] = [];
  const blocked: { employeeId: string; fullName: string; net: string; rows: number }[] = [];
  const memberRows = new Map<string, { accruals: PlanAccrual[]; carries: PlanCarry[] }>();

  for (const [employeeId, group] of groups) {
    const person = people.get(employeeId);
    const fullName = person?.fullName ?? group.carries[0]?.employeeName ?? "—";
    if (group.net > 0n) {
      members.push({ employeeId, fullName, net: group.net, lineCount: group.accruals.length + group.carries.length });
      memberRows.set(employeeId, { accruals: [...group.accruals].sort(accrualOrder), carries: group.carries });
    } else {
      blocked.push({ employeeId, fullName, net: group.net.toString(), rows: group.accruals.length + group.carries.length });
    }
  }
  members.sort(compareMembers);
  blocked.sort((a, b) => a.fullName.localeCompare(b.fullName, "fa"));

  // Lines: each paid member's rows, in name order, then date order, carries last.
  const lines: PlanLine[] = [];
  const accrualIds: string[] = [];
  const carryIds: string[] = [];
  let total = 0n;
  let ordinal = 0;
  for (const member of members) {
    const rows = memberRows.get(member.employeeId)!;
    const person = people.get(member.employeeId);
    const identity = {
      employeeName: member.fullName,
      employeeCode: person?.employeeCode ?? null,
      employeeRole: person?.role ?? null,
      employeeActive: person?.isActive ?? true,
    };
    for (const accrual of rows.accruals) {
      ordinal += 1;
      accrualIds.push(accrual.id);
      total += accrual.amount;
      lines.push({
        ordinal,
        lineKind: "accrual",
        accrualId: accrual.id,
        carryId: null,
        carriedFromRunId: null,
        employeeId: member.employeeId,
        ...identity,
        ruleId: accrual.ruleId,
        ruleVersion: ruleVersionOf(accrual.rule),
        ruleTerms: accrual.rule ? ruleTermsOf(accrual.rule) : null,
        sourceType: accrual.sourceType,
        sourceId: accrual.sourceId,
        sourceLabel: sourceLabelFor(accrual.sourceType, accrual.orderNumber),
        sourceOrderNumber: accrual.orderNumber,
        sourceItemName: accrual.itemName,
        locationId: accrual.locationId,
        saleDate: accrual.saleDate,
        entryId: accrual.entryId,
        basisAmount: accrual.basisAmount,
        amount: accrual.amount,
      });
    }
    for (const carry of rows.carries) {
      ordinal += 1;
      carryIds.push(carry.id);
      total += carry.amount;
      lines.push({
        ordinal,
        lineKind: "carry_forward",
        accrualId: null,
        carryId: carry.id,
        carriedFromRunId: carry.fromRunId,
        employeeId: member.employeeId,
        ...identity,
        ruleId: null,
        ruleVersion: null,
        ruleTerms: null,
        sourceType: "carry_forward",
        sourceId: null,
        sourceLabel: `مانده دورهٔ شماره ${carry.fromRunNumber}`,
        sourceOrderNumber: null,
        sourceItemName: null,
        locationId: null,
        saleDate: null,
        entryId: null,
        basisAmount: 0n,
        amount: carry.amount,
      });
    }
  }

  const claimedAccruals = lines.filter((line) => line.lineKind === "accrual");
  const warnings: PlanWarning[] = [];
  if (blocked.length > 0) warnings.push({ code: "balance_not_positive", employees: blocked });
  if (input.claimedByPayroll > 0) warnings.push({ code: "claimed_by_payroll", rows: input.claimedByPayroll });
  const earlier = claimedAccruals.filter((line) => (line.saleDate ?? "") < input.periodFrom).length;
  if (earlier > 0) warnings.push({ code: "earlier_rows_included", rows: earlier, before: input.periodFrom });
  const inactive = members
    .filter((member) => people.get(member.employeeId)?.isActive === false)
    .map((member) => ({ employeeId: member.employeeId, fullName: member.fullName }));
  if (inactive.length > 0) warnings.push({ code: "inactive_member", employees: inactive });
  const withoutRule = claimedAccruals.filter((line) => line.ruleId === null).length;
  if (withoutRule > 0) warnings.push({ code: "rule_missing", rows: withoutRule });

  return { members, lines, accrualIds, carryIds, total, warnings };
}
