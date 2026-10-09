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

/** Keys a client may attach to a create request: printable ASCII, no spaces, 8–128 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;

/**
 * The idempotency key of a payroll create request — the #835 accrual and the
 * #865 engine run share this one rule. Absent/blank = none; anything else that
 * is not a printable 8–128 character key is refused.
 */
export function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PayrollError("idempotency_key_invalid");
  const key = value.trim();
  if (key === "") return null;
  if (!IDEMPOTENCY_KEY.test(key)) throw new PayrollError("idempotency_key_invalid");
  return key;
}
