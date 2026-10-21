/**
 * Phase 21 Wave 1 — generic Item/Variant/Serial primitive (DB-touching).
 *
 * A shared "sellable thing" model for the industries this phase adds:
 * a watch is a `tracking: 'serial'` item (one item_serials row per physical
 * unit), an accessory is a `kind: 'variant_child'` item under a
 * `variant_parent`, and a weighted gold piece (Wave 2) will attach its own
 * weight/purity attributes on top of the same `items` row. F&B's own
 * `menu_items`/`inventory_items`/recipes are deliberately untouched in this
 * wave — see Phase-21-Multi-Industry-Accounting-Platform.md's progress notes
 * for why migrating them onto this primitive is its own follow-up slice.
 *
 * DB-touching, so per repo convention (see items.ts for the pure rules this
 * leans on) it has no direct unit test; covered instead by
 * integration/generic-items.integration.test.ts.
 */
import { getPool, query, type PoolClient } from "./db";
import {
  validateItemKindParent,
  validateSerialNumber,
  validateSerialStatusTransition,
  validateVariantAttributes,
  validateWeightItemStatusTransition,
  type ItemKind,
  type ItemTracking,
  type SerialStatus,
  type VariantAttributeInput,
  type WeightItemStatus,
} from "./items";
import { validateStone, validateWeightAttributes, type Purity, type StoneInput } from "./gold";
import { validateSerialUnitCost, validateServiceIntervalMonths, validateWarrantyMonths } from "./watch";

export interface Item {
  id: string;
  locationId: string;
  parentItemId: string | null;
  name: string;
  sku: string | null;
  kind: ItemKind;
  tracking: ItemTracking;
  isActive: boolean;
  /** Phase 27 Wave 3 — the brand this item is sold under, for filters/reports and (Wave 7) commission scope. */
  brandId: string | null;
  /** Phase 27 Wave 10 — how often this model should be serviced (months); null = no service reminder. */
  serviceIntervalMonths: number | null;
  /** Phase 27 Wave 11 — merchandising tags for sell-through reporting. */
  collection: string | null;
  season: string | null;
  /** Shared `/media` cover / variant image reference (`media_assets.id`). */
  imageMediaId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemSerial {
  id: string;
  itemId: string;
  serialNumber: string;
  status: SerialStatus;
  /** Phase 21 Wave 5 — what the shop paid for this unit (Rial); null until recorded. The sale path refuses to sell a unit with none. */
  unitCost: number | null;
  /** Phase 21 Wave 5 — the warranty term (months) this unit is sold with; 0 = no warranty. */
  warrantyMonths: number;
  soldAt: string | null;
  createdAt: string;
}

export interface VariantAttribute {
  id: string;
  itemId: string;
  name: string;
  value: string;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  parent_item_id: string | null;
  name: string;
  sku: string | null;
  kind: ItemKind;
  tracking: ItemTracking;
  is_active: boolean;
  brand_id: string | null;
  service_interval_months: number | null;
  collection: string | null;
  season: string | null;
  image_media_id?: string | null;
  created_at: string;
  updated_at: string;
}

function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    locationId: row.location_id,
    parentItemId: row.parent_item_id,
    name: row.name,
    sku: row.sku,
    kind: row.kind,
    tracking: row.tracking,
    isActive: row.is_active,
    brandId: row.brand_id,
    serviceIntervalMonths: row.service_interval_months,
    collection: row.collection,
    season: row.season,
    imageMediaId: row.image_media_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateItemInput {
  locationId: string;
  name: string;
  sku?: string | null;
  kind?: ItemKind;
  tracking?: ItemTracking;
  parentItemId?: string | null;
  /** Phase 27 Wave 10 — service interval in months; null = no reminder. */
  serviceIntervalMonths?: number | null;
}

/** Creates a `simple` (default) item, or a bare `variant_parent` with no attributes of its own — use createVariantChild for its children. */
export async function createItem(input: CreateItemInput, client?: PoolClient): Promise<Item> {
  const kind = input.kind ?? "simple";
  const parentItemId = input.parentItemId ?? null;
  if (kind === "variant_child") {
    throw new Error("از createVariantChild برای ایجاد کالای تنوع فرزند استفاده کنید.");
  }
  const error = validateItemKindParent(kind, parentItemId);
  if (error) throw new Error(error);
  const intervalError = validateServiceIntervalMonths(input.serviceIntervalMonths);
  if (intervalError) throw new Error(intervalError);

  const params = [
    input.locationId,
    parentItemId,
    input.name,
    input.sku ?? null,
    kind,
    input.tracking ?? "none",
    input.serviceIntervalMonths ?? null,
  ];
  const { rows } = client
    ? await client.query<ItemRow>(
        `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking, service_interval_months)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        params,
      )
    : await query<ItemRow>(
        `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking, service_interval_months)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        params,
      );
  return mapItem(rows[0]);
}

