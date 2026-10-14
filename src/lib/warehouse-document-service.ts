/**
 * Phase 42 — warehouse documents (رسید/حواله انبار), lifted the same way
 * `waste-service.ts` was: the route handler and any future executor call the
 * same function, never two implementations of the same posting.
 *
 * A warehouse document is a posted source document, created already complete:
 * stock movement + ledger entry in one transaction, immutable afterwards.
 *
 *   receipt (رسید) — stock in without a purchase order. Line qty × unit cost
 *     is authoritative; it settles open negative layers first (a physical
 *     receipt is evidence the shortage is covered) and the residual becomes a
 *     FIFO lot / weighted-average carrying value — the same mechanics
 *     `applyPurchaseReceiptCosting` uses for the positive portion of a
 *     purchase receipt. Ledger: Debit 1300 (inventory) / Credit 4900 (other
 *     income) — stock received without an invoice is other income.
 *
 *   issue (حواله) — stock out without a sale or waste entry. Consumed
 *     through `consumeInventoryExact` exactly like a sale (a priced negative
 *     layer opens when the stock runs short), so the posted cost is the
 *     exact-costing cost of what actually left. Ledger: Debit 5900 (other
 *     expense) / Credit 1300 (inventory).
 *
 * Both accounts (4900 «سایر درآمدها», 5900 «سایر هزینه‌ها») exist in every
 * industry's COA template, so the posting rule needs no per-industry lookup.
 *
 * DB-touching, so not unit-tested directly (repo convention) — the pure
 * parsing/valuation helpers below are covered in warehouse-document-service.test.ts.
 */
import Decimal from "decimal.js";
import { getPool, query, type PoolClient } from "./db";
import {
  allocateRialByWeight,
  boundedRialText,
  minQuantity,
  positiveQuantityText,
  proportionalDepletionValue,
  quantityText,
  rialBigInt,
  rialText,
  subtractQuantity,
  type QuantityText,
  type RialText,
} from "./inventory-exact";
import { consumeInventoryExact } from "./inventory-consumption-exact";
import { isLotBased } from "./inventory-costing";
import { getCostingMethod, getInventorySystem } from "./inventory-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { emitDomainEvent } from "./posting-engine";
import { isUuid } from "./uuid";
// Side-effect import: registers "inventory.operational_posting" with the engine.
import "./fnb-posting-rules";

export const WAREHOUSE_DOCUMENT_KINDS = ["receipt", "issue"] as const;
export type WarehouseDocumentKind = (typeof WAREHOUSE_DOCUMENT_KINDS)[number];

