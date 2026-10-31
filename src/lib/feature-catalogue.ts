/**
 * How the feature catalogue's look-alike keys relate — written down once.
 *
 * `feature_flags` grew in three layers, each with its own naming, and the
 * result is six pairs of keys that read as duplicates:
 *
 *   gate key (the flag a route/page is actually refused on)  ↔  commercial key
 *   `inventory`      (0020)                                  ↔  `accounting.inventory` (0177)
 *   `ledger`         (0020)                                  ↔  `accounting.ledger`    (0177)
 *   `reporting`      (0020)                                  ↔  `accounting.reports`   (0177)
 *   `api_platform`   (0041)                                  ↔  `integrations.api`     (0177)
 *   `ai_assistant`   (0020)                                  ↔  `ai`                   (0153)
 *   `integrations`   (0070)                                  ↔  `website_service`      (0177)
 *
 * Neither side is dead code and none of them can be dropped without breaking a
 * caller: the left key is what `features.ts` gates `/api/*` and the dashboard
 * pages on, the right key is what a plan prices (`billing_plan_features`) or a
 * wallet charge is booked under. What was missing is the statement of how they
 * relate, so an operator reading the console — or an engineer adding a flag —
 * could not tell a legitimate parent/child from a stale copy.
 *
 * Nothing here changes what is enforced. The request gate (`isFeatureEnabled`,
 * `features.ts`) answers for the gate key; the commercial key is reported next to it by
 * the platform's access report so a contradiction is visible instead of
 * silent. Whether a plan's inclusion of the commercial key should *grant* the
 * gate key is a product decision, recorded in the access report rather than
 * guessed here.
 */

export type FeatureRelationKind =
  /** One screen/API family; the commercial key is the plan-facing name of the gate's work area. */
  | "gate_of_commercial"
  /** Access to the assistant is one thing; what a use of it costs is another. */
  | "access_vs_metering"
  /** Two different products that happen to share a vocabulary. They never merge. */
  | "distinct_products";

export interface FeatureRelation {
  /** The key `features.ts` refuses routes and pages on. */
  gateKey: string;
  /** The key a plan prices or a wallet charge is booked under. */
  commercialKey: string;
  kind: FeatureRelationKind;
  /** One line for the operator: what each key is, in Persian. */
  explanation: string;
}

export const FEATURE_RELATIONS: readonly FeatureRelation[] = [
  {
    gateKey: "inventory",
    commercialKey: "accounting.inventory",
    kind: "gate_of_commercial",
    explanation:
      "«inventory» قفل مسیرهای انبار رستوران/کافه است؛ «accounting.inventory» همان قابلیت انبار در بستهٔ پلن حسابداری است (خرده‌فروشی با ماژول stock جدا کار می‌کند).",
  },
  {
    gateKey: "ledger",
    commercialKey: "accounting.ledger",
    kind: "gate_of_commercial",
    explanation:
      "«ledger» قفل مسیرهای دفتر و حسابداری است؛ «accounting.ledger» همان قابلیت در بستهٔ پلن است.",
  },
  {
    gateKey: "reporting",
    commercialKey: "accounting.reports",
    kind: "gate_of_commercial",
    explanation:
      "«reporting» قفل مسیرهای گزارش است؛ «accounting.reports» همان قابلیت در بستهٔ پلن است. تفکیک گزارش پایه و پیشرفته هنوز تصمیم محصولی است.",
  },
  {
    gateKey: "api_platform",
    commercialKey: "integrations.api",
    kind: "gate_of_commercial",
    explanation:
      "«api_platform» کلید API توسعه‌دهنده، وب‌هوک و اتصال MCP را قفل می‌کند (پیش‌فرض خاموش)؛ «integrations.api» نام همین قابلیت در بستهٔ پلن است.",
  },
  {
    gateKey: "ai_assistant",
    commercialKey: "ai",
    kind: "access_vs_metering",
    explanation:
      "«ai_assistant» تعیین می‌کند کسب‌وکار به دستیار دسترسی دارد یا نه (پیش‌فرض خاموش)؛ «ai» کلید اندازه‌گیری و برداشت از کیف پول برای مصرف هوش مصنوعی است.",
  },
  {
    gateKey: "integrations",
    commercialKey: "website_service",
    kind: "distinct_products",
    explanation:
      "«integrations» اتصال فروشگاه ووکامرس/وردپرس است؛ «website_service» هزینهٔ سایت‌ساز بیزامیز از کیف پول است. دو محصول جدا که نباید ادغام شوند.",
  },
];

export function relationForGateKey(gateKey: string): FeatureRelation | null {
  return FEATURE_RELATIONS.find((r) => r.gateKey === gateKey) ?? null;
}

export type RelationStatus =
  /** Both sides agree (both on, or both off). */
  | "consistent"
  /** The gate lets the business in, but its plan does not carry the commercial key. */
  | "gate_on_without_plan_row"
  /** The plan carries the commercial key, but the gate keeps the business out. */
  | "plan_row_without_gate"
  /** The gate is on, the plan prices the commercial key and the business is not entitled to it. */
  | "gate_on_commercial_denied";

export interface RelationSides {
  /** The gate key's effective access (flag layer + commercial layer on that same key). */
  gateEnabled: boolean;
  /** Whether the business's plan has a row for the commercial key. */
  commercialPriced: boolean;
  /** Whether the commercial key's access is currently entitled (meaningful only when priced). */
  commercialEntitled: boolean;
}

/**
 * Classifies one pair for one business. Pure, so the same rule drives the
 * access report and its tests; it never decides access.
 */
export function assessRelation(sides: RelationSides): RelationStatus {
  if (sides.gateEnabled) {
    if (!sides.commercialPriced) return "gate_on_without_plan_row";
    return sides.commercialEntitled ? "consistent" : "gate_on_commercial_denied";
  }
  return sides.commercialPriced && sides.commercialEntitled ? "plan_row_without_gate" : "consistent";
}
