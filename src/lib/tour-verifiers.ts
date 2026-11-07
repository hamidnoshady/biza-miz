/**
 * Verified business actions (issue #972, phase 2) — the whitelist.
 *
 * A tour step may ask the member to do something real ("ثبت کنید", "ذخیره
 * کنید"). Such a step is `kind: "action"` and names ONE key from this registry.
 * The step is completed only when the server finds *evidence* that the action
 * succeeded — a row `tour_action_evidence` wrote when the real domain endpoint
 * returned success (migration 0289). There is deliberately no way for a client
 * to claim it:
 *
 *  - the browser can send `{ stepId }` to `POST …/verify`, and the server looks
 *    the evidence up; it never trusts a "done" flag from the page;
 *  - evidence is written by the domain service that actually performed the
 *    write (`product-creation-service` via `POST /api/products/items`,
 *    `createParty`, `createOrder`), in the same request as the write itself, so
 *    a failed save leaves no evidence;
 *  - nothing here stores what was created: only the verifier key, the member,
 *    the business and an opaque entity id, never a customer's or an order's
 *    payload.
 *
 * Adding a verifier is a deliberate act: the key must be wired to a success
 * point that a reviewer can point at, and the step copy must describe exactly
 * that action. A key with no writer would silently make a tour unfinishable,
 * which is why `TOUR_VERIFIER_KEYS` is the single source the tour validator,
 * the console's picker and the tests all read.
 *
 * Client-safe: no database, no React.
 */

export interface TourVerifierDefinition {
  /** What the member must do — the console's picker and the step hint use it. */
  readonly label: string;
  /** One sentence for the overlay: when the server will confirm this step. */
  readonly promise: string;
  /** The endpoint whose success records evidence, for review and for the docs. */
  readonly recordedBy: string;
}

export const TOUR_VERIFIERS = {
  "product.created": {
    label: "ثبت یک کالای تازه",
    promise: "وقتی ثبت کالا در سرور انجام شود، این مرحله خودکار تأیید می‌شود.",
    recordedBy: "POST /api/products/items",
  },
  "party.created": {
    label: "ثبت یک مشتری یا تأمین‌کننده",
    promise: "وقتی طرف حساب در سرور ثبت شود، این مرحله خودکار تأیید می‌شود.",
    recordedBy: "POST /api/parties",
  },
  "order.created": {
    label: "ثبت یک سفارش",
    promise: "وقتی سفارش در سرور ثبت شود، این مرحله خودکار تأیید می‌شود.",
    recordedBy: "POST /api/orders",
  },
} as const satisfies Record<string, TourVerifierDefinition>;

/** The keys a tour step may name. */
export type TourVerifier = keyof typeof TOUR_VERIFIERS;

export const TOUR_VERIFIER_KEYS = Object.keys(TOUR_VERIFIERS) as TourVerifier[];

const KNOWN = new Set<string>(TOUR_VERIFIER_KEYS);

export function isTourVerifier(value: unknown): value is TourVerifier {
  return typeof value === "string" && KNOWN.has(value);
}

/** The human sentence for a step, or null when the key is not registered. */
export function tourVerifierDefinition(value: unknown): TourVerifierDefinition | null {
  return isTourVerifier(value) ? TOUR_VERIFIERS[value] : null;
}
