/**
 * Strong types for the retail invoice domain — the retail counterpart of the
 * generic order/order-item shapes the café POS uses.
 *
 * `RetailInvoiceLineSnapshot` is a discriminated union on `kind`, matching
 * `RetailInvoiceLineInput` in retail-invoice-service.ts one-for-one: a line is
 * priced one way and printed one way per industry, and a union makes it
 * impossible to, say, read `.serialNumber` off a gold line at compile time.
 *
 * These types are framework/DB-free (no `pg`, no Next) so they can be shared
 * by the write path (retail-invoice-service.ts), the read model
 * (read-service.ts), the print pipeline (print-data.ts) and the client
 * screens without a dependency cycle.
 */
import type { RialText } from "../inventory-exact";
import type { Purity } from "../gold";

/** Money as the API/DB hands it back — an integer-Rial string, per repo convention (see inventory-exact.ts). */
export type Money = RialText | string;

interface RetailInvoiceLineSnapshotBase {
  /** `order_items.id`. */
  orderItemId: string;
  /** `items.id` this line sold — may be null if the catalogue row was later deleted. */
  itemId: string | null;
  /** What the receipt/detail screen names the line — captured at sale time, never re-read from the current item. */
  nameSnapshot: string;
  skuSnapshot?: string | null;
  /** Decimal string — always the *real* quantity sold, never coerced to 1. */
  quantity: string;
  unit?: string | null;
  /** Pre-discount, pre-VAT unit price, Rial. Absent for a uniquely-priced line (gold, watch) where "unit price" has no meaning. */
  unitPrice?: Money | null;
  /** Pre-discount, pre-VAT line total, Rial. */
  gross: Money;
  /** Manual discount the cashier applied, Rial (excludes any promotion discount). */
  manualDiscount: Money;
  /** Promotion-engine discount applied to this line, Rial. */
  promotionDiscount: Money;
  /** manualDiscount + promotionDiscount — what the invoice document prints as "تخفیف". */
  discount: Money;
  vat: Money;
  /** gross - discount (excl. VAT). */
  net: Money;
  /** net + vat. */
  total: Money;
  /**
   * The journal entries this line's sale actually posted (revenue, COGS —
   * whichever the industry's sell service returned), captured at sale time
   * so a later void can reverse *exactly* these entries. There is no
   * reliable way to re-derive them afterwards: they are keyed by a
   * per-sale-unique posting identity (see RETAIL_POS_ENGINEERING_REPORT.md
   * §12/§13), never by the order or the item. Absent on a line sold before
   * this field existed — `retail-invoice-void-service.ts` refuses to void
   * such a line automatically rather than leave it unreversed.
   */
  ledgerEntryIds?: string[];
}

export interface GoldLineSnapshot extends RetailInvoiceLineSnapshotBase {
  kind: "gold";
  netWeight: string;
  purity: Purity;
  /** The gold rate this line actually priced against, Rial/gram. */
  pricePerGram: number;
  /** The date that rate was recorded for (Jalali/Gregorian ISO date string). */
  priceDate: string;
  makingChargeType: "percent" | "fixed";
  makingChargeValue: number;
  profitPercent: number;
  metalValue: Money;
  makingCharge: Money;
  profit: Money;
  /** Whether this piece was sold on consignment (امانی) rather than owned inventory. */
  consigned: boolean;
}

export interface WatchLineSnapshot extends RetailInvoiceLineSnapshotBase {
  kind: "watch";
  serialId: string;
  serialNumber: string;
  warrantyMonths: number;
  warrantyStartDate?: string | null;
  warrantyEndDate?: string | null;
  provenance?: {
    conditionGrade: string | null;
    boxAndPapers: boolean;
  } | null;
}

export interface CosmeticLineSnapshot extends RetailInvoiceLineSnapshotBase {
  kind: "cosmetic";
  batchNumbers: string[];
  /** Earliest expiry date among the batches this line consumed. */
  expiryDate: string | null;
}

export interface AccessoryLineSnapshot extends RetailInvoiceLineSnapshotBase {
  kind: "accessory";
}

export interface StockedLineSnapshot extends RetailInvoiceLineSnapshotBase {
  kind: "stocked";
}

export type RetailInvoiceLineSnapshot =
  | GoldLineSnapshot
  | WatchLineSnapshot
  | CosmeticLineSnapshot
  | AccessoryLineSnapshot
  | StockedLineSnapshot;

/** `Omit` that distributes over a union — TS's built-in `Omit` collapses a union to its common keys first, which is not what we want here. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * What actually goes into the `order_items.retail_snapshot` JSONB column.
 *
 * `orderItemId`, `itemId` and `nameSnapshot` are deliberately left out: they
 * already exist as real `order_items` columns (`id`, `item_id`,
 * `name_snapshot`), and duplicating them into the JSON would let the two
 * copies drift. `read-service.ts` reconstructs the full `RetailInvoiceLineSnapshot`
 * by merging this stored shape back with the row it came from.
 */
export type RetailInvoiceLineSnapshotStored = DistributiveOmit<
  RetailInvoiceLineSnapshot,
  "orderItemId" | "itemId" | "nameSnapshot" | "skuSnapshot"
>;

/** A line whose `order_items` row predates the `retail_snapshot` column (migration 0174) — read as best-effort, never fabricated. */
export interface LegacyRetailLine {
  kind: "legacy";
  orderItemId: string;
  itemId: string | null;
  nameSnapshot: string;
  /** Always "1" on a legacy row — the actual quantity was never persisted. */
  quantity: string;
  /** The whole line's net, because that is genuinely what `unit_price` held. */
  unitPrice: Money;
  total: Money;
  metalValue?: Money | null;
  makingCharge?: Money | null;
  profit?: Money | null;
}

export type RetailInvoiceDetailLine = RetailInvoiceLineSnapshot | LegacyRetailLine;

export interface RetailInvoicePayment {
  id: string;
  method: string;
  methodLabel: string;
  amount: number;
  reference: string | null;
  paymentMethodId: string | null;
  receivedAt: string;
}

export interface RetailInvoiceCustomer {
  id: string;
  name: string;
  phone: string | null;
}

/** The dedicated retail invoice read model — getRetailInvoiceDetail()'s return shape. Never fetches tables/menu; a retail invoice has neither. */
export interface RetailInvoiceDetail {
  orderId: string;
  orderNumber: number;
  status: "completed" | "voided";
  /** The invoice's real, original issue moment — closed_at, falling back to opened_at. Never `new Date()`. */
  issuedAt: string;
  voidedReason: string | null;
  businessId: string;
  locationId: string;
  locationName: string;
  cashierId: string | null;
  cashierName: string | null;
  customer: RetailInvoiceCustomer | null;
  note: string | null;
  lines: RetailInvoiceDetailLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  payments: RetailInvoicePayment[];
  paidTotal: number;
  balanceDue: number;
  overpaid: number;
  /** How much of this invoice's payment posted as customer receivable (نسیه). */
  creditTotal: number;
  currencyUnit: "toman" | "rial";
  /** Outbound integration state (e.g. Holoo) — surfaced in the info tab only, never blocking. */
  integration: {
    holooQueued: boolean;
    holooSynced: boolean;
  };
}

/** getRetailInvoicePrintData()'s output — the one shape every print surface (first print, reprint, PDF, preview) renders from. */
export interface RetailInvoicePrintDataMeta {
  legacy: boolean;
}
