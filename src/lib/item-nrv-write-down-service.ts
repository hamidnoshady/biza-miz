/**
 * GH #1567 F3 — net-realisable-value write-downs for the items model (every
 * retail-catalogue trade: fashion, accessories, cosmetics, wholesale,
 * haberdashery, tools, automotive parts, …).
 *
 * A markdown is a price decision; it never touches inventory value. Value is
 * written down only when NRV per unit falls below the carrying value per unit:
 *
 *   preview  — carrying value (the F1 exact value), NRV, the write-down and a
 *              fingerprint of that state. Read-only.
 *   create   — the reviewed write-down: inventory.adjust + ledger.approve (at
 *              the route), a reason, the reviewed fingerprint and an
 *              idempotency key. Lowers `total_value_rial` and the moving
 *              average (quantity unchanged) and posts Dr 5170 / Cr inventory.
 *              Later sales relieve the lowered value through F1, so the loss
 *              is expensed once — never again as COGS.
 *   reverse  — IAS 2 reversal when NRV recovers: at most the write-down still
 *              attributable to units on hand (amount × min(1, on-hand ÷
 *              written-down quantity)), and only up to the revised NRV, so the
 *              carrying value never rises above cost or above NRV.
 *
 * Serial, weight and batch-tracked stock is refused (`tracking_unsupported`):
 * its value lives per unit or per lot. A row whose stored value drifted from
 * its average (pre-F1 legacy) is refused (`valuation_drift`) until the F1
 * reconciliation clears it, so a write-down is never computed on a stale value.
 */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { roundRial, type RialText } from "./inventory-exact";
import { carryingDrift, type FungibleStockState } from "./item-stock-valuation";
import { accountIdsByCode, postExactJournalEntry } from "./ledger-service";
import { inventoryCodeForBusiness } from "./retail-stock-posting-rules";
import { isUuid } from "./uuid";

export class ItemWriteDownError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

export interface ItemWriteDownPreview {
  itemId: string;
  quantity: string;
  carryingValue: string;
  carryingUnitValue: string;
  nrvUnitValue: string;
  nrvValue: string;
  writeDownAmount: string;
  inventoryAccountCode: string;
  expenseAccountCode: string;
  fingerprint: string;
}

interface ItemRow {
  location_id: string;
  tracking: string;
  kind: string;
  quantity: string | null;
  unit_cost: string | null;
  total_value_rial: string | null;
}

function parseRial(raw: unknown, code: string): string {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,15}$/.test(text)) throw new ItemWriteDownError(code);
  return BigInt(text).toString();
}

function fingerprintOf(parts: { itemId: string; quantity: string; carrying: string; nrvUnit: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.itemId, new Decimal(parts.quantity).toFixed(), parts.carrying, parts.nrvUnit]))
    .digest("hex");
}

async function loadItem(client: PoolClient, businessId: string, locationId: string, itemId: string, lock: boolean): Promise<ItemRow> {
  if (!isUuid(itemId)) throw new ItemWriteDownError("item_not_found", 404);
  if (lock) await client.query(`SELECT 1 FROM item_stock WHERE item_id = $1 FOR UPDATE`, [itemId]);
  const { rows } = await client.query<ItemRow>(
    `SELECT i.location_id::text, i.tracking, i.kind, s.quantity::text, s.unit_cost::text, s.total_value_rial::text
       FROM items i JOIN locations l ON l.id = i.location_id
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = $1 AND l.business_id = $2`,
    [itemId, businessId],
  );
  const row = rows[0];
  if (!row || row.location_id !== locationId) throw new ItemWriteDownError("item_not_found", 404);
  if (row.kind === "variant_parent") throw new ItemWriteDownError("not_sellable");
  if (row.tracking !== "none") throw new ItemWriteDownError("tracking_unsupported");
  return row;
}

function computePreview(itemId: string, row: ItemRow, nrvUnit: string, inventoryAccountCode: string): ItemWriteDownPreview {
  const quantity = new Decimal(row.quantity ?? "0");
  if (quantity.lte(0)) throw new ItemWriteDownError("no_stock");
  const state: FungibleStockState = { quantity: row.quantity ?? "0", unitCost: row.unit_cost, totalValue: row.total_value_rial };
  if (row.total_value_rial == null || row.unit_cost == null) throw new ItemWriteDownError("no_cost_basis");
  if (carryingDrift(state) !== 0n) throw new ItemWriteDownError("valuation_drift", 409);
  const carrying = BigInt(row.total_value_rial);
  if (carrying <= 0n) throw new ItemWriteDownError("no_cost_basis");
  const nrvValue = BigInt(roundRial(quantity.times(nrvUnit)));
  const amount = carrying - nrvValue;
  if (amount <= 0n) {
    throw new ItemWriteDownError("nrv_not_below_cost", 409, { carryingValue: carrying.toString(), nrvValue: nrvValue.toString() });
  }
  return {
    itemId,
    quantity: quantity.toFixed(),
    carryingValue: carrying.toString(),
    carryingUnitValue: roundRial(new Decimal(carrying.toString()).div(quantity)),
    nrvUnitValue: nrvUnit,
    nrvValue: nrvValue.toString(),
    writeDownAmount: amount.toString(),
    inventoryAccountCode,
    expenseAccountCode: WELL_KNOWN_CODES.inventoryWriteDownExpense,
    fingerprint: fingerprintOf({ itemId, quantity: quantity.toFixed(), carrying: carrying.toString(), nrvUnit }),
  };
}

