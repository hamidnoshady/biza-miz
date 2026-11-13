import { describe, expect, it } from "vitest";
import {
  parseCampaignCsv,
  mapCampaignCsvRow,
  CAMPAIGN_CSV_MAX_BYTES,
  type CampaignImportMapping,
} from "./agency-campaign-report-import";
const context = {
  periodStart: "2026-10-01",
  periodEnd: "2026-10-07",
  evidenceReference: "file.csv; SHA-256 declared",
  attributionNote: "Source matching pending",
};
const mapping: CampaignImportMapping = {
  spendRial: "Spend",
  impressions: "Views",
  clicks: "Clicks",
  leadsGenerated: "Leads",
  conversions: "Orders",
  revenueRial: "Revenue",
};
const csv = (row = "100,1000,100,10,5,") =>
  parseCampaignCsv(`Spend,Views,Clicks,Leads,Orders,Revenue\r\n${row}`);
describe("bounded manual campaign CSV", () => {
  it("accepts BOM, CRLF, escaped quotes, quoted commas/newlines and blank lines", () => {
    const table = parseCampaignCsv(
      '\uFEFFName,Value\r\n"a,\"\"b\"\"\nc",0\r\n\r\n',
    );
    expect(table).toEqual({
      headers: ["Name", "Value"],
      rows: [['a,"b"\nc', "0"]],
    });
  });
  for (const input of [
    "",
    "a,b",
    "a,a\n1,2",
    "a,\n1,2",
    'a,b\n"unterminated,2',
    'a,b\n"one"x,2',
    'a,b\none"x,2',
    "a,b\n1",
    "a,b\n1,2,3",
    "a,b\n1,\0",
  ])
    it(`rejects malformed CSV ${JSON.stringify(input)}`, () =>
      expect(() => parseCampaignCsv(input)).toThrow());
  it("enforces row, column and byte bounds", () => {
    expect(() =>
      parseCampaignCsv("a\n" + Array(1001).fill("1").join("\n")),
    ).toThrow();
    expect(
      parseCampaignCsv("a\n" + Array(1000).fill("1").join("\n")).rows,
    ).toHaveLength(1000);
    expect(() =>
      parseCampaignCsv(
        Array.from({ length: 101 }, (_, i) => `c${i}`).join(",") +
          "\n" +
          Array(101).fill("1").join(","),
      ),
    ).toThrow();
    expect(() =>
      parseCampaignCsv("a\n" + "a".repeat(CAMPAIGN_CSV_MAX_BYTES)),
    ).toThrow();
  });
  it("maps only a chosen row, preserving zero versus unknown and leaving attribution unconfirmed", () => {
    const table = csv("100,1000,100,10,5,\n200,2000,200,20,10,0");
    const first = mapCampaignCsvRow(table, 0, mapping, "rial", context);
    expect(first).toMatchObject({
      spendRial: 100,
      revenueRial: null,
      reach: null,
      attributionConfirmed: false,
      supersedesId: null,
      ...context,
    });
    expect(mapCampaignCsvRow(table, 1, mapping, "rial", context)).toMatchObject(
      { spendRial: 200, revenueRial: 0 },
    );
  });
  it("converts explicitly selected toman exactly and normalizes Persian/Arabic digits", () => {
    expect(
      mapCampaignCsvRow(
        csv("۱۲۳,١٠٠٠,۱۰۰,۱۰,۵,۰"),
        0,
        mapping,
        "toman",
        context,
      ),
    ).toMatchObject({
      spendRial: 1230,
      revenueRial: 0,
      impressions: 1000,
      clicks: 100,
    });
  });
  for (const bad of [
    "",
    "-1",
    "1.5",
    "1e3",
    "1_000",
    "1 000",
    "=1+1",
    "9000000000000001",
  ])
    it(`refuses nonexplicit/unsafe spend ${bad}`, () =>
      expect(() =>
        mapCampaignCsvRow(
          csv(`${bad},1000,100,10,5,`),
          0,
          mapping,
          "rial",
          context,
        ),
      ).toThrow());
  it("refuses missing required/duplicate/unknown mapping, out-of-range rows and count inconsistency", () => {
    for (const m of [
      { ...mapping, spendRial: undefined },
      { ...mapping, clicks: "Views" },
      { ...mapping, reach: "absent" },
    ])
      expect(() => mapCampaignCsvRow(csv(), 0, m, "rial", context)).toThrow();
    expect(() =>
      mapCampaignCsvRow(csv(), 3, mapping, "rial", context),
    ).toThrow();
    expect(() =>
      mapCampaignCsvRow(csv("100,10,11,1,1,"), 0, mapping, "rial", context),
    ).toThrow();
    expect(() =>
      mapCampaignCsvRow(
        csv("900000000000001,1000,100,1,1,"),
        0,
        mapping,
        "toman",
        context,
      ),
    ).toThrow();
  });
  it("does not consume imported attestation/IDs or execute formula cells", () => {
    const table = parseCampaignCsv(
      'Spend,Views,Clicks,Leads,Orders,Revenue,attributionConfirmed,id\n100,1000,100,10,5,,true,=HYPERLINK("evil")'.replace(
        '=HYPERLINK("evil")',
        "=EVIL()",
      ),
    );
    expect(
      mapCampaignCsvRow(table, 0, mapping, "rial", context)
        .attributionConfirmed,
    ).toBe(false);
  });
});
