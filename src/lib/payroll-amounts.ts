/**
 * How payroll reads an amount a client sent — issue #835 §3 and §10.
 *
 * An amount arrives as a JSON number (exact only up to 2^53 − 1) or as integer
 * text (exact at any size the ledger holds). Nothing else is an amount: not
 * `true`, not `[]`, not `""`, not `"1.5"` — those used to be coerced by
 * `Number(...)` into 1, 0 and 0 and quietly saved. And nothing is ever turned
 * into a `Number` on the way in: the result is a `bigint`, exact.
 *
 * Pure and framework-free; the service, the advances service and the tests share
 * it, so a wage, an allowance, an overtime figure and an advance are all
 * refused for the same reasons with the same two codes:
 *
 *   - `invalid_amount`      — not a non-negative whole amount;
 *   - `amount_out_of_range` — a whole amount the `bigint` column cannot hold.
 */
import { boundedRialText } from "./inventory-exact";
import { PayrollError } from "./payroll-errors";

export function parseRialInput(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new PayrollError("invalid_amount");
    return BigInt(value);
  }
  if (typeof value === "string") {
    try {
      return BigInt(boundedRialText(value));
    } catch (err) {
      throw new PayrollError(err instanceof Error && err.message === "rial_out_of_range" ? "amount_out_of_range" : "invalid_amount");
    }
  }
  throw new PayrollError("invalid_amount");
}
