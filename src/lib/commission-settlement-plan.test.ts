import { describe, expect, it } from "vitest";
import {
  planSettlement,
  ruleTermsOf,
  ruleVersionOf,
  sourceLabelFor,
  type PlanAccrual,
  type PlanCarry,
  type PlanPerson,
  type PlanRule,
} from "./commission-settlement-plan";

const RULE: PlanRule = {
  kind: "percent",
  basis: "net",
  value: "5",
  priority: 0,
  itemIds: [],
  brandIds: [],
  categoryIds: [],
  activeFrom: null,
  activeTo: null,
  isActive: true,
};

const PEOPLE: PlanPerson[] = [
  { id: "emp-a", fullName: "علی", employeeCode: "E-1", role: "cashier", isActive: true },
  { id: "emp-b", fullName: "بابک", employeeCode: null, role: "cashier", isActive: true },
];

function accrual(id: string, employeeId: string, amount: bigint, extra: Partial<PlanAccrual> = {}): PlanAccrual {
  return {
    id,
    employeeId,
    amount,
    basisAmount: amount * 20n,
    ruleId: "rule-1",
    rule: RULE,
    sourceType: "order_item",
    sourceId: `src-${id}`,
    orderNumber: "101",
    itemName: "رژ لب",
    locationId: "loc-1",
    saleDate: "2026-10-05",
    entryId: `entry-${id}`,
    createdAt: "2026-10-05T10:00:00.000000Z",
    ...extra,
  };
}

function carry(id: string, employeeId: string, amount: bigint, fromRunNumber = 3): PlanCarry {
  return { id, fromRunId: `run-${fromRunNumber}`, fromRunNumber, employeeId, employeeName: "نامعلوم", amount };
}

const BASE = { people: PEOPLE, periodFrom: "2026-10-01", periodTo: "2026-10-09", claimedByPayroll: 0 };

describe("which rows a run takes", () => {
  it("claims every row of a member whose net is positive, in name then date order", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [
        accrual("a2", "emp-a", 300n, { saleDate: "2026-10-07", createdAt: "2026-10-07T09:00:00.000000Z" }),
        accrual("a1", "emp-a", 100n, { saleDate: "2026-10-05" }),
        accrual("b1", "emp-b", 200n),
      ],
      carries: [],
    });

    expect(plan.members.map((m) => [m.fullName, m.net.toString()])).toEqual([
      ["بابک", "200"],
      ["علی", "400"],
    ]);
    expect(plan.lines.map((l) => l.accrualId)).toEqual(["b1", "a1", "a2"]);
    expect(plan.lines.map((l) => l.ordinal)).toEqual([1, 2, 3]);
    expect(plan.total).toBe(600n);
    expect(plan.accrualIds).toEqual(["b1", "a1", "a2"]);
    expect(plan.warnings).toEqual([]);
  });

  it("holds a member back whose returns outweigh their sales, and says so by name", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [accrual("a1", "emp-a", 100n), accrual("a2", "emp-a", -250n, { sourceType: "serial_return", orderNumber: null })],
      carries: [],
    });

    expect(plan.members).toEqual([]);
    expect(plan.lines).toEqual([]);
    expect(plan.accrualIds).toEqual([]);
    expect(plan.warnings).toEqual([
      { code: "balance_not_positive", employees: [{ employeeId: "emp-a", fullName: "علی", net: "-150", rows: 2 }] },
    ]);
  });

  it("nets a return against the same member's sale and claims both rows, so the reversal is traceable", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [accrual("sale", "emp-a", 500n), accrual("ret", "emp-a", -120n, { sourceType: "serial_return", orderNumber: null })],
      carries: [],
    });

    expect(plan.total).toBe(380n);
    const reversal = plan.lines.find((l) => l.accrualId === "ret");
    expect(reversal).toMatchObject({ amount: -120n, sourceLabel: "برگشت کالا" });
  });

  it("treats a zero balance as nothing to pay, not as a member to settle", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [accrual("a1", "emp-a", 100n), accrual("a2", "emp-a", -100n, { sourceType: "order_amendment" })],
      carries: [],
    });
    expect(plan.members).toEqual([]);
    expect(plan.warnings[0]).toMatchObject({ code: "balance_not_positive" });
  });

  it("carries a balance forward into the member's lines, last, with the run it came from", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [accrual("a1", "emp-a", 100n)],
      carries: [carry("c1", "emp-a", 900n, 7)],
    });

    expect(plan.total).toBe(1000n);
    expect(plan.carryIds).toEqual(["c1"]);
    const last = plan.lines[plan.lines.length - 1];
    expect(last).toMatchObject({
      lineKind: "carry_forward",
      carryId: "c1",
      carriedFromRunId: "run-7",
      amount: 900n,
      sourceLabel: "مانده دورهٔ شماره 7",
      accrualId: null,
    });
  });

  it("includes a carried balance even when the member has no rows in this window", () => {
    const plan = planSettlement({ ...BASE, accruals: [], carries: [carry("c1", "emp-b", 50n)] });
    expect(plan.members).toEqual([expect.objectContaining({ employeeId: "emp-b", net: 50n, lineCount: 1 })]);
  });

  it("produces an empty plan from nothing", () => {
    const plan = planSettlement({ ...BASE, accruals: [], carries: [] });
    expect(plan).toMatchObject({ members: [], lines: [], accrualIds: [], carryIds: [], total: 0n, warnings: [] });
  });
});

