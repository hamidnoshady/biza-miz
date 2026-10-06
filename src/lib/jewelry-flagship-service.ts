/**
 * Phase 27 Wave 9 — the jewelry flagship (DB-touching): gold buy-back,
 * gram-denominated layaway, the customer gold account (حساب طلایی), and
 * custom-order tickets.
 *
 * All four run in the caller's transaction and post through the
 * `jewelry.*` domain events registered in jewelry-flagship-posting-rules.ts.
 * Layaway is denominated in grams (the price is locked at open, the grams
 * never move); the gold account is a signed gram subledger whose balance is a
 * SUM, never a stored column.
 */
import { queryReportPage } from "./report-page-query";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { createItem, setWeightAttributes } from "./items-service";
import { query } from "./db";
import { roundRial, rialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { computeBuyBack, validateBuyBackInput } from "./gold-buyback";
import type { LayawayBook } from "./industry-reports";
import type { Purity } from "./gold";
// Side-effect import: registers the jewelry.* flagship posting rules.
import "./jewelry-flagship-posting-rules";

export class JewelryFlagshipError extends Error {}

// --------------------------------------------------------------- buy-back

export async function buyBackGold(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId?: string | null;
    purity: Purity;
    grossWeight: string;
    karsorPercent: number;
    buyPricePerGram: number;
    createdBy?: string | null;
  },
): Promise<{ itemId: string; netWeight: string; valueRial: number; entryId: string | null }> {
  const errors = validateBuyBackInput({
    grossWeight: input.grossWeight,
    karsorPercent: input.karsorPercent,
    buyPricePerGram: input.buyPricePerGram,
  });
  if (errors.length > 0) throw new JewelryFlagshipError(errors.join("؛ "));

  const { netWeight, valueRial } = computeBuyBack({
    grossWeight: input.grossWeight,
    karsorPercent: input.karsorPercent,
    buyPricePerGram: input.buyPricePerGram,
  });

  const item = await createItem({ locationId: input.locationId, name: "طلای خریداری‌شده (دست‌دوم/آبشده)", tracking: "weight" });
  // Cost basis = what the shop paid, per net gram, so a later COGS posting
  // recovers the exact buy value.
  await setWeightAttributes(item.id, {
    purity: input.purity,
    grossWeight: input.grossWeight,
    netWeight,
    unitCostPerGram: new Decimal(valueRial).div(netWeight).toDecimalPlaces(9).toFixed(),
  });

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "jewelry.gold_buy_back",
    payload: { itemId: item.id, customerId: input.customerId ?? null, netWeight, amount: rialText(String(valueRial)) },
    sourceType: "gold_buy_back",
    sourceId: item.id,
    createdBy: input.createdBy ?? null,
  });

  return { itemId: item.id, netWeight, valueRial, entryId };
}

// ---------------------------------------------------------------- layaway

export interface LayawayPlan {
  id: string;
  businessId: string;
  locationId: string;
  planNumber: number;
  customerId: string;
  itemId: string | null;
  grams: string;
  pricePerGram: number;
  totalValueRial: number;
  paidRial: number;
  status: "open" | "completed" | "cancelled";
  promisedDate: string | null;
  completedAt: string | null;
}

interface LayawayRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string;
  plan_number: string;
  customer_id: string;
  item_id: string | null;
  grams: string;
  price_per_gram: string;
  total_value_rial: string;
  paid_rial: string;
  status: "open" | "completed" | "cancelled";
  promised_date: string | null;
  completed_at: string | null;
}

function mapLayaway(row: LayawayRow): LayawayPlan {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    planNumber: Number(row.plan_number),
    customerId: row.customer_id,
    itemId: row.item_id,
    grams: row.grams,
    pricePerGram: Number(row.price_per_gram),
    totalValueRial: Number(row.total_value_rial),
    paidRial: Number(row.paid_rial),
    status: row.status,
    promisedDate: row.promised_date,
    completedAt: row.completed_at,
  };
}

