import { describe, expect, it } from "vitest";
import { VENDOR_PURCHASE_STATUSES, VENDOR_PURCHASE_STATUS_LABELS, VENDOR_PURCHASE_ERROR_STATUS, VendorPurchaseError, canTransitionVendorPurchase } from "./agency-vendor-purchase";

describe("vendor purchase vocabulary", () => {
  const allowed = new Set(["draft:submitted","submitted:draft","submitted:approved","submitted:rejected","approved:booked"]);
  for (const from of VENDOR_PURCHASE_STATUSES) for (const to of VENDOR_PURCHASE_STATUSES) {
    it(`${from} → ${to}: ${allowed.has(`${from}:${to}`) ? "allowed" : "refused"}`, () => {
      expect(canTransitionVendorPurchase(from,to)).toBe(allowed.has(`${from}:${to}`));
    });
  }
  it("distinguishes a commitment from a posted expense in Persian labels", () => {
    expect(VENDOR_PURCHASE_STATUS_LABELS.approved).toContain("هنوز ثبت حسابداری نشده");
    expect(VENDOR_PURCHASE_STATUS_LABELS.booked).toContain("پرداختنی");
  });
  for (const [code,status] of Object.entries(VENDOR_PURCHASE_ERROR_STATUS)) {
    it(`maps ${code} to ${status}`, () => {
      expect(new VendorPurchaseError(code as keyof typeof VENDOR_PURCHASE_ERROR_STATUS).message).toBe(code);
      expect(status).toBe(code === "not_agency" ? 403 : code === "purchase_not_found" ? 404 : code === "invalid_purchase" ? 400 : 409);
    });
  }
});
