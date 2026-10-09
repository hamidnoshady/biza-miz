import { describe, expect, it } from "vitest";
import {
  accrualPostingSides,
  allocateExact,
  allocatePayslip,
  canTransition,
  computePayslip,
  coveredDays,
  DEFAULT_COMPONENTS,
  divRound,
  IRAN_RULE_TEMPLATE,
  NO_PRIOR,
  parsePayrollRuleSet,
  progressiveTax,
  prorate,
  type PriorPeriodTotals,
  type PayrollRuleSet,
  type PayslipInput,
} from "./payroll-engine-calc";

const rules: PayrollRuleSet = {
  ...IRAN_RULE_TEMPLATE,
  insuranceCeilingRial: 500_000_000,
  taxExemptMonthlyRial: 100_000_000,
  taxBrackets: [
    { upToRial: 200_000_000, ratePercent: 10 },
    { upToRial: null, ratePercent: 20 },
  ],
};

const base = (over: Partial<PayslipInput> = {}): PayslipInput => ({
  baseSalary: 150_000_000n,
  workedDays: null,
  insured: true,
  taxExempt: false,
  overtimeHours: 0,
  unpaidLeaveDays: 0,
  items: [],
  commission: 0n,
  advanceOwed: 0n,
  ...over,
});

describe("parsePayrollRuleSet", () => {
  it("accepts the template and fills defaults", () => {
    const r = parsePayrollRuleSet({});
    expect(r.ok && r.value.employeeInsurancePercent).toBe(7);
  });
  it("refuses non-ascending and closed brackets", () => {
    expect(parsePayrollRuleSet({ taxExemptMonthlyRial: 10, taxBrackets: [{ upToRial: 5, ratePercent: 10 }, { upToRial: null, ratePercent: 1 }] }))
      .toMatchObject({ ok: false, error: "brackets_not_ascending" });
    expect(parsePayrollRuleSet({ taxBrackets: [{ upToRial: 5, ratePercent: 10 }] })).toMatchObject({ ok: false, error: "last_bracket_must_be_open" });
    expect(parsePayrollRuleSet({ employerInsurancePercent: 120 })).toMatchObject({ ok: false, error: "invalid_percent" });
  });
});

describe("exact arithmetic", () => {
  it("rounds half away from zero", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
  });
  it("taxes progressively above the exemption", () => {
    expect(progressiveTax(100_000_000n, rules)).toBe(0n);
    expect(progressiveTax(150_000_000n, rules)).toBe(5_000_000n);
    expect(progressiveTax(300_000_000n, rules)).toBe(10_000_000n + 20_000_000n);
  });
  it("allocates exactly", () => {
    const parts = allocateExact(100n, [33.33, 33.33, 33.34]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
  });
});

