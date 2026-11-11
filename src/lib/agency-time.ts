import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
export class AgencyTimeError extends Error {
  constructor(
    readonly code: "invalid_time" | "time_conflict" | "time_forbidden",
  ) {
    super(code);
  }
}
export interface AgencyTimeInput {
  taskId: string;
  workDate: string;
  minutes: number;
  note: string;
  supersedesId: string | null;
  requestId: string;
}
export function readAgencyTime(
  input: Record<string, unknown>,
): AgencyTimeInput {
  if (
    !isUuid(input.taskId) ||
    !isUuid(input.requestId) ||
    !isValidIsoDate(input.workDate) ||
    typeof input.minutes !== "number" ||
    !Number.isInteger(input.minutes) ||
    input.minutes < 0 ||
    input.minutes > 1440 ||
    typeof input.note !== "string" ||
    !input.note.trim() ||
    input.note.trim().length > 1000 ||
    (input.supersedesId != null && !isUuid(input.supersedesId)) ||
    (!input.supersedesId && input.minutes === 0)
  )
    throw new AgencyTimeError("invalid_time");
  return {
    taskId: input.taskId,
    requestId: input.requestId,
    workDate: input.workDate,
    minutes: input.minutes,
    note: input.note.trim(),
    supersedesId:
      typeof input.supersedesId === "string" ? input.supersedesId : null,
  };
}
