/**
 * Phase 42b — retail warehouse documents (رسید/حواله انبار) on the RETAIL
 * stock model (`items` / `item_stock` / `item_batches`), lifted the same way
 * `warehouse-document-service.ts` was for F&B: the route handler and any
 * future executor call the same function, never two implementations of the
 * same posting.
 *
 * A retail warehouse document is a posted source document, created already
 * complete: lot/stock move + ledger entry in one transaction, immutable
 * afterwards, corrected by the opposite document.
 *
 *   receipt (رسید) — stock in without a purchase. Line qty × whole-Rial unit
 *     cost is authoritative for the ledger. The lot named on the line is
 *     upserted into `item_batches`: an existing lot gains the quantity and is
 *     re-averaged to the weighted average (expiry preserved unless the line
 *     supplies one); a new lot is created through `receiveBatch`. Either way
 *     `item_stock` is rolled to the SUM of the item's batches at their
 *     weighted-average cost — the 0078 invariant, through the exact same
 *     `rollItemStockToBatches` write `receiveBatch` uses. A `tracking='none'`
 *     item goes through `receiveStock` (the purchase path's own engine).
 *     Ledger: Debit {industry}Inventory / Credit 4900 (other income).
 *
 *   issue (حواله) — stock out without a sale or a supplier return. A
 *     batch-tracked line must name an existing lot of the item, the lot must
 *     cover the quantity, and the lot is relieved at ITS OWN cost; a
 *     `tracking='none'` line is relieved from `item_stock` at its running
 *     cost. Short stock is REFUSED — retail has no negative layers (F&B's
 *     0141 settlement machinery deliberately does not apply here). Ledger:
 *     Debit 5900 (other expense) / Credit {industry}Inventory.
 *
 * Serial-tracked and weight-tracked items are refused (their intake paths
 * are one-row-per-unit, not a fungible quantity), and a supplier is refused
 * on any warehouse document: a receipt WITH a supplier is «خرید», a return
 * TO one is «حواله بازگشت» — both already exist and stay where they are.
 *
 * The DB half is not unit-tested directly (repo convention) — the pure
 * parsing/valuation helpers below are covered in
 * retail-warehouse-document-service.test.ts, and the flows in
 * integration/retail-warehouse-document.integration.test.ts.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { receiveStock } from "./accessories-service";
import { receiveBatch, rollItemStockToBatches } from "./cosmetics-service";
import {
  MAX_RIAL,
  quantityText,
  rialText,
  roundRial,
  type QuantityText,
  type RialText,
} from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { validateItemQuantity, validateItemUnitCost } from "./retail-stock";
import { isUuid } from "./uuid";
import { WELL_KNOWN_CODES } from "./coa-template";
import { inventoryCodeForBusiness as retailInventoryCodeForBusiness } from "./retail-stock-posting-rules";
// Side-effect import: registers the retail.* posting rules the documents post
// through (retail.warehouse_receipt / retail.warehouse_issue included).
import "./retail-stock-posting-rules";

export const RETAIL_WAREHOUSE_DOCUMENT_KINDS = ["receipt", "issue"] as const;
export type RetailWarehouseDocumentKind = (typeof RETAIL_WAREHOUSE_DOCUMENT_KINDS)[number];

export function isRetailWarehouseDocumentKind(value: unknown): value is RetailWarehouseDocumentKind {
  return (
    typeof value === "string" &&
    (RETAIL_WAREHOUSE_DOCUMENT_KINDS as readonly string[]).includes(value)
  );
}

/** The domain event the kind posts under. */
export function eventTypeForRetailWarehouseDocument(
  kind: RetailWarehouseDocumentKind,
): "retail.warehouse_receipt" | "retail.warehouse_issue" {
  return kind === "receipt" ? "retail.warehouse_receipt" : "retail.warehouse_issue";
}

/** One validated line of a retail warehouse document. */
export interface RetailWarehouseDocumentLine {
  itemId: string;
  quantity: QuantityText;
  /** Rial per unit at the document. Receipt lines only; issue lines carry 0 until relieved. */
  unitCost: number;
  /** The lot/batch number the line names, when it names one. */
  lotNumber: string | null;
  /** ISO date (YYYY-MM-DD) or null — receipt lines only. */
  expiryDate: string | null;
  /** qty × unitCost, whole Rial — receipt. Issue lines are valued on relief. */
  value: RialText;
}