describe("computePayslip", () => {
  it("computes a standard month", () => {
    const r = computePayslip(base({ items: [{ code: "HOUSING", amount: 10_000_000n }, { code: "CHILD", amount: 5_000_000n }] }), rules, DEFAULT_COMPONENTS);
    expect(r.gross).toBe(165_000_000n);
    expect(r.insuranceBase).toBe(160_000_000n); // CHILD not insurable
    expect(r.employeeInsurance).toBe(11_200_000n);
    expect(r.employerInsurance).toBe(32_000_000n);
    expect(r.unemploymentInsurance).toBe(4_800_000n);
    expect(r.taxableBase).toBe(165_000_000n - 11_200_000n);
    expect(r.incomeTax).toBe(5_380_000n);
    expect(r.netPay).toBe(165_000_000n - 11_200_000n - 5_380_000n);
    expect(r.employerCost).toBe(165_000_000n + 32_000_000n + 4_800_000n);
  });

  it("applies overtime and unpaid leave", () => {
    const r = computePayslip(base({ overtimeHours: 10, unpaidLeaveDays: 3 }), { ...rules, taxBrackets: [] }, DEFAULT_COMPONENTS);
    const ot = r.lines.find((l) => l.systemKey === "overtime")!.amount;
    const leave = r.lines.find((l) => l.systemKey === "unpaid_leave")!.amount;
    expect(ot).toBe(divRound(150_000_000n * 10n * 140n, 192n * 100n));
    expect(leave).toBe(-15_000_000n);
  });

  it("caps the insurance base and honours exemptions", () => {
    const r = computePayslip(base({ baseSalary: 900_000_000n, insured: false, taxExempt: true }), rules, DEFAULT_COMPONENTS);
    expect(r.insuranceBase).toBe(0n);
    expect(r.incomeTax).toBe(0n);
    expect(r.netPay).toBe(900_000_000n);
    const capped = computePayslip(base({ baseSalary: 900_000_000n }), rules, DEFAULT_COMPONENTS);
    expect(capped.insuranceBase).toBe(500_000_000n);
  });

  it("recovers advances partially and refuses deductions beyond gross", () => {
    const r = computePayslip(base({ advanceOwed: 10_000_000_000n }), { ...rules, taxBrackets: [] }, DEFAULT_COMPONENTS);
    expect(r.netPay).toBe(0n);
    expect(() => computePayslip(base({ items: [{ code: "LOAN", amount: 999_000_000n }] }), rules, DEFAULT_COMPONENTS)).toThrow("deductions_exceed_gross");
    expect(() => computePayslip(base({ items: [{ code: "INS_EMP", amount: 1n }] }), rules, DEFAULT_COMPONENTS)).toThrow("component_not_enterable");
  });

  it("computes a supplemental run on the cumulative month", () => {
    const first = computePayslip(base(), rules, DEFAULT_COMPONENTS);
    const prior = { ...NO_PRIOR, ...first };
    const supp = computePayslip(base({ baseSalary: 0n, items: [{ code: "BONUS", amount: 100_000_000n }] }), rules, DEFAULT_COMPONENTS, prior, { supplemental: true });
    const whole = computePayslip(base({ items: [{ code: "BONUS", amount: 100_000_000n }] }), rules, DEFAULT_COMPONENTS);
    expect(first.incomeTax + supp.incomeTax).toBe(whole.incomeTax);
    expect(first.employeeInsurance + supp.employeeInsurance).toBe(whole.employeeInsurance);
  });

  it("is exact beyond 2^53", () => {
    const big = 2n ** 60n;
    const r = computePayslip(base({ baseSalary: big, insured: false, taxExempt: true }), rules, DEFAULT_COMPONENTS);
    expect(r.netPay).toBe(big);
  });
});

describe("posting", () => {
  it("produces a balanced accrual netted per account", () => {
    const slips = [
      computePayslip(base({ items: [{ code: "LOAN", amount: 1_000_000n }] }), rules, DEFAULT_COMPONENTS),
      computePayslip(base({ commission: 2_000_000n }), rules, DEFAULT_COMPONENTS),
    ];
    const sides = accrualPostingSides(slips);
    const get = (c: string) => sides.find((s) => s.accountCode === c);
    expect(get("5200")!.debit).toBe(300_000_000n);
    expect(get("1260")!.credit).toBe(1_000_000n);
    expect(get("2470")!.credit).toBe(slips[0].incomeTax + slips[1].incomeTax);
    // 2300: net credited minus the commission reclassified out of it.
    expect(get("2300")!.credit).toBe(slips[0].netPay + slips[1].netPay - 2_000_000n);
  });
  it("guards the lifecycle", () => {
    expect(canTransition("reviewed", "approved")).toBe(true);
    expect(canTransition("approved", "calculated")).toBe(false);
    expect(canTransition("closed", "paid")).toBe(false);
  });
});

