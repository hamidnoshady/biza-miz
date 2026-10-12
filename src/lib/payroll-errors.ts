/**
 * The one error payroll raises on purpose — a stable machine code plus the HTTP
 * status the route answers with, so every refusal is a controlled 4xx the
 * screen can translate rather than a raw database failure.
 *
 * Its own module so the pure helpers (period identity, history query,
 * gross-to-net settings) can throw it without importing the service, and with
 * it `pg`.
 */
export class PayrollError extends Error {
  status: number;
  /**
   * Fields the route returns beside `{ error }` — e.g. the run that blocked a
   * duplicate period, so the screen can name it instead of guessing; or the
   * `field` that failed (a settings key, or the member whose deductions exceed
   * their gross pay).
   */
  details?: Record<string, unknown>;
  /**
   * `details` may be a string, which is shorthand for `{ field: <string> }` —
   * the common case of «this input is the one that was refused».
   */
  constructor(code: string, status = 400, details?: Record<string, unknown> | string) {
    super(code);
    this.status = status;
    this.details = typeof details === "string" ? { field: details } : details;
  }
}
