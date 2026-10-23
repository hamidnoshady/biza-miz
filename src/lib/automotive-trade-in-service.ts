/**
 * Issue #963 (#839 §9) — the two-sided trade-in: one command that sells
 * vehicle A and acquires vehicle B against it, in one transaction.
 *
 * This service invents no new way to sell, buy or post. It composes the
 * three canonical ones the dealership already has, inside the caller's
 * transaction, so both sides commit or neither does:
 *
 *   1. **B becomes real stock** through `createVehicle` — the ordinary
 *      acquisition path, with `source: "trade_in"`, the agreed allowance as
 *      its `purchase_cost_rial`, and settlement `trade_in` (Debit 1370 /
 *      Credit 2465 «تعهد بابت معاوضه خودرو»). B is `in_stock` in the branch
 *      that took it and sells later like any other used car; its expected
 *      retail price is its asking price, a separate number, and its margin
 *      will be computed from the allowance exactly like a purchase.
 *   2. **A sells through the ordinary retail invoice** (`createRetailInvoice`
 *      → `sellVehicle`), with one addition on the vehicle line: the
 *      allowance. It is *consideration*, never a discount — A's price, the
 *      minimum-price floor, revenue (4590), VAT and COGS frozen at A's
 *      effective cost are all computed exactly as for any sale. The applied
 *      part of the allowance debits 2465 inside the revenue entry (clearing
 *      what step 1 credited, as an applied deposit clears 2430); an active
 *      reservation's deposit on A is applied to the same invoice by the
 *      ordinary path — applied to the difference, never refunded-and-re-taken
 *      — and the hold closes as converted. The remaining difference is one
 *      ordinary invoice tender: cash/bank settled now, or `credit` leaving
 *      it as a receivable on the customer's account, through the existing
 *      payments/AR plumbing. An allowance larger than the invoice can
 *      absorb stays on 2465 as money still owed to the customer.
 *   3. **The link row** (`automotive_vehicle_trade_ins`, migration 0239)
 *      binds the sale occurrence to the acquired vehicle with the frozen
 *      consideration arithmetic, so "which car paid for which car" is a
 *      join on identity, not on timestamps.
 *
 * Decisions this module makes explicitly:
 *
 *   * **One car handed in per deal.** Multi-vehicle trade-ins are refused
 *     loudly at the API boundary (`multi_trade_in_not_supported`) and the
 *     input type carries exactly one traded-in vehicle.
 *   * **A trade-in always names a customer.** The 2465 obligation, the
 *     possible receivable and B's acquisition party are all that customer;
 *     an anonymous deal would post a payable to nobody.
 *   * **No landed costs at hand-in.** Transport/preparation for B are
 *     recorded afterwards through the ordinary vehicle-cost path — which is
 *     also what makes them visible to the reversal rule below.
 *   * **Reversal reverses the whole deal, or refuses.** `reverseTradeIn`
 *     mirrors A's sale through `reverseVehicleSale` (A lands `returned`,
 *     the invoice is voided, an applied deposit returns to 2430 as money
 *     held — the ordinary sale-reversal behaviour), mirrors B's acquisition
 *     entry, and archives B with the reversal reason: the customer takes
 *     their car back and the books net to zero. It *refuses* when B has
 *     passed a reversible point: B already sold (reverse B's own sale
 *     first), B in transit between branches, B under an active reservation,
 *     or B carrying any active reconditioning cost (void the costs first —
 *     money spent on a car the dealership returned is a fact the reversal
 *     must not quietly swallow). A plain sale reversal of A refuses
 *     likewise (`vehicle_has_trade_in`) — see `reverseVehicleSale`.
 *   * **Cloud-authoritative, like every sale.** Nothing here is queued,
 *     mirrored or classed offline-finalizable: the link table is
 *     `cloud_only` (`automotive-sync-classification.ts`), the capability
 *     model states `offlineTradeIn: false`, and the route refuses on a
 *     paired site rather than recording an intent.
 *
 * Idempotency: with a `clientRequestId`, concurrent twins serialise on a
 * transaction-scoped advisory lock and a retry answers with the recorded
 * deal (`replayed: true`); the same key with a different fingerprint is a
 * 409. The same key rides into the invoice, so the orders-level identity
 * agrees. Without a key, A's sold-once lock is the guard: creating B and
 * selling A share one transaction, and the loser rolls B back with it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "./db";
import {
  computeTradeInConsideration,
  validateTradeInDeal,
  wholeRial,
  type TradeInDifferenceSettlement,
  type TradeInStatus,
  type VehicleCondition,
} from "./automotive";
import {
  archiveVehicle,
  businessToday,
  createVehicle,
  VehicleError,
  type CreateVehicleInput,
} from "./automotive-service";
import { reverseVehicleSale } from "./automotive-sales-service";
import {
  createRetailInvoice,
  RetailInvoiceError,
  RetailRequestConflictError,
  type CreateRetailInvoiceTenderInput,
} from "./retail-invoice-service";
import { reverseLiveEntry } from "./retail-invoice-void-service";
import { recordDomainEvent } from "./posting-engine";
import { normalizeClientRequestId } from "./checkout-idempotency";

export class VehicleTradeInError extends VehicleError {
  constructor(code: string, message: string, status = 409) {
    super(code, message, status);
    this.name = "VehicleTradeInError";
  }
}

/**
 * The vehicle the customer hands in. Every physical field is the ordinary
 * `createVehicle` field of the same name; the condition is validated as
 * `used`, acquisition/pricing are the deal's own, and landed costs are
 * recorded after hand-in through the cost path.
 */
