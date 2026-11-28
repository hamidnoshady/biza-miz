import { Readable } from "node:stream";
import { xlsxCellToString } from "./codecs";
import { normaliseHeader, parseCsv, westernDigits } from "./csv";
import { normalizeSkuKey } from "../import-reconciliation/normalize";
import { barcodeEntryError, normalizeBarcode } from "../barcode";
import type { WatchMovement } from "../watch-attributes-service";
import {
  parseCatalogueMoney,
  parseCatalogueQuantity,
  type CatalogueAmountState,
  type CatalogueCurrency,
  type CatalogueMoneyCell,
  type CatalogueQuantityCell,
} from "./catalogue-values";

/**
 * Strict first-sheet view for reviewed catalogue imports. Formula caches are
 * evidence only: even a numeric cache can refer to a missing external workbook.
 * Keep physical worksheet row numbers, including after blank lines.
 */
export async function readCatalogueWorksheet(buffer: ArrayBuffer, maxRows: number) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.values(zip.files).filter(entry => !entry.dir);
  if (parts.length > 256) throw new Error("catalogue_sheet_limit");
  let expanded = 0;
  for (const part of parts) {
    for await (const bytes of new Readable().wrap(part.nodeStream())) {
      expanded += (bytes as Buffer).length;
      if (expanded > 32 * 1024 * 1024) throw new Error("catalogue_sheet_limit");
    }
  }
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new Error("catalogue_empty");
  if (sheet.rowCount > maxRows + 1 || sheet.columnCount > 100) throw new Error("catalogue_sheet_limit");
  const rows: { number: number; cells: { text: string; issue?: "formula" | "error" | "unsafe_number" }[] }[] = [];
  sheet.eachRow((row, number) => {
    const cells = Array.from({ length: sheet.columnCount }, (_, i) => {
      const value = row.getCell(i + 1).value;
      if (value && typeof value === "object") {
        if ("formula" in value || "sharedFormula" in value) {
          return { text: String("formula" in value ? value.formula : value.sharedFormula).slice(0, 500), issue: "formula" as const };
        }
        if ("error" in value) return { text: value.error, issue: "error" as const };
      }
      if (typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        return { text: String(value), issue: "unsafe_number" as const };
      }
      const text = xlsxCellToString(value);
      if (text.length > 2_000) throw new Error("catalogue_cell_limit");
      return { text };
    });
    rows.push({ number, cells });
  });
  if (rows[0]?.number !== 1 || rows.length < 2) throw new Error("catalogue_empty");
  const columns = rows.shift()!.cells.map((cell) => cell.issue ? "" : cell.text.trim());
  return { name: sheet.name, columns, rows };
}

/**
 * GH #1567 F6: the same reviewed catalogue, from a CSV file. The view has the
 * worksheet's shape so every later step (mapping, preview, staging) is shared.
 * A cell beginning with `=` is a spreadsheet formula, not a value, and gets the
 * same `formula` issue an XLSX formula does. CSV row numbers count non-blank
 * records (the first data record is row 2, as in the worksheet).
 */
export function readCatalogueCsv(buffer: ArrayBuffer, maxRows: number): CatalogueSheet {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error("catalogue_file_invalid"); }
  const records = parseCsv(text);
  if (records.length < 2) throw new Error("catalogue_empty");
  const width = Math.max(...records.map(record => record.length));
  if (records.length > maxRows + 1 || width > 100) throw new Error("catalogue_sheet_limit");
  const [header, ...body] = records;
  const columns = Array.from({ length: width }, (_, i) => (header[i] ?? "").trim());
  const rows = body.map((record, index) => ({
    number: index + 2,
    cells: Array.from({ length: width }, (_, i) => {
      const text = record[i] ?? "";
      if (text.length > 2_000) throw new Error("catalogue_cell_limit");
      return text.trimStart().startsWith("=") ? { text: text.slice(0, 500), issue: "formula" as const } : { text };
    }),
  }));
  return { name: "CSV", columns, rows };
}

export const CATALOGUE_MAX_ROWS = 1_000;
export const CATALOGUE_MAX_FILE_BYTES = 2 * 1024 * 1024;

