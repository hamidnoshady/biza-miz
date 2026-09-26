/**
 * Phase 25 Wave 3 — writing a retail sale down as a document.
 *
 * Phase 21 gave jewelry, watch and accessories each a correct *posting* path:
 * `sellWeightedItem`, `sellSerializedUnit`, `sellAccessoryUnits`. What none of
 * them produced was a sale. Each posts one item straight into the ledger from
 * an admin panel — no order row, no customer, no line items, no invoice
 * number, nothing to print, and nothing in سفارش‌ها or in any sales report. A
 * shop selling two rings and a chain to one customer had no way to say so.
 *
 * This is the missing half, and it is deliberately thin: it writes the
 * document (`orders` + `order_items`) and then calls those same three services,
 * unchanged, one per line, inside the same transaction. Every ledger posting,
 * stock decrement, serial status change, consignment settlement and item-audit
 * event is therefore exactly what Phase 21 already does and tests — this adds a
 * record of the sale, it does not add a second way to account for one.
 *
 * A retail invoice is an `orders` row rather than a parallel `invoices` table
 * for the same reason: per-location sequential numbering, payments, customer
 * linkage, the receipt pipeline, the orders list and the reporting joins all
 * already exist there. See migration 0071 for the two columns that were
 * missing.
 *
 * DB-touching, so per repo convention no direct unit test; covered by
 * integration/retail-invoice.integration.test.ts, which asserts the ledger
 * result matches the existing single-item sale tests line for line.
 */
import type { PoolClient } from "pg";
import { sellWeightedItem } from "./gold-sales-service";
import { sellSerializedUnit } from "./watch-sales-service";
import { getStock, sellAccessoryUnits } from "./accessories-service";
import { sellCosmeticUnits } from "./cosmetics-service";
import { sellTradeGoodsUnits } from "./trade-goods-service";
import { isTradeGoodsIndustry } from "./trade-goods";
import { getItem } from "./items-service";
import { accrueCommissionForLine } from "./commission-service";
import { earnPoints } from "./loyalty-service";
import { evaluatePromotions, type AppliedPromotion, type PromotionItem } from "./promotions";
import { listPromotions } from "./promotions-service";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import type { MakingChargeType } from "./gold-pricing";
import type { SettlementMethod } from "./ledger";
import type { Industry } from "./industries";
import type { RetailInvoiceLineSnapshotStored } from "./retail-invoice/types";
import {
  assertTendersExhausted,
  buildTenderQueue,
  resolveTenderAmounts,
  type RetailTenderInput,
  type RetailTenderQueueEntry,
} from "./retail-tenders";

/** One line of a retail invoice, discriminated by how its industry prices things. */
export type RetailInvoiceLineInput =
  | {
      kind: "gold";
      /** A weighed piece (`items.tracking = 'weight'`). Quantity is always 1 — each piece is unique. */
      itemId: string;
      makingChargeType: MakingChargeType;
      makingChargeValue: number;
      profitPercent: number;
      vatPercent: number;
    }
  | {
      kind: "watch";
      /** A specific serialised unit (`item_serials.id`), not the model. */
      serialId: string;
      price: number;
      discount?: number;
      vatPercent: number;
      warrantyMonths?: number;
    }
  | {
      kind: "accessory";
      itemId: string;
      /** Decimal string — `item_stock.quantity` is numeric, not integer. */
      quantity: string;
      /** Omit to use the variant's standard price from `item_stock`. */
      unitPrice?: number;
      discount?: number;
      vatPercent: number;
    }
  | {
      kind: "cosmetic";
      itemId: string;
      quantity: string;
      unitPrice?: number;
      discount?: number;
      vatPercent: number;
    }
  | {
      kind: "stocked";
      itemId: string;
      quantity: string;
      unitPrice?: number;
      discount?: number;
      vatPercent: number;
    };

/**
 * One slice of the invoice's payment — ۲۰۰٬۰۰۰ نقدی plus ۳۰۰٬۰۰۰ کارت‌خوان is
 * two of these. `amount` may be omitted on at most one tender per invoice
 * ("whatever this comes to"), which is how a single, unsplit payment (still
 * the overwhelming common case, and every caller that predates this) pays
 * without the caller ever computing the invoice's total itself.
 */
