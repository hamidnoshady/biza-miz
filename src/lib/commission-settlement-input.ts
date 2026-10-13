/**
 * Reading the request bodies and query strings of the settlement API (issue #869),
 * strictly: a value the service would have to guess at is refused here with the
 * code the screen translates, never coerced into something plausible.
 *
 * Money arrives as integer Rial, as a digit string or a safe integer. Dates
 * arrive as `YYYY-MM-DD` (Gregorian storage; the screen shows Shamsi).
 */
import { isValidIsoDate } from "./iso-date";
import { CommissionSettlementError } from "./commission-settlement-errors";
import { MAX_RUN_NOTE_LENGTH, isCommissionRunStatus, type CommissionRunStatus } from "./commission-settlement-lifecycle";
import type { AllocationRequest } from "./commission-settlement-payout";

export type JsonObject = Record<string, unknown>;

/** Above any sum a business will ever settle, and well inside the bigint columns. */
export const MAX_SETTLEMENT_AMOUNT = 999_999_999_999_999n;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The same printable-ASCII shape the payroll keys use. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const MAX_TITLE_LENGTH = 120;
const MAX_EMPLOYEES_PER_RUN = 200;
const MAX_ALLOCATIONS_PER_PAYOUT = 500;

export const MAX_LIST_LIMIT = 200;
export const MAX_LINES_LIMIT = 500;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A body that is not a plain JSON object is refused before any field is read. */
export function requireObject(body: unknown): JsonObject {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CommissionSettlementError("bad_request", 400);
  }
  return body as JsonObject;
}

/** Integer Rial from a digit string or a safe integer, strictly positive and within the storage bound. */
export function parseRialAmount(value: unknown, code = "invalid_amount"): bigint {
  let parsed: bigint | null = null;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^\d{1,16}$/.test(value.trim())) {
    parsed = BigInt(value.trim());
  }
  if (parsed === null || parsed <= 0n || parsed > MAX_SETTLEMENT_AMOUNT) {
    throw new CommissionSettlementError(code, 400);
  }
  return parsed;
}

function optionalString(value: unknown, maxLength: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CommissionSettlementError(code, 400);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > maxLength) throw new CommissionSettlementError(code, 400);
  return trimmed;
}

function optionalUuid(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isUuid(value)) throw new CommissionSettlementError(code, 400);
  return value.toLowerCase();
}

export interface CreateRunInput {
  periodFrom: string;
  periodTo: string;
  locationId: string | null;
  employeeIds: string[];
  title: string | null;
}

export function parseCreateRunBody(body: unknown): CreateRunInput {
  const input = requireObject(body);
  if (!isValidIsoDate(input.periodFrom)) throw new CommissionSettlementError("invalid_period", 400, { field: "periodFrom" });
  if (!isValidIsoDate(input.periodTo)) throw new CommissionSettlementError("invalid_period", 400, { field: "periodTo" });
  if (input.periodFrom > input.periodTo) throw new CommissionSettlementError("invalid_period_range", 400);

  let employeeIds: string[] = [];
  if (input.employeeIds !== undefined && input.employeeIds !== null) {
    if (!Array.isArray(input.employeeIds) || input.employeeIds.length > MAX_EMPLOYEES_PER_RUN) {
      throw new CommissionSettlementError("invalid_employee_ids", 400);
    }
    const ids = input.employeeIds.map((id) => {
      if (!isUuid(id)) throw new CommissionSettlementError("invalid_employee_ids", 400);
      return id.toLowerCase();
    });
    if (new Set(ids).size !== ids.length) throw new CommissionSettlementError("invalid_employee_ids", 400);
    employeeIds = ids.sort();
  }

  return {
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    locationId: optionalUuid(input.locationId, "invalid_location"),
    employeeIds,
    title: optionalString(input.title, MAX_TITLE_LENGTH, "invalid_title"),
  };
}

export interface PayoutInput {
  allocations: AllocationRequest[];
  paymentAccountId: string | null;
  method: "cash" | "bank" | null;
  paidDate: string | null;
  memo: string | null;
}