export async function openLayaway(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    itemId?: string | null;
    grams: string;
    pricePerGram: number;
    depositRial: number;
    promisedDate?: string | null;
    createdBy?: string | null;
  },
): Promise<LayawayPlan> {
  const grams = new Decimal(input.grams);
  if (grams.lte(0)) throw new JewelryFlagshipError("وزن لیاوی باید بزرگ‌تر از صفر باشد.");
  if (!Number.isInteger(input.pricePerGram) || input.pricePerGram <= 0) {
    throw new JewelryFlagshipError("قیمت هر گرم باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  const total = Number(roundRial(grams.times(input.pricePerGram)));
  if (!Number.isInteger(input.depositRial) || input.depositRial < 0 || input.depositRial > total) {
    throw new JewelryFlagshipError("پیش‌پرداخت باید بین صفر و مبلغ کل باشد.");
  }

  const { rows: counter } = await client.query<{ next_number: string }>(
    `INSERT INTO layaway_plan_counters (location_id, next_number) VALUES ($1, 2)
     ON CONFLICT (location_id) DO UPDATE SET next_number = layaway_plan_counters.next_number + 1
     RETURNING next_number - 1 AS next_number`,
    [input.locationId],
  );
  const planNumber = Number(counter[0].next_number);

  const { rows } = await client.query<LayawayRow>(
    `INSERT INTO layaway_plans
       (business_id, location_id, plan_number, customer_id, item_id, grams, price_per_gram,
        total_value_rial, paid_rial, promised_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11) RETURNING *`,
    [
      input.businessId,
      input.locationId,
      planNumber,
      input.customerId,
      input.itemId ?? null,
      input.grams,
      input.pricePerGram,
      total,
      input.depositRial,
      input.promisedDate ?? null,
      input.createdBy ?? null,
    ],
  );
  const plan = mapLayaway(rows[0]);

  if (input.depositRial > 0) {
    const payment = await recordLayawayPayment(client, {
      businessId: input.businessId,
      planId: plan.id,
      amountRial: input.depositRial,
      createdBy: input.createdBy ?? null,
    });
    await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "jewelry.layaway_deposit",
      payload: { planId: plan.id, paymentId: payment.id, amount: rialText(String(input.depositRial)) },
      sourceType: "layaway_payment",
      sourceId: payment.id,
      createdBy: input.createdBy ?? null,
    });
  }
  return plan;
}

async function recordLayawayPayment(
  client: PoolClient,
  input: { businessId: string; planId: string; amountRial: number; createdBy?: string | null },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO layaway_payments (business_id, layaway_plan_id, amount_rial, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.businessId, input.planId, input.amountRial, input.createdBy ?? null],
  );
  return rows[0];
}

export async function payLayaway(
  client: PoolClient,
  input: { businessId: string; planId: string; amount: number; createdBy?: string | null },
): Promise<LayawayPlan> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new JewelryFlagshipError("مبلغ پرداخت باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  const { rows } = await client.query<LayawayRow>(
    `SELECT * FROM layaway_plans WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.planId, input.businessId],
  );
  const plan = rows[0];
  if (!plan) throw new JewelryFlagshipError("لیاوی یافت نشد.");
  if (plan.status !== "open") throw new JewelryFlagshipError("این لیاوی باز نیست.");
  if (Number(plan.paid_rial) + input.amount > Number(plan.total_value_rial)) {
    throw new JewelryFlagshipError("مبلغ پرداخت از ماندهٔ لیاوی بیشتر است.");
  }

  await client.query(`UPDATE layaway_plans SET paid_rial = paid_rial + $2 WHERE id = $1`, [input.planId, input.amount]);

  const payment = await recordLayawayPayment(client, {
    businessId: input.businessId,
    planId: input.planId,
    amountRial: input.amount,
    createdBy: input.createdBy ?? null,
  });
  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: plan.location_id,
    eventType: "jewelry.layaway_deposit",
    payload: { planId: input.planId, paymentId: payment.id, amount: rialText(String(input.amount)) },
    sourceType: "layaway_payment",
    sourceId: payment.id,
    createdBy: input.createdBy ?? null,
  });

  const { rows: updated } = await client.query<LayawayRow>(`SELECT * FROM layaway_plans WHERE id = $1`, [input.planId]);
  return mapLayaway(updated[0]);
}

export async function completeLayaway(
  client: PoolClient,
  input: { businessId: string; planId: string; createdBy?: string | null },
): Promise<LayawayPlan> {
  const { rows } = await client.query<LayawayRow>(
    `SELECT * FROM layaway_plans WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.planId, input.businessId],
  );
  const plan = rows[0];
  if (!plan) throw new JewelryFlagshipError("لیاوی یافت نشد.");
  if (plan.status !== "open") throw new JewelryFlagshipError("این لیاوی باز نیست.");
  if (Number(plan.paid_rial) < Number(plan.total_value_rial)) {
    throw new JewelryFlagshipError("لیاوی باید کامل پرداخت شده باشد تا تکمیل شود.");
  }

  await client.query(
    `UPDATE layaway_plans SET status = 'completed', completed_at = now() WHERE id = $1`,
    [input.planId],
  );

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: plan.location_id,
    eventType: "jewelry.layaway_completed",
    payload: { planId: input.planId, amount: rialText(plan.total_value_rial) },
    sourceType: "layaway_plan",
    sourceId: input.planId,
    createdBy: input.createdBy ?? null,
  });

  const { rows: updated } = await client.query<LayawayRow>(`SELECT * FROM layaway_plans WHERE id = $1`, [input.planId]);
  return mapLayaway(updated[0]);
}

