import { describe, expect, it } from "vitest";
import {
  chooseOnlineOccurredAt,
  decideOnlineLineCost,
  decideOnlineStockRelief,
  isProvisionalCost,
  parseRemoteInstant,
  planOnlineLineReturn,
  reconcileOnlineDocument,
} from "./online-sale-policy";

describe("decideOnlineStockRelief", () => {
  it("relieves the shelf when no remote snapshot has been taken", () => {
    expect(decideOnlineStockRelief({ quantity: "2", onHand: "5", remoteSnapshotAt: null, remoteOccurredAt: "2026-09-01T10:00:00.000Z" }))
      .toEqual({ outcome: "relieved", relieve: "2", short: "0" });
  });

  it("does not relieve twice when a post-sale snapshot already arrived", () => {
    expect(decideOnlineStockRelief({
      quantity: "2", onHand: "3",
      remoteSnapshotAt: "2026-09-01T10:05:00.000Z", remoteOccurredAt: "2026-09-01T10:00:00.000Z",
    })).toEqual({ outcome: "already_reflected", relieve: "0", short: "0" });
  });

  it("relieves when the snapshot predates the sale", () => {
    expect(decideOnlineStockRelief({
      quantity: "1", onHand: "3",
      remoteSnapshotAt: "2026-08-30T00:00:00.000Z", remoteOccurredAt: "2026-09-01T10:00:00.000Z",
    }).outcome).toBe("relieved");
  });

  it("relieves when the order carried no instant to compare (never guesses it was reflected)", () => {
    expect(decideOnlineStockRelief({ quantity: "1", onHand: "3", remoteSnapshotAt: "2026-09-01T10:05:00.000Z", remoteOccurredAt: null }).outcome)
      .toBe("relieved");
  });

  it("records a shortfall instead of clamping it away", () => {
    expect(decideOnlineStockRelief({ quantity: "5", onHand: "2", remoteSnapshotAt: null, remoteOccurredAt: null }))
      .toEqual({ outcome: "short", relieve: "2", short: "3" });
    expect(decideOnlineStockRelief({ quantity: "1", onHand: "0", remoteSnapshotAt: null, remoteOccurredAt: null }))
      .toEqual({ outcome: "short", relieve: "0", short: "1" });
  });

  it("rejects a non-positive quantity", () => {
    expect(() => decideOnlineStockRelief({ quantity: "0", onHand: "1", remoteSnapshotAt: null, remoteOccurredAt: null })).toThrow();
  });
});

describe("decideOnlineLineCost", () => {
  it("costs every unit at the recorded purchase cost", () => {
    expect(decideOnlineLineCost({ quantity: "3", shortQuantity: "0", unitCost: 125_000n })).toEqual({ costStatus: "known", cogsRial: "375000" });
  });

  it("marks a line with no cost basis missing — never infers it from the price", () => {
    expect(decideOnlineLineCost({ quantity: "3", shortQuantity: "0", unitCost: null })).toEqual({ costStatus: "missing", cogsRial: "0" });
    expect(decideOnlineLineCost({ quantity: "3", shortQuantity: "0", unitCost: 0 })).toEqual({ costStatus: "missing", cogsRial: "0" });
  });

  it("is partial when some units were never on the local shelf", () => {
    expect(decideOnlineLineCost({ quantity: "5", shortQuantity: "3", unitCost: "1000" })).toEqual({ costStatus: "partial", cogsRial: "2000" });
    expect(decideOnlineLineCost({ quantity: "2", shortQuantity: "2", unitCost: "1000" })).toEqual({ costStatus: "missing", cogsRial: "0" });
  });

  it("rounds a fractional quantity's cost to the whole Rial", () => {
    expect(decideOnlineLineCost({ quantity: "0.5", shortQuantity: "0", unitCost: 3 }).cogsRial).toBe("2");
  });

  it("flags only gaps as provisional", () => {
    expect(isProvisionalCost("known")).toBe(false);
    expect(isProvisionalCost("not_applicable")).toBe(false);
    expect(isProvisionalCost("missing")).toBe(true);
    expect(isProvisionalCost("partial")).toBe(true);
    expect(isProvisionalCost("unattributed")).toBe(true);
  });
});

describe("parseRemoteInstant", () => {
  it("reads a WooCommerce *_gmt field as UTC", () => {
    expect(parseRemoteInstant("2026-09-01T10:22:03", { assumeUtc: true })).toBe("2026-09-01T10:22:03.000Z");
  });

  it("refuses a store-local time without an offset rather than guessing the timezone", () => {
    expect(parseRemoteInstant("2026-09-01T10:22:03", { assumeUtc: false })).toBeNull();
  });

  it("honours an explicit offset", () => {
    expect(parseRemoteInstant("2026-09-01T13:52:03+03:30", { assumeUtc: false })).toBe("2026-09-01T10:22:03.000Z");
  });

  it("is null for blanks and garbage", () => {
    expect(parseRemoteInstant(null, { assumeUtc: true })).toBeNull();
    expect(parseRemoteInstant("  ", { assumeUtc: true })).toBeNull();
    expect(parseRemoteInstant("not a date", { assumeUtc: true })).toBeNull();
  });
});