export type TradeInVehicleInput = Omit<
  CreateVehicleInput,
  | "businessId"
  | "locationId"
  | "condition"
  | "acquisition"
  | "askingPriceRial"
  | "minimumPriceRial"
  | "wholesalePriceRial"
  | "promotionalPriceRial"
  | "initialCosts"
  | "provenanceSource"
  | "provenancePartyId"
  | "createdBy"
> & { condition?: VehicleCondition };

export interface ExecuteTradeInInput {
  businessId: string;
  locationId: string;
  /** Vehicle A — the car being sold (`item_serials.id`). */
  soldSerialId: string;
  /** The customer on both sides of the deal. */
  customerId: string;
  /** Agreed price of A itself, Rial, before discount and before any allowance. */
  salePriceRial: number;
  discountRial?: number;
  /** True only when the caller holds `vehicles.override_min_price`. */
  overrideMinPrice?: boolean;
  /** How the customer settles whatever deposit + allowance leave due. */
  differenceSettlement: TradeInDifferenceSettlement;
  differencePaymentMethodId?: string | null;
  differenceReference?: string | null;
  /** Vehicle B — exactly one car handed in per deal. */
  tradeIn: TradeInVehicleInput;
  /** The allowance agreed for B, Rial. Becomes B's purchase cost. */
  allowanceRial: number;
  /** B's asking price at hand-in, Rial. Separate from the allowance. */
  expectedRetailRial?: number;
  /** ISO date of the hand-in; defaults to the branch's business day. */
  acquisitionDate?: string;
  note?: string | null;
  /** The submission key for the whole deal (see the module header). */
  clientRequestId?: string | null;
  createdBy?: string | null;
}

