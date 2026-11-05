import { describe, expect, it } from "vitest";

import { AGENCY_BRIEF_CHANNELS, AGENCY_BRIEF_CHANNEL_LIMIT } from "./agency-brief";
import {
  AGENCY_CAMPAIGN_CHANNELS,
  AGENCY_CAMPAIGN_CHANNEL_LIMIT,
  AGENCY_CAMPAIGN_DATE_YEAR_MAX,
  AGENCY_CAMPAIGN_DATE_YEAR_MIN,
  AGENCY_CAMPAIGN_METRICS_SOURCES,
  AGENCY_CAMPAIGN_STATUSES,
  AGENCY_CAMPAIGN_TRANSITIONS,
  agencyCampaignActions,
  agencyCampaignBudget,
  agencyCampaignMetrics,
  agencyCampaignWindowProblem,
  campaignActionRequiresWindow,
  campaignStatusLabel,
  campaignStatusTone,
  isAgencyCampaignAction,
  isAgencyCampaignClosed,
  isAgencyCampaignCurrent,
  isAgencyCampaignDeletable,
  isAgencyCampaignEditable,
  isAgencyCampaignInFlight,
  isAgencyCampaignMetricsSource,
  isAgencyCampaignStatus,
  normalizeAgencyCampaignChannels,
  normalizeAgencyCampaignDate,
  normalizeAgencyCampaignNullableDate,
  normalizeAgencyCampaignNullableRial,
  normalizeAgencyCampaignNumber,
  normalizeAgencyCampaignOptionalText,
  normalizeAgencyCampaignText,
  nullableFieldStored,
} from "./agency-campaign";

const TODAY = "2026-05-15";

describe("the lifecycle", () => {
  it("has the five statuses a campaign passes through, and words for each", () => {
    expect([...AGENCY_CAMPAIGN_STATUSES]).toEqual([
      "planned",
      "running",
      "paused",
      "completed",
      "cancelled",
    ]);
    for (const status of AGENCY_CAMPAIGN_STATUSES) {
      expect(isAgencyCampaignStatus(status)).toBe(true);
      expect(campaignStatusLabel(status)).not.toBe("");
      expect(campaignStatusTone(status)).toBeTruthy();
      // Every status has a transition list, even when it is empty: a Record with a
      // hole in it would be `undefined` at the screen and the row would render no
      // actions at all rather than no *available* actions.
      expect(Array.isArray(AGENCY_CAMPAIGN_TRANSITIONS[status])).toBe(true);
    }
    expect(isAgencyCampaignStatus("live")).toBe(false);
    expect(isAgencyCampaignStatus(undefined)).toBe(false);
  });

  it("makes completed and cancelled terminal", () => {
    // 0278 refuses a status change on a closed campaign, because its figures have
    // been reported and there is no client-facing document to supersede.
    expect(agencyCampaignActions("completed")).toEqual([]);
    expect(agencyCampaignActions("cancelled")).toEqual([]);
    expect(isAgencyCampaignClosed("completed")).toBe(true);
    expect(isAgencyCampaignClosed("cancelled")).toBe(true);
    expect(isAgencyCampaignClosed("paused")).toBe(false);
    expect(isAgencyCampaignEditable("planned")).toBe(true);
    expect(isAgencyCampaignEditable("completed")).toBe(false);
  });

  it("lets a planned campaign be abandoned without ever running", () => {
    expect(agencyCampaignActions("planned")).toEqual(["start", "cancel"]);
    expect(agencyCampaignActions("running")).toEqual(["pause", "complete", "cancel"]);
    expect(agencyCampaignActions("paused")).toEqual(["resume", "cancel"]);
  });

  it("counts a paused campaign as in flight", () => {
    // Its budget is committed and its channels are booked; excluding it would
    // understate what the agency has going, which is the question being asked.
    expect(isAgencyCampaignInFlight("running")).toBe(true);
    expect(isAgencyCampaignInFlight("paused")).toBe(true);
    expect(isAgencyCampaignInFlight("planned")).toBe(false);
    expect(isAgencyCampaignInFlight("completed")).toBe(false);
    expect(isAgencyCampaignInFlight("cancelled")).toBe(false);
  });

  it("deletes only what never ran", () => {
    expect(isAgencyCampaignDeletable("planned")).toBe(true);
    for (const status of ["running", "paused", "completed", "cancelled"] as const) {
      expect(isAgencyCampaignDeletable(status)).toBe(false);
    }
  });

  it("says in words what a status change needs before the database has to", () => {
    expect(campaignActionRequiresWindow("start")).toBe("start");
    expect(campaignActionRequiresWindow("resume")).toBe("start");
    expect(campaignActionRequiresWindow("complete")).toBe("end");
    expect(campaignActionRequiresWindow("pause")).toBeNull();
    expect(campaignActionRequiresWindow("cancel")).toBeNull();
    expect(isAgencyCampaignAction("start")).toBe(true);
    expect(isAgencyCampaignAction("approve")).toBe(false);
  });
});

