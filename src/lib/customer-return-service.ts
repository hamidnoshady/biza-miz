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
import { getCostingMethod, getInventorySystem } from "./inventory-service";
import { unitCostFromValue } from "./inventory-reversal";
import { liveSaleInventoryEventId } from "./order-amendment-service";
import {
  postExactCustomerRefundEntry,
  postExactOperationalInventoryEntry,
  resolveOrderReturnAttribution,
} from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";

export type ReturnLine = NormalizedCustomerReturnLine;

interface CreateCustomerReturnParams {
  businessId: string;
  locationId: string;
  orderId: string;
  refundMethod: CustomerReturnRefundMethod;
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
    refund_amount_rial: string;
    reason: string;
  }>(
    `SELECT id, location_id, order_id, refund_method, refund_amount_rial::text, reason
       FROM customer_returns WHERE business_id=$1 AND idempotency_key=$2`,
    [params.businessId, params.idempotencyKey],
  );
  const existing = duplicate[0];
  if (!existing) return null;

  const matchesHeader =
    existing.location_id === params.locationId &&
    existing.order_id === params.orderId &&
    existing.refund_method === params.refundMethod &&
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
  return {
    id: existing.id,
    refundAmount: rialText(existing.refund_amount_rial),
    recoveredValue: rialText(recoveredRows[0]?.value ?? "0"),
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
    quantity: string;
  }>(
    `SELECT id, quantity::text FROM order_items
      WHERE order_id=$1 AND id=ANY($2::uuid[]) AND location_id=$3 AND status<>'voided'
      ORDER BY id FOR UPDATE`,
    [params.orderId, itemIds, params.locationId],
  );
  if (soldItems.length !== lines.length) throw new Error("order_item_not_found");

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
  const soldById = new Map(soldItems.map((item) => [item.id, item.quantity]));
  const returnedById = new Map(previouslyReturnedRows.map((row) => [row.order_item_id, row.quantity]));
  for (const line of lines) {
    const sold = soldById.get(line.orderItemId);
    if (sold === undefined) throw new Error("order_item_not_found");
    const returnedAfter = new Decimal(returnedById.get(line.orderItemId) ?? "0").plus(line.quantity);
    if (returnedAfter.gt(sold)) throw new Error("return_quantity_exceeds_sold");
  }

  params = { ...params, idempotencyKey, refundAmount, reason, lines };


  const { rows: headers } = await client.query<{ id: string }>(
    `INSERT INTO customer_returns
       (business_id,location_id,order_id,refund_method,refund_amount_rial,reason,created_by,idempotency_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [params.businessId, params.locationId, params.orderId, params.refundMethod, params.refundAmount,
      params.reason.trim(), params.createdBy, params.idempotencyKey],
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

  for (const line of lines) {
    const soldQuantity = soldById.get(line.orderItemId);
    if (soldQuantity === undefined) throw new Error("order_item_not_found");
    const { rows: returnLines } = await client.query<{ id: string }>(
      `INSERT INTO customer_return_lines(customer_return_id,order_item_id,quantity,disposition)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [returnId, line.orderItemId, line.quantity, line.disposition],
    );
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
  if (refund > 0n || recovered > 0n) {
    // Issue #868 — both legs of the return mirror the sale's own attribution:
    // the contra-revenue debit and the COGS reversal carry what the sale's
    // revenue and COGS legs carried, never a rule re-read today.
    returnAttribution = await resolveOrderReturnAttribution(client, {
      businessId: params.businessId, locationId: params.locationId, orderId: params.orderId,
    });
  }
  if (refund > 0n) {
    await client.query(
      "INSERT INTO payments(location_id,order_id,method,amount,reference,received_by) VALUES($1,$2,$3,-$4::bigint,$5,$6)",
      [params.locationId, params.orderId, params.refundMethod, refundAmount, `customer-return:${returnId}`, params.createdBy],
    );
    const tax = BigInt(orders[0].total) === 0n
      ? 0n
      : BigInt(roundRial(new Decimal(refundAmount).times(orders[0].tax).div(orders[0].total)));
    await postExactCustomerRefundEntry(client, {
      businessId: params.businessId, locationId: params.locationId, customerReturnId: returnId,
      createdBy: params.createdBy, inventoryEventId: events[0].id, paymentMethod: params.refundMethod,
      amount: refundAmount, tax: rialText(tax.toString()),
      orderId: params.orderId, dimensions: returnAttribution,
    });
  }
  if (recovered > 0n) {
    await postExactOperationalInventoryEntry(client, {
      businessId: params.businessId, locationId: params.locationId, sourceType: "customer_return",
      sourceId: returnId, postingKind: "cogs_reversal", memo: "Customer return inventory recovery",
      createdBy: params.createdBy, inventoryEventId: events[0].id,
      debitCode: WELL_KNOWN_CODES.inventory, creditCode: WELL_KNOWN_CODES.cogs,
      amount: rialText(recovered.toString()), dimensions: returnAttribution,
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
      recoveredValueRial: recovered.toString(),
      reason,
      actorRole: params.sync?.actorRole ?? null,
      lines,
    })],
  );
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.locationId,
    clientEventId: params.sync.clientEventId ?? idempotencyKey,
    eventType: "order.customer_return.created",
    payload: {
      orderId: params.orderId, refundMethod: params.refundMethod,
      refundAmount: refundAmount, reason, lines,
    },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });
  return { id: returnId, refundAmount, recoveredValue: rialText(recovered.toString()), duplicate: false };
}
