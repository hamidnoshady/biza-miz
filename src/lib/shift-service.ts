/**
 * Phase 20 Wave 5 — shift tracking: the DB-touching half (not unit-tested
 * directly, per repo convention — see employee-service.ts's header for why;
 * the pure rules it uses live in shift.ts / shift-cashup.ts and are covered by
 * their tests).
 *
 * ## What issue #933 changed here
 *
 * A shift is still one row in `employee_shifts`, and its *order* list is still
 * "orders opened while it ran" (shift-orders-service.ts). What changed is the
 * part that touches money:
 *
 *   * The **closing cash-up is a snapshot**, written in the same transaction as
 *     `ended_at` (migration 0233). A closed shift's variance is read from that
 *     row, never recomputed from today's payments, so a refund or a
 *     closed-order amendment afterwards cannot silently rewrite it.
 *   * The state change, the snapshot, the mandatory audit row and the sync
 *     outbox event are **one transaction**. Notifications and coworker events
 *     are queued afterwards and can never make a committed close look like a
 *     failure.
 *   * Start and close are **retry-safe**: a repeated start with the same
 *     idempotency key returns the shift it already opened, and repeating a
 *     close returns the cash-up that was already committed.
 *   * The branch is **canonical from the active branch**, not a fallback for a
 *     session row that may name another branch.
 *   * Expected cash accounts for **cash movements** (paid-outs, drops,
 *     handovers) as well as the opening float and cash sales, and a close with
 *     no physical count is stored as `unresolved` — NULL variance, never zero.
 *   * Every settlement class is reported (including SnapFood and cheque), so a
 *     shift's gross can be tied out to its tenders instead of leaving an
 *     unexplained gap.
 */
import type { PoolClient } from "pg";
import { getBusinessDayStatus, type BusinessDayStatus } from "./business-day-service";
import { getPool, query } from "./db";
import { postgresDateToIso } from "./jalali";
import type { Role } from "./auth";
import { recordShiftAdjustmentSyncEvent, recordShiftSyncEvent } from "./shift-sync";
import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import {
  applyVarianceAdjustment,
  MAX_SHIFT_REASON_LENGTH,
  parseShiftCloseInput,
  reconcileDrawer,
  tenderTieOut,
  type CashDrawerReconciliation,
  type ShiftCloseInput,
  type ShiftCloseMode,
  type ShiftTenderTotals,
  type TenderTieOut,
} from "./shift-cashup";
import { shiftBranchExpression, isShiftInAllowedBranches } from "./shift-branch-scope";
import { isValidCashFloat } from "./shift";
import { formatMoney } from "./money";
import { resolveBusinessMoneyUnit } from "./ai-money-unit";
// Phase 32 — the coworker's event queue. Enqueued after the close commits,
// never inside it: a cashier clocking out is a foreground request and must not
// wait on (or fail because of) a background job. `recordCoworkerEvent` swallows
// its own errors for the same reason.
import { recordCoworkerEvent } from "./ai-coworker-events";
// Phase 35 — notifications, queued for the same reason and with the same
// contract: `recordNotification` swallows its own errors, so a shift can never
// fail to close because nobody could be told about it.
import { recordNotification } from "./notification-events";
import { cashVarianceText, notificationDedupeKey } from "./notifications";

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

/**
 * The mandatory audit row — always inside the caller's transaction.
 *
 * It used to be written after COMMIT, which is precisely the defect #933 item 1
 * describes: a failure there reported a 500 for a shift that had already
 * closed. Taking a client makes it impossible to call this outside a
 * transaction by accident.
 */
async function auditShift(
  client: PoolClient,
  businessId: string,
  actorId: string | null,
  action: string,
  shiftId: string,
  payload?: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'shift', $4, $5)`,
    [businessId, actorId, action, shiftId, JSON.stringify(payload ?? null)],
  );
}

export interface ShiftCashSummary {
  orderCount: number;
  grossTotal: number;
  /** Cash settled on the shift's orders — the only tender that feeds the drawer. */
  cashTotal: number;
  /** Card terminal + card-to-card, kept as one line for older callers. */
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
  /** Every settlement class including SnapFood and cheque (#933 item 9). */
  tenders: ShiftTenderTotals;
  cashMovementsIn: number;
  cashMovementsOut: number;
}

interface CashSummaryRow extends Record<string, unknown> {
  order_count: string;
  gross_total: string;
  cash_total: string;
  card_total: string;
  card_to_card_total: string;
  online_total: string;
  credit_total: string;
  snappfood_total: string;
  cheque_total: string;
  other_total: string;
  tendered_total: string;
}

function numberValue(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isSafeInteger(numeric) ? numeric : Math.trunc(numeric) || 0;
}

function toTenderTotals(row: CashSummaryRow | undefined): ShiftTenderTotals {
  const cash = numberValue(row?.cash_total);
  const card = numberValue(row?.card_total);
  const cardToCard = numberValue(row?.card_to_card_total);
  const online = numberValue(row?.online_total);
  const credit = numberValue(row?.credit_total);
  const snappfood = numberValue(row?.snappfood_total);
  const cheque = numberValue(row?.cheque_total);
  const other = numberValue(row?.other_total);
  return {
    cash,
    card,
    cardToCard,
    online,
    credit,
    snappfood,
    cheque,
    other,
    // Summed from the classes rather than read back from `tendered_total`, so a
    // row from before this migration (no such column) still adds up.
    total: cash + card + cardToCard + online + credit + snappfood + cheque + other,
  };
}

function toCashSummary(row: CashSummaryRow | undefined, movements = { in: 0, out: 0 }): ShiftCashSummary {
  const tenders = toTenderTotals(row);
  return {
    orderCount: numberValue(row?.order_count),
    grossTotal: numberValue(row?.gross_total),
    cashTotal: tenders.cash,
    cardTotal: tenders.card + tenders.cardToCard,
    onlineTotal: tenders.online,
    creditTotal: tenders.credit,
    tenders,
    cashMovementsIn: movements.in,
    cashMovementsOut: movements.out,
  };
}

/**
 * A shift's cash summary, as one SELECT over the orders matching `predicate`.
 *
 * `predicate` is the window — it may reference the outer row (`s.employee_id`,
 * `s.started_at`) when this is embedded in a LATERAL join, or bind parameters
 * when it stands alone — and every caller shares it so `shiftCashSummary` (one
 * shift's own `[from, to]`) and `listShifts`'s per-row join cannot drift apart.
 *
 * The orders and the payments are counted **separately**, never across one
 * `orders LEFT JOIN payments`. That join produces one row per payment, so an
 * order settled in two tenders — a split cash/card bill, or the re-settlement a
 * closed-order amendment writes — was counted once by `count(DISTINCT o.id)`
 * but summed twice by `sum(o.total)`: every such shift reported a gross total
 * larger than it had sold. The per-method totals stay `sum(p.amount) FILTER (…)`
 * because a payment row *is* the unit there — two tenders on one bill are two
 * real amounts.
 *
 * Every settlement class has a bucket. Before #933 this stopped at cash/card/
 * online/credit, so a SnapFood checkout — a legitimate tender in this product —
 * raised the gross with nothing on the method side to explain it.
 */
function cashSummarySelect(predicate: string): string {
  const windowOrders = `SELECT o.id, o.total FROM orders o WHERE ${predicate}`;
  return `
    SELECT
      (SELECT count(*) FROM (${windowOrders}) wo)                                  AS order_count,
      (SELECT coalesce(sum(wo.total), 0) FROM (${windowOrders}) wo)                AS gross_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)                  AS cash_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'card'), 0)                  AS card_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'card_to_card'), 0)          AS card_to_card_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)                AS online_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)                AS credit_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'snappfood'), 0)             AS snappfood_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method = 'cheque'), 0)                AS cheque_total,
      coalesce(sum(p.amount) FILTER (WHERE p.method NOT IN
        ('cash', 'card', 'card_to_card', 'online', 'credit', 'snappfood', 'cheque')), 0) AS other_total,
      coalesce(sum(p.amount), 0)                                                   AS tendered_total
      FROM payments p
     WHERE p.order_id IN (SELECT wo.id FROM (${windowOrders}) wo)
  `;
}

/**
 * The window a shift's *cash* is judged by: what this employee closed while
 * they were clocked in. Deliberately `closed_by`/`closed_at` rather than the
 * `opened_at` rule the shift's *order list* uses (see CLAUDE.md) — the drawer
 * count has to reconcile against money this person actually took.
 *
 * This remains the attribution rule for a *shift's* sales. It is not a model of
 * a physical till shared by several people (issue #933 item 3): the snapshot
 * records the tender breakdown and the movements so the figure is explainable,
 * and `payments.received_by` stays available for a per-till report, but a
 * multi-cashier register is a separate feature and is called out as such in the
 * PR rather than being faked here.
 */
const SHIFT_CASH_WINDOW = (from: string, to: string, employee: string) =>
  `o.closed_by = ${employee} AND o.status = 'completed' AND o.closed_at BETWEEN ${from} AND ${to}`;

/** Exported for `shift-service-sql.test.ts`: the shape above is the thing worth pinning, not the rows. */
export const SHIFT_CASH_SUMMARY_SQL = cashSummarySelect(SHIFT_CASH_WINDOW("$2", "$3", "$1"));

interface MovementTotals {
  in: number;
  out: number;
}

const MOVEMENT_TOTALS_SQL = `
  SELECT coalesce(sum(amount) FILTER (WHERE direction = 'in'), 0)  AS cash_in,
         coalesce(sum(amount) FILTER (WHERE direction = 'out'), 0) AS cash_out
    FROM shift_cash_movements
   WHERE shift_id = $1