/** Creates one variant of a `variant_parent` item, with its distinguishing attributes, atomically. */
export async function createVariantChild(
  parentItemId: string,
  locationId: string,
  name: string,
  sku: string | null,
  attributes: VariantAttributeInput[],
  transactionClient?: PoolClient,
): Promise<Item> {
  const errors = validateVariantAttributes(attributes);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const insert = async (client: PoolClient): Promise<Item> => {
    const { rows } = await client.query<ItemRow>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind)
       VALUES ($1, $2, $3, $4, 'variant_child') RETURNING *`,
      [locationId, parentItemId, name, sku],
    );
    const item = mapItem(rows[0]);
    for (const attribute of attributes) {
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value, attribute_definition_id) VALUES ($1, $2, $3, $4)`,
        [item.id, attribute.name.trim(), attribute.value.trim(), attribute.definitionId ?? null],
      );
    }
    return item;
  };

  // Product creation already owns a wider transaction (parent, every child,
  // barcodes and opening prices). Reuse it instead of committing each child
  // independently; standalone callers retain the original atomic helper.
  if (transactionClient) return insert(transactionClient);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const item = await insert(client);
    await client.query("COMMIT");
    return item;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Phase 42 — the products workspace's add/edit form writes the additive
 * product columns (barcode, units, ordering hints, tax percents, sellability)
 * that 0140 added to the shared item core. Only the named fields move; the
 * receipt/sale paths' columns (kind, tracking, stock) stay with their own
 * writers.
 */
export interface ItemMetaPatch {
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  imageMediaId?: string | null;
  unit?: string | null;
  subUnit?: string | null;
  conversionFactor?: number | null;
  minOrderQty?: number | null;
  reorderReminderQty?: number | null;
  leadTimeDays?: number | null;
  storageLocation?: string | null;
  taxSalePercent?: number | null;
  taxPurchasePercent?: number | null;
  isSellable?: boolean;
}

export async function updateItemMeta(
  id: string,
  patch: ItemMetaPatch,
  client?: PoolClient,
): Promise<Item | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name.trim());
  if (patch.sku !== undefined) push("sku", patch.sku);
  if (patch.barcode !== undefined) push("barcode", patch.barcode);
  if (patch.imageMediaId !== undefined) push("image_media_id", patch.imageMediaId);
  if (patch.unit !== undefined) push("unit", patch.unit);
  if (patch.subUnit !== undefined) push("sub_unit", patch.subUnit);
  if (patch.conversionFactor !== undefined) push("conversion_factor", patch.conversionFactor);
  if (patch.minOrderQty !== undefined) push("min_order_qty", patch.minOrderQty);
  if (patch.reorderReminderQty !== undefined) push("reorder_reminder_qty", patch.reorderReminderQty);
  if (patch.leadTimeDays !== undefined) push("lead_time_days", patch.leadTimeDays);
  if (patch.storageLocation !== undefined) push("storage_location", patch.storageLocation);
  if (patch.taxSalePercent !== undefined) push("tax_sale_percent", patch.taxSalePercent);
  if (patch.taxPurchasePercent !== undefined) push("tax_purchase_percent", patch.taxPurchasePercent);
  if (patch.isSellable !== undefined) push("is_sellable", patch.isSellable);
  if (sets.length === 0) return getItem(id, client);
  sets.push(`updated_at = now()`);

  const { rows } = client
    ? await client.query<ItemRow>(
        `UPDATE items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
        params,
      )
    : await query<ItemRow>(
        `UPDATE items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
        params,
      );
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function listItems(locationId: string): Promise<Item[]> {
  const { rows } = await query<ItemRow>(
    `SELECT * FROM items WHERE location_id = $1 ORDER BY name`,
    [locationId],
  );
  return rows.map(mapItem);
}

