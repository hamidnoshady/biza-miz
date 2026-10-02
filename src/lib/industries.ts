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
