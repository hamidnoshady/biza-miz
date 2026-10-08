import { describe, expect, it } from "vitest";
import {
  applyBasisPoints,
  computeGrossToNet,
  EMPTY_PAYROLL_SETTINGS,
  MAX_TAX_BRACKETS,
  parsePayrollSettings,
  payrollAccrualTotals,
  payrollSettingsApplyDeductions,
  percentToBasisPoints,
  progressiveIncomeTax,
  type GrossToNetBreakdown,
  type PayrollSettings,
} from "./payroll-gross-to-net";

/** Rates a business might enter — fixtures, not statutory figures this code assumes. */
const SETTINGS: PayrollSettings = {
  employeeInsurancePercent: 7,
  employerInsurancePercent: 20,
  unemploymentInsurancePercent: 3,
  insuranceCeilingRial: null,
  nonTaxableAllowancesInsurable: false,
  deductEmployeeInsuranceFromTaxable: true,
  taxExemptThresholdRial: 100_000_000,
  taxBrackets: [
    { upToRial: 140_000_000, ratePercent: 10 },
    { upToRial: 230_000_000, ratePercent: 15 },
    { upToRial: null, ratePercent: 20 },
  ],
};

function ok(result: ReturnType<typeof computeGrossToNet>): GrossToNetBreakdown {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result;
}

describe("parsePayrollSettings", () => {
  it("treats a missing document as nothing entered", () => {
    const parsed = parsePayrollSettings(null);
    expect(parsed).toEqual({ ok: true, value: EMPTY_PAYROLL_SETTINGS });
    expect(payrollSettingsApplyDeductions(EMPTY_PAYROLL_SETTINGS)).toBe(false);
  });

  it("treats empty fields as not applied", () => {
    const parsed = parsePayrollSettings({ employeeInsurancePercent: "", insuranceCeilingRial: null, taxBrackets: [] });
    expect(parsed.ok && parsed.value).toEqual(EMPTY_PAYROLL_SETTINGS);
  });

  it("accepts a full document and keeps it", () => {
    const parsed = parsePayrollSettings(SETTINGS);
    expect(parsed).toEqual({ ok: true, value: SETTINGS });
    expect(payrollSettingsApplyDeductions(SETTINGS)).toBe(true);
  });

  it("drops unknown keys", () => {
    const parsed = parsePayrollSettings({ ...SETTINGS, statutoryRate: 99 });
    expect(parsed.ok && "statutoryRate" in parsed.value).toBe(false);
  });

  it.each([-1, 100.01, 7.123, Number.NaN, "7"])("refuses the percent %s", (value) => {
    expect(parsePayrollSettings({ employeeInsurancePercent: value })).toMatchObject({
      ok: false,
      error: "invalid_percent",
      field: "employeeInsurancePercent",
    });
  });

  it("accepts a two-decimal percent", () => {
    const parsed = parsePayrollSettings({ employerInsurancePercent: 23.25 });
    expect(parsed.ok && parsed.value.employerInsurancePercent).toBe(23.25);
  });

  it.each([-5, 1.5, "100"])("refuses the ceiling %s", (value) => {
    expect(parsePayrollSettings({ insuranceCeilingRial: value })).toMatchObject({ ok: false, error: "invalid_amount" });
  });

  it("refuses a non-boolean flag", () => {
    expect(parsePayrollSettings({ deductEmployeeInsuranceFromTaxable: "yes" })).toMatchObject({ ok: false });
  });

  it("requires the last bracket to be open-ended, and only the last", () => {
    expect(parsePayrollSettings({ taxBrackets: [{ upToRial: 10, ratePercent: 10 }] })).toMatchObject({
      error: "last_bracket_must_be_open",
    });
    expect(
      parsePayrollSettings({
        taxBrackets: [
          { upToRial: null, ratePercent: 10 },
          { upToRial: null, ratePercent: 20 },
        ],
      }),
    ).toMatchObject({ error: "last_bracket_must_be_open" });
  });

  it("requires ascending bounds above the exempt threshold", () => {
    expect(
      parsePayrollSettings({
        taxBrackets: [
          { upToRial: 200, ratePercent: 10 },
          { upToRial: 100, ratePercent: 15 },
          { upToRial: null, ratePercent: 20 },
        ],
      }),
    ).toMatchObject({ error: "brackets_not_ascending" });
    expect(
      parsePayrollSettings({
        taxExemptThresholdRial: 500,
        taxBrackets: [
          { upToRial: 400, ratePercent: 10 },
          { upToRial: null, ratePercent: 20 },
        ],
      }),
    ).toMatchObject({ error: "brackets_not_ascending" });
  });

  it("caps the number of brackets", () => {
    const brackets = Array.from({ length: MAX_TAX_BRACKETS + 1 }, (_, i) => ({
      upToRial: i === MAX_TAX_BRACKETS ? null : (i + 1) * 1000,
      ratePercent: 1,
    }));
    expect(parsePayrollSettings({ taxBrackets: brackets })).toMatchObject({ error: "too_many_brackets" });
  });

  it("refuses a non-object document", () => {
    expect(parsePayrollSettings([1, 2])).toMatchObject({ ok: false, error: "invalid_settings" });
    expect(parsePayrollSettings("x")).toMatchObject({ ok: false, error: "invalid_settings" });
  });
});

