import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { broadcast } from "@/lib/realtime";
import { deductForOrder } from "@/lib/inventory-service";
import {
  MissingLedgerAccountError,
  postExactCogsEntry,
  postExactOrderPaymentEntry,
} from "@/lib/ledger-service";
import { getOnlinePlatformsConfig } from "@/lib/online-platforms-service";
import { commissionAmountFor } from "@/lib/online-platforms-calculation";
import { lockOpenOrder } from "@/lib/order-lock";
import { recordOrderState } from "@/lib/order-state-sync";
import { paymentFailureFor } from "@/lib/order-payment-errors";
import { rialBigInt, rialText, type RialText } from "@/lib/inventory-exact";
import {
  platformCommissionBase,
  settlementDifference,
  tendersWithTip,
  validateTenders,
  type ResolvedTender,
} from "@/lib/payment-methods";
import { listPaymentMethods } from "@/lib/payment-methods-service";
import { enqueueHolooSaleForOrder } from "@/lib/integrations/holoo/outbox-producer";
import { emitDomainEvent } from "@/lib/posting-engine";
import { earnPoints } from "@/lib/loyalty-service";
import { releaseTableAfterOrderSettled } from "@/lib/table-session-service";
import { appendSyncOutboxEvent } from "@/lib/sync-outbox";
import { markScoringDirtyIn } from "@/lib/crm-scoring-freshness";

interface PayTenderBody {
  /** `payment_methods.id` — the way the cashier tapped. */
  methodId?: string;
  /** The way's code (`cash`, `card`, …) — accepted so a caller that knows only the built-in names can still pay. */
  method?: string;
  amount?: number;
  reference?: string;
}

interface PayBody {
  /**
   * A bill split across payment ways (migration 0091): ۲۰۰٬۰۰۰ نقدی plus
   * ۳۰۰٬۰۰۰ کارت‌خوان. The slices add up to the order total; a separately
   * entered tip is added to the ledger tender later and is not duplicated in
   * the payment rows.
   *
   * With the manual «مبلغ دریافتی» flow the slices may also settle the bill
   * *with a difference*: less than the total leaves the remainder as customer
   * debt (a `credit` payments row plus an Accounts-Receivable debit), more
   * than the total leaves the excess as customer credit (the store-credit
   * liability plus an `order.customer_credit_issued` domain event). Either
   * difference requires `customerId` — a balance is a person's, never a
   * walk-in's.
   */
  payments?: PayTenderBody[];
  /** The single-way form, still sent by the amendment screen and by older clients. */
  method?: string;
  methodId?: string;
  reference?: string;
  customerId?: string;
  /** A tip collected alongside the bill (issue #160 §4), in whole Rial — added on top of the order total, never part of revenue. */
  tipAmount?: number;
}

