/**
 * Loyalty points, store credit and the repeat-purchase list (DB-touching).
 *
 * Points are an append-only, signed ledger. A point lot can expire, so a
 * redemption is recorded against the expiry bucket it consumed; that keeps a
 * lapsed lot and the debit that consumed it out of today's balance together.
 * Store credit is a liability reconstructed from domain events, never a
 * mutable balance column.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { predictNextPurchase } from "./repurchase";
import { loyaltyRedemptionSummary } from "./industry-reports";
import { isValidIsoDate } from "./jalali";
import type { SettlementMethod } from "./ledger";
// Side-effect import: registers the store-credit posting rules.
import "./loyalty-posting-rules";

export interface LoyaltyProgram {
  id: string;
  businessId: string;
  name: string;
  earnPointsPer100000: number;
  pointValueRial: number;
  pointsExpiryDays: number | null;
  isActive: boolean;
  isDefault: boolean;
}

export interface LoyaltyProgramInput {
  name: string;
  earnPointsPer100000?: number;
  pointValueRial?: number;
  pointsExpiryDays?: number | null;
  isActive?: boolean;
  isDefault?: boolean;
}

interface ProgramRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  earn_points_per_100000: number;
  point_value_rial: number;
  points_expiry_days: number | null;
  is_active: boolean;
  is_default: boolean;
}

function mapProgram(row: ProgramRow): LoyaltyProgram {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    earnPointsPer100000: Number(row.earn_points_per_100000),
    pointValueRial: Number(row.point_value_rial),
    pointsExpiryDays: row.points_expiry_days === null ? null : Number(row.points_expiry_days),
    isActive: row.is_active,
    isDefault: row.is_default,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Calendar arithmetic over a date-only string; no machine-local timezone leaks in. */
function addDaysIso(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function optionalIsoDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isValidIsoDate(value)) throw new Error(`${field} معتبر نیست.`);
  return value;
}

function positiveSafeInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(message);
}

function nonNegativeSafeInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(message);
}

function optionalBoolean(value: unknown, message: string): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new Error(message);
}

function normalizedReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== "string") throw new Error("دلیل اعتبار باید متن باشد.");
  const value = reason.trim();
  if (value.length > 500) throw new Error("دلیل اعتبار نباید بیش از ۵۰۰ نویسه باشد.");
  return value || null;
}

export async function listPrograms(businessId: string): Promise<LoyaltyProgram[]> {
  const { rows } = await query<ProgramRow>(
    `SELECT * FROM loyalty_programs WHERE business_id = $1 ORDER BY is_default DESC, is_active DESC, name`,
    [businessId],
  );
  return rows.map(mapProgram);
}

/** The one active program currently used for earning and redemption. */
export async function getDefaultProgram(businessId: string, client?: PoolClient): Promise<LoyaltyProgram | null> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<ProgramRow>(
    `SELECT *
       FROM loyalty_programs
      WHERE business_id = $1 AND is_active AND is_default
      LIMIT 1`,
    [businessId],
  );
  return rows[0] ? mapProgram(rows[0]) : null;
}

/**
 * Creates or updates a named program while preserving omitted fields on an
 * update. The transaction serializes the "which program is default" decision:
 * an inactive program is never selected, and whenever active programs exist
 * exactly one of them is the default.
 */