/**
 * Phase 27 Wave 13 — the layaway book: every plan for a branch plus the
 * summary (open count, outstanding Rial, total grams) the jeweller reads off
 * at a glance. SQL aggregates follow the pure `layawayBook` contract
 * (industry-reports.ts); pagination never changes the book totals.
 */
async function readLayaways(businessId: string, locationId: string, page?: number) {
  const result = await queryReportPage<LayawayRow, LayawayBook>(
    `SELECT * FROM layaway_plans WHERE business_id = $1 AND location_id = $2`,
    [businessId, locationId],
    { page, orderBy: "plan_number, id", summary: `jsonb_build_object(
      'openCount', count(*) FILTER (WHERE status='open'),
      'completedCount', count(*) FILTER (WHERE status='completed'),
      'openValueRial', coalesce(sum(total_value_rial) FILTER (WHERE status='open'),0),
      'openPaidRial', coalesce(sum(paid_rial) FILTER (WHERE status='open'),0),
      'openOutstandingRial', coalesce(sum(total_value_rial-paid_rial) FILTER (WHERE status='open'),0),
      'totalGrams', coalesce(sum(grams),0)::text)` },
  );
  return { ...result, rows: result.rows.map(mapLayaway), summary: {
    ...result.summary, totalGrams: new Decimal(result.summary.totalGrams).toString(),
  } };
}
export async function listLayaways(businessId: string, locationId: string): Promise<{ rows: LayawayPlan[]; book: LayawayBook }> {
  const result = await readLayaways(businessId, locationId);
  return { rows: result.rows, book: result.summary };
}
export const listLayawaysPage = (businessId: string, locationId: string, page: number) => readLayaways(businessId, locationId, page);

// ------------------------------------------------------------ gold account

export interface GoldAccountMovement {
  id: string;
  businessId: string;
  customerId: string;
  grams: string;
  pricePerGram: number;
  valueRial: number;
  reason: string | null;
  createdAt: string;
}

interface MovementRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  customer_id: string;
  grams: string;
  price_per_gram: string;
  value_rial: string;
  reason: string | null;
  created_at: string;
}

