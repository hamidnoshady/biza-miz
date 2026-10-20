/**
 * Validation and normalisation for the shared retail «افزودن محصول» form.
 *
 * This module is deliberately framework-free. The browser uses it before a
 * request so it can move the person to the tab that needs attention, and the
 * API runs the same rules again because request JSON is never trusted.
 */
import Decimal from "decimal.js";
import { barcodeEntryError, normalizeBarcode } from "./barcode";
import { toPersianDigits } from "./digits";

export type ProductFormSection = "base" | "pricing" | "general" | "order" | "tax" | "attributes";

export interface ProductValidationIssue {
  code: string;
  field: string;
  message: string;
  section: ProductFormSection;
}

export interface ParsedProductVariantInput {
  name: string | null;
  sku: string | null;
  barcode: string | null;
  attributes: { name: string; value: string }[];
  /** Optional overrides. Null means use the product-level default. */
  sellPrice: number | null;
  purchasePrice: number | null;
  quantity: string | null;
}

/**
 * The retail-advisor calculation a submitted sale price came from (issue #924,
 * code-review item 3). It is *advisory metadata*, never a second source of
 * truth: the server re-checks that the saved price equals the suggestion before
 * labelling the history row `source: "recommendation"`, and a manual override
 * is recorded as an ordinary manual edit.
 */
export interface ParsedPriceRecommendation {
  /** The advisor's suggested sale price in Rial. */
  suggestedPriceRial: number;
  /** Which target the advisor used — markup or margin. */
  mode: "markup" | "margin";
  /**
   * The inputs behind the suggestion (reference cost, overheads, percentages,
   * rounding, tax preview), kept verbatim for the audit.
   */
  inputs: Record<string, string | number | boolean | null>;
}

export interface ParsedProductCreateInput {
  name: string;
  sku: string | null;
  barcode: string | null;
  isSellable: boolean;
  unit: string | null;
  subUnit: string | null;
  conversionFactor: number | null;
  minOrderQty: number | null;
  reorderReminderQty: number | null;
  leadTimeDays: number | null;
  storageLocation: string | null;
  taxSalePercent: number | null;
  taxPurchasePercent: number | null;
  sellPrice: number | null;
  purchasePrice: number | null;
  quantity: string | null;
  variants: ParsedProductVariantInput[];
  /** Advisory provenance for a sale price the advisor produced, or null. */
  priceRecommendation: ParsedPriceRecommendation | null;
}

export type ProductInputResult =
  | { ok: true; data: ParsedProductCreateInput; issues: [] }
  | { ok: false; data: null; issues: ProductValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  issues: ProductValidationIssue[],
  field: string,
  section: ProductFormSection,
  code: string,
  message: string,
): void {
  issues.push({ field, section, code, message });
}

function optionalText(
  value: unknown,
  field: string,
  section: ProductFormSection,
  maxLength: number,
  issues: ProductValidationIssue[],
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    issue(issues, field, section, "invalid_text", "مقدار متنی واردشده معتبر نیست.");
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    issue(
      issues,
      field,
      section,
      "text_too_long",
      `این مقدار نباید بیشتر از ${maxLength.toLocaleString("fa-IR")} نویسه باشد.`,
    );
  }
  return trimmed;
}

function decimalValue(
  value: unknown,
  config: {
    field: string;
    section: ProductFormSection;
    label: string;
    min: number;
    strictlyGreater?: boolean;
    integer?: boolean;
    max?: number;
    maxDecimals?: number;
  },
  issues: ProductValidationIssue[],
): { number: number | null; text: string | null } {
  if (value === undefined || value === null || value === "") return { number: null, text: null };
  if (typeof value !== "string" && typeof value !== "number") {
    issue(issues, config.field, config.section, "invalid_number", `${config.label} باید عدد باشد.`);
    return { number: null, text: null };
  }

  const source = String(value).trim();
  if (!source) return { number: null, text: null };

  let decimal: Decimal;
  try {
    decimal = new Decimal(source);
  } catch {
    issue(issues, config.field, config.section, "invalid_number", `${config.label} باید عدد باشد.`);
    return { number: null, text: null };
  }
  if (!decimal.isFinite()) {
    issue(issues, config.field, config.section, "invalid_number", `${config.label} باید عدد باشد.`);
    return { number: null, text: null };
  }

  if (config.strictlyGreater ? decimal.lte(config.min) : decimal.lt(config.min)) {
    const relation = config.strictlyGreater ? "بیشتر از" : "حداقل";
    issue(
      issues,
      config.field,
      config.section,
      "number_out_of_range",
      `${config.label} باید ${relation} ${config.min.toLocaleString("fa-IR")} باشد.`,
    );
  }
  if (config.max !== undefined && decimal.gt(config.max)) {
    issue(
      issues,
      config.field,
      config.section,
      "number_out_of_range",
      `${config.label} نمی‌تواند بیشتر از ${config.max.toLocaleString("fa-IR")} باشد.`,
    );
  }
  if (config.integer && !decimal.isInteger()) {
    issue(issues, config.field, config.section, "integer_required", `${config.label} باید عدد صحیح باشد.`);
  }
  if (config.maxDecimals !== undefined && decimal.decimalPlaces() > config.maxDecimals) {
    issue(
      issues,
      config.field,
      config.section,
      "too_many_decimals",
      `${config.label} حداکثر ${config.maxDecimals.toLocaleString("fa-IR")} رقم اعشار می‌پذیرد.`,
    );
  }

  const numeric = decimal.toNumber();
  if (!Number.isSafeInteger(numeric) && config.integer) {
    issue(issues, config.field, config.section, "number_out_of_range", `${config.label} بیش از حد بزرگ است.`);
  }
  return { number: numeric, text: decimal.toFixed() };
}