export async function upsertProgram(businessId: string, input: LoyaltyProgramInput): Promise<LoyaltyProgram> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("نام برنامه وفاداری نمی‌تواند خالی باشد.");
  if (name.length > 120) throw new Error("نام برنامه وفاداری نباید بیش از ۱۲۰ نویسه باشد.");
  if (input.earnPointsPer100000 !== undefined) {
    nonNegativeSafeInteger(input.earnPointsPer100000, "نرخ کسب امتیاز باید عدد صحیح نامنفی باشد.");
  }
  if (input.pointValueRial !== undefined) {
    positiveSafeInteger(input.pointValueRial, "ارزش ریالی هر امتیاز باید عدد صحیح مثبت باشد.");
  }
  if (input.pointsExpiryDays !== undefined && input.pointsExpiryDays !== null) {
    positiveSafeInteger(input.pointsExpiryDays, "روزهای انقضای امتیاز باید عدد صحیح مثبت باشد یا خالی بماند.");
  }
  optionalBoolean(input.isActive, "وضعیت برنامه معتبر نیست.");
  optionalBoolean(input.isDefault, "وضعیت پیش‌فرض برنامه معتبر نیست.");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // A partial unique index prevents two defaults, but an advisory lock also
    // lets us choose a replacement deterministically instead of surfacing a
    // race-dependent unique-constraint error to the owner.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`loyalty-program:${businessId}`]);
    const { rows: currentRows } = await client.query<ProgramRow>(
      `SELECT * FROM loyalty_programs WHERE business_id = $1 ORDER BY created_at, id FOR UPDATE`,
      [businessId],
    );
    const existing = currentRows.find((row) => row.name === name);
    const next = {
      earnPointsPer100000: input.earnPointsPer100000 ?? existing?.earn_points_per_100000 ?? 1,
      pointValueRial: input.pointValueRial ?? existing?.point_value_rial ?? 1000,
      pointsExpiryDays: input.pointsExpiryDays !== undefined ? input.pointsExpiryDays : existing?.points_expiry_days ?? null,
      isActive: input.isActive ?? existing?.is_active ?? true,
      isDefault: input.isDefault ?? existing?.is_default ?? false,
    };

    if (next.isDefault && !next.isActive) {
      throw new Error("برنامهٔ پیش‌فرض باید فعال باشد.");
    }

    const otherActive = currentRows.filter((row) => row.id !== existing?.id && row.is_active);
    const existingActiveDefault = currentRows.find(
      (row) => row.id !== existing?.id && row.is_active && row.is_default,
    );
    let defaultId: string | null = existingActiveDefault?.id ?? null;

    if (next.isActive && (next.isDefault || !defaultId)) {
      // A new active program becomes the default only when there is no active
      // default. Explicitly selecting it remains the normal switch action.
      defaultId = existing?.id ?? "__new_program__";
    }
    if (!next.isActive && existing?.is_default) {
      defaultId = otherActive[0]?.id ?? null;
    }
    if (next.isActive && input.isDefault === false && existing?.is_default) {
      throw new Error("برای برداشتن پیش‌فرض، ابتدا یک برنامهٔ فعال دیگر را پیش‌فرض کنید.");
    }

    // Demote before promoting so PostgreSQL's one-default partial index is
    // satisfied at every statement boundary.
    await client.query(`UPDATE loyalty_programs SET is_default = false WHERE business_id = $1 AND is_default`, [businessId]);
    const { rows } = await client.query<ProgramRow>(
      `INSERT INTO loyalty_programs
         (business_id, name, earn_points_per_100000, point_value_rial, points_expiry_days, is_active, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, name) DO UPDATE
         SET earn_points_per_100000 = EXCLUDED.earn_points_per_100000,
             point_value_rial = EXCLUDED.point_value_rial,
             points_expiry_days = EXCLUDED.points_expiry_days,
             is_active = EXCLUDED.is_active,
             is_default = EXCLUDED.is_default
       RETURNING *`,
      [
        businessId,
        name,
        next.earnPointsPer100000,
        next.pointValueRial,
        next.pointsExpiryDays,
        next.isActive,
        defaultId === "__new_program__" || defaultId === existing?.id,
      ],
    );
    const saved = rows[0];
    if (defaultId && defaultId !== "__new_program__" && defaultId !== existing?.id) {
      await client.query(`UPDATE loyalty_programs SET is_default = true WHERE business_id = $1 AND id = $2`, [
        businessId,
        defaultId,
      ]);
    }
    await client.query("COMMIT");
    return mapProgram({ ...saved, is_default: defaultId === "__new_program__" || defaultId === existing?.id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Signed, currently spendable balance. Expired point lots and the negative
 * redemption rows allocated to those lots disappear together, so an old
 * redemption can never turn a customer's current balance negative.
 */
export async function pointsBalance(
  businessId: string,
  customerId: string,
  client?: PoolClient,
  asOfDate = todayIso(),
): Promise<number> {
  optionalIsoDate(asOfDate, "تاریخ محاسبهٔ امتیاز");
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<{ balance: string | null }>(
    `SELECT COALESCE(SUM(points) FILTER (WHERE expires_at IS NULL OR expires_at >= $3::date), 0)::text AS balance
       FROM customer_points
      WHERE business_id = $1 AND customer_id = $2`,
    [businessId, customerId, asOfDate],
  );
  return Number(rows[0]?.balance ?? 0);
}

interface SpendablePointLot {
  expiresAt: string | null;
  points: number;
}

/** Aggregate only the live expiry buckets, ordered FIFO by upcoming expiry. */
async function spendablePointLots(
  client: PoolClient,
  businessId: string,
  customerId: string,
  asOfDate: string,
): Promise<SpendablePointLot[]> {
  const { rows } = await client.query<{ expires_at: string | null; points: string }>(
    `SELECT expires_at::text, SUM(points)::text AS points
       FROM customer_points
      WHERE business_id = $1 AND customer_id = $2
        AND (expires_at IS NULL OR expires_at >= $3::date)
      GROUP BY expires_at
      HAVING SUM(points) > 0
      ORDER BY expires_at NULLS LAST`,
    [businessId, customerId, asOfDate],
  );
  return rows.map((row) => ({ expiresAt: row.expires_at, points: Number(row.points) }));
}

export interface EarnPointsResult {
  points: number;
  programId: string | null;
}

/**
 * Credits points for a sale in the caller's transaction. `earnedOn` is the
 * branch's business date when the caller has it, rather than the server's UTC
 * date, so a late-night branch neither gains nor loses a day of validity.
 */
export async function earnPoints(
  client: PoolClient,
  input: {
    businessId: string;
    customerId: string;
    /** Rial, whole — the settled invoice total the points are earned on. */
    amountRial: RialText;
    sourceType: string;
    sourceId: string;
    earnedOn?: string;
    createdBy?: string | null;
  },
): Promise<EarnPointsResult> {
  const earnedOn = optionalIsoDate(input.earnedOn, "تاریخ کسب امتیاز") ?? todayIso();
  const program = await getDefaultProgram(input.businessId, client);
  if (!program || program.earnPointsPer100000 === 0) return { points: 0, programId: null };

  const pointsBigInt = (BigInt(input.amountRial) * BigInt(program.earnPointsPer100000)) / 100_000n;
  if (pointsBigInt <= 0n) return { points: 0, programId: program.id };
  if (pointsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("تعداد امتیاز این فروش بیش از حد مجاز است.");
  }
  const points = Number(pointsBigInt);

  await client.query(
    `INSERT INTO customer_points (business_id, customer_id, points, source_type, source_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.businessId,
      input.customerId,
      points,
      input.sourceType,
      input.sourceId,
      program.pointsExpiryDays ? addDaysIso(earnedOn, program.pointsExpiryDays) : null,
    ],
  );
  return { points, programId: program.id };
}

/**
 * Redeems points into store credit. A negative points row is written for each
 * expiry bucket consumed (soonest first), preserving the expiry ledger's
 * arithmetic. Each financial operation receives its own UUID source id: using
 * the customer id here used to make a second valid redemption collide with the
 * journal's source uniqueness index.
 */
export async function redeemPoints(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    points: number;
    businessDate?: string;
    createdBy?: string | null;
  },
): Promise<{ points: number; valueRial: number; entryId: string | null }> {
  positiveSafeInteger(input.points, "تعداد امتیاز باید یک عدد صحیح مثبت باشد.");
  const businessDate = optionalIsoDate(input.businessDate, "تاریخ روز کاری") ?? todayIso();
  const program = await getDefaultProgram(input.businessId, client);
  if (!program) throw new Error("برنامهٔ فعال و پیش‌فرض وفاداری تعریف نشده است.");

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `loyalty-points:${input.businessId}:${input.customerId}`,
  ]);
  const lots = await spendablePointLots(client, input.businessId, input.customerId, businessDate);
  const balance = lots.reduce((total, lot) => total + lot.points, 0);
  if (input.points > balance) throw new Error("امتیاز کافی نیست.");

  const valueRialBigInt = BigInt(input.points) * BigInt(program.pointValueRial);
  if (valueRialBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ارزش اعتبار حاصل از این تعداد امتیاز بیش از حد مجاز است.");
  }
  const valueRial = Number(valueRialBigInt);
  const operationId = randomUUID();
  let remaining = input.points;
  for (const lot of lots) {
    if (remaining === 0) break;
    const consumed = Math.min(remaining, lot.points);
    await client.query(
      `INSERT INTO customer_points (business_id, customer_id, points, source_type, source_id, expires_at)
       VALUES ($1, $2, $3, 'loyalty_points_redemption', $4, $5)`,
      [input.businessId, input.customerId, -consumed, operationId, lot.expiresAt],
    );
    remaining -= consumed;
  }

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "loyalty.store_credit_issued",
    payload: {
      customerId: input.customerId,
      amount: rialText(valueRialBigInt.toString()),
      reason: "points_redemption",
      entryDate: businessDate,
    },
    sourceType: "loyalty_points_redemption",
    sourceId: operationId,
    createdBy: input.createdBy ?? null,
  });

  return { points: input.points, valueRial, entryId };
}

/** A customer's store-credit balance, reconstructed from issued/used events. */
export async function storeCreditBalance(businessId: string, customerId: string, client?: PoolClient): Promise<number> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows } = await run<{ issued: string | null; used: string | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type IN ('loyalty.store_credit_issued', 'order.customer_credit_issued')
                          THEN (payload->>'amount')::bigint ELSE 0 END), 0)::text AS issued,
       COALESCE(SUM(CASE WHEN event_type = 'loyalty.store_credit_used'
                          THEN (payload->>'amount')::bigint ELSE 0 END), 0)::text AS used
       FROM domain_events
      WHERE business_id = $1
        AND event_type IN ('loyalty.store_credit_issued', 'loyalty.store_credit_used', 'order.customer_credit_issued')
        AND payload->>'customerId' = $2`,
    [businessId, customerId],
  );
  return Number(rows[0]?.issued ?? 0) - Number(rows[0]?.used ?? 0);
}

/**
 * Several customers' store-credit balances in one pass — the till's picker,
 * which shows a page of customers and must not ask per row. Same events, same
 * arithmetic as {@link storeCreditBalance}; an empty id list answers empty.
 */
export async function storeCreditBalancesFor(
  businessId: string,
  customerIds: readonly string[],
  client?: PoolClient,
): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map();
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<{ customer_id: string; balance: string }>(
    `SELECT payload->>'customerId' AS customer_id,
            (COALESCE(SUM(CASE WHEN event_type IN ('loyalty.store_credit_issued', 'order.customer_credit_issued')
                               THEN (payload->>'amount')::bigint ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN event_type = 'loyalty.store_credit_used'
                               THEN (payload->>'amount')::bigint ELSE 0 END), 0))::text AS balance
       FROM domain_events
      WHERE business_id = $1
        AND event_type IN ('loyalty.store_credit_issued', 'loyalty.store_credit_used', 'order.customer_credit_issued')
        AND payload->>'customerId' = ANY($2::text[])
      GROUP BY payload->>'customerId'`,
    [businessId, customerIds],
  );
  return new Map(rows.map((row) => [row.customer_id, Number(row.balance)]));
}

/** Issue a credit liability, for a documented refund / correction. */
export async function issueStoreCredit(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    amount: number;
    reason?: string | null;
    businessDate?: string;
    createdBy?: string | null;
  },
): Promise<{ entryId: string | null }> {
  positiveSafeInteger(input.amount, "مبلغ اعتبار باید یک عدد صحیح مثبت (ریال) باشد.");
  const reason = normalizedReason(input.reason);
  const businessDate = optionalIsoDate(input.businessDate, "تاریخ روز کاری") ?? todayIso();
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "loyalty.store_credit_issued",
    payload: {
      customerId: input.customerId,
      amount: rialText(String(input.amount)),
      reason,
      entryDate: businessDate,
    },
    sourceType: "loyalty_store_credit",
    sourceId: randomUUID(),
    createdBy: input.createdBy ?? null,
  });
  return { entryId };
}