/** What a standing regular run leaves behind as `prior` for a correction. */
const priorOf = (slip: ReturnType<typeof computePayslip>, hours = 0, days = 0): PriorPeriodTotals => ({
  ...NO_PRIOR,
  insurableRaw: slip.insurableRaw,
  insuranceBase: slip.insuranceBase,
  employeeInsurance: slip.employeeInsurance,
  employerInsurance: slip.employerInsurance,
  unemploymentInsurance: slip.unemploymentInsurance,
  taxableBase: slip.taxableBase,
  incomeTax: slip.incomeTax,
  baseSalary: slip.baseSalary,
  workedDays: slip.workedDays,
  overtimeHours: hours,
  overtimeAmount: slip.lines.filter((l) => l.systemKey === "overtime").reduce((s, l) => s + l.amount, 0n),
  unpaidLeaveDays: days,
  unpaidLeaveAmount: -slip.lines.filter((l) => l.systemKey === "unpaid_leave").reduce((s, l) => s + l.amount, 0n),
});

describe("partial months", () => {
  it("counts covered days, null for the whole month, capped at the rule basis", () => {
    expect(coveredDays("2025-03-21", "2025-04-20", [{ from: null, to: null }], 30)).toBeNull();
    expect(coveredDays("2025-03-21", "2025-04-20", [{ from: "2025-04-11", to: null }], 30)).toBe(10);
    expect(coveredDays("2025-03-21", "2025-04-20", [{ from: null, to: "2025-03-30" }], 30)).toBe(10);
    // Employment and an item's own window intersect.
    expect(coveredDays("2025-03-21", "2025-04-20", [{ from: "2025-03-26", to: null }, { from: null, to: "2025-03-30" }], 30)).toBe(5);
    expect(coveredDays("2025-03-21", "2025-04-20", [{ from: "2025-05-01", to: null }], 30)).toBe(0);
    // A 31-day Jalali month missing only its first day: 30 days, the full basis.
    expect(coveredDays("2025-03-21", "2025-04-20", [{ from: "2025-03-22", to: null }], 30)).toBe(30);
  });
  it("prorates base pay and keeps a full month exact", () => {
    expect(prorate(150_000_000n, null, 30)).toBe(150_000_000n);
    expect(prorate(150_000_000n, 10, 30)).toBe(50_000_000n);
    expect(prorate(100n, 10, 30)).toBe(33n);
    const r = computePayslip(base({ workedDays: 10, insured: false, taxExempt: true }), rules, DEFAULT_COMPONENTS);
    expect(r.gross).toBe(50_000_000n);
    expect(r.workedDays).toBe(10);
    expect(() => computePayslip(base({ workedDays: 10, unpaidLeaveDays: 11 }), rules, DEFAULT_COMPONENTS)).toThrow("invalid_unpaid_leave_days");
    expect(() => computePayslip(base({ workedDays: 31 }), rules, DEFAULT_COMPONENTS)).toThrow("invalid_worked_days");
  });
});

