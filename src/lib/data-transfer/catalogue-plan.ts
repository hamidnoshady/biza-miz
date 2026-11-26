import { normalizeSkuKey } from "../import-reconciliation/normalize";
import type { IncomingProduct } from "../import-reconciliation/types";
import { attributeComparisonKey } from "../product-attributes";
import { CATALOGUE_MAX_AXES, CATALOGUE_OPTION_FIELDS, type CatalogueRow, type CatalogueTarget } from "./catalogue-profile";
import type { CatalogueIncomingValues, CatalogueValuePlan } from "./catalogue-values";

export interface CatalogueRecord extends IncomingProduct {
  catalogue: CatalogueRow;
  /**
   * `axis` is the first axis (kept for runs staged before GH #1567 F6);
   * `axes` lists every axis in order — size × colour is two.
   */
  family?: { axis: string; axes?: string[]; children: CatalogueRow[] };
  familyParentRow?: number;
  /** Sale price, opening/purchase cost and target quantity exactly as reviewed. */
  values?: CatalogueIncomingValues;
  costRial?: string | null;
  /** Set at staging for a resolved existing product; applied after the link. */
  valuePlan?: CatalogueValuePlan;
}

/** Row issues that make a row (and its whole variant family) unimportable. */
const BLOCKING_ISSUES = new Set(["invalid_identity", "duplicate_barcode", "invalid_barcode"]);

/** Every axis of a staged family, including one staged before multi-axis. */
export function catalogueFamilyAxes(family: NonNullable<CatalogueRecord["family"]>): string[] {
  return family.axes?.length ? family.axes : [family.axis];
}

/** One child's `{ axis → value }` pairs, in axis order. */
export function catalogueChildOptions(family: NonNullable<CatalogueRecord["family"]>, row: CatalogueRow) {
  return catalogueFamilyAxes(family).map((name, index) => ({ name, value: row.values[CATALOGUE_OPTION_FIELDS[index]] ?? "" }));
}

/** Same pairs regardless of order, by the Persian-aware comparison key. */
export function sameVariantOptions(
  expected: readonly { name: string; value: string }[],
  actual: readonly { name: string; value: string }[],
): boolean {
  if (expected.length !== actual.length) return false;
  const key = (pair: { name: string; value: string }) => `${attributeComparisonKey(pair.name)}\u0001${attributeComparisonKey(pair.value)}`;
  const seen = new Set(actual.map(key));
  return seen.size === actual.length && expected.every(pair => seen.has(key(pair)));
}

function normaliseAxes(axis: string | readonly string[]): string[] {
  return (typeof axis === "string" ? [axis] : [...axis]).map(name => name.trim()).filter(Boolean);
}

export function catalogueRecords(
  rows: CatalogueRow[],
  target: CatalogueTarget,
  chosenRows: ReadonlySet<number>,
  axis: string | readonly string[],
) {
  const axes = normaliseAxes(axis);
  const axesValid = axes.length >= 1 && axes.length <= CATALOGUE_MAX_AXES && axes.every(name => name.length <= 100) &&
    new Set(axes.map(attributeComparisonKey)).size === axes.length;
  const selected = rows.filter(row => !row.duplicateRows.length || chosenRows.has(row.number));
  const groups = new Map<string, CatalogueRow[]>();
  const selectedSkus = new Set<string>();
  for (const row of selected) {
    if (!row.sku) continue;
    if (selectedSkus.has(row.sku)) throw new Error("catalogue_choose_one_duplicate");
    selectedSkus.add(row.sku);
    const parent = normalizeSkuKey(row.values.parent_sku);
    if (parent) groups.set(parent, [...(groups.get(parent) ?? []), row]);
  }

  const families = new Map<number, CatalogueRecord["family"]>();
  const consumed = new Map<number, number>();
  for (const [parentSku, children] of groups) {
    // Every child names a value for every axis — and only those axes: a
    // value in an unnamed option column would otherwise be silently dropped.
    const values = children.map(row => CATALOGUE_OPTION_FIELDS.map(field => attributeComparisonKey(row.values[field] ?? "")));
    const combinations = values.map(cells => cells.slice(0, axes.length).join("\u0001"));
    const title = children[0].values.parent_title;
    if (target !== "retail" || !axesValid || !title || title.length > 200 || parentSku.length > 100 || selectedSkus.has(parentSku) ||
        children.length < 2 || children.length > 100 ||
        values.some(cells => cells.slice(0, axes.length).some(value => !value) || cells.slice(axes.length).some(Boolean)) ||
        new Set(combinations).size !== combinations.length ||
        children.some(row => row.values.parent_title !== title ||
          row.issues.some(issue => BLOCKING_ISSUES.has(issue.code)))) {
      throw new Error("catalogue_variant_group_invalid");
    }
    families.set(children[0].number, { axis: axes[0], axes, children });
    for (const row of children.slice(1)) consumed.set(row.number, children[0].number);
  }

  return rows.map(row => {
    const family = families.get(row.number);
    const sku = family ? normalizeSkuKey(row.values.parent_sku) : row.sku;
    const duplicateUnselected = row.duplicateRows.length > 0 && !chosenRows.has(row.number);
    const duplicateResolved = duplicateUnselected && row.duplicateRows.some(n => chosenRows.has(n));
    const invalid = row.issues.some(issue => BLOCKING_ISSUES.has(issue.code)) ||
      (!row.values.parent_sku && Boolean(CATALOGUE_OPTION_FIELDS.some(field => row.values[field]) || row.values.parent_title));
    const blocked = duplicateUnselected || consumed.has(row.number) || invalid;
    const record: CatalogueRecord = {
      domain: "product",
      externalId: blocked || !sku ? null : `sku:${sku}`,
      rowNumber: row.number,
      sku: blocked ? null : sku,
      barcodes: !blocked && !family && row.values.barcode ? [row.values.barcode] : [],
      name: family ? row.values.parent_title! : row.title,
      kind: family ? "variant_parent" : "simple",
      tracking: target === "watch" ? "serial" : "none",
      catalogue: row,
      values: {
        priceRial: row.amounts.price.rial,
        costRial: row.amounts.cost.rial,
        quantity: row.stock.quantity,
      },
      priceRial: row.amounts.price.rial == null ? null : String(row.amounts.price.rial),
      stockQuantity: row.stock.quantity,
      costRial: row.amounts.cost.rial == null ? null : String(row.amounts.cost.rial),
      ...(family ? { family } : {}),
      ...(consumed.has(row.number) ? { familyParentRow: consumed.get(row.number) } : {}),
    };
    return { record, invalid: invalid || (duplicateUnselected && !duplicateResolved), skipped: consumed.has(row.number) || duplicateResolved };
  });
}
