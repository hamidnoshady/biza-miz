/**
 * Issue #839 Wave 4 — selling one exact car, inside the ordinary retail
 * invoice.
 *
 * The issue is explicit that a vehicle sale is **not** a second sales system:
 * "sales must reuse the existing retail invoice/accounting path; the invoice
 * line identifies the exact vehicle". This module is therefore the automotive
 * counterpart of `watch-sales-service.ts`'s `sellSerializedUnit` — the same
 * contract with the retail invoice engine, and the same discipline:
 *
 *   1. **Lock the unit first.** `FOR UPDATE` on the vehicle row means two
 *      invoices racing for one car serialise here; the loser re-reads the
 *      committed row, sees it sold, and refuses — instead of both posting
 *      revenue for one car.
 *   2. **Re-check the tenant and the branch.** The vehicle is re-read by
 *      `business_id` and must belong to the invoice's own branch; a client's
 *      `businessId`/`locationId` is never trusted (the route passes the
 *      session's).
 *   3. **A live hold blocks a sale to anyone but its customer** — §7's "an
 *      active reservation blocks a second sale" — with an explicit override
 *      for the manager who decides otherwise.
 *   4. **The floor is the car's own number.** A sale below
 *      `minimum_price_rial` requires `vehicles.override_min_price`; the rule
 *      lives in `automotive.ts` so the screen, the API and the sale cannot
 *      disagree about what it means.
 *   5. **Cost and price never meet.** Revenue and COGS are two separate
 *      postings, and the COGS number is the *frozen* effective cost written
 *      onto the car in this same transaction — a reconditioning cost recorded
 *      next week cannot rewrite what the books recorded today.
 *   6. **The deposit is applied, not re-earned.** The reservation's deposit
 *      clears the customer-advance liability inside the revenue entry.
 *
 * Idempotency comes from the same place every other retail sale gets it: the
 * `(source_type, source_id, posting_kind)` uniqueness on `journal_entries`,
 * with a freshly generated sale id per occurrence — so a retried request that
 * somehow reached the posting stage twice cannot double-post, and a car that is
 * legitimately returned and resold can post again under its new sale id.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { checkMinimumPrice } from "./automotive";
import { ensureVehicleState, VehicleError } from "./automotive-service";
import { businessVatPercent, type TaxConfig } from "./vat-policy";
import { rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { computeWatchSalePrice } from "./watch-pricing";
import { resolveLineTenders, type RetailTender, type RetailTenderQueueEntry } from "./retail-tenders";
import {
  convertVehicleReservation,
  resolveVehicleReservationForSale,
} from "./automotive-reservation-service";
// Side-effect import: registers the automotive.* posting rules (revenue, COGS,
// deposits) with the engine.
import "./automotive-posting-rules";
import { reverseLiveEntry, RetailInvoiceVoidError, voidRetailInvoice } from "./retail-invoice-void-service";

export class VehicleSaleError extends VehicleError {
  constructor(code: string, message: string, status = 409) {
    super(code, message, status);
    this.name = "VehicleSaleError";
  }
}

export interface SellVehicleInput {
  businessId: string;
  locationId: string;
  serialId: string;
  /** Agreed price of the car itself, Rial, before the discount. */
  price: number;
  discount?: number;
  /** @deprecated Ignored: the sale service always reads `tax.config` for this business. */
  vatPercent?: number;
  /** The invoice's shared tender queue (retail-tenders.ts). */
  tenders?: RetailTenderQueueEntry[];
  /** A single settlement, for the direct (non-invoice) caller. */
  paymentMethod?: "cash" | "bank" | "credit";
  customerId?: string | null;
  /** ISO date (YYYY-MM-DD); defaults to the branch's own business day. */
  saleDate?: string;
  /** The invoice this sale belongs to, recorded on the car's frozen facts. */
  orderId?: string | null;
  /** True only when the caller holds `vehicles.override_min_price`. */
  overrideMinPrice?: boolean;
  createdBy?: string | null;
}

export interface VehicleSaleResult {
  /** Stable identity for this sale occurrence and its idempotent ledger postings. */
  saleId: string;
  /** Canonical business tax rate actually applied to the sale. */
  vatPercent: number;
  serialId: string;
  stockNumber: string;
  displayName: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  /** The discount taken on this sale (manual + promotion). */
  discount?: RialText;
  /** The car's effective cost at the instant of sale — the number COGS posted. */
  frozenEffectiveCost: RialText;
  marginRial: number;
  revenueEntryId: string | null;
  cogsEntryId: string | null;
  /** The deposit applied to this invoice, Rial. */
  depositApplied: RialText;
  /** The same number as a plain integer, for callers that need to compare it. */
  depositAppliedToThisInvoiceRial: number;
  reservationId: string | null;
}