export interface TradeInDeal {
  id: string;
  businessId: string;
  locationId: string;
  saleId: string;
  orderId: string | null;
  soldSerialId: string;
  acquiredSerialId: string;
  customerId: string;
  allowanceRial: number;
  expectedRetailRial: number;
  saleTotalRial: number;
  depositAppliedRial: number;
  tradeInAppliedRial: number;
  remainderPayableRial: number;
  differenceDueRial: number;
  differenceSettlement: TradeInDifferenceSettlement | "none";
  acquisitionEntryId: string | null;
  status: TradeInStatus;
  reversalReason: string | null;
  reversalEntryIds: string[];
  reversedBy: string | null;
  reversedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface TradeInResult {
  tradeIn: TradeInDeal;
  orderId: string | null;
  orderNumber: number | null;
  saleId: string;
  /** The acquired vehicle's identity, for the counter's confirmation. */
  acquiredSerialId: string;
  acquiredStockNumber: string | null;
  /** True when this answers a retry of a deal already recorded. */
  replayed: boolean;
}

interface TradeInRow {
  id: string;
  business_id: string;
  location_id: string;
  sale_id: string;
  order_id: string | null;
  sold_serial_id: string;
  acquired_serial_id: string;
  customer_id: string;
  allowance_rial: string;
  expected_retail_rial: string;
  sale_total_rial: string;
  deposit_applied_rial: string;
  trade_in_applied_rial: string;
  remainder_payable_rial: string;
  difference_due_rial: string;
  difference_settlement: TradeInDifferenceSettlement | "none";
  acquisition_entry_id: string | null;
  status: TradeInStatus;
  reversal_reason: string | null;
  reversal_entry_ids: string[];
  reversed_by: string | null;
  reversed_at: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
}

const TRADE_IN_COLUMNS = `id, business_id, location_id, sale_id, order_id, sold_serial_id,
  acquired_serial_id, customer_id, allowance_rial::text AS allowance_rial,
  expected_retail_rial::text AS expected_retail_rial, sale_total_rial::text AS sale_total_rial,
  deposit_applied_rial::text AS deposit_applied_rial,
  trade_in_applied_rial::text AS trade_in_applied_rial,
  remainder_payable_rial::text AS remainder_payable_rial,
  difference_due_rial::text AS difference_due_rial, difference_settlement,
  acquisition_entry_id, status, reversal_reason, reversal_entry_ids, reversed_by,
  reversed_at::text AS reversed_at, request_fingerprint, created_by, created_at::text AS created_at`;

function mapTradeIn(row: TradeInRow): TradeInDeal {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    saleId: row.sale_id,
    orderId: row.order_id,
    soldSerialId: row.sold_serial_id,
    acquiredSerialId: row.acquired_serial_id,
    customerId: row.customer_id,
    allowanceRial: Number(row.allowance_rial),
    expectedRetailRial: Number(row.expected_retail_rial),
    saleTotalRial: Number(row.sale_total_rial),
    depositAppliedRial: Number(row.deposit_applied_rial),
    tradeInAppliedRial: Number(row.trade_in_applied_rial),
    remainderPayableRial: Number(row.remainder_payable_rial),
    differenceDueRial: Number(row.difference_due_rial),
    differenceSettlement: row.difference_settlement,
    acquisitionEntryId: row.acquisition_entry_id,
    status: row.status,
    reversalReason: row.reversal_reason,
    reversalEntryIds: row.reversal_entry_ids ?? [],
    reversedBy: row.reversed_by,
    reversedAt: row.reversed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Recursively key-sorted JSON — the same canonical form `checkout-idempotency` fingerprints with. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value ?? null;
}

/**
 * What one submission key was *for*: the whole two-sided intent (both cars,
 * the customer, the money), never actor/clock — so a colleague's retry of
 * the same deal replays it, and a changed deal under an old key conflicts.
 */
export function tradeInRequestFingerprint(input: ExecuteTradeInInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          soldSerialId: input.soldSerialId,
          customerId: input.customerId,
          salePriceRial: input.salePriceRial,
          discountRial: input.discountRial ?? 0,
          differenceSettlement: input.differenceSettlement,
          allowanceRial: input.allowanceRial,
          expectedRetailRial: input.expectedRetailRial ?? 0,
          acquisitionDate: input.acquisitionDate ?? null,
          tradeIn: input.tradeIn,
        }),
      ),
    )
    .digest("hex");
}

