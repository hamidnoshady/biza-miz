/**
 * The one error the commission settlement lifecycle raises on purpose — a stable
 * machine code plus the HTTP status the route answers with (issue #869).
 *
 * Its own module, like `payroll-errors.ts`, so the pure planners can throw it
 * without importing the database service, and the screen can translate every
 * refusal instead of showing a bare code.
 */
export class CommissionSettlementError extends Error {
  status: number;
  /** Fields the route returns beside `{ error }` (the run, the member, the amount that was refused). */
  details?: Record<string, unknown>;

  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.name = "CommissionSettlementError";
    this.status = status;
    this.details = details;
  }
}

export function isCommissionSettlementError(err: unknown): err is CommissionSettlementError {
  return err instanceof CommissionSettlementError;
}
