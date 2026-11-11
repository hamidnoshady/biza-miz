import { describe, expect, it } from "vitest";
import {
  readCampaignReport,
  campaignReportMetrics,
} from "./agency-campaign-report";
const input = (extra: Record<string, unknown> = {}) => ({
  periodStart: "2026-10-01",
  periodEnd: "2026-10-07",
  evidenceReference: "source.csv",
  attributionNote: "Reconciled unique forms and orders in this period",
  attributionConfirmed: true,
  spendRial: 1000,
  impressions: 100,
  clicks: 10,
  leadsGenerated: 5,
  conversions: 2,
  revenueRial: 2000,
  ...extra,
});
describe("evidence-based campaign report", () => {
  it("derives only supported ratios", () =>
    expect(campaignReportMetrics(readCampaignReport(input()))).toEqual({
      ctrPct: 10,
      cplRial: 200,
      cpaRial: 500,
      roas: 2,
    }));
  it("suppresses attribution metrics on an unconfirmed claim", () =>
    expect(
      campaignReportMetrics(
        readCampaignReport(input({ attributionConfirmed: false })),
      ),
    ).toEqual({ ctrPct: 10, cplRial: null, cpaRial: null, roas: null }));
  it("distinguishes zero revenue from missing revenue", () => {
    expect(
      campaignReportMetrics(readCampaignReport(input({ revenueRial: 0 }))).roas,
    ).toBe(0);
    expect(
      campaignReportMetrics(readCampaignReport(input({ revenueRial: null })))
        .roas,
    ).toBeNull();
  });
  it("refuses to manufacture ratios from missing denominators", () =>
    expect(
      campaignReportMetrics(
        readCampaignReport(
          input({
            spendRial: 0,
            impressions: 0,
            clicks: 0,
            leadsGenerated: 0,
            conversions: 0,
          }),
        ),
      ),
    ).toEqual({ ctrPct: null, cplRial: null, cpaRial: null, roas: null }));
  for (const key of [
    "spendRial",
    "impressions",
    "clicks",
    "leadsGenerated",
    "conversions",
  ])
    for (const invalid of [
      undefined,
      null,
      "0",
      -1,
      1.5,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      it(`refuses ${key}=${String(invalid)} instead of defaulting it to zero`, () =>
        expect(() => readCampaignReport(input({ [key]: invalid }))).toThrow(
          "invalid_report",
        ));
    }
  for (const patch of [
    { periodStart: "2026-02-30" },
    { periodEnd: "2026-09-01" },
    { evidenceReference: " " },
    { attributionNote: "" },
    { attributionConfirmed: "true" },
    { clicks: 101 },
    { supersedesId: "not-an-id" },
  ]) {
    it(`rejects malformed evidence ${JSON.stringify(patch)}`, () =>
      expect(() => readCampaignReport(input(patch))).toThrow("invalid_report"));
  }
});
