import { Readable } from "node:stream";
import { xlsxCellToString } from "./codecs";
import { normaliseHeader, westernDigits } from "./csv";
import { normalizeSkuKey } from "../import-reconciliation/normalize";
import type { WatchMovement } from "../watch-attributes-service";

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
  price: ["قیمت"],
  quantity: ["موجودی", "stock", "qty"],
  parent_sku: ["شناسه والد", "group_sku"],
  parent_title: ["نام والد"],
  option: ["گزینه تنوع"],
} as const;

export type CatalogueField = keyof typeof CATALOGUE_FIELDS;
export type CatalogueMapping = Partial<Record<CatalogueField, number>>;
export type CatalogueSheet = Awaited<ReturnType<typeof readCatalogueWorksheet>>;
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

export function parseCatalogueRows(sheet: CatalogueSheet, mapping: CatalogueMapping, omax: boolean) {
  const parsed = sheet.rows.map((row) => {
    const raw: Partial<Record<CatalogueField, string>> = {};
    const values: Partial<Record<CatalogueField, string>> = {};
    const issues: { field: CatalogueField; code: string }[] = [];
    for (const field of keys) {
      const index = mapping[field];
      const cell = index === undefined ? undefined : row.cells[index];
      if (cell?.text) raw[field] = cell.text;
      if (cell?.issue) {
        issues.push({ field, code: cell.issue });
        continue;
      }
      const text = catalogueText(cell?.text ?? "");
      if (field === "price" || field === "quantity") {
        issues.push({ field, code: text ? "metadata_only" : "missing" });
      } else if (text) {
        values[field] = text;
      }
    }
    if (omax) values.brand = "Omax";
    for (const field of ["band_color", "face", "case_color"] as const) {
      const color = values[field];
      if (color) values[field] = colors[color.toLowerCase()] ?? color;
    }
    const sku = normalizeSkuKey(values.sku);
    const title = values.title ?? "";
    if (!sku || sku.length > 100) issues.push({ field: "sku", code: "invalid_identity" });
    if (!title || title.length > 200) issues.push({ field: "title", code: "invalid_identity" });
    const movement = values.drive ? normalizeMovement(values.drive) : null;
    if (values.drive && !movement) issues.push({ field: "drive", code: "movement_review" });
    const dimensions = values.case_dimension ? dimensionsMm(values.case_dimension) : null;
    if (values.case_dimension && !dimensions) issues.push({ field: "case_dimension", code: "dimension_review" });
    return { number: row.number, raw, values, issues, sku, title, movement, dimensions };
  });
  const groups = new Map<string, number[]>();
  for (const row of parsed) {
    if (!row.sku) continue;
    const occurrences = groups.get(row.sku) ?? [];
    occurrences.push(row.number);
    groups.set(row.sku, occurrences);
  }
  const duplicates = [...groups].filter(([, rows]) => rows.length > 1);
  return {
    rows: parsed.map((row) => ({ ...row, duplicateRows: row.sku ? (groups.get(row.sku) ?? []).filter(n => n !== row.number) : [] })),
    totals: {
      rows: parsed.length,
      distinctSkus: groups.size,
      repeated: duplicates.reduce((total, [, rows]) => total + rows.length - 1, 0),
    },
  };
}

export type CatalogueRow = ReturnType<typeof parseCatalogueRows>["rows"][number];