async function resultForRecordedDeal(
  client: PoolClient,
  row: TradeInRow,
  replayed: boolean,
): Promise<TradeInResult> {
  const { rows } = await client.query<{ order_number: string | null; stock_number: string | null }>(
    `SELECT (SELECT order_number::text FROM orders WHERE id = $2) AS order_number,
            (SELECT stock_number FROM automotive_vehicle_attributes
              WHERE business_id = $3 AND serial_id = $1) AS stock_number`,
    [row.acquired_serial_id, row.order_id, row.business_id],
  );
  return {
    tradeIn: mapTradeIn(row),
    orderId: row.order_id,
    orderNumber: rows[0]?.order_number == null ? null : Number(rows[0].order_number),
    saleId: row.sale_id,
    acquiredSerialId: row.acquired_serial_id,
    acquiredStockNumber: rows[0]?.stock_number ?? null,
    replayed,
  };
}

/** Records one two-sided trade-in deal, atomically, in the caller's transaction. */
export async function executeTradeIn(
  client: PoolClient,
  input: ExecuteTradeInInput,
): Promise<TradeInResult> {
  const validationError = validateTradeInDeal({
    customerId: input.customerId,
    soldSerialId: input.soldSerialId,
    allowanceRial: input.allowanceRial,
    expectedRetailRial: input.expectedRetailRial ?? 0,
    tradeInCondition: input.tradeIn.condition ?? "used",
    differenceSettlement: input.differenceSettlement,
  });
  if (validationError) throw new VehicleTradeInError("invalid_trade_in", validationError, 400);
  try {
    const price = wholeRial(input.salePriceRial, "قیمت فروش خودرو");
    if (price <= 0) throw new Error("قیمت فروش خودرو باید بزرگ‌تر از صفر باشد.");
    const discount = wholeRial(input.discountRial ?? 0, "تخفیف");
    if (discount > price) throw new Error("تخفیف نمی‌تواند از قیمت خودرو بیشتر باشد.");
  } catch (err) {
    throw new VehicleTradeInError("invalid_amount", (err as Error).message, 400);
  }
  if (!input.tradeIn.make?.trim() || !input.tradeIn.model?.trim()) {
    throw new VehicleTradeInError("invalid_trade_in", "برند و مدل خودروی معاوضه الزامی است.", 400);
  }
  if (input.acquisitionDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.acquisitionDate)) {
    throw new VehicleTradeInError("invalid_date", "تاریخ تحویل خودروی معاوضه نامعتبر است.", 400);
  }

  const clientRequestId = normalizeClientRequestId(input.clientRequestId ?? null);
  if (input.clientRequestId != null && input.clientRequestId !== "" && !clientRequestId) {
    throw new VehicleTradeInError("invalid_client_request_id", "کلید درخواست نامعتبر است.", 400);
  }
  const fingerprint = clientRequestId ? tradeInRequestFingerprint(input) : null;

  if (clientRequestId) {
    // One twin at a time: without this, two simultaneous deliveries could
    // both pass the replay check below and race into acquiring B twice.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      `automotive-trade-in:${input.businessId}:${input.locationId}`,
      clientRequestId,
    ]);
    const { rows: prior } = await client.query<TradeInRow>(
      `SELECT ${TRADE_IN_COLUMNS} FROM automotive_vehicle_trade_ins
        WHERE business_id = $1 AND location_id = $2 AND client_request_id = $3
        FOR UPDATE`,
      [input.businessId, input.locationId, clientRequestId],
    );
    if (prior[0]) {
      if (prior[0].request_fingerprint !== fingerprint) {
        throw new VehicleTradeInError(
          "request_conflict",
          "این کلید درخواست قبلاً برای معاملهٔ دیگری ثبت شده است.",
          409,
        );
      }
      return resultForRecordedDeal(client, prior[0], true);
    }
  }

  // The customer is re-read inside the deal's own tenant scope — a party id
  // from another business must not become this deal's counterparty just
  // because the foreign key alone would accept it.
  const { rows: customerRows } = await client.query<{ id: string }>(
    `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
    [input.customerId, input.businessId],
  );
  if (!customerRows[0]) {
    throw new VehicleTradeInError("customer_not_found", "مشتری یافت نشد.", 404);
  }

  const acquisitionDate = input.acquisitionDate ?? (await businessToday(client, input.locationId));
  const allowanceRial = input.allowanceRial;
  const expectedRetailRial = input.expectedRetailRial ?? 0;

  // Side 1 — B enters stock through the ordinary acquisition path. The
  // allowance is its purchase cost and the expected retail its asking
  // price: two fields, never one number doing both jobs.
  const acquired = await createVehicle(client, {
    ...input.tradeIn,
    businessId: input.businessId,
    locationId: input.locationId,
    condition: "used",
    provenanceSource: "trade_in",
    provenancePartyId: input.customerId,
    acquisition: {
      date: acquisitionDate,
      source: "trade_in",
      partyId: input.customerId,
      costRial: allowanceRial,
      settlement: "trade_in",
      note: input.note ?? null,
    },
    askingPriceRial: expectedRetailRial,
    createdBy: input.createdBy ?? null,
  });

  // Side 2 — A sells through the ordinary retail invoice. The difference is
  // one open tender ("whatever remains due, by this method"): `sellVehicle`
  // alone knows the deposit it will apply, so the open slice is what keeps
  // deposit + allowance + tenders equal to the invoice total by
  // construction instead of by the caller guessing the same arithmetic.
  const tenders: CreateRetailInvoiceTenderInput[] = [
    {
      method: input.differenceSettlement,
      paymentMethodId: input.differencePaymentMethodId ?? null,
      reference: input.differenceReference ?? null,
    },
  ];
  let invoice;
  try {
    invoice = await createRetailInvoice(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      industry: "automotive",
      lines: [
        {
          kind: "vehicle",
          serialId: input.soldSerialId,
          price: input.salePriceRial,
          discount: input.discountRial ?? 0,
          // `sellVehicle` reads the business's configured rate itself; the
          // line's copy is the deprecated carrier and is never trusted.
          vatPercent: 0,
          overrideMinPrice: input.overrideMinPrice === true,
          tradeInAllowanceRial: allowanceRial,
          tradeInSerialId: acquired.serialId,
        },
      ],
      tenders,
      customerId: input.customerId,
      note: input.note ?? null,
      clientRequestId,
      createdBy: input.createdBy ?? null,
    });
  } catch (err) {
    if (err instanceof VehicleError) throw err;
    if (err instanceof RetailRequestConflictError) {
      throw new VehicleTradeInError(
        "request_conflict",
        "این کلید درخواست قبلاً برای فروش دیگری ثبت شده است.",
        409,
      );
    }
    if (err instanceof RetailInvoiceError) {
      throw new VehicleTradeInError("sale_failed", err.message, 409);
    }
    throw err;
  }

  // Freeze the deal's arithmetic from what the sale actually recorded
  // (deposit applied, allowance applied, invoice total) — the link reports
  // the occurrence, never the request's hopes.
  const { rows: saleRows } = await client.query<{
    sale_id: string;
    order_item_id: string | null;
    deposit_applied: string;
    trade_in_applied: string;
  }>(
    `SELECT s.sale_id, s.order_item_id,
            coalesce(oi.retail_snapshot->>'depositApplied', '0') AS deposit_applied,
            coalesce(oi.retail_snapshot->>'tradeInApplied', '0') AS trade_in_applied
       FROM automotive_vehicle_sales s
       LEFT JOIN order_items oi ON oi.id = s.order_item_id
      WHERE s.business_id = $1 AND s.order_id = $2 AND s.serial_id = $3 AND s.status = 'active'`,
    [input.businessId, invoice.orderId, input.soldSerialId],
  );
  const sale = saleRows[0];
  if (!sale) {
    throw new VehicleTradeInError("sale_occurrence_not_found", "سابقهٔ فروش خودرو در این معامله ساخته نشد.", 409);
  }
  const consideration = computeTradeInConsideration({
    saleTotalRial: Number(invoice.total),
    depositAppliedRial: Number(sale.deposit_applied),
    allowanceRial,
    expectedRetailRial,
  });
  if (consideration.tradeInAppliedRial !== Number(sale.trade_in_applied)) {
    throw new VehicleTradeInError(
      "trade_in_amount_mismatch",
      "مبلغ اعمال‌شدهٔ معاوضه با سابقهٔ فروش هم‌خوان نیست؛ معامله ثبت نشد.",
      409,
    );
  }

  const { rows: entryRows } = await client.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE business_id = $1 AND source_type = 'automotive_vehicle' AND source_id = $2
        AND posting_kind = 'automotive_vehicle_acquired'
      ORDER BY posted_at DESC LIMIT 1`,
    [input.businessId, acquired.serialId],
  );

  const { rows: linkRows } = await client.query<TradeInRow>(
    `INSERT INTO automotive_vehicle_trade_ins (
       business_id, location_id, sale_id, order_id, sold_serial_id, acquired_serial_id,
       customer_id, allowance_rial, expected_retail_rial, sale_total_rial,
       deposit_applied_rial, trade_in_applied_rial, remainder_payable_rial,
       difference_due_rial, difference_settlement, acquisition_entry_id,
       client_request_id, request_fingerprint, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING ${TRADE_IN_COLUMNS}`,
    [
      input.businessId,
      input.locationId,
      sale.sale_id,
      invoice.orderId,
      input.soldSerialId,
      acquired.serialId,
      input.customerId,
      allowanceRial,
      expectedRetailRial,
      consideration.saleTotalRial,
      consideration.depositAppliedRial,
      consideration.tradeInAppliedRial,
      consideration.remainderPayableRial,
      consideration.differenceDueRial,
      consideration.differenceDueRial === 0 ? "none" : input.differenceSettlement,
      entryRows[0]?.id ?? null,
      clientRequestId,
      fingerprint,
      input.createdBy ?? null,
    ],
  );
  const link = linkRows[0];

  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "automotive.trade_in_completed",
    payload: {
      tradeInId: link.id,
      saleId: sale.sale_id,
      orderId: invoice.orderId,
      soldSerialId: input.soldSerialId,
      acquiredSerialId: acquired.serialId,
      acquiredStockNumber: acquired.stockNumber,
      customerId: input.customerId,
      allowanceRial,
      expectedRetailRial,
      saleTotalRial: consideration.saleTotalRial,
      depositAppliedRial: consideration.depositAppliedRial,
      tradeInAppliedRial: consideration.tradeInAppliedRial,
      remainderPayableRial: consideration.remainderPayableRial,
      differenceDueRial: consideration.differenceDueRial,
      differenceSettlement: consideration.differenceDueRial === 0 ? "none" : input.differenceSettlement,
    },
    sourceType: "automotive_vehicle_trade_in",
    sourceId: link.id,
    createdBy: input.createdBy ?? null,
  });

  return {
    tradeIn: mapTradeIn(link),
    orderId: invoice.orderId,
    orderNumber: invoice.orderNumber,
    saleId: sale.sale_id,
    acquiredSerialId: acquired.serialId,
    acquiredStockNumber: acquired.stockNumber,
    replayed: false,
  };
}

