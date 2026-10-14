/**
 * The payroll history query contract — issue #835 §9.
 *
 * `listPayrollRuns` used to return every run the business ever made, with every
 * employee line of every run, and the screen rendered all of it at once. That
 * grows for ever and it is compensation data. The history is now a bounded,
 * newest-first, keyset-paginated list:
 *
 *   - **bounded** — `limit` defaults to 20 and is clamped to 100;
 *   - **stable** — ordered by `(accrual_date, created_at, id)` descending, the
 *     last of which is unique, so two runs that share a date and an instant
 *     still have one order and a cursor can never skip or repeat a row;
 *   - **cursor, not offset** — the cursor carries the last row's own sort key,
 *     so a run created while somebody pages does not shift the next page;
 *   - **filtered** — by status, by accrual-date range and by period identity;
 *   - **lazy** — a page carries summaries only; a run's lines are fetched when
 *     its details are opened.
 *
 * The cursor is opaque to a client (base64url JSON) but strictly validated on
 * the way back in: a hand-edited one is a controlled 400, never a SQL error.
 * Pure and framework-free, so the route, the service and the tests share it.
 */
import { isValidIsoDate } from "./iso-date";
import { PayrollError } from "./payroll-errors";
import { isUuid } from "./uuid";
import type { PayrollRunStatus } from "./payroll-types";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const RUN_STATUSES: readonly PayrollRunStatus[] = ["accrued", "paid", "voided"];

export interface ListPayrollRunsOptions {
  /** 1…MAX_PAGE_SIZE; absent = DEFAULT_PAGE_SIZE; larger is clamped. */
  limit?: number | null;
  /** The `nextCursor` of the previous page. */
  cursor?: string | null;
  /** One status, or absent/`null` for all of them. */
  status?: PayrollRunStatus | null;
  /** Accrual date, inclusive, ISO `YYYY-MM-DD`. */
  from?: string | null;
  to?: string | null;
  /** A month as `YYYY-MM` or the way a person writes it (`مرداد ۱۴۰۴`) — compared by identity, not by spelling. */
  period?: string | null;
  /** Attach each run's lines (bounded by `limit`). For internal callers only; the API never sets it. */
  includeLines?: boolean;
}

/** A query problem a caller can fix — a 400 with a code the screen can translate. */
function queryError(code: "invalid_limit" | "invalid_run_status" | "invalid_date" | "invalid_cursor"): PayrollError {
  return new PayrollError(code, 400);
}

export interface RunCursor {
  /** accrual_date, `YYYY-MM-DD`. */
  d: string;
  /** created_at as Postgres prints it, microseconds and offset included. */
  c: string;
  /** The run id — the unique tie-break. */
  i: string;
}

/** `2026-10-07 11:55:24.123456+00` — what `timestamptz::text` prints. */
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursorObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw queryError("invalid_cursor");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw queryError("invalid_cursor");
  return parsed as Record<string, unknown>;
}

export function encodeRunCursor(cursor: RunCursor): string {
  return encodeCursor(cursor);
}

export function decodeRunCursor(raw: string): RunCursor {
  const { d, c, i } = decodeCursorObject(raw);
  if (!isValidIsoDate(d) || typeof c !== "string" || !PG_TIMESTAMPTZ.test(c) || !isUuid(i)) {
    throw queryError("invalid_cursor");
  }
  return { d, c, i };
}

/** The sort key of a pay-term history row: when it was written, and its id as the tie-break. */
export interface PayTermCursor {
  c: string;
  i: string;
}

export function encodePayTermCursor(cursor: PayTermCursor): string {
  return encodeCursor(cursor);
}

export function decodePayTermCursor(raw: string): PayTermCursor {
  const { c, i } = decodeCursorObject(raw);
  if (typeof c !== "string" || !PG_TIMESTAMPTZ.test(c) || !isUuid(i)) throw queryError("invalid_cursor");
  return { c, i };
}

/** The effective page size: default when absent, clamped when too big, rejected when not a positive integer. */
export function pageSize(limit: number | null | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw queryError("invalid_limit");
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * Read list options out of a URL's search params.
 *
 * An empty value (`?status=`) is "not filtering", the way a cleared filter box
 * behaves; a *malformed* one is an error rather than a silently ignored filter,
 * so a typo cannot return the unfiltered list a caller thought was filtered.
 */
export function parseListPayrollRunsQuery(params: URLSearchParams): ListPayrollRunsOptions {
  const present = (name: string): string | null => {
    const value = params.get(name);
    return value === null || value.trim() === "" ? null : value.trim();
  };

  const options: ListPayrollRunsOptions = {};

  const limit = present("limit");
  if (limit !== null) {
    if (!/^\d{1,6}$/.test(limit)) throw queryError("invalid_limit");
    options.limit = Number(limit);
  }

  const status = present("status");
  if (status !== null && status !== "all") {
    if (!RUN_STATUSES.includes(status as PayrollRunStatus)) throw queryError("invalid_run_status");
    options.status = status as PayrollRunStatus;
  }

  for (const name of ["from", "to"] as const) {
    const value = present(name);
    if (value === null) continue;
    if (!isValidIsoDate(value)) throw queryError("invalid_date");
    options[name] = value;
  }
  if (options.from && options.to && options.from > options.to) throw queryError("invalid_date");

  const period = present("period");
  if (period !== null) options.period = period;

  const cursor = present("cursor");
  if (cursor !== null) {
    decodeRunCursor(cursor); // validate now, so a bad cursor is a 400 before any SQL
    options.cursor = cursor;
  }

  return options;
}

/** `?limit=&cursor=` for a member's pay-term history — same rules, its own cursor shape. */
export function parsePayTermHistoryQuery(params: URLSearchParams): { limit?: number; cursor?: string } {
  const options: { limit?: number; cursor?: string } = {};
  const limit = params.get("limit")?.trim();
  if (limit) {
    if (!/^\d{1,6}$/.test(limit)) throw queryError("invalid_limit");
    options.limit = Number(limit);
  }
  const cursor = params.get("cursor")?.trim();
  if (cursor) {
    decodePayTermCursor(cursor);
    options.cursor = cursor;
  }
  return options;
}
