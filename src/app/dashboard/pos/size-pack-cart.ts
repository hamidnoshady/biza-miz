/**
 * GH #1567 6C — a size pack as a till cart line. The server expands the
 * `size_pack` payload into per-variant lines; the preview prices each component
 * the way a per-variant line is priced, so the cart total matches the invoice.
 */
import { computeAccessorySalePrice } from "@/lib/accessories";
import { toPersianDigits } from "@/lib/digits";

export interface TillSizePack {
  id: string;
  name: string;
  priceRial: number;
  pieces: number;
  available: number;
  components: { quantity: number; unitPriceRial: number }[];
  /** GH #1567 C5 — variants in the pack that hold consigned (امانی) units; such a pack is not sellable. */
  consignedComponents?: string[];
}

export interface SizePackCartLine {
  key: string;
  label: string;
  payload: { kind: "size_pack"; packId: string; quantity: number; vatPercent: number };
  net: number;
  vat: number;
  total: number;
}

export function sizePackCartLine(pack: TillSizePack, quantity: number, vatPercent: number, key: string): SizePackCartLine {
  let net = 0;
  let vat = 0;
  let total = 0;
  for (const c of pack.components) {
    if (c.unitPriceRial <= 0) continue;
    const b = computeAccessorySalePrice({ unitPrice: c.unitPriceRial, quantity: String(c.quantity * quantity), discount: 0, vatPercent });
    net += Number(b.net);
    vat += Number(b.vat);
    total += Number(b.total);
  }
  return {
    key,
    label: `بستهٔ ${pack.name} × ${toPersianDigits(String(quantity))} (${toPersianDigits(String(pack.pieces * quantity))} قطعه)`,
    payload: { kind: "size_pack", packId: pack.id, quantity, vatPercent },
    net,
    vat,
    total,
  };
}
