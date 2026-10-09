/**
 * A shelf/stock label, loaded server-side from the barcode it prints.
 *
 * A label looks like the least dangerous document in the product and is
 * actually the one that gets scanned. The browser used to build it: the
 * cosmetics screen read the price, the shade and the expiry out of its own
 * board state and posted a finished `LabelData`; the inventory screen posted
 * the item's unit. Nothing tied the printed bars to the catalogue row they
 * claim to identify, and the field list itself (`labelFieldsForTrade`, Persian
 * money formatting included) lived in the client.
 *
 * Here the code is looked up in the branch's barcodes, the item behind it is
 * read from its own table, and the trade's field set is applied on the server —
 * so the label a shop prints is a function of what is stored, the same way its
 * receipt is.
 */
import type { Industry } from "../industries";
import type { LabelData, LabelField, LabelItem, LabelTrade } from "../label-template";
import { labelFieldsForTrade } from "../label-template";
import { formatMoney, type MoneyUnit } from "../money";
import { query } from "../db";
import { loadPrintIdentity } from "./identity";

/** The four trades with a label vocabulary; every other industry prints the plain item label. */
const TRADE_BY_INDUSTRY: Partial<Record<Industry, LabelTrade>> = {
  jewelry: "jewelry",
  watch: "watch",
  accessories: "accessories",
  cosmetics: "cosmetics",
};

interface ItemRow extends Record<string, unknown> {
  source: "inventory" | "item";
  id: string;
  name: string;
  unit: string | null;
  unit_price: string | null;
}

export interface LabelPrintData {
  label: LabelData;
  /** The barcode row the label documents — recorded on the job row. */
  entityId: string;
}

export interface LabelPrintInput {
  businessId: string;
  locationId: string;
  /** An `items` or `inventory_items` id; the row itself says which table it is. */
  itemId: string;
  /** The exact code to print. Omitted means the item's own first code. */
  code?: string | null;
}

/**
 * Resolve one branch's label, or null when the item, or a barcode for it, does
 * not exist in that branch. The caller turns null into a 404 — a label for
 * another branch's item is exactly what this branch-scoped read refuses.
 */
export async function getLabelPrintData(input: LabelPrintInput): Promise<LabelPrintData | null> {
  const item = await findItem(input.locationId, input.itemId);
  if (!item) return null;

  const barcode = await findBarcode(input.locationId, item, input.code ?? null);
  if (!barcode) return null;

  const { business, currencyUnit } = await loadPrintIdentity(input.businessId, input.locationId);
  const fields =
    item.source === "inventory"
      ? unitFields(item.unit)
      : tradeFields(item, await itemLabelFacts(item.id), currencyUnit, await industryOf(input.businessId));

  return {
    label: {
      businessName: business.name,
      itemName: item.name,
      code: barcode.code,
      fields,
    },
    entityId: barcode.id,
  };
}

/** The item behind a barcode, from whichever catalogue table owns it. */
async function findItem(locationId: string, itemId: string): Promise<ItemRow | null> {
  const { rows } = await query<ItemRow>(
    `SELECT 'inventory' AS source, i.id, i.name, i.unit, NULL::text AS unit_price
       FROM inventory_items i
      WHERE i.id = $1 AND i.location_id = $2
      UNION ALL
     SELECT 'item' AS source, i.id, i.name, NULL AS unit, s.unit_price::text AS unit_price
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = $1 AND i.location_id = $2`,
    [itemId, locationId],
  );
  return rows[0] ?? null;
}

/**
 * The barcode row to print: the named code, or the item's own first code.
 * One code = one item per branch (the services enforce it), so a code is a
 * complete reference within the branch — but the item is still checked, so a
 * caller cannot print a label whose bars belong to something else.
 */
async function findBarcode(
  locationId: string,
  item: ItemRow,
  code: string | null,
): Promise<{ id: string; code: string } | null> {
  const table = item.source === "inventory" ? "inventory_item_barcodes" : "item_barcodes";
  const itemColumn = item.source === "inventory" ? "inventory_item_id" : "item_id";
  const { rows } = await query<{ id: string; code: string }>(
    `SELECT id, code FROM ${table}
      WHERE location_id = $1 AND ${itemColumn} = $2 AND ($3::text IS NULL OR code = $3)
      ORDER BY created_at, id
      LIMIT 1`,
    [locationId, item.id, code],
  );
  return rows[0] ?? null;
}

/** The trade facts a label may print: the shelf price, the shade and the nearest expiry. */
async function itemLabelFacts(itemId: string): Promise<Omit<LabelItem, "name">> {
  const [{ rows: stock }, { rows: attributes }, { rows: batches }] = await Promise.all([
    query<{ unit_price: string | null }>("SELECT unit_price::text FROM item_stock WHERE item_id = $1", [itemId]),
    query<{ name: string; value: string }>(
      "SELECT name, value FROM item_variant_attributes WHERE item_id = $1 AND name IN ('سایه', 'رنگ') ORDER BY name",
      [itemId],
    ),
    query<{ expiry_date: string | null }>(
      "SELECT expiry_date::text FROM item_batches WHERE item_id = $1 AND expiry_date IS NOT NULL ORDER BY expiry_date LIMIT 1",
      [itemId],
    ),
  ]);
  return {
    price: stock[0]?.unit_price == null ? null : Number(stock[0].unit_price),
    shade: attributes[0]?.value ?? null,
    expiryDate: batches[0]?.expiry_date ?? null,
  };
}

async function industryOf(businessId: string): Promise<Industry | null> {
  const { rows } = await query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [
    businessId,
  ]);
  return rows[0]?.industry ?? null;
}

function unitFields(unit: string | null): LabelField[] {
  return unit ? [{ label: "واحد", value: unit }] : [];
}

/**
 * The trade's own field set, or — for an industry with no label vocabulary —
 * the price alone. `labelFieldsForTrade` is the one function that decides what
 * a trade's label carries, so a saved template's `labelFields` block and this
 * loader can never drift apart.
 */
function tradeFields(
  item: ItemRow,
  facts: Omit<LabelItem, "name">,
  currencyUnit: MoneyUnit,
  industry: Industry | null,
): LabelField[] {
  const trade = industry ? TRADE_BY_INDUSTRY[industry] : undefined;
  const labeled: LabelItem = { name: item.name, ...facts };
  if (trade) return labelFieldsForTrade(trade, labeled, currencyUnit);
  return facts.price == null
    ? []
    : [{ label: "قیمت", value: formatMoney(facts.price, currencyUnit, { withUnit: false }) }];
}
