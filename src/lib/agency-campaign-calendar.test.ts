import { describe, expect, it } from "vitest";
import { readCampaignCalendarWindow } from "./agency-campaign-calendar";
const read = (extra: Record<string, string> = {}) =>
  readCampaignCalendarWindow(
    new URLSearchParams({ start: "2026-10-01", end: "2026-10-31", ...extra }),
  );
describe("bounded campaign calendar window", () => {
  it("accepts a valid inclusive window with explicit paging", () =>
    expect(read({ offset: "100" })).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
      offset: 100,
      partyId: null,
    }));
  it("accepts a one-day/leap day and exactly 93 days", () => {
    expect(read({ start: "2028-02-29", end: "2028-02-29" }).start).toBe(
      "2028-02-29",
    );
    expect(read({ start: "2026-01-01", end: "2026-04-03" }).end).toBe(
      "2026-04-03",
    );
  });
  const invalid: Record<string, string>[] = [
    { start: "" },
    { start: "2026-02-29" },
    { end: "2026-09-30" },
    { end: "2027-01-02" },
    { offset: "-1" },
    { offset: "1.5" },
    { offset: "1e2" },
    { offset: "9007199254740992" },
    { partyId: "bad" },
    { partyId: "" },
  ];
  for (const extra of invalid)
    it(`refuses invalid window ${JSON.stringify(extra)}`, () =>
      expect(() => read(extra)).toThrow("invalid_calendar_window"));
});