describe("warnings the run carries", () => {
  it("names rows a payroll run already holds, and how many", () => {
    const plan = planSettlement({ ...BASE, accruals: [accrual("a1", "emp-a", 100n)], carries: [], claimedByPayroll: 3 });
    expect(plan.warnings).toContainEqual({ code: "claimed_by_payroll", rows: 3 });
  });

  it("counts rows dated before the run's start, which were left unpaid earlier", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [accrual("old", "emp-a", 100n, { saleDate: "2026-09-20" }), accrual("new", "emp-a", 100n)],
      carries: [],
    });
    expect(plan.warnings).toContainEqual({ code: "earlier_rows_included", rows: 1, before: "2026-10-01" });
  });

  it("flags an inactive member who is nonetheless being paid", () => {
    const people = PEOPLE.map((p) => (p.id === "emp-b" ? { ...p, isActive: false } : p));
    const plan = planSettlement({ ...BASE, people, accruals: [accrual("b1", "emp-b", 100n)], carries: [] });
    expect(plan.warnings).toContainEqual({ code: "inactive_member", employees: [{ employeeId: "emp-b", fullName: "بابک" }] });
  });

  it("counts claimed rows whose rule has since been deleted", () => {
    const plan = planSettlement({
      ...BASE,
      accruals: [accrual("a1", "emp-a", 100n, { ruleId: null, rule: null })],
      carries: [],
    });
    expect(plan.warnings).toContainEqual({ code: "rule_missing", rows: 1 });
    expect(plan.lines[0]).toMatchObject({ ruleId: null, ruleVersion: null, ruleTerms: null });
  });
});

describe("the snapshot a line keeps", () => {
  it("fixes the rule terms and their fingerprint, so a later edit to the rule changes neither", () => {
    const first = planSettlement({ ...BASE, accruals: [accrual("a1", "emp-a", 100n)], carries: [] }).lines[0];
    const edited = planSettlement({
      ...BASE,
      accruals: [accrual("a1", "emp-a", 100n, { rule: { ...RULE, value: "7" } })],
      carries: [],
    }).lines[0];

    expect(first.ruleTerms).toMatchObject({ kind: "percent", value: "5" });
    expect(first.ruleVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(edited.ruleVersion).not.toBe(first.ruleVersion);
    expect(edited.ruleTerms).toMatchObject({ value: "7" });
  });

  it("keeps the member's name as it was on the run, from the people snapshot", () => {
    const line = planSettlement({ ...BASE, accruals: [accrual("a1", "emp-a", 100n)], carries: [] }).lines[0];
    expect(line).toMatchObject({ employeeName: "علی", employeeCode: "E-1", employeeRole: "cashier", employeeActive: true });
  });
});

describe("rule fingerprints and labels", () => {
  it("is the same for the same terms, whatever order the scope lists came in", () => {
    const a = { ...RULE, itemIds: ["x", "y"] };
    const b = { ...RULE, itemIds: ["y", "x"] };
    expect(ruleVersionOf(a)).toBe(ruleVersionOf(b));
    expect(ruleTermsOf(b).itemIds).toEqual(["x", "y"]);
  });

  it("has no fingerprint for a rule that no longer exists", () => {
    expect(ruleVersionOf(null)).toBeNull();
  });

  it("says what a source is in words, with the order number when there is one", () => {
    expect(sourceLabelFor("order_item", "101")).toBe("سفارش 101");
    expect(sourceLabelFor("order_item", null)).toBe("فروش");
    expect(sourceLabelFor("serial_return", null)).toBe("برگشت کالا");
    expect(sourceLabelFor("order_amendment", null)).toBe("ابطال یا اصلاح فاکتور");
    expect(sourceLabelFor("something_new", null)).toBe("something_new");
  });
});