describe("the metrics vocabulary", () => {
  it("offers two sources and no third, because no platform integration exists", () => {
    expect([...AGENCY_CAMPAIGN_METRICS_SOURCES]).toEqual(["manual", "imported"]);
    expect(isAgencyCampaignMetricsSource("manual")).toBe(true);
    expect(isAgencyCampaignMetricsSource("imported")).toBe(true);
    // The value that would claim an integration this codebase does not have. §C
    // forbids fake campaign performance, and a `platform` source with nothing
    // behind it is exactly that.
    expect(isAgencyCampaignMetricsSource("platform")).toBe(false);
    expect(isAgencyCampaignMetricsSource("api")).toBe(false);
  });

  it("shares the brief's channel vocabulary rather than growing a second", () => {
    // A campaign that ran on channels its brief never named is a conversation a
    // member needs to be able to have, and two lists would make it unwritable.
    // Identity, not equality: the same array object, so the two can never drift.
    expect(AGENCY_CAMPAIGN_CHANNELS).toBe(AGENCY_BRIEF_CHANNELS);
    expect(AGENCY_CAMPAIGN_CHANNEL_LIMIT).toBe(AGENCY_BRIEF_CHANNEL_LIMIT);
    expect(normalizeAgencyCampaignChannels([...AGENCY_BRIEF_CHANNELS].slice(0, 3))).toEqual([
      "social",
      "search",
      "display",
    ]);
    expect(normalizeAgencyCampaignChannels(["billboard"])).toBeNull();
  });
});

describe("the derived metrics", () => {
  const base = {
    spendRial: 400_000,
    budgetRial: 1_000_000,
    impressions: 1_000,
    clicks: 40,
    leadsGenerated: 12,
    conversions: 3,
    revenueRial: 1_200_000,
  };

  it("derives all four ratios from stored counts and money", () => {
    expect(agencyCampaignMetrics(base)).toEqual({
      ctrPct: 4,
      cplRial: 33_333,
      cpaRial: 133_333,
      roas: 3,
    });
  });

  it("returns null, never zero, when a denominator is missing", () => {
    // The single most important rule in this module: a CPL of 0 for a campaign that
    // recorded no leads reads as the cheapest leads anyone ever bought, and §C's
    // word for that is "fake".
    expect(agencyCampaignMetrics({ ...base, leadsGenerated: 0 }).cplRial).toBeNull();
    expect(agencyCampaignMetrics({ ...base, conversions: 0 }).cpaRial).toBeNull();
    expect(agencyCampaignMetrics({ ...base, impressions: 0, clicks: 0 }).ctrPct).toBeNull();
    expect(agencyCampaignMetrics({ ...base, spendRial: 0 }).roas).toBeNull();
    expect(agencyCampaignMetrics({ ...base, revenueRial: null }).roas).toBeNull();
    // "We do not know yet" and "zero revenue" are different claims, and neither
    // produces a ROAS: a 0 ROAS would say the money came back as nothing.
    expect(agencyCampaignMetrics({ ...base, revenueRial: 0 }).roas).toBeNull();
  });

  it("still reports what it can when most figures are absent", () => {
    const metrics = agencyCampaignMetrics({
      spendRial: 0,
      budgetRial: null,
      impressions: 0,
      clicks: 0,
      leadsGenerated: 0,
      conversions: 0,
      revenueRial: null,
    });
    expect(metrics).toEqual({ ctrPct: null, cplRial: null, cpaRial: null, roas: null });
  });

  it("rounds a rate to two places and a rial to a whole rial", () => {
    const metrics = agencyCampaignMetrics({ ...base, impressions: 3, clicks: 1 });
    expect(metrics.ctrPct).toBe(33.33);
    expect(agencyCampaignMetrics({ ...base, spendRial: 100, leadsGenerated: 3 }).cplRial).toBe(33);
  });
});

