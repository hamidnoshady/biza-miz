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
  // Issue #839 — the automotive trade: car dealerships and vehicle traders,
  // new and used. One business type covers both, because "new or used" is a
  // property of each *vehicle* (`automotive_vehicle_attributes.condition`),
  // never of the business: a dealer sells both off one lot.
  //
  // It belongs to the `retail` family (below): a car is a priced good sold
  // from `items`/`item_stock` with a retail invoice, exactly like a watch — it
  // is simply a unit whose identity is a chassis plate rather than a serial
  // number, which is what the automotive module adds on top. Nothing here is
  // restaurant-shaped, and the profile grants no F&B module.
  "automotive",
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
  // The English label (used wherever a Latin name is wanted) is
  // "Automotive / Car Dealership".
  automotive: "خودرو و نمایشگاه اتومبیل",
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
 *   * `retail` — a priced goods catalogue in `items`/`item_stock` (the eight
 *     trades below: the jeweller's and watchmaker's own managers, the four
 *     product-workspace trades, the three trade-goods industries, and the
 *     automotive trade, whose units are tracked individually);
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
 *
 * Issue #839 adds `automotive` for the same reason jewellery and watch are
 * here: a dealership sells a priced good — one row per physical car, a retail
 * invoice at the counter, stock in `items`/`item_stock` — and its manager is
 * its own screen rather than the products workspace's variant board.
 */
export const RETAIL_CATALOGUE_INDUSTRIES = [
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
  "automotive",
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

/**
 * What an operator must be told before changing a business's industry, beyond
 * the row counts the console already shows.
 *
 * The counts answer "how much data belongs to the old trade". They cannot
 * answer the two questions §2 of issue #839 is about, because both are facts
 * about *meaning* rather than volume, and a switch that silently changes what a
 * row means is the failure this exists to prevent:
 *
 *   * **Stock is not portable between trades.** A jeweller's `items` rows are
 *     weighed pieces, a wholesaler's are quantity lines, and a dealership's are
 *     make/model/trim entries with a serial per physical car. The automotive
 *     manager lists vehicles from the vehicle-attribute table, never "every
 *     item", so an ex-jewellery business's stock does *not* appear as cars —
 *     but it also cannot be *sold* as cars, and someone looking at the old
 *     rows through the new trade's screens must be told that rather than left
 *     to infer it. The reverse switch has the same shape: a car is a serialized
 *     unit, not a weighed piece or a menu item.
 *   * **The old trade's operational data stays unreachable.** That is the
 *     console's existing message; what is new here is naming the automotive
 *     case, where the warehouse of unsold cars is the business's largest asset
 *     and the operator should hear it before, not after.
 *
 * The function is pure and lives beside the registry so the console, the API
 * and the tests read one list instead of three screens inventing their own
 * copy. Empty array = nothing trade-specific to add; the console still shows
 * the generic data warning.
 */
export function industrySwitchCautions(
  from: Industry | string | null | undefined,
  to: Industry | string | null | undefined,
): string[] {
  if (!from || !to || from === to) return [];
  if (!isIndustry(from) || !isIndustry(to)) return [];

  const cautions: string[] = [];
  const fromSellsCatalogue = hasSellableCatalogue(from);
  const toSellsCatalogue = hasSellableCatalogue(to);

  if (to === "automotive") {
    cautions.push(
      "فهرست خودروها فقط خودروهایی را نشان می‌دهد که در همین کسب‌وکار به‌عنوان خودرو ثبت شده‌اند؛ " +
        "کالاها و موجودی نوع فعلی به‌طور خودکار خودرو در نظر گرفته نمی‌شوند و برای فروش خودرو قابل استفاده نیستند.",
    );
    if (fromSellsCatalogue) {
      cautions.push(
        "کالاهای فروشنی نوع فعلی در انبار خودرو دیده نمی‌شوند؛ برای ادامهٔ فروش آن‌ها، پیش از تغییر نوع " +
          "موجودی را تعیین تکلیف کنید.",
      );
    }
  } else if (from === "automotive" && toSellsCatalogue) {
    cautions.push(
      "خودروهای ثبت‌شده در فهرست کالای نوع جدید نمایش داده نمی‌شوند؛ موجودی خودرو، بهای تمام‌شده و " +
        "سوابق فروش خودرو دست‌نخورده باقی می‌ماند اما از داشبورد جدید در دسترس نیست.",
    );
  } else if (from === "automotive") {
    cautions.push(
      "موجودی خودرو، بهای تمام‌شده و سوابق فروش خودرو حذف نمی‌شود، اما از داشبورد نوع جدید در دسترس نیست.",
    );
  }

  return cautions;
}
