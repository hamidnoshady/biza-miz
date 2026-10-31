import type { WooProduct } from "./woocommerce-client";

export const PUBLICATION_META_KEY = "_bizamiz_publication_id";

/** A matching SKU is a collision unless this exact operation created it. */
export function publicationRetryTarget(products: WooProduct[], operationId: string): WooProduct | null {
  if (products.length === 0) return null;
  if (products.length !== 1 || !products[0].meta_data?.some((m) => m.key === PUBLICATION_META_KEY && m.value === operationId)) {
    throw new Error("publication_review:sku_already_exists");
  }
  return products[0];
}

export function publicationRemoteId(value: unknown): string {
  const id = String(value ?? "");
  if (!/^[1-9]\d*$/.test(id) || BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("publication_invalid_remote_ack");
  return id;
}
