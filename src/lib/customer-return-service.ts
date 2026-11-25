import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import {
  boundedRialText,
  quantityText,
  rialText,
  roundRial,
  type RialText,
} from "./inventory-exact";
import {
  calculateRefundCapacity,
  isCustomerReturnRefundMethod,
  isUuid,
  normalizeCustomerReturnLines,
  sameNormalizedReturnLines,
  validateCustomerReturnReason,
  type CustomerReturnRefundMethod,
  type NormalizedCustomerReturnLine,
} from "./customer-return-domain";
import { isLotBased } from "./inventory-costing";
import { restoreFungibleStock } from "./item-stock-valuation";
import { getCostingMethod, getInventorySystem } from "./inventory-service";
import { unitCostFromValue } from "./inventory-reversal";
import { liveSaleInventoryEventId } from "./order-amendment-service";
import {
  postExactCustomerRefundEntry,
  postExactJournalEntry,
  postExactOperationalInventoryEntry,
  resolveOrderReturnAttribution,
} from "./ledger-service";
import { recomputeLastSoldAt } from "./retail-stock-service";
import { restoreOrderItemBatchStock } from "./retail-batch-inventory";
import { WELL_KNOWN_CODES } from "./coa-template";
import { systemJournalMemo } from "./journal-memo";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";
import {
  readOrderPaymentRouting, resolveExplicitOrderSource, type OrderPaymentSourceSnapshot,
} from "./order-payment-routing-service";
import { paymentSourceKindForSettlement } from "./order-payment-routing";

export type ReturnLine = NormalizedCustomerReturnLine;

interface CreateCustomerReturnParams {
  businessId: string;
  locationId: string;
  orderId: string;
  refundMethod: CustomerReturnRefundMethod;
  financialAccountId?: string | null;
  /** Only supplied by the versioned replay handler, after validating the envelope. */
  sourceSnapshot?: OrderPaymentSourceSnapshot;
  legacyReplay?: boolean;
  refundAmount: RialText;
  reason: string;
  idempotencyKey: string;
  /** null for system-driven returns (e.g. a WooCommerce webhook) with no local user. */
  createdBy: string | null;
  lines: ReturnLine[];
  sync?: { actorRole: Role; clientEventId?: string };
}

async function findDuplicateReturn(
  client: PoolClient,
  params: CreateCustomerReturnParams,
  lines: readonly ReturnLine[],
  refundAmount: RialText,
  reason: string,
): Promise<{ id: string; refundAmount: RialText; recoveredValue: RialText; duplicate: true } | null> {
  const { rows: duplicate } = await client.query<{
    id: string;
    location_id: string;
    order_id: string;
    refund_method: string;
    financial_account_id: string | null;
    refund_amount_rial: string;
    reason: string;
  }>(
    `SELECT id, location_id, order_id, refund_method, financial_account_id, refund_amount_rial::text, reason
       FROM customer_returns WHERE business_id=$1 AND idempotency_key=$2`,
    [params.businessId, params.idempotencyKey],
  );
  const existing = duplicate[0];
  if (!existing) return null;

  const matchesHeader =
    existing.location_id === params.locationId &&
    existing.order_id === params.orderId &&
    existing.refund_method === params.refundMethod &&
    existing.financial_account_id === (params.sourceSnapshot?.financialAccountId ?? params.financialAccountId ?? null) &&
    BigInt(existing.refund_amount_rial) === BigInt(refundAmount) &&
    existing.reason === reason;
  if (!matchesHeader) throw new Error("idempotency_key_conflict");

  const { rows: storedLines } = await client.query<{
    order_item_id: string;
    quantity: string;
    disposition: "restockable" | "discarded";
  }>(
    `SELECT order_item_id, quantity::text, disposition
       FROM customer_return_lines WHERE customer_return_id=$1 ORDER BY order_item_id`,
    [existing.id],
  );
  const normalizedStoredLines = normalizeCustomerReturnLines(storedLines.map((line) => ({
    orderItemId: line.order_item_id,
    quantity: line.quantity,
    disposition: line.disposition,
  })));
  if (!sameNormalizedReturnLines(lines, normalizedStoredLines)) {
    throw new Error("idempotency_key_conflict");
  }

  const { rows: recoveredRows } = await client.query<{ value: string }>(
    `SELECT COALESCE(sum(recovered_value_rial),0)::text AS value
       FROM customer_return_inventory_allocations a
       JOIN customer_return_lines l ON l.id=a.customer_return_line_id
      WHERE l.customer_return_id=$1`,
    [existing.id],
  );
  // Items-model returns recover value through a journal reversal rather than
  // warehouse allocations (their sales never had snapshots); report that so a
  // replay answers exactly what the first call did. The two are mutually
  // exclusive per return, so only fall back when no allocation exists.
  let recoveredValue = recoveredRows[0]?.value ?? "0";
  if (BigInt(recoveredValue) === 0n) {
    const { rows: reversalRows } = await client.query<{ value: string }>(
      `SELECT COALESCE(sum(jl.debit),0)::text AS value
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
        WHERE je.source_type='customer_return' AND je.source_id=$1 AND je.posting_kind='cogs_reversal'`,
      [existing.id],
    );
    recoveredValue = reversalRows[0]?.value ?? "0";
  }
  return {
    id: existing.id,
    refundAmount: rialText(existing.refund_amount_rial),
    recoveredValue: rialText(recoveredValue),
    duplicate: true,
  };
}