describe("spend against budget", () => {
  it("reports an overrun as a state, not as an error", () => {
    // 0278 deliberately does not CHECK spend against budget: a campaign that
    // overran did so, and refusing the true figure would push it into a note no
    // report can read.
    expect(agencyCampaignBudget(500_000, 900_000)).toEqual({
      state: "over",
      differenceRial: 400_000,
      percentOfBudget: 180,
    });
  });

  it("distinguishes under, at, over and unbudgeted", () => {
    expect(agencyCampaignBudget(1_000_000, 400_000)).toEqual({
      state: "under",
      differenceRial: 600_000,
      percentOfBudget: 40,
    });
    expect(agencyCampaignBudget(1_000_000, 1_000_000)).toEqual({
      state: "at",
      differenceRial: 0,
      percentOfBudget: 100,
    });
    expect(agencyCampaignBudget(null, 400_000)).toEqual({
      state: "unbudgeted",
      differenceRial: 0,
      percentOfBudget: null,
    });
    // A zero budget is not a budget: 0278 refuses to store one, and reading it as
    // "under" would say a campaign with no ceiling is inside it.
    expect(agencyCampaignBudget(0, 0).state).toBe("unbudgeted");
  });

  it("reports spend with no budget recorded, which is a campaign nobody capped", () => {
    expect(agencyCampaignBudget(null, 2_000_000).state).toBe("unbudgeted");
  });
});

describe("the window", () => {
  it("is current on its first and last day, inclusive", () => {
    // The calendar a member reads says «running» on the opening day and the
    // closing day, not the day after each.
    expect(isAgencyCampaignCurrent("running", TODAY, "2026-06-01", TODAY)).toBe(true);
    expect(isAgencyCampaignCurrent("running", "2026-05-01", TODAY, TODAY)).toBe(true);
    expect(isAgencyCampaignCurrent("running", "2026-05-01", "2026-06-01", TODAY)).toBe(true);
    expect(isAgencyCampaignCurrent("running", "2026-05-16", "2026-06-01", TODAY)).toBe(false);
    expect(isAgencyCampaignCurrent("running", "2026-05-01", "2026-05-14", TODAY)).toBe(false);
  });

  it("is not current when it never had a window, whatever its status", () => {
    expect(isAgencyCampaignCurrent("running", null, null, TODAY)).toBe(false);
    expect(isAgencyCampaignCurrent("planned", TODAY, "2026-06-01", TODAY)).toBe(false);
    expect(isAgencyCampaignCurrent("completed", "2026-05-01", "2026-06-01", TODAY)).toBe(false);
    // Paused is in flight, so it stays on the calendar as current.
    expect(isAgencyCampaignCurrent("paused", "2026-05-01", "2026-06-01", TODAY)).toBe(true);
  });

  it("names a reversed window before the database has to", () => {
    expect(agencyCampaignWindowProblem("2026-05-10", "2026-05-01")).toBe("window_reversed");
    expect(agencyCampaignWindowProblem("2026-05-01", "2026-05-10")).toBeNull();
    // A half-entered window is not a problem: a campaign with a start and no end is
    // simply still open.
    expect(agencyCampaignWindowProblem("2026-05-01", null)).toBeNull();
    expect(agencyCampaignWindowProblem(null, null)).toBeNull();
    expect(agencyCampaignWindowProblem("2026-05-01", "2026-05-01")).toBeNull();
  });
});

