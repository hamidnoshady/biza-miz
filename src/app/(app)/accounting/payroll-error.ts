import { errorMessage } from "@/app/dashboard/ui";
import { DIMENSION_ERROR_MESSAGES } from "@/lib/accounting-dimensions";
import { PAYROLL_ERROR_MESSAGES } from "./payroll-error-messages";

/**
 * A payroll refusal in Persian: payroll's own wording first (several codes —
 * `invalid_period`, `invalid_amount`, `invalid_method` — are another domain's
 * term in the shared map), the dashboard's shared map for the rest, and the
 * generic sentence for a code nobody has worded.
 */
export function payrollError(code: string | undefined): string {
  // Issue #868 — a payroll action can carry an accounting-dimension refusal
  // (the posting policy names its codes); those keep their canonical wording.
  return PAYROLL_ERROR_MESSAGES[code ?? ""] ?? DIMENSION_ERROR_MESSAGES[code ?? ""] ?? errorMessage(code);
}
