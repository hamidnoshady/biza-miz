import { describe, expect, it } from "vitest";
import { deliveryHealth } from "./messaging-delivery-report";

const row = (over: Partial<{ sent: number; delivered: number; failed: number; pending: number }>) => ({
  sent: 0,
  delivered: 0,
  failed: 0,
  pending: 0,
  ...over,
});

describe("delivery health", () => {
  it("reports silence as idle, never as healthy", () => {
    // No attempts means no evidence; calling that "healthy" trains the operator
    // to ignore the column exactly when it matters.
    expect(deliveryHealth(row({}))).toBe("idle");
  });

  it("calls a queue with no outcome yet degraded", () => {
    expect(deliveryHealth(row({ pending: 12 }))).toBe("degraded");
  });

  it("is healthy only when everything that was tried succeeded and nothing is waiting", () => {
    expect(deliveryHealth(row({ sent: 40, delivered: 60 }))).toBe("healthy");
  });

  it("escalates to attention at a 10% failure rate", () => {
    expect(deliveryHealth(row({ sent: 9, failed: 1 }))).toBe("attention");
    // Exactly 10% (2 of 20 decided) is at the threshold, not under it.
    expect(deliveryHealth(row({ sent: 18, failed: 2 }))).toBe("attention");
    // Below the threshold a failure is still worth a look, but not an alarm.
    expect(deliveryHealth(row({ sent: 99, failed: 1 }))).toBe("degraded");
  });

  it("flags leftover queue work even when nothing has failed", () => {
    expect(deliveryHealth(row({ sent: 10, pending: 3 }))).toBe("degraded");
  });
});