/**
 * Pays a customer's stored credit out in cash or through the bank. This is a
 * payout/refund operation, not a sales tender; the name is explicit so the
 * Growth screen cannot imply that a cash movement happened when it did not.
 */
export async function useStoreCredit(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    amount: number;
    paymentMethod: Extract<SettlementMethod, "cash" | "bank">;
    businessDate?: string;
    createdBy?: string | null;
  },
): Promise<{ entryId: string | null; balance: number }> {
  positiveSafeInteger(input.amount, "مبلغ بازپرداخت اعتبار باید یک عدد صحیح مثبت (ریال) باشد.");
  if (input.paymentMethod !== "cash" && input.paymentMethod !== "bank") {
    throw new Error("روش بازپرداخت اعتبار باید نقدی یا بانکی باشد.");
  }
  const businessDate = optionalIsoDate(input.businessDate, "تاریخ روز کاری") ?? todayIso();
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `loyalty-store-credit:${input.businessId}:${input.customerId}`,
  ]);
  const balance = await storeCreditBalance(input.businessId, input.customerId, client);
  if (input.amount > balance) throw new Error("اعتبار فروشگاهی کافی نیست.");

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "loyalty.store_credit_used",
    payload: {
      customerId: input.customerId,
      amount: rialText(String(input.amount)),
      paymentMethod: input.paymentMethod,
      entryDate: businessDate,
    },
    sourceType: "loyalty_store_credit_use",
    sourceId: randomUUID(),
    createdBy: input.createdBy ?? null,
  });
  return { entryId, balance: balance - input.amount };
}

