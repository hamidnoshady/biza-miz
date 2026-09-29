/**
 * The business-billing `include=` contract, in one place (issue #755 §17).
 *
 * This module exists because the contract was written twice — once as the set of
 * keys the route accepts, once as the per-tab lists the page sends — and the two
 * disagreed from the first commit: the page prepended `business`, which the
 * route did not accept, so *every* tab load answered `400 invalid_include` and
 * the page sat on its loading state. Nothing caught it, because the route's own
 * tests call the handler directly and the page's behaviour is a fetch it has no
 * harness for.
 *
 * So the keys, the tab mapping and the one always-present section live here, and
 * both sides import them. `platform-billing-includes.test.ts` asserts the
 * mapping is valid against the accepted set, which is the assertion that would
 * have failed on the broken version.
 */

/** Sections a caller may name. Everything else is `invalid_include`. */
export const BILLING_INCLUDE_KEYS = [
  "subscription",
  "wallet",
  "ledger",
  "payments",
  "invoices",
  "usage",
  "ai",
  "overrides",
] as const;

export type BillingIncludeKey = (typeof BILLING_INCLUDE_KEYS)[number];

/**
 * The business's own identity — name, plan, id.
 *
 * Always returned, and *naming it is not an error*: every tab needs it to title
 * itself, so a caller that lists it alongside the section it wants is being
 * perfectly reasonable. It is the one key that is neither gated by `include` nor
 * refused by it.
 */
export const BILLING_ALWAYS_INCLUDED = "business";

/** Every value `?include=` may contain without a refusal. */
export function isBillingIncludeKey(value: string): value is BillingIncludeKey {
  return (BILLING_INCLUDE_KEYS as readonly string[]).includes(value);
}

/**
 * What each tab of the business Billing page needs.
 *
 * The point of the split: opening Invoices must not also compute the wallet, the
 * ledger, usage, media and the subscription total.
 */
export const BILLING_TAB_INCLUDES: Record<string, BillingIncludeKey[]> = {
  subscription: ["subscription", "overrides"],
  wallet: ["wallet", "ledger", "payments", "ai"],
  invoices: ["invoices"],
  usage: ["usage", "ai"],
};

/**
 * The response keys a tab renders before it may draw anything.
 *
 * Not the same as the include keys: `subscription` includes `recurring` and
 * `entitlements` too, and `usage` includes `media` and `messaging`. A tab that
 * rendered as soon as its *include* resolved would flash a subscription card
 * with no price on it.
 */
export const BILLING_TAB_READY_KEYS: Record<string, string[]> = {
  subscription: ["subscription", "recurring", "entitlements", "overrides"],
  wallet: ["wallet", "ledger", "payments", "ai"],
  invoices: ["invoices"],
  usage: ["usage", "media", "messaging", "ai"],
};