export interface CreateRetailInvoiceTenderInput extends RetailTenderInput {
  /** Named payment way and optional operator-entered reference, retained for history — per slice. */
  paymentMethodId?: string | null;
  reference?: string | null;
}

export interface CreateRetailInvoiceInput {
  businessId: string;
  locationId: string;
  industry: Industry;
  lines: RetailInvoiceLineInput[];
  /** 1–10 slices; see CreateRetailInvoiceTenderInput. */
  tenders: CreateRetailInvoiceTenderInput[];
  customerId?: string | null;
  note?: string | null;
  /** Branch business date supplied by the route for loyalty-point expiry. */
  businessDate?: string;
  createdBy?: string | null;
}

export interface RetailInvoiceLine {
  orderItemId: string;
  itemId: string;
  name: string;
  quantity: string;
  /** Line total excluding VAT after line/promotion discounts. */
  net: RialText;
  /** Pre-discount line total and discount, retained for the order header totals. */
  gross?: RialText;
  discount?: RialText;
  vat: RialText;
  total: RialText;
  /** Gold only: the components the customer is entitled to see on the invoice. */
  metalValue?: RialText;
  makingCharge?: RialText;
  profit?: RialText;
  /** Cosmetics batch-tracked lines only: the lot numbers consumed and the earliest expiry. */
  batchNumbers?: string[];
  expiryDate?: string | null;
}

export interface RetailInvoice {
  orderId: string;
  orderNumber: number;
  lines: RetailInvoiceLine[];
  subtotal: RialText;
  discount: RialText;
  tax: RialText;
  total: RialText;
}

/** Which line kinds an industry may put on an invoice — a shop sells what it stocks. */
const LINE_KINDS_BY_INDUSTRY: Record<Industry, readonly RetailInvoiceLineInput["kind"][]> = {
  food_service: [],
  jewelry: ["gold"],
  watch: ["watch"],
  accessories: ["accessory"],
  cosmetics: ["cosmetic"],
  wholesale: ["stocked"],
  tools_fittings: ["stocked"],
  haberdashery: ["stocked"],
};

export class RetailInvoiceError extends Error {}

function sum(values: RialText[]): RialText {
  return rialText(values.reduce((acc, v) => acc + rialBigInt(v), 0n).toString());
}

/**
 * Write and settle one retail invoice, atomically, in the caller's transaction.
 *
 * Settlement happens here rather than through `/api/orders/[id]/pay` because
 * that route's completion path is F&B's: it deducts recipe ingredients
 * (`deductForOrder`) and posts through `postExactOrderPaymentEntry`. A retail
 * line has no recipe, and its revenue/COGS split is the industry's own posting
 * rule. So the invoice is written and settled in one step — which is also what
 * a shop counter actually does, with no open-ticket stage in between.
 */
