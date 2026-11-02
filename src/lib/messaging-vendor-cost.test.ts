import { describe, expect, it } from "vitest";
import {
  hasReportedVendorCost,
  recordSendVendorCost,
  vendorCostMeter,
  vendorCostReference,
} from "./messaging-vendor-cost";

describe("vendor cost reporting", () => {
  it("treats only a real non-negative integer as a reported cost", () => {
    expect(hasReportedVendorCost(0)).toBe(true);
    expect(hasReportedVendorCost(1_733)).toBe(true);
    // Unknown is not zero: a missing or malformed cost must not post a free send.
    expect(hasReportedVendorCost(null)).toBe(false);
    expect(hasReportedVendorCost(undefined)).toBe(false);
    expect(hasReportedVendorCost(Number.NaN)).toBe(false);
    expect(hasReportedVendorCost(-1)).toBe(false);
    expect(hasReportedVendorCost(1.5)).toBe(false);
    expect(hasReportedVendorCost(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("keys the event to the outbox row so a replay cannot double-post", () => {
    const id = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
    expect(vendorCostReference(id)).toBe(`message_outbox:${id}`);
    expect(vendorCostReference(id)).toBe(vendorCostReference(id));
  });

  it("maps each channel to the meter whose wholesale cost it feeds", () => {
    expect(vendorCostMeter("sms")).toBe("messaging.sms_segment");
    expect(vendorCostMeter("email")).toBe("messaging.email_send");
    expect(vendorCostMeter("push")).toBeNull();
  });

  it("short-circuits before touching the database when nothing is reportable", async () => {
    const base = {
      businessId: "00000000-0000-0000-0000-000000000000",
      outboxId: "00000000-0000-0000-0000-000000000001",
      channel: "sms",
      provider: "kavenegar",
      costRial: 1_000,
    };
    await expect(recordSendVendorCost({ ...base, channel: "push" })).resolves.toBe(false);
    await expect(recordSendVendorCost({ ...base, provider: null })).resolves.toBe(false);
    await expect(recordSendVendorCost({ ...base, costRial: null })).resolves.toBe(false);
    await expect(recordSendVendorCost({ ...base, costRial: -5 })).resolves.toBe(false);
  });
});
