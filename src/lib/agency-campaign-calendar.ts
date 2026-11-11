import { isValidIsoDate } from "./iso-date";

export interface CampaignCalendarWindow {
  start: string;
  end: string;
  offset: number;
  partyId: string | null;
}
export class CampaignCalendarError extends Error {
  constructor() {
    super("invalid_calendar_window");
  }
}
/** Bounded inclusive range, not a derived total from the legacy capped list. */
export function readCampaignCalendarWindow(
  search: URLSearchParams,
): CampaignCalendarWindow {
  const start = search.get("start"),
    end = search.get("end");
  const offsetText = search.get("offset") ?? "0";
  const offset = Number(offsetText);
  const partyId = search.get("partyId");
  if (
    !isValidIsoDate(start) ||
    !isValidIsoDate(end) ||
    start > end ||
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86400000 >
      92 ||
    !/^\d+$/.test(offsetText) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (partyId !== null &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(partyId))
  )
    throw new CampaignCalendarError();
  return { start, end, offset, partyId };
}
