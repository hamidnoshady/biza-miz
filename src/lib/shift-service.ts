/**
 * Phase 20 Wave 5 — shift tracking: the DB-touching half (not unit-tested
 * directly, per repo convention — see employee-service.ts's header for why;
 * the pure rules it uses live in shift.ts and are covered by shift.test.ts).
 *
 * A shift's location_id/device_id are copied from the employee_sessions row
 * open at the moment it starts, not re-resolved from a device token — see
 * migration 0045's header for why that's the right source. Cash sales for a
 * shift are read back on demand from orders/payments by (closed_by, time
 * window), the same join v_shift_reconciliation (Phase 8) already does per
 * business-day — no new column on orders, no change to order-service.ts.
 */
import { getBusinessDayStatus, type BusinessDayStatus } from "./business-day-service";
import { getPool, query } from "./db";
import { postgresDateToIso } from "./jalali";
import { reconcileCash } from "./shift";
import type { Role } from "./auth";
import { recordShiftSyncEvent } from "./shift-sync";
import { isUuid } from "./uuid";
// Phase 32 — the coworker's event queue. Enqueued, never acted on here: a
// cashier clocking in or out is a foreground request and must not wait on (or
// fail because of) a background job. `recordCoworkerEvent` swallows its own
// errors for the same reason.
import { recordCoworkerEvent } from "./ai-coworker-events";
// Phase 35 — notifications, queued for the same reason and with the same
// contract: `recordNotification` swallows its own errors, so a shift can never
// fail to close because nobody could be told about it.
import { recordNotification } from "./notification-events";
import { cashVarianceText, notificationDedupeKey } from "./notifications";
import { tomanText } from "./ai-labels";

export class ShiftError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/**
 * Who the notification is about, by name.
 *
 * A push notification is read on a lock screen with no way to ask a follow-up
 * question, so «شیفت بسته شد» alone is not worth sending — the owner's next
 * question is always "whose".
 */
async function employeeName(businessId: string, employeeId: string): Promise<string> {
  const { rows } = await query<{ full_name: string | null }>(
    `SELECT full_name FROM users WHERE id = $1 AND business_id = $2`,
    [employeeId, businessId],
  );
  return rows[0]?.full_name?.trim() || "کارمند";
}