describe("signed corrections", () => {
  const plain = { ...rules, taxBrackets: [], taxExemptMonthlyRial: 0 };
  it("reverses overtime exactly and leaves an employee debt instead of a negative net", () => {
    const first = computePayslip(base({ overtimeHours: 10, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS);
    const otPaid = first.lines.find((l) => l.systemKey === "overtime")!.amount;
    const fix = computePayslip(base({ overtimeHours: -10, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS, priorOf(first, 10), {
      supplemental: true,
    });
    expect(fix.lines.find((l) => l.systemKey === "overtime")!.amount).toBe(-otPaid);
    expect(fix.netPay).toBe(0n);
    expect(fix.employeeDebt).toBe(otPaid);
    // Cannot reverse more than was paid.
    expect(() =>
      computePayslip(base({ overtimeHours: -11 }), plain, DEFAULT_COMPONENTS, priorOf(first, 10), { supplemental: true }),
    ).toThrow("invalid_overtime_hours");
  });
  it("adds and removes unpaid leave against the days already deducted", () => {
    const first = computePayslip(base({ unpaidLeaveDays: 2, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS);
    const deducted = -first.lines.find((l) => l.systemKey === "unpaid_leave")!.amount;
    const undo = computePayslip(base({ unpaidLeaveDays: -2, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS, priorOf(first, 0, 2), {
      supplemental: true,
    });
    expect(undo.lines.find((l) => l.systemKey === "unpaid_leave")!.amount).toBe(deducted);
    expect(undo.netPay).toBe(deducted);
    expect(() =>
      computePayslip(base({ unpaidLeaveDays: -3 }), plain, DEFAULT_COMPONENTS, priorOf(first, 0, 2), { supplemental: true }),
    ).toThrow("invalid_unpaid_leave_days");
  });
  it("re-settles insurance and tax downward on the cumulative month", () => {
    const first = computePayslip(base({ items: [{ code: "BONUS", amount: 100_000_000n }] }), rules, DEFAULT_COMPONENTS);
    const fix = computePayslip(base({ items: [{ code: "BONUS", amount: -100_000_000n }] }), rules, DEFAULT_COMPONENTS, priorOf(first), {
      supplemental: true,
    });
    const plainMonth = computePayslip(base(), rules, DEFAULT_COMPONENTS);
    expect(first.incomeTax + fix.incomeTax).toBe(plainMonth.incomeTax);
    expect(first.employeeInsurance + fix.employeeInsurance).toBe(plainMonth.employeeInsurance);
    expect(fix.netPay === 0n || fix.employeeDebt === 0n).toBe(true);
    expect(fix.netPay - fix.employeeDebt).toBe(-100_000_000n - fix.incomeTax - fix.employeeInsurance);
  });
  it("needs the regular run's rate to price an hours correction", () => {
    expect(() => computePayslip(base({ overtimeHours: 1 }), rules, DEFAULT_COMPONENTS, NO_PRIOR, { supplemental: true })).toThrow("no_base_salary");
  });
  it("posts a debt to the staff receivable, balanced", () => {
    const first = computePayslip(base({ overtimeHours: 10, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS);
    const fix = computePayslip(base({ overtimeHours: -10, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS, priorOf(first, 10), {
      supplemental: true,
    });
    const sides = accrualPostingSides([fix]);
    expect(sides.find((s) => s.accountCode === "1260")!.debit).toBe(fix.employeeDebt);
    expect(sides.find((s) => s.accountCode === "5200")!.credit).toBe(fix.employeeDebt);
  });
});

describe("allocatePayslip", () => {
  it("splits every line and the net exactly, each share balancing on its own", () => {
    const slip = computePayslip(base({ baseSalary: 100_000_001n, items: [{ code: "LOAN", amount: 1_000_001n }] }), rules, DEFAULT_COMPONENTS);
    const parts = allocatePayslip(slip, [33.33, 33.33, 33.34]);
    expect(parts).toHaveLength(3);
    expect(parts.reduce((s, p) => s + p.netPay, 0n)).toBe(slip.netPay);
    for (let j = 0; j < slip.lines.length; j++) expect(parts.reduce((s, p) => s + p.lines[j].amount, 0n)).toBe(slip.lines[j].amount);
    const whole = accrualPostingSides([slip]);
    const split = parts.map((p) => accrualPostingSides([p]));
    for (const side of whole) {
      const debit = split.flat().filter((s) => s.accountCode === side.accountCode).reduce((s, x) => s + x.debit - x.credit, 0n);
      expect(debit).toBe(side.debit - side.credit);
    }
    expect(allocatePayslip(slip, [])).toEqual([slip]);
  });
  it("splits a debt as well", () => {
    const plain = { ...rules, taxBrackets: [], taxExemptMonthlyRial: 0 };
    const first = computePayslip(base({ overtimeHours: 7, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS);
    const fix = computePayslip(base({ overtimeHours: -7, insured: false, taxExempt: true }), plain, DEFAULT_COMPONENTS, priorOf(first, 7), {
      supplemental: true,
    });
    const parts = allocatePayslip(fix, [50, 50]);
    expect(parts.reduce((s, p) => s + p.employeeDebt, 0n)).toBe(fix.employeeDebt);
    expect(parts.reduce((s, p) => s + p.netPay, 0n)).toBe(0n);
  });
});