export interface ParsedRetailWarehouseDocument {
  kind: RetailWarehouseDocumentKind;
  lines: RetailWarehouseDocumentLine[];
  /** Sum of the receipt lines' values (issue: 0 — the real total comes out of the relief). */
  totalValue: RialText;
}

/**
 * Validates the raw lines the route hands over, with the retail module's own
 * Number-based validators (`retail-stock.ts`). Rules:
 *   - at least one line (`no_items`);
 *   - no item twice in one document (`invalid_line` — the UNIQUE(document,
 *     item) column would reject it with an SQL error instead of a clean 400);
 *   - quantities are positive parseable numbers (`invalid_quantity`);
 *   - receipt lines carry a unit cost (`missing_cost`) that is a whole-Rial
 *     non-negative number (`invalid_cost`). Issue lines carry none: the lot's
 *     own cost is authoritative.
 */
export function parseRetailWarehouseDocumentLines(
  kind: RetailWarehouseDocumentKind,
  rawLines: Array<{
    itemId?: string;
    quantity?: string | number;
    unitCost?: string | number;
    lot?: string | null;
    expiryDate?: string | null;
  }>,
): ParsedRetailWarehouseDocument {
  const lines: RetailWarehouseDocumentLine[] = [];
  const seen = new Set<string>();
  for (const raw of rawLines) {
    const itemId = raw?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0 || seen.has(itemId)) {
      throw new Error("invalid_line");
    }
    seen.add(itemId);

    const qtyError = validateItemQuantity(raw?.quantity ?? "");
    if (qtyError) throw new Error("invalid_quantity");
    const quantity = quantityText(String(raw.quantity));

    let unitCost = 0;
    if (kind === "receipt") {
      const rawCost = raw?.unitCost;
      const cost = Number(rawCost);
      if (rawCost === undefined || rawCost === null || rawCost === "" || !Number.isFinite(cost)) {
        throw new Error("missing_cost");
      }
      const costError = validateItemUnitCost(cost);
      if (costError) throw new Error("invalid_cost");
      // `unit_cost` is a bigint column: a value past 2^63-1 aborts the INSERT
      // with «out of range for type bigint» — a 500 for what is really a
      // mistyped cost. Answer it as the caller error it is.
      if (!Number.isSafeInteger(cost)) throw new Error("cost_out_of_range");
      unitCost = cost;
    }

    const lotNumber = typeof raw?.lot === "string" ? raw.lot.trim() : "";
    const expiryDate =
      typeof raw?.expiryDate === "string" && raw.expiryDate.trim() ? raw.expiryDate.trim() : null;

    lines.push({
      itemId,
      quantity,
      unitCost,
      lotNumber: lotNumber || null,
      expiryDate,
      value: kind === "receipt" ? retailLineValue(quantity, unitCost) : rialText("0"),
    });
  }
  if (lines.length === 0) throw new Error("no_items");

  let totalValue = 0n;
  for (const line of lines) totalValue += BigInt(line.value);
  // The document total lands in a bigint column too, so a stack of
  // individually-valid lines must not add up past the ceiling either.
  if (totalValue > MAX_RIAL) throw new Error("cost_out_of_range");
  return { kind, lines, totalValue: rialText(totalValue.toString()) };
}

/** qty × unitCost, rounded to whole Rial (half up) — the receipt line's value. */
export function retailLineValue(quantity: string, unitCost: number): RialText {
  return roundRial(new Decimal(quantity).times(unitCost));
}

/**
 * The re-averaged unit cost of a lot that receives `addQuantity` at
 * `addUnitCost` on top of its current `existingQuantity` @ `existingUnitCost`:
 * the weighted average of the two layers, whole Rial. A null existing cost is
 * an unknown, and unknown stock is carried at zero value — the same treatment
 * `averageAcrossBatches` gives a null-cost batch.
 */
export function nextLotUnitCost(
  existingQuantity: string,
  existingUnitCost: number | null,
  addQuantity: string,
  addUnitCost: number,
): number {
  const totalQuantity = new Decimal(existingQuantity).plus(addQuantity);
  if (totalQuantity.lte(0)) return addUnitCost;
  const totalValue = new Decimal(existingQuantity).times(existingUnitCost ?? 0).plus(
    new Decimal(addQuantity).times(addUnitCost),
  );
  return Number(roundRial(totalValue.div(totalQuantity)));
}

