import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
export class AgencyReservationError extends Error {
  constructor(
    readonly code:
      "invalid_reservation" | "reservation_conflict" | "resource_unavailable",
  ) {
    super(code);
  }
}
export interface ReservationInput {
  taskId: string;
  workerId: string;
  startAt: string;
  endAt: string;
  note: string;
  status: "reserved" | "cancelled";
  supersedesId: string | null;
  requestId: string;
}
/** Explicit offset, minute precision; never interpret a naive browser-local time. */
export function reservationInstant(value: unknown): string {
  if (typeof value !== "string")
    throw new AgencyReservationError("invalid_reservation");
  const m =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00(?:\.000)?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (
    !m ||
    !isValidIsoDate(m[1]) ||
    Number(m[2]) > 23 ||
    Number(m[3]) > 59 ||
    (m[4] !== "Z" &&
      (Number(m[5]) > 14 ||
        Number(m[6]) > 59 ||
        (m[5] === "14" && m[6] !== "00")))
  )
    throw new AgencyReservationError("invalid_reservation");
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()))
    throw new AgencyReservationError("invalid_reservation");
  const iso = instant.toISOString();
  if (!/^\d{4}-/.test(iso) || Number(iso.slice(0, 4)) < 1)
    throw new AgencyReservationError("invalid_reservation");
  return iso;
}
export function readReservation(
  input: Record<string, unknown>,
): ReservationInput {
  if (
    !isUuid(input.taskId) ||
    !isUuid(input.workerId) ||
    !isUuid(input.requestId) ||
    typeof input.note !== "string" ||
    !input.note.trim() ||
    input.note.trim().length > 1000 ||
    (input.status !== "reserved" && input.status !== "cancelled") ||
    (input.supersedesId != null && !isUuid(input.supersedesId)) ||
    (!input.supersedesId && input.status === "cancelled")
  )
    throw new AgencyReservationError("invalid_reservation");
  const startAt = reservationInstant(input.startAt),
    endAt = reservationInstant(input.endAt);
  const minutes = (Date.parse(endAt) - Date.parse(startAt)) / 60000;
  if (minutes <= 0 || minutes > 1440)
    throw new AgencyReservationError("invalid_reservation");
  return {
    taskId: input.taskId,
    workerId: input.workerId,
    requestId: input.requestId,
    note: input.note.trim(),
    status: input.status as ReservationInput["status"],
    supersedesId:
      typeof input.supersedesId === "string" ? input.supersedesId : null,
    startAt,
    endAt,
  };
}
export function reservationWindow(search: URLSearchParams) {
  const from = search.get("from"),
    to = search.get("to"),
    raw = search.get("offset") ?? "0",
    offset = Number(raw);
  if (
    !isValidIsoDate(from) ||
    !isValidIsoDate(to) ||
    from > to ||
    Date.parse(to) - Date.parse(from) > 92 * 86400000 ||
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new AgencyReservationError("invalid_reservation");
  return { from, to, offset };
}