/** Parse one Rial amount without ever accepting fractions or unsafe integers. */
function rialValue(
  value: unknown,
  field: string,
  label: string,
  allowZero: boolean,
  issues: ProductValidationIssue[],
): number | null {
  const parsed = decimalValue(
    value,
    {
      field,
      section: "pricing",
      label,
      min: 0,
      strictlyGreater: !allowZero,
      integer: true,
      max: Number.MAX_SAFE_INTEGER,
    },
    issues,
  );
  return parsed.number;
}

function barcodeValue(
  value: unknown,
  field: string,
  issues: ProductValidationIssue[],
): string | null {
  const text = optionalText(value, field, field.startsWith("variants.") ? "attributes" : "base", 256, issues);
  if (!text) return null;
  const normalized = normalizeBarcode(text);
  const error = barcodeEntryError(normalized);
  if (error) issue(issues, field, field.startsWith("variants.") ? "attributes" : "base", "invalid_barcode", error);
  return normalized;
}

function parseVariant(
  raw: unknown,
  index: number,
  issues: ProductValidationIssue[],
): ParsedProductVariantInput {
  const prefix = `variants.${index}`;
  if (!isRecord(raw)) {
    issue(issues, prefix, "attributes", "invalid_variant", "اطلاعات یکی از تنوع‌ها معتبر نیست.");
    return {
      name: null,
      sku: null,
      barcode: null,
      attributes: [],
      sellPrice: null,
      purchasePrice: null,
      quantity: null,
    };
  }

  const name = optionalText(raw.name, `${prefix}.name`, "attributes", 200, issues);
  const sku = optionalText(raw.sku, `${prefix}.sku`, "attributes", 100, issues);
  const barcode = barcodeValue(raw.barcode, `${prefix}.barcode`, issues);
  const sellPrice = rialValue(raw.sellPrice, `${prefix}.sellPrice`, "قیمت فروش تنوع", false, issues);
  const purchasePrice = rialValue(raw.purchasePrice, `${prefix}.purchasePrice`, "قیمت خرید تنوع", true, issues);
  const quantity = decimalValue(
    raw.quantity,
    {
      field: `${prefix}.quantity`,
      section: "attributes",
      label: "موجودی اولیهٔ تنوع",
      min: 0,
      max: 999_999_999_999_999,
      maxDecimals: 9,
    },
    issues,
  ).text;

  const attributes: { name: string; value: string }[] = [];
  if (!Array.isArray(raw.attributes)) {
    issue(issues, `${prefix}.attributes`, "attributes", "invalid_attributes", "حداقل یک ویژگی برای هر تنوع انتخاب کنید.");
  } else if (raw.attributes.length > 20) {
    issue(issues, `${prefix}.attributes`, "attributes", "too_many_attributes", "هر تنوع حداکثر ۲۰ ویژگی می‌پذیرد.");
  } else {
    const names = new Set<string>();
    raw.attributes.forEach((attribute, attributeIndex) => {
      if (!isRecord(attribute)) {
        issue(
          issues,
          `${prefix}.attributes.${attributeIndex}`,
          "attributes",
          "invalid_attributes",
          "یکی از ویژگی‌های تنوع معتبر نیست.",
        );
        return;
      }
      const attributeName = optionalText(
        attribute.name,
        `${prefix}.attributes.${attributeIndex}.name`,
        "attributes",
        100,
        issues,
      );
      const attributeValue = optionalText(
        attribute.value,
        `${prefix}.attributes.${attributeIndex}.value`,
        "attributes",
        200,
        issues,
      );
      if (!attributeName || !attributeValue) {
        issue(
          issues,
          `${prefix}.attributes.${attributeIndex}`,
          "attributes",
          "invalid_attributes",
          "نام و مقدار ویژگی تنوع نباید خالی باشد.",
        );
        return;
      }
      const normalizedName = attributeName.toLocaleLowerCase("fa-IR");
      if (names.has(normalizedName)) {
        issue(
          issues,
          `${prefix}.attributes.${attributeIndex}.name`,
          "attributes",
          "duplicate_attribute",
          `ویژگی «${attributeName}» در یک تنوع تکرار شده است.`,
        );
        return;
      }
      names.add(normalizedName);
      attributes.push({ name: attributeName, value: attributeValue });
    });
  }
  if (attributes.length === 0) {
    issue(issues, `${prefix}.attributes`, "attributes", "empty_variant", `برای تنوع ${toPersianDigits(index + 1)} حداقل یک ویژگی انتخاب کنید.`);
  }

  return { name, sku, barcode, attributes, sellPrice, purchasePrice, quantity };
}

