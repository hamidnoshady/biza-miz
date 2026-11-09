/** #1128 §D: a quoted vendor purchase is a commitment until explicitly booked. */
export const VENDOR_PURCHASE_STATUSES = ["draft", "submitted", "approved", "rejected", "booked"] as const;
export type VendorPurchaseStatus = typeof VENDOR_PURCHASE_STATUSES[number];
export const VENDOR_PURCHASE_STATUS_LABELS: Record<VendorPurchaseStatus, string> = {
  draft: "پیش‌نویس پیشنهاد فروشنده", submitted: "در انتظار تأیید خرید", approved: "خرید تأییدشده — هنوز ثبت حسابداری نشده",
  rejected: "ردشده", booked: "ثبت‌شده در پرداختنی",
};
export const VENDOR_PURCHASE_ERROR_STATUS = {
  not_agency: 403, purchase_not_found: 404, invalid_purchase: 400,
  invalid_purchase_state: 409, purchase_not_posted: 409, approval_not_pending: 409,
} as const;
export class VendorPurchaseError extends Error {
  constructor(readonly code: keyof typeof VENDOR_PURCHASE_ERROR_STATUS) { super(code); }
}
export function canTransitionVendorPurchase(from: VendorPurchaseStatus, to: VendorPurchaseStatus): boolean {
  return ({ draft: ["submitted"], submitted: ["draft", "approved", "rejected"], approved: ["booked"], rejected: [], booked: [] } as Record<VendorPurchaseStatus, VendorPurchaseStatus[]>)[from].includes(to);
}