describe("chooseOnlineOccurredAt", () => {
  const importedAt = "2026-10-07T08:00:00.000Z";

  it("prefers paid, then completed, then created", () => {
    expect(chooseOnlineOccurredAt({ createdAt: "2026-09-01T09:00:00Z", paidAt: "2026-09-01T09:05:00Z", completedAt: "2026-09-02T00:00:00Z", importedAt }))
      .toEqual({ occurredAt: "2026-09-01T09:05:00.000Z", source: "remote_paid" });
    expect(chooseOnlineOccurredAt({ createdAt: "2026-09-01T09:00:00Z", paidAt: null, completedAt: "2026-09-02T00:00:00Z", importedAt }).source)
      .toBe("remote_completed");
    expect(chooseOnlineOccurredAt({ createdAt: "2026-09-01T09:00:00Z", paidAt: null, completedAt: null, importedAt }).source)
      .toBe("remote_created");
  });

  it("keeps a historical import on its own day, not the import day", () => {
    const { occurredAt } = chooseOnlineOccurredAt({ createdAt: "2026-03-01T09:00:00Z", paidAt: null, completedAt: null, importedAt });
    expect(occurredAt.slice(0, 10)).toBe("2026-03-01");
  });

  it("falls back to the import instant, labelled, when the payload has no usable date", () => {
    expect(chooseOnlineOccurredAt({ createdAt: null, paidAt: null, completedAt: null, importedAt }))
      .toEqual({ occurredAt: importedAt, source: "import" });
  });

  it("does not trust a remote instant from the future", () => {
    expect(chooseOnlineOccurredAt({ createdAt: "2027-01-01T00:00:00Z", paidAt: null, completedAt: null, importedAt }).source).toBe("import");
  });
});

describe("reconcileOnlineDocument", () => {
  it("reconciles lines − discount + shipping + fees + tax to the total", () => {
    const result = reconcileOnlineDocument({
      linesSubtotalRial: 22_500_000n, discountRial: 0n, shippingRial: 2_000_000n, feesRial: 0n, taxRial: 280_000n, totalRial: 24_780_000n,
    });
    expect(result.status).toBe("reconciled");
    expect(result.unexplainedDifferenceRial).toBe(0n);
  });

  it("states the difference when the payload omitted components", () => {
    // The audit's sampled invoice: items 2,250,000 Toman, total 2,478,000 Toman.
    const result = reconcileOnlineDocument({
      linesSubtotalRial: 22_500_000n, discountRial: null, shippingRial: null, feesRial: null, taxRial: 0n, totalRial: 24_780_000n,
    });
    expect(result.status).toBe("incomplete");
    expect(result.unexplainedDifferenceRial).toBe(2_280_000n);
  });

  it("calls a complete-but-unequal document an explained difference", () => {
    const result = reconcileOnlineDocument({
      linesSubtotalRial: 1_000n, discountRial: 0n, shippingRial: 0n, feesRial: 0n, taxRial: 0n, totalRial: 1_001n,
    });
    expect(result.status).toBe("explained_difference");
    expect(result.unexplainedDifferenceRial).toBe(1n);
  });
});

describe("planOnlineLineReturn", () => {
  const line = {
    quantity: "4", shortQuantity: "0", relievedQuantity: "4", restoredQuantity: "0", cogsRial: "400000", restoredCogsRial: "0",
  };

  it("restores the units and reverses COGS at the sale's own cost", () => {
    expect(planOnlineLineReturn(line, "1")).toEqual({ restock: "1", cogsReversalRial: "100000" });
  });

  it("never restocks a unit the sale did not take off this shelf", () => {
    expect(planOnlineLineReturn({ ...line, relievedQuantity: "0", cogsRial: "400000" }, "2"))
      .toEqual({ restock: "0", cogsReversalRial: "200000" });
    expect(planOnlineLineReturn({ ...line, relievedQuantity: "4", restoredQuantity: "3" }, "2").restock).toBe("1");
  });

  it("reverses no COGS for a line that posted none", () => {
    expect(planOnlineLineReturn({ ...line, cogsRial: "0" }, "2")).toEqual({ restock: "2", cogsReversalRial: "0" });
  });

  it("never reverses more than was posted", () => {
    expect(planOnlineLineReturn({ ...line, restoredCogsRial: "350000" }, "2").cogsReversalRial).toBe("50000");
  });
});
