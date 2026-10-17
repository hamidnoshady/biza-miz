import { describe, expect, it } from "vitest";
import {
  idempotencyKeyFrom,
  parseCapitalMovement,
  parseDistribution,
  parseDistributionPayment,
  parseOwnershipEvents,
  parseOwnershipPolicy,
  parseReason,
  shareholderErrorResponse,
} from "./shareholder-http";
import { ShareholderError } from "./shareholder-service";

describe("shareholder API input boundaries", () => {
  it("requires a non-empty ownership event batch and documents every event with a reason", () => {
    expect(() => parseOwnershipEvents([])).toThrow("invalid_ownership_events");
    expect(() => parseOwnershipEvents([{
      partyId: "party-a",
      eventType: "shareholder_added",
      effectiveOn: "2026-01-01",
      ownershipPercent: "25",
    }])).toThrow("invalid_reason");
    expect(parseOwnershipEvents([{
      partyId: "party-a",
      eventType: "shareholder_added",
      effectiveOn: "2026-01-01",
      ownershipPercent: "۲۵٫۱۲۵",
      shareUnits: "۱۲۵٫۵",
      reason: "ثبت مصوبهٔ تأسیس",
    }])).toMatchObject([{
      partyId: "party-a",
      ownershipPercent: "۲۵٫۱۲۵",
      shareUnits: "۱۲۵٫۵",
      reason: "ثبت مصوبهٔ تأسیس",
    }]);
  });

  it("validates ownership policy, capital class, payment fields and distribution shape", () => {
    expect(parseOwnershipPolicy("exactly_100")).toBe("exactly_100");
    expect(() => parseOwnershipPolicy("100")).toThrow("invalid_ownership_policy");
    expect(parseCapitalMovement({
      partyId: "party-a",
      eventType: "capital_contribution",
      capitalClass: "equity",
      amountRial: "۲٬۰۰۰",
      paymentAccountId: "account-1100",
      effectiveOn: "2026-01-01",
      reason: "آوردهٔ نقدی",
    })).toMatchObject({ eventType: "capital_contribution", capitalClass: "equity", amountRial: "۲٬۰۰۰" });
    expect(parseDistribution({ fiscalYearId: "fy-1404", snapshotOn: "2026-01-01", taxAdjustmentRial: "0", reserveAdjustmentRial: "0" }))
      .toMatchObject({ manualAdjustmentRial: "0", adjustmentReason: null });
    expect(parseDistributionPayment({ shareholderId: "holder-a", amountRial: "500", paidOn: "2026-01-01", paymentAccountId: "cash" }))
      .toMatchObject({ shareholderId: "holder-a", amountRial: "500", paidOn: "2026-01-01" });
    expect(() => parseReason({ reason: "   " })).toThrow("invalid_reason");
  });

  it("prefers the idempotency header and returns domain errors as structured JSON", async () => {
    const request = new Request("https://example.test", { headers: { "idempotency-key": "header-key" } });
    expect(idempotencyKeyFrom(request, { idempotencyKey: "body-key" })).toBe("header-key");
    expect(idempotencyKeyFrom(new Request("https://example.test"), { idempotencyKey: "body-key" })).toBe("body-key");

    const response = shareholderErrorResponse(new ShareholderError("retroactive_permission_required", 403, { permission: "shareholders.retroactive" }));
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: "retroactive_permission_required", permission: "shareholders.retroactive" });
  });
});