const RECOMMENDATION_MODES = new Set(["markup", "margin"]);

function parsePriceRecommendation(raw: unknown): ParsedPriceRecommendation | null {
  if (!isRecord(raw)) return null;
  const suggested = raw.suggestedPriceRial;
  const mode = raw.mode;
  if (
    typeof suggested !== "number" ||
    !Number.isFinite(suggested) ||
    !Number.isInteger(suggested) ||
    suggested <= 0 ||
    suggested > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  if (typeof mode !== "string" || !RECOMMENDATION_MODES.has(mode)) return null;

  // Keep only scalar entries: the audit column is `jsonb`, but a nested object
  // from an untrusted body has no business being persisted as provenance.
  const inputs: Record<string, string | number | boolean | null> = {};
  if (isRecord(raw.inputs)) {
    for (const [key, value] of Object.entries(raw.inputs)) {
      if (key.length === 0 || key.length > 64) continue;
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        if (typeof value === "number" && !Number.isFinite(value)) continue;
        if (typeof value === "string" && value.length > 200) continue;
        inputs[key] = value;
      }
    }
  }
  return { suggestedPriceRial: suggested, mode: mode as "markup" | "margin", inputs };
}

/** Validate and normalise untrusted JSON from the add-product form. */
export function parseProductCreateInput(raw: unknown): ProductInputResult {
  const issues: ProductValidationIssue[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      data: null,
      issues: [
        {
          code: "invalid_payload",
          field: "form",
          section: "base",
          message: "اطلاعات فرم محصول معتبر نیست.",
        },
      ],
    };
  }

  const name = optionalText(raw.name, "name", "base", 200, issues) ?? "";
  if (!name) issue(issues, "name", "base", "name_required", "نام محصول الزامی است.");
  const sku = optionalText(raw.sku, "sku", "base", 100, issues);
  const barcode = barcodeValue(raw.barcode, "barcode", issues);

  let isSellable = true;
  if (raw.isSellable !== undefined) {
    if (typeof raw.isSellable !== "boolean") {
      issue(issues, "isSellable", "base", "invalid_boolean", "وضعیت فروش‌پذیری معتبر نیست.");
    } else {
      isSellable = raw.isSellable;
    }
  }

  const unit = optionalText(raw.unit, "unit", "general", 50, issues);
  const subUnit = optionalText(raw.subUnit, "subUnit", "general", 50, issues);
  const conversionFactor = decimalValue(
    raw.conversionFactor,
    {
      field: "conversionFactor",
      section: "general",
      label: "ضریب تبدیل",
      min: 0,
      strictlyGreater: true,
      max: 999_999_999_999_999,
      maxDecimals: 9,
    },
    issues,
  ).number;
  if (subUnit && !unit) {
    issue(issues, "unit", "general", "main_unit_required", "برای واحد فرعی، واحد اصلی را هم وارد کنید.");
  }
  if (subUnit && conversionFactor === null) {
    issue(issues, "conversionFactor", "general", "conversion_required", "ضریب تبدیل واحد فرعی را وارد کنید.");
  }
  if (conversionFactor !== null && (!unit || !subUnit)) {
    issue(issues, "conversionFactor", "general", "units_required", "ضریب تبدیل به واحد اصلی و فرعی نیاز دارد.");
  }
  if (unit && subUnit && unit.toLocaleLowerCase("fa-IR") === subUnit.toLocaleLowerCase("fa-IR")) {
    issue(issues, "subUnit", "general", "duplicate_unit", "واحد اصلی و فرعی باید متفاوت باشند.");
  }

  const minOrderQty = decimalValue(
    raw.minOrderQty,
    {
      field: "minOrderQty",
      section: "order",
      label: "حداقل سفارش",
      min: 0,
      max: 999_999_999_999_999,
      maxDecimals: 9,
    },
    issues,
  ).number;
  const reorderReminderQty = decimalValue(
    raw.reorderReminderQty,
    {
      field: "reorderReminderQty",
      section: "order",
      label: "نقطهٔ یادآوری سفارش",
      min: 0,
      max: 999_999_999_999_999,
      maxDecimals: 9,
    },
    issues,
  ).number;
  const leadTimeDays = decimalValue(
    raw.leadTimeDays,
    {
      field: "leadTimeDays",
      section: "order",
      label: "زمان تحویل",
      min: 0,
      integer: true,
      max: 3650,
    },
    issues,
  ).number;
  const storageLocation = optionalText(raw.storageLocation, "storageLocation", "order", 200, issues);

  const taxSalePercent = decimalValue(
    raw.taxSalePercent,
    {
      field: "taxSalePercent",
      section: "tax",
      label: "مالیات فروش",
      min: 0,
      max: 100,
      maxDecimals: 2,
    },
    issues,
  ).number;
  const taxPurchasePercent = decimalValue(
    raw.taxPurchasePercent,
    {
      field: "taxPurchasePercent",
      section: "tax",
      label: "مالیات خرید",
      min: 0,
      max: 100,
      maxDecimals: 2,
    },
    issues,
  ).number;

  const sellPrice = rialValue(raw.sellPrice, "sellPrice", "قیمت فروش", false, issues);
  // Malformed provenance is dropped, not rejected: it is metadata about the
  // price, and refusing the product over it would punish a stale client.
  const priceRecommendation = parsePriceRecommendation(raw.priceRecommendation);
  const purchasePrice = rialValue(raw.purchasePrice, "purchasePrice", "قیمت خرید", true, issues);
  const quantity = decimalValue(
    raw.quantity,
    {
      field: "quantity",
      section: "pricing",
      label: "موجودی اولیه",
      min: 0,
      max: 999_999_999_999_999,
      maxDecimals: 9,
    },
    issues,
  ).text;

  let variants: ParsedProductVariantInput[] = [];
  if (raw.variants !== undefined && !Array.isArray(raw.variants)) {
    issue(issues, "variants", "attributes", "invalid_variants", "فهرست تنوع‌های محصول معتبر نیست.");
  } else if (Array.isArray(raw.variants)) {
    if (raw.variants.length > 100) {
      issue(issues, "variants", "attributes", "too_many_variants", "هر محصول حداکثر ۱۰۰ تنوع می‌پذیرد.");
    } else {
      variants = raw.variants.map((variant, index) => parseVariant(variant, index, issues));
    }
  }

  if (variants.length > 0 && barcode) {
    issue(
      issues,
      "barcode",
      "base",
      "parent_barcode_with_variants",
      "برای محصول چندتنوعی، بارکد را در ردیف همان تنوع وارد کنید.",
    );
  }

  const seenCombinations = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  variants.forEach((variant, index) => {
    const combination = variant.attributes
      .map((attribute) => [attribute.name.toLocaleLowerCase("fa-IR"), attribute.value.toLocaleLowerCase("fa-IR")] as const)
      .sort(([left], [right]) => left.localeCompare(right, "fa-IR"))
      .map(([attributeName, attributeValue]) => `${attributeName}\u0000${attributeValue}`)
      .join("\u0001");
    if (combination) {
      const previous = seenCombinations.get(combination);
      if (previous !== undefined) {
        issue(
          issues,
          `variants.${index}.attributes`,
          "attributes",
          "duplicate_variant",
          `تنوع ${toPersianDigits(index + 1)} با تنوع ${toPersianDigits(previous + 1)} یکسان است.`,
        );
      } else {
        seenCombinations.set(combination, index);
      }
    }
    if (variant.barcode) {
      const previous = seenBarcodes.get(variant.barcode);
      if (previous !== undefined) {
        issue(
          issues,
          `variants.${index}.barcode`,
          "attributes",
          "duplicate_barcode",
          `بارکد تنوع ${toPersianDigits(index + 1)} با تنوع ${toPersianDigits(previous + 1)} تکراری است.`,
        );
      } else {
        seenBarcodes.set(variant.barcode, index);
      }
    }
  });

  if (issues.length > 0) return { ok: false, data: null, issues };

  return {
    ok: true,
    issues: [],
    data: {
      name,
      sku,
      barcode,
      isSellable,
      unit,
      subUnit,
      conversionFactor,
      minOrderQty,
      reorderReminderQty,
      leadTimeDays,
      storageLocation,
      taxSalePercent,
      taxPurchasePercent,
      sellPrice,
      purchasePrice,
      quantity,
      variants,
      priceRecommendation,
    },
  };
}
