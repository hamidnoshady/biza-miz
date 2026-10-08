/**
 * «لیست محصولات» — the pure rules behind the products workspace list
 * (dashboard/products/products-list-section.tsx). Framework-free and DB-free
 * per repo convention so the section stays markup and the Vitest unit suite
 * can pin the search, status-filter, KPI, pager and export behaviour.
 */
import { toLatinDigits } from "./digits";
import { moneyToInput, type MoneyUnit } from "./money";

/**
 * The structural slice of the trade's `VariantSummary` the list reads, kept
 * minimal so this module never imports the DB-touching service that defines
 * the full type.
 */
export interface ProductListRow {
  name: string;
  parentName: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  kind: string;
  quantity: string;
  unitPrice: number | null;
  unitCost: number | null;
  isSellable: boolean;
}

/** A row whose children carry the sellable units (see migrations/0050). */
export function isVariantParent(row: Pick<ProductListRow, "kind">): boolean {
  return row.kind === "variant_parent";
}

/**
 * The one status vocabulary the list, its filter and its KPI row share.
 *
 * A family row is «خانواده» — never «ناموجود»: it has no stock of its own, so
 * counting it as out of stock would inflate the headline number with rows that
 * are not things on a shelf. A non-sellable variant is «غیر قابل فروش»
 * whatever its stock says; only a sellable variant is split by its quantity.
 */
export type ProductStatus = "family" | "in_stock" | "out_of_stock" | "non_sellable";

/** The status dropdown's values — `all` plus the three countable statuses. */
export type ProductStatusFilter = "all" | "in_stock" | "out_of_stock" | "non_sellable";

export function productStatus(row: ProductListRow): ProductStatus {
  if (isVariantParent(row)) return "family";
  if (!row.isSellable) return "non_sellable";
  const quantity = Number(row.quantity);
  return Number.isFinite(quantity) && quantity > 0 ? "in_stock" : "out_of_stock";
}

/** True when the row belongs to the filter (every row when `all`). */
export function variantMatchesStatusFilter(row: ProductListRow, filter: ProductStatusFilter): boolean {
  if (filter === "all") return true;
  return productStatus(row) === filter;
}

/** The KPI row's numbers — see `productStatus` for who counts as what. */
export interface ProductKpis {
  /** Every catalogue row: families and variants alike, as the list shows. */
  total: number;
  inStock: number;
  outOfStock: number;
  nonSellable: number;
}

export function productKpis(rows: readonly ProductListRow[]): ProductKpis {
  const kpis: ProductKpis = { total: rows.length, inStock: 0, outOfStock: 0, nonSellable: 0 };
  for (const row of rows) {
    const status = productStatus(row);
    if (status === "in_stock") kpis.inStock++;
    else if (status === "out_of_stock") kpis.outOfStock++;
    else if (status === "non_sellable") kpis.nonSellable++;
  }
  return kpis;
}

/**
 * The numbered pager's window: which 1-based page buttons to draw.
 *
 * At most `maxVisible` buttons (five, so a long catalogue never becomes a
 * ribbon of digits), slid toward the current page — the first pages show
 * `۱ ۲ ۳ ۴ ۵`, a middle page centres itself, the last pages end at the end.
 * Out-of-range `page`/`pageCount` values are clamped rather than trusted.
 */
export function pageWindow(page: number, pageCount: number, maxVisible = 5): number[] {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return [];
  const clampedCount = Math.floor(pageCount);
  const last = clampedCount;
  if (clampedCount <= maxVisible) {
    return Array.from({ length: clampedCount }, (_, index) => index + 1);
  }
  const current = Math.min(Math.max(Math.floor(page), 1), last);
  const start = Math.min(Math.max(current - Math.floor(maxVisible / 2), 1), last - maxVisible + 1);
  return Array.from({ length: maxVisible }, (_, index) => start + index);
}

/**
 * Canonical form for both the search needle and the haystack fields:
 * lowercase, trimmed, with Persian/Arabic-Indic digits folded to ASCII. The
 * catalogue stores SKUs and barcodes in Latin digits, but this is a
 * Persian-first app — a cashier typing «۱۰۱۳» on a Persian keyboard must find
 * SKU `1013`. `toLowerCase` alone folds letters but not digits.
 */
export function normalizeListSearch(text: string): string {
  return toLatinDigits(text).trim().toLowerCase();
}

/** The per-row haystack, pre-computed once per dataset by the caller. */
export function variantSearchNeedles(row: ProductListRow): string[] {
  return [row.name, row.parentName ?? "", row.sku ?? "", row.barcode ?? ""]
    .map((field) => normalizeListSearch(field))
    .filter((field) => field.length > 0);
}

/** True when any of the row's fields contains the already-normalized needle. */
export function variantMatchesNeedle(needles: string[], needle: string): boolean {
  return needles.some((field) => field.includes(needle));
}

/**
 * The stock quantity for a CSV cell, in *Latin* digits. Export must stay
 * machine-parseable: the display formatter turns quantities into grouped
 * Persian text («۵٬۰۰۰»), which Excel cannot read and which disagreed with
 * the Latin prices in the same file. A family row has no stock of its own —
 * the table shows «—», the export leaves the cell empty rather than inventing
 * a zero.
 */
function quantityForCsv(row: ProductListRow): string {
  if (isVariantParent(row)) return "";
  const numeric = Number(row.quantity);
  return Number.isFinite(numeric) ? String(numeric) : row.quantity;
}

/**
 * One CSV field, quoted per RFC 4180 (embedded quotes doubled).
 *
 * A cell starting `=`, `+`, `-` or `@` is a formula to Excel even inside
 * quotes, so a product named `=HYPERLINK(...)` ran on the machine of whoever
 * opened the export. The leading apostrophe makes it inert text — the same
 * guard the platform's shared writer (`data-transfer/codecs.ts`) applies.
 */
function csvCell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** A Rial amount as the plain number a spreadsheet adds up, in the chosen unit. */
function moneyCell(rial: number | null, unit: MoneyUnit): string {
  return rial != null ? String(moneyToInput(rial, unit)) : "";
}

/**
 * The «دانلود CSV» payload: a BOM (so Windows Excel detects UTF-8), quoted
 * header, one row per variant/family in the order shown, CRLF row endings.
 * Money columns are plain Latin-digit numbers in the business's selected unit,
 * and the header names that unit: a Toman business used to get Rial under a
 * «(ریال)» header — ten times the figure on its screen — while every other
 * export in the product speaks the selected unit. `unit` defaults to Rial.
 */
export function buildProductsCsv(rows: ProductListRow[], unit: MoneyUnit = "rial"): string {
  const unitLabel = unit === "rial" ? "ریال" : "تومان";
  const head = ["نام", "خانواده", "کد کالا", "بارکد", "واحد", "موجودی", `قیمت فروش (${unitLabel})`, `قیمت خرید (${unitLabel})`];
  const lines = rows.map((row) =>
    [
      row.name,
      row.parentName ?? "",
      row.sku ?? "",
      row.barcode ?? "",
      row.unit ?? "",
      quantityForCsv(row),
      moneyCell(row.unitPrice, unit),
      moneyCell(row.unitCost, unit),
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[head.map(csvCell).join(","), ...lines].join("\r\n")}`;
}
