import { describe, expect, it } from "vitest";
import {
  DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  diffKitchenAgingStages,
  diffKitchenAlerts,
  kitchenAgingStage,
  kitchenSoundEnabledFor,
  parseKitchenAlertThresholds,
  parseKitchenSoundPreferences,
  resolveKitchenAlertThresholds,
} from "./kitchen-alerts";

describe("kitchen alert thresholds", () => {
  it("accepts a late threshold with no approaching threshold", () => {
    expect(parseKitchenAlertThresholds({ overdueMinutes: 12, approachingMinutes: null })).toEqual({
      overdueMinutes: 12,
      approachingMinutes: null,
    });
  });

  it("accepts an approaching threshold below the late threshold", () => {
    expect(parseKitchenAlertThresholds({ overdueMinutes: 20, approachingMinutes: 10 })).toEqual({
      overdueMinutes: 20,
      approachingMinutes: 10,
    });
  });

  it("rejects out-of-range, fractional and non-progressing thresholds", () => {
    expect(parseKitchenAlertThresholds({ overdueMinutes: 0, approachingMinutes: null })).toBeNull();
    expect(parseKitchenAlertThresholds({ overdueMinutes: 1441, approachingMinutes: null })).toBeNull();
    expect(parseKitchenAlertThresholds({ overdueMinutes: 12.5, approachingMinutes: null })).toBeNull();
    expect(parseKitchenAlertThresholds({ overdueMinutes: 10, approachingMinutes: 10 })).toBeNull();
    expect(parseKitchenAlertThresholds({ overdueMinutes: 10, approachingMinutes: 11 })).toBeNull();
    expect(parseKitchenAlertThresholds("10")).toBeNull();
  });

  it("prefers the branch override, then the business default, then the platform default", () => {
    expect(
      resolveKitchenAlertThresholds(
        { overdueMinutes: 20, approachingMinutes: 10 },
        { overdueMinutes: 15, approachingMinutes: null },
      ),
    ).toEqual({ overdueMinutes: 15, approachingMinutes: null });
    expect(
      resolveKitchenAlertThresholds({ overdueMinutes: 20, approachingMinutes: 10 }, null),
    ).toEqual({ overdueMinutes: 20, approachingMinutes: 10 });
    expect(resolveKitchenAlertThresholds(null, null)).toEqual(DEFAULT_KITCHEN_ALERT_THRESHOLDS);
  });
});

describe("kitchen aging stage", () => {
  const thresholds = { overdueMinutes: 20, approachingMinutes: 10 };

  it("classifies from the persisted age against the branch's own thresholds", () => {
    expect(kitchenAgingStage(0, thresholds)).toBe("within");
    expect(kitchenAgingStage(9.99, thresholds)).toBe("within");
    expect(kitchenAgingStage(10, thresholds)).toBe("approaching");
    expect(kitchenAgingStage(19.99, thresholds)).toBe("approaching");
    expect(kitchenAgingStage(20, thresholds)).toBe("overdue");
    expect(kitchenAgingStage(Number.NaN, thresholds)).toBe("within");
  });

  it("has no approaching stage when the branch has not configured one", () => {
    expect(kitchenAgingStage(19, { overdueMinutes: 20, approachingMinutes: null })).toBe("within");
    expect(kitchenAgingStage(20, { overdueMinutes: 20, approachingMinutes: null })).toBe("overdue");
  });
});

describe("new-ticket and new-line detection", () => {
  const lines = [
    { id: "line-1", order_id: "order-1" },
    { id: "line-2", order_id: "order-2" },
  ];

  it("uses the first snapshot as a baseline so refresh does not replay the queue", () => {
    const first = diffKitchenAlerts(null, lines);
    expect(first.alerts).toEqual([]);
    expect(first.next.itemIds).toEqual(new Set(["line-1", "line-2"]));
    expect(first.next.orderIds).toEqual(new Set(["order-1", "order-2"]));
  });

  it("separates a brand-new order from a new round on a known order", () => {
    const baseline = diffKitchenAlerts(null, lines).next;
    const next = diffKitchenAlerts(baseline, [
      ...lines,
      { id: "line-3", order_id: "order-1" },
      { id: "line-4", order_id: "order-3" },
      { id: "line-5", order_id: "order-3" },
    ]);
    expect(next.alerts).toEqual([
      { kind: "new_ticket", orderId: "order-3", itemIds: ["line-4", "line-5"] },
      { kind: "items_added", orderId: "order-1", itemIds: ["line-3"] },
    ]);
  });

  it("does not alert twice when the same items survive a reconnect or a stale response", () => {
    const baseline = diffKitchenAlerts(null, lines).next;
    const withNew = diffKitchenAlerts(baseline, [...lines, { id: "line-3", order_id: "order-1" }]);
    expect(withNew.alerts).toHaveLength(1);
    // A reconnect snapshot that still contains the line is not a new line.
    expect(diffKitchenAlerts(withNew.next, [...lines, { id: "line-3", order_id: "order-1" }]).alerts).toEqual([]);
    // A refresh that briefly omits it and then returns it is also not a new line.
    const omitted = diffKitchenAlerts(withNew.next, lines);
    expect(omitted.alerts).toEqual([]);
    expect(diffKitchenAlerts(omitted.next, [...lines, { id: "line-3", order_id: "order-1" }]).alerts).toEqual([]);
  });
});

describe("aging alert de-duplication", () => {
  it("baselines the first snapshot and only alerts on an upward stage move", () => {
    const first = diffKitchenAgingStages(
      null,
      new Map([
        ["order-1", "within"],
        ["order-2", "approaching"],
      ]),
    );
    expect(first.alerts).toEqual([]);

    const up = diffKitchenAgingStages(
      first.next,
      new Map([
        ["order-1", "approaching"],
        ["order-2", "overdue"],
      ]),
    );
    expect(up.alerts).toEqual([
      { ticketKey: "order-1", stage: "approaching" },
      { ticketKey: "order-2", stage: "overdue" },
    ]);

    // Repeating the same snapshot (reconnect, refresh, 15s tick) is silent.
    expect(diffKitchenAgingStages(up.next, new Map([
      ["order-1", "approaching"],
      ["order-2", "overdue"],
    ])).alerts).toEqual([]);
  });

  it("updates silently when a ticket goes back down", () => {
    const baseline = diffKitchenAgingStages(
      null,
      new Map([["order-1", "overdue"]]),
    ).next;
    const down = diffKitchenAgingStages(baseline, new Map([["order-1", "within"]]));
    expect(down.alerts).toEqual([]);
    expect(down.next.get("order-1")).toBe("within");
  });
});

describe("device sound preferences", () => {
  it("is off by default and preserves per-event choices", () => {
    const defaults = parseKitchenSoundPreferences(null);
    expect(defaults.enabled).toBe(false);
    expect(kitchenSoundEnabledFor(defaults, "newTicket")).toBe(false);

    const parsed = parseKitchenSoundPreferences({
      enabled: true,
      events: { newTicket: false, printFailure: true },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.events.newTicket).toBe(false);
    expect(parsed.events.addedItems).toBe(true);
    expect(kitchenSoundEnabledFor(parsed, "newTicket")).toBe(false);
    expect(kitchenSoundEnabledFor(parsed, "printFailure")).toBe(true);
  });

  it("ignores malformed storage rather than muting an operator's choice by throwing", () => {
    expect(parseKitchenSoundPreferences("yes").enabled).toBe(false);
    expect(parseKitchenSoundPreferences({ enabled: "true" }).enabled).toBe(false);
  });
});
