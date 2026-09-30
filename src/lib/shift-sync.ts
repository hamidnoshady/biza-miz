/**
 * Phase 45 — shifts cross between a Hybrid desktop and the cloud.
 *
 * The desktop is the till, so clocking in and the cash-up happen there, and
 * the cloud's shift reports need them. Each event carries the whole row; the
 * receiver upserts it by id, so a replay is idempotent and an `opened` that
 * arrives after its `closed` changes nothing. The session and device are
 * device-local and never travel.
 */
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import type { EmployeeShift } from "./shift-service";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { isUuid } from "./uuid";

export type ShiftSyncEventType = "shift.opened" | "shift.closed";

export interface ShiftSyncPayload {
  shiftId: string;
  employeeId: string;
  businessDate: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
  closedBy: string | null;
}

export function shiftSyncPayload(shift: EmployeeShift): ShiftSyncPayload {
  return {
    shiftId: shift.id,
    employeeId: shift.employeeId,
    businessDate: shift.businessDate,
    openingFloat: shift.openingFloat,
    closingFloat: shift.closingFloat,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    closedBy: shift.closedBy,
  };
}

function instant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** A float in integer Rial, null, or `undefined` when invalid. */
function float(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseShiftSyncPayload(raw: Record<string, unknown>): ShiftSyncPayload | null {
  if (!isUuid(raw.shiftId) || !isUuid(raw.employeeId)) return null;
  if (typeof raw.businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.businessDate)) return null;
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
  return {
    shiftId: raw.shiftId,
    employeeId: raw.employeeId,
    businessDate: raw.businessDate,
    openingFloat,
    closingFloat,
    startedAt,
    endedAt,
    closedBy,
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
): Promise<void> {
  // A shift with no branch cannot be routed to a peer; it stays local.
  if (!shift.locationId) return;
  await appendSyncOutboxEvent(client, {
    locationId: shift.locationId,
    clientEventId: shiftSyncClientEventId(type, shift.id),
    eventType: type,
    payload: { ...shiftSyncPayload(shift) },
    actorUserId: actor.userId,
    actorRole: actor.role,
    occurredAt: type === "shift.closed" ? (shift.endedAt ?? shift.startedAt) : shift.startedAt,
  });
}

/** The receiver's side: upsert the row by id. Returns the shift id. */
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
         (id, employee_id, business_id, location_id, opening_float, closing_float,
          business_date, started_at, ended_at, closed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9,
               (SELECT id FROM users WHERE id = $10 AND business_id = $3))
       ON CONFLICT (id) DO UPDATE SET
         closing_float = COALESCE(employee_shifts.closing_float, EXCLUDED.closing_float),
         ended_at      = COALESCE(employee_shifts.ended_at, EXCLUDED.ended_at),
         closed_by     = COALESCE(employee_shifts.closed_by, EXCLUDED.closed_by)`,
      [
        shift.shiftId,
        shift.employeeId,
        businessId,
        locationId,
        shift.openingFloat,
        shift.closingFloat,
        shift.businessDate,
        shift.startedAt,
        shift.endedAt,
        shift.closedBy,
      ],
    );
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