export interface DueForRepurchaseRow {
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  predictedDate: string;
  avgIntervalDays: number;
}

/** Loyalty earned/redeemed over an optional, validated ISO-date window. */
export async function loyaltyRedemptionReport(
  businessId: string,
  range: { from?: string | null; to?: string | null },
): Promise<{
  summary: ReturnType<typeof loyaltyRedemptionSummary> & { redeemedValueRial: number };
}> {
  const from = range.from ?? null;
  const to = range.to ?? null;
  if ((from !== null && !isValidIsoDate(from)) || (to !== null && !isValidIsoDate(to)) || (from && to && from > to)) {
    throw new Error("بازهٔ گزارش وفاداری معتبر نیست.");
  }
  const { rows } = await query<{ points: number; source_type: string }>(
    `SELECT points, source_type
       FROM customer_points
      WHERE business_id = $1
        AND ($2::date IS NULL OR created_at::date >= $2::date)
        AND ($3::date IS NULL OR created_at::date <= $3::date)`,
    [businessId, from, to],
  );
  const summary = loyaltyRedemptionSummary(rows.map((row) => ({ points: row.points, sourceType: row.source_type })));
  const program = await getDefaultProgram(businessId);
  return { summary: { ...summary, redeemedValueRial: summary.redeemedPoints * (program?.pointValueRial ?? 0) } };
}

