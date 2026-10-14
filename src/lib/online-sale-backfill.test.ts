import { describe, expect, it } from "vitest";
import { planLegacyOnlineLines, type LegacyOnlineLine } from "./online-sale-backfill";

const line = (over: Partial<LegacyOnlineLine>): LegacyOnlineLine => ({
  orderItemId: "oi-1",
  orderId: "o-1",
  locationId: "loc",
  itemId: "item-1",
  sourceType: "woocommerce_order",
  quantity: "2",
  netRial: "1000000",
  occurredAt: "2026-09-01T10:00:00Z",
  batchCostRial: "0",
  hasBatch: false,
  orderCogsRial: "0",
  isContainer: false,
  ...over,
});

describe("planLegacyOnlineLines", () => {
  it("marks an order that posted no COGS as missing cost with nothing relieved", () => {
    expect(planLegacyOnlineLines([line({})])[0]).toMatchObject({
      costStatus: "missing", cogsRial: "0", stockOutcome: "legacy", relievedQuantity: "0",
    });
  });

  it("takes a batch line's cost from its persisted allocations", () => {
    expect(planLegacyOnlineLines([line({ hasBatch: true, batchCostRial: "30000", orderCogsRial: "30000" })])[0])
      .toMatchObject({ costStatus: "known", cogsRial: "30000", stockOutcome: "relieved", relievedQuantity: "2" });
  });

  it("attributes the residual COGS exactly when one fungible line carries it", () => {
    const plan = planLegacyOnlineLines([
      line({ orderItemId: "a", hasBatch: true, batchCostRial: "30000", orderCogsRial: "70000" }),
      line({ orderItemId: "b", orderCogsRial: "70000" }),
    ]);
    expect(plan.find((f) => f.orderItemId === "b")).toMatchObject({ costStatus: "known", cogsRial: "40000" });
  });

  it("never splits an order's COGS total across several fungible lines", () => {
    const plan = planLegacyOnlineLines([
      line({ orderItemId: "a", orderCogsRial: "70000" }),
      line({ orderItemId: "b", itemId: "item-2", orderCogsRial: "70000" }),
    ]);
    expect(plan.map((f) => f.costStatus)).toEqual(["unattributed", "unattributed"]);
    expect(plan.every((f) => f.cogsRial === "0" && f.relievedQuantity === "0")).toBe(true);
  });

  it("marks a line on a container or an unmapped product not applicable", () => {
    const plan = planLegacyOnlineLines([line({ orderItemId: "a", isContainer: true }), line({ orderItemId: "b", itemId: null })]);
    expect(plan.map((f) => f.stockOutcome)).toEqual(["not_tracked", "not_tracked"]);
  });
});
