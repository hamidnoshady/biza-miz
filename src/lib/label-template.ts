/**
 * The vocabulary of a price label: the item facts, the trade's field set, and
 * the plain data the printing pipeline renders.
 *
 * **Rendering is not here any more.** A label used to have its own HTML string
 * builder and its own browser-dialog sheet path; both are gone. A label is now
 * a document type like any other — `labelToPrintDocument` maps this data onto
 * the general template model, the built-in `label57x40-label` (or the branch's
 * own saved template) decides the layout, and `renderPrintTemplate` draws it,
 * barcode included, for the same ESC/POS raster path as a receipt. One
 * renderer, one designer, one rules table.
 */
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";
import { formatMoney, type MoneyUnit, type Rial } from "./money";

export type LabelTrade = "jewelry" | "watch" | "accessories" | "cosmetics";

/** The item facts a trade might print; only the ones a trade cares about are used. */
export interface LabelItem {
  name: string;
  /** Shelf price (Rial). */
  price?: Rial | null;
  /** cosmetics: the shade / colour name. */
  shade?: string | null;
  /** cosmetics: expiry date (ISO, Gregorian — stored convention, Jalali at display). */
  expiryDate?: string | null;
  /** jewelry: عیار, e.g. "۱۸". */
  purity?: string | null;
  /** jewelry: وزن (e.g. "۱٫۲۳ گرم"). */
  weight?: string | null;
  /** watch: the model reference. */
  model?: string | null;
  /** watch: the unit's serial number. */
  serial?: string | null;
  /** accessories: the size (e.g. "سایز ۵۵"). */
  size?: string | null;
}

export interface LabelField {
  label: string;
  value: string;
}

/** The fields a trade's label carries, in display order. */
export function labelFieldsForTrade(
  trade: LabelTrade,
  item: LabelItem,
  unit: MoneyUnit = "toman",
): LabelField[] {
  const fields: LabelField[] = [];
  if (item.price != null) {
    fields.push({ label: "قیمت", value: formatMoney(item.price, unit, { withUnit: false }) });
  }
  switch (trade) {
    case "cosmetics":
      if (item.shade) fields.push({ label: "رنگ", value: item.shade });
      if (item.expiryDate) {
        fields.push({ label: "انقضا", value: toPersianDigits(formatJalali(item.expiryDate)) });
      }
      break;
    case "jewelry":
      if (item.purity) fields.push({ label: "عیار", value: item.purity });
      if (item.weight) fields.push({ label: "وزن", value: item.weight });
      break;
    case "watch":
      if (item.model) fields.push({ label: "مدل", value: item.model });
      if (item.serial) fields.push({ label: "سریال", value: item.serial });
      break;
    case "accessories":
      if (item.size) fields.push({ label: "سایز", value: item.size });
      break;
  }
  return fields;
}

export interface LabelData {
  businessName: string;
  itemName: string;
  code: string;
  fields: LabelField[];
}