interface VehicleSaleRow {
  serial_id: string;
  item_id: string;
  location_id: string;
  state: string;
  make: string;
  model: string;
  trim: string | null;
  model_year: number | null;
  stock_number: string;
  vin: string | null;
  chassis_number: string | null;
  purchase_cost_rial: string;
  asking_price_rial: string;
  minimum_price_rial: string | null;
  sale_price_rial: string | null;
  sold_on: string | null;
  capitalized: string;
}

/** The branch's own business day — never the UTC calendar day (§8's sale date). */
async function businessDate(client: PoolClient, locationId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT app_business_date(now(), coalesce(timezone, 'Asia/Tehran'), business_day_start_minutes)::text AS today
       FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10);
}

export async function sellVehicle(client: PoolClient, input: SellVehicleInput): Promise<VehicleSaleResult> {
  // 1 & 2 — lock the car, scoped to this business and this branch.
  const { rows } = await client.query<VehicleSaleRow>(
    `SELECT v.serial_id, s.item_id, v.location_id, v.state, v.make, v.model, v.trim, v.model_year,
            v.stock_number, v.vin, v.chassis_number, v.purchase_cost_rial::text AS purchase_cost_rial,
            v.asking_price_rial::text AS asking_price_rial, v.minimum_price_rial::text AS minimum_price_rial,
            v.sale_price_rial::text AS sale_price_rial, v.sold_on::text AS sold_on,
            coalesce(c.capitalized, 0)::text AS capitalized
       FROM automotive_vehicle_attributes v
       JOIN item_serials s ON s.id = v.serial_id
       LEFT JOIN (
         SELECT serial_id, sum(amount_rial) FILTER (WHERE posting = 'capitalized') AS capitalized
           FROM automotive_vehicle_costs WHERE status = 'active' GROUP BY serial_id
       ) c ON c.serial_id = v.serial_id
      WHERE v.business_id = $1 AND v.serial_id = $2
      FOR UPDATE OF v`,
    [input.businessId, input.serialId],
  );
  const vehicle = rows[0];
  if (!vehicle) throw new VehicleSaleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.location_id !== input.locationId) {
    throw new VehicleSaleError("wrong_location", "این خودرو متعلق به شعبهٔ فعال نیست.", 409);
  }
  if (vehicle.state === "sold") {
    throw new VehicleSaleError("vehicle_already_sold", "این خودرو قبلاً فروخته شده است.", 409);
  }
  if (vehicle.state !== "in_stock" && vehicle.state !== "acquired" && vehicle.state !== "reserved") {
    throw new VehicleSaleError("vehicle_not_sellable", "این خودرو در وضعیت قابل فروش نیست.", 409);
  }

  // 3 — a live hold blocks a sale to anybody else.
  const saleDate = input.saleDate ?? (await businessDate(client, input.locationId));
  const hold = await resolveVehicleReservationForSale(client, {
    businessId: input.businessId,
    serialId: input.serialId,
    customerId: input.customerId ?? null,
  });

  const { rows: taxRows } = await client.query<{ value: TaxConfig | null }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = 'tax.config'`,
    [input.businessId],
  );
  const vatPercent = businessVatPercent(taxRows[0]?.value);
  const breakdown = computeWatchSalePrice({
    price: input.price,
    discount: input.discount ?? 0,
    vatPercent,
  });

  // 4 — the floor applies to the realized, pre-VAT price. A discount that
  // takes the car below its floor is still a below-floor sale, even when the
  // sticker price itself was above it.
  const floor = checkMinimumPrice({
    priceRial: Math.round(input.price),
    discountRial: Math.round(input.discount ?? 0),
    minimumPriceRial: vehicle.minimum_price_rial == null ? null : Number(vehicle.minimum_price_rial),
    overrideAllowed: input.overrideMinPrice === true,
  });
  if (!floor.allowed) {
    throw new VehicleSaleError(
      "below_minimum_price",
      "قیمت فروش پس از تخفیف از حداقل قیمت تعیین‌شده کمتر است؛ برای عبور از آن مجوز «تجاوز از حداقل قیمت» لازم است.",
      409,
    );
  }

  // 6 — the deposit the customer already paid is applied (capped at the
  // invoice total; any excess stays on their advance account to be refunded
  // deliberately rather than quietly becoming revenue).
  //
  // It applies to *this* customer's invoice only. A manager who overrode the
  // hold to sell to somebody else has not thereby transferred the other
  // customer's money: that advance stays on 2430 until it is refunded on
  // purpose.
  const depositAppliesHere = hold.applied && hold.holdCustomerId === (input.customerId ?? null);
  const depositApplied = depositAppliesHere ? Math.min(hold.depositRial, Number(breakdown.total)) : 0;
  const depositText = rialText(String(depositApplied));

  // What the cashier actually collects now: the invoice total less the deposit
  // the customer paid when they reserved. The shared queue is drawn for
  // exactly that, so the entry's debits (tenders + the deposit released from
  // 2430) are the invoice total and nothing is double-counted — and the
  // `payments` rows the shift reconciles record today's money, not money
  // taken weeks ago at the reservation counter.
  const dueNow = rialText(String(Number(breakdown.total) - depositApplied));
  const tenders: RetailTender[] = resolveLineTenders(input, dueNow);

  const effectiveCost = Number(vehicle.purchase_cost_rial) + Number(vehicle.capitalized);
  const frozenEffectiveCost = rialText(String(effectiveCost));

  // Each sale *occurrence* is its own posting identity (a car that is returned
  // and resold is a new sale), while the car stays queryable through the
  // payload's serialId.
  const saleId = randomUUID();

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "automotive.sale_revenue",
    payload: {
      serialId: vehicle.serial_id,
      itemId: vehicle.item_id,
      orderId: input.orderId ?? null,
      price: breakdown.price,
      discount: breakdown.discount,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
      tenders,
      depositApplied: depositText,
    },
    sourceType: "automotive_sale",
    sourceId: saleId,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: cogsEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "automotive.sale_cogs",
    payload: {
      serialId: vehicle.serial_id,
      itemId: vehicle.item_id,
      effectiveCost: frozenEffectiveCost,
    },
    sourceType: "automotive_sale",
    sourceId: saleId,
    createdBy: input.createdBy ?? null,
  });

  // The state transition belongs to the sale command, not a direct status
  // write. The invoice, ledger entries, serial state and frozen facts are all
  // still inside this caller-owned transaction.
  try {
    await ensureVehicleState(client, {
      businessId: input.businessId,
      serialId: vehicle.serial_id,
      locationId: input.locationId,
      state: "sold",
      actorId: input.createdBy,
      command: "sale_completed",
    });
  } catch (error) {
    if (error instanceof VehicleError) {
      throw new VehicleSaleError(error.code, error.message, error.status);
    }
    throw error;
  }
  const { rowCount } = await client.query(
    `UPDATE automotive_vehicle_attributes
        SET sold_order_id = $2, sold_customer_id = $3, sold_on = $4,
            sale_price_rial = $5, frozen_effective_cost_rial = $6, sold_by = $7, updated_at = now()
      WHERE business_id = $1 AND serial_id = $8 AND state = 'sold'`,
    [
      input.businessId,
      input.orderId ?? null,
      input.customerId ?? null,
      saleDate,
      Number(breakdown.total),
      effectiveCost,
      input.createdBy ?? null,
      vehicle.serial_id,
    ],
  );
  if (rowCount !== 1) {
    throw new VehicleSaleError("vehicle_already_sold", "این خودرو دیگر قابل فروش نیست.", 409);
  }
  await client.query(`UPDATE item_serials SET sold_at = $2 WHERE id = $1 AND status = 'sold'`, [
    vehicle.serial_id,
    saleDate,
  ]);

  // 5 — the hold closes as *converted* by this sale, and the invoice that did
  // it is recorded on the hold for the audit trail.
  if (depositAppliesHere && hold.reservationId) {
    await convertVehicleReservation(client, {
      businessId: input.businessId,
      reservationId: hold.reservationId,
      orderId: input.orderId ?? null,
    });
  }

  const marginRial = Number(breakdown.net) - effectiveCost;

  return {
    saleId,
    vatPercent,
    serialId: vehicle.serial_id,
    stockNumber: vehicle.stock_number,
    displayName: [vehicle.make, vehicle.model, vehicle.trim, vehicle.model_year]
      .filter((part) => part != null && String(part).trim() !== "")
      .join(" "),
    net: breakdown.net,
    vat: breakdown.vat,
    total: breakdown.total,
    discount: breakdown.discount,
    frozenEffectiveCost,
    marginRial,
    revenueEntryId,
    cogsEntryId,
    depositApplied: depositText,
    reservationId: hold.applied ? hold.reservationId : null,
    depositAppliedToThisInvoiceRial: depositApplied,
  };
}

/**
 * Records the invoice line that sold this car — `sold_order_item_id` is the
 * structural "sold once" guarantee (0212 makes it unique), and it is only
 * knowable *after* the line row exists, so the invoice engine calls this in the
 * same transaction the moment it has written the line.
 */
export async function attachVehicleSaleLine(
  client: PoolClient,
  input: {
    businessId: string;
    serialId: string;
    saleId: string;
    orderId: string;
    orderItemId: string;
    saleEntryIds: string[];
    vatRatePercent: number;
  },
): Promise<void> {
  const { rowCount } = await client.query(
    `WITH current_sale AS (
       UPDATE automotive_vehicle_attributes
          SET sold_order_id = coalesce($3, sold_order_id), sold_order_item_id = $4, updated_at = now()
        WHERE business_id = $1 AND serial_id = $2 AND state = 'sold' AND sold_order_item_id IS NULL
        RETURNING business_id, location_id, serial_id, sold_order_id, sold_order_item_id,
                  sold_customer_id, sold_on, sale_price_rial, frozen_effective_cost_rial, sold_by,
                  coalesce(acquisition_date, created_at::date) AS acquired_on,
                  stock_number, make, model, trim, model_year, condition
     )
     INSERT INTO automotive_vehicle_sales (
       sale_id, business_id, location_id, serial_id, order_id, order_item_id,
       customer_id, sold_on, acquired_on, stock_number, make, model, trim, model_year,
       condition, sale_price_rial, vat_rate_percent, frozen_effective_cost_rial, sold_by, sale_entry_ids
     )
     SELECT $5, business_id, location_id, serial_id, sold_order_id, sold_order_item_id,
            sold_customer_id, sold_on, acquired_on, stock_number, make, model, trim, model_year,
            condition, sale_price_rial, $7, frozen_effective_cost_rial, sold_by, $6::uuid[]
       FROM current_sale`,
    [
      input.businessId,
      input.serialId,
      input.orderId,
      input.orderItemId,
      input.saleId,
      input.saleEntryIds,
      input.vatRatePercent,
    ],
  );
  if (rowCount !== 1) {
    throw new VehicleSaleError("sale_line_attach_failed", "ردیف فاکتور خودرو با سابقهٔ فروش آن همگام نشد.", 409);
  }
}

/**
 * Reverses a vehicle sale — the mirror of `sellVehicle`, in the caller's own
 * transaction.
 *
 * It does not invent its own reversal logic, and it does not re-derive what
 * the sale *should* have posted: the invoice already recorded which ledger
 * entries belong to this line (`order_items.retail_snapshot.ledgerEntryIds`),
 * so the reversal mirrors **those** entries exactly — the same
 * `reverseLiveEntry` the retail void and the watch return workflow use. Two
 * consequences the code gets for free and would otherwise have to be argued
 * about separately:
 *
 *   - the money side (cash/bank/receivable, VAT, revenue) is undone the way it
 *     was taken, so a credit sale credits the customer's account back;
 *   - a reservation deposit that the sale applied is re-credited to the
 *     customer-advance liability, which is exactly what it is again — the
 *     customer's money, held, refundable on purpose rather than by accident.
 *
 * The inventory/COGS entry is reversed the same way, which is why the car is
 * carried back at the **frozen** effective cost the books used: reconditioning
 * recorded after the sale cannot rewrite what was posted before it.
 *
 * The car lands in `returned`, **not** `in_stock` — it visibly carries the fact
 * that it sold and came back, and returning it to the shelf is a deliberate
 * step (`vehicles.edit`) after inspection, never a silent side effect.
 */
export async function reverseVehicleSale(
  client: PoolClient,
  input: { businessId: string; serialId: string; locationId: string; reason: string; actorId?: string | null },
): Promise<{ reversalEntryIds: string[] }> {
  const reason = input.reason?.trim();
  if (!reason) throw new VehicleSaleError("reason_required", "دلیل برگشت فروش الزامی است.");

  const { rows } = await client.query<{ state: string; location_id: string; stock_number: string }>(
    `SELECT state, location_id, stock_number
       FROM automotive_vehicle_attributes
      WHERE business_id = $1 AND serial_id = $2
      FOR UPDATE`,
    [input.businessId, input.serialId],
  );
  const vehicle = rows[0];
  if (!vehicle) throw new VehicleSaleError("vehicle_not_found", "خودرو یافت نشد.", 404);
  if (vehicle.location_id !== input.locationId) {
    throw new VehicleSaleError("wrong_location", "این خودرو در شعبهٔ فعال نیست.", 409);
  }
  if (vehicle.state !== "sold") {
    throw new VehicleSaleError("not_sold", "این خودرو فروخته نشده است؛ برگشتی برای آن ثبت نمی‌شود.", 409);
  }

  const { rows: sales } = await client.query<{
    sale_id: string;
    location_id: string;
    order_id: string | null;
    order_item_id: string | null;
    customer_id: string | null;
    sold_on: string;
    sale_price_rial: string;
    frozen_effective_cost_rial: string | null;
    sale_entry_ids: string[];
  }>(
    `SELECT sale_id, location_id, order_id, order_item_id, customer_id, sold_on::text AS sold_on,
            sale_price_rial::text AS sale_price_rial,
            frozen_effective_cost_rial::text AS frozen_effective_cost_rial, sale_entry_ids
       FROM automotive_vehicle_sales
      WHERE business_id = $1 AND serial_id = $2 AND status = 'active'
      FOR UPDATE`,
    [input.businessId, input.serialId],
  );
  const sale = sales[0];
  if (!sale) throw new VehicleSaleError("sale_occurrence_not_found", "سابقهٔ فروش فعال این خودرو یافت نشد.", 409);
  if (sale.location_id !== input.locationId) {
    throw new VehicleSaleError("wrong_location", "فروش این خودرو متعلق به شعبهٔ فعال نیست.", 409);
  }

  // New sales store exact posting ids on their occurrence; pre-0215 sales use
  // the canonical retail line snapshot as a compatibility fallback.
  let entryIds: string[] = sale.sale_entry_ids ?? [];
  if (entryIds.length === 0 && sale.order_item_id && sale.order_id) {
    const { rows: lineRows } = await client.query<{
      retail_snapshot: { ledgerEntryIds?: string[] } | null;
    }>(
      `SELECT retail_snapshot FROM order_items
        WHERE id = $1 AND order_id = $2 AND location_id = $3`,
      [sale.order_item_id, sale.order_id, sale.location_id],
    );
    entryIds = lineRows[0]?.retail_snapshot?.ledgerEntryIds ?? [];
  }
  if (entryIds.length === 0) {
    // A sale recorded before the line kept its entries: the books cannot be
    // unwound from this row, so the reversal refuses rather than half-doing it.
    throw new VehicleSaleError(
      "sale_entries_unknown",
      "ردیف فاکتور این خودرو معلوم نیست؛ برگشت خودکار ممکن نیست و باید دستی اصلاح شود.",
      409,
    );
  }

  // The car side of the reversal: `returned`, current-sale facts cleared, the
  // occurrence closed with the mirror ids, and the domain event. Shared by the
  // invoice path and the legacy no-invoice path below.
  const releaseVehicle = async (reversalEntryIds: string[]): Promise<void> => {
    await ensureVehicleState(client, {
      businessId: input.businessId,
      serialId: input.serialId,
      locationId: sale.location_id,
      state: "returned",
      actorId: input.actorId,
      command: "sale_reversed",
    });
    const { rowCount: clearedSaleFacts } = await client.query(
      `UPDATE automotive_vehicle_attributes
          SET sold_order_id = NULL, sold_order_item_id = NULL, sold_customer_id = NULL,
              sold_on = NULL, sale_price_rial = NULL, frozen_effective_cost_rial = NULL,
              sold_by = NULL, updated_at = now()
        WHERE business_id = $1 AND serial_id = $2 AND location_id = $4
          AND state = 'returned' AND sold_order_item_id IS NOT DISTINCT FROM $3`,
      [input.businessId, input.serialId, sale.order_item_id, input.locationId],
    );
    if (clearedSaleFacts !== 1) {
      throw new VehicleSaleError("sale_state_mismatch", "واقعیت‌های فروش خودرو با سابقهٔ برگشت همگام نیست.", 409);
    }
    await client.query(`UPDATE item_serials SET sold_at = NULL WHERE id = $1`, [input.serialId]);
    const { rowCount: reversedSales } = await client.query(
      `UPDATE automotive_vehicle_sales
          SET status = 'reversed', reversal_reason = $3, reversal_entry_ids = $4::uuid[],
              reversed_by = $5, reversed_at = now()
        WHERE sale_id = $1 AND business_id = $2 AND status = 'active'`,
      [sale.sale_id, input.businessId, reason, reversalEntryIds, input.actorId ?? null],
    );
    if (reversedSales !== 1) {
      throw new VehicleSaleError("sale_already_reversed", "این سابقهٔ فروش قبلاً برگشت شده است.", 409);
    }

    await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: sale.location_id,
      eventType: "automotive.sale_reversed",
      payload: {
        serialId: input.serialId,
        stockNumber: vehicle.stock_number,
        saleId: sale.sale_id,
        orderId: sale.order_id,
        orderItemId: sale.order_item_id,
        customerId: sale.customer_id,
        soldOn: sale.sold_on,
        salePriceRial: sale.sale_price_rial,
        // The number the reversal was based on: what the books posted, not what
        // the car's cost has become since.
        frozenEffectiveCostRial: sale.frozen_effective_cost_rial,
        reversedEntryIds: reversalEntryIds,
        reason,
      },
      sourceType: "automotive_vehicle_sale",
      sourceId: sale.sale_id,
      createdBy: input.actorId ?? null,
    });
  };

  if (sale.order_id && sale.order_item_id) {
    // The sale was an invoice line: undo the whole invoice footprint (order
    // status, payments, commission, loyalty) with the retail void engine, so
    // the shift stops reporting money the ledger has given back and the
    // invoice cannot stay "completed" over a car that can be resold.
    const { rows: otherLines } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_items
        WHERE order_id = $1 AND id <> $2 AND status <> 'voided'`,
      [sale.order_id, sale.order_item_id],
    );
    if (Number(otherLines[0]?.count ?? 0) > 0) {
      throw new VehicleSaleError(
        "invoice_has_other_lines",
        "فاکتور این خودرو ردیف‌های دیگری هم دارد؛ برگشت تنها یک ردیف از فاکتور به‌صورت خودکار ممکن نیست.",
        409,
      );
    }
    const reversalEntryIds: string[] = [];
    try {
      await voidRetailInvoice(
        client,
        {
          businessId: input.businessId,
          locationId: sale.location_id,
          orderId: sale.order_id,
          actorId: input.actorId ?? null,
          reason,
        },
        {
          entryDate: await businessDate(client, sale.location_id),
          memo: `برگشت فروش خودرو${vehicle.stock_number ? ` — ${vehicle.stock_number}` : ""}`,
          vehicleLineReversal: async (line) => {
            if (line.orderItemId !== sale.order_item_id || line.serialId !== input.serialId) {
              throw new VehicleSaleError("sale_state_mismatch", "ردیف فاکتور با خودروی برگشتی یکی نیست.", 409);
            }
            reversalEntryIds.push(...line.reversalEntryIds);
            await releaseVehicle(line.reversalEntryIds);
          },
        },
      );
      // The entries this sale posted, mirrored; commission/loyalty reversals
      // are the invoice's and stay recorded on its amendment.
      return { reversalEntryIds };
    } catch (err) {
      if (err instanceof RetailInvoiceVoidError) {
        throw new VehicleSaleError("invoice_void_refused", err.message, err.status);
      }
      throw err;
    }
  }

  // A sale with no invoice line (direct caller): mirror the posted entries.
  const amendmentId = randomUUID();
  const reversalEntryIds: string[] = [];
  for (const entryId of entryIds) {
    const reversalEntryId = await reverseLiveEntry(client, {
      businessId: input.businessId,
      locationId: sale.location_id,
      entryId,
      amendmentId,
      memo: `برگشت فروش خودرو${vehicle.stock_number ? ` — ${vehicle.stock_number}` : ""}`,
      createdBy: input.actorId ?? null,
    });
    if (reversalEntryId) reversalEntryIds.push(reversalEntryId);
  }
  await releaseVehicle(reversalEntryIds);

  return { reversalEntryIds };
}