/**
 * Customers whose product-level next-purchase prediction is due. Purchases and
 * today's comparison both use the branch's business day rather than UTC, and
 * inactive customers are intentionally excluded from outreach work.
 */
export async function customersDueForRepurchase(
  businessId: string,
  locationId: string,
  today: string,
): Promise<DueForRepurchaseRow[]> {
  if (!isValidIsoDate(today)) throw new Error("تاریخ روز کاری معتبر نیست.");
  const { rows } = await query<{
    customer_id: string;
    customer_name: string;
    product_id: string;
    product_name: string;
    dates: string[];
  }>(
    `SELECT o.customer_id, c.name AS customer_name,
            COALESCE(oi.item_id::text, oi.menu_item_id::text) AS product_id,
            oi.name_snapshot AS product_name,
            array_agg(DISTINCT app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)::text
                      ORDER BY app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)::text) AS dates
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       JOIN order_items oi ON oi.order_id = o.id AND oi.location_id = o.location_id
       JOIN parties c ON c.id = o.customer_id
      WHERE o.location_id = $1
        AND l.business_id = $2
        AND c.is_active
        AND o.status = 'completed' AND o.customer_id IS NOT NULL
        AND (oi.item_id IS NOT NULL OR oi.menu_item_id IS NOT NULL)
      GROUP BY o.customer_id, c.name, COALESCE(oi.item_id::text, oi.menu_item_id::text), oi.name_snapshot`,
    [locationId, businessId],
  );

  const due: DueForRepurchaseRow[] = [];
  for (const row of rows) {
    const prediction = predictNextPurchase({ dates: row.dates });
    if (prediction.reliable && prediction.nextPurchaseDate && prediction.nextPurchaseDate <= today) {
      due.push({
        customerId: row.customer_id,
        customerName: row.customer_name,
        productId: row.product_id,
        productName: row.product_name,
        predictedDate: prediction.nextPurchaseDate,
        avgIntervalDays: prediction.avgIntervalDays,
      });
    }
  }
  return due.sort((a, b) => a.predictedDate.localeCompare(b.predictedDate) || a.customerName.localeCompare(b.customerName, "fa"));
}
