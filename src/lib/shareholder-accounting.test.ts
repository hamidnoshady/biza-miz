import { describe, expect, it } from "vitest";
import {
  FULL_OWNERSHIP_MICRO_PERCENT,
  SHAREHOLDER_PERCENT_SCALE,
  allocateRialByWeight,
  closingEntryProfitRial,
  formatOwnershipPercent,
  ownershipSnapshotIsComplete,
  parseNonNegativeRial,
  parseOwnershipPercent,
  parsePositiveRial,
  validateOwnershipTimeline,
} from "./shareholder-accounting";
import type { OwnershipTimelineEvent } from "./shareholder-accounting";

const dayOne = "2025-01-01";
const dayTwo = "2025-06-01";

function ownershipEvent(
  partyId: string,
  eventType: OwnershipTimelineEvent["eventType"],
  effectiveOn: string,
  ownershipPercent: string,
  extras: Partial<OwnershipTimelineEvent> = {},
): OwnershipTimelineEvent {
  return { partyId, eventType, effectiveOn, ownershipPercent, ...extras };
}

describe("shareholder exact Rial and percent parsing", () => {
  it("parses and formats six-place percentage precision without floating point", () => {
    expect(SHAREHOLDER_PERCENT_SCALE).toBe(1_000_000n);
    expect(FULL_OWNERSHIP_MICRO_PERCENT).toBe(100_000_000n);
    expect(parseOwnershipPercent("۲۵٫۱۲۵" )).toBe(25_125_000n);
    expect(parseOwnershipPercent("0.000001")).toBe(1n);
    expect(parseOwnershipPercent("100")).toBe(FULL_OWNERSHIP_MICRO_PERCENT);
    expect(formatOwnershipPercent(25_125_000n)).toBe("25.125");
    expect(parseOwnershipPercent("100.000001")).toBeNull();
    expect(parseOwnershipPercent("1.0000001")).toBeNull();
  });

  it("bounds exact Rial inputs to PostgreSQL bigint", () => {
    expect(parsePositiveRial("۹٬۲۲۳٬۳۷۲٬۰۳۶٬۸۵۴٬۷۷۵٬۸۰۷")).toBe(9_223_372_036_854_775_807n);
    expect(parsePositiveRial("9223372036854775808")).toBeNull();
    expect(parsePositiveRial("0")).toBeNull();
    expect(parseNonNegativeRial("۰")).toBe(0n);
    expect(parseNonNegativeRial("-1")).toBeNull();
  });
});

describe("effective ownership timeline validation", () => {
  it("treats same-day ownership rows as one atomic snapshot", () => {
    const events = [
      ownershipEvent("party-a", "shareholder_added", dayOne, "60"),
      ownershipEvent("party-b", "shareholder_added", dayOne, "40"),
    ];
    expect(validateOwnershipTimeline(events, "exactly_100")).toBeNull();
  });

  it("accepts a paired transfer as one exact snapshot, not two interim states", () => {
    const events = [
      ownershipEvent("party-a", "shareholder_added", dayOne, "60"),
      ownershipEvent("party-b", "shareholder_added", dayOne, "40"),
      ownershipEvent("party-a", "ownership_transfer_out", dayTwo, "50", {
        transferPercent: "10",
        transferGroupId: "transfer-1",
      }),
      ownershipEvent("party-b", "ownership_transfer_in", dayTwo, "50", {
        transferPercent: "10",
        transferGroupId: "transfer-1",
      }),
    ];
    expect(validateOwnershipTimeline(events, "exactly_100")).toBeNull();
  });

  it("rejects mismatched transfer halves, duplicate same-day party events and totals above 100%", () => {
    const initial = [
      ownershipEvent("party-a", "shareholder_added", dayOne, "60"),
      ownershipEvent("party-b", "shareholder_added", dayOne, "40"),
    ];
    const mismatched = [
      ...initial,
      ownershipEvent("party-a", "ownership_transfer_out", dayTwo, "50", { transferPercent: "10", transferGroupId: "transfer-1" }),
      ownershipEvent("party-b", "ownership_transfer_in", dayTwo, "50", { transferPercent: "9", transferGroupId: "transfer-1" }),
    ];
    expect(validateOwnershipTimeline(mismatched, "at_most_100")?.code).toBe("ownership_transfer_pair_invalid");

    expect(validateOwnershipTimeline([
      ...initial,
      ownershipEvent("party-a", "ownership_changed", dayTwo, "55"),
      ownershipEvent("party-a", "ownership_changed", dayTwo, "54"),
    ], "at_most_100")?.code).toBe("duplicate_shareholder_event_date");

    expect(validateOwnershipTimeline([
      ownershipEvent("party-a", "shareholder_added", dayOne, "60"),
      ownershipEvent("party-b", "shareholder_added", dayOne, "41"),
    ], "at_most_100")?.code).toBe("ownership_total_exceeds_100");
  });

  it("applies exactly-100 to every effective date and checks valid removal/re-entry", () => {
    const complete = [
      ownershipEvent("party-a", "shareholder_added", dayOne, "60"),
      ownershipEvent("party-b", "shareholder_added", dayOne, "40"),
      ownershipEvent("party-a", "shareholder_removed", dayTwo, "0"),
      ownershipEvent("party-b", "ownership_changed", dayTwo, "100"),
    ];
    expect(validateOwnershipTimeline(complete, "exactly_100")).toBeNull();
    expect(validateOwnershipTimeline([ownershipEvent("party-a", "shareholder_added", dayOne, "60")], "exactly_100")?.code).toBe("ownership_total_must_equal_100");
  });
});

describe("integer-Rial allocation and close sourcing", () => {
  it("uses deterministic largest remainders while preserving the exact total", () => {
    const allocation = allocateRialByWeight(5n, [
      { key: "b", weight: 1n },
      { key: "a", weight: 1n },
    ]);
    expect(allocation.map(({ key, amountRial }) => [key, amountRial])).toEqual([
      ["b", 2n],
      ["a", 3n],
    ]);
    expect(allocation.reduce((sum, row) => sum + row.amountRial, 0n)).toBe(5n);

    const large = allocateRialByWeight(9_000_000_000_000_000_001n, [
      { key: "a", weight: 25_000_000n },
      { key: "b", weight: 75_000_000n },
    ]);
    expect(large.reduce((sum, row) => sum + row.amountRial, 0n)).toBe(9_000_000_000_000_000_001n);
  });

  it("requires a complete 100% snapshot and takes profit only from the existing close result", () => {
    expect(ownershipSnapshotIsComplete([{ ownershipPercent: "33.333333" }, { ownershipPercent: "66.666667" }])).toBe(true);
    expect(ownershipSnapshotIsComplete([{ ownershipPercent: "60" }, { ownershipPercent: "40" }])).toBe(true);
    expect(ownershipSnapshotIsComplete([{ ownershipPercent: "60" }])).toBe(false);
    expect(closingEntryProfitRial({ debit: 15n, credit: 120n })).toBe(105n);
    expect(closingEntryProfitRial({ debit: 120n, credit: 15n })).toBe(0n);
  });
});
