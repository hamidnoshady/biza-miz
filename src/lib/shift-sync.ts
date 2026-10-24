/**
 * Phase 45 — shifts cross between a Hybrid desktop and the cloud.
 *
 * The desktop is the till, so clocking in and the cash-up happen there, and
 * the cloud's shift reports need them. Each event carries the whole row; the
 * receiver upserts it by id, so a replay is idempotent and an `opened` that
 * arrives after its `closed` changes nothing. The session and device are
 * device-local and never travel.
 *
 * ## Issue #933 — the cash-up travels too
 *
 * A close used to carry only `ended_at` and the counted float, which meant a
 * Cloud report recomputed the variance from its own copy of the payments — a
 * different number from the one the till signed off whenever the two sides had
 * seen different amendments. Schema version 2 carries the immutable snapshot
 * (tender totals, expected/counted/variance, cash movements, close mode and
 * reason), and the receiver stores it with `ON CONFLICT DO NOTHING` so a replay
 * can never rewrite it.
 *
 * Version 1 remains registered and accepted: an in-flight event from a desktop
 * that has not updated yet still applies, exactly as it did before. New events
 * are always written as v2.
 *
 * Nothing device-local is added: no session id, no device credential, no device
 * token. The branch is the event's own location, which the sync layer already
 * scopes and authorizes — putting it in the payload would duplicate an identity
 * the receiver must not take from the sender.
 */
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import type { EmployeeShift } from "./shift-service";
import { isValidIsoDate } from "./iso-date";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { isUuid } from "./uuid";
import type { ShiftCloseMode, ShiftTenderTotals } from "./shift-cashup";
import { emptyTenderTotals } from "./shift-cashup";

export type ShiftSyncEventType = "shift.opened" | "shift.closed";

/** The current wire version for both shift events. */
export const SHIFT_SYNC_SCHEMA_VERSION = 2 as const;

export interface ShiftCashupSync {
  closeMode: ShiftCloseMode;
  reason: string | null;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
  cashIn: number;
  cashOut: number;
  orderCount: number;
  grossTotal: number;
  tenders: ShiftTenderTotals;
}

export interface ShiftSyncPayload {
  shiftId: string;
  employeeId: string;
  businessDate: string;
  openingFloat: number | null;
  closingFloat: number | null;
  closeMode: ShiftCloseMode | null;
  startedAt: string;
  endedAt: string | null;
  closedBy: string | null;
  /** Schema v2 only; absent (or null) on an open event and on a v1 close. */
  cashup?: ShiftCashupSync | null;
}