/**
 * Checkout: records the payment and completes the order. This is the
 * "payment completion" trigger Phase 5's cash-drawer/receipt exit criteria
 * hook into — this is the only place an order reaches status 'completed'.
 * It is therefore also where a dine-in table is handed back to the floor:
 * settling the session's last active order frees its tables automatically
 * (releaseTableAfterOrderSettled), so there is no manual "close the table"
 * step and no second place that decides whether a table is occupied. Since migration
 * 0091 one order may be settled across several payment ways at once — ۲۰۰٬۰۰۰
 * نقدی plus ۳۰۰٬۰۰۰ کارت‌خوان is one checkout, one `payments` row per slice,
 * and one journal entry with a debit line per slice. What has not changed is
 * that a checkout settles the bill *in full*: the slices must add up to the
 * order total, while a separately entered tip is added to the ledger and
 * receipt, so there is still no partial payment and no balance left open.
 * Several parties on one table stay several orders, each settled here on its
 * own; the table is only released once the last of them is finalized.
 *
 * This is also the inventory deduction trigger (Phase 6): completing an
 * order is the one place order_items become immutable (they can only be
 * added/voided/requantified while status = 'open'), so it's the only
 * correct, exactly-once point to consume recipe ingredients. Payment
 * recording, order completion, and deduction all happen in one transaction.
 *
 * Same transaction also posts two Phase 7 journal entries: the payment
 * itself (Debit Cash/Bank-Clearing/Accounts-Receivable — or, for a SnapFood
 * order (issue #160 §4), Receivable-from-Online-Platforms net of SnapFood's
 * commission, with the commission itself debited to its own expense account
 * — for the bill *plus* any tip / Credit the order's channel-specific Sales
 * Revenue account, split by orders.type since Phase 22 Wave 4 — + Tax
 * Payable + Tips Payable if a tip was collected, issue #160 §4 — a
 * pass-through liability, never revenue) and the COGS entry from the
 * deduction's total cost (Debit COGS / Credit Inventory Asset).
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.paymentsTake);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const businessDay = await getBusinessDayStatus(location.id);

  let body: PayBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const customerId = body.customerId?.trim() || null;
  const tipAmount = body.tipAmount ?? 0;
  if (!Number.isSafeInteger(tipAmount) || tipAmount < 0) {
    return NextResponse.json({ error: "invalid_tip_amount" }, { status: 400 });
  }

  const rawTenders: PayTenderBody[] = body.payments?.length
    ? body.payments
    : [{ methodId: body.methodId, method: body.method, reference: body.reference }];
  if (!Array.isArray(rawTenders) || rawTenders.length === 0) {
    return NextResponse.json({ error: "no_payment" }, { status: 400 });
  }

  const available = await listPaymentMethods(session.businessId);
  const byId = new Map(available.map((paymentMethod) => [paymentMethod.id, paymentMethod]));
  const byCode = new Map(available.map((paymentMethod) => [paymentMethod.code, paymentMethod]));
  const resolvedWays = rawTenders.map((tender) =>
    tender.methodId ? byId.get(tender.methodId) : tender.method ? byCode.get(tender.method) : undefined,
  );
  if (resolvedWays.some((way) => !way)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }
  const ways = resolvedWays as NonNullable<(typeof resolvedWays)[number]>[];
  const missingReference = ways.findIndex(
    (way, index) => way.requiresReference && !rawTenders[index].reference?.trim(),
  );
  if (missingReference >= 0) {
    return NextResponse.json({ error: "payment_reference_required" }, { status: 400 });
  }
  if (ways.some((way) => way.settlement === "credit") && !customerId) {
    return NextResponse.json({ error: "customer_required" }, { status: 400 });
  }

  const client = await getPool().connect();
  let total = "0" as RialText;
  let paid: ResolvedTender[] = [];
  // The settle-with-difference balances (manual «مبلغ دریافتی»), surfaced in
  // the response so the receipt and the till can restate what became debt or
  // credit. Both zero for the ordinary, exact checkout.
  let balanceDue = 0;
  let customerCredit = 0;
  // Set when this checkout settled the last active order on a dine-in table,
  // so the floor plan can be told the table is back.
  let releasedSession: { sessionId: string } | null = null;
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, location.id, id);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: locked.error }, { status: locked.status });
    }
    const order = locked.order;
    // The exact bill being paid, queued for the paired peer before the payment
    // event and in the same transaction (order-state-sync.ts): even if every
    // earlier state was lost, the peer settles precisely these lines and totals.
    await recordOrderState(client, {
      locationId: location.id,
      orderId: id,
      actor: { userId: session.sub, role: session.role },
    });
    if (customerId) {
      const { rowCount: customerOwned } = await client.query(
        `SELECT 1 FROM parties
          WHERE id = $1 AND business_id = $2 AND roles && ARRAY['customer']::text[]`,
        [customerId, session.businessId],
      );
      if (customerOwned !== 1) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
      }
      await client.query(`UPDATE orders SET customer_id = $1 WHERE id = $2`, [customerId, id]);
    }
    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key,costing_version)
       VALUES($1,$2,'sale_consumption','order',$3,$4,'order-payment:' || $5,2)
       RETURNING id`,
      [session.businessId, location.id, id, session.sub, id],
    );
    const inventoryEventId = eventRows[0].id;
    total = rialText(order.total);
    const due = Number(rialBigInt(total));
    let tenders: ResolvedTender[] = [];
    if (due > 0) {
      const validated = validateTenders(
        ways.map((way, index) => ({
          methodId: way.id,
          settlement: way.settlement,
          amount: rawTenders[index].amount,
          reference: rawTenders[index].reference,
        })),
        // A difference is settled onto the customer's account, so the
        // customer requirement is enforced inside the same validation that
        // checks the amounts — never after the money has moved.
        { due, hasCustomer: Boolean(customerId), allowDifference: true },
      );
      if (!validated.ok) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      tenders = validated.value;
      const difference = settlementDifference(tenders, due);
      balanceDue = difference.balanceDue;
      customerCredit = difference.customerCredit;
    }
    paid = tenders;
    for (const [index, tender] of tenders.entries()) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, payment_method_id, settlement_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [location.id, id, tender.settlement, String(tender.amount), tender.reference, session.sub, tender.methodId, index + 1],
      );
    }
    // An underpayment's remainder is recorded like any نسیه slice: a credit
    // payments row, so the shift's per-method buckets and the AR subledger
    // read one consistent story. The business's own نسیه way is named when it
    // has one; the settlement class is what the ledger posts either way.
    if (balanceDue > 0) {
      const { rows: creditWay } = await client.query<{ id: string }>(
        `SELECT id FROM payment_methods
          WHERE business_id = $1 AND settlement = 'credit' AND is_active
          ORDER BY sort_order LIMIT 1`,
        [session.businessId],
      );
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, payment_method_id, settlement_seq)
         VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7)`,
        [location.id, id, String(balanceDue), null, session.sub, creditWay[0]?.id ?? null, tenders.length + 1],
      );
    }
    // An overpayment's excess is the customer's store credit: a real
    // liability, recorded as a domain event the balance is reconstructed
    // from (loyalty-service.ts's storeCreditBalance). No posting rule is
    // registered for this event type — the credit line already rides the
    // payment entry below, in the same transaction, so posting it twice is
    // structurally impossible.
    if (customerCredit > 0 && customerId) {
      await emitDomainEvent(client, {
        businessId: session.businessId,
        locationId: location.id,
        eventType: "order.customer_credit_issued",
        payload: {
          customerId,
          amount: rialText(String(customerCredit)),
          orderId: id,
        },
        sourceType: "order",
        sourceId: id,
        createdBy: session.sub,
      });
    }
    const { rowCount: completed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now(), tip_amount = $3
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [id, session.sub, tipAmount],
    );
    if (completed !== 1) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "order_not_open" }, { status: 409 });
    }
    const { totalCost } = await deductForOrder(client, session.businessId, location.id, id, session.sub, inventoryEventId);
    let platformCommission = "0" as RialText;
    // Commission applies to the food bill on the platform slice, not to a
    // tip. `tenders` contains the bill only; the tip is added separately
    // for the ledger and therefore never enters this base.
    const platformAmount = rialText(String(platformCommissionBase(tenders)));
    if (rialBigInt(platformAmount) > 0n) {
      const { snappfood } = await getOnlinePlatformsConfig(session.businessId);
      if (snappfood) {
        platformCommission = commissionAmountFor(platformAmount, snappfood.commissionPercent);
      }
    }
    await postExactOrderPaymentEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      tenders: tendersWithTip(tenders, tipAmount).map((tender) => ({
        settlement: tender.settlement,
        amount: rialText(String(tender.amount)),
      })),
      amount: total,
      tax: rialText(order.tax),
      inventoryEventId,
      orderChannel: order.type,
      tip: rialText(String(tipAmount)),
      platformCommission,
      balanceDue: rialText(String(balanceDue)),
      customerCredit: rialText(String(customerCredit)),
    });
    await postExactCogsEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      createdBy: session.sub,
      totalCost,
      inventoryEventId,
    });
    // Every sales model awards a known customer in the transaction that closes
    // the sale. F&B previously omitted this hook, so the same loyalty program
    // behaved differently at a café counter and a retail counter.
    const loyaltyCustomerId = customerId ?? order.customer_id;
    if (loyaltyCustomerId) {
      const { rowCount: isCustomer } = await client.query(
        `SELECT 1 FROM parties
          WHERE id = $1 AND business_id = $2 AND roles && ARRAY['customer']::text[]`,
        [loyaltyCustomerId, session.businessId],
      );
      if (isCustomer === 1) {
        await earnPoints(client, {
          businessId: session.businessId,
          customerId: loyaltyCustomerId,
          amountRial: total,
          sourceType: "order",
          sourceId: id,
          earnedOn: businessDay?.businessDate,
          createdBy: session.sub,
        });
      }
    }
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
    await enqueueHolooSaleForOrder(client, session.businessId, id);
    // Same transaction as the completion it reacts to: a settled bill and a
    // freed table commit together or not at all, so a rolled-back checkout can
    // never leave a table that looks empty but still owes money.
    releasedSession = await releaseTableAfterOrderSettled(client, location.id, id, session.sub);
    await markScoringDirtyIn(client, session.businessId);
    // The date the entries above were posted on (CURRENT_DATE in this same
    // transaction), so the peer posts its copy on the same day however late
    // it receives it — its own CURRENT_DATE, and its timezone, may differ.
    const { rows: postedOn } = await client.query<{ day: string }>("SELECT CURRENT_DATE::text AS day");
    await appendSyncOutboxEvent(client, {
      locationId: location.id,
      clientEventId: `order-payment:${id}`,
      eventType: "order.payment.completed",
      schemaVersion: 2,
      payload: {
        orderId: id,
        tenders: paid.map((tender) => ({
          methodId: tender.methodId,
          settlement: tender.settlement,
          amount: tender.amount,
          reference: tender.reference,
        })),
        customerId,
        tipAmount,
        businessDate: businessDay?.businessDate ?? null,
        entryDate: postedOn[0]?.day ?? null,
      },
      actorUserId: session.sub,
      actorRole: session.role,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const failure = paymentFailureFor(err);
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
    throw err;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });
  if (releasedSession) {
    // The floor plan, the waiter board and the POS table picker all listen for
    // this; without it a freed table keeps showing as occupied until someone
    // reloads, which is exactly the stale-occupancy problem being fixed.
    broadcast(location.id, { type: "table_session.updated", sessionId: releasedSession.sessionId });
  }
  return NextResponse.json({
    ok: true,
    tableReleased: Boolean(releasedSession),
    amount: total,
    method: paid[0]?.settlement ?? null,
    payments: paid.map((tender) => ({
      methodId: tender.methodId,
      method: tender.settlement,
      amount: tender.amount,
      reference: tender.reference,
    })),
    tipAmount,
    balanceDue,
    customerCredit,
  });
});