export async function listVariantChildren(parentItemId: string): Promise<Item[]> {
  const { rows } = await query<ItemRow>(
    `SELECT * FROM items WHERE parent_item_id = $1 ORDER BY name`,
    [parentItemId],
  );
  return rows.map(mapItem);
}

export async function getItem(id: string, client?: PoolClient): Promise<Item | null> {
  const { rows } = client
    ? await client.query<ItemRow>(`SELECT * FROM items WHERE id = $1`, [id])
    : await query<ItemRow>(`SELECT * FROM items WHERE id = $1`, [id]);
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function listVariantAttributes(itemId: string): Promise<VariantAttribute[]> {
  const { rows } = await query<{ id: string; item_id: string; name: string; value: string }>(
    `SELECT * FROM item_variant_attributes WHERE item_id = $1 ORDER BY name`,
    [itemId],
  );
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, name: r.name, value: r.value }));
}

interface SerialRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  serial_number: string;
  status: SerialStatus;
  // bigint comes back from pg as a string (see gold-prices-service.ts) --
  // converted to a plain number in mapSerial.
  unit_cost: string | null;
  warranty_months: number;
  sold_at: string | null;
  created_at: string;
}

/** `sold_at` is a `date`, which node-postgres maps to a JS Date unless cast — every read of a date column in this repo casts it (see expense-service.ts, fixed-assets). */
const SERIAL_COLUMNS =
  "id, item_id, serial_number, status, unit_cost, warranty_months, sold_at::text AS sold_at, created_at";

function mapSerial(row: SerialRow): ItemSerial {
  return {
    id: row.id,
    itemId: row.item_id,
    serialNumber: row.serial_number,
    status: row.status,
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    warrantyMonths: row.warranty_months,
    soldAt: row.sold_at,
    createdAt: row.created_at,
  };
}

export interface AddSerialInput {
  /** Rial, whole — omit until the unit's cost is known; the sale path refuses to sell a unit with none. */
  unitCost?: number | null;
  /** Months, 0 = sold with no warranty. Overridable again at the point of sale. */
  warrantyMonths?: number;
}

/** Registers one physical unit of a `tracking: 'serial'` item (Wave 5: watches), with its cost basis and standard warranty term. */
export async function addSerial(
  itemId: string,
  serialNumber: string,
  input: AddSerialInput = {},
): Promise<ItemSerial> {
  const error = validateSerialNumber(serialNumber);
  if (error) throw new Error(error);
  const costError = validateSerialUnitCost(input.unitCost);
  if (costError) throw new Error(costError);
  const warrantyMonths = input.warrantyMonths ?? 0;
  const warrantyError = validateWarrantyMonths(warrantyMonths);
  if (warrantyError) throw new Error(warrantyError);

  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "serial") {
    throw new Error("فقط کالای با ردیابی «سریال» می‌تواند شماره سریال داشته باشد.");
  }

  const { rows } = await query<SerialRow>(
    `INSERT INTO item_serials (item_id, serial_number, unit_cost, warranty_months)
     VALUES ($1, $2, $3, $4) RETURNING ${SERIAL_COLUMNS}`,
    [itemId, serialNumber.trim(), input.unitCost ?? null, warrantyMonths],
  );
  return mapSerial(rows[0]);
}

/** Edits a registered unit's cost basis / standard warranty term — the serial equivalent of editing a weighed piece's `unit_cost_per_gram`. */
export async function updateSerial(
  id: string,
  input: AddSerialInput,
): Promise<ItemSerial> {
  const costError = validateSerialUnitCost(input.unitCost);
  if (costError) throw new Error(costError);
  if (input.warrantyMonths != null) {
    const warrantyError = validateWarrantyMonths(input.warrantyMonths);
    if (warrantyError) throw new Error(warrantyError);
  }

  const { rows } = await query<SerialRow>(
    `UPDATE item_serials
        SET unit_cost = COALESCE($1, unit_cost),
            warranty_months = COALESCE($2, warranty_months)
      WHERE id = $3 RETURNING ${SERIAL_COLUMNS}`,
    [input.unitCost ?? null, input.warrantyMonths ?? null, id],
  );
  if (!rows[0]) throw new Error("سریال یافت نشد.");
  return mapSerial(rows[0]);
}