export function isWarehouseDocumentKind(value: unknown): value is WarehouseDocumentKind {
  return typeof value === "string" && (WAREHOUSE_DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** One validated line of a warehouse document. */
export interface WarehouseDocumentLine {
  inventoryItemId: string;
  quantity: QuantityText;
  /** Rial per unit at the document. Receipt lines only; issue lines carry "0". */
  unitCost: RialText;
  /** qty × unitCost, whole Rial — receipt. Issue lines are valued on consumption. */
  value: RialText;
}

export interface ParsedWarehouseDocument {
  kind: WarehouseDocumentKind;
  lines: WarehouseDocumentLine[];
  /** Sum of the receipt lines' values (issue: 0 — the real total comes out of consumption). */
  totalValue: RialText;
}

/**
 * Validates the raw lines the route hands over. Rules:
 *   - at least one line (`no_items`);
 *   - no item twice in one document (`invalid_line` — the UNIQUE(document, item)
 *     column would reject it with an SQL error instead of a clean 400);
 *   - quantities are positive canonical decimals (`invalid_quantity`);
 *   - unit costs are whole-Rial non-negative (`invalid_rial`), receipts only.
 */
export function parseWarehouseDocumentLines(
  kind: WarehouseDocumentKind,
  rawLines: Array<{
    inventoryItemId?: string;
    quantity?: string;
    unitCost?: string | number;
  }>,
): ParsedWarehouseDocument {
  const lines: WarehouseDocumentLine[] = [];
  const seen = new Set<string>();
  for (const raw of rawLines) {
    const itemId = raw?.inventoryItemId;
    if (typeof itemId !== "string" || itemId.length === 0 || seen.has(itemId)) {
      throw new Error("invalid_line");
    }
    seen.add(itemId);
    const quantity = positiveQuantityText(String(raw.quantity ?? ""));
    let unitCost: RialText = rialText("0");
    if (kind === "receipt") {
      unitCost = boundedRialText(String(raw.unitCost ?? "0"));
    }
    const value = kind === "receipt" ? lineValue(quantity, unitCost) : rialText("0");
    // A receipt line must carry value. Exact costing (0015's
    // `inventory_lot_exact_value_bounds`) forbids a lot holding quantity at
    // zero value, so a costless receipt cannot be represented: under FIFO it
    // aborted the transaction with a CHECK violation, and under weighted
    // average it quietly added stock with no cost basis, which then poisons
    // every later consumption. Refuse it here so both costing methods answer
    // the same way, before anything is written.
    if (kind === "receipt" && rialBigInt(value) === 0n) {
      throw new Error("receipt_value_required");
    }
    lines.push({ inventoryItemId: itemId, quantity, unitCost, value });
  }
  if (lines.length === 0) throw new Error("no_items");
  let totalValue = 0n;
  for (const line of lines) totalValue += rialBigInt(line.value);
  // The document's own total lands in a bigint column too, so a stack of
  // individually-valid lines must not add up past the ceiling either.
  return { kind, lines, totalValue: boundedRialText(totalValue.toString()) };
}

/** qty × unitCost, rounded to whole Rial. */
export function lineValue(quantity: QuantityText, unitCost: RialText): RialText {
  return rialText(new Decimal(quantity).times(rialBigInt(unitCost)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed());
}

/** The stock_movement_type the kind consumes/produces. */
export function movementTypeFor(kind: WarehouseDocumentKind): "warehouse_in" | "warehouse_out" {
  return kind === "receipt" ? "warehouse_in" : "warehouse_out";
}

/** The inventory_event_type the kind posts under. */
export function eventTypeFor(kind: WarehouseDocumentKind): "warehouse_receipt" | "warehouse_issue" {
  return kind === "receipt" ? "warehouse_receipt" : "warehouse_issue";
}

export interface CreatedWarehouseDocument {
  id: string;
  totalValue: RialText;
}

interface NegativeLayer {
  id: string;
  remaining_quantity: string;
  remaining_provisional_value_rial: string | null;
}

/**
 * Rial per unit implied by an extended value — full 9-dp precision, for the
 * `numeric(24,9)` columns (`stock_movements.unit_cost`, `inventory_lots
 * .unit_cost`) that record the exact cost basis.
 */
function derivedUnitCost(value: RialText, quantity: QuantityText): string {
  if (new Decimal(quantity).eq(0)) return "0";
  return new Decimal(value).div(quantity).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
}

/**
 * The same ratio rounded to whole Rial, for `warehouse_document_lines
 * .unit_cost` — a **bigint** column.
 *
 * An issue line's unit cost is derived from what the exact-costing path
 * actually consumed, and that division is almost never whole: issuing 0.7 of a
 * 333-Rial lot posts 233 Rial, i.e. 332.857142857 per unit. Handing that to a
 * bigint column made Postgres reject the INSERT (`invalid input syntax for
 * type bigint`), which aborted the transaction and surfaced as a 500 — an
 * ordinary fractional issue could not be posted at all.
 *
 * `value_rial` stays the authoritative number (it is what the ledger posts);
 * the displayed per-unit cost is a rounded read-out of it, exactly as the
 * detail dialog presents it.
 */
function documentLineUnitCost(value: RialText, quantity: QuantityText): string {
  if (new Decimal(quantity).eq(0)) return "0";
  return new Decimal(value).div(quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

export interface CreateWarehouseDocumentParams {
  businessId: string;
  locationId: string;
  kind: WarehouseDocumentKind;
  supplierId: string | null;
  recipient: string | null;
  documentNumber: string | null;
  note: string | null;
  createdBy: string | null;
  lines: WarehouseDocumentLine[];
}

/**
 * Creates a warehouse document and posts it. Runs inside the caller's
 * transaction (`client`), exactly like `recordWasteInTransaction`.
 */
export interface WarehouseDocumentListRow extends Record<string, unknown> {
  id: string;
  kind: WarehouseDocumentKind;
  location_id: string;
  location_name: string;
  supplier_name: string | null;
  recipient: string | null;
  document_number: string | null;
  note: string | null;
  total_value_rial: string;
  created_at: string;
  created_by_name: string | null;
  line_count: number;
}

/**
 * The document list the warehouse screen paints — moved here verbatim from
 * the route so GET and the MCP read share one definition (#883 batch L). The
 * route keeps its 400 guards for malformed filters; the service assumes them
 * already validated (uuid + kind).
 */
export async function listWarehouseDocuments(
  businessId: string,
  options: { kind?: WarehouseDocumentKind; locationId?: string; limit?: number } = {},
): Promise<WarehouseDocumentListRow[]> {
  const clauses = ["d.business_id = $1"];
  const params: unknown[] = [businessId];
  if (options.kind) {
    params.push(options.kind);
    clauses.push(`d.kind = $${params.length}`);
  }
  if (options.locationId) {
    params.push(options.locationId);
    clauses.push(`d.location_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const { rows } = await query<WarehouseDocumentListRow>(
    `SELECT d.id, d.kind, d.location_id, l.name AS location_name,
            COALESCE(p.name, s.name) AS supplier_name,
            d.recipient, d.document_number, d.note,
            d.total_value_rial::text AS total_value_rial,
            d.created_at, u.full_name AS created_by_name,
            (SELECT count(*) FROM warehouse_document_lines l2
              WHERE l2.document_id = d.id)::int AS line_count
       FROM warehouse_documents d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $1
       LEFT JOIN users u ON u.id = d.created_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return rows;
}

export async function createWarehouseDocumentInTransaction(
  client: PoolClient,
  params: CreateWarehouseDocumentParams,
): Promise<CreatedWarehouseDocument> {
  if (params.lines.length === 0) throw new Error("no_items");

  // `WHERE id = $1` against a uuid column raises a syntax error rather than
  // returning no rows for a non-uuid, which surfaces as a 500 instead of an
  // honest 404 — see `isUuid`. Screen every id the body supplies.
  if (!isUuid(params.locationId)) throw new Error("location_not_found");
  for (const line of params.lines) {
    if (!isUuid(line.inventoryItemId)) throw new Error("item_not_found");
  }
  if (params.supplierId && !isUuid(params.supplierId)) throw new Error("supplier_not_found");

  const { rows: locationRows } = await client.query<{ id: string; is_active: boolean }>(
    "SELECT id, is_active FROM locations WHERE id = $1 AND business_id = $2",
    [params.locationId, params.businessId],
  );
  const location = locationRows[0];
  if (!location) throw new Error("location_not_found");
  if (!location.is_active) throw new Error("location_inactive");
  // رسید/حواله انبار write priced stock movements — perpetual instruments.
  if ((await getInventorySystem(params.businessId, client)) === "periodic") {
    throw new Error("periodic_system_unsupported");
  }

  let supplierId: string | null = null;
  if (params.supplierId) {
    if (params.kind !== "receipt") throw new Error("invalid_line");
    const { rows: supplierRows } = await client.query<{ id: string }>(
      "SELECT id FROM suppliers WHERE id = $1 AND location_id = $2",
      [params.supplierId, params.locationId],
    );
    if (supplierRows.length === 0) throw new Error("supplier_not_found");
    supplierId = supplierRows[0].id;
  }

  for (const line of params.lines) {
    const { rows: itemRows } = await client.query<{ id: string }>(
      "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2 AND is_active",
      [line.inventoryItemId, params.locationId],
    );
    if (itemRows.length === 0) throw new Error("item_not_found");
  }

  const totalValue: RialText = params.kind === "receipt" ? params.lines.reduce<RialText>(
    (total, line) => rialText((rialBigInt(total) + rialBigInt(line.value)).toString()),
    rialText("0"),
  ) : rialText("0");

  const { rows: docRows } = await client.query<{ id: string }>(
    `INSERT INTO warehouse_documents
       (business_id, location_id, kind, supplier_id, recipient, document_number, note, created_by, total_value_rial)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.kind,
      supplierId,
      params.recipient ?? null,
      params.documentNumber ?? null,
      params.note ?? null,
      params.createdBy,
      rialBigInt(totalValue).toString(),
    ],
  );
  const documentId = docRows[0].id;

  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,created_by,metadata,costing_version)
     VALUES($1,$2,$3,$4,$5,jsonb_build_object('kind',$6::text,'documentNumber',$7::text),2)
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      eventTypeFor(params.kind),
      eventTypeFor(params.kind),
      params.createdBy,
      params.kind,
      params.documentNumber ?? null,
    ],
  );
  const eventId = eventRows[0].id;
  await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [eventId]);

  if (params.kind === "receipt") {
    await applyWarehouseReceiptCosting(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      documentId,
      inventoryEventId: eventId,
      lines: params.lines,
      createdBy: params.createdBy,
    });
  } else {
    let issuedTotal = 0n;
    for (const line of params.lines) {
      const result = await consumeInventoryExact(client, {
        locationId: params.locationId,
        businessId: params.businessId,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        type: "warehouse_out",
        sourceType: "warehouse_issue",
        sourceId: documentId,
        createdBy: params.createdBy,
        inventoryEventId: eventId,
      });
      issuedTotal += rialBigInt(result.postedCost);
      await client.query(
        `INSERT INTO warehouse_document_lines
           (document_id, inventory_item_id, quantity, unit_cost, value_rial)
         VALUES($1,$2,$3,$4,$5)`,
        [
          documentId,
          line.inventoryItemId,
          line.quantity,
          documentLineUnitCost(result.postedCost, line.quantity),
          result.postedCost,
        ],
      );
    }
    await upsertDocumentTotal(client, documentId, rialText(issuedTotal.toString()));
  }

  const postedTotal =
    params.kind === "receipt" ? totalValue : (await documentTotalFromDb(client, documentId));

  await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: "inventory.operational_posting",
    payload: {
      debitCode: params.kind === "receipt" ? WELL_KNOWN_CODES.inventory : WELL_KNOWN_CODES.otherExpense,
      creditCode: params.kind === "receipt" ? WELL_KNOWN_CODES.otherIncome : WELL_KNOWN_CODES.inventory,
      amount: postedTotal,
      memo: params.kind === "receipt" ? "رسید انبار" : "حواله انبار",
      postingKind: eventTypeFor(params.kind),
      inventoryEventId: eventId,
    },
    sourceType: eventTypeFor(params.kind),
    sourceId: documentId,
    createdBy: params.createdBy,
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [eventId]);

  return { id: documentId, totalValue: postedTotal };
}

/** The same write, opening and owning its own transaction. */
export async function createWarehouseDocument(
  params: CreateWarehouseDocumentParams,
): Promise<CreatedWarehouseDocument> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createWarehouseDocumentInTransaction(client, params);
    await client.query("COMMIT");
    return created;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The receipt side of a Phase 42 document: settle the item's open negative
 * layers first (oldest first), then let the residual become a FIFO lot (or a
 * weighted-average carrying value). Mirrors the positive portion of
 * applyPurchaseReceiptCosting, with the settlement rows sourced from this
 * document (the 0019/0090 generalisation of the settlement table).
 */
async function applyWarehouseReceiptCosting(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    documentId: string;
    inventoryEventId: string;
    lines: WarehouseDocumentLine[];
    createdBy: string | null;
  },
): Promise<void> {
  const method = await getCostingMethod(params.businessId, client);

  for (const line of [...params.lines].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    const quantity = line.quantity;
    const extendedCost = line.value;

    const { rows: inventoryRows } = await client.query<{ carrying_value_rial: string | null }>(
      "SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE",
      [line.inventoryItemId, params.locationId],
    );
    const item = inventoryRows[0];
    if (!item) throw new Error("item_not_found");

    const { rows: stockRows } = await client.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
      [line.inventoryItemId],
    );
    const priorPhysical = new Decimal(stockRows[0].quantity);

    const { rows: shortages } = await client.query<NegativeLayer>(
      `SELECT id, remaining_quantity::text, remaining_provisional_value_rial::text
         FROM inventory_negative_layers
        WHERE inventory_item_id=$1 AND remaining_quantity>0
        ORDER BY created_at,id
        FOR UPDATE`,
      [line.inventoryItemId],
    );

    let available = quantity;
    const portions: Array<{ key: string; quantity: QuantityText; layer: NegativeLayer | null }> = [];
    for (const layer of shortages) {
      if (new Decimal(available).eq(0)) break;
      if (layer.remaining_provisional_value_rial === null) {
        throw new Error(`inventory_exact_cutover_required: negative_layer:${layer.id}`);
      }
      const settled = minQuantity(available, quantityText(layer.remaining_quantity));
      portions.push({ key: `negative:${layer.id}`, quantity: settled, layer });
      available = subtractQuantity(available, settled);
    }
    if (new Decimal(available).gt(0)) {
      portions.push({ key: "positive", quantity: available, layer: null });
    }

    const allocations = allocateRialByWeight(
      extendedCost,
      portions.map((portion) => ({ key: portion.key, weight: portion.quantity })),
    );

    for (const portion of portions) {
      const actualValue = allocations.get(portion.key)!;
      if (portion.layer) {
        const remainingQuantity = quantityText(portion.layer.remaining_quantity);
        const remainingProvisional = rialText(portion.layer.remaining_provisional_value_rial!);
        const provisionalValue = proportionalDepletionValue(
          remainingQuantity,
          remainingProvisional,
          portion.quantity,
        );
        const nextQuantity = subtractQuantity(remainingQuantity, portion.quantity);
        const nextValue = (rialBigInt(remainingProvisional) - rialBigInt(provisionalValue)).toString();
        await client.query(
          `UPDATE inventory_negative_layers
              SET remaining_quantity=$2,
                  remaining_provisional_value_rial=$3,
                  settled_at=CASE WHEN $2::numeric=0 THEN now() ELSE NULL END
            WHERE id=$1`,
          [portion.layer.id, nextQuantity, nextValue],
        );
        const difference = rialBigInt(actualValue) - rialBigInt(provisionalValue);
        await client.query(
          `INSERT INTO inventory_negative_layer_settlements
             (inventory_event_id,warehouse_document_id,negative_layer_id,quantity,
              provisional_value_rial,actual_value_rial,difference_rial)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            params.inventoryEventId,
            params.documentId,
            portion.layer.id,
            portion.quantity,
            provisionalValue,
            actualValue,
            difference.toString(),
          ],
        );
      } else if (isLotBased(method)) {
        // A FIFO/LIFO lot may not hold quantity at zero value: the exact cost
        // basis (0015's `inventory_lot_exact_value_bounds`) requires
        // `(remaining_qty = 0) = (remaining_value_rial = 0)`, because stock
        // with no cost basis silently poisons every later consumption. A
        // zero-cost receipt line — or one whose qty × cost rounds below half a
        // Rial — used to reach the INSERT and abort the whole transaction with
        // a CHECK violation (a 500). Refuse it as the caller error it is, with
        // a code the form can explain.
        if (rialBigInt(actualValue) === 0n) {
          throw new Error("receipt_value_required");
        }
        await client.query(
          `INSERT INTO inventory_lots
             (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,inventory_event_id,
              original_quantity,original_value_rial,remaining_value_rial)
           VALUES($1,$2,$3,$4,'warehouse_receipt',$5,$6,$3,$7,$7)`,
          [
            params.locationId,
            line.inventoryItemId,
            portion.quantity,
            derivedUnitCost(actualValue, portion.quantity),
            params.documentId,
            params.inventoryEventId,
            actualValue,
          ],
        );
      } else {
        const existingValue = item.carrying_value_rial;
        if (existingValue === null && priorPhysical.gt(0)) {
          throw new Error(`inventory_exact_cutover_required: inventory_item:${line.inventoryItemId}`);
        }
        const newValue = BigInt(existingValue ?? "0") + rialBigInt(actualValue);
        const positiveQuantity = Decimal.max(priorPhysical, new Decimal("0")).plus(new Decimal(portion.quantity));
        const average = positiveQuantity.eq(0)
          ? "0"
          : new Decimal(newValue.toString()).div(positiveQuantity).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
        await client.query("UPDATE inventory_items SET carrying_value_rial=$2,avg_cost=$3 WHERE id=$1", [
          line.inventoryItemId,
          newValue.toString(),
          average,
        ]);
      }
    }

    await client.query(
      `INSERT INTO warehouse_document_lines
         (document_id, inventory_item_id, quantity, unit_cost, value_rial)
       VALUES($1,$2,$3,$4,$5)`,
      [params.documentId, line.inventoryItemId, line.quantity, line.unitCost, line.value],
    );

    await client.query(
      `INSERT INTO stock_movements
         (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
          source_type,source_id,created_by,inventory_event_id)
       VALUES($1,$2,'warehouse_in',$3,$4,$5,'warehouse_receipt',$6,$7,$8)`,
      [
        params.locationId,
        line.inventoryItemId,
        quantity,
        derivedUnitCost(extendedCost, quantity),
        extendedCost,
        params.documentId,
        params.createdBy,
        params.inventoryEventId,
      ],
    );
  }
}

async function upsertDocumentTotal(client: PoolClient, documentId: string, total: RialText): Promise<void> {
  await client.query("UPDATE warehouse_documents SET total_value_rial=$2 WHERE id=$1", [
    documentId,
    rialBigInt(total).toString(),
  ]);
}

async function documentTotalFromDb(client: PoolClient, documentId: string): Promise<RialText> {
  const { rows } = await client.query<{ total: string | null }>(
    "SELECT COALESCE(sum(value_rial),0)::text AS total FROM warehouse_document_lines WHERE document_id=$1",
    [documentId],
  );
  return rialText(rows[0]?.total ?? "0");
}
