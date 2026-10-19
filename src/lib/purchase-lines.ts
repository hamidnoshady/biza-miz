/**
 * Shared validation/conversion for a purchase's draft lines and its entered
 * date, used by both POST /api/inventory/purchases (create) and
 * PUT /api/inventory/purchases/[id] (edit). Kept here rather than duplicated in
 * the two route handlers so the two paths can never drift on how a line is
 * validated, converted, or costed.
 *
 * DB-touching (it resolves each line's purchase_unit_factor and checks
 * ownership), so purchase-lines.test.ts stubs query() to cover the arithmetic
 * and validation; the real SQL is exercised by the purchase integration tests.
 */
import { isUuid } from "./uuid";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { query } from "./db";
import { boundedRialText, positiveQuantityText, quantityText, rialText } from "./inventory-exact";

export interface PurchaseItemInput {
  inventoryItemId?: string;
  /** quantity in the item's purchase_unit (or base unit if none is set) */
  purchaseQty?: string;
  /** total Rial cost for this line (however the supplier invoiced it) */
  totalCost?: string;
}

/** A line converted to what purchase_items actually stores: base-unit quantity. */
export interface PurchaseLine {
  inventoryItemId: string;
  baseQty: string;
  totalCost: string;
}

export interface PreparedPurchaseLines {
  lines: PurchaseLine[];
  /** Σ of every line's Rial cost, as a decimal string (BigInt-safe). */
  total: string;
}

/** An error code the caller turns into a JSON response, mirroring the existing route codes. */
export class PurchaseLineError extends Error {
  constructor(
    readonly code: "no_items" | "invalid_item" | "item_not_found" | "invalid_purchase_date",
    readonly status: number,
  ) {
    super(code);
    this.name = "PurchaseLineError";
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The purchase's own date as the user entered it (ISO/Gregorian, per the
 * project's date convention), or null for "not given" — which the create path
 * turns into the *branch's* today and the edit path into "leave it alone".
 *
 * Absent, null, and blank are the only ways to mean "not given"; anything else
 * has to be a real date. Validated here rather than left to Postgres's `::date`
 * cast so a bad value comes back as a 400 the UI can explain instead of a 500,
 * and so a garbled field can never be quietly filed under today. The
 * round-trip comparison is what rejects a well-formed but non-existent day such
 * as 2025-02-31, which the regex alone would let through.
 */
export function purchaseDateOrNull(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") throw new PurchaseLineError("invalid_purchase_date", 400);
  const iso = input.trim();
  if (!iso) return null;
  const parsed = ISO_DATE_RE.test(iso) ? new Date(`${iso}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new PurchaseLineError("invalid_purchase_date", 400);
  }
  return iso;
}

/**
 * Validates each line, resolves the items against `locationId`, and converts
 * each purchaseQty from the item's purchase unit (e.g. kg) to its base/recipe
 * unit (e.g. g) via purchase_unit_factor — purchase_items/stock_movements
 * always store the base unit (see migrations/0006_inventory.sql).
 */
export async function preparePurchaseLines(
  items: PurchaseItemInput[],
  locationId: string,
  client?: PoolClient,
): Promise<PreparedPurchaseLines> {
  if (!Array.isArray(items) || items.length === 0) throw new PurchaseLineError("no_items", 400);
  for (const it of items) {
    if (!it || !isUuid(it.inventoryItemId) || typeof it.purchaseQty !== "string" || typeof it.totalCost !== "string") {
      throw new PurchaseLineError("invalid_item", 400);
    }
    try {
      const quantity = positiveQuantityText(it.purchaseQty);
      if (new Decimal(quantity).gte("1000000000000000")) throw new Error("quantity_out_of_range");
      boundedRialText(it.totalCost);
    } catch {
      throw new PurchaseLineError("invalid_item", 400);
    }
  }

  const inventoryItemIds = items.map((i) => i.inventoryItemId);
  const lookup = client ? client.query.bind(client) : query;
  const { rows: invItems } = await lookup<{ id: string; purchase_unit_factor: string }>(
    "SELECT id, purchase_unit_factor FROM inventory_items WHERE id = ANY($1::uuid[]) AND location_id = $2",
    [inventoryItemIds, locationId],
  );
  const factorById = new Map(invItems.map((i) => [i.id, positiveQuantityText(i.purchase_unit_factor)]));
  if (invItems.length !== new Set(inventoryItemIds).size) {
    throw new PurchaseLineError("item_not_found", 404);
  }

  let lines: PurchaseLine[];
  try {
    lines = items.map((it) => {
      const factor = factorById.get(it.inventoryItemId!)!;
      const baseQty = quantityText(new Decimal(it.purchaseQty!).times(new Decimal(factor)).toFixed());
      if (new Decimal(baseQty).gte("1000000000000000")) throw new Error("quantity_out_of_range");
      return { inventoryItemId: it.inventoryItemId!, baseQty, totalCost: rialText(it.totalCost!) };
    });
  } catch {
    throw new PurchaseLineError("invalid_item", 400);
  }

  const total = lines.reduce((sum, line) => sum + BigInt(line.totalCost), 0n).toString();
  try { boundedRialText(total); } catch { throw new PurchaseLineError("invalid_item", 400); }
  return { lines, total };
}