/**
 * Reverses a whole trade-in deal in the caller's transaction — the decision
 * the module header states: both sides unwind together, or the refusal
 * names why B can no longer be handed back.
 */
export async function reverseTradeIn(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    tradeInId: string;
    reason: string;
    actorId?: string | null;
  },
): Promise<{ tradeIn: TradeInDeal; reversalEntryIds: string[] }> {
  const reason = input.reason?.trim();
  if (!reason) throw new VehicleTradeInError("reason_required", "دلیل برگشت معاوضه الزامی است.", 400);

  const { rows } = await client.query<TradeInRow>(
    `SELECT ${TRADE_IN_COLUMNS} FROM automotive_vehicle_trade_ins
      WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [input.businessId, input.tradeInId],
  );
  const link = rows[0];
  if (!link) throw new VehicleTradeInError("trade_in_not_found", "معاملهٔ معاوضه یافت نشد.", 404);
  if (link.location_id !== input.locationId) {
    throw new VehicleTradeInError("wrong_location", "این معاوضه متعلق به شعبهٔ فعال نیست.", 409);
  }
  if (link.status === "reversed") {
    throw new VehicleTradeInError("trade_in_already_reversed", "این معاوضه قبلاً برگشت شده است.", 409);
  }

  // B's reversibility, decided before anything moves.
  const { rows: vehicleRows } = await client.query<{ state: string; location_id: string; stock_number: string }>(
    `SELECT state, location_id, stock_number FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2 FOR UPDATE`,
    [input.businessId, link.acquired_serial_id],
  );
  const acquired = vehicleRows[0];
  if (!acquired) throw new VehicleTradeInError("vehicle_not_found", "خودروی معاوضه‌ای یافت نشد.", 404);
  if (acquired.state === "sold") {
    throw new VehicleTradeInError(
      "trade_in_vehicle_sold",
      "خودروی معاوضه‌ای فروخته شده است؛ ابتدا فروش آن خودرو را برگشت بزنید، سپس معاوضه را برگشت کنید.",
      409,
    );
  }
  if (acquired.state === "transferred") {
    throw new VehicleTradeInError(
      "trade_in_vehicle_in_transit",
      "خودروی معاوضه‌ای در انتقال بین شعبه است؛ پس از تحویل به شعبهٔ مقصد دوباره تلاش کنید.",
      409,
    );
  }
  if (acquired.state === "archived") {
    throw new VehicleTradeInError(
      "trade_in_vehicle_archived",
      "خودروی معاوضه‌ای بایگانی شده است و دیگر قابل استرداد به مشتری نیست.",
      409,
    );
  }
  const { rows: blockerRows } = await client.query<{ held: boolean; has_costs: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM serial_reservations
                     WHERE business_id = $1 AND serial_id = $2 AND status = 'active') AS held,
            EXISTS (SELECT 1 FROM automotive_vehicle_costs
                     WHERE business_id = $1 AND serial_id = $2 AND status = 'active') AS has_costs`,
    [input.businessId, link.acquired_serial_id],
  );
  if (blockerRows[0]?.held) {
    throw new VehicleTradeInError(
      "trade_in_vehicle_reserved",
      "خودروی معاوضه‌ای رزرو فعال دارد؛ ابتدا رزرو را تعیین تکلیف کنید.",
      409,
    );
  }
  if (blockerRows[0]?.has_costs) {
    throw new VehicleTradeInError(
      "trade_in_vehicle_reconditioned",
      "برای خودروی معاوضه‌ای هزینه ثبت شده است؛ ابتدا هزینه‌های آن را ابطال کنید تا خودرو همان‌طور که تحویل گرفته شد برگردد.",
      409,
    );
  }
  if (!link.acquisition_entry_id) {
    throw new VehicleTradeInError(
      "trade_in_acquisition_entry_missing",
      "سند خرید خودروی معاوضه‌ای معلوم نیست؛ برگشت خودکار ممکن نیست و باید دستی اصلاح شود.",
      409,
    );
  }

  // Side 1 — A's sale mirrors through the ordinary reversal (invoice void,
  // A → `returned`, 2465's applied part re-credited, an applied deposit
  // back on 2430 as money held).
  const { reversalEntryIds: saleReversalIds } = await reverseVehicleSale(client, {
    businessId: input.businessId,
    serialId: link.sold_serial_id,
    locationId: input.locationId,
    reason,
    actorId: input.actorId ?? null,
    tradeInReversalId: link.id,
  });

  // Side 2 — B's acquisition entry mirrors, clearing both the re-credited
  // applied part and any remainder still payable, and taking B out of 1370.
  const reversalEntryIds = [...saleReversalIds];
  const acquisitionReversalId = await reverseLiveEntry(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    entryId: link.acquisition_entry_id,
    amendmentId: randomUUID(),
    memo: `برگشت معاوضه — خودروی تحویلی${acquired.stock_number ? ` — ${acquired.stock_number}` : ""}`,
    createdBy: input.actorId ?? null,
  });
  if (acquisitionReversalId) reversalEntryIds.push(acquisitionReversalId);

  // The customer takes B back: it leaves the board as an archive with the
  // reason, never a delete. `acquired.location_id` is B's branch — the
  // branch holding the car archives it, even if it was transferred after
  // hand-in (an in-transit car was refused above).
  await archiveVehicle(client, {
    businessId: input.businessId,
    serialId: link.acquired_serial_id,
    locationId: acquired.location_id,
    reason: `برگشت معاوضه: ${reason}`,
    actorId: input.actorId ?? null,
  });

  const { rows: updated } = await client.query<TradeInRow>(
    `UPDATE automotive_vehicle_trade_ins
        SET status = 'reversed', reversal_reason = $3, reversal_entry_ids = $4::uuid[],
            reversed_by = $5, reversed_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2 AND status = 'active'
      RETURNING ${TRADE_IN_COLUMNS}`,
    [input.businessId, link.id, reason, reversalEntryIds, input.actorId ?? null],
  );
  if (!updated[0]) {
    throw new VehicleTradeInError("trade_in_already_reversed", "این معاوضه قبلاً برگشت شده است.", 409);
  }

  await recordDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "automotive.trade_in_reversed",
    payload: {
      tradeInId: link.id,
      saleId: link.sale_id,
      orderId: link.order_id,
      soldSerialId: link.sold_serial_id,
      acquiredSerialId: link.acquired_serial_id,
      customerId: link.customer_id,
      allowanceRial: Number(link.allowance_rial),
      reversalEntryIds,
      reason,
    },
    sourceType: "automotive_vehicle_trade_in",
    sourceId: link.id,
    createdBy: input.actorId ?? null,
  });

  return { tradeIn: mapTradeIn(updated[0]), reversalEntryIds };
}

/** One deal by id, tenant-scoped. Reads on the pooled connection. */
export async function getTradeIn(businessId: string, tradeInId: string): Promise<TradeInDeal | null> {
  const { rows } = (await query(
    `SELECT ${TRADE_IN_COLUMNS} FROM automotive_vehicle_trade_ins WHERE business_id = $1 AND id = $2`,
    [businessId, tradeInId],
  )) as unknown as { rows: TradeInRow[] };
  return rows[0] ? mapTradeIn(rows[0]) : null;
}

/**
 * Every deal a vehicle took part in — asked from either side («این خودرو با
 * چه خودرویی معاوضه شد؟»), newest first.
 */
export async function listTradeInsForVehicle(
  businessId: string,
  serialId: string,
): Promise<TradeInDeal[]> {
  const { rows } = (await query(
    `SELECT ${TRADE_IN_COLUMNS} FROM automotive_vehicle_trade_ins
      WHERE business_id = $1 AND (sold_serial_id = $2 OR acquired_serial_id = $2)
      ORDER BY created_at DESC`,
    [businessId, serialId],
  )) as unknown as { rows: TradeInRow[] };
  return rows.map(mapTradeIn);
}
