/**
 * Phase 21 Wave 3/4 — selling a specific weighed gold piece, whether the
 * shop owns it or is holding it on consignment (امانی, Wave 4).
 *
 * Orchestrates, in the caller's own transaction (so a sale is always atomic
 * with its postings and status change, same discipline as every ledger
 * posting path): look up the item's weight/cost basis and today's gold
 * price, compute the price breakdown (src/lib/gold-pricing.ts — identical
 * formula either way, per the product owner's confirmed decision), post the
 * sale through the domain-event engine (src/lib/gold-posting-rules.ts —
 * importing it here registers the rules), and mark the piece sold.
 *
 * A consigned item skips the cost-basis requirement and the COGS posting
 * entirely — the shop never owned it, so there's nothing to relieve from
 * inventory, and "profit" becomes the shop's commission instead of margin.
 *
 * DB-touching, so per repo convention (see gold-pricing.ts for the pure
 * formula this leans on) it has no direct unit test; covered instead by
 * integration/gold-sales.integration.test.ts and
 * integration/consignment.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { computeGoldSalePrice, type GoldSalePriceBreakdown, type MakingCharge } from "./gold-pricing";
import type { Purity } from "./gold";
import { getGoldPrice } from "./gold-prices-service";
import { getItem, getWeightAttributes, setWeightItemStatus } from "./items-service";
import { getConsignment } from "./consignment-service";
import { emitDomainEvent } from "./posting-engine";
import type { RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
import { resolveLineTenders, type RetailTender, type RetailTenderQueueEntry } from "./retail-tenders";
// Side-effect import registers the gold.* posting rules; goldSoldCost is the
// shared cost-basis helper the COGS rule and the commission margin basis both use.
import { goldSoldCost } from "./gold-posting-rules";
import "./gold-posting-rules";

export interface SellWeightedItemInput {
  businessId: string;
  locationId: string;
  itemId: string;
  makingCharge: MakingCharge;
  profitPercent: number;
  vatPercent: number;
  /** The whole piece paid one way — every pre-split caller (the jewelry quick-sell panel). */
  paymentMethod?: SettlementMethod;
  /** A retail invoice's shared tender queue (retail-tenders.ts) — mutually exclusive with `paymentMethod`. */
  tenders?: RetailTenderQueueEntry[];
  createdBy?: string | null;
  /** Defaults to today — the gold-price lookup date, in case a sale is backdated. */
  priceDate?: string;
}

export interface SellWeightedItemResult {
  breakdown: GoldSalePriceBreakdown;
  revenueEntryId: string | null;
  cogsEntryId: string | null;
  /** Whether this sale posted as a consignment (امانی) settlement rather than an owned-inventory sale. */
  consigned: boolean;
  /** The COGS this sale posted (metal + stones), Rial; 0 for a consignment, which has none. */
  cost: RialText;
  /**
   * The exact weight/purity/rate this sale priced against — returned so a
   * caller building a permanent invoice snapshot (retail-invoice-service.ts)
   * never has to re-read today's item/price rows to reconstruct an old sale.
   * A reprint next month must show the rate that was charged, not whatever
   * the item or the gold-price table says now.
   */
  netWeight: string;
  purity: Purity;
  pricePerGram: number;
  priceDate: string;
}

export async function sellWeightedItem(
  client: PoolClient,
  input: SellWeightedItemInput,
): Promise<SellWeightedItemResult> {
  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» را می‌توان با این روش فروخت.");
  }

  const weightAttrs = await getWeightAttributes(input.itemId);
  if (!weightAttrs) throw new Error("ویژگی وزن/عیار برای این کالا ثبت نشده است.");
  if (weightAttrs.status !== "in_stock") {
    throw new Error("این کالا در انبار موجود نیست (رزرو شده یا قبلاً فروخته شده است).");
  }

  const consignment = await getConsignment(input.itemId);
  if (!consignment && !weightAttrs.unitCostPerGram) {
    throw new Error("بهای تمام‌شده این کالا ثبت نشده است؛ ابتدا آن را ثبت کنید.");
  }

  const price = await getGoldPrice(input.businessId, weightAttrs.purity, input.priceDate);
  if (!price) throw new Error(`قیمت طلای عیار ${weightAttrs.purity} برای امروز ثبت نشده است.`);

  const breakdown = computeGoldSalePrice({
    netWeight: weightAttrs.netWeight,
    pricePerGram: price.pricePerGram,
    makingCharge: input.makingCharge,
    profitPercent: input.profitPercent,
    vatPercent: input.vatPercent,
  });

  // A consigned piece has no owned COGS; an owned piece's cost is the same
  // metal + stone basis the COGS posting rule uses (goldSoldCost).
  const cost: RialText = consignment
    ? ("0" as RialText)
    : await goldSoldCost(client, {
        itemId: input.itemId,
        netWeight: weightAttrs.netWeight,
        unitCostPerGram: weightAttrs.unitCostPerGram ?? "0",
      });

  const lineTenders: RetailTender[] = resolveLineTenders(input, breakdown.total);

  let revenueEntryId: string | null;
  let cogsEntryId: string | null = null;

  if (consignment) {
    ({ entryId: revenueEntryId } = await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "gold.consignment_sale_revenue",
      payload: {
        itemId: input.itemId,
        metalValue: breakdown.metalValue,
        makingCharge: breakdown.makingCharge,
        profit: breakdown.profit,
        vat: breakdown.vat,
        total: breakdown.total,
        tenders: lineTenders,
      },
      sourceType: "gold_consignment_sale",
      sourceId: input.itemId,
      createdBy: input.createdBy ?? null,
    }));
  } else {
    const makingChargePlusProfit = (
      BigInt(breakdown.makingCharge) + BigInt(breakdown.profit)
    ).toString() as RialText;

    ({ entryId: revenueEntryId } = await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "gold.sale_revenue",
      payload: {
        itemId: input.itemId,
        metalValue: breakdown.metalValue,
        makingChargePlusProfit,
        vat: breakdown.vat,
        total: breakdown.total,
        tenders: lineTenders,
      },
      sourceType: "gold_sale",
      sourceId: input.itemId,
      createdBy: input.createdBy ?? null,
    }));

    ({ entryId: cogsEntryId } = await emitDomainEvent(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      eventType: "gold.sale_cogs",
      payload: {
        itemId: input.itemId,
        netWeight: weightAttrs.netWeight,
        unitCostPerGram: weightAttrs.unitCostPerGram,
      },
      sourceType: "gold_sale",
      sourceId: input.itemId,
      createdBy: input.createdBy ?? null,
    }));
  }

  await setWeightItemStatus(input.itemId, "sold", client);

  return {
    breakdown,
    revenueEntryId,
    cogsEntryId,
    consigned: Boolean(consignment),
    cost,
    netWeight: weightAttrs.netWeight,
    purity: weightAttrs.purity,
    pricePerGram: price.pricePerGram,
    priceDate: price.priceDate,
  };
}