export async function createCustomerReturn(
  client: PoolClient,
  params: CreateCustomerReturnParams,
): Promise<{ id: string; refundAmount: RialText; recoveredValue: RialText; duplicate: boolean }> {
  if (!isUuid(params.businessId) || !isUuid(params.locationId) || !isUuid(params.orderId)) {
    throw new Error("invalid_order_id");
  }
  if (!isCustomerReturnRefundMethod(params.refundMethod)) {
    throw new Error("invalid_refund_method");
  }
  const reason = validateCustomerReturnReason(params.reason);
  const idempotencyKey = typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    throw new Error("invalid_idempotency_key");
  }
  const refundAmount = boundedRialText(params.refundAmount);
  const refund = BigInt(refundAmount);
  const lines = normalizeCustomerReturnLines(params.lines);
  const intent = { ...params, idempotencyKey };

  // Idempotency keys are business-scoped, not order-scoped. Serialize the
  // lookup/insert pair so two simultaneous replays cannot race the unique key
  // across different orders, then verify the replay is byte-for-byte the same
  // intent (header and normalized lines) before returning a duplicate.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`customer-return:${params.businessId}:${idempotencyKey}`],
  );
  const priorIntent = await findDuplicateReturn(client, intent, lines, refundAmount, reason);
  if (priorIntent) return priorIntent;

  const { rows: orders } = await client.query<{ tax: string; total: string }>(
    "SELECT tax::text,total::text FROM orders WHERE id=$1 AND location_id=$2 AND status='completed' FOR UPDATE",
    [params.orderId, params.locationId],
  );
  if (!orders[0]) throw new Error("completed_order_not_found");

  // Another same-key call may have been waiting for the same order lock when
  // the first lookup ran (the advisory lock already handles a same key, but
  // this second read also protects against legacy writers that do not take it).
  const duplicateAfterOrderLock = await findDuplicateReturn(client, intent, lines, refundAmount, reason);
  if (duplicateAfterOrderLock) return duplicateAfterOrderLock;

  const { rows: tenderRows } = await client.query<{
    previously_refunded: string;
    net_non_credit_tender: string;
  }>(
    `SELECT
       (SELECT COALESCE(sum(refund_amount_rial),0)::text
          FROM customer_returns WHERE business_id=$2 AND location_id=$3 AND order_id=$1) AS previously_refunded,
       (SELECT COALESCE(sum(p.amount) FILTER (
                  WHERE p.method <> 'credit' AND p.superseded_by_amendment_id IS NULL
                ),0)::text
          FROM payments p WHERE p.location_id=$3 AND p.order_id=$1) AS net_non_credit_tender`,
    [params.orderId, params.businessId, params.locationId],
  );
  const capacity = calculateRefundCapacity({
    orderTotalRial: orders[0].total,
    previouslyRefundedRial: tenderRows[0]?.previously_refunded ?? "0",
    netNonCreditTenderRial: tenderRows[0]?.net_non_credit_tender ?? "0",
  });
  if (refund > BigInt(capacity.remainingRefundRial)) {
    throw new Error("refund_exceeds_remaining_refundable_amount");
  }

  const itemIds = lines.map((line) => line.orderItemId);
  const { rows: soldItems } = await client.query<{
    id: string;
    item_id: string | null;
    quantity: string;
    retail_snapshot: Record<string, unknown> | null;
  }>(
    `SELECT id, item_id, quantity::text, retail_snapshot FROM order_items
      WHERE order_id=$1 AND id=ANY($2::uuid[]) AND location_id=$3 AND status<>'voided'
      ORDER BY id FOR UPDATE`,
    [params.orderId, itemIds, params.locationId],
  );
  if (soldItems.length !== lines.length) throw new Error("order_item_not_found");

  // Retail lines always store `1` in `order_items.quantity`; the real sold
  // quantity lives only in `retail_snapshot.quantity` (see the LineRow comment
  // in retail-invoice-void-service.ts). The cumulative cap below and the F&B
  // COGS basis therefore both read the *effective* quantity: the snapshot's
  // when the line carries one, the raw column otherwise — F&B/warehouse lines
  // store their true quantity raw, so their behaviour is unchanged.
  const effectiveSoldQuantity = (row: (typeof soldItems)[number]): string => {
    const snap = row.retail_snapshot as { quantity?: unknown } | null;
    const snapQuantity =
      snap && typeof snap.quantity === "string" && snap.quantity ? snap.quantity : null;
    return snapQuantity ?? row.quantity;
  };
  const soldById = new Map(soldItems.map((item) => [item.id, effectiveSoldQuantity(item)]));
  const soldRowById = new Map(soldItems.map((item) => [item.id, item]));

  const { rows: previouslyReturnedRows } = await client.query<{
    order_item_id: string;
    quantity: string;
  }>(
    `SELECT l.order_item_id, COALESCE(sum(l.quantity),0)::text AS quantity
       FROM customer_return_lines l
       JOIN customer_returns r ON r.id=l.customer_return_id
      WHERE r.business_id=$3 AND r.location_id=$4 AND r.order_id=$1
        AND l.order_item_id=ANY($2::uuid[])
      GROUP BY l.order_item_id`,
    [params.orderId, itemIds, params.businessId, params.locationId],
  );
  const returnedById = new Map(previouslyReturnedRows.map((row) => [row.order_item_id, row.quantity]));
  for (const line of lines) {
    const sold = soldById.get(line.orderItemId);
    if (sold === undefined) throw new Error("order_item_not_found");
    const returnedAfter = new Decimal(returnedById.get(line.orderItemId) ?? "0").plus(line.quantity);
    if (returnedAfter.gt(sold)) throw new Error("return_quantity_exceeds_sold");
  }

  params = { ...params, idempotencyKey, refundAmount, reason, lines };
  let source = params.sourceSnapshot;
  if (refund > 0n && !source && !params.legacyReplay && paymentSourceKindForSettlement(params.refundMethod)) {
    const mode = await readOrderPaymentRouting(client, params.businessId, params.locationId, true, Boolean(params.financialAccountId));
    if (params.financialAccountId) {
      if (mode === "peer_unsupported") throw new Error("payment_routing_peer_unsupported");
      source = await resolveExplicitOrderSource(client, params.businessId, params.locationId, params.refundMethod, params.financialAccountId);
    } else {
      const { rows: [payment] } = await client.query<{ routed: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM payments WHERE order_id = $1 AND location_id = $2 AND financial_account_id IS NOT NULL
        ) AS routed`,
        [params.orderId, params.locationId],
      );
      if (mode !== "disabled" || payment?.routed) throw new Error("refund_payment_source_required");
    }
  }
  if ((params.financialAccountId || source) && (refund <= 0n || !paymentSourceKindForSettlement(params.refundMethod))) {
    throw new Error("invalid_payment_source");
  }

  const { rows: headers } = await client.query<{ id: string }>(
    `INSERT INTO customer_returns
       (business_id,location_id,order_id,refund_method,refund_amount_rial,reason,created_by,idempotency_key,
        financial_account_id,financial_account_gl_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [params.businessId, params.locationId, params.orderId, params.refundMethod, params.refundAmount,
      params.reason.trim(), params.createdBy, params.idempotencyKey,
      source?.financialAccountId ?? null, source?.financialAccountGlId ?? null],
  );
  const returnId = headers[0].id;
  const { rows: events } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key)
     VALUES($1,$2,'customer_return','customer_return',$3,$4,2,$5) RETURNING id`,
    [params.businessId, params.locationId, returnId, params.createdBy, `customer-return:${params.idempotencyKey}`],
  );
  const method = await getCostingMethod(params.businessId, client);
  // سیستم ادواری: a sale consumed nothing, so a return restocks nothing —
  // the refund still posts below, and the returned goods simply show up in
  // the next period-end count.
  const periodic = (await getInventorySystem(params.businessId, client)) === "periodic";
  // The sale's COGS is read off the consumption event that currently stands for
  // this order — after a closed-order amendment that is the replayed
  // consumption, not the reversed original, and both wear `source_type='order'`.
  const saleEventId = periodic ? null : await liveSaleInventoryEventId(client, params.businessId, params.orderId);
  let recovered = 0n;
  // Items-model (retail) returns reverse the sale's own COGS entry
  // proportionally, mirroring the accounts it actually posted — never the
  // generic WELL_KNOWN_CODES constants, because a fashion tenant's COGS is
  // 5184 while an F&B tenant's is 5100. One account pair per return.
  const retailCogs = {
    amount: 0n,
    inventoryAccountId: null as string | null,
    cogsAccountId: null as string | null,
  };

  for (const line of lines) {
    const soldQuantity = soldById.get(line.orderItemId);
    if (soldQuantity === undefined) throw new Error("order_item_not_found");
    const soldRow = soldRowById.get(line.orderItemId);
    if (!soldRow) throw new Error("order_item_not_found");
    const { rows: returnLines } = await client.query<{ id: string }>(
      `INSERT INTO customer_return_lines(customer_return_id,order_item_id,quantity,disposition)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [returnId, line.orderItemId, line.quantity, line.disposition],
    );

    // ---- items-model (retail) line ----
    // Its sale relieved `item_stock` and posted revenue+COGS directly; it has
    // no `order_item_inventory_snapshots`, so the warehouse loop below never
    // applies. Mirror retail-invoice-void-service: restore the *real* sold
    // quantity (never `order_items.quantity`, which retail stores as 1), and
    // reverse the line's live COGS entry proportionally so stock and GL come
    // back together. A discarded (damaged/unsellable) return refunds without
    // restocking — the goods stay out of the shelf and out of the reversal.
    if (soldRow.retail_snapshot) {
      if (line.disposition === "restockable") {
        const snap = soldRow.retail_snapshot as {
          kind?: unknown;
          ledgerEntryIds?: unknown;
        };
        const kind = typeof snap.kind === "string" ? snap.kind : null;
        // gold/watch/vehicle have their own return flows (watch-return-service
        // etc.), service sells no catalogue row, and `legacy` rows predate the
        // snapshot contract — none of them restore stock here.
        if (kind === "accessory" || kind === "stocked" || kind === "cosmetic") {
          if (!soldRow.item_id) throw new Error("retail_item_missing");
          const { rows: batchAllocation } = await client.query(
            "SELECT 1 FROM order_item_batch_allocations WHERE order_item_id=$1 LIMIT 1",
            [line.orderItemId],
          );
          if (batchAllocation.length > 0) {
            // Batch-tracked cosmetics restore through the canonical engine so
            // the lots and the item_stock rollup stay in step (the void path
            // does the same); a plain quantity bump would orphan lot-less
            // stock that belongs to no lot.
            await restoreOrderItemBatchStock(client, {
              orderItemId: line.orderItemId,
              itemId: soldRow.item_id,
              locationId: params.locationId,
              quantity: line.quantity,
              disposition: "restockable",
              sourceType: "customer_return",
              sourceId: returnId,
            });
          }
          // A fungible line restores further down, once the exact COGS value
          // this return reverses is known (F1, GH #1567): quantity and value
          // must come back together, or the next movement reads a stale
          // carrying value.
          const fungibleRestore = batchAllocation.length === 0;
          let fungibleValue = 0n;
          const recomputed = await recomputeLastSoldAt(client, soldRow.item_id);
          await client.query(
            "UPDATE item_stock SET last_sold_at = $2::timestamptz WHERE item_id = $1",
            [soldRow.item_id, recomputed],
          );

          // Proportional COGS reversal: this line's live COGS entry prorated
          // by returned/sold quantity, mirrored to the very accounts the sale
          // used. Return-level idempotency already guards replays, and the
          // cumulative quantity cap keeps the prorated sum ≤ the original
          // entry (modulo rial rounding).
          const ledgerIds = Array.isArray(snap.ledgerEntryIds)
            ? snap.ledgerEntryIds.filter((value: unknown): value is string => typeof value === "string")
            : [];
          if (ledgerIds.length > 0) {
            const { rows: entryRows } = await client.query<{ id: string }>(
              `SELECT id FROM journal_entries
                WHERE id = ANY($1::uuid[]) AND business_id = $2
                  AND posting_kind ILIKE '%cogs%'
                  AND reversed_at IS NULL AND reverses_entry_id IS NULL`,
              [ledgerIds, params.businessId],
            );
            const cogsEntry = entryRows[0];
            if (cogsEntry) {
              const { rows: entryLines } = await client.query<{
                account_id: string;
                debit: string;
                credit: string;
              }>(
                `SELECT account_id, sum(debit)::text AS debit, sum(credit)::text AS credit
                   FROM journal_lines WHERE entry_id=$1 GROUP BY account_id`,
                [cogsEntry.id],
              );
              const debitLine = entryLines.find((l) => BigInt(l.debit) > 0n);
              const creditLine = entryLines.find((l) => BigInt(l.credit) > 0n);
              const portion = new Decimal(line.quantity).div(soldQuantity);
              const amount = BigInt(roundRial(new Decimal(debitLine?.debit ?? "0").times(portion)));
              if (amount > 0n && debitLine && creditLine) {
                if (retailCogs.cogsAccountId && retailCogs.cogsAccountId !== debitLine.account_id) {
                  // One return spans one order, whose lines all post the same
                  // trade accounts; a mixed pair would need a second entry
                  // under a distinct posting_kind. Refuse loudly instead of
                  // silently merging unrelated accounts.
                  throw new Error("mixed_cogs_accounts");
                }
                retailCogs.amount += amount;
                retailCogs.cogsAccountId = debitLine.account_id;
                retailCogs.inventoryAccountId = creditLine.account_id;
                fungibleValue = amount;
              }
            }
          }
          if (fungibleRestore) {
            // A legacy line with no live COGS entry to mirror comes back at
            // the current average (fallbackToAverage).
            await restoreFungibleStock(client, {
              itemId: soldRow.item_id,
              quantity: String(line.quantity),
              value: fungibleValue.toString(),
              fallbackToAverage: true,
            });
          }
        }
      }
      continue;
    }

    if (line.disposition === "discarded" || periodic) continue;

    const { rows: snapshots } = await client.query<{ inventory_item_id: string; required_quantity: string }>(
      "SELECT inventory_item_id,required_quantity::text FROM order_item_inventory_snapshots WHERE order_item_id=$1 ORDER BY inventory_item_id",
      [line.orderItemId],
    );
    for (const snapshot of snapshots) {
      const restoredQty = quantityText(new Decimal(snapshot.required_quantity).times(line.quantity).toFixed());
      const { rows: basisRows } = await client.query<{ sold_qty: string; sold_value: string; prior_qty: string; prior_value: string }>(
        `SELECT
          (SELECT sum(s.required_quantity*oi.quantity)::text
             FROM order_item_inventory_snapshots s JOIN order_items oi ON oi.id=s.order_item_id
            WHERE oi.order_id=$1 AND oi.status<>'voided' AND s.inventory_item_id=$2) sold_qty,
          (SELECT COALESCE(sum(sm.cost_value_rial),0)::text FROM stock_movements sm
            WHERE sm.source_type='order' AND sm.source_id=$1 AND sm.inventory_item_id=$2 AND sm.type='sale'
              AND ($4::uuid IS NULL OR sm.inventory_event_id=$4)) sold_value,
          COALESCE((SELECT sum(a.quantity)::text
             FROM customer_return_inventory_allocations a
             JOIN customer_return_lines rl ON rl.id=a.customer_return_line_id
             JOIN customer_returns r ON r.id=rl.customer_return_id
            WHERE r.order_id=$1 AND rl.order_item_id=$3 AND a.inventory_item_id=$2),'0') prior_qty,
          COALESCE((SELECT sum(a.recovered_value_rial)::text
             FROM customer_return_inventory_allocations a
             JOIN customer_return_lines rl ON rl.id=a.customer_return_line_id
             JOIN customer_returns r ON r.id=rl.customer_return_id
            WHERE r.order_id=$1 AND rl.order_item_id=$3 AND a.inventory_item_id=$2),'0') prior_value`,
        [params.orderId, snapshot.inventory_item_id, line.orderItemId, saleEventId],
      );
      const basis = basisRows[0];
      if (!basis.sold_qty) throw new Error("historical_cogs_unavailable");
      const lineSoldQty = new Decimal(snapshot.required_quantity).times(soldQuantity);
      const returnedAfter = new Decimal(basis.prior_qty).plus(restoredQty);
      const lineBasis = new Decimal(basis.sold_value).times(lineSoldQty).div(basis.sold_qty);
      const targetValue = returnedAfter.eq(lineSoldQty)
        ? roundRial(lineBasis)
        : roundRial(lineBasis.times(returnedAfter).div(lineSoldQty));
      const value = BigInt(targetValue) - BigInt(basis.prior_value);
      if (value < 0n) throw new Error("invalid_return_cost_basis");

      const { rows: movements } = await client.query<{ id: string }>(
        `INSERT INTO stock_movements
          (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
         VALUES($1,$2,'adjustment',$3,$4::numeric/$3::numeric,$4,'customer_return',$5,$6,$7) RETURNING id`,
        [params.locationId, snapshot.inventory_item_id, restoredQty, value.toString(), returnId, params.createdBy, events[0].id],
      );
      let lotId: string | null = null;
      if (isLotBased(method)) {
        const { rows: lots } = await client.query<{ id: string }>(
          `INSERT INTO inventory_lots
            (location_id,inventory_item_id,remaining_qty,unit_cost,remaining_value_rial,source_type,source_id,inventory_event_id,
             original_quantity,original_value_rial)
           VALUES($1,$2,$3,$4::numeric/$3::numeric,$4,'customer_return',$5,$6,$3,$4) RETURNING id`,
          [params.locationId, snapshot.inventory_item_id, restoredQty, value.toString(), returnId, events[0].id],
        );
        lotId = lots[0].id;
      } else {
        await client.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE", [snapshot.inventory_item_id]);
        const { rows: stockRows } = await client.query<{ quantity: string }>(
          "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
          [snapshot.inventory_item_id],
        );
        const physical = new Decimal(stockRows[0]?.quantity ?? "0");
        const positivePhysical = Decimal.max(physical, new Decimal("0"));
        const { rows: itemRows } = await client.query<{ carrying_value_rial: string | null }>(
          "SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1",
          [snapshot.inventory_item_id],
        );
        const nextValue = BigInt(itemRows[0]?.carrying_value_rial ?? "0") + value;
        const average = positivePhysical.lte(0)
          ? (new Decimal(restoredQty).gt(0) ? unitCostFromValue(value, new Decimal(restoredQty)) : "0")
          : new Decimal(nextValue.toString())
              .div(positivePhysical)
              .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
              .toFixed();
        const nextCarrying = positivePhysical.lte(0) ? "0" : nextValue.toString();
        await client.query(
          "UPDATE inventory_items SET carrying_value_rial=$2, avg_cost=$3 WHERE id=$1",
          [snapshot.inventory_item_id, nextCarrying, average],
        );
      }
      await client.query(
        `INSERT INTO customer_return_inventory_allocations
          (customer_return_line_id,inventory_item_id,quantity,recovered_value_rial,stock_movement_id,inventory_lot_id)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [returnLines[0].id, snapshot.inventory_item_id, restoredQty, value.toString(), movements[0].id, lotId],
      );
      recovered += value;
    }
  }

  // A zero-money exchange is a valid inventory return, but zero-value payment
  // and journal rows violate the ledger's debit/credit constraints. Persist the
  // return itself and only write monetary rows when there is an actual refund.
  let returnAttribution: Awaited<ReturnType<typeof resolveOrderReturnAttribution>> = null;
  if (refund > 0n || recovered > 0n || retailCogs.amount > 0n) {
    // Issue #868 — both legs of the return mirror the sale's own attribution:
    // the contra-revenue debit and the COGS reversal carry what the sale's
    // revenue and COGS legs carried, never a rule re-read today.
    returnAttribution = await resolveOrderReturnAttribution(client, {
      businessId: params.businessId, locationId: params.locationId, orderId: params.orderId,
    });
  }
  if (refund > 0n) {
    await client.query(
      `INSERT INTO payments(location_id,order_id,method,amount,reference,received_by,financial_account_id,financial_account_gl_id)
       VALUES($1,$2,$3,-$4::bigint,$5,$6,$7,$8)`,
      [params.locationId, params.orderId, params.refundMethod, refundAmount, `customer-return:${returnId}`, params.createdBy,
        source?.financialAccountId ?? null, source?.financialAccountGlId ?? null],
    );
    const tax = BigInt(orders[0].total) === 0n
      ? 0n
      : BigInt(roundRial(new Decimal(refundAmount).times(orders[0].tax).div(orders[0].total)));
    await postExactCustomerRefundEntry(client, {
      businessId: params.businessId, locationId: params.locationId, customerReturnId: returnId,
      createdBy: params.createdBy, inventoryEventId: events[0].id, paymentMethod: params.refundMethod,
      amount: refundAmount, tax: rialText(tax.toString()),
      orderId: params.orderId, dimensions: returnAttribution,
      ...source,
    });
  }
  if (recovered > 0n) {
    await postExactOperationalInventoryEntry(client, {
      businessId: params.businessId, locationId: params.locationId, sourceType: "customer_return",
      sourceId: returnId, postingKind: "cogs_reversal", memo: systemJournalMemo("customer_return_cogs_reversal"),
      createdBy: params.createdBy, inventoryEventId: events[0].id,
      debitCode: WELL_KNOWN_CODES.inventory, creditCode: WELL_KNOWN_CODES.cogs,
      amount: rialText(recovered.toString()), dimensions: returnAttribution,
    });
  }
  // The items-model counterpart of the block above: same posting_kind (one
  // order is either retail or warehouse/F&B shaped, so a single return can
  // never trigger both and collide on (source_type, source_id, posting_kind)),
  // but the accounts are the ones the sale itself posted — read back from its
  // entry — not the generic constants.
  if (retailCogs.amount > 0n && retailCogs.cogsAccountId && retailCogs.inventoryAccountId) {
    const retailReversal = rialText(retailCogs.amount.toString());
    const zero = "0" as RialText;
    await postExactJournalEntry(client, {
      businessId: params.businessId, locationId: params.locationId,
      memo: systemJournalMemo("customer_return_cogs_reversal"),
      sourceType: "customer_return", sourceId: returnId,
      postingKind: "cogs_reversal", inventoryEventId: events[0].id,
      createdBy: params.createdBy,
      lines: [
        { accountId: retailCogs.inventoryAccountId, debit: retailReversal, credit: zero, dimensions: returnAttribution },
        { accountId: retailCogs.cogsAccountId, debit: zero, credit: retailReversal, dimensions: returnAttribution },
      ],
    });
  }
  await client.query("UPDATE customer_returns SET inventory_event_id=$2 WHERE id=$1", [returnId, events[0].id]);
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [events[0].id]);
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'order.customer_return.created', 'customer_return', $4, $5::jsonb)`,
    [params.businessId, params.locationId, params.createdBy, returnId, JSON.stringify({
      orderId: params.orderId,
      refundMethod: params.refundMethod,
      refundAmountRial: refundAmount,
      recoveredValueRial: (recovered + retailCogs.amount).toString(),
      reason,
      actorRole: params.sync?.actorRole ?? null,
      lines,
    })],
  );
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? idempotencyKey,
    eventType: "order.customer_return.created",
    schemaVersion: source ? 2 : 1,
    payload: {
      orderId: params.orderId, refundMethod: params.refundMethod,
      refundAmount: refundAmount, reason, lines,
      ...source,
    },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });
  return { id: returnId, refundAmount, recoveredValue: rialText((recovered + retailCogs.amount).toString()), duplicate: false };
}