/** Read-only: what writing this SKU down to `nrvUnitValue` per unit would post. */
export async function previewItemWriteDown(
  client: PoolClient,
  input: { businessId: string; locationId: string; itemId: string; nrvUnitValue: string | number },
): Promise<ItemWriteDownPreview> {
  const nrvUnit = parseRial(input.nrvUnitValue, "invalid_nrv");
  const row = await loadItem(client, input.businessId, input.locationId, input.itemId, false);
  return computePreview(input.itemId, row, nrvUnit, await inventoryCodeForBusiness(client, input.businessId));
}

export interface ItemWriteDownResult {
  id: string;
  amount: string;
  journalEntryId: string | null;
  quantity: string;
  carryingAfter: string;
  duplicate: boolean;
}

/** The reviewed write-down. The caller owns the transaction and the tenant scope. */
export async function createItemWriteDown(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    itemId: string;
    nrvUnitValue: string | number;
    reason: string;
    idempotencyKey: string;
    reviewedFingerprint: string;
    createdBy: string;
  },
): Promise<ItemWriteDownResult> {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) throw new ItemWriteDownError("reason_required");
  const key = String(input.idempotencyKey ?? "").trim();
  if (key.length < 8 || key.length > 200) throw new ItemWriteDownError("idempotency_key_required");
  if (!/^[0-9a-f]{64}$/.test(input.reviewedFingerprint ?? "")) throw new ItemWriteDownError("fingerprint_required");
  const nrvUnit = parseRial(input.nrvUnitValue, "invalid_nrv");

  // Serialise retries of the same key before anything else.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`item_write_down:${input.businessId}:${key}`]);
  const existing = await client.query<{ id: string; item_id: string; nrv_unit_rial: string; fingerprint: string; amount_rial: string; journal_entry_id: string | null; quantity: string; carrying_before_rial: string }>(
    `SELECT id::text, item_id::text, nrv_unit_rial::text, fingerprint, amount_rial::text, journal_entry_id::text, quantity::text, carrying_before_rial::text
       FROM item_nrv_write_downs WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, key],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.item_id !== input.itemId || row.nrv_unit_rial !== nrvUnit || row.fingerprint !== input.reviewedFingerprint) {
      throw new ItemWriteDownError("idempotency_conflict", 409);
    }
    return {
      id: row.id,
      amount: row.amount_rial,
      journalEntryId: row.journal_entry_id,
      quantity: new Decimal(row.quantity).toFixed(),
      carryingAfter: (BigInt(row.carrying_before_rial) - BigInt(row.amount_rial)).toString(),
      duplicate: true,
    };
  }

  const row = await loadItem(client, input.businessId, input.locationId, input.itemId, true);
  const preview = computePreview(input.itemId, row, nrvUnit, await inventoryCodeForBusiness(client, input.businessId));
  if (preview.fingerprint !== input.reviewedFingerprint) {
    throw new ItemWriteDownError("review_stale", 409, { fingerprint: preview.fingerprint });
  }

  const quantity = new Decimal(preview.quantity);
  const nextUnitCost = roundRial(new Decimal(preview.nrvValue).div(quantity));
  await client.query(
    `UPDATE item_stock SET total_value_rial = $2, unit_cost = $3, updated_at = now() WHERE item_id = $1`,
    [input.itemId, preview.nrvValue, nextUnitCost],
  );

  const accounts = await accountIdsByCode(client, input.businessId, [preview.expenseAccountCode, preview.inventoryAccountCode]);
  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO item_nrv_write_downs
       (business_id, location_id, item_id, reason, idempotency_key, fingerprint, quantity,
        carrying_before_rial, nrv_unit_rial, amount_rial, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id::text`,
    [input.businessId, input.locationId, input.itemId, reason, key, preview.fingerprint, preview.quantity,
      preview.carryingValue, nrvUnit, preview.writeDownAmount, input.createdBy],
  );
  const id = inserted[0].id;
  const journalEntryId = await postExactJournalEntry(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    memo: "کاهش ارزش موجودی به خالص ارزش فروش",
    sourceType: "item_nrv_write_down",
    sourceId: id,
    createdBy: input.createdBy,
    postingKind: "item_nrv_write_down",
    idempotencyKey: `item_nrv_write_down:${id}`,
    lines: [
      { accountId: accounts.get(preview.expenseAccountCode)!, debit: preview.writeDownAmount as RialText, credit: "0" as RialText },
      { accountId: accounts.get(preview.inventoryAccountCode)!, debit: "0" as RialText, credit: preview.writeDownAmount as RialText },
    ],
  });
  await client.query(`UPDATE item_nrv_write_downs SET journal_entry_id = $2 WHERE id = $1`, [id, journalEntryId]);

  return {
    id,
    amount: preview.writeDownAmount,
    journalEntryId,
    quantity: preview.quantity,
    carryingAfter: preview.nrvValue,
    duplicate: false,
  };
}