export async function createRetailInvoice(
  client: PoolClient,
  input: CreateRetailInvoiceInput,
): Promise<RetailInvoice> {
  if (input.lines.length === 0) {
    throw new RetailInvoiceError("فاکتور بدون کالا قابل ثبت نیست.");
  }
  // A نسیه (credit) tender creates a receivable someone must owe — even a
  // partial one ("نصف نقد، نصف نسیه"). Without a customer there is nobody
  // for that balance to belong to. Cash/card slices settle in full at the
  // register and stay anonymous-customer-safe.
  if (input.tenders.some((t) => t.method === "credit") && !input.customerId) {
    throw new RetailInvoiceError("برای فروش نسیه، انتخاب مشتری الزامی است.");
  }
  let tenderQueue: RetailTenderQueueEntry[];
  try {
    tenderQueue = buildTenderQueue(input.tenders);
  } catch (err) {
    throw new RetailInvoiceError(err instanceof Error ? err.message : "پرداخت نامعتبر است.");
  }
  const allowed = LINE_KINDS_BY_INDUSTRY[input.industry];
  for (const line of input.lines) {
    if (!allowed.includes(line.kind)) {
      throw new RetailInvoiceError("این نوع کالا در این کسب‌وکار قابل فروش نیست.");
    }
  }

  // Same counter every F&B order uses (order-mutations.ts), so a business's
  // invoice numbers and order numbers are one sequence per branch and can
  // never collide.
  const { rows: counter } = await client.query<{ next_number: string }>(
    `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
     ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
     RETURNING next_number - 1 AS next_number`,
    [input.locationId],
  );
  const orderNumber = Number(counter[0].next_number);

  // Opened, filled, then completed — in that order, and not because it reads
  // nicely: `guard_order_item_mutation` (migration 0014) refuses to add a line
  // to an order that is not 'open', which is exactly the invariant that makes
  // a settled sale immutable. A retail invoice has no open-ticket *stage* the
  // user ever sees, but it still passes through the state the guard requires.
  const { rows: orderRows } = await client.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, customer_id, note, opened_by)
     VALUES ($1, $2, 'retail', 'open', $3, $4, $5)
     RETURNING id`,
    [input.locationId, orderNumber, input.customerId ?? null, input.note?.trim() || null, input.createdBy ?? null],
  );
  const orderId = orderRows[0].id;

  const lines: RetailInvoiceLine[] = [];

  // Phase 27 Wave 6 — the shared promotion engine, evaluated over the retail
  // cart exactly as order-totals.ts evaluates it over an F&B cart. Promotions
  // apply to the fungible catalogue lines (accessories/cosmetics), where a
  // per-line discount already exists; a gold piece or a watch is individually
  // priced and negotiated, so it never carries a campaign discount.
  const promotion = await retailPromotionDiscounts(client, input);
  const promotionDiscounts = promotion.discounts;

  // Phase 27 Wave 13 — record which promotions fired (and how much they took
  // off) so the effectiveness report can rank campaigns. Same transaction, so
  // the invoice and its applications can never be half-committed.
  for (const applied of promotion.applied) {
    if (applied.amount <= 0) continue;
    await client.query(
      `INSERT INTO promotion_applications (business_id, location_id, promotion_id, source_type, source_id, discount_rial)
       VALUES ($1, $2, $3, 'order', $4, $5)`,
      [input.businessId, input.locationId, applied.promotionId, orderId, applied.amount],
    );
  }

  for (let lineIndex = 0; lineIndex < input.lines.length; lineIndex++) {
    const line = input.lines[lineIndex];
    const settled = await settleLine(client, input, line, promotionDiscounts[lineIndex] ?? 0, tenderQueue);

    const { rows: itemRows } = await client.query<{ id: string }>(
      `INSERT INTO order_items
         (location_id, order_id, item_id, name_snapshot, unit_price, quantity, status,
          metal_value, making_charge, profit, retail_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, 'served', $7, $8, $9, $10)
       RETURNING id`,
      [
        input.locationId,
        orderId,
        settled.itemId,
        settled.name,
        // `unit_price`/`quantity` stay the F&B-shaped columns they always
        // were (bigint line-net at integer quantity 1) — every existing join,
        // report and posting check that reads them keeps working unchanged.
        // The real sold quantity, unit price, discount split and industry
        // breakdown live in `retail_snapshot` (migration 0174); that is what
        // the retail read model and the print pipeline use, never this pair.
        rialBigInt(settled.net).toString(),
        1,
        settled.metalValue ?? null,
        settled.makingCharge ?? null,
        settled.profit ?? null,
        JSON.stringify(settled.snapshot),
      ],
    );

    lines.push({
      orderItemId: itemRows[0].id,
      itemId: settled.itemId,
      name: settled.name,
      quantity: settled.quantity,
      gross: settled.gross,
      discount: settled.discount,
      net: settled.net,
      vat: settled.vat,
      total: settled.total,
      metalValue: settled.metalValue,
      makingCharge: settled.makingCharge,
      profit: settled.profit,
      batchNumbers: settled.batchNumbers,
      expiryDate: settled.expiryDate,
    });

    // Phase 27 Wave 7 — the selling employee (the invoice's `created_by`)
    // accrues commission on this line per their rules, in the same
    // transaction, so the accrual and its payroll-liability posting can never
    // be half-committed. No employee or no matching rule accrues nothing.
    if (input.createdBy) {
      await accrueCommissionForLine(client, {
        businessId: input.businessId,
        locationId: input.locationId,
        employeeId: input.createdBy,
        sourceType: "order_item",
        sourceId: itemRows[0].id,
        line: {
          net: Number(settled.net),
          cost: settled.cost != null ? Number(settled.cost) : null,
          itemId: settled.itemId,
          brandId: settled.brandId ?? null,
        },
        createdBy: input.createdBy,
      });
    }
  }

  const subtotal = sum(lines.map((l) => l.gross ?? l.net));
  const discount = sum(lines.map((l) => l.discount ?? rialText("0")));
  const tax = sum(lines.map((l) => l.vat));
  const total = sum(lines.map((l) => l.total));

  // Every line has now drawn its own total off the shared queue; a bounded
  // tender left over here means the cashier's slices added up to more than
  // the invoice (a shortfall would already have thrown mid-draw, inside
  // settleLine, the moment a line ran out of money to draw from).
  try {
    assertTendersExhausted(tenderQueue);
  } catch (err) {
    throw new RetailInvoiceError(err instanceof Error ? err.message : "پرداخت نامعتبر است.");
  }

  await client.query(
    `UPDATE orders
        SET subtotal = $2, discount = $3, tax = $4, total = $5,
            status = 'completed', closed_by = $6, closed_at = now()
      WHERE id = $1`,
    [
      orderId,
      rialBigInt(subtotal).toString(),
      rialBigInt(discount).toString(),
      rialBigInt(tax).toString(),
      rialBigInt(total).toString(),
      input.createdBy ?? null,
    ],
  );

  // The payment rows the orders list, the shift reconciliation and the
  // receipt all read — one per slice the cashier actually entered (not
  // however the per-line ledger draw happened to fragment things). The
  // ledger side was already posted by the per-line service, so this records
  // *how* it was collected, not a second posting. The open slice (if any)
  // resolves to the exact remainder now that `total` is known; a slice that
  // ended up contributing nothing (the bounded ones already covered the
  // invoice) is left out rather than recorded as a zero payment.
  // `uq_payments_one_positive_per_order` (migration 0092) keys on
  // `(order_id, settlement_seq)`, not `order_id` alone, precisely so one
  // checkout can write more than one live positive row — each slice of this
  // invoice's settlement is stamped 1..N here, exactly like the café's own
  // split-payment insert in api/orders/[id]/pay/route.ts.
  const resolvedTenders = resolveTenderAmounts(input.tenders, total);
  let settlementSeq = 0;
  for (let i = 0; i < input.tenders.length; i++) {
    const amount = resolvedTenders[i].amount;
    if (rialBigInt(amount) <= 0n) continue;
    const tender = input.tenders[i];
    settlementSeq += 1;
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, payment_method_id, received_by, settlement_seq)
       VALUES ($1, $2, $3::payment_method, $4, $5, $6, $7, $8)`,
      [
        input.locationId,
        orderId,
        // The ledger's SettlementMethod and the payment_method enum overlap on
        // every value the retail screen offers ('cash', 'card', 'credit');
        // 'bank' is the ledger's name for what the till calls a card payment.
        tender.method === "bank" ? "card" : tender.method,
        rialBigInt(amount).toString(),
        tender.reference?.trim() || null,
        tender.paymentMethodId ?? null,
        input.createdBy ?? null,
        settlementSeq,
      ],
    );
  }

  // Phase 27 Wave 5 — a retail sale to a known customer earns loyalty points
  // per the business's default program, in the same transaction, so the
  // invoice and its points can never be half-committed. A business with no
  // program earns nothing.
  if (input.customerId) {
    await earnPoints(client, {
      businessId: input.businessId,
      customerId: input.customerId,
      amountRial: total,
      sourceType: "retail_invoice",
      sourceId: orderId,
      earnedOn: input.businessDate,
      createdBy: input.createdBy ?? null,
    });
  }

  return { orderId, orderNumber, lines, subtotal, discount, tax, total };
}