`;

function toMovementTotals(row: { cash_in?: string; cash_out?: string } | undefined): MovementTotals {
  return { in: numberValue(row?.cash_in), out: numberValue(row?.cash_out) };
}

async function movementTotals(client: PoolClient, shiftId: string): Promise<MovementTotals> {
  const { rows } = await client.query<{ cash_in: string; cash_out: string }>(MOVEMENT_TOTALS_SQL, [shiftId]);
  return toMovementTotals(rows[0]);
}

async function readSalesSummary(
  client: PoolClient,
  predicate: string,
  params: unknown[],
): Promise<ShiftCashSummary> {
  const { rows } = await client.query<CashSummaryRow>(cashSummarySelect(predicate), params);
  return toCashSummary(rows[0]);
}

/**
 * Every completed order this employee closed between `from` and `to`,
 * reconciled by payment method, plus the cash movements recorded on the shift.
 *
 * Kept as a separate read for the *active* shift panel and for legacy rows;
 * a finalized shift's figures come from `shift_cashups`, never from here.
 */
export async function shiftCashSummary(
  employeeId: string,
  from: Date | string,
  to: Date | string,
  shiftId?: string | null,
): Promise<ShiftCashSummary> {
  const { rows } = await query<CashSummaryRow>(
    cashSummarySelect(SHIFT_CASH_WINDOW("$2", "$3", "$1")),
    [employeeId, from, to],
  );
  const summary = toCashSummary(rows[0]);
  let movements: MovementTotals = { in: 0, out: 0 };
  if (shiftId) {
    const totals = await query<{ cash_in: string; cash_out: string }>(MOVEMENT_TOTALS_SQL, [shiftId]);
    movements = toMovementTotals(totals.rows[0]);
  }
  return { ...summary, cashMovementsIn: movements.in, cashMovementsOut: movements.out };
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
 * back to zero at each cash-up.
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
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'card'), 0)             AS card_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'card_to_card'), 0)     AS card_to_card_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)           AS online_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)           AS credit_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'snappfood'), 0)        AS snappfood_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method = 'cheque'), 0)           AS cheque_total,
       coalesce(sum(p.amount) FILTER (WHERE p.method NOT IN
         ('cash', 'card', 'card_to_card', 'online', 'credit', 'snappfood', 'cheque')), 0) AS other_total,
       coalesce(sum(p.amount), 0)                                              AS tendered_total
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
  /** `counted` / `unresolved` once closed by a path that recorded it; null otherwise. */
  closeMode: ShiftCloseMode | null;
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
  close_mode: ShiftCloseMode | null;
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
    closeMode: row.close_mode ?? null,
  };
}

const SHIFT_COLUMNS =
  "id, employee_id, business_id, location_id, session_id, device_id, opening_float, closing_float, business_date, started_at, ended_at, closed_by, close_mode";

/** The same list qualified with `s.`, for reads that join. */
const SHIFT_COLUMNS_S = SHIFT_COLUMNS.split(", ").map((column) => `s.${column}`).join(", ");

/**
 * Opens a new shift for `employeeId`, attributed to the branch the request is
 * actually being made in.
 *
 * ## The branch is canonical, not a fallback (#933 item 4)
 *
 * The old INSERT wrote `coalesce(session.location_id, active_location)`, so a
 * member who signed in at Branch A and switched to Branch B opened their shift
 * at A — the stale session row won over the branch on screen. `locationId` is
 * now required and is the shift's branch; the session only supplies its id and
 * device. The route resolves it through `resolveActiveLocation`, which already
 * refuses a branch the member cannot reach.
 *
 * ## Idempotent (#933 item 1)
 *
 * With `requestId` (the request's idempotency key), a replay returns the shift
 * that key already opened instead of colliding with the one-open-shift index
 * and answering `shift_already_open` for a shift that is, in fact, this
 * request's own. Without a key the old behaviour stands: a second start is a
 * conflict.
 *
 * The row, its audit entry and its sync-outbox event are one transaction.
 * Notifications and the coworker event are queued afterwards and cannot fail
 * the request.
 */
export async function openShift(
  employeeId: string,
  businessId: string,
  sessionId: string | null,
  openingFloat: number | null = null,
  locationId: string | null = null,
  actorRole: Role = "cashier",
  requestId: string | null = null,
): Promise<EmployeeShift> {
  if (openingFloat !== null && !isValidCashFloat(openingFloat)) {
    throw new ShiftError("invalid_amount", 400);
  }
  if (!locationId || !isUuid(locationId)) throw new ShiftError("location_required", 409);
  if (requestId !== null && (typeof requestId !== "string" || requestId.length > 200)) {
    throw new ShiftError("bad_request", 400);
  }

  let shift: EmployeeShift;
  let replayed = false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const branch = await client.query<{ id: string }>(
      `SELECT id FROM locations WHERE id = $1 AND business_id = $2 AND is_active`,
      [locationId, businessId],
    );
    if (!branch.rows[0]) throw new ShiftError("location_not_found", 404);

    if (requestId) {
      const existing = await client.query<ShiftRow>(
        `SELECT ${SHIFT_COLUMNS} FROM employee_shifts
          WHERE business_id = $1 AND open_request_id = $2 AND employee_id = $3`,
        [businessId, requestId, employeeId],
      );
      if (existing.rows[0]) {
        shift = toShift(existing.rows[0]);
        replayed = true;
        await client.query("COMMIT");
        return shift;
      }
    }

    // A second start while one is open is a conflict; saying *where* the shift
    // is open lets the UI offer "close it there first" instead of a dead end.
    const open = await client.query<{ id: string; location_id: string | null }>(
      `SELECT id, location_id FROM employee_shifts
        WHERE employee_id = $1 AND business_id = $2 AND ended_at IS NULL
        FOR UPDATE`,
      [employeeId, businessId],
    );
    if (open.rows[0]) throw new ShiftError("shift_already_open", 409);

    const { rows } = await client.query<ShiftRow>(
      sessionId
        ? `INSERT INTO employee_shifts
             (employee_id, business_id, location_id, session_id, device_id, opening_float,
              business_date, open_request_id)
           SELECT $1, $2, $5::uuid, s.id, s.device_id, $4,
                  app_business_date(now(), l.timezone, l.business_day_start_minutes), $6
             FROM employee_sessions s
             JOIN locations l ON l.id = $5::uuid AND l.business_id = $2
            WHERE s.id = $3 AND s.business_id = $2 AND s.employee_id = $1
              AND s.revoked_at IS NULL AND s.expires_at > now()
           RETURNING ${SHIFT_COLUMNS}`
        : `INSERT INTO employee_shifts
             (employee_id, business_id, location_id, session_id, device_id, opening_float,
              business_date, open_request_id)
           SELECT $1, $2, $5::uuid, NULL, NULL, $4,
                  app_business_date(now(), l.timezone, l.business_day_start_minutes), $6
             FROM locations l
            WHERE l.id = $5::uuid AND l.business_id = $2
           RETURNING ${SHIFT_COLUMNS}`,
      [employeeId, businessId, sessionId, openingFloat, locationId, requestId],
    );
    if (!rows[0]) throw new ShiftError("session_required", 400);
    shift = toShift(rows[0]);
    // Phase 45: the cloud's shift reports hear about it in the same commit.
    await recordShiftSyncEvent(client, "shift.opened", shift, { userId: employeeId, role: actorRole });
    await auditShift(client, businessId, employeeId, "shift.opened", shift.id, {
      openingFloat,
      locationId,
      requestId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") throw new ShiftError("shift_already_open", 409);
    throw err;
  } finally {
    client.release();
  }
  if (!replayed) await notifyOpened(businessId, shift);
  return shift;
}

/**
 * Post-commit side effects for a start. Never throws: the shift is already
 * committed, and a push notification that cannot be queued is not a reason to
 * tell the cashier their clock-in failed.
 */
async function notifyOpened(businessId: string, shift: EmployeeShift): Promise<void> {
  try {
    await recordCoworkerEvent({
      businessId,
      locationId: shift.locationId,
      kind: "shift_open",
      payload: { shiftId: shift.id, employeeId: shift.employeeId },
      dedupeKey: shift.id,
    });
    await recordNotification({
      businessId,
      locationId: shift.locationId,
      eventKey: "shift.opened",
      severity: "info",
      title: "شیفت باز شد",
      body: `${await employeeName(businessId, shift.employeeId)} شیفت خود را شروع کرد.`,
      url: "/settings/shifts",
      // Keyed on the shift, not on now(): a retried request is one shift and
      // therefore one notification.
      dedupeKey: notificationDedupeKey("shift.opened", shift.id),
      payload: { shiftId: shift.id, employeeId: shift.employeeId },
    });
  } catch (error) {
    console.error("shift open notification failed:", error instanceof Error ? error.message : error);
  }
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
 * Branch attribution of a legacy row with no `location_id` is
 * `shift-branch-scope.ts`'s job now (#933 item 6). It used to be
 * `location_id = $1 OR location_id IS NULL`, which let a shift at another
 * branch start *this* branch's window.
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
          AND ${shiftBranchExpression("s")} = $1`,
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