export interface ItemWriteDownReversal {
  id: string;
  reversedAmount: string;
  journalEntryId: string | null;
  carryingAfter: string;
}

/**
 * Reverse (part of) a write-down after NRV recovered. The restorable amount is
 * the write-down still attributable to units on hand, further limited so the
 * carrying value does not exceed the revised NRV. One reversal per write-down.
 */
export async function reverseItemWriteDown(
  client: PoolClient,
  input: {
    businessId: string;
    writeDownId: string;
    revisedNrvUnitValue: string | number;
    reason: string;
    reversedBy: string;
  },
): Promise<ItemWriteDownReversal> {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) throw new ItemWriteDownError("reason_required");
  const revisedNrv = parseRial(input.revisedNrvUnitValue, "invalid_nrv");
  if (!isUuid(input.writeDownId)) throw new ItemWriteDownError("write_down_not_found", 404);
  const { rows } = await client.query<{
    id: string; location_id: string; item_id: string; quantity: string; amount_rial: string; reversed_at: string | null;
  }>(
    `SELECT id::text, location_id::text, item_id::text, quantity::text, amount_rial::text, reversed_at::text
       FROM item_nrv_write_downs WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.writeDownId, input.businessId],
  );
  const writeDown = rows[0];
  if (!writeDown) throw new ItemWriteDownError("write_down_not_found", 404);
  if (writeDown.reversed_at) throw new ItemWriteDownError("already_reversed", 409);

  const item = await loadItem(client, input.businessId, writeDown.location_id, writeDown.item_id, true);
  const onHand = new Decimal(item.quantity ?? "0");
  if (onHand.lte(0)) throw new ItemWriteDownError("nothing_to_reverse", 409);
  const carrying = BigInt(item.total_value_rial ?? "0");
  const share = Decimal.min(1, onHand.div(writeDown.quantity));
  const attributable = BigInt(new Decimal(writeDown.amount_rial).times(share).floor().toFixed(0));
  const headroom = BigInt(roundRial(onHand.times(revisedNrv))) - carrying;
  const amount = attributable < headroom ? attributable : headroom;
  if (amount <= 0n) throw new ItemWriteDownError("nothing_to_reverse", 409, { attributable: attributable.toString(), headroom: headroom.toString() });

  const nextTotal = carrying + amount;
  await client.query(
    `UPDATE item_stock SET total_value_rial = $2, unit_cost = $3, updated_at = now() WHERE item_id = $1`,
    [writeDown.item_id, nextTotal.toString(), roundRial(new Decimal(nextTotal.toString()).div(onHand))],
  );
  const inventoryCode = await inventoryCodeForBusiness(client, input.businessId);
  const expenseCode = WELL_KNOWN_CODES.inventoryWriteDownExpense;
  const accounts = await accountIdsByCode(client, input.businessId, [expenseCode, inventoryCode]);
  const journalEntryId = await postExactJournalEntry(client, {
    businessId: input.businessId,
    locationId: writeDown.location_id,
    memo: "برگشت کاهش ارزش موجودی (بهبود خالص ارزش فروش)",
    sourceType: "item_nrv_write_down_reversal",
    sourceId: writeDown.id,
    createdBy: input.reversedBy,
    postingKind: "item_nrv_write_down",
    idempotencyKey: `item_nrv_write_down_reversal:${writeDown.id}`,
    lines: [
      { accountId: accounts.get(inventoryCode)!, debit: amount.toString() as RialText, credit: "0" as RialText },
      { accountId: accounts.get(expenseCode)!, debit: "0" as RialText, credit: amount.toString() as RialText },
    ],
  });
  await client.query(
    `UPDATE item_nrv_write_downs
        SET reversed_amount_rial = $2, reversal_nrv_unit_rial = $3, reversal_reason = $4,
            reversal_entry_id = $5, reversed_by = $6, reversed_at = now()
      WHERE id = $1`,
    [writeDown.id, amount.toString(), revisedNrv, reason, journalEntryId, input.reversedBy],
  );
  return { id: writeDown.id, reversedAmount: amount.toString(), journalEntryId, carryingAfter: nextTotal.toString() };
}

export async function listItemWriteDowns(
  client: PoolClient,
  input: { businessId: string; locationId: string; itemId?: string | null },
) {
  const { rows } = await client.query(
    `SELECT w.id::text, w.item_id::text, i.name AS item_name, w.reason, w.quantity::text, w.carrying_before_rial::text,
            w.nrv_unit_rial::text, w.amount_rial::text, w.created_at::text, w.reversed_amount_rial::text, w.reversed_at::text
       FROM item_nrv_write_downs w JOIN items i ON i.id = w.item_id
      WHERE w.business_id = $1 AND w.location_id = $2 AND ($3::uuid IS NULL OR w.item_id = $3::uuid)
      ORDER BY w.created_at DESC LIMIT 200`,
    [input.businessId, input.locationId, input.itemId ?? null],
  );
  return rows;
}