interface SettledLine {
  itemId: string;
  name: string;
  quantity: string;
  gross: RialText;
  discount: RialText;
  net: RialText;
  vat: RialText;
  total: RialText;
  /** The COGS this line's sale posted, Rial — the commission margin basis. */
  cost?: RialText;
  brandId?: string | null;
  metalValue?: RialText;
  makingCharge?: RialText;
  profit?: RialText;
  batchNumbers?: string[];
  expiryDate?: string | null;
  /**
   * The full sold-line snapshot for `order_items.retail_snapshot` (migration
   * 0174) — everything `getRetailInvoiceDetail`/`getRetailInvoicePrintData`
   * need to reconstruct this exact line months later, without re-reading the
   * item's *current* price, weight, serial or batch state.
   */
  snapshot: RetailInvoiceLineSnapshotStored;
}

/**
 * Evaluate the business's active promotions over the invoice's fungible
 * (accessory/cosmetic) lines and return one discount amount per input line,
 * in input order. The engine is the same pure function the F&B path calls.
 */
async function retailPromotionDiscounts(
  client: PoolClient,
  input: CreateRetailInvoiceInput,
): Promise<{ discounts: number[]; applied: AppliedPromotion[] }> {
  const discounts = input.lines.map(() => 0);
  const promotions = await listPromotions(input.businessId, false, client);
  if (promotions.length === 0) return { discounts, applied: [] };

  const items: PromotionItem[] = [];
  const indexes: number[] = [];
  const itemIds: string[] = [];

  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    if (line.kind !== "accessory" && line.kind !== "cosmetic" && line.kind !== "stocked") continue;
    itemIds.push(line.itemId);
    indexes.push(i);
  }

  if (itemIds.length === 0) return { discounts, applied: [] };

  // Brand is a scope axis (Wave 3), fetched in one round trip.
  const { rows: brandRows } = await client.query<{ item_id: string; brand_id: string | null }>(
    `SELECT id AS item_id, brand_id FROM items WHERE id = ANY($1::uuid[])`,
    [itemIds],
  );
  const brandById = new Map(brandRows.map((r) => [r.item_id, r.brand_id]));

  for (let n = 0; n < indexes.length; n++) {
    const lineIndex = indexes[n];
    const line = input.lines[lineIndex] as Extract<RetailInvoiceLineInput, { kind: "accessory" | "cosmetic" | "stocked" }>;
    const stock = await getStock(line.itemId, client);
    const unitPrice = line.unitPrice ?? stock?.unitPrice ?? 0;
    items.push({
      id: line.itemId,
      brandId: brandById.get(line.itemId) ?? null,
      gross: Math.round(unitPrice * Number(line.quantity)),
      quantity: Number(line.quantity),
    });
  }

  const result = evaluatePromotions(items, promotions, new Date());
  result.lineDiscounts.forEach((amount, itemIndex) => {
    discounts[indexes[itemIndex]] = amount;
  });
  return { discounts, applied: result.applied };
}