export function shiftSyncPayload(shift: EmployeeShift, cashup?: ShiftCashupSync | null): ShiftSyncPayload {
  return {
    shiftId: shift.id,
    employeeId: shift.employeeId,
    businessDate: shift.businessDate,
    openingFloat: shift.openingFloat,
    closingFloat: shift.closingFloat,
    closeMode: shift.closeMode,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    closedBy: shift.closedBy,
    ...(cashup ? { cashup } : {}),
  };
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO-8601 instant on a real calendar date. Anything looser reaches the
 * timestamptz cast as a 22xxx error, which the sync classes transient and
 * retries forever.
 */
function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_INSTANT.exec(value);
  return match && isValidIsoDate(match[1]) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** A float in integer Rial, null, or `undefined` when invalid. */
function float(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A tender amount: integer Rial of either sign (a refund row is negative). */
function tender(value: unknown): number | undefined {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function cashupPayload(value: unknown): ShiftCashupSync | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const closeMode = raw.closeMode;
  if (closeMode !== "counted" && closeMode !== "unresolved") return undefined;

  const expectedCash = float(raw.expectedCash);
  const countedCash = float(raw.countedCash);
  const cashIn = tender(raw.cashIn) ?? undefined;
  const cashOut = tender(raw.cashOut) ?? undefined;
  const orderCount = raw.orderCount;
  const grossTotal = raw.grossTotal;
  if (expectedCash === undefined || countedCash === undefined) return undefined;
  if (cashIn === undefined || cashOut === undefined || cashIn < 0 || cashOut < 0) return undefined;
  if (typeof orderCount !== "number" || !Number.isSafeInteger(orderCount) || orderCount < 0) return undefined;
  if (typeof grossTotal !== "number" || !Number.isSafeInteger(grossTotal)) return undefined;

  let variance: number | null = null;
  if (raw.variance !== null && raw.variance !== undefined) {
    if (typeof raw.variance !== "number" || !Number.isSafeInteger(raw.variance)) return undefined;
    variance = raw.variance;
  }
  // The database CHECK constraint refuses an unresolved close that carries a
  // count or a variance; refuse it here so the event becomes a payload error
  // instead of a 23514 retried forever.
  if (closeMode === "unresolved" && (countedCash !== null || variance !== null)) return undefined;
  if (closeMode === "counted" && countedCash === null) return undefined;

  let reason: string | null = null;
  if (raw.reason !== null && raw.reason !== undefined) {
    if (typeof raw.reason !== "string" || raw.reason.length > 500) return undefined;
    reason = raw.reason.trim() || null;
  }

  const tendersRaw = raw.tenders;
  if (typeof tendersRaw !== "object" || tendersRaw === null || Array.isArray(tendersRaw)) return undefined;
  const tenders = emptyTenderTotals();
  for (const key of ["cash", "card", "cardToCard", "online", "credit", "snappfood", "cheque", "other"] as const) {
    const parsed = tender((tendersRaw as Record<string, unknown>)[key]);
    if (parsed === undefined) return undefined;
    tenders[key] = parsed;
  }
  // Recompute the total from the classes; a sender's total is not trusted.
  tenders.total =
    tenders.cash + tenders.card + tenders.cardToCard + tenders.online + tenders.credit +
    tenders.snappfood + tenders.cheque + tenders.other;

  return { closeMode, reason, expectedCash, countedCash, variance, cashIn, cashOut, orderCount, grossTotal, tenders };
}

export function parseShiftSyncPayload(raw: Record<string, unknown>): ShiftSyncPayload | null {
  if (!isUuid(raw.shiftId) || !isUuid(raw.employeeId)) return null;
  if (!isValidIsoDate(raw.businessDate)) return null;
  const startedAt = instant(raw.startedAt);
  if (!startedAt) return null;
  let endedAt: string | null = null;
  if (raw.endedAt !== null && raw.endedAt !== undefined) {
    endedAt = instant(raw.endedAt);
    if (!endedAt || Date.parse(endedAt) < Date.parse(startedAt)) return null;
  }
  const openingFloat = float(raw.openingFloat);
  const closingFloat = float(raw.closingFloat);
  if (openingFloat === undefined || closingFloat === undefined) return null;
  let closedBy: string | null = null;
  if (raw.closedBy !== null && raw.closedBy !== undefined) {
    if (!isUuid(raw.closedBy)) return null;
    closedBy = raw.closedBy;
  }
  let closeMode: ShiftCloseMode | null = null;
  if (raw.closeMode !== null && raw.closeMode !== undefined) {
    if (raw.closeMode !== "counted" && raw.closeMode !== "unresolved") return null;
    closeMode = raw.closeMode;
  }
  const cashup = cashupPayload(raw.cashup);
  if (cashup === undefined) return null;

  // A closed event that carries a snapshot must agree with it: the column and
  // the snapshot are read by different screens, and a payload where they
  // disagree would make one of them lie.
  if (cashup) {
    if (endedAt === null) return null;
    if (closeMode !== null && closeMode !== cashup.closeMode) return null;
    closeMode = cashup.closeMode;
    if (closingFloat !== null && cashup.countedCash !== null && closingFloat !== cashup.countedCash) return null;
  }

  return {
    shiftId: raw.shiftId,
    employeeId: raw.employeeId,
    businessDate: raw.businessDate,
    openingFloat,
    closingFloat,
    closeMode,
    startedAt,
    endedAt,
    closedBy,
    ...(cashup ? { cashup } : {}),
  };
}

/** The shift's own id names both events, so a retried request is one event. */
export function shiftSyncClientEventId(type: ShiftSyncEventType, shiftId: string): string {
  return `${type}:${shiftId}`;
}

/** Called inside the transaction that opened or closed the shift. */
export async function recordShiftSyncEvent(
  client: PoolClient,
  type: ShiftSyncEventType,
  shift: EmployeeShift,
  actor: { userId: string | null; role: Role },
  cashup?: ShiftCashupSync | null,
): Promise<void> {
  // A shift with no branch cannot be routed to a peer; it stays local.
  if (!shift.locationId) return;
  await appendSyncOutboxEvent(client, {
    locationId: shift.locationId,
    clientEventId: shiftSyncClientEventId(type, shift.id),
    eventType: type,
    payload: { ...shiftSyncPayload(shift, cashup) },
    actorUserId: actor.userId,
    actorRole: actor.role,
    occurredAt: type === "shift.closed" ? (shift.endedAt ?? shift.startedAt) : shift.startedAt,
    schemaVersion: SHIFT_SYNC_SCHEMA_VERSION,
  });
}

/**
 * The receiver's side: upsert the row by id, then the cash-up snapshot.
 *
 * Returns the shift id. The shift upsert keeps the old "closed wins" rule — a
 * late `opened` cannot reopen a shift — and the snapshot uses `DO NOTHING`, so
 * a replayed close can never rewrite a finalized cash-up.
 */
export async function applyShiftReplay(
  client: PoolClient,
  businessId: string,
  locationId: string,
  shift: ShiftSyncPayload,
): Promise<string> {
  // employee_shifts references employees(id), which is keyed on the member's
  // user id; staff sync brings the user, this brings the employee row.
  await client.query(
    `INSERT INTO employees (id, business_id)
     SELECT id, business_id FROM users WHERE id = $1 AND business_id = $2
     ON CONFLICT DO NOTHING`,
    [shift.employeeId, businessId],
  );
  const known = await client.query("SELECT 1 FROM employees WHERE id = $1 AND business_id = $2", [
    shift.employeeId,
    businessId,
  ]);
  if (known.rowCount !== 1) throw new Error("employee_not_found");
  await client.query("SAVEPOINT shift_replay");
  try {
    await client.query(
      `INSERT INTO employee_shifts
         (id, employee_id, business_id, location_id, opening_float, closing_float, close_mode,
          business_date, started_at, ended_at, closed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10,
               (SELECT id FROM users WHERE id = $11 AND business_id = $3))
       ON CONFLICT (id) DO UPDATE SET
         closing_float = COALESCE(employee_shifts.closing_float, EXCLUDED.closing_float),
         ended_at      = COALESCE(employee_shifts.ended_at, EXCLUDED.ended_at),
         closed_by     = COALESCE(employee_shifts.closed_by, EXCLUDED.closed_by),
         close_mode    = COALESCE(employee_shifts.close_mode, EXCLUDED.close_mode)`,
      [
        shift.shiftId,
        shift.employeeId,
        businessId,
        locationId,
        shift.openingFloat,
        shift.closingFloat,
        shift.closeMode,
        shift.businessDate,
        shift.startedAt,
        shift.endedAt,
        shift.closedBy,
      ],
    );
    if (shift.cashup && shift.endedAt) {
      const c = shift.cashup;
      await client.query(
        `INSERT INTO shift_cashups
           (business_id, location_id, shift_id, employee_id, business_date, started_at, ended_at,
            closed_by, close_mode, close_reason, opening_float, expected_cash, counted_cash, variance,
            cash_in, cash_out, order_count, gross_total,
            tender_cash, tender_card, tender_card_to_card, tender_online, tender_credit,
            tender_snappfood, tender_cheque, tender_other, breakdown)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7,
                 (SELECT id FROM users WHERE id = $8 AND business_id = $1), $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb)
         ON CONFLICT (shift_id) DO NOTHING`,
        [
          businessId,
          locationId,
          shift.shiftId,
          shift.employeeId,
          shift.businessDate,
          shift.startedAt,
          shift.endedAt,
          shift.closedBy,
          c.closeMode,
          c.reason,
          shift.openingFloat,
          c.expectedCash,
          c.countedCash,
          c.variance,
          c.cashIn,
          c.cashOut,
          c.orderCount,
          c.grossTotal,
          c.tenders.cash,
          c.tenders.card,
          c.tenders.cardToCard,
          c.tenders.online,
          c.tenders.credit,
          c.tenders.snappfood,
          c.tenders.cheque,
          c.tenders.other,
          JSON.stringify({ tenders: c.tenders, closeMode: c.closeMode, source: "sync" }),
        ],
      );
    }
    await client.query("RELEASE SAVEPOINT shift_replay");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT shift_replay");
    // idx_employee_shifts_employee_open: this person already has an open shift
    // on this side. Not a missing prerequisite; the owner has to see it.
    if ((error as { code?: string }).code === "23505") throw new Error("shift_already_open");
    throw error;
  }
  return shift.shiftId;
}


/**
 * Issue #933 — an audited correction to a finalized cash-up, as its own event.
 *
 * The snapshot itself never travels twice (`shift.closed` is insert-once), but a
 * correction recorded on the till after the close is a fact the cloud needs: a
 * manager reading the variance there must see the same correction the desktop
 * recorded. The event names the adjustment by id, so a replay is one row.
 *
 * `cashup_not_found` is a *deferred* dependency, not a terminal error: an
 * adjustment can be queued before its close has been delivered.
 */
export interface ShiftAdjustmentSyncPayload {
  adjustmentId: string;
  shiftId: string;
  delta: number;
  beforeVariance: number | null;
  afterVariance: number | null;
  reason: string;
  createdAt: string;
}

export function parseShiftAdjustmentSyncPayload(
  raw: Record<string, unknown>,
): ShiftAdjustmentSyncPayload | null {
  if (!isUuid(raw.adjustmentId) || !isUuid(raw.shiftId)) return null;
  if (typeof raw.delta !== "number" || !Number.isSafeInteger(raw.delta) || raw.delta === 0) return null;
  const nullableInt = (value: unknown): number | null | undefined => {
    if (value === null || value === undefined) return null;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
  };
  const beforeVariance = nullableInt(raw.beforeVariance);
  const afterVariance = nullableInt(raw.afterVariance);
  if (beforeVariance === undefined || afterVariance === undefined) return null;
  if (typeof raw.reason !== "string") return null;
  const reason = raw.reason.trim();
  if (!reason || reason.length > 500) return null;
  const createdAt = instant(raw.createdAt);
  if (!createdAt) return null;
  return { adjustmentId: raw.adjustmentId, shiftId: raw.shiftId, delta: raw.delta, beforeVariance, afterVariance, reason, createdAt };
}

/** Called inside the transaction that recorded the correction. */
export async function recordShiftAdjustmentSyncEvent(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string | null;
    shiftId: string;
    actor: { userId: string | null; role: Role };
    payload: ShiftAdjustmentSyncPayload;
  },
): Promise<void> {
  if (!input.locationId) return;
  await appendSyncOutboxEvent(client, {
    locationId: input.locationId,
    clientEventId: `shift.cashup.adjusted:${input.payload.adjustmentId}`,
    eventType: "shift.cashup.adjusted",
    payload: { ...input.payload },
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    occurredAt: input.payload.createdAt,
    schemaVersion: 1,
  });
}

/** The receiver's side: insert the correction once, linked to the stored cash-up. */
export async function applyShiftAdjustmentReplay(
  client: PoolClient,
  businessId: string,
  locationId: string,
  adjustment: ShiftAdjustmentSyncPayload,
): Promise<string> {
  const cashup = await client.query<{ id: string }>(
    "SELECT id FROM shift_cashups WHERE shift_id = $1 AND business_id = $2",
    [adjustment.shiftId, businessId],
  );
  if (!cashup.rows[0]) throw new Error("cashup_not_found");
  await client.query(
    `INSERT INTO shift_cashup_adjustments
       (id, business_id, location_id, cashup_id, shift_id, before_variance, after_variance, delta, reason, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             (SELECT id FROM users WHERE id = $10 AND business_id = $2), $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      adjustment.adjustmentId,
      businessId,
      locationId,
      cashup.rows[0].id,
      adjustment.shiftId,
      adjustment.beforeVariance,
      adjustment.afterVariance,
      adjustment.delta,
      adjustment.reason,
      null,
      adjustment.createdAt,
    ],
  );
  return adjustment.adjustmentId;
}