export const CATALOGUE_FIELDS = {
  sku: ["شناسه کالا", "کد کالا", "reference"],
  title: ["نام کالا", "نام", "name"],
  barcode: ["بارکد"],
  collection: ["مجموعه", "category"],
  brand: ["برند"],
  case_dimension: ["ابعاد قاب"],
  case_material: ["جنس قاب"],
  band_material: ["جنس بند"],
  band_color: ["رنگ بند"],
  drive: ["نوع موتور", "movement"],
  face: ["رنگ صفحه", "dial_color"],
  lock_type: ["نوع قفل"],
  case_color: ["رنگ قاب"],
  case_form: ["شکل قاب"],
  price: ["قیمت", "قیمت فروش"],
  cost: ["بهای خرید", "قیمت خرید", "cost"],
  quantity: ["موجودی", "stock", "qty"],
  parent_sku: ["شناسه والد", "group_sku"],
  parent_title: ["نام والد"],
  option: ["گزینه تنوع", "option_1", "گزینه تنوع ۱"],
  // GH #1567 F6: up to three explicit variant axes (e.g. size × colour × fit).
  option_2: ["گزینه تنوع ۲", "option2"],
  option_3: ["گزینه تنوع ۳", "option3"],
} as const;

/** The mapped field that carries each variant axis's value, in axis order. */
export const CATALOGUE_OPTION_FIELDS = ["option", "option_2", "option_3"] as const;
export const CATALOGUE_MAX_AXES = CATALOGUE_OPTION_FIELDS.length;

export type CatalogueField = keyof typeof CATALOGUE_FIELDS;
export type CatalogueMapping = Partial<Record<CatalogueField, number>>;
export type CatalogueSheet = {
  name: string;
  columns: string[];
  rows: { number: number; cells: { text: string; issue?: "formula" | "error" | "unsafe_number" }[] }[];
};
export type CatalogueTarget = "retail" | "watch";

const keys = Object.keys(CATALOGUE_FIELDS) as CatalogueField[];

export function suggestCatalogueMapping(columns: string[]): CatalogueMapping {
  const mapping: CatalogueMapping = {};
  for (const key of keys) {
    const aliases = [key, ...CATALOGUE_FIELDS[key]].map(normaliseHeader);
    const matches = columns.flatMap((column, index) => aliases.includes(normaliseHeader(column)) ? [index] : []);
    if (matches.length === 1) mapping[key] = matches[0];
  }
  return mapping;
}

export function validateCatalogueMapping(value: unknown, width: number): CatalogueMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalogue_mapping_invalid");
  const mapping: CatalogueMapping = {};
  const used = new Set<number>();
  for (const [key, index] of Object.entries(value)) {
    if (!Object.hasOwn(CATALOGUE_FIELDS, key) || !Number.isInteger(index) || index < 0 || index >= width || used.has(index)) {
      throw new Error("catalogue_mapping_invalid");
    }
    used.add(index);
    mapping[key as CatalogueField] = index;
  }
  if (mapping.sku === undefined || mapping.title === undefined) throw new Error("catalogue_mapping_required");
  return mapping;
}