describe("basis points", () => {
  it("converts two-decimal percents exactly", () => {
    expect(percentToBasisPoints(7)).toBe(700n);
    expect(percentToBasisPoints(1.15)).toBe(115n);
    expect(percentToBasisPoints(null)).toBe(0n);
  });

  it("rounds half-up", () => {
    expect(applyBasisPoints(15n, 700n)).toBe(1n); // 1.05 → 1
    expect(applyBasisPoints(50n, 700n)).toBe(4n); // 3.5 → 4
    expect(applyBasisPoints(49n, 700n)).toBe(3n); // 3.43 → 3
  });

  it("stays exact beyond Number's safe range", () => {
    const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(applyBasisPoints(big, 10_000n)).toBe(big);
  });
});

describe("progressiveIncomeTax", () => {
  const brackets = SETTINGS.taxBrackets;

  it("is zero at or under the exempt threshold", () => {
    expect(progressiveIncomeTax(100_000_000n, brackets, 100_000_000)).toBe(0n);
    expect(progressiveIncomeTax(0n, brackets, 100_000_000)).toBe(0n);
  });

  it("taxes only the slice above the threshold within the first band", () => {
    // 120M: (120M − 100M) × 10% = 2M
    expect(progressiveIncomeTax(120_000_000n, brackets, 100_000_000)).toBe(2_000_000n);
  });

  it("walks every band up to the open one", () => {
    // 300M: 40M×10% + 90M×15% + 70M×20% = 4M + 13.5M + 14M = 31.5M
    expect(progressiveIncomeTax(300_000_000n, brackets, 100_000_000)).toBe(31_500_000n);
  });

  it("stops exactly at a band boundary", () => {
    // 230M: 40M×10% + 90M×15% = 17.5M
    expect(progressiveIncomeTax(230_000_000n, brackets, 100_000_000)).toBe(17_500_000n);
  });

  it("rounds the sum once rather than per band", () => {
    // Bands: 0–3 at 10%, 3–∞ at 15%. Income 6: 0.3 + 0.45 = 0.75 → 1, where
    // rounding each band separately would give 0 + 0 = 0.
    const b = [
      { upToRial: 3, ratePercent: 10 },
      { upToRial: null, ratePercent: 15 },
    ];
    expect(progressiveIncomeTax(6n, b, null)).toBe(1n);
  });

  it("is zero with no brackets, whatever the threshold", () => {
    expect(progressiveIncomeTax(500_000_000n, [], 100)).toBe(0n);
  });

  it("taxes from zero when there is no threshold", () => {
    expect(progressiveIncomeTax(1_000n, [{ upToRial: null, ratePercent: 10 }], null)).toBe(100n);
  });
});