/**
 * How a finalized cash-up reads in the UI.
 *
 * A counted close with no expected figure (the shift never tracked an opening
 * float) has no variance to compare — it is unresolved, not "a variance".
 */
function drawerStatusFor(closeMode: ShiftCloseMode, variance: number | null): CashDrawerReconciliation["status"] {
  if (closeMode === "unresolved" || variance === null) return "unresolved";
  return variance === 0 ? "balanced" : "variance";
}

/** The stored closing snapshot, as the API and the history screen read it. */
export interface ShiftCashup {
  id: string;
  shiftId: string;
  locationId: string | null;
  closeMode: ShiftCloseMode;
  reason: string | null;
  closedBy: string | null;
  closedByName: string | null;
  openingFloat: number | null;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
  cashIn: number;
  cashOut: number;
  orderCount: number;
  grossTotal: number;
  tenders: ShiftTenderTotals;
  tieOut: TenderTieOut;
  createdAt: string;
}

export interface ShiftCashupAdjustment {
  id: string;
  beforeVariance: number | null;
  afterVariance: number | null;
  delta: number | null;
  reason: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

interface CashupRow extends Record<string, unknown> {
  id: string;
  shift_id: string;
  location_id: string | null;
  close_mode: ShiftCloseMode;
  close_reason: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  opening_float: string | null;
  expected_cash: string | null;
  counted_cash: string | null;
  variance: string | null;
  cash_in: string;
  cash_out: string;
  order_count: number;
  gross_total: string;
  tender_cash: string;
  tender_card: string;
  tender_card_to_card: string;
  tender_online: string;
  tender_credit: string;
  tender_snappfood: string;
  tender_cheque: string;
  tender_other: string;
  created_at: Date;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function cashupTenderTotals(row: CashupRow): ShiftTenderTotals {
  const cash = numberValue(row.tender_cash);
  const card = numberValue(row.tender_card);
  const cardToCard = numberValue(row.tender_card_to_card);
  const online = numberValue(row.tender_online);
  const credit = numberValue(row.tender_credit);
  const snappfood = numberValue(row.tender_snappfood);
  const cheque = numberValue(row.tender_cheque);
  const other = numberValue(row.tender_other);
  return {
    cash,
    card,
    cardToCard,
    online,
    credit,
    snappfood,
    cheque,
    other,
    total: cash + card + cardToCard + online + credit + snappfood + cheque + other,
  };
}

function toCashup(row: CashupRow): ShiftCashup {
  const tenders = cashupTenderTotals(row);
  const grossTotal = numberValue(row.gross_total);
  return {
    id: row.id,
    shiftId: row.shift_id,
    locationId: row.location_id,
    closeMode: row.close_mode,
    reason: row.close_reason,
    closedBy: row.closed_by,
    closedByName: row.closed_by_name,
    openingFloat: nullableNumber(row.opening_float),
    expectedCash: nullableNumber(row.expected_cash),
    countedCash: nullableNumber(row.counted_cash),
    variance: nullableNumber(row.variance),
    cashIn: numberValue(row.cash_in),
    cashOut: numberValue(row.cash_out),
    orderCount: numberValue(row.order_count),
    grossTotal,
    tenders,
    tieOut: tenderTieOut(grossTotal, tenders),
    createdAt: row.created_at.toISOString(),
  };
}

const CASHUP_SELECT = `
  SELECT sc.id, sc.shift_id, sc.location_id, sc.close_mode, sc.close_reason,
         sc.closed_by, cu.full_name AS closed_by_name,
         sc.opening_float, sc.expected_cash, sc.counted_cash, sc.variance,
         sc.cash_in, sc.cash_out, sc.order_count, sc.gross_total,
         sc.tender_cash, sc.tender_card, sc.tender_card_to_card, sc.tender_online,
         sc.tender_credit, sc.tender_snappfood, sc.tender_cheque, sc.tender_other,
         sc.created_at
    FROM shift_cashups sc
    LEFT JOIN users cu ON cu.id = sc.closed_by
`;

async function readCashup(
  runner: Pick<PoolClient, "query">,
  shiftId: string,
): Promise<ShiftCashup | null> {
  const { rows } = await runner.query<CashupRow>(`${CASHUP_SELECT} WHERE sc.shift_id = $1`, [shiftId]);
  return rows[0] ? toCashup(rows[0]) : null;
}

export interface CloseShiftResult {
  shift: EmployeeShift;
  cashSummary: ShiftCashSummary;
  reconciliation: CashDrawerReconciliation;
  cashup: ShiftCashup;
  /** True when this call found the close already committed and returned it. */
  replayed: boolean;
}

export interface CloseShiftOptions {
  /**
   * Administrative force-close: the actor is not the employee, so closing
   * without a count needs a reason and is audited as such (#933 item 10).
   */
  admin?: boolean;
  /**
   * The branches this caller may act on. Null/omitted means no branch check
   * (self-service, which is already bounded by the employee id). Enforced for
   * every admin path (#933 item 5).
   */
  allowedLocationIds?: readonly string[] | null;
  /**
   * A client idempotency key. A close retried after its transaction committed
   * has no open shift left to find, so it finds the committed close this way
   * (and the cash-up with it) instead of reporting failure.
   */
  requestId?: string | null;
}

/**
 * The committed close a retry is asking for.
 *
 * Reads the snapshot and ends the transaction with a success — the shift is
 * already closed, so there is nothing left to write and nothing that can fail.
 */
async function replayClosedShift(
  client: PoolClient,
  row: ShiftRow & { branch_id: string | null },
  options: CloseShiftOptions,
): Promise<CloseShiftResult> {
  if (options.allowedLocationIds !== undefined &&
      !isShiftInAllowedBranches(row.branch_id, options.allowedLocationIds ?? null)) {
    throw new ShiftError("no_active_shift", 404);
  }
  const cashup = await readCashup(client, row.id);
  if (!cashup) throw new ShiftError("shift_already_closed", 409);
  await client.query("COMMIT");
  return {
    shift: toShift(row),
    cashSummary: cashupSummary(cashup),
    reconciliation: {
      expectedCash: cashup.expectedCash,
      variance: cashup.variance,
      status: drawerStatusFor(cashup.closeMode, cashup.variance),
    },
    cashup,
    replayed: true,
  };
}

/**
 * The one close implementation, shared by self-service and force-close.
 *
 * Everything durable happens inside one transaction: the state change, the
 * cash-up snapshot, the audit row and the sync-outbox event. A committed close
 * therefore cannot report a misleading failure (#933 item 1), and repeating it
 * returns the snapshot that was already written instead of `no_active_shift`
 * (#933 item 1, idempotency).
 */
async function closeShiftRow(
  filter: { id: string } | { employeeId: string },
  businessId: string,
  actorId: string | null,
  input: ShiftCloseInput,
  actorRole: Role,
  options: CloseShiftOptions = {},
): Promise<CloseShiftResult> {
  const requestId = options.requestId?.trim() || null;
  if (requestId !== null && requestId.length > 200) throw new ShiftError("bad_request", 400);
  const client = await getPool().connect();
  let committed: { shift: EmployeeShift; cashSummary: ShiftCashSummary; reconciliation: CashDrawerReconciliation; cashup: ShiftCashup } | null = null;
  const replayed = false;
  try {
    await client.query("BEGIN");

    // A retried close: the shift is already ended, so looking for an *open*
    // one would answer `no_active_shift` for work that succeeded. The key is
    // unique per business and names exactly the close this request performed.
    if (requestId) {
      const prior = await client.query<ShiftRow & { branch_id: string | null }>(
        `SELECT ${SHIFT_COLUMNS_S}, ${shiftBranchExpression("s")} AS branch_id
           FROM employee_shifts s
          WHERE s.business_id = $1 AND s.close_request_id = $2
            ${"employeeId" in filter ? "AND s.employee_id = $3" : ""}`,
        "employeeId" in filter ? [businessId, requestId, filter.employeeId] : [businessId, requestId],
      );
      if (prior.rows[0]) return replayClosedShift(client, prior.rows[0], options);
    }

    const where = "id" in filter ? "id = $1" : "employee_id = $1";
    const param = "id" in filter ? filter.id : filter.employeeId;
    // A self close must find an open shift. Without this, an employee whose
    // only shift was closed weeks ago would be handed that old cash-up as if
    // this request had produced it.
    const openOnly = "employeeId" in filter ? " AND s.ended_at IS NULL" : "";

    // Lock the row: two closes of one shift serialize here, and the loser sees
    // the committed cash-up below rather than writing a second snapshot.
    const locked = await client.query<ShiftRow & { branch_id: string | null }>(
      `SELECT ${SHIFT_COLUMNS_S}, ${shiftBranchExpression("s")} AS branch_id
         FROM employee_shifts s
        WHERE s.${where} AND s.business_id = $2${openOnly}
        FOR UPDATE OF s`,
      [param, businessId],
    );
    const existing = locked.rows[0];
    if (!existing) {
      // Two requests with the same idempotency key can race: the loser's first
      // lookup ran before the winner committed and its row lock then found no
      // open shift. Under READ COMMITTED the winner's commit is visible now, so
      // look the key up once more instead of failing work that succeeded.
      if (requestId) {
        const delayed = await client.query<ShiftRow & { branch_id: string | null }>(
          `SELECT ${SHIFT_COLUMNS_S}, ${shiftBranchExpression("s")} AS branch_id
             FROM employee_shifts s
            WHERE s.business_id = $1 AND s.close_request_id = $2
              ${"employeeId" in filter ? "AND s.employee_id = $3" : ""}`,
          "employeeId" in filter ? [businessId, requestId, filter.employeeId] : [businessId, requestId],
        );
        if (delayed.rows[0]) return replayClosedShift(client, delayed.rows[0], options);
      }
      throw new ShiftError("no_active_shift", 404);
    }

    if (options.allowedLocationIds !== undefined &&
        !isShiftInAllowedBranches(existing.branch_id, options.allowedLocationIds ?? null)) {
      // Deliberately the same answer as "not found": a constrained manager must
      // not be able to probe another branch's shift ids.
      throw new ShiftError("no_active_shift", 404);
    }

    if (existing.ended_at !== null) {
      const cashup = await readCashup(client, existing.id);
      if (!cashup) throw new ShiftError("shift_already_closed", 409);
      if (
        input.countedCash !== null &&
        (cashup.countedCash === null || input.countedCash !== cashup.countedCash)
      ) {
        // A different count for an already-finalized shift is a correction, not
        // a retry — and so is a count arriving for a close that was recorded
        // without one. Both belong in the adjustment workflow, with a reason.
        throw new ShiftError("shift_already_closed", 409);
      }
      const summary = cashupSummary(cashup);
      await client.query("COMMIT");
      return {
        shift: toShift(existing),
        cashSummary: summary,
        reconciliation: {
          expectedCash: cashup.expectedCash,
          variance: cashup.variance,
          status: drawerStatusFor(cashup.closeMode, cashup.variance),
        },
        cashup,
        replayed: true,
      };
    }

    if (options.admin && input.mode === "unresolved" && !input.reason) {
      throw new ShiftError("reason_required", 400);
    }

    const { rows } = await client.query<ShiftRow>(
      `UPDATE employee_shifts
          SET ended_at = now(),
              closing_float = $3,
              closed_by = $4,
              close_mode = $5,
              close_request_id = $6
        WHERE id = $1 AND business_id = $2 AND ended_at IS NULL
        RETURNING ${SHIFT_COLUMNS}`,
      [existing.id, businessId, input.countedCash, actorId, input.mode, requestId],
    );
    if (!rows[0]) throw new ShiftError("no_active_shift", 404);
    const shift = toShift(rows[0]);

    const summary = await readSalesSummary(
      client,
      SHIFT_CASH_WINDOW("$2", "$3", "$1"),
      [shift.employeeId, shift.startedAt, shift.endedAt!],
    );
    const movements = await movementTotals(client, shift.id);
    const cashSummary: ShiftCashSummary = {
      ...summary,
      cashMovementsIn: movements.in,
      cashMovementsOut: movements.out,
    };
    const reconciliation = reconcileDrawer({
      openingFloat: shift.openingFloat,
      cashSales: cashSummary.cashTotal,
      cashIn: movements.in,
      cashOut: movements.out,
      countedCash: input.countedCash,
    });

    await client.query(
      `INSERT INTO shift_cashups
         (business_id, location_id, shift_id, employee_id, business_date, started_at, ended_at,
          closed_by, close_mode, close_reason, opening_float, expected_cash, counted_cash, variance,
          cash_in, cash_out, order_count, gross_total,
          tender_cash, tender_card, tender_card_to_card, tender_online, tender_credit,
          tender_snappfood, tender_cheque, tender_other, breakdown)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb)
       ON CONFLICT (shift_id) DO NOTHING
       RETURNING id`,
      [
        businessId,
        shift.locationId,
        shift.id,
        shift.employeeId,
        shift.businessDate,
        shift.startedAt,
        shift.endedAt,
        actorId,
        input.mode,
        input.reason,
        shift.openingFloat,
        reconciliation.expectedCash,
        input.countedCash,
        reconciliation.variance,
        movements.in,
        movements.out,
        cashSummary.orderCount,
        cashSummary.grossTotal,
        cashSummary.tenders.cash,
        cashSummary.tenders.card,
        cashSummary.tenders.cardToCard,
        cashSummary.tenders.online,
        cashSummary.tenders.credit,
        cashSummary.tenders.snappfood,
        cashSummary.tenders.cheque,
        cashSummary.tenders.other,
        JSON.stringify({
          tenders: cashSummary.tenders,
          movements: { in: movements.in, out: movements.out },
          closeMode: input.mode,
          reconciliation,
          recordedAt: new Date().toISOString(),
        }),
      ],
    );
    // `ON CONFLICT DO NOTHING` cannot fire here — the row is locked and has no
    // cash-up yet — but reading the row back rather than trusting RETURNING
    // keeps a replayed sync event from producing a half-built result.
    const cashup = await readCashup(client, shift.id);
    if (!cashup) throw new Error("shift_cashup_missing");

    await auditShift(client, businessId, actorId, "shift.closed", shift.id, {
      cashupId: cashup.id,
      closeMode: cashup.closeMode,
      expectedCash: cashup.expectedCash,
      countedCash: cashup.countedCash,
      variance: cashup.variance,
      cashIn: cashup.cashIn,
      cashOut: cashup.cashOut,
      reason: cashup.reason,
      forced: Boolean(options.admin),
      employeeId: shift.employeeId,
      locationId: shift.locationId,
    });
    await recordShiftSyncEvent(client, "shift.closed", shift, { userId: actorId, role: actorRole }, {
      expectedCash: cashup.expectedCash,
      countedCash: cashup.countedCash,
      variance: cashup.variance,
      closeMode: cashup.closeMode,
      cashIn: cashup.cashIn,
      cashOut: cashup.cashOut,
      tenders: cashup.tenders,
      grossTotal: cashup.grossTotal,
      orderCount: cashup.orderCount,
      reason: cashup.reason,
    });
    await client.query("COMMIT");
    committed = { shift, cashSummary, reconciliation, cashup };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await notifyClosed(businessId, committed!);
  return { ...committed!, replayed };
}

function cashupSummary(cashup: ShiftCashup): ShiftCashSummary {
  return {
    orderCount: cashup.orderCount,
    grossTotal: cashup.grossTotal,
    cashTotal: cashup.tenders.cash,
    cardTotal: cashup.tenders.card + cashup.tenders.cardToCard,
    onlineTotal: cashup.tenders.online,
    creditTotal: cashup.tenders.credit,
    tenders: cashup.tenders,
    cashMovementsIn: cashup.cashIn,
    cashMovementsOut: cashup.cashOut,
  };
}

/**
 * Everything a close tells people about, after the commit.
 *
 * One try/catch around the whole block: if the business's money unit cannot be
 * read, the closer's name cannot be found or the notification table is missing
 * (an old deployment), the cashier still sees a successful close. The dedupe
 * keys are keyed on the shift, so a retry produces no second notification.
 */
async function notifyClosed(
  businessId: string,
  result: { shift: EmployeeShift; cashSummary: ShiftCashSummary; reconciliation: CashDrawerReconciliation; cashup: ShiftCashup },
): Promise<void> {
  const { shift, cashSummary, reconciliation, cashup } = result;
  try {
    const [unit, closerName] = await Promise.all([
      resolveBusinessMoneyUnit(businessId),
      employeeName(businessId, shift.employeeId),
    ]);
    const moneyText = (rial: number | null) =>
      rial === null ? "—" : formatMoney(rial, unit, { withUnit: true });

    await recordCoworkerEvent({
      businessId,
      locationId: shift.locationId,
      kind: "shift_close",
      payload: { shiftId: shift.id, employeeId: shift.employeeId, cashupId: cashup.id },
      dedupeKey: shift.id,
    });

    await recordNotification({
      businessId,
      locationId: shift.locationId,
      eventKey: "shift.closed",
      severity: "info",
      title: "شیفت بسته شد",
      body:
        cashup.closeMode === "counted"
          ? `${closerName} — فروش نقدی ${moneyText(cashSummary.cashTotal)}`
          : `${closerName} — بدون شمارش صندوق بسته شد (فروش نقدی ${moneyText(cashSummary.cashTotal)})`,
      url: "/settings/shifts",
      amountRial: cashSummary.cashTotal,
      dedupeKey: notificationDedupeKey("shift.closed", shift.id),
      payload: { shiftId: shift.id, employeeId: shift.employeeId, cashupId: cashup.id },
    });

    // A separate event rather than a field on the one above, because it is a
    // separate *decision*: an owner who does not want a card every time a till
    // closes still wants to know the night it came up 400,000 ﷼ short, and
    // `min_amount_rial` on this event is what lets them set the size that
    // matters to them.
    if (cashup.closeMode === "counted" && reconciliation.variance !== null && reconciliation.variance !== 0) {
      await recordNotification({
        businessId,
        locationId: shift.locationId,
        eventKey: "shift.cash_variance",
        severity: "important",
        title: cashVarianceText(reconciliation.variance, unit),
        body: `شیفت ${closerName} — مبلغ مورد انتظار ${moneyText(reconciliation.expectedCash)}`,
        url: "/settings/shifts",
        amountRial: reconciliation.variance,
        dedupeKey: notificationDedupeKey("shift.cash_variance", shift.id),
        payload: { shiftId: shift.id, employeeId: shift.employeeId, variance: reconciliation.variance },
      });
    }
  } catch (error) {
    console.error("shift close notification failed:", error instanceof Error ? error.message : error);
  }
}

/** Self-service — ends the caller's own open shift. */
export async function closeOwnShift(
  employeeId: string,
  businessId: string,
  closingFloat: number | null = null,
  actorRole: Role = "cashier",
  reason: string | null = null,
  requestId: string | null = null,
): Promise<CloseShiftResult> {
  const parsed = parseShiftCloseInput(
    { countedCash: closingFloat, reason },
    // A waiter's shift has no drawer, so a self close without a count is
    // routine — it is recorded unresolved, not refused.
    {},
  );
  if (!parsed.ok) throw new ShiftError(parsed.error, 400);
  return closeShiftRow({ employeeId }, businessId, employeeId, parsed.value, actorRole, {
    admin: false,
    requestId,
  });
}

/**
 * Admin force-close — an owner/manager ending a shift the employee left open
 * (e.g. forgot to clock out).
 *
 * ## A guessed count is not a count (#933 item 10)
 *
 * `options.requireReasonWhenUncounted` is on for every admin close, and the
 * route parses the body with the same option. The history screen no longer
 * prefills "expected" as the counted amount; an operator who has not counted
 * the drawer closes it explicitly as unresolved, with a reason.
 *
 * ## Branch scope (#933 item 5)
 *
 * `options.allowedLocationIds` is the caller's reachable branches. A shift at
 * another branch is answered exactly like one that does not exist.
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
  options: {
    reason?: string | null;
    allowedLocationIds?: readonly string[] | null;
    requestId?: string | null;
  } = {},
): Promise<CloseShiftResult> {
  if (!isUuid(shiftId)) throw new ShiftError("no_active_shift", 404);
  const parsed = parseShiftCloseInput(
    { countedCash: closingFloat, reason: options.reason ?? null },
    { requireReasonWhenUncounted: true },
  );
  if (!parsed.ok) throw new ShiftError(parsed.error, 400);
  return closeShiftRow({ id: shiftId }, businessId, actorId, parsed.value, actorRole, {
    admin: true,
    allowedLocationIds: options.allowedLocationIds,
    requestId: options.requestId,
  });
}

/** Records a cash movement against an open shift (#933 items 2 and 3). */
export async function recordCashMovement(input: {
  businessId: string;
  shiftId: string;
  actorId: string | null;
  direction: "in" | "out";
  amount: number;
  reason: string;
  allowedLocationIds?: readonly string[] | null;
  /** When set, the shift must belong to this employee (a self-service caller). */
  employeeId?: string;
}): Promise<{ id: string; direction: "in" | "out"; amount: number; reason: string }> {
  const { businessId, shiftId, actorId, direction, amount, reason } = input;
  if (!isUuid(shiftId)) throw new ShiftError("shift_not_found", 404);
  if (direction !== "in" && direction !== "out") throw new ShiftError("bad_request", 400);
  if (!isValidCashFloat(amount) || amount <= 0) throw new ShiftError("invalid_amount", 400);
  const trimmed = reason.trim();
  if (!trimmed) throw new ShiftError("reason_required", 400);
  if (trimmed.length > MAX_SHIFT_REASON_LENGTH) throw new ShiftError("bad_request", 400);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; location_id: string | null; business_id: string; employee_id: string; ended_at: Date | null; branch_id: string | null }>(
      `SELECT s.id, s.location_id, s.business_id, s.employee_id, s.ended_at,
              ${shiftBranchExpression("s")} AS branch_id
         FROM employee_shifts s
        WHERE s.id = $1 AND s.business_id = $2
        FOR UPDATE OF s`,
      [shiftId, businessId],
    );
    const shift = rows[0];
    if (!shift) throw new ShiftError("shift_not_found", 404);
    if (input.allowedLocationIds !== undefined &&
        !isShiftInAllowedBranches(shift.branch_id, input.allowedLocationIds ?? null)) {
      throw new ShiftError("shift_not_found", 404);
    }
    if (shift.ended_at !== null) throw new ShiftError("shift_already_closed", 409);
    if (input.employeeId && shift.employee_id !== input.employeeId) {
      throw new ShiftError("shift_not_found", 404);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO shift_cash_movements (business_id, location_id, shift_id, direction, amount, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [businessId, shift.location_id, shiftId, direction, amount, trimmed, actorId],
    );
    await auditShift(client, businessId, actorId, "shift.cash_movement", shiftId, {
      movementId: inserted.rows[0]?.id ?? null,
      direction,
      amount,
      reason: trimmed,
    });
    await client.query("COMMIT");
    return { id: inserted.rows[0]!.id, direction, amount, reason: trimmed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * An audited correction to a finalized variance (#933 item 2).
 *
 * The cash-up row itself is never updated — migration 0233's trigger refuses
 * it. This records a linked adjustment with before/after values, a mandatory
 * reason and the actor, so the history shows the correction as its own event.
 */
export async function adjustShiftCashup(input: {
  businessId: string;
  shiftId: string;
  actorId: string | null;
  /** The actor's role at the time of the request — not hard-coded. */
  actorRole?: Role;
  delta: number;
  reason: string;
  allowedLocationIds?: readonly string[] | null;
}): Promise<{ adjustment: ShiftCashupAdjustment; cashup: ShiftCashup }> {
  const { businessId, shiftId, actorId, delta } = input;
  const actorRole: Role = input.actorRole ?? "manager";
  if (!isUuid(shiftId)) throw new ShiftError("shift_not_found", 404);
  if (!Number.isSafeInteger(delta) || delta === 0) throw new ShiftError("invalid_amount", 400);
  const reason = input.reason.trim();
  if (!reason) throw new ShiftError("reason_required", 400);
  if (reason.length > MAX_SHIFT_REASON_LENGTH) throw new ShiftError("bad_request", 400);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CashupRow>(
      `${CASHUP_SELECT}
        WHERE sc.shift_id = $1 AND sc.business_id = $2
        FOR UPDATE OF sc`,
      [shiftId, businessId],
    );
    const row = rows[0];
    if (!row) throw new ShiftError("cashup_not_found", 404);
    const attributed = await client.query<{ branch_id: string | null }>(
      `SELECT ${shiftBranchExpression("s")} AS branch_id FROM employee_shifts s WHERE s.id = $1`,
      [shiftId],
    );
    if (input.allowedLocationIds !== undefined &&
        !isShiftInAllowedBranches(attributed.rows[0]?.branch_id ?? null, input.allowedLocationIds ?? null)) {
      throw new ShiftError("cashup_not_found", 404);
    }

    const cashup = toCashup(row as CashupRow);
    // Chain from the latest correction's afterVariance, not the original snapshot.
    const latest = await client.query<{ after_variance: string | null }>(
      `SELECT after_variance FROM shift_cashup_adjustments
        WHERE cashup_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [cashup.id],
    );
    const baseVariance =
      latest.rows[0] !== undefined
        ? latest.rows[0].after_variance === null
          ? null
          : Number(latest.rows[0].after_variance)
        : cashup.variance;
    const change = applyVarianceAdjustment(baseVariance, delta);
    const inserted = await client.query<{ id: string; created_at: Date; created_by_name: string | null }>(
      `INSERT INTO shift_cashup_adjustments
         (business_id, location_id, cashup_id, shift_id, before_variance, after_variance, delta, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at, (SELECT full_name FROM users WHERE id = $9) AS created_by_name`,
      [
        businessId,
        cashup.locationId,
        cashup.id,
        shiftId,
        change.beforeVariance,
        change.afterVariance,
        change.delta,
        reason,
        actorId,
      ],
    );
    await auditShift(client, businessId, actorId, "shift.cashup_adjusted", shiftId, {
      cashupId: cashup.id,
      adjustmentId: inserted.rows[0]?.id ?? null,
      beforeVariance: change.beforeVariance,
      afterVariance: change.afterVariance,
      delta,
      reason,
    });
    // A correction the manager records on the till must reach the Cloud's copy
    // of the cash-up (issue #933's hybrid clause); it travels as its own event,
    // and the snapshot it corrects still never travels twice.
    await recordShiftAdjustmentSyncEvent(client, {
      businessId,
      locationId: cashup.locationId,
      shiftId,
      actor: { userId: actorId, role: actorRole },
      payload: {
        adjustmentId: inserted.rows[0]!.id,
        shiftId,
        delta,
        beforeVariance: change.beforeVariance,
        afterVariance: change.afterVariance,
        reason,
        createdAt: inserted.rows[0]!.created_at.toISOString(),
      },
    });
    await client.query("COMMIT");
    return {
      adjustment: {
        id: inserted.rows[0]!.id,
        beforeVariance: change.beforeVariance,
        afterVariance: change.afterVariance,
        delta: change.delta,
        reason,
        createdBy: actorId,
        createdByName: inserted.rows[0]!.created_by_name,
        createdAt: inserted.rows[0]!.created_at.toISOString(),
      },
      cashup,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface ShiftListEntry extends EmployeeShift {
  employeeName: string;
  /** The branch the shift was worked at, when it recorded one — a business with several needs to tell them apart. */
  locationName: string | null;
  /** The finalized snapshot's figures when there is one, otherwise the live read. */
  cashSummary: ShiftCashSummary;
  /** Drawer reconciliation from the snapshot (finalized) or computed live (open/legacy). */
  reconciliation: CashDrawerReconciliation;
  /** Non-null only once a cash-up was recorded. */
  cashup: ShiftCashup | null;
  /** "finalized" = read from the immutable snapshot; "live" = still open or legacy. */
  cashSource: "finalized" | "live";
  /** For a finalized shift, today's recomputation — shown beside, never instead of, the snapshot. */
  restated: { orderCount: number; grossTotal: number; cashTotal: number; variance: number | null } | null;
  adjustments: ShiftCashupAdjustment[];
  /** True when a finalized close has an audit adjustment attached. */
  hasAdjustments: boolean;
}

interface ShiftListRow extends Record<string, unknown>, CashSummaryRow {
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
  close_mode: ShiftCloseMode | null;
  employee_name: string;
  location_name: string | null;
  movements_in: string;
  movements_out: string;
  cashup_id: string | null;
  cashup_location_id: string | null;
  cashup_mode: ShiftCloseMode | null;
  cashup_reason: string | null;
  cashup_closed_by: string | null;
  cashup_closed_by_name: string | null;
  cashup_opening_float: string | null;
  cashup_expected_cash: string | null;
  cashup_counted_cash: string | null;
  cashup_variance: string | null;
  cashup_cash_in: string | null;
  cashup_cash_out: string | null;
  cashup_order_count: number | null;
  cashup_gross_total: string | null;
  cashup_tender_cash: string | null;
  cashup_tender_card: string | null;
  cashup_tender_card_to_card: string | null;
  cashup_tender_online: string | null;
  cashup_tender_credit: string | null;
  cashup_tender_snappfood: string | null;
  cashup_tender_cheque: string | null;
  cashup_tender_other: string | null;
  cashup_created_at: Date | null;
  adjustments: { id: string; beforeVariance: number | null; afterVariance: number | null; delta: number | null; reason: string; createdBy: string | null; createdByName: string | null; createdAt: string }[] | null;
}

/** What the admin review tab may narrow its history by. */
export interface ShiftListFilters {
  employeeId?: string;
  /** One branch. Legacy rows are attributed through `app_shift_attribution_branch`. */
  locationId?: string;
  /** The caller's reachable branches (#933 item 5). Null/omitted means no branch restriction. */
  locationIds?: readonly string[] | null;
  /** "open" = still clocked in, "closed" = cashed up. Omitted means both. */
  status?: "open" | "closed";
  /** Business-date range, inclusive (the branch's own day, not the calendar's). */
  from?: string;
  to?: string;
  /** One shift by id — a direct lookup from a notification or an audit row. */
  shiftId?: string;
  /** Only finalized shifts whose counted drawer did not match. */
  onlyVariance?: boolean;
  /** Only shifts closed without a count (including legacy closes with no floats). */
  onlyUnresolved?: boolean;
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

function cashupFromListRow(row: ShiftListRow): ShiftCashup | null {
  if (!row.cashup_id) return null;
  const cashupRow: CashupRow = {
    id: row.cashup_id,
    shift_id: row.id,
    location_id: row.cashup_location_id,
    close_mode: row.cashup_mode ?? "unresolved",
    close_reason: row.cashup_reason,
    closed_by: row.cashup_closed_by,
    closed_by_name: row.cashup_closed_by_name,
    opening_float: row.cashup_opening_float,
    expected_cash: row.cashup_expected_cash,
    counted_cash: row.cashup_counted_cash,
    variance: row.cashup_variance,
    cash_in: row.cashup_cash_in ?? "0",
    cash_out: row.cashup_cash_out ?? "0",
    order_count: row.cashup_order_count ?? 0,
    gross_total: row.cashup_gross_total ?? "0",
    tender_cash: row.cashup_tender_cash ?? "0",
    tender_card: row.cashup_tender_card ?? "0",
    tender_card_to_card: row.cashup_tender_card_to_card ?? "0",
    tender_online: row.cashup_tender_online ?? "0",
    tender_credit: row.cashup_tender_credit ?? "0",
    tender_snappfood: row.cashup_tender_snappfood ?? "0",
    tender_cheque: row.cashup_tender_cheque ?? "0",
    tender_other: row.cashup_tender_other ?? "0",
    created_at: row.cashup_created_at ?? row.ended_at ?? row.started_at,
  };
  return toCashup(cashupRow);
}

function shiftEntryFromRow(row: ShiftListRow): ShiftListEntry {
  const shift = toShift(row as ShiftRow);
  const liveSummary = toCashSummary(row, {
    in: numberValue(row.movements_in),
    out: numberValue(row.movements_out),
  });
  const cashup = cashupFromListRow(row);
  const adjustments = (row.adjustments ?? []).map((adjustment) => ({
    id: adjustment.id,
    beforeVariance: adjustment.beforeVariance,
    afterVariance: adjustment.afterVariance,
    delta: adjustment.delta,
    reason: adjustment.reason,
    createdBy: adjustment.createdBy,
    createdByName: adjustment.createdByName,
    createdAt: adjustment.createdAt,
  }));

  if (cashup) {
    const snapshotSummary = cashupSummary(cashup);
    return {
      ...shift,
      employeeName: row.employee_name,
      locationName: row.location_name,
      cashSummary: snapshotSummary,
      reconciliation: {
        expectedCash: cashup.expectedCash,
        variance: cashup.variance,
        status: drawerStatusFor(cashup.closeMode, cashup.variance),
      },
      cashup,
      cashSource: "finalized",
      restated: {
        orderCount: liveSummary.orderCount,
        grossTotal: liveSummary.grossTotal,
        cashTotal: liveSummary.cashTotal,
        variance:
          shift.closingFloat !== null && shift.openingFloat !== null
            ? shift.closingFloat -
              (shift.openingFloat + liveSummary.cashTotal + liveSummary.cashMovementsIn - liveSummary.cashMovementsOut)
            : null,
      },
      adjustments,
      hasAdjustments: adjustments.length > 0,
    };
  }

  const reconciliation = reconcileDrawer({
    openingFloat: shift.openingFloat,
    cashSales: liveSummary.cashTotal,
    cashIn: liveSummary.cashMovementsIn,
    cashOut: liveSummary.cashMovementsOut,
    countedCash: shift.endedAt ? shift.closingFloat : null,
  });
  return {
    ...shift,
    employeeName: row.employee_name,
    locationName: row.location_name,
    cashSummary: liveSummary,
    reconciliation,
    cashup: null,
    cashSource: "live",
    restated: null,
    adjustments: [],
    hasAdjustments: false,
  };
}

/**
 * Shift history for the admin review tab, most recent first.
 *
 * Each row's cash summary comes from its finalized snapshot when it has one and
 * from a live LATERAL aggregate otherwise, so the list cannot disagree with the
 * shift's own cash-up (#933 item 2). Paged with a stable `(started_at, id)`
 * order: an offset page over `started_at DESC` alone could duplicate or skip
 * rows when two shifts started in the same second (#933 item 12).
 *
 * Branch scoping is the caller's reachable branches (`locationIds`) and, when a
 * single branch is requested, the attribution rule from
 * `shift-branch-scope.ts` — never `OR location_id IS NULL` (#933 items 5, 6).
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
  if (filters.shiftId) {
    if (!isUuid(filters.shiftId)) return { shifts: [], hasMore: false };
    params.push(filters.shiftId);
    conditions.push(`s.id = $${params.length}`);
  }
  if (filters.locationId) {
    if (!isUuid(filters.locationId)) return { shifts: [], hasMore: false };
    params.push(filters.locationId);
    conditions.push(`${shiftBranchExpression("s")} = $${params.length}`);
  }
  if (filters.locationIds && filters.locationIds.length > 0) {
    const allowed = filters.locationIds.filter((id) => isUuid(id));
    if (allowed.length === 0) return { shifts: [], hasMore: false };
    params.push(allowed);
    conditions.push(`${shiftBranchExpression("s")} = ANY($${params.length}::uuid[])`);
  } else if (filters.locationIds && filters.locationIds.length === 0) {
    // A caller with no reachable branch sees no history — not the whole tenant.
    return { shifts: [], hasMore: false };
  }
  if (filters.status === "open") conditions.push("s.ended_at IS NULL");
  if (filters.status === "closed") conditions.push("s.ended_at IS NOT NULL");
  if (filters.from) {
    if (!isValidIsoDate(filters.from)) return { shifts: [], hasMore: false };
    params.push(filters.from);
    conditions.push(`s.business_date >= $${params.length}::date`);
  }
  if (filters.to) {
    if (!isValidIsoDate(filters.to)) return { shifts: [], hasMore: false };
    params.push(filters.to);
    conditions.push(`s.business_date <= $${params.length}::date`);
  }
  if (filters.onlyVariance) {
    conditions.push("sc.variance IS NOT NULL AND sc.variance <> 0");
  }
  if (filters.onlyUnresolved) {
    conditions.push(
      `(sc.close_mode = 'unresolved' OR (sc.id IS NULL AND s.ended_at IS NOT NULL AND (s.opening_float IS NULL OR s.closing_float IS NULL)))`,
    );
  }

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
            s.opening_float, s.closing_float, s.business_date, s.started_at, s.ended_at,
            s.closed_by, s.close_mode,
            u.full_name AS employee_name,
            l.name AS location_name,
            coalesce(live.order_count, 0) AS order_count,
            coalesce(live.gross_total, 0) AS gross_total,
            coalesce(live.cash_total, 0) AS cash_total,
            coalesce(live.card_total, 0) AS card_total,
            coalesce(live.card_to_card_total, 0) AS card_to_card_total,
            coalesce(live.online_total, 0) AS online_total,
            coalesce(live.credit_total, 0) AS credit_total,
            coalesce(live.snappfood_total, 0) AS snappfood_total,
            coalesce(live.cheque_total, 0) AS cheque_total,
            coalesce(live.other_total, 0) AS other_total,
            coalesce(live.tendered_total, 0) AS tendered_total,
            coalesce(mov.movements_in, 0) AS movements_in,
            coalesce(mov.movements_out, 0) AS movements_out,
            sc.id AS cashup_id,
            sc.location_id AS cashup_location_id,
            sc.close_mode AS cashup_mode,
            sc.close_reason AS cashup_reason,
            sc.closed_by AS cashup_closed_by,
            cu.full_name AS cashup_closed_by_name,
            sc.opening_float AS cashup_opening_float,
            sc.expected_cash AS cashup_expected_cash,
            sc.counted_cash AS cashup_counted_cash,
            sc.variance AS cashup_variance,
            sc.cash_in AS cashup_cash_in,
            sc.cash_out AS cashup_cash_out,
            sc.order_count AS cashup_order_count,
            sc.gross_total AS cashup_gross_total,
            sc.tender_cash AS cashup_tender_cash,
            sc.tender_card AS cashup_tender_card,
            sc.tender_card_to_card AS cashup_tender_card_to_card,
            sc.tender_online AS cashup_tender_online,
            sc.tender_credit AS cashup_tender_credit,
            sc.tender_snappfood AS cashup_tender_snappfood,
            sc.tender_cheque AS cashup_tender_cheque,
            sc.tender_other AS cashup_tender_other,
            sc.created_at AS cashup_created_at,
            adj.adjustments
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
       LEFT JOIN locations l ON l.id = s.location_id
       LEFT JOIN shift_cashups sc ON sc.shift_id = s.id
       LEFT JOIN users cu ON cu.id = sc.closed_by
       LEFT JOIN LATERAL (
         ${cashSummarySelect(
           SHIFT_CASH_WINDOW("s.started_at", "coalesce(s.ended_at, now())", "s.employee_id"),
         )}
       ) live ON true
       LEFT JOIN LATERAL (
         SELECT coalesce(sum(m.amount) FILTER (WHERE m.direction = 'in'), 0)  AS movements_in,
                coalesce(sum(m.amount) FILTER (WHERE m.direction = 'out'), 0) AS movements_out
           FROM shift_cash_movements m
          WHERE m.shift_id = s.id
       ) mov ON true
       LEFT JOIN LATERAL (
         SELECT coalesce(json_agg(json_build_object(
                  'id', a.id,
                  'beforeVariance', a.before_variance,
                  'afterVariance', a.after_variance,
                  'delta', a.delta,
                  'reason', a.reason,
                  'createdBy', a.created_by,
                  'createdByName', au.full_name,
                  'createdAt', a.created_at
                ) ORDER BY a.created_at, a.id), '[]'::json) AS adjustments
           FROM shift_cashup_adjustments a
           LEFT JOIN users au ON au.id = a.created_by
          WHERE a.cashup_id = sc.id
       ) adj ON true
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  const hasMore = rows.length > limit;
  return {
    shifts: rows.slice(0, limit).map(shiftEntryFromRow),
    hasMore,
  };
}

export interface ShiftHistoryFilterOptions {
  locations: { id: string; name: string }[];
  employees: { id: string; name: string }[];
}

/**
 * The values the history screen's filters offer, already narrowed to the
 * caller's reachable branches. Employees are those who have ever worked a shift
 * here, which is what a reviewer wants — not the whole roster including people
 * who never clock in.
 */
export async function shiftHistoryFilterOptions(
  businessId: string,
  locationIds?: readonly string[] | null,
): Promise<ShiftHistoryFilterOptions> {
  const allowed =
    locationIds === undefined || locationIds === null
      ? null
      : locationIds.filter((id) => isUuid(id));
  if (allowed !== null && allowed.length === 0) return { locations: [], employees: [] };

  const { rows: locations } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations
      WHERE business_id = $1
      ${allowed ? "AND id = ANY($2::uuid[])" : ""}
      ORDER BY created_at`,
    allowed ? [businessId, allowed] : [businessId],
  );
  const { rows: employees } = await query<{ id: string; name: string }>(
    `SELECT DISTINCT u.id, coalesce(nullif(btrim(u.full_name), ''), 'بدون نام') AS name
       FROM employee_shifts s
       JOIN users u ON u.id = s.employee_id
      WHERE s.business_id = $1
        ${allowed ? `AND ${shiftBranchExpression("s")} = ANY($2::uuid[])` : ""}
      ORDER BY name`,
    allowed ? [businessId, allowed] : [businessId],
  );
  return { locations, employees };
}