export function catalogueText(value: string): string {
  return westernDigits(value.normalize("NFKC"))
    .replaceAll("ي", "ی").replaceAll("ك", "ک").replace(/[\u200c\u200d]/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

const movements: [WatchMovement, RegExp][] = [
  ["automatic", /automatic|اتوماتیک|خودکار/u],
  ["manual", /hand[ -]?wind|manual|کوکی|دستی/u],
  ["quartz", /quartz|کوارتز/u],
  ["solar", /solar|خورشیدی/u],
  ["kinetic", /kinetic|کینتیک/u],
  ["smart", /smart|هوشمند/u],
];

function normalizeMovement(value: string): WatchMovement | null {
  const matches = movements.filter(([, pattern]) => pattern.test(value.toLowerCase()));
  return matches.length === 1 ? matches[0][0] : null;
}

function dimensionsMm(value: string): number[] | null {
  const clean = value.toLowerCase().replaceAll("٫", ".").replace(/\s*(?:mm|میلی متر)\s*$/u, "");
  if (!/^\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?){0,2}$/u.test(clean)) return null;
  const dimensions = clean.split(/[x×*]/u).map(Number);
  return dimensions.every((n) => n > 0 && n <= 100) ? dimensions : null;
}

const colors: Record<string, string> = {
  black: "مشکی", white: "سفید", silver: "نقره ای", gold: "طلایی",
  blue: "آبی", green: "سبز", brown: "قهوه ای", gray: "خاکستری", grey: "خاکستری",
};

export const CATALOGUE_MAX_BRAND_LENGTH = 100;

export function normalizeBrandFallback(fallbackBrand: string | null | undefined): string | null {
  if (fallbackBrand === undefined || fallbackBrand === null) return null;
  const normalized = catalogueText(fallbackBrand);
  if (!normalized || normalized.length > CATALOGUE_MAX_BRAND_LENGTH) {
    throw new Error("catalogue_brand_invalid");
  }
  return normalized;
}

export type BrandSource = "excel" | "fallback" | "none";

export interface ParseCatalogueOptions {
  fallbackBrand?: string | null;
  /** The workbook's money unit. Stored and compared as integer Rial. */
  currency?: CatalogueCurrency;
}

export function parseCatalogueRows(
  sheet: CatalogueSheet,
  mapping: CatalogueMapping,
  options: ParseCatalogueOptions = {},
) {
  const fallbackBrand = normalizeBrandFallback(options.fallbackBrand);
  const currency = options.currency === "toman" ? "toman" : "rial";
  const hasBrandColumn = mapping.brand !== undefined;
  if (!hasBrandColumn && !fallbackBrand) {
    throw new Error("catalogue_brand_required");
  }

  let blankBrandRows = 0;
  let excelBrandRows = 0;
  let fallbackBrandRows = 0;
  let unbrandedRows = 0;

  const parsed = sheet.rows.map((row) => {
    const raw: Partial<Record<CatalogueField, string>> = {};
    const values: Partial<Record<CatalogueField, string>> = {};
    const issues: { field: CatalogueField; code: string }[] = [];
    const amounts: Record<"price" | "cost", CatalogueMoneyCell> = {
      price: { raw: null, rial: null, state: "blank" },
      cost: { raw: null, rial: null, state: "blank" },
    };
    let stock: CatalogueQuantityCell = { raw: null, quantity: null, state: "blank" };
    for (const field of keys) {
      const index = mapping[field];
      const cell = index === undefined ? undefined : row.cells[index];
      if (cell?.text) raw[field] = cell.text;
      const text = catalogueText(cell?.text ?? "");
      // Price, cost and quantity are values with a state, not free text: a
      // blank, a formula, a malformed number and an explicit zero are four
      // different facts and only the last one is ever a number the file meant.
      if (field === "price" || field === "cost") {
        const parsedAmount = parseCatalogueMoney(cell?.text ?? "", currency, cell?.issue);
        amounts[field] = parsedAmount;
        if (cell?.issue) issues.push({ field, code: cell.issue });
        else if (parsedAmount.state === "invalid") issues.push({ field, code: "invalid_amount" });
        else if (parsedAmount.state === "blank") issues.push({ field, code: "missing" });
        else if (parsedAmount.state === "zero") issues.push({ field, code: "explicit_zero" });
        continue;
      }
      if (field === "quantity") {
        stock = parseCatalogueQuantity(cell?.text ?? "", cell?.issue);
        if (cell?.issue) issues.push({ field, code: cell.issue });
        else if (stock.state === "invalid") issues.push({ field, code: "invalid_amount" });
        else if (stock.state === "blank") issues.push({ field, code: "missing" });
        else if (stock.state === "zero") issues.push({ field, code: "explicit_zero" });
        continue;
      }
      if (cell?.issue) {
        issues.push({ field, code: cell.issue });
        continue;
      }
      if (text) values[field] = text;
    }

    let brandSource: BrandSource = "none";
    if (hasBrandColumn) {
      if (values.brand) {
        if (values.brand.length > CATALOGUE_MAX_BRAND_LENGTH) {
          issues.push({ field: "brand", code: "invalid_brand" });
          delete values.brand;
          unbrandedRows += 1;
        } else {
          brandSource = "excel";
          excelBrandRows += 1;
        }
      } else if (!issues.some((issue) => issue.field === "brand")) {
        blankBrandRows += 1;
        if (fallbackBrand) {
          values.brand = fallbackBrand;
          brandSource = "fallback";
          fallbackBrandRows += 1;
        } else {
          unbrandedRows += 1;
        }
      } else {
        unbrandedRows += 1;
      }
    } else if (fallbackBrand) {
      values.brand = fallbackBrand;
      brandSource = "fallback";
      fallbackBrandRows += 1;
    }

    for (const field of ["band_color", "face", "case_color"] as const) {
      const color = values[field];
      if (color) values[field] = colors[color.toLowerCase()] ?? color;
    }
    const sku = normalizeSkuKey(values.sku);
    const title = values.title ?? "";
    if (!sku || sku.length > 100) issues.push({ field: "sku", code: "invalid_identity" });
    if (!title || title.length > 200) issues.push({ field: "title", code: "invalid_identity" });
    // GH #1567 F6: the product form rejects a bad check digit at apply, which
    // would fail a whole size × colour family late; show it on the row now.
    if (values.barcode && barcodeEntryError(normalizeBarcode(values.barcode))) {
      issues.push({ field: "barcode", code: "invalid_barcode" });
    }
    const movement = values.drive ? normalizeMovement(values.drive) : null;
    if (values.drive && !movement) issues.push({ field: "drive", code: "movement_review" });
    const dimensions = values.case_dimension ? dimensionsMm(values.case_dimension) : null;
    if (values.case_dimension && !dimensions) issues.push({ field: "case_dimension", code: "dimension_review" });
    return { number: row.number, raw, values, issues, sku, title, movement, dimensions, brandSource, amounts, stock };
  });

  const countStates = (states: CatalogueAmountState[]) => {
    const counts: Record<CatalogueAmountState, number> = { blank: 0, valid: 0, zero: 0, invalid: 0, formula: 0, error: 0 };
    for (const state of states) counts[state] += 1;
    return counts;
  };
  const valueTotals = {
    price: countStates(parsed.map((row) => row.amounts.price.state)),
    cost: countStates(parsed.map((row) => row.amounts.cost.state)),
    quantity: countStates(parsed.map((row) => row.stock.state)),
  };
  const groups = new Map<string, number[]>();
  for (const row of parsed) {
    if (!row.sku) continue;
    const occurrences = groups.get(row.sku) ?? [];
    occurrences.push(row.number);
    groups.set(row.sku, occurrences);
  }
  const duplicates = [...groups].filter(([, rows]) => rows.length > 1);
  // GH #1567 F6: a barcode identifies one sellable unit. Two different SKUs in
  // one file carrying the same barcode is a data error both rows must show;
  // rows that are duplicates of each other (same SKU) are already in review.
  const barcodeSkus = new Map<string, Set<string>>();
  for (const row of parsed) {
    const code = row.values.barcode ? normalizeBarcode(row.values.barcode) : "";
    if (!code || !row.sku) continue;
    barcodeSkus.set(code, (barcodeSkus.get(code) ?? new Set()).add(row.sku));
  }
  let repeatedBarcodes = 0;
  for (const row of parsed) {
    const code = row.values.barcode ? normalizeBarcode(row.values.barcode) : "";
    if (code && (barcodeSkus.get(code)?.size ?? 0) > 1) {
      row.issues.push({ field: "barcode", code: "duplicate_barcode" });
      repeatedBarcodes += 1;
    }
  }
  return {
    rows: parsed.map((row) => ({ ...row, duplicateRows: row.sku ? (groups.get(row.sku) ?? []).filter(n => n !== row.number) : [] })),
    valueTotals,
    totals: {
      rows: parsed.length,
      distinctSkus: groups.size,
      repeated: duplicates.reduce((total, [, rows]) => total + rows.length - 1, 0),
      repeatedBarcodes,
      blankBrandRows,
      excelBrandRows,
      fallbackBrandRows,
      unbrandedRows,
    },
  };
}

export type CatalogueRow = ReturnType<typeof parseCatalogueRows>["rows"][number];