export async function getSerial(id: string): Promise<ItemSerial | null> {
  const { rows } = await query<SerialRow>(`SELECT ${SERIAL_COLUMNS} FROM item_serials WHERE id = $1`, [id]);
  return rows[0] ? mapSerial(rows[0]) : null;
}

export async function listSerials(itemId: string): Promise<ItemSerial[]> {
  const { rows } = await query<SerialRow>(
    `SELECT ${SERIAL_COLUMNS} FROM item_serials WHERE item_id = $1 ORDER BY serial_number`,
    [itemId],
  );
  return rows.map(mapSerial);
}

export async function setSerialStatus(
  id: string,
  status: SerialStatus,
  client?: PoolClient,
): Promise<ItemSerial> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows: existing } = await run<SerialRow>(
    `SELECT ${SERIAL_COLUMNS} FROM item_serials WHERE id = $1`,
    [id],
  );
  const current = existing[0];
  if (!current) throw new Error("سریال یافت نشد.");

  const error = validateSerialStatusTransition(current.status, status);
  if (error) throw new Error(error);

  const { rows } = await run<SerialRow>(
    `UPDATE item_serials SET status = $1 WHERE id = $2 RETURNING ${SERIAL_COLUMNS}`,
    [status, id],
  );
  return mapSerial(rows[0]);
}

export interface ItemWeightAttributes {
  itemId: string;
  purity: Purity;
  grossWeight: string;
  netWeight: string;
  unitCostPerGram: string | null;
  status: WeightItemStatus;
}

interface WeightAttributesRow extends Record<string, unknown> {
  item_id: string;
  purity: Purity;
  gross_weight: string;
  net_weight: string;
  unit_cost_per_gram: string | null;
  status: WeightItemStatus;
}

function mapWeightAttributes(row: WeightAttributesRow): ItemWeightAttributes {
  return {
    itemId: row.item_id,
    purity: row.purity,
    grossWeight: row.gross_weight,
    netWeight: row.net_weight,
    unitCostPerGram: row.unit_cost_per_gram,
    status: row.status,
  };
}

/** Sets (creates or replaces) the weight/purity/cost attributes of a `tracking: 'weight'` item — Wave 2/3's gold/jewelry pieces. Leaves `status` alone on an update (use setWeightItemStatus for that) and defaults a new row to `in_stock`. */
export async function setWeightAttributes(
  itemId: string,
  input: { purity: string; grossWeight: string; netWeight: string; unitCostPerGram?: string | null },
): Promise<ItemWeightAttributes> {
  const errors = validateWeightAttributes(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» می‌تواند ویژگی وزن/عیار داشته باشد.");
  }

  const { rows } = await query<WeightAttributesRow>(
    `INSERT INTO item_weight_attributes (item_id, purity, gross_weight, net_weight, unit_cost_per_gram)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_id) DO UPDATE
       SET purity = EXCLUDED.purity, gross_weight = EXCLUDED.gross_weight,
           net_weight = EXCLUDED.net_weight, unit_cost_per_gram = EXCLUDED.unit_cost_per_gram,
           updated_at = now()
     RETURNING *`,
    [itemId, input.purity, input.grossWeight, input.netWeight, input.unitCostPerGram ?? null],
  );
  return mapWeightAttributes(rows[0]);
}