/**
 * The expiry a lot keeps after a receipt: the one the line carries, or — when
 * the line carries none — the one the lot already had (COALESCE). A receipt
 * may date a lot it tops up; it may never un-date one.
 */
export function preservedExpiry(existing: string | null, incoming: string | null): string | null {
  return incoming ?? existing;
}

/** Whether a lot's quantity covers a line's — the issue-side stock check. */
export function lotCoversQuantity(lotQuantity: string, lineQuantity: string): boolean {
  return !new Decimal(lotQuantity).lt(lineQuantity);
}

/** The lot number a receipt line without one gets, so the batch stays traceable to the document. */
export function generatedLotNumber(documentId: string, lineIndex: number): string {
  return `W-${documentId.slice(0, 8)}-${lineIndex + 1}`;
}

export class RetailWarehouseDocumentError extends Error {}

export interface CreateRetailWarehouseDocumentParams {
  businessId: string;
  locationId: string;
  kind: RetailWarehouseDocumentKind;
  /**
   * Always refused: a receipt with a supplier is «خرید» (item_purchases) and a
   * return to one is «حواله بازگشت» (item_supplier_returns). The warehouse
   * document is the supplier-less in/out.
   */
  supplierId?: string | null;
  /** Issue only: free-text destination/recipient. */
  recipient?: string | null;
  documentNumber?: string | null;
  note?: string | null;
  createdBy?: string | null;
  lines: RetailWarehouseDocumentLine[];
}

export interface CreatedRetailWarehouseDocument {
  id: string;
  totalValue: RialText;
  /** The GL entry the document posted, when it posted one (a zero-value document posts nothing). */
  entryId: string | null;
  /** The posting's two account codes, for the success summary. */
  debitCode: string;
  creditCode: string;
}

interface ItemEligibilityRow {
  id: string;
  location_id: string;
  kind: string;
  tracking: string;
  is_active: boolean;
}

/**
 * Loads and screens one line's item through the caller's transaction: it must
 * exist, be active, belong to this warehouse (branch), be a sellable variant
 * (not a family), and be fungibly tracked (`none` or `batch`). Serial and
 * weight items are refused — their intake paths are one-row-per-unit.
 */
async function eligibleItemOrThrow(
  client: PoolClient,
  itemId: string,
  locationId: string,
): Promise<ItemEligibilityRow> {
  // `WHERE id = $1` against a uuid column raises a syntax error rather than
  // returning no rows for a non-uuid, which surfaces as a 500 instead of the
  // honest «کالا در این انبار یافت نشد» — see `isUuid`.
  if (!isUuid(itemId)) {
    throw new RetailWarehouseDocumentError("کالا در این انبار یافت نشد.");
  }
  const { rows } = await client.query<ItemEligibilityRow>(
    `SELECT id, location_id, kind::text, tracking::text, is_active
       FROM items WHERE id = $1`,
    [itemId],
  );
  const item = rows[0];
  if (!item || item.location_id !== locationId || !item.is_active) {
    throw new RetailWarehouseDocumentError("کالا در این انبار یافت نشد.");
  }
  if (item.kind === "variant_parent") {
    throw new RetailWarehouseDocumentError(
      "موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.",
    );
  }
  if (item.tracking === "serial") {
    // Issue #795 — serialized intake with accounting is the purchase receipt
    // (receiveItemPurchase with exact serials); a warehouse adjustment
    // document on a one-row-per-unit serial would bypass that chain.
    throw new RetailWarehouseDocumentError("کالای سریالی از مسیر «دریافت خرید» با سریال دقیق ثبت می‌شود.");
  }
  if (item.tracking === "weight") {
    throw new RetailWarehouseDocumentError("کالای وزنی از مسیر وزن/عیار ثبت می‌شود.");
  }
  return item;
}

interface BatchRow {
  id: string;
  quantity: string;
  unit_cost: string | null;
}

/**
 * Creates a retail warehouse document and posts it. Runs inside the caller's
 * transaction (`client`), exactly like `receiveItemPurchase` — the route
 * opens BEGIN/COMMIT around it and any future executor reuses the same shape.
 */