describe("normalising what a browser sends", () => {
  it("trims a required field and refuses a blank or an overlong one", () => {
    expect(normalizeAgencyCampaignText("  کمپین بهاره  ", 200)).toBe("کمپین بهاره");
    expect(normalizeAgencyCampaignText("   ", 200)).toBeNull();
    expect(normalizeAgencyCampaignText("", 200)).toBeNull();
    expect(normalizeAgencyCampaignText("ا".repeat(201), 200)).toBeNull();
    expect(normalizeAgencyCampaignText(undefined, 200)).toBeNull();
    expect(normalizeAgencyCampaignText(42, 200)).toBeNull();
  });

  it("treats a blank optional field as cleared, not as refused", () => {
    expect(normalizeAgencyCampaignOptionalText("  هدف  ", 2000)).toBe("هدف");
    expect(normalizeAgencyCampaignOptionalText("   ", 2000)).toBe("");
    expect(normalizeAgencyCampaignOptionalText(undefined, 2000)).toBe("");
    expect(normalizeAgencyCampaignOptionalText("ا".repeat(2001), 2000)).toBeNull();
  });

  it("accepts a counter as a string, rounds a float, and refuses a negative", () => {
    // bigint and numeric arrive from node-postgres as strings and a form field is a
    // string too; a float is rounded because rial is the integer unit.
    expect(normalizeAgencyCampaignNumber("1000", 1e12)).toBe(1000);
    expect(normalizeAgencyCampaignNumber(1000.4, 1e12)).toBe(1000);
    expect(normalizeAgencyCampaignNumber(1000.6, 1e12)).toBe(1001);
    expect(normalizeAgencyCampaignNumber(-1, 1e12)).toBeNull();
    expect(normalizeAgencyCampaignNumber("banana", 1e12)).toBeNull();
    expect(normalizeAgencyCampaignNumber(true, 1e12)).toBeNull();
    expect(normalizeAgencyCampaignNumber(1e13, 1e12)).toBeNull();
  });

  it("tells an omitted field from a cleared one from an unusable one", () => {
    // Three different intentions, and a two-state result cannot hold them: 0276's
    // lesson was that null-for-absent turns "omitted" into "refused", and the same
    // trap one level down is that null-for-empty is indistinguishable from
    // null-for-unusable — so "clear the budget" and "that is not a number" would get
    // one answer between them.
    expect(normalizeAgencyCampaignNullableRial(undefined, 1e12)).toEqual({ state: "absent" });
    expect(normalizeAgencyCampaignNullableRial(null, 1e12)).toEqual({ state: "clear" });
    expect(normalizeAgencyCampaignNullableRial("", 1e12)).toEqual({ state: "clear" });
    expect(normalizeAgencyCampaignNullableRial("   ", 1e12)).toEqual({ state: "clear" });
    expect(normalizeAgencyCampaignNullableRial("500", 1e12)).toEqual({ state: "value", value: 500 });
    expect(normalizeAgencyCampaignNullableRial(0, 1e12)).toEqual({ state: "value", value: 0 });
    expect(normalizeAgencyCampaignNullableRial("-5", 1e12)).toEqual({ state: "invalid" });
    expect(normalizeAgencyCampaignNullableRial("banana", 1e12)).toEqual({ state: "invalid" });
    expect(normalizeAgencyCampaignNumber(undefined, 1e12, { absentIsZero: true })).toBe(0);
    expect(normalizeAgencyCampaignNumber("", 1e12, { absentIsZero: true })).toBe(0);
  });

  it("stores null for both absent and clear, and only for those", () => {
    expect(nullableFieldStored(normalizeAgencyCampaignNullableRial(undefined, 1e12))).toBeNull();
    expect(nullableFieldStored(normalizeAgencyCampaignNullableRial("", 1e12))).toBeNull();
    expect(nullableFieldStored(normalizeAgencyCampaignNullableRial("500", 1e12))).toBe(500);
    // An invalid field has nothing safe to store, which is why the caller checks the
    // state before it ever asks for the value.
    expect(nullableFieldStored(normalizeAgencyCampaignNullableRial("-5", 1e12))).toBeNull();
  });

  it("accepts a real date and refuses a Jalali year typed into a Gregorian field", () => {
    expect(normalizeAgencyCampaignDate("2026-05-15")).toBe("2026-05-15");
    expect(normalizeAgencyCampaignDate("2026-02-28")).toBe("2026-02-28");
    expect(AGENCY_CAMPAIGN_DATE_YEAR_MIN).toBe(1970);
    expect(AGENCY_CAMPAIGN_DATE_YEAR_MAX).toBe(2200);
    // Calendar-invalid: `isValidIsoDate` catches these, which is why the shared
    // validator is reused rather than a shape regex re-derived.
    expect(normalizeAgencyCampaignDate("2026-02-31")).toBeNull();
    expect(normalizeAgencyCampaignDate("2026-13-01")).toBeNull();
    expect(normalizeAgencyCampaignDate("banana")).toBeNull();
    // The case that passes a shape check *and* a calendar check and is still wrong:
    // 1406 is a valid Gregorian year, and storing it puts the window seven
    // centuries off where every downstream check still agrees with it.
    expect(normalizeAgencyCampaignDate("1406-03-01")).toBeNull();
    expect(normalizeAgencyCampaignDate("1969-12-31")).toBeNull();
    expect(normalizeAgencyCampaignDate("2201-01-01")).toBeNull();
    expect(normalizeAgencyCampaignDate(20260515)).toBeNull();
  });

  it("distinguishes an omitted date from a cleared one from an impossible one", () => {
    expect(normalizeAgencyCampaignNullableDate(undefined)).toEqual({ state: "absent" });
    expect(normalizeAgencyCampaignNullableDate("")).toEqual({ state: "clear" });
    expect(normalizeAgencyCampaignNullableDate("2026-05-15")).toEqual({
      state: "value",
      value: "2026-05-15",
    });
    // A Jalali year is not "no date", it is a date nobody meant: refusing it is what
    // stops a window seven centuries off being stored as though it were fine.
    expect(normalizeAgencyCampaignNullableDate("1406-03-01")).toEqual({ state: "invalid" });
    expect(normalizeAgencyCampaignNullableDate("2026-02-31")).toEqual({ state: "invalid" });
  });

  it("de-duplicates channels in the member's order and refuses what it cannot use", () => {
    expect(normalizeAgencyCampaignChannels(["search", "social", "search"])).toEqual([
      "search",
      "social",
    ]);
    expect(normalizeAgencyCampaignChannels([])).toEqual([]);
    expect(normalizeAgencyCampaignChannels(undefined)).toEqual([]);
    // A refusal, never a silent drop: dropping an unrecognised channel would record
    // a campaign that ran on fewer channels than it did.
    expect(normalizeAgencyCampaignChannels(["social", "billboard"])).toBeNull();
    expect(normalizeAgencyCampaignChannels("social")).toBeNull();
    expect(
      normalizeAgencyCampaignChannels(
        Array.from({ length: AGENCY_CAMPAIGN_CHANNEL_LIMIT + 1 }, () => "social"),
      ),
    ).toBeNull();
  });
});
