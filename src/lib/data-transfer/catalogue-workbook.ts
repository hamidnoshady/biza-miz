import { createHash } from "node:crypto";
import { readCatalogueWorksheet } from "./codecs";
import { normaliseHeader, westernDigits } from "./csv";
import { normalizeNameKey, normalizeSkuKey } from "../import-reconciliation/normalize";
import type { IncomingProduct } from "../import-reconciliation/types";

export const CATALOGUE_FIELDS = [
  "sku", "title", "collection", "brand", "case_dimension", "case_material",
  "band_material", "band_color", "drive", "face", "lock_type", "case_color",
  "case_form", "price", "quantity", "parent_sku", "parent_title", "option_name", "option_value",
] as const;
export type CatalogueField = typeof CATALOGUE_FIELDS[number];
export type CatalogueMapping = Partial<Record<CatalogueField, number>>;
export type CatalogueTarget = "watch" | "retail";

export async function readCatalogueWorkbook(buffer: ArrayBuffer) {
  const sheet = await readCatalogueWorksheet(buffer);
  const suggested: CatalogueMapping = {};
  for (const field of CATALOGUE_FIELDS) {
    const index = sheet.columns.findIndex((column) =>
      normaliseHeader(column) === normaliseHeader(field) ||
      (field === "quantity" && normaliseHeader(column) === "موجودی"));
    if (index !== -1) suggested[field] = index;
  }
  return { ...sheet, suggested, fingerprint: createHash("sha256").update(new Uint8Array(buffer)).digest("hex") };
}

export function catalogueRecords(
  sheet: Awaited<ReturnType<typeof readCatalogueWorkbook>>,
  mapping: CatalogueMapping,
  target: CatalogueTarget,
  fixedBrand?: string,
) {
  const mapped = Object.entries(mapping);
  if (mapping.sku == null || mapping.title == null ||
      mapped.some(([key, index]) => !(CATALOGUE_FIELDS as readonly string[]).includes(key) ||
        !Number.isInteger(index) || index < 0 || index >= sheet.columns.length) ||
      new Set(mapped.map(([, index]) => index)).size !== mapped.length) {
    throw new Error("catalogue_invalid_mapping");
  }

  const records = sheet.rows.map(({ rowNumber, values, unsafe }): IncomingProduct => {
    const raw = (key: CatalogueField) => mapping[key] == null ? "" : values[mapping[key]!] ?? "";
    const read = (key: CatalogueField) => unsafe.includes(mapping[key] ?? -1) ? "" : raw(key).trim();
    const sku = normalizeSkuKey(read("sku"));
    const name = read("title").replace(/\s+/g, " ");
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!sku || sku.length > 160 || !name || name.length > 300) errors.push("catalogue_invalid_identity");
    for (const [field, index] of mapped) {
      if (unsafe.includes(index)) warnings.push(`${field}:formula_or_error`);
    }
    for (const field of ["price", "quantity"] as const) {
      if (raw(field)) warnings.push(`${field}:not_applied`);
    }

    const specs = Object.fromEntries(CATALOGUE_FIELDS.slice(4, 13).flatMap((key) => {
      const value = normalizeNameKey(read(key));
      return value ? [[key, value]] : [];
    }));
    const dimension = westernDigits(specs.case_dimension ?? "").replace(/٫/g, ".");
    const diameter = dimension.match(/^(\d+(?:\.\d+)?)\s*(?:mm|میلی\s*متر)?$/iu);
    const caseDiameterMm = diameter ? Number(diameter[1]) : null;
    if (dimension && (caseDiameterMm == null || caseDiameterMm <= 0 || caseDiameterMm > 100)) {
      warnings.push("case_dimension:diameter_unknown");
    }

    const drive = specs.drive ?? "";
    const movements = [
      ["automatic", /automatic|اتوماتیک/u], ["manual", /manual|hand\s*wind|کوکی|دستی/u],
      ["quartz", /quartz|کوارتز/u], ["solar", /solar|خورشیدی/u],
      ["kinetic", /kinetic|کینتیک/u], ["smart", /smart|هوشمند/u],
    ] as const;
    const matches = movements.filter(([, pattern]) => pattern.test(drive));
    if (drive && matches.length !== 1) warnings.push("drive:review_required");

    const parentSku = normalizeSkuKey(read("parent_sku"));
    const optionName = normalizeNameKey(read("option_name"));
    const optionValue = normalizeNameKey(read("option_value"));
    const variant = Boolean(parentSku || optionName || optionValue);
    if (variant && (target === "watch" || !parentSku || parentSku === sku || !optionName || !optionValue ||
        [parentSku, optionName, optionValue].some((value) => (value?.length ?? 0) > 160))) {
      errors.push("catalogue_invalid_variant");
    }

    return {
      domain: "product",
      externalId: sku,
      rowNumber,
      name,
      sku,
      kind: variant ? "variant_child" : "simple",
      parentExternalId: parentSku,
      variantOptions: optionName && optionValue ? { [optionName]: optionValue } : undefined,
      tracking: target === "watch" ? "serial" : "none",
      fields: {
        source: values,
        warnings,
        errors,
        collection: read("collection"),
        parentTitle: read("parent_title").slice(0, 300),
        brand: read("brand") || fixedBrand?.trim() || "",
        specs,
        watch: {
          referenceNo: sku,
          movement: matches.length === 1 ? matches[0][0] : null,
          caseDiameterMm: caseDiameterMm != null && caseDiameterMm > 0 && caseDiameterMm <= 100 ? caseDiameterMm : null,
          caseMaterial: specs.case_material,
          braceletMaterial: specs.band_material,
          dialColor: specs.face,
          braceletColor: specs.band_color,
          claspType: specs.lock_type,
          caseColor: specs.case_color,
          caseShape: specs.case_form,
          caseDimensions: specs.case_dimension,
        },
      },
    };
  });

  const occurrences = new Map<string, number[]>();
  for (const record of records) {
    if (!record.sku || !record.rowNumber) continue;
    const rows = occurrences.get(record.sku) ?? [];
    rows.push(record.rowNumber);
    occurrences.set(record.sku, rows);
  }
  const duplicateRows = [...occurrences.entries()].filter(([, rows]) => rows.length > 1);
  return {
    records,
    counts: {
      rows: records.length,
      uniqueSkus: occurrences.size,
      repeated: duplicateRows.reduce((total, [, rows]) => total + rows.length - 1, 0),
    },
    duplicateRows,
  };
}
