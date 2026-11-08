import { normalizeSkuKey } from "../import-reconciliation/normalize";
import type { IncomingProduct } from "../import-reconciliation/types";
import { attributeComparisonKey } from "../product-attributes";
import type { CatalogueRow, CatalogueTarget } from "./catalogue-profile";

export interface CatalogueRecord extends IncomingProduct {
  catalogue: CatalogueRow;
  family?: { axis: string; children: CatalogueRow[] };
  familyParentRow?: number;
}

export function catalogueRecords(
  rows: CatalogueRow[],
  target: CatalogueTarget,
  chosenRows: ReadonlySet<number>,
  axis: string,
) {
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
    const options = children.map(row => attributeComparisonKey(row.values.option ?? ""));
    const title = children[0].values.parent_title;
    if (target !== "retail" || !axis || !title || title.length > 200 || parentSku.length > 100 || selectedSkus.has(parentSku) ||
        children.length < 2 || children.length > 100 || options.some(option => !option) || new Set(options).size !== options.length ||
        children.some(row => row.values.parent_title !== title || row.issues.some(issue => issue.code === "invalid_identity"))) {
      throw new Error("catalogue_variant_group_invalid");
    }
    families.set(children[0].number, { axis, children });
    for (const row of children.slice(1)) consumed.set(row.number, children[0].number);
  }

  return rows.map(row => {
    const family = families.get(row.number);
    const sku = family ? normalizeSkuKey(row.values.parent_sku) : row.sku;
    const duplicateUnselected = row.duplicateRows.length > 0 && !chosenRows.has(row.number);
    const duplicateResolved = duplicateUnselected && row.duplicateRows.some(n => chosenRows.has(n));
    const invalid = row.issues.some(issue => issue.code === "invalid_identity") ||
      (!row.values.parent_sku && Boolean(row.values.option || row.values.parent_title));
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
      ...(family ? { family } : {}),
      ...(consumed.has(row.number) ? { familyParentRow: consumed.get(row.number) } : {}),
    };
    return { record, invalid: invalid || (duplicateUnselected && !duplicateResolved), skipped: consumed.has(row.number) || duplicateResolved };
  });
}
