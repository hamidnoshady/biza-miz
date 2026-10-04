/**
 * Phase 21 Wave 1 — the industry a business operates in.
 *
 * Framework-free (no db/bcrypt imports) so both server code
 * (business-provisioning.ts) and client UI (the /welcome bootstrap form) can
 * import it directly. Chosen exactly once at business creation and never
 * exposed for update afterwards — see
 * migrations/0048_business_industry.sql's doc comment for why this needs no
 * separate lock step the way inventory costing does.
 */

export const INDUSTRIES = [
  "food_service",
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
  "service_saas",
  // Issue #799 — the AEC industry. One business type covers architecture
  // offices, civil/structural engineering companies, contractors, design &
  // build firms, consulting/supervision teams and individual professionals;
  // which of those a business actually is, is an *operating profile* it picks
  // inside the industry (see industry-profile.ts), never a second industry
  // key. Nothing here is restaurant- or retail-shaped: the profile grants the
  // core platform modules and deliberately withholds `pos`, `orders`, `stock`
  // and every F&B module, so the trade cannot inherit café UI by accident.
  "architecture_construction",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** Which industries the setup UI actually offers a new business, vs. reserved for a later wave. */
export const ENABLED_INDUSTRIES: Industry[] = [...INDUSTRIES];

export const INDUSTRY_LABELS: Record<Industry, string> = {
  food_service: "کافه و رستوران",
  jewelry: "طلا و جواهر",
  watch: "ساعت",
  accessories: "بدلیجات",
  cosmetics: "آرایشی و بهداشتی",
  wholesale: "عمده‌فروشی",
  tools_fittings: "ابزار و یراق‌آلات",
  haberdashery: "خرازی",
  service_saas: "خدمات و نرم‌افزار (SaaS)",
  // The English label (used wherever a Latin name is wanted) is
  // "Architecture, Civil Engineering & Construction".
  architecture_construction: "مهندسی عمران، معماری و پیمانکاری",
};

export function isIndustry(value: string): value is Industry {
  return (INDUSTRIES as readonly string[]).includes(value);
}

/* ===========================================================================
 * Industry families — the axis the shared engines branch on
 * ===========================================================================
 *
 * The engines that predate this registry (website product sync, the storefront
 * order ingest, the webhook ingest, the outbound push) were written when there
 * were exactly two shapes: F&B and "retail". They branched on
 * `industry !== "food_service"`, which was true for every trade then and is
 * false now — an architecture practice, or a future service business, has no
 * `items` row and no `menu_items` row for a web-store product to map onto, and
 * writing one anyway is how a construction office ends up with a retail
 * catalogue it never asked for.
 *
 * So the branch is no longer "F&B or not". It is the *family* an industry
 * belongs to, and each site names the family it can actually serve:
 *
 *   * `food_service` — one sellable row per menu item, recipe-based stock;
 *   * `retail` — a priced goods catalogue in `items`/`item_stock` (the seven
 *     trades below: the jeweller's and watchmaker's own managers, the four
 *     product-workspace trades, and the three trade-goods industries);
 *   * `project_based` — work sold as projects and contracts; no sellable
 *     catalogue, so a web-store product is *skipped* and a web-store order is
 *     refused with a reason rather than imported as a retail sale;
 *   * `service` — the SaaS/service trade, same rule for the same reason.
 */

/**
 * The trades whose catalogue is `items` + `item_stock`.
 *
 * Deliberately its own set rather than `PRODUCT_WORKSPACE_INDUSTRIES ∪
 * TRADE_GOODS_INDUSTRIES`: jewellery and watch keep their own managers over the
 * same two tables, and importing a UI registry into an engine that runs on
 * every webhook would invert the dependency. `industry-coverage.test.ts`
 * asserts this set covers both of those registries, so the three lists cannot
 * drift apart silently.
 */
export const RETAIL_CATALOGUE_INDUSTRIES = [
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
] as const;
export type RetailCatalogueIndustry = (typeof RETAIL_CATALOGUE_INDUSTRIES)[number];

export function isRetailCatalogueIndustry(
  value: Industry | string | null | undefined,
): value is RetailCatalogueIndustry {
  return value !== null && value !== undefined && (RETAIL_CATALOGUE_INDUSTRIES as readonly string[]).includes(value);
}

/** The four shapes the shared engines need to tell apart. */
export type IndustryFamily = "food_service" | "retail" | "project_based" | "service";

export function industryFamily(industry: Industry | string | null | undefined): IndustryFamily | null {
  if (!industry || !isIndustry(industry)) return null;
  if (industry === "food_service") return "food_service";
  if (isRetailCatalogueIndustry(industry)) return "retail";
  if (industry === "architecture_construction") return "project_based";
  return "service";
}

/**
 * Whether a web-store product has a local sellable row to land on at all.
 *
 * `false` does not mean "broken": it means the business's site is a shopfront
 * for something this product does not sell (work, not goods), so product sync
 * skips and an order ingest refuses with a named reason instead of guessing.
 */
export function hasSellableCatalogue(industry: Industry | string | null | undefined): boolean {
  const family = industryFamily(industry);
  return family === "food_service" || family === "retail";
}

/** The reason recorded when a storefront tries to sell to a non-storefront trade. */
export const INDUSTRY_NOT_STOREFRONT = "industry_not_storefront";