describe("computeGrossToNet", () => {
  it("with nothing configured, gross equals net and the employer pays gross", () => {
    const r = ok(
      computeGrossToNet(
        { baseSalaryRial: 150_000_000, taxableAllowancesRial: 20_000_000, nonTaxableAllowancesRial: 10_000_000, overtimeRial: 5_000_000 },
        EMPTY_PAYROLL_SETTINGS,
      ),
    );
    expect(r.grossRial).toBe(185_000_000);
    expect(r.netPayRial).toBe(185_000_000);
    expect(r.employerCostRial).toBe(185_000_000);
    expect(r.employeeInsuranceRial + r.employerInsuranceRial + r.incomeTaxRial).toBe(0);
  });

  it("computes the full breakdown to the Rial", () => {
    const r = ok(
      computeGrossToNet(
        {
          baseSalaryRial: 200_000_000,
          taxableAllowancesRial: 30_000_000,
          nonTaxableAllowancesRial: 15_000_000,
          overtimeRial: 10_000_000,
          advanceOutstandingRial: 5_000_000,
          otherDeductionsRial: 2_000_000,
        },
        SETTINGS,
      ),
    );
    // insurance base = 200 + 10 + 30 = 240M (non-taxable not insurable)
    expect(r.grossRial).toBe(255_000_000);
    expect(r.insuranceBaseRial).toBe(240_000_000);
    expect(r.employeeInsuranceRial).toBe(16_800_000);
    expect(r.employerInsuranceRial).toBe(48_000_000);
    expect(r.unemploymentInsuranceRial).toBe(7_200_000);
    // taxable = 240M − 16.8M = 223.2M → 40M×10% + 83.2M×15% = 4M + 12.48M = 16.48M
    expect(r.taxableIncomeRial).toBe(223_200_000);
    expect(r.incomeTaxRial).toBe(16_480_000);
    expect(r.otherDeductionsRial).toBe(2_000_000);
    expect(r.advanceRecoveryRial).toBe(5_000_000);
    expect(r.advanceCarriedRial).toBe(0);
    expect(r.netPayRial).toBe(255_000_000 - 16_800_000 - 16_480_000 - 2_000_000 - 5_000_000);
    expect(r.employerCostRial).toBe(255_000_000 + 48_000_000 + 7_200_000);
  });

  it("caps the insurance base at the ceiling", () => {
    const r = ok(
      computeGrossToNet({ baseSalaryRial: 500_000_000 }, { ...SETTINGS, insuranceCeilingRial: 300_000_000 }),
    );
    expect(r.insuranceBaseRial).toBe(300_000_000);
    expect(r.employeeInsuranceRial).toBe(21_000_000);
    expect(r.employerInsuranceRial).toBe(60_000_000);
    // taxable income is not capped
    expect(r.taxableIncomeRial).toBe(500_000_000 - 21_000_000);
  });

  it("insures non-taxable allowances only when the business says so", () => {
    const input = { baseSalaryRial: 100_000_000, nonTaxableAllowancesRial: 20_000_000 };
    expect(ok(computeGrossToNet(input, SETTINGS)).insuranceBaseRial).toBe(100_000_000);
    expect(ok(computeGrossToNet(input, { ...SETTINGS, nonTaxableAllowancesInsurable: true })).insuranceBaseRial).toBe(
      120_000_000,
    );
  });

  it("keeps non-taxable allowances out of taxable income", () => {
    const r = ok(computeGrossToNet({ baseSalaryRial: 100_000_000, nonTaxableAllowancesRial: 50_000_000 }, {
      ...SETTINGS,
      employeeInsurancePercent: null,
    }));
    expect(r.taxableIncomeRial).toBe(100_000_000);
    expect(r.incomeTaxRial).toBe(0);
  });

  it("deducts the employee's insurance before tax only when the business says so", () => {
    const withDeduction = ok(computeGrossToNet({ baseSalaryRial: 200_000_000 }, SETTINGS));
    const without = ok(computeGrossToNet({ baseSalaryRial: 200_000_000 }, { ...SETTINGS, deductEmployeeInsuranceFromTaxable: false }));
    expect(withDeduction.taxableIncomeRial).toBe(186_000_000);
    expect(without.taxableIncomeRial).toBe(200_000_000);
    expect(without.incomeTaxRial).toBeGreaterThan(withDeduction.incomeTaxRial);
  });

  it("recovers an advance only up to the remaining pay and carries the rest", () => {
    const r = ok(
      computeGrossToNet({ baseSalaryRial: 10_000_000, advanceOutstandingRial: 25_000_000 }, EMPTY_PAYROLL_SETTINGS),
    );
    expect(r.advanceRecoveryRial).toBe(10_000_000);
    expect(r.advanceCarriedRial).toBe(15_000_000);
    expect(r.netPayRial).toBe(0);
  });

  it("refuses a month whose fixed deductions exceed gross", () => {
    expect(
      computeGrossToNet({ baseSalaryRial: 10_000_000, otherDeductionsRial: 10_000_001 }, EMPTY_PAYROLL_SETTINGS),
    ).toEqual({ ok: false, error: "deductions_exceed_gross" });
  });

  it.each([-1, 1.5, Number.NaN])("refuses the amount %s", (value) => {
    expect(computeGrossToNet({ baseSalaryRial: value }, EMPTY_PAYROLL_SETTINGS)).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    expect(computeGrossToNet({ baseSalaryRial: 1, overtimeRial: value }, EMPTY_PAYROLL_SETTINGS)).toEqual({
      ok: false,
      error: "invalid_amount",
    });
  });

  it("rounds each insurance figure half-up", () => {
    // base 15 Rial × 7% = 1.05 → 1; × 20% = 3; × 3.5% = 0.525 → 1
    const r = ok(
      computeGrossToNet({ baseSalaryRial: 15 }, { ...EMPTY_PAYROLL_SETTINGS, employeeInsurancePercent: 7, employerInsurancePercent: 20, unemploymentInsurancePercent: 3.5 }),
    );
    expect([r.employeeInsuranceRial, r.employerInsuranceRial, r.unemploymentInsuranceRial]).toEqual([1, 3, 1]);
  });

  it("satisfies gross = net + every employee-side deduction for any input", () => {
    for (let base = 0; base < 3_000_000; base += 77_777) {
      const r = ok(
        computeGrossToNet(
          { baseSalaryRial: base, taxableAllowancesRial: 1_234, overtimeRial: 9_999, advanceOutstandingRial: 50_001 },
          { ...SETTINGS, taxExemptThresholdRial: 1_000_000, taxBrackets: [{ upToRial: 2_000_000, ratePercent: 10.5 }, { upToRial: null, ratePercent: 33.33 }] },
        ),
      );
      expect(r.netPayRial + r.employeeInsuranceRial + r.incomeTaxRial + r.otherDeductionsRial + r.advanceRecoveryRial).toBe(
        r.grossRial,
      );
      expect(r.netPayRial).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("payrollAccrualTotals", () => {
  it("sums lines into a balanced journal", () => {
    const lines = [
      ok(computeGrossToNet({ baseSalaryRial: 200_000_000, advanceOutstandingRial: 3_000_000, otherDeductionsRial: 1_000_000 }, SETTINGS)),
      ok(computeGrossToNet({ baseSalaryRial: 120_000_000, overtimeRial: 7_777_777 }, SETTINGS)),
    ];
    const t = payrollAccrualTotals(lines);
    const debits = t.grossRial + t.employerInsuranceExpenseRial;
    const credits =
      t.netPayableRial + t.insurancePayableRial + t.incomeTaxPayableRial + t.advanceRecoveryRial + t.otherDeductionsPayableRial;
    expect(debits).toBe(credits);
    expect(t.advanceRecoveryRial).toBe(3_000_000);
    expect(t.otherDeductionsPayableRial).toBe(1_000_000);
  });

  it("with nothing configured, is gross on both sides", () => {
    const t = payrollAccrualTotals([ok(computeGrossToNet({ baseSalaryRial: 50_000_000 }, EMPTY_PAYROLL_SETTINGS))]);
    expect(t).toEqual({
      grossRial: 50_000_000,
      employerInsuranceExpenseRial: 0,
      netPayableRial: 50_000_000,
      insurancePayableRial: 0,
      incomeTaxPayableRial: 0,
      advanceRecoveryRial: 0,
      otherDeductionsPayableRial: 0,
    });
  });
});