export function parsePayoutBody(body: unknown): PayoutInput {
  const input = requireObject(body);
  if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
    throw new CommissionSettlementError("no_allocations", 400);
  }
  if (input.allocations.length > MAX_ALLOCATIONS_PER_PAYOUT) {
    throw new CommissionSettlementError("invalid_allocations", 400);
  }
  const allocations: AllocationRequest[] = input.allocations.map((raw) => {
    const row = requireObject(raw);
    if (!isUuid(row.employeeId)) throw new CommissionSettlementError("invalid_allocations", 400);
    const employeeId = row.employeeId.toLowerCase();
    // `all: true` pays what the member is still owed in this run, resolved on the server.
    if (row.all === true) return { employeeId, amount: null };
    return { employeeId, amount: parseRialAmount(row.amount) };
  });

  const paymentAccountId = optionalUuid(input.paymentAccountId, "invalid_payment_account");
  let method: "cash" | "bank" | null = null;
  if (input.method !== undefined && input.method !== null && input.method !== "") {
    if (input.method !== "cash" && input.method !== "bank") throw new CommissionSettlementError("invalid_method", 400);
    method = input.method;
  }
  // The money has to leave somewhere a person can name: an explicit account, or a method.
  if (paymentAccountId === null && method === null) throw new CommissionSettlementError("invalid_method", 400);

  let paidDate: string | null = null;
  if (input.paidDate !== undefined && input.paidDate !== null && input.paidDate !== "") {
    if (!isValidIsoDate(input.paidDate)) throw new CommissionSettlementError("invalid_paid_date", 400);
    paidDate = input.paidDate;
  }

  return {
    allocations,
    paymentAccountId,
    method,
    paidDate,
    memo: optionalString(input.memo, MAX_RUN_NOTE_LENGTH, "note_too_long"),
  };
}

/** The optional note a review, approval, release or close may carry. */
export function parseNoteBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  const input = requireObject(body);
  return optionalString(input.note, MAX_RUN_NOTE_LENGTH, "note_too_long");
}

/** A void needs a reason on the record: a run is never voided silently. */
export function parseVoidBody(body: unknown): string {
  const reason = parseNoteBody(body);
  if (reason === null) throw new CommissionSettlementError("void_reason_required", 400);
  return reason;
}

/** The idempotency key from the header, or the body when the header is absent. A disagreement is refused. */
export function parseIdempotencyKey(headerValue: string | null, bodyValue: unknown): string | null {
  if (bodyValue !== undefined && bodyValue !== null && typeof bodyValue !== "string") {
    throw new CommissionSettlementError("idempotency_key_invalid", 400);
  }
  const header = headerValue === null ? null : headerValue.trim();
  const body = typeof bodyValue === "string" ? bodyValue.trim() : null;
  if (header !== null && body !== null && header !== body) {
    throw new CommissionSettlementError("idempotency_key_invalid", 400);
  }
  const key = header ?? body;
  if (key === null || key === "") return null;
  if (!IDEMPOTENCY_KEY.test(key)) throw new CommissionSettlementError("idempotency_key_invalid", 400);
  return key;
}

export interface RunListQuery {
  status: CommissionRunStatus | null;
  limit: number;
  offset: number;
  format: "json" | "csv";
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number, code: string): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new CommissionSettlementError(code, 400);
  const value = Number(raw);
  if (value < min || value > max) throw new CommissionSettlementError(code, 400);
  return value;
}

function formatParam(raw: string | null): "json" | "csv" {
  if (raw === null || raw === "" || raw === "json") return "json";
  if (raw === "csv") return "csv";
  throw new CommissionSettlementError("invalid_format", 400);
}

export function parseRunListQuery(params: URLSearchParams): RunListQuery {
  const raw = params.get("status");
  let status: CommissionRunStatus | null = null;
  if (raw !== null && raw !== "") {
    if (!isCommissionRunStatus(raw)) throw new CommissionSettlementError("invalid_run_status", 400);
    status = raw;
  }
  return {
    status,
    limit: boundedInt(params.get("limit"), 50, 1, MAX_LIST_LIMIT, "invalid_limit"),
    offset: boundedInt(params.get("offset"), 0, 0, 1_000_000, "invalid_offset"),
    format: formatParam(params.get("format")),
  };
}

export interface RunLinesQuery {
  employeeId: string | null;
  limit: number;
  offset: number;
  format: "json" | "csv";
}

export function parseRunLinesQuery(params: URLSearchParams): RunLinesQuery {
  const employee = params.get("employeeId");
  if (employee !== null && employee !== "" && !isUuid(employee)) {
    throw new CommissionSettlementError("invalid_employee", 400);
  }
  return {
    employeeId: employee && employee !== "" ? employee.toLowerCase() : null,
    limit: boundedInt(params.get("limit"), 100, 1, MAX_LINES_LIMIT, "invalid_limit"),
    offset: boundedInt(params.get("offset"), 0, 0, 1_000_000, "invalid_offset"),
    format: formatParam(params.get("format")),
  };
}

export function parseEmployeeParam(params: URLSearchParams): string {
  const employee = params.get("employeeId");
  if (!isUuid(employee)) throw new CommissionSettlementError("employee_required", 400);
  return employee.toLowerCase();
}
