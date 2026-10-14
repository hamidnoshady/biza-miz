import type { PayTerm } from "@/lib/payroll-types";

/**
 * The four standing terms a member's pay is built from, as the screen names
 * them — in the order it lists them, and the order the history reads.
 */
export const TERM_LABELS: Record<PayTerm, string> = {
  monthlyWage: "حقوق پایه ماهانه",
  taxableAllowance: "مزایای مشمول مالیات",
  nonTaxableAllowance: "مزایای غیرمشمول",
  fixedDeduction: "سایر کسور ثابت",
};