/**
 * Hand one line to its industry's existing sell service and normalise what
 * comes back. The three breakdowns name their parts differently (gold splits
 * metal/اجرت/سود, watch and accessories carry a discount) — this is the only
 * place that has to know that.
 */
async function settleLine(
  client: PoolClient,
  input: CreateRetailInvoiceInput,
  line: RetailInvoiceLineInput,
  promotionDiscount: number,
  tenderQueue: RetailTenderQueueEntry[],
): Promise<SettledLine> {
  if (line.kind === "gold") {
    const item = await getItem(line.itemId, client);
    if (!item || item.locationId !== input.locationId) {
      throw new RetailInvoiceError("کالا یافت نشد.");
    }
    const sale = await sellWeightedItem(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      itemId: line.itemId,
      makingCharge: { type: line.makingChargeType, value: line.makingChargeValue },
      profitPercent: line.profitPercent,
      vatPercent: line.vatPercent,
      tenders: tenderQueue,
      createdBy: input.createdBy ?? null,
    });
    const { breakdown, cost } = sale;
    const net = rialText(
      (
        rialBigInt(breakdown.metalValue) +
        rialBigInt(breakdown.makingCharge) +
        rialBigInt(breakdown.profit)
      ).toString(),
    );
    return {
      itemId: line.itemId,
      name: item.name,
      quantity: "1",
      gross: net,
      discount: rialText("0"),
      net,
      vat: breakdown.vat,
      total: breakdown.total,
      cost,
      brandId: item.brandId,
      metalValue: breakdown.metalValue,
      makingCharge: breakdown.makingCharge,
      profit: breakdown.profit,
      snapshot: {
        kind: "gold",
        quantity: "1",
        gross: net,
        manualDiscount: rialText("0"),
        promotionDiscount: rialText("0"),
        discount: rialText("0"),
        vat: breakdown.vat,
        net,
        total: breakdown.total,
        netWeight: sale.netWeight,
        purity: sale.purity,
        pricePerGram: sale.pricePerGram,
        priceDate: sale.priceDate,
        makingChargeType: line.makingChargeType,
        makingChargeValue: line.makingChargeValue,
        profitPercent: line.profitPercent,
        metalValue: breakdown.metalValue,
        makingCharge: breakdown.makingCharge,
        profit: breakdown.profit,
        consigned: sale.consigned,
        ledgerEntryIds: [sale.revenueEntryId, sale.cogsEntryId].filter((id): id is string => id != null),
      },
    };
  }

  if (line.kind === "watch") {
    const { rows } = await client.query<{
      item_id: string;
      serial_number: string;
      name: string;
      brand_id: string | null;
      condition_grade: string | null;
      box_and_papers: boolean;
    }>(
      `SELECT s.item_id, s.serial_number, i.name, i.brand_id, s.condition_grade, s.box_and_papers
         FROM item_serials s JOIN items i ON i.id = s.item_id
        WHERE s.id = $1 AND i.location_id = $2`,
      [line.serialId, input.locationId],
    );
    if (!rows[0]) throw new RetailInvoiceError("دستگاه یافت نشد.");
    const serialRow = rows[0];

    const manualDiscount = line.discount ?? 0;
    const watchSale = await sellSerializedUnit(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      serialId: line.serialId,
      price: line.price,
      discount: manualDiscount + promotionDiscount,
      vatPercent: line.vatPercent,
      tenders: tenderQueue,
      warrantyMonths: line.warrantyMonths,
      createdBy: input.createdBy ?? null,
    });
    const { breakdown, cost, warranty } = watchSale;
    return {
      itemId: serialRow.item_id,
      // The serial is what identifies the unit sold; a reprint has to show it.
      name: `${serialRow.name} — ${serialRow.serial_number}`,
      quantity: "1",
      gross: breakdown.price,
      discount: breakdown.discount,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
      cost,
      brandId: serialRow.brand_id,
      snapshot: {
        kind: "watch",
        quantity: "1",
        unitPrice: rialText(String(line.price)),
        gross: breakdown.price,
        manualDiscount: rialText(String(Math.max(0, Math.round(manualDiscount)))),
        promotionDiscount: rialText(String(Math.max(0, Math.round(promotionDiscount)))),
        discount: breakdown.discount,
        vat: breakdown.vat,
        net: breakdown.net,
        total: breakdown.total,
        serialId: line.serialId,
        serialNumber: serialRow.serial_number,
        warrantyMonths: warranty?.months ?? line.warrantyMonths ?? 0,
        warrantyStartDate: warranty?.startDate ?? null,
        warrantyEndDate: warranty?.endDate ?? null,
        provenance:
          serialRow.condition_grade != null || serialRow.box_and_papers
            ? { conditionGrade: serialRow.condition_grade, boxAndPapers: serialRow.box_and_papers }
            : null,
        ledgerEntryIds: [watchSale.revenueEntryId, watchSale.cogsEntryId].filter(
          (id): id is string => id != null,
        ),
      },
    };
  }

  const item = await getItem(line.itemId, client);
  if (!item || item.locationId !== input.locationId) {
    throw new RetailInvoiceError("کالا یافت نشد.");
  }
  const manualDiscount = line.discount ?? 0;
  const combinedDiscount = manualDiscount + promotionDiscount;

  // Cosmetics and accessories share the same item_stock model, but each sells
  // through its own service so its own posting rules (and accounts) run.
  const cosmeticSale =
    line.kind === "cosmetic"
      ? await sellCosmeticUnits(client, {
          businessId: input.businessId,
          locationId: input.locationId,
          itemId: line.itemId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: combinedDiscount,
          vatPercent: line.vatPercent,
          tenders: tenderQueue,
          createdBy: input.createdBy ?? null,
        })
      : null;

  // The trade-goods industries (wholesale/tools & fittings/haberdashery) share
  // the same item_stock shape but post through their own `{trade}.sale_*`
  // events and accounts, so the line goes to `sellTradeGoodsUnits` rather than
  // the accessory service.
  if (line.kind === "stocked") {
    if (!isTradeGoodsIndustry(input.industry)) {
      throw new RetailInvoiceError("این نوع کالا در این کسب‌وکار قابل فروش نیست.");
    }
    const tradeSale = await sellTradeGoodsUnits(client, {
      trade: input.industry,
      businessId: input.businessId,
      locationId: input.locationId,
      itemId: line.itemId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount: combinedDiscount,
      vatPercent: line.vatPercent,
      tenders: tenderQueue,
      createdBy: input.createdBy ?? null,
    });
    return {
      itemId: line.itemId,
      name: item.name,
      quantity: line.quantity,
      gross: tradeSale.breakdown.gross,
      discount: tradeSale.breakdown.discount,
      net: tradeSale.breakdown.net,
      vat: tradeSale.breakdown.vat,
      total: tradeSale.breakdown.total,
      cost: tradeSale.cost,
      brandId: item.brandId,
      snapshot: {
        kind: "stocked",
        quantity: line.quantity,
        unitPrice: line.unitPrice != null ? rialText(String(Math.round(line.unitPrice))) : null,
        gross: tradeSale.breakdown.gross,
        manualDiscount: rialText(String(Math.max(0, Math.round(manualDiscount)))),
        promotionDiscount: rialText(String(Math.max(0, Math.round(promotionDiscount)))),
        discount: tradeSale.breakdown.discount,
        vat: tradeSale.breakdown.vat,
        net: tradeSale.breakdown.net,
        total: tradeSale.breakdown.total,
        ledgerEntryIds: [tradeSale.revenueEntryId, tradeSale.cogsEntryId].filter(
          (id): id is string => id != null,
        ),
      },
    };
  }

  const sale = cosmeticSale
    ? cosmeticSale
    : await sellAccessoryUnits(client, {
          businessId: input.businessId,
          locationId: input.locationId,
          itemId: line.itemId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: combinedDiscount,
          vatPercent: line.vatPercent,
          tenders: tenderQueue,
          createdBy: input.createdBy ?? null,
        });
  const { breakdown, cost, revenueEntryId, cogsEntryId } = sale;
  const baseSnapshot = {
    quantity: line.quantity,
    unitPrice: line.unitPrice != null ? rialText(String(Math.round(line.unitPrice))) : null,
    gross: breakdown.gross,
    manualDiscount: rialText(String(Math.max(0, Math.round(manualDiscount)))),
    promotionDiscount: rialText(String(Math.max(0, Math.round(promotionDiscount)))),
    discount: breakdown.discount,
    vat: breakdown.vat,
    net: breakdown.net,
    total: breakdown.total,
    ledgerEntryIds: [revenueEntryId, cogsEntryId].filter((id): id is string => id != null),
  } as const;
  return {
    itemId: line.itemId,
    name: item.name,
    quantity: line.quantity,
    gross: breakdown.gross,
    discount: breakdown.discount,
    net: breakdown.net,
    vat: breakdown.vat,
    total: breakdown.total,
    cost,
    brandId: item.brandId,
    batchNumbers: cosmeticSale?.batchNumbers,
    expiryDate: cosmeticSale?.expiryDate,
    snapshot:
      line.kind === "cosmetic"
        ? { kind: "cosmetic", ...baseSnapshot, batchNumbers: cosmeticSale?.batchNumbers ?? [], expiryDate: cosmeticSale?.expiryDate ?? null }
        : { kind: "accessory", ...baseSnapshot },
  };
}
