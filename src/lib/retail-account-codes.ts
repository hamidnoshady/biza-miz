/**
 * Issue #770 — the retail trades' ledger accounts, in one place.
 *
 * Both website adapters (WooCommerce order/refund ingest and the Eshobe CMS
 * store-order import) need to know which revenue/COGS/inventory accounts a
 * given non-F&B industry posts to. They each used to carry their own copy of
 * this map — which is precisely the kind of business rule an adapter must not
 * own, and a copy that can silently drift from the counter's own posting rules
 * (`retail-stock-posting-rules.ts`, `cosmetics-posting-rules.ts`).
 *
 * One map, imported by every adapter; the counter paths keep resolving their
 * own accounts through their posting rules.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import type { Industry } from "./industries";

export interface RetailAccountCodes {
  revenue: string;
  cogs: string;
  inventory: string;
}

export const RETAIL_ACCOUNT_CODES: Record<Exclude<Industry, "food_service">, RetailAccountCodes> = {
  service_saas: { revenue: "4500", cogs: "5670", inventory: "1400" },
  jewelry: {
    revenue: WELL_KNOWN_CODES.goldSalesRevenue,
    cogs: WELL_KNOWN_CODES.goldCogs,
    inventory: WELL_KNOWN_CODES.goldInventory,
  },
  watch: {
    revenue: WELL_KNOWN_CODES.watchSalesRevenue,
    cogs: WELL_KNOWN_CODES.watchCogs,
    inventory: WELL_KNOWN_CODES.watchInventory,
  },
  accessories: {
    revenue: WELL_KNOWN_CODES.accessorySalesRevenue,
    cogs: WELL_KNOWN_CODES.accessoryCogs,
    inventory: WELL_KNOWN_CODES.accessoryInventory,
  },
  cosmetics: {
    revenue: WELL_KNOWN_CODES.cosmeticSalesRevenue,
    cogs: WELL_KNOWN_CODES.cosmeticCogs,
    inventory: WELL_KNOWN_CODES.cosmeticInventory,
  },
  wholesale: {
    revenue: WELL_KNOWN_CODES.wholesaleSalesRevenue,
    cogs: WELL_KNOWN_CODES.wholesaleCogs,
    inventory: WELL_KNOWN_CODES.wholesaleInventory,
  },
  tools_fittings: {
    revenue: WELL_KNOWN_CODES.toolsSalesRevenue,
    cogs: WELL_KNOWN_CODES.toolsCogs,
    inventory: WELL_KNOWN_CODES.toolsInventory,
  },
  haberdashery: {
    revenue: WELL_KNOWN_CODES.haberdasherySalesRevenue,
    cogs: WELL_KNOWN_CODES.haberdasheryCogs,
    inventory: WELL_KNOWN_CODES.haberdasheryInventory,
  },
  // Issue #799 — an AEC business's website sells services, not stock: an online
  // order lands in the design/engineering revenue account, its direct cost in
  // project cost, and any material it consumes against the generic inventory
  // account. Every code exists in the trade's chart (coa-template.ts). The two
  // ingest paths refuse an order for a trade with no sellable catalogue, so this
  // entry is the *service* order shape, for the day such a trade sells online.
  architecture_construction: {
    revenue: WELL_KNOWN_CODES.aecDesignRevenue,
    cogs: WELL_KNOWN_CODES.aecProjectDirectCost,
    inventory: WELL_KNOWN_CODES.inventory,
  },
  // Issue #839 — a dealership's website lists cars, so an online order lands in
  // the vehicle revenue account and relieves vehicle inventory; its COGS is the
  // vehicle's own frozen effective cost, which the ingest path resolves from
  // the unit exactly as the counter does. Every code exists in the trade's
  // chart (coa-template.ts).
  automotive: {
    revenue: WELL_KNOWN_CODES.vehicleSalesRevenue,
    cogs: WELL_KNOWN_CODES.vehicleCogs,
    inventory: WELL_KNOWN_CODES.vehicleInventory,
  },
};
