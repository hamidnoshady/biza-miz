/**
 * What the payroll routes share: reading a JSON body strictly, and turning a
 * refusal into the one response shape the screen translates.
 *
 * Five routes each carried their own copy of both, and the copies drifted — a
 * body of `null` or `[]` parsed fine and then threw a `TypeError` on the first
 * property access (a 500 where a 400 belongs), and only some routes knew the
 * fiscal-lock codes. One place means a new refusal reaches every route.
 */
import { NextResponse } from "next/server";
import { fiscalPeriodLockErrorCode } from "./fiscal-periods";
import { MissingLedgerAccountError } from "./ledger-service";
import { PayrollError } from "./payroll-errors";

export type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request body as a JSON object, or `null` when it is not one (malformed
 * JSON, `null`, an array, a string, a number). An *empty* body is `{}` when
 * `emptyIsObject` — for the endpoints whose body is optional.
 */
export async function readJsonObject(
  request: Request,
  options: { emptyIsObject?: boolean } = {},
): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return options.emptyIsObject ? {} : null;
  try {
    const body: unknown = JSON.parse(text);
    return isPlainObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** `{ error: "bad_request" }` — a body that is not a JSON object at all. */
export function badRequest(code = "bad_request"): NextResponse {
  return NextResponse.json({ error: code }, { status: 400 });
}

/**
 * The response for a refusal payroll raised on purpose — a `PayrollError`, a
 * missing system account, a fiscal-period lock — or `null` for anything else,
 * which the caller must rethrow (an unexpected failure is not a 4xx).
 */
export function payrollErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof PayrollError) {
    return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  const lockCode = fiscalPeriodLockErrorCode(err);
  if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
  return null;
}
