import { describe, expect, it } from "vitest";
import {
  accrualPostingSides,
  allocateExact,
  canTransition,
  computePayslip,
  DEFAULT_COMPONENTS,
  divRound,
  IRAN_RULE_TEMPLATE,
  NO_PRIOR,
  parsePayrollRuleSet,
  progressiveTax,
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