async function auditShift(
  businessId: string,
  actorId: string | null,
  action: string,
  shiftId: string,
  payload?: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'shift', $4, $5)`,
    [businessId, actorId, action, shiftId, JSON.stringify(payload ?? null)],
  );
}

export interface ShiftCashSummary {
  orderCount: number;
  grossTotal: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
}

interface CashSummaryRow extends Record<string, unknown> {
  order_count: string;
  gross_total: string;
  cash_total: string;
  card_total: string;
  online_total: string;
  credit_total: string;
}

function toCashSummary(row: CashSummaryRow | undefined): ShiftCashSummary {
  return {
    orderCount: Number(row?.order_count ?? 0),
    grossTotal: Number(row?.gross_total ?? 0),
    cashTotal: Number(row?.cash_total ?? 0),
    cardTotal: Number(row?.card_total ?? 0),
    onlineTotal: Number(row?.online_total ?? 0),
    creditTotal: Number(row?.credit_total ?? 0),
  };
}

/**
 * A shift's cash summary, as one SELECT over the orders matching `predicate`.
 *
 * `predicate` is the window — it may reference the outer row (`s.employee_id`,
 * `s.started_at`) when this is embedded in a LATERAL join, or bind parameters
 * when it stands alone — and both callers share it so `shiftCashSummary` (one
 * shift's own `[from, to]`) and `listShifts`'s per-row join (Wave 7 — every
 * shift's window at once) cannot drift apart.
 *
 * The orders and the payments are counted **separately**, never across one
 * `orders LEFT JOIN payments`. That join produces one row per payment, so an
 * order settled in two tenders — a split cash/card bill, or the re-settlement a
 * closed-order amendment writes — was counted once by `count(DISTINCT o.id)`
 * but summed twice by `sum(o.total)`: every such shift reported a gross total
 * larger than it had sold, and the more the branch split bills the further out
 * it was. `branchShiftSales` below already avoided this deliberately (see its
 * comment); the two per-shift readings did not, which is why they are built
 * from this one fragment now.
 *
 * The per-method totals stay `sum(p.amount) FILTER (…)` because a payment row
 * *is* the unit there — two tenders on one bill are two real amounts.
 */
function cashSummarySelect(predicate: string): string {
  const windowOrders = `SELECT o.id, o.total FROM orders o WHERE ${predicate}`;
  return `
    SELECT
      (SELECT count(*) FROM (${windowOrders}) wo)                                  AS order_count,
      (SELECT coalesce(sum(wo.total), 0) FROM (${windowOrders}) wo)                AS gross_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)                  AS cash_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)                AS online_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)                AS credit_total
      FROM payments p
     WHERE p.order_id IN (SELECT wo.id FROM (${windowOrders}) wo)
  `;
}

/**
 * The window a shift's *cash* is judged by: what this employee closed while
 * they were clocked in. Deliberately `closed_by`/`closed_at` rather than the
 * `opened_at` rule the shift's *order list* uses (see CLAUDE.md) — the drawer
 * count has to reconcile against money this person actually took.
 */
const SHIFT_CASH_WINDOW = (from: string, to: string, employee: string) =>
  `o.closed_by = ${employee} AND o.status = 'completed' AND o.closed_at BETWEEN ${from} AND ${to}`;

/** Exported for `shift-service-sql.test.ts`: the shape above is the thing worth pinning, not the rows. */
export const SHIFT_CASH_SUMMARY_SQL = cashSummarySelect(SHIFT_CASH_WINDOW("$2", "$3", "$1"));

/**
 * Every completed order this employee closed between `from` and `to`,
 * reconciled by payment method — the same shape v_shift_reconciliation
 * (Phase 8) computes per business-day, narrowed here to one shift's own
 * window instead.
 */
export async function shiftCashSummary(
  employeeId: string,
  from: Date | string,
  to: Date | string,
): Promise<ShiftCashSummary> {
  const { rows } = await query<CashSummaryRow>(SHIFT_CASH_SUMMARY_SQL, [employeeId, from, to]);
  return toCashSummary(rows[0]);
}

export interface BranchShiftSales {
  /** Where the running total starts counting from, as an ISO instant. */
  since: string;
  /** The branch's most recent shift close, if it has ever had one. */
  lastShiftEndedAt: string | null;
  /** True while anyone is still clocked in at the branch. */
  hasOpenShift: boolean;
  summary: ShiftCashSummary;
}

/**
 * The branch's running sales since its last shift close — the Accounting
 * home's «فروش شیفت جاری» quick-report box.
 *
 * The window starts at the *later* of the branch's live-window start (the
 * business day's own start, or a manual «بستن روز کاری») and the branch's most
 * recent shift cash-up. Deliberately **every** cash-up, not only the one that
 * emptied the floor: `resolveLiveWindow` treats a close with a colleague still
 * clocked in as a handover and keeps the board running, which is right for the
 * day's KPIs — but this box is the till counter, and the till counter goes
 * back to zero at each cash-up. Bounding it by the day's start is what keeps a
 * branch whose staff never clock in from accumulating a week of sales into
 * \"the current shift\".
 *
 * Branch-scoped rather than per-employee (`shiftCashSummary`): the box reports
 * what the branch has sold this shift, whoever rang each order up.
 */
export async function branchShiftSales(locationId: string): Promise<BranchShiftSales | null> {
  const status = await getBusinessDayStatus(locationId);
  if (!status) return null;

  const dayStart = status.windowStart;
  const lastShiftEndedAt = status.lastShiftEndedAt;
  const since =
    lastShiftEndedAt && Date.parse(lastShiftEndedAt) > Date.parse(dayStart)
      ? lastShiftEndedAt
      : dayStart;

  // Orders and payments aggregated *separately*, not through one LEFT JOIN:
  // an order settled in two payments (split cash/card) has two joined rows,
  // and `sum(o.total)` over them would report the order's total twice.
  const { rows } = await query<CashSummaryRow>(
    `WITH window_orders AS (
       SELECT o.id, o.total
         FROM orders o
        WHERE o.location_id = $1
          AND o.status = 'completed'
          AND o.closed_at IS NOT NULL
          AND o.closed_at >= $2::timestamptz
     )
     SELECT
       (SELECT count(*) FROM window_orders)                                    AS order_count,
       (SELECT coalesce(sum(total), 0) FROM window_orders)                     AS gross_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)             AS cash_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)           AS online_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)           AS credit_total
       FROM payments p
      WHERE p.order_id IN (SELECT id FROM window_orders)`,
    [locationId, since],
  );

  return {
    since,
    lastShiftEndedAt,
    hasOpenShift: status.hasOpenShift,
    summary: toCashSummary(rows[0]),
  };
}

export interface EmployeeShift {
  id: string;
  employeeId: string;
  businessId: string;
  locationId: string | null;
  sessionId: string | null;
  deviceId: string | null;
  openingFloat: number | null;
  closingFloat: number | null;
  businessDate: string;
  startedAt: string;
  endedAt: string | null;
  closedBy: string | null;
}

interface ShiftRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  business_id: string;
  location_id: string | null;
  session_id: string | null;
  device_id: string | null;
  opening_float: string | null;
  closing_float: string | null;
  business_date: Date;
  started_at: Date;
  ended_at: Date | null;
  closed_by: string | null;
}

function toShift(row: ShiftRow): EmployeeShift {
  return {
    id: row.id,
    employeeId: row.employee_id,
    businessId: row.business_id,
    locationId: row.location_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    openingFloat: row.opening_float !== null ? Number(row.opening_float) : null,
    closingFloat: row.closing_float !== null ? Number(row.closing_float) : null,
    // employee_shifts.business_date is a Postgres `date` (local-midnight Date
    // from node-postgres) — see postgresDateToIso for why toISOString is wrong.
    businessDate: postgresDateToIso(row.business_date),
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    closedBy: row.closed_by,
  };
}

const SHIFT_COLUMNS =
  "id, employee_id, business_id, location_id, session_id, device_id, opening_float, closing_float, business_date, started_at, ended_at, closed_by";

/**
 * Opens a new shift for `employeeId`, copying location/device from the
 * session that's opening it (`sessionId` — the caller's own
 * `session.employeeSessionId`) so a shift never needs its own device-token
 * resolution. `businessDate` is bucketed by `app_business_date` (migration
 * 0076), the same rule every reporting view now uses — the branch's timezone,
 * offset by its configured business-day start where it has one — computed once
 * at open time and stored, not recomputed later, so a shift that runs past
 * local midnight stays on the day it started.
 *
 * A session only carries a location when the employee has a default branch
 * assigned (users.location_id, copied at PIN/WebAuthn login) or signed in from
 * a paired device — otherwise it is null, and a shift used to be recorded with
 * no branch at all even though the request itself resolves one. The caller
 * passes that resolved branch as `fallbackLocationId` so every shift is
 * attributed to where it was actually worked; without it a branch-scoped read
 * of open shifts silently finds nothing.
 */
export async function openShift(
  employeeId: string,
  businessId: string,
  sessionId: string | null,
  openingFloat: number | null = null,
  fallbackLocationId: string | null = null,
  actorRole: Role = "cashier",
): Promise<EmployeeShift> {
  let shift: EmployeeShift;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ShiftRow>(
      `INSERT INTO employee_shifts
         (employee_id, business_id, location_id, session_id, device_id, opening_float, business_date)
       SELECT $1, $2, coalesce(s.location_id, $5::uuid), s.id, s.device_id, $4,
              app_business_date(now(), l.timezone, l.business_day_start_minutes)
         FROM employee_sessions s
         LEFT JOIN locations l ON l.id = coalesce(s.location_id, $5::uuid)
        WHERE s.id = $3 AND s.business_id = $2
       RETURNING ${SHIFT_COLUMNS}`,
      [employeeId, businessId, sessionId, openingFloat, fallbackLocationId],
    );
    if (!rows[0]) throw new ShiftError("session_required", 400);
    shift = toShift(rows[0]);
    // Phase 45: the cloud's shift reports hear about it in the same commit.
    await recordShiftSyncEvent(client, "shift.opened", shift, { userId: employeeId, role: actorRole });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") throw new ShiftError("shift_already_open", 409);
    throw err;
  } finally {
    client.release();
  }
  await auditShift(businessId, employeeId, "shift.opened", shift.id, { openingFloat });
  await recordCoworkerEvent({
    businessId,
    locationId: shift.locationId,
    kind: "shift_open",
    payload: { shiftId: shift.id, employeeId },
  });
  await recordNotification({
    businessId,
    locationId: shift.locationId,
    eventKey: "shift.opened",
    severity: "info",
    title: "شیفت باز شد",
    body: `${await employeeName(businessId, employeeId)} شیفت خود را شروع کرد.`,
    url: "/settings/shifts",
    // Keyed on the shift, not on now(): a retried request is one shift and
    // therefore one notification.
    dedupeKey: notificationDedupeKey("shift.opened", shift.id),
    payload: { shiftId: shift.id, employeeId },
  });
  return shift;
}

export async function getActiveShift(
  employeeId: string,
  businessId: string,
): Promise<EmployeeShift | null> {
  const { rows } = await query<ShiftRow>(
    `SELECT ${SHIFT_COLUMNS} FROM employee_shifts
      WHERE employee_id = $1 AND business_id = $2 AND ended_at IS NULL`,
    [employeeId, businessId],
  );
  return rows[0] ? toShift(rows[0]) : null;
}

export interface ClosedOrdersWindow {
  /** Start of the period the orders screen lists closed orders for. */
  since: string;
  /** When the branch's running shift began, or null when nobody is clocked in. */
  shiftStartedAt: string | null;
  /** The branch's trading day as of now — null when it has no business day configured. */
  businessDay: BusinessDayStatus | null;
}

/**
 * The period the orders screen looks back over for closed orders: the current
 * business day at the branch, extended back to the start of a shift that is
 * still running if that shift began earlier.
 *
 * The first version of this keyed the window on the open shift alone, and that
 * was wrong in practice in three separate ways, each of which showed an empty
 * list on a branch that had been trading all day: a business whose staff never
 * clock in has no shift at all; an owner/manager *cannot* clock in (the shift
 * routes are cashier/waiter/kitchen only); and a cashier who clocks in at 14:00
 * would hide everything sold that morning. Anchoring on the business day fixes
 * all three, and taking the earlier of the two keeps a night shift that crossed
 * local midnight whole instead of truncating it at 00:00.
 *
 * Shifts are per employee (one open shift each), so a branch with two people
 * clocked in has two rows and the earliest wins — a colleague arriving mid-
 * service never narrows the window. A shift row whose location is null counts
 * for the branch: rows written before shifts recorded a fallback branch (see
 * openShift) have no branch of their own, and dropping them would reintroduce
 * exactly the empty list this function exists to prevent. Reads stay tenant-
 * scoped by RLS, and the orders themselves are always filtered by branch, so
 * the only thing such a row can affect is where the window starts.
 *
 * All of that is the *calendar-day* branch of this function, and it is left
 * exactly as it was. A branch that has configured a business day (روز کاری,
 * migration 0076) takes the other branch, where the trading day is authoritative
 * and the employee-shift widening is deliberately not applied: the business day
 * already keeps a night service that crosses midnight whole — which is the only
 * thing that widening was ever compensating for — and honouring an employee who
 * clocked in before the day started, or forgot to clock out last night, would
 * pull the *previous* business day's sales back into this one's list. A manual
 * close moves the start later still, so the screen goes to zero at the cash-up
 * rather than at the next day's start time.
 */
export async function branchClosedOrdersWindow(locationId: string): Promise<ClosedOrdersWindow> {
  // getBusinessDayStatus already carries where the day started (local midnight
  // for a branch with none configured, which is what this used to compute for
  // itself), so the only thing left to look up here is the open shift.
  const [{ rows }, businessDay] = await Promise.all([
    query<{ shift_started_at: Date | null }>(
      `SELECT min(s.started_at) AS shift_started_at
         FROM employee_shifts s
        WHERE s.ended_at IS NULL
          AND (s.location_id = $1 OR s.location_id IS NULL)`,
      [locationId],
    ),
    getBusinessDayStatus(locationId),
  ]);

  const shiftStartedAt = rows[0]?.shift_started_at ?? null;
  const shiftStartedAtIso = shiftStartedAt ? shiftStartedAt.toISOString() : null;

  if (businessDay?.enabled) {
    return { since: businessDay.windowStart, shiftStartedAt: shiftStartedAtIso, businessDay };
  }

  const dayStartedAt = businessDay ? new Date(businessDay.scheduledStart) : new Date();
  const since = shiftStartedAt && shiftStartedAt < dayStartedAt ? shiftStartedAt : dayStartedAt;
  return { since: since.toISOString(), shiftStartedAt: shiftStartedAtIso, businessDay: null };
}

export interface CloseShiftResult {
  shift: EmployeeShift;
  cashSummary: ShiftCashSummary;
  reconciliation: { expectedCash: number; variance: number } | null;
}

async function closeShiftRow(
  filter: { id: string } | { employeeId: string },
  businessId: string,
  actorId: string | null,
  closingFloat: number | null,
  actorRole: Role,
): Promise<CloseShiftResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const where = "id" in filter ? "id = $1" : "employee_id = $1";
    const param = "id" in filter ? filter.id : filter.employeeId;
    const { rows } = await client.query<ShiftRow>(
      `UPDATE employee_shifts
          SET ended_at = now(), closing_float = $3, closed_by = $4
        WHERE ${where} AND business_id = $2 AND ended_at IS NULL
        RETURNING ${SHIFT_COLUMNS}`,
      [param, businessId, closingFloat, actorId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      throw new ShiftError("no_active_shift", 404);
    }
    await recordShiftSyncEvent(client, "shift.closed", toShift(rows[0]), { userId: actorId, role: actorRole });
    await client.query("COMMIT");
    const shift = toShift(rows[0]);

    const cashSummary = await shiftCashSummary(shift.employeeId, shift.startedAt, shift.endedAt!);
    const reconciliation =
      shift.openingFloat !== null && shift.closingFloat !== null
        ? reconcileCash(shift.openingFloat, shift.closingFloat, cashSummary.cashTotal)
        : null;

    await auditShift(businessId, actorId, "shift.closed", shift.id, {
      closingFloat,
      reconciliation,
    });
    await recordCoworkerEvent({
      businessId,
      locationId: shift.locationId,
      kind: "shift_close",
      payload: { shiftId: shift.id, employeeId: shift.employeeId },
    });

    const closerName = await employeeName(businessId, shift.employeeId);
    await recordNotification({
      businessId,
      locationId: shift.locationId,
      eventKey: "shift.closed",
      severity: "info",
      title: "شیفت بسته شد",
      body: `${closerName} — فروش نقدی ${tomanText(cashSummary.cashTotal)}`,
      url: "/settings/shifts",
      amountRial: cashSummary.cashTotal,
      dedupeKey: notificationDedupeKey("shift.closed", shift.id),
      payload: { shiftId: shift.id, employeeId: shift.employeeId },
    });

    // A separate event rather than a field on the one above, because it is a
    // separate *decision*: an owner who does not want a card every time a till
    // closes still wants to know the night it came up 400,000 ﷼ short, and
    // `min_amount_rial` on this event is what lets them set the size that
    // matters to them.
    if (reconciliation && reconciliation.variance !== 0) {
      await recordNotification({
        businessId,
        locationId: shift.locationId,
        eventKey: "shift.cash_variance",
        severity: "important",
        title: `${cashVarianceText(reconciliation.variance)}`,
        body: `شیفت ${closerName} — مبلغ مورد انتظار ${tomanText(reconciliation.expectedCash)}`,
        url: "/settings/shifts",
        amountRial: reconciliation.variance,
        dedupeKey: notificationDedupeKey("shift.cash_variance", shift.id),
        payload: { shiftId: shift.id, employeeId: shift.employeeId, variance: reconciliation.variance },
      });
    }
    return { shift, cashSummary, reconciliation };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Self-service — ends the caller's own open shift. */
export async function closeOwnShift(
  employeeId: string,
  businessId: string,
  closingFloat: number | null = null,
  actorRole: Role = "cashier",
): Promise<CloseShiftResult> {
  return closeShiftRow({ employeeId }, businessId, employeeId, closingFloat, actorRole);
}

/**
 * Admin force-close — an owner/manager ending a shift the employee left open
 * (e.g. forgot to clock out).
 *
 * The id is uuid-guarded before it reaches the UPDATE: `WHERE id = $1` against
 * a `uuid` column raises `invalid input syntax for type uuid` for anything
 * else, which surfaces as a 500 and the generic «خطای غیرمنتظره» instead of
 * the honest «شیفت بازی برای پایان دادن پیدا نشد» (see uuid.ts).
 */
export async function closeShiftById(
  shiftId: string,
  businessId: string,
  actorId: string | null,
  closingFloat: number | null = null,
  actorRole: Role = "manager",
): Promise<CloseShiftResult> {
  if (!isUuid(shiftId)) throw new ShiftError("no_active_shift", 404);
  return closeShiftRow({ id: shiftId }, businessId, actorId, closingFloat, actorRole);
}

export interface ShiftListEntry extends EmployeeShift {
  employeeName: string;
  /** The branch the shift was worked at, when it recorded one — a business with several needs to tell them apart. */
  locationName: string | null;
  cashSummary: ShiftCashSummary;
  /** Only set when the shift tracked a float on both ends — see shift.ts's reconcileCash. */
  reconciliation: { expectedCash: number; variance: number } | null;
}

interface ShiftListRow extends ShiftRow, CashSummaryRow {
  employee_name: string;
  location_name: string | null;
}

/** What the admin review tab may narrow its history by. */
export interface ShiftListFilters {
  employeeId?: string;
  locationId?: string;
  /** "open" = still clocked in, "closed" = cashed up. Omitted means both. */
  status?: "open" | "closed";
  /** Page size; clamped to `SHIFT_PAGE_MAX` so a hand-written query cannot ask for the whole table. */
  limit?: number;
  offset?: number;
}

export const SHIFT_PAGE_SIZE = 25;
export const SHIFT_PAGE_MAX = 100;

export interface ShiftListPage {
  shifts: ShiftListEntry[];
  /** True when another page exists — read by fetching one row past the page and dropping it. */
  hasMore: boolean;
}

/**
 * Shift history for the admin review tab, most recent first — each row's
 * cash summary/variance is computed in the same query via a LATERAL join
 * (Wave 7 — resolves this doc's Wave 5/6 open question 1), instead of the
 * settings tab making one `shiftCashSummary` round trip per shift.
 *
 * Paged rather than the flat `LIMIT 200` it shipped with. Two hundred rows is
 * roughly a fortnight for a branch with four staff, so the tab both stopped
 * showing older shifts — silently, with nothing on screen saying so — and sent
 * two hundred rows plus two hundred correlated aggregates down the wire to a
 * phone on every visit. The page carries `hasMore` so the UI can say which of
 * those two things is happening.
 *
 * A branch filter matches rows with no branch of their own as well, the same
 * rule `branchClosedOrdersWindow` and `getBusinessDayStatus` already apply: a
 * shift only records a branch when the session that opened it had one, and
 * dropping those rows would hide the very shifts a single-branch business
 * records. Both ids are uuid-guarded — `WHERE id = $1` against a `uuid` column
 * raises `invalid input syntax` for a non-uuid, which surfaces as a 500 rather
 * than an empty list (see uuid.ts).
 */
export async function listShifts(
  businessId: string,
  filters: ShiftListFilters = {},
): Promise<ShiftListPage> {
  const params: unknown[] = [businessId];
  const conditions: string[] = ["s.business_id = $1"];
  if (filters.employeeId) {
    if (!isUuid(filters.employeeId)) return { shifts: [], hasMore: false };
    params.push(filters.employeeId);
    conditions.push(`s.employee_id = $${params.length}`);
  }
  if (filters.locationId) {
    if (!isUuid(filters.locationId)) return { shifts: [], hasMore: false };
    params.push(filters.locationId);
    conditions.push(`(s.location_id = $${params.length} OR s.location_id IS NULL)`);
  }
  if (filters.status === "open") conditions.push("s.ended_at IS NULL");
  if (filters.status === "closed") conditions.push("s.ended_at IS NOT NULL");

  const limit = Math.min(
    Math.max(Math.trunc(filters.limit ?? SHIFT_PAGE_SIZE), 1),
    SHIFT_PAGE_MAX,
  );
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  // One row past the page: its presence is `hasMore`, and it costs one row
  // rather than the second COUNT(*) query over the same correlated aggregates.
  params.push(limit + 1, offset);
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;

  const { rows } = await query<ShiftListRow>(
    `SELECT s.id, s.employee_id, s.business_id, s.location_id, s.session_id, s.device_id,
            s.opening_float, s.closing_float, s.business_date, s.started_at, s.ended_at, s.closed_by,
            u.full_name AS employee_name,
            l.name AS location_name,
            coalesce(cs.order_count, 0) AS order_count,
            coalesce(cs.gross_total, 0) AS gross_total,
            coalesce(cs.cash_total, 0) AS cash_total,
            coalesce(cs.card_total, 0) AS card_total,
            coalesce(cs.online_total, 0) AS online_total,
            coalesce(cs.credit_total, 0) AS credit_total
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
       LEFT JOIN locations l ON l.id = s.location_id
       LEFT JOIN LATERAL (
         ${cashSummarySelect(
           SHIFT_CASH_WINDOW("s.started_at", "coalesce(s.ended_at, now())", "s.employee_id"),
         )}
       ) cs ON true
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.started_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  const hasMore = rows.length > limit;
  return {
    shifts: rows.slice(0, limit).map((row) => {
      const shift = toShift(row);
      const cashSummary = toCashSummary(row);
      const reconciliation =
        shift.openingFloat !== null && shift.closingFloat !== null
          ? reconcileCash(shift.openingFloat, shift.closingFloat, cashSummary.cashTotal)
          : null;
      return {
        ...shift,
        employeeName: row.employee_name,
        locationName: row.location_name,
        cashSummary,
        reconciliation,
      };
    }),
    hasMore,
  };
}
