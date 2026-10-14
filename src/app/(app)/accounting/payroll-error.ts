import { errorMessage } from "@/app/dashboard/ui";
import { PAYROLL_ERROR_MESSAGES } from "./payroll-error-messages";

/**
 * A payroll refusal in Persian: payroll's own wording first (several codes —
 * `invalid_period`, `invalid_amount`, `invalid_method` — are another domain's
 * term in the shared map), the dashboard's shared map for the rest, and the
 * generic sentence for a code nobody has worded.
 */
export function payrollError(code: string | undefined): string {
  return PAYROLL_ERROR_MESSAGES[code ?? ""] ?? errorMessage(code);
}