export async function getWeightAttributes(itemId: string): Promise<ItemWeightAttributes | null> {
  const { rows } = await query<WeightAttributesRow>(
    `SELECT * FROM item_weight_attributes WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapWeightAttributes(rows[0]) : null;
}

export async function setWeightItemStatus(
  itemId: string,
  status: WeightItemStatus,
  client?: PoolClient,
): Promise<ItemWeightAttributes> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows: existing } = await run<WeightAttributesRow>(
    `SELECT * FROM item_weight_attributes WHERE item_id = $1`,
    [itemId],
  );
  const current = existing[0];
  if (!current) throw new Error("ویژگی وزن/عیار برای این کالا ثبت نشده است.");

  const error = validateWeightItemStatusTransition(current.status, status);
  if (error) throw new Error(error);

  const { rows } = await run<WeightAttributesRow>(
    `UPDATE item_weight_attributes SET status = $1, updated_at = now() WHERE item_id = $2 RETURNING *`,
    [status, itemId],
  );
  return mapWeightAttributes(rows[0]);
}

export interface ItemStone {
  id: string;
  itemId: string;
  stoneType: string;
  carat: string;
  cost: number;
  createdAt: string;
}

interface StoneRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  stone_type: string;
  carat: string;
  // bigint comes back from pg as a string (see gold-prices-service.ts) --
  // converted to a plain number in mapStone.
  cost: string;
  created_at: string;
}

function mapStone(row: StoneRow): ItemStone {
  return {
    id: row.id,
    itemId: row.item_id,
    stoneType: row.stone_type,
    carat: row.carat,
    cost: Number(row.cost),
    createdAt: row.created_at,
  };
}

/** Adds a gem/stone cost add-on to a `tracking: 'weight'` item — Wave 4's jewelry pieces. An item may carry several. */
export async function addStone(itemId: string, input: StoneInput): Promise<ItemStone> {
  const errors = validateStone(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» می‌تواند سنگ داشته باشد.");
  }

  const { rows } = await query<StoneRow>(
    `INSERT INTO item_stones (item_id, stone_type, carat, cost) VALUES ($1, $2, $3, $4) RETURNING *`,
    [itemId, input.stoneType.trim(), input.carat, input.cost],
  );
  return mapStone(rows[0]);
}

export async function listStones(itemId: string): Promise<ItemStone[]> {
  const { rows } = await query<StoneRow>(
    `SELECT * FROM item_stones WHERE item_id = $1 ORDER BY created_at`,
    [itemId],
  );
  return rows.map(mapStone);
}

/**
 * Removes a stone only if it belongs to the given item.
 *
 * The route verifies the parent item is at the caller's active branch, so the
 * parent-child predicate here is what prevents IDOR: a caller with access to
 * one item must not be able to delete a stone attached to another branch's
 * item by passing a foreign stone id. RLS on `item_stones` scopes by business
 * only (via its parent item), not by branch, so this application-level check
 * is load-bearing.
 */
export async function removeStone(id: string, itemId: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM item_stones WHERE id = $1 AND item_id = $2`,
    [id, itemId],
  );
  return (rowCount ?? 0) > 0;
}

/** Sum of an item's stone costs (0 if it has none) — the add-on to metal cost when computing COGS at sale time. */
export async function totalStoneCost(itemId: string, client?: PoolClient): Promise<number> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows } = await run<{ total: string | null }>(
    `SELECT SUM(cost)::text AS total FROM item_stones WHERE item_id = $1`,
    [itemId],
  );
  return Number(rows[0]?.total ?? 0);
}

export interface WeightItemSummary {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  purity: Purity;
  grossWeight: string;
  netWeight: string;
  unitCostPerGram: string | null;
  status: WeightItemStatus;
  stoneCost: number;
  consignorId: string | null;
  consignorName: string | null;
}

interface WeightItemSummaryRow extends Record<string, unknown> {
  id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  purity: Purity;
  gross_weight: string;
  net_weight: string;
  unit_cost_per_gram: string | null;
  status: WeightItemStatus;
  stone_cost: string | null;
  consignor_id: string | null;
  consignor_name: string | null;
}

/** The jewelry dashboard's item board: every `tracking: 'weight'` item at this branch, joined with its weight/cost basis, stone-cost add-on, and consignment (if any) in one round trip. */
export async function listWeightItems(locationId: string): Promise<WeightItemSummary[]> {
  const { rows } = await query<WeightItemSummaryRow>(
    `SELECT i.id, i.name, i.sku, i.is_active,
            w.purity, w.gross_weight, w.net_weight, w.unit_cost_per_gram, w.status,
            COALESCE((SELECT SUM(cost) FROM item_stones WHERE item_id = i.id), 0)::text AS stone_cost,
            c.consignor_id, cons.name AS consignor_name
       FROM items i
       JOIN item_weight_attributes w ON w.item_id = i.id
       LEFT JOIN item_consignments c ON c.item_id = i.id
       LEFT JOIN consignors cons ON cons.id = c.consignor_id
      WHERE i.location_id = $1 AND i.tracking = 'weight'
      ORDER BY i.name`,
    [locationId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku,
    isActive: r.is_active,
    purity: r.purity,
    grossWeight: r.gross_weight,
    netWeight: r.net_weight,
    unitCostPerGram: r.unit_cost_per_gram,
    status: r.status,
    stoneCost: Number(r.stone_cost ?? 0),
    consignorId: r.consignor_id,
    consignorName: r.consignor_name,
  }));
}