export async function recordGoldAccountMovement(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    /** Signed grams: positive = customer gives gold, negative = withdrawal. */
    grams: string;
    pricePerGram: number;
    reason?: string | null;
    sourceType: string;
    sourceId?: string | null;
    createdBy?: string | null;
  },
): Promise<GoldAccountMovement> {
  const grams = new Decimal(input.grams);
  if (grams.eq(0)) throw new JewelryFlagshipError("وزن گردش نمی‌تواند صفر باشد.");
  if (!Number.isInteger(input.pricePerGram) || input.pricePerGram <= 0) {
    throw new JewelryFlagshipError("قیمت هر گرم باید یک عدد صحیح مثبت (ریال) باشد.");
  }

  if (grams.lt(0)) {
    const balance = await goldAccountBalance(input.businessId, input.customerId, client);
    if (balance.plus(grams).lt(0)) throw new JewelryFlagshipError("موجودی حساب طلایی کافی نیست.");
  }

  const valueRial = Number(roundRial(grams.abs().times(input.pricePerGram))) * (grams.gt(0) ? 1 : -1);

  const { rows } = await client.query<MovementRow>(
    `INSERT INTO gold_account_movements
       (business_id, customer_id, grams, price_per_gram, value_rial, reason, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      input.businessId,
      input.customerId,
      input.grams,
      input.pricePerGram,
      valueRial,
      input.reason?.trim() || null,
      input.sourceType,
      input.sourceId ?? null,
      input.createdBy ?? null,
    ],
  );

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "jewelry.gold_account_movement",
    payload: { movementId: rows[0].id, customerId: input.customerId, valueRial: String(valueRial) },
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    createdBy: input.createdBy ?? null,
  });

  return {
    id: rows[0].id,
    businessId: rows[0].business_id,
    customerId: rows[0].customer_id,
    grams: rows[0].grams,
    pricePerGram: Number(rows[0].price_per_gram),
    valueRial: Number(rows[0].value_rial),
    reason: rows[0].reason,
    createdAt: rows[0].created_at,
  };
}

export async function goldAccountBalance(
  businessId: string,
  customerId: string,
  client?: PoolClient,
): Promise<Decimal> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<{ balance: string | null }>(
    `SELECT COALESCE(SUM(grams), 0)::text AS balance
       FROM gold_account_movements
      WHERE business_id = $1 AND customer_id = $2`,
    [businessId, customerId],
  );
  return new Decimal(rows[0]?.balance ?? 0);
}

export async function goldAccountStatement(businessId: string, customerId: string): Promise<GoldAccountMovement[]> {
  const { rows } = await query<MovementRow>(
    `SELECT * FROM gold_account_movements
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY created_at, id`,
    [businessId, customerId],
  );
  return rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    customerId: r.customer_id,
    grams: r.grams,
    pricePerGram: Number(r.price_per_gram),
    valueRial: Number(r.value_rial),
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------- custom orders

export interface CustomOrderTicket {
  id: string;
  locationId: string;
  ticketNumber: number;
  customerId: string | null;
  itemDescription: string;
  grams: string;
  depositRial: number;
  laborCharge: number;
  status: string;
  promisedDate: string | null;
}

export async function createCustomOrder(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId?: string | null;
    itemDescription: string;
    grams: string;
    depositRial: number;
    laborCharge: number;
    promisedDate?: string | null;
    createdBy?: string | null;
  },
): Promise<CustomOrderTicket> {
  if (!input.itemDescription.trim()) throw new JewelryFlagshipError("شرح سفارش نمی‌تواند خالی باشد.");
  if (new Decimal(input.grams).lte(0)) throw new JewelryFlagshipError("وزن سفارش باید بزرگ‌تر از صفر باشد.");
  if (!Number.isInteger(input.depositRial) || input.depositRial < 0) {
    throw new JewelryFlagshipError("پیش‌پرداخت باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (!Number.isInteger(input.laborCharge) || input.laborCharge < 0) {
    throw new JewelryFlagshipError("اجرت ساخت باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }

  const { rows: counter } = await client.query<{ next_number: string }>(
    `INSERT INTO custom_order_counters (location_id, next_number) VALUES ($1, 2)
     ON CONFLICT (location_id) DO UPDATE SET next_number = custom_order_counters.next_number + 1
     RETURNING next_number - 1 AS next_number`,
    [input.locationId],
  );
  const ticketNumber = Number(counter[0].next_number);

  const { rows } = await client.query<{
    id: string;
    location_id: string;
    ticket_number: string;
    customer_id: string | null;
    item_description: string;
    grams: string;
    deposit_rial: string;
    labor_charge: string;
    status: string;
    promised_date: string | null;
  }>(
    `INSERT INTO custom_order_tickets
       (location_id, ticket_number, customer_id, item_description, grams, deposit_rial,
        labor_charge, promised_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9) RETURNING *`,
    [
      input.locationId,
      ticketNumber,
      input.customerId ?? null,
      input.itemDescription.trim(),
      input.grams,
      input.depositRial,
      input.laborCharge,
      input.promisedDate ?? null,
      input.createdBy ?? null,
    ],
  );

  const ticket: CustomOrderTicket = {
    id: rows[0].id,
    locationId: rows[0].location_id,
    ticketNumber: Number(rows[0].ticket_number),
    customerId: rows[0].customer_id,
    itemDescription: rows[0].item_description,
    grams: rows[0].grams,
    depositRial: Number(rows[0].deposit_rial),
    laborCharge: Number(rows[0].labor_charge),
    status: rows[0].status,
    promisedDate: rows[0].promised_date,
  };

  if (input.depositRial > 0) {
    await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "jewelry.custom_order_deposit",
      payload: { ticketId: ticket.id, amount: rialText(String(input.depositRial)) },
      sourceType: "custom_order_ticket",
      sourceId: ticket.id,
      createdBy: input.createdBy ?? null,
    });
  }
  return ticket;
}
