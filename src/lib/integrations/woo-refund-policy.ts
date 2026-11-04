import type { WooRefund } from "./woocommerce-client";

/** Refunded units are not evidence that Woo actually restocked them. */
export function refundRestockIntent(refund: Pick<WooRefund, "restock_items" | "meta_data">): boolean | null {
  if (typeof refund.restock_items === "boolean") return refund.restock_items;
  const value = refund.meta_data?.find(m => m.key === "_bizamiz_restock_items")?.value;
  return value === "yes" ? true : value === "no" ? false : null;
}
