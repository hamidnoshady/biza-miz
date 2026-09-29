import type { PoolClient } from "pg";
import { deductForOrder } from "./inventory-service";
import {
  MissingLedgerAccountError,
  postExactCogsEntry,
  postExactOrderPaymentEntry,
} from "./ledger-service";
import { getOnlinePlatformsConfig } from "./online-platforms-service";
import { commissionAmountFor } from "./online-platforms-calculation";
import { lockOpenOrder } from "./order-lock";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import { markScoringDirtyIn } from "./crm-scoring-freshness";
import { earnPoints } from "./loyalty-service";
import { releaseTableAfterOrderSettled } from "./table-session-service";
import { emitDomainEvent } from "./posting-engine";
import { enqueueHolooSaleForOrder } from "./integrations/holoo/outbox-producer";
import {
  platformCommissionBase,
  settlementDifference,
  tendersWithTip,
  type ResolvedTender,
} from "./payment-methods";

export const PAYMENT_METHODS = [
  "cash",
  "card",
  "card_to_card",
  "online",
  "credit",
  "snappfood",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface CompleteOrderPaymentInput {
  client: PoolClient;
  businessId: string;
  locationId: string;
  orderId: string;
  method: PaymentMethod;
  reference?: string | null;
  customerId?: string | null;
  tipAmount?: number;
  /** The branch's business date, supplied by the route that resolved the branch. */
  businessDate?: string;
  receivedBy: string | null;
  /** Caller-owned domain idempotency identity (for offline/server sync). */
  idempotencyKey?: string | null;
}

export interface CompleteOrderPaymentResult {
  amount: RialText;
  tipAmount: number;
  duplicate?: boolean;
  /** Set when settling this order freed its dine-in table. */
  releasedSessionId?: string | null;
}

/**
 * Completes one open order inside the caller's transaction. Keeping the
 * inventory event, payment row, order status, and two ledger entries together
 * is what makes a replayed offline payment safe to retry or roll back.
 *
 * Like the online checkout it also hands a dine-in table back to the floor
 * when this was the session's last active order — a sale that syncs up from a
 * till that was offline must leave the floor in the same state as one taken
 * online, or tables would silently stay occupied after every outage.
 */
export async function completeOrderPayment(
  input: CompleteOrderPaymentInput,
): Promise<CompleteOrderPaymentResult> {
  const {
    client,
    businessId,
    locationId,
    orderId,
    method,
    reference,
    customerId = null,
    tipAmount = 0,
    businessDate,
    receivedBy,
    idempotencyKey,
  } = input;
  const effectKey = `order-payment:${idempotencyKey || orderId}`;
  if (idempotencyKey) {
    const prior = await client.query<{ total: string; tip_amount: number }>(
      `SELECT o.total::text AS total, o.tip_amount
         FROM inventory_events ie
         JOIN orders o ON o.id=ie.source_id AND o.location_id=ie.location_id
        WHERE ie.business_id=$1 AND ie.location_id=$2 AND ie.idempotency_key=$3
          AND ie.source_type='order' AND ie.posting_status='posted'`,
      [businessId, locationId, effectKey],
    );
    if (prior.rows[0]) {
      return { amount: rialText(prior.rows[0].total), tipAmount: prior.rows[0].tip_amount, duplicate: true };
    }
  }
  const locked = await lockOpenOrder(client, locationId, orderId);
  if (!locked.ok) {
    throw Object.assign(new Error(locked.error), { code: locked.error, status: locked.status });
  }

  if (customerId) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM parties
        WHERE id = $1 AND business_id = $2 AND roles && ARRAY['customer']::text[]`,
      [customerId, businessId],
    );
    if (rowCount !== 1) {
      throw Object.assign(new Error("customer_not_found"), {
        code: "customer_not_found",
        status: 404,
      });
    }
    await client.query(`UPDATE orders SET customer_id = $1 WHERE id = $2`, [customerId, orderId]);
  }

  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id, location_id, event_type, source_type, source_id, created_by, idempotency_key, costing_version)
       VALUES ($1, $2, 'sale_consumption', 'order', $3, $4, $5, 2)
       RETURNING id`,
    [businessId, locationId, orderId, receivedBy, effectKey],
  );
  const inventoryEventId = eventRows[0].id;
  const amount = rialText(locked.order.total);

  if (rialBigInt(amount) > 0n) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [locationId, orderId, method, amount, reference?.trim() || null, receivedBy],
    );
  }

  const { rowCount: completed } = await client.query(
    `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now(), tip_amount = $3
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [orderId, receivedBy, tipAmount],
  );
  if (completed !== 1) {
    throw Object.assign(new Error("order_not_open"), { code: "order_not_open", status: 409 });
  }

  const { totalCost } = await deductForOrder(
    client,
    businessId,
    locationId,
    orderId,
    receivedBy,
    inventoryEventId,
  );

  let platformCommission = "0" as RialText;
  if (method === "snappfood") {
    const { snappfood } = await getOnlinePlatformsConfig(businessId);
    if (snappfood) {
      platformCommission = commissionAmountFor(amount, snappfood.commissionPercent);
    }
  }

  await postExactOrderPaymentEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: receivedBy,
    method,
    amount,
    tax: rialText(locked.order.tax),
    inventoryEventId,
    orderChannel: locked.order.type,
    tip: rialText(String(tipAmount)),
    platformCommission,
  });
  await postExactCogsEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: receivedBy,
    totalCost,
    inventoryEventId,
  });
  const loyaltyCustomerId = customerId || locked.order.customer_id;
  if (loyaltyCustomerId) {
    const { rowCount: isCustomer } = await client.query(
      `SELECT 1 FROM parties
        WHERE id = $1 AND business_id = $2 AND roles && ARRAY['customer']::text[]`,
      [loyaltyCustomerId, businessId],
    );
    if (isCustomer === 1) {
      await earnPoints(client, {
        businessId,
        customerId: loyaltyCustomerId,
        amountRial: amount,
        sourceType: "order",
        sourceId: orderId,
        earnedOn: businessDate,
        createdBy: receivedBy,
      });
    }
  }
  await client.query(`UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1`, [inventoryEventId]);

  // A completed sale changes what this business's RFM scores are derived from.
  // Marking it is one tiny upsert of one row — deliberately not a rescore:
  // RFM is a whole-population quintile calculation, and running it here would
  // put a full scan of every customer and every order on the path of taking
  // money. The background tick picks this up (crm-scoring-freshness.ts).
  await markScoringDirtyIn(client, businessId);
  await enqueueHolooSaleForOrder(client, businessId, orderId);

  const released = await releaseTableAfterOrderSettled(client, locationId, orderId, receivedBy);

  return { amount, tipAmount, duplicate: false, releasedSessionId: released?.sessionId ?? null };
}

export interface CompleteSplitOrderPaymentInput {
  client: PoolClient;
  businessId: string;
  locationId: string;
  orderId: string;
  tenders: ResolvedTender[];
  customerId: string | null;
  tipAmount: number;
  businessDate?: string;
  receivedBy: string | null;
  idempotencyKey: string;
  /**
   * When the bill was actually paid, and the journal date the paying side
   * posted it on (migration 0190). A replay that stamped its own `now()` put a
   * sale synced after midnight on the next day's reports and books — the same
   * rule the Holoo importer already follows: the row carries the instant the
   * sale happened.
   */
  settledAt?: string | null;
  entryDate?: string | null;
}

/** Exact split-tender settlement used by server-sync replay. */
export async function completeSplitOrderPayment(input: CompleteSplitOrderPaymentInput): Promise<CompleteOrderPaymentResult> {
  const { client, businessId, locationId, orderId, tenders, customerId, tipAmount, businessDate, receivedBy, idempotencyKey } = input;
  const settledAt = input.settledAt ?? null;
  const entryDate = input.entryDate ?? null;
  const effectKey = `order-payment:${idempotencyKey}`;
  const prior = await client.query<{ total: string; tip_amount: number }>(
    `SELECT o.total::text total,o.tip_amount FROM inventory_events ie JOIN orders o ON o.id=ie.source_id AND o.location_id=ie.location_id
      WHERE ie.business_id=$1 AND ie.location_id=$2 AND ie.idempotency_key=$3 AND ie.source_type='order' AND ie.posting_status='posted'`,
    [businessId, locationId, effectKey],
  );
  if (prior.rows[0]) return { amount: rialText(prior.rows[0].total), tipAmount: prior.rows[0].tip_amount, duplicate: true };
  const locked = await lockOpenOrder(client, locationId, orderId);
  if (!locked.ok) throw Object.assign(new Error(locked.error), { code: locked.error, status: locked.status });
  if (customerId) {
    const owned = await client.query(`SELECT 1 FROM parties WHERE id=$1 AND business_id=$2 AND roles && ARRAY['customer']::text[]`, [customerId, businessId]);
    if (owned.rowCount !== 1) throw Object.assign(new Error("customer_not_found"), { code: "customer_not_found", status: 404 });
    await client.query("UPDATE orders SET customer_id=$1 WHERE id=$2", [customerId, orderId]);
  }
  const amount = rialText(locked.order.total);
  const difference = settlementDifference(tenders, Number(rialBigInt(amount)));
  if ((difference.balanceDue > 0 || difference.customerCredit > 0 || tenders.some((t) => t.settlement === "credit")) && !customerId) {
    throw Object.assign(new Error("customer_required"), { code: "customer_required", status: 400 });
  }
  const methodIds = tenders.map((tender) => tender.methodId).filter((id): id is string => Boolean(id));
  const knownMethods = methodIds.length
    ? new Set((await client.query<{ id: string }>("SELECT id FROM payment_methods WHERE business_id=$1 AND id=ANY($2::uuid[])", [businessId, methodIds])).rows.map((row) => row.id))
    : new Set<string>();
  const event = await client.query<{ id: string }>(
    `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key,costing_version)
     VALUES($1,$2,'sale_consumption','order',$3,$4,$5,2) RETURNING id`,
    [businessId, locationId, orderId, receivedBy, effectKey],
  );
  const inventoryEventId = event.rows[0].id;
  for (const [index, tender] of tenders.entries()) {
    await client.query(
      `INSERT INTO payments(location_id,order_id,method,amount,reference,received_by,payment_method_id,settlement_seq,received_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz,now()))`,
      [locationId, orderId, tender.settlement, String(tender.amount), tender.reference, receivedBy, tender.methodId && knownMethods.has(tender.methodId) ? tender.methodId : null, index + 1, settledAt],
    );
  }
  if (difference.balanceDue > 0) {
    const credit = await client.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE business_id=$1 AND settlement='credit' AND is_active ORDER BY sort_order LIMIT 1", [businessId],
    );
    await client.query(
      `INSERT INTO payments(location_id,order_id,method,amount,reference,received_by,payment_method_id,settlement_seq,received_at)
       VALUES($1,$2,'credit',$3,NULL,$4,$5,$6,coalesce($7::timestamptz,now()))`,
      [locationId, orderId, String(difference.balanceDue), receivedBy, credit.rows[0]?.id ?? null, tenders.length + 1, settledAt],
    );
  }
  if (difference.customerCredit > 0 && customerId) {
    await emitDomainEvent(client, {
      businessId, locationId, eventType: "order.customer_credit_issued",
      payload: { customerId, amount: rialText(String(difference.customerCredit)), orderId },
      sourceType: "order", sourceId: orderId, createdBy: receivedBy,
    });
  }
  const completed = await client.query(
    "UPDATE orders SET status='completed',closed_by=$2,closed_at=coalesce($4::timestamptz,now()),tip_amount=$3 WHERE id=$1 AND status='open' RETURNING id",
    [orderId, receivedBy, tipAmount, settledAt],
  );
  if (completed.rowCount !== 1) throw Object.assign(new Error("order_not_open"), { code: "order_not_open", status: 409 });
  const { totalCost } = await deductForOrder(client, businessId, locationId, orderId, receivedBy, inventoryEventId);
  const platformAmount = rialText(String(platformCommissionBase(tenders)));
  let platformCommission = "0" as RialText;
  if (rialBigInt(platformAmount) > 0n) {
    const { snappfood } = await getOnlinePlatformsConfig(businessId);
    if (snappfood) platformCommission = commissionAmountFor(platformAmount, snappfood.commissionPercent);
  }
  await postExactOrderPaymentEntry(client, {
    businessId, locationId, orderId, createdBy: receivedBy,
    tenders: tendersWithTip(tenders, tipAmount).map((tender) => ({ settlement: tender.settlement, amount: rialText(String(tender.amount)) })),
    amount, tax: rialText(locked.order.tax), inventoryEventId, orderChannel: locked.order.type,
    tip: rialText(String(tipAmount)), platformCommission,
    balanceDue: rialText(String(difference.balanceDue)), customerCredit: rialText(String(difference.customerCredit)),
    entryDate,
  });
  await postExactCogsEntry(client, { businessId, locationId, orderId, createdBy: receivedBy, totalCost, inventoryEventId, entryDate });
  const loyaltyCustomerId = customerId || locked.order.customer_id;
  if (loyaltyCustomerId) {
    const owned = await client.query(`SELECT 1 FROM parties WHERE id=$1 AND business_id=$2 AND roles && ARRAY['customer']::text[]`, [loyaltyCustomerId, businessId]);
    if (owned.rowCount === 1) await earnPoints(client, { businessId, customerId: loyaltyCustomerId, amountRial: amount, sourceType: "order", sourceId: orderId, earnedOn: businessDate, createdBy: receivedBy });
  }
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
  await markScoringDirtyIn(client, businessId);
  await enqueueHolooSaleForOrder(client, businessId, orderId);
  const released = await releaseTableAfterOrderSettled(client, locationId, orderId, receivedBy);
  return { amount, tipAmount, duplicate: false, releasedSessionId: released?.sessionId ?? null };
}

export function paymentErrorDetails(error: unknown): { error: string; status: number } | null {
  if (error instanceof MissingLedgerAccountError) {
    return { error: "ledger_account_missing", status: 409 };
  }
  const code = (error as { code?: string; status?: number })?.code;
  const status = (error as { status?: number })?.status;
  return code && status ? { error: code, status } : null;
}
