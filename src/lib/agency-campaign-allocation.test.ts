import { describe, expect, it } from "vitest";
import {
  CampaignAllocationError,
  previewCampaignAllocation,
  readAllocationSourceLineId,
  readCampaignAllocationTargets,
} from "./agency-campaign-allocation";
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const target = (campaignId: string, basisPoints: number) => ({
  campaignId,
  basisPoints,
});
describe("campaign allocation policy", () => {
  it("keeps incomplete shares unassigned", () => {
    const result = previewCampaignAllocation("1000", [
      target(A, 2500),
      target(B, 5000),
    ]);
    expect(result.allocations.map((row) => row.amountRial)).toEqual([
      "250",
      "500",
    ]);
    expect(result.unassignedRial).toBe("250");
    expect(result.unassignedBasisPoints).toBe(2500);
  });
  it("does not infer weights", () => {
    expect(
      previewCampaignAllocation("9007199254740993", []).unassignedRial,
    ).toBe("9007199254740993");
  });
  it("uses largest remainders including unassigned", () => {
    expect(
      previewCampaignAllocation("1", [target(A, 2000)]).unassignedRial,
    ).toBe("1");
    expect(
      previewCampaignAllocation("2", [target(A, 3333), target(B, 3333)]),
    ).toMatchObject({
      allocations: [{ amountRial: "1" }, { amountRial: "0" }],
      unassignedRial: "1",
    });
  });
  it("normalizes UUID case and request order before tie-breaking", () => {
    const result = previewCampaignAllocation("1", [
      target(B, 5000),
      target(A.toUpperCase(), 5000),
    ]);
    expect(result).toEqual(
      previewCampaignAllocation("1", [target(A, 5000), target(B, 5000)]),
    );
    expect(result.allocations[0].amountRial).toBe("1");
    expect(result.unassignedRial).toBe("0");
    expect(
      previewCampaignAllocation("1", [target(A, 5000)]).allocations[0]
        .amountRial,
    ).toBe("1");
  });
  it("distinguishes zero from missing source", () => {
    expect(
      previewCampaignAllocation("0", [target(A, 10000)]).allocations[0]
        .amountRial,
    ).toBe("0");
    expect(() => previewCampaignAllocation(null, [])).toThrow(
      CampaignAllocationError,
    );
  });
  it.each([
    null,
    undefined,
    123,
    "-1",
    "1.5",
    "1e3",
    " 1",
    "01",
    "9223372036854775808",
  ])("rejects invalid source %s", (value) => {
    expect(() => previewCampaignAllocation(value, [])).toThrow(
      CampaignAllocationError,
    );
  });
  it.each([
    null,
    {},
    [null],
    ["campaign"],
    [[]],
    [target("bad", 10000)],
    [target(A, 0)],
    [target(A, -1)],
    [target(A, 0.5)],
    [target(A, NaN)],
    [target(A, Infinity)],
    [target(A, 10001)],
    [target(A, "10000" as unknown as number)],
    [target(A, 6000), target(B, 4001)],
    [target(A, 1), target(A.toUpperCase(), 1)],
    Array.from({ length: 101 }, () => target(A, 1)),
  ])("rejects invalid targets %#", (value) => {
    expect(() => readCampaignAllocationTargets(value)).toThrow(
      CampaignAllocationError,
    );
  });
  it.each([
    null,
    1,
    "0",
    "-1",
    "01",
    "1e2",
    " 1",
    "9223372036854775808",
    "1.1",
    "9".repeat(100),
  ])("rejects invalid bigint source id %s", (value) => {
    expect(() => readAllocationSourceLineId(value)).toThrow(
      CampaignAllocationError,
    );
  });
  it("retains bigint source ids exactly", () => {
    expect(readAllocationSourceLineId("9223372036854775807")).toBe(
      "9223372036854775807",
    );
  });
  it("does not mutate caller input", () => {
    const rows = Object.freeze([
      Object.freeze(target(B, 5000)),
      Object.freeze(target(A, 5000)),
    ]);
    previewCampaignAllocation("3", rows);
    expect(rows[0].campaignId).toBe(B);
  });
  it("conserves storage-safe rial across partial allocations and serializes without BigInt", () => {
    for (const source of [
      "0",
      "1",
      "2",
      "99",
      "9007199254740993",
      "9223372036854775807",
    ]) {
      for (let basis = 1; basis <= 10000; basis += 137) {
        const result = previewCampaignAllocation(source, [target(A, basis)]);
        const allocated = BigInt(result.allocations[0].amountRial);
        const unassigned = BigInt(result.unassignedRial);
        expect(allocated + unassigned).toBe(BigInt(source));
        expect(allocated >= 0n && unassigned >= 0n).toBe(true);
        expect(() => JSON.stringify(result)).not.toThrow();
      }
    }
  });
  it("supports 100 unique targets", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      target(`aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`, 100),
    );
    const result = previewCampaignAllocation("99", rows.reverse());
    expect(result.allocations).toHaveLength(100);
    expect(
      result.allocations.reduce((sum, row) => sum + BigInt(row.amountRial), 0n),
    ).toBe(99n);
    expect(result.unassignedRial).toBe("0");
  });
});