export async function createRetailWarehouseDocumentInTransaction(
  client: PoolClient,
  params: CreateRetailWarehouseDocumentParams,
): Promise<CreatedRetailWarehouseDocument> {
  if (params.lines.length === 0) throw new Error("no_items");
  if (!isUuid(params.locationId)) throw new RetailWarehouseDocumentError("انبار یافت نشد.");

  const { rows: locationRows } = await client.query<{ id: string; is_active: boolean }>(
    "SELECT id, is_active FROM locations WHERE id = $1 AND business_id = $2",
    [params.locationId, params.businessId],
  );
  const location = locationRows[0];
  if (!location) throw new RetailWarehouseDocumentError("انبار یافت نشد.");
  if (!location.is_active) throw new RetailWarehouseDocumentError("این انبار غیرفعال است.");

  if (params.supplierId) {
    throw new RetailWarehouseDocumentError(
      "سند انبار تأمین‌کننده ندارد؛ خرید از مسیر «خرید» و برگشت به تأمین‌کننده از مسیر «حواله بازگشت» ثبت می‌شود.",
    );
  }

  const documentNumber = params.documentNumber?.trim() || null;
  if (documentNumber) {
    const { rows: taken } = await client.query<{ id: string }>(
      `SELECT id FROM retail_warehouse_documents WHERE business_id = $1 AND document_number = $2`,
      [params.businessId, documentNumber],
    );
    if (taken[0]) {
      throw new RetailWarehouseDocumentError("سندی با این شماره قبلاً ثبت شده است.");
    }
  }

  const { rows: docRows } = await client.query<{ id: string }>(
    `INSERT INTO retail_warehouse_documents
       (business_id, location_id, kind, recipient, document_number, note, created_by, total_value_rial)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.kind,
      params.kind === "issue" ? params.recipient?.trim() || null : null,
      documentNumber,
      params.note?.trim() || null,
      params.createdBy ?? null,
    ],
  );
  const documentId = docRows[0].id;

  let total = 0n;
  for (let i = 0; i < params.lines.length; i++) {
    const line = params.lines[i];
    const item = await eligibleItemOrThrow(client, line.itemId, params.locationId);

    let value: RialText;
    let unitCost: number;
    let batchId: string | null = null;

    if (params.kind === "receipt") {
      unitCost = line.unitCost;
      value = line.value;

      if (item.tracking === "batch") {
        const lotNumber = line.lotNumber ?? generatedLotNumber(documentId, i);
        const { rows: batchRows } = await client.query<BatchRow>(
          `SELECT id, quantity::text, unit_cost::text
             FROM item_batches WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
          [line.itemId, lotNumber],
        );
        const existing = batchRows[0];
        if (existing) {
          // Existing lot: add the quantity, re-average the lot's own cost,
          // keep its expiry unless this line dates it.
          const reAveraged = nextLotUnitCost(
            existing.quantity,
            existing.unit_cost == null ? null : Number(existing.unit_cost),
            line.quantity,
            line.unitCost,
          );
          await client.query(
            `UPDATE item_batches
                SET quantity = quantity + $3,
                    unit_cost = $4,
                    expiry_date = COALESCE($5::date, expiry_date)
              WHERE id = $1 AND item_id = $2`,
            [existing.id, line.itemId, line.quantity, reAveraged, line.expiryDate],
          );
          batchId = existing.id;
        } else {
          // New lot: the purchase path's own create-and-roll (receiveBatch
          // creates the batch AND rolls item_stock to the 0078 invariant).
          const batch = await receiveBatch(client, {
            itemId: line.itemId,
            batchNumber: lotNumber,
            expiryDate: line.expiryDate,
            quantity: line.quantity,
            unitCost: line.unitCost,
            supplierReference: documentId,
          });
          batchId = batch.id;
        }
        // Either way, the item's stock is the SUM of its batches at their
        // weighted-average cost — the same write receiveBatch ends with.
        await rollItemStockToBatches(client, line.itemId);
      } else {
        // tracking='none': the fungible receive path purchases already use.
        await receiveStock(line.itemId, { quantity: line.quantity, unitCost: line.unitCost }, client);
      }
    } else {
      if (item.tracking === "batch") {
        if (!line.lotNumber) {
          throw new RetailWarehouseDocumentError("برای حواله کالای بچ‌محور، بچ را مشخص کنید.");
        }
        const { rows: batchRows } = await client.query<BatchRow>(
          `SELECT id, quantity::text, unit_cost::text
             FROM item_batches WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
          [line.itemId, line.lotNumber],
        );
        const batch = batchRows[0];
        if (!batch) throw new RetailWarehouseDocumentError("بچ یافت نشد.");
        if (!lotCoversQuantity(batch.quantity, line.quantity)) {
          throw new RetailWarehouseDocumentError("موجودی بچ کافی نیست.");
        }
        // A lot with no cost basis cannot be valued, and issuing it at zero
        // would write stock out of the books for free — the same refusal the
        // tracking='none' branch below already makes on `item_stock`.
        if (batch.unit_cost == null) {
          throw new RetailWarehouseDocumentError("بهای تمام‌شده این بچ ثبت نشده است.");
        }
        // Relieve the lot at the lot's OWN cost.
        unitCost = Number(batch.unit_cost);
        value = retailLineValue(line.quantity, unitCost);
        await client.query(
          `UPDATE item_batches SET quantity = quantity - $3 WHERE id = $1 AND item_id = $2`,
          [batch.id, line.itemId, line.quantity],
        );
        batchId = batch.id;
        await rollItemStockToBatches(client, line.itemId);
      } else {
        // FOR UPDATE, not the plain `getStock` read: between an unlocked read
        // and the UPDATE below, a concurrent sale or issue can take the stock
        // this check just approved. The row-level CHECK (quantity >= 0) would
        // then abort the transaction with a Postgres error (a 500) instead of
        // the honest «موجودی کافی نیست». Serialise on the row — the batch
        // branch above already does, via `SELECT … FOR UPDATE` on the lot.
        const { rows: stockRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
          `SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
          [line.itemId],
        );
        const stock = stockRows[0];
        if (!stock) throw new RetailWarehouseDocumentError("موجودی این کالا ثبت نشده است.");
        if (stock.unit_cost == null) {
          throw new RetailWarehouseDocumentError("بهای تمام‌شده کالا ثبت نشده است.");
        }
        if (!lotCoversQuantity(stock.quantity, line.quantity)) {
          throw new RetailWarehouseDocumentError("موجودی کافی نیست.");
        }
        unitCost = Number(stock.unit_cost);
        value = retailLineValue(line.quantity, unitCost);
        await client.query(
          `UPDATE item_stock SET quantity = quantity - $2, updated_at = now() WHERE item_id = $1`,
          [line.itemId, line.quantity],
        );
      }
    }

    await client.query(
      `INSERT INTO retail_warehouse_document_lines
         (document_id, item_id, batch_id, lot_number, expiry_date, quantity, unit_cost, value_rial)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)`,
      [
        documentId,
        line.itemId,
        batchId,
        line.lotNumber,
        params.kind === "receipt" ? line.expiryDate : null,
        line.quantity,
        unitCost,
        value,
      ],
    );
    total += BigInt(value);
  }

  await client.query(`UPDATE retail_warehouse_documents SET total_value_rial = $2 WHERE id = $1`, [
    documentId,
    total.toString(),
  ]);

  const inventoryCode = await retailInventoryCodeForBusiness(client, params.businessId);
  const debitCode = params.kind === "receipt" ? inventoryCode : WELL_KNOWN_CODES.otherExpense;
  const creditCode = params.kind === "receipt" ? WELL_KNOWN_CODES.otherIncome : inventoryCode;

  const { entryId } = await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: eventTypeForRetailWarehouseDocument(params.kind),
    payload: { documentId, amount: rialText(total.toString()), debitCode, creditCode },
    sourceType: "retail_warehouse_document",
    sourceId: documentId,
    createdBy: params.createdBy ?? null,
  });

  return { id: documentId, totalValue: rialText(total.toString()), entryId, debitCode, creditCode };
}

/** The same write, opening and owning its own transaction. */
export async function createRetailWarehouseDocument(
  params: CreateRetailWarehouseDocumentParams,
): Promise<CreatedRetailWarehouseDocument> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createRetailWarehouseDocumentInTransaction(client, params);
    await client.query("COMMIT");
    return created;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
