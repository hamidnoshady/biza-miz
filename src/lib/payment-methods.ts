/**
 * Payment ways, and splitting one bill across several of them.
 *
 * Framework-free half of migration 0091: what the built-in ways are, what a
 * business may change about a way it adds, and — the part with teeth — whether
 * a set of tenders actually pays a bill.
 *
 * The distinction the whole feature rests on:
 *
 *   * a **payment way** (`payment_methods` row) is the business's own thing —
 *     its name, its position in the cashier's grid, whether it is still
 *     offered;
 *   * a **settlement** is the ledger's thing — which account the money lands
 *     in. A business can name a way anything, but it must say which of the
 *     five settlements it behaves like, because that is what
 *     `postExactOrderPaymentEntry` posts against.
 *
 * Everything here is integer Rial (src/lib/money.ts) and free of the database.
 */
import type { Rial } from "./money";

/**
 * The settlement classes — the `payment_method` enum, which is also the set of
 * debit accounts the order-payment posting knows how to reach.
 */
export const PAYMENT_SETTLEMENTS = ["cash", "card", "card_to_card", "online", "credit", "cheque", "snappfood"] as const;

export type PaymentSettlement = (typeof PAYMENT_SETTLEMENTS)[number];

export function isPaymentSettlement(value: unknown): value is PaymentSettlement {
  return typeof value === "string" && (PAYMENT_SETTLEMENTS as readonly string[]).includes(value);
}

/**
 * The settlements a business may pick for a way it adds itself.
 *
 * `snappfood` is missing on purpose: it carries the commission arithmetic
 * driven by one business-wide contract percentage (issue #160 §4), so a second
 * way settling as SnapFood would silently claim the same contract's rate. The
 * built-in stays; nobody gets to mint another.
 *
 * `cheque` is missing for a different reason (Phase 30). A cheque is not a
 * tender the till can take: it has a serial, a bank, a due date and a life of
 * its own, and settling a bill with one would leave چک‌های نزد صندوق holding a
 * balance no register could explain — and the bill's total sitting in a shift's
 * `gross_total` with no method bucket accounting for it. A cheque is recorded in
 * the register instead (`/accounting/cheques`), where it settles the
 * customer's or supplier's account; the settlement class exists so the ledger
 * knows which account that is, not so a checkout can offer it.
 */
export const CUSTOM_PAYMENT_SETTLEMENTS = PAYMENT_SETTLEMENTS.filter(
  (method) => method !== "snappfood" && method !== "cheque",
) as readonly PaymentSettlement[];

export interface PaymentMethodDefaults {
  code: string;
  name: string;
  settlement: PaymentSettlement;
  sortOrder: number;
  opensDrawer: boolean;
  /** Only true for F&B — SnapFood needs a chart of accounts a jeweller doesn't have. */
  foodServiceOnly?: boolean;
}

/**
 * The ways every business starts with, in the order a till is reached for.
 * Mirrors the seed in migration 0091 — the two must agree, since a business
 * provisioned after that migration is seeded from here.
 */
export const BUILTIN_PAYMENT_METHODS: readonly PaymentMethodDefaults[] = [
  { code: "cash", name: "نقدی", settlement: "cash", sortOrder: 10, opensDrawer: true },
  { code: "card", name: "کارت‌خوان", settlement: "card", sortOrder: 20, opensDrawer: false },
  { code: "card_to_card", name: "کارت‌به‌کارت", settlement: "card_to_card", sortOrder: 30, opensDrawer: false },
  { code: "online", name: "پرداخت آنلاین", settlement: "online", sortOrder: 40, opensDrawer: false },
  { code: "credit", name: "نسیه", settlement: "credit", sortOrder: 50, opensDrawer: false },
  {
    code: "snappfood",
    name: "اسنپ‌فود",
    settlement: "snappfood",
    sortOrder: 60,
    opensDrawer: false,
    foodServiceOnly: true,
  },
];

export function builtinPaymentMethodsFor(industry: string): PaymentMethodDefaults[] {
  if (industry === "architecture_construction") {
    return BUILTIN_PAYMENT_METHODS.filter((method) => ["cash", "card", "card_to_card"].includes(method.code));
  }
  return BUILTIN_PAYMENT_METHODS.filter((method) => !method.foodServiceOnly || industry === "food_service");
}

/**
 * A way's settlement in the *ledger's* vocabulary (`SettlementMethod` in
 * ledger.ts: cash / bank / credit), for the retail sale paths that post
 * through the domain-event engine rather than through an order payment.
 *
 * Those paths settle a sale one way and know three destinations, so this is a
 * narrowing, not a translation: everything card-shaped is "bank" to them.
 * Returns null for a way that cannot settle an invoice: SnapFood, which only a
 * food-service business has an account for and which never reaches a retail
 * invoice, and `cheque`, which is recorded in the register instead of at a
 * checkout (see CUSTOM_PAYMENT_SETTLEMENTS above).
 */
export function ledgerSettlementFor(settlement: PaymentSettlement): "cash" | "bank" | "credit" | null {
  switch (settlement) {
    case "cash":
      return "cash";
    case "card":
    case "card_to_card":
    case "online":
      return "bank";
    case "credit":
      return "credit";
    // A cheque is not a tender: it is recorded in the register, where it
    // settles the account rather than the invoice. Returning null keeps it out
    // of the invoice screen's way picker — the same thing this already does for
    // SnapFood — rather than posting it as cash, bank or credit, none of which
    // it is.
    case "cheque":
    case "snappfood":
      return null;
  }
}

/** A payment way as every screen sees it. */
export interface PaymentMethodView {
  id: string;
  code: string;
  name: string;
  settlement: PaymentSettlement;
  sortOrder: number;
  isActive: boolean;
  isBuiltin: boolean;
  opensDrawer: boolean;
  requiresReference: boolean;
}

/**
 * The order the ways are shown in, everywhere: `sort_order` ascending, then by
 * name so two ways sharing a position don't swap places between renders.
 */
export function sortPaymentMethods<T extends { sortOrder: number; name: string }>(methods: T[]): T[] {
  return [...methods].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fa"));
}

/**
 * Reordering is an all-or-nothing operation. Accepting a subset, a duplicate,
 * or an id from another business leaves tied sort positions and makes the till
 * order unpredictable, so the API and service both use this exact-set check.
 */
export function isExactPaymentMethodOrder(currentIds: readonly string[], orderedIds: readonly string[]): boolean {
  if (currentIds.length !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length) return false;
  const current = new Set(currentIds);
  return orderedIds.every((id) => current.has(id));
}

export const MAX_PAYMENT_METHOD_NAME = 40;

/**
 * A code for a way the business just named.
 *
 * Persian names transliterate badly, so this doesn't try: a name that happens
 * to be ASCII gets a readable slug, anything else gets `custom_N`. The code is
 * an internal handle (uniqueness, the API's addressing) and is never shown, so
 * an opaque one costs nothing.
 */
export function paymentMethodCodeFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "custom";
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`.slice(0, 32);
    if (!used.has(candidate)) return candidate;
  }
}

export interface PaymentMethodInput {
  name?: unknown;
  settlement?: unknown;
  opensDrawer?: unknown;
  requiresReference?: unknown;
}

export interface ValidatedPaymentMethod {
  name: string;
  settlement: PaymentSettlement;
  opensDrawer: boolean;
  requiresReference: boolean;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates the body of "add a payment way". Error codes are the API's. */
export function validatePaymentMethodInput(input: PaymentMethodInput): ValidationResult<ValidatedPaymentMethod> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_PAYMENT_METHOD_NAME) return { ok: false, error: "invalid_name" };
  if (!isPaymentSettlement(input.settlement) || !CUSTOM_PAYMENT_SETTLEMENTS.includes(input.settlement)) {
    return { ok: false, error: "invalid_settlement" };
  }
  if (input.opensDrawer !== undefined && typeof input.opensDrawer !== "boolean") {
    return { ok: false, error: "bad_request" };
  }
  if (input.requiresReference !== undefined && typeof input.requiresReference !== "boolean") {
    return { ok: false, error: "bad_request" };
  }
  return {
    ok: true,
    value: {
      name,
      settlement: input.settlement,
      // A way a business models on cash defaults to behaving like cash at the
      // drawer and the cash-up, which is what it is for.
      opensDrawer: input.opensDrawer === undefined ? input.settlement === "cash" : input.opensDrawer,
      requiresReference: input.requiresReference ?? false,
    },
  };
}

/** One slice of a split payment, as a checkout screen sends it. */
export interface TenderInput {
  /** `payment_methods.id`; absent only on the legacy single-method body. */
  methodId?: string | null;
  /** The settlement the way resolves to — filled in server-side from `methodId`. */
  settlement?: PaymentSettlement;
  /**
   * What this slice takes, or absent for "whatever is left".
   *
   * At most one slice may leave it open, and it is how the ordinary sale is
   * expressed: one way, no amount typed, take the bill. On a split it is the
   * last slice — «۲۰۰٬۰۰۰ نقدی، بقیه با کارت» is literally that sentence — and
   * it is what keeps a checkout honest when the screen's idea of the total is
   * a little behind the server's (a promotion the till has not re-evaluated,
   * say): the difference lands on the open slice instead of failing the sale
   * with a total the cashier cannot reconcile.
   */
  amount?: Rial;
  reference?: string | null;
}

export interface ResolvedTender {
  methodId: string | null;
  settlement: PaymentSettlement;
  amount: Rial;
  reference: string | null;
}

/** How much a set of tenders comes to. */
export function tenderTotal(tenders: readonly { amount: Rial }[]): Rial {
  return tenders.reduce((sum, tender) => sum + tender.amount, 0);
}

/** What is still owed after these tenders — negative once they overshoot. */
export function remainingAfterTenders(tenders: readonly { amount: Rial }[], due: Rial): Rial {
  return due - tenderTotal(tenders);
}

/**
 * The change owed back on a cash-heavy split: whatever the customer handed
 * over beyond the bill, but only up to the cash in the split — a card is never
 * over-swiped, so an overshoot that isn't cash is a mistake, not change.
 */
export function changeDue(tenders: readonly { settlement: PaymentSettlement; amount: Rial }[], due: Rial): Rial {
  const overshoot = tenderTotal(tenders) - due;
  if (overshoot <= 0) return 0;
  const cash = tenderTotal(tenders.filter((tender) => tender.settlement === "cash"));
  return Math.min(overshoot, cash);
}

/** At most this many slices on one bill — a guard against a runaway client, not a business rule. */
export const MAX_TENDERS = 10;

/**
 * The part of a split bill an ordering platform charges commission on.
 *
 * Checkout and imported-sale tender lists contain the bill only. Tips are
 * stored separately on the order and added later by `tendersWithTip` for the
 * ledger, so summing the SnapFood tender here keeps the tip out of the
 * commission base by construction.
 */
export function platformCommissionBase(
  tenders: readonly { settlement: PaymentSettlement; amount: Rial }[],
): Rial {
  return tenders.reduce(
    (total, tender) => (tender.settlement === "snappfood" ? total + tender.amount : total),
    0,
  );
}

export interface TenderValidationOptions {
  /** The bill amount; tips are stored separately and folded into the ledger later. */
  due: Rial;
  /** Whether a customer was named — a `credit` tender is a debt, so it needs one. */
  hasCustomer: boolean;
  /**
   * Whether the tenders may settle the bill *with a difference* rather than
   * exactly (the manual «مبلغ دریافتی» flow): less than the bill leaves the
   * remainder as customer debt (accounts receivable), more than the bill
   * leaves the excess as customer credit (store-credit liability). Both are
   * a person's balance, so both still require `hasCustomer`.
   *
   * Default false — every pre-existing caller (amendments, imported sales,
   * retail invoices) keeps the exact-settlement rule it was written against.
   */
  allowDifference?: boolean;
}

/**
 * Whether these tenders settle the bill.
 *
 * Exact by default: the tenders must sum to what is owed, to the Rial. A
 * cashier who takes ۵۰۰٬۰۰۰ نقدی against a ۴۷۰٬۰۰۰ bill hands back ۳۰٬۰۰۰ and
 * the drawer holds the difference, but the *payment* is ۴۷۰٬۰۰۰ — recording
 * the ۵۰۰٬۰۰۰ would post revenue that was never earned and leave the entry
 * unbalanced. `changeDue` is what the screen shows; this is what it sends.
 *
 * With `allowDifference` the sum may sit either side of the bill, and the
 * caller settles the difference through `settlementDifference` — debt to the
 * customer's account, or credit to their store-credit balance — inside the
 * same transaction.
 */
export function validateTenders(
  tenders: readonly TenderInput[],
  options: TenderValidationOptions,
): ValidationResult<ResolvedTender[]> {
  if (!Array.isArray(tenders) || tenders.length === 0) return { ok: false, error: "no_payment" };
  if (tenders.length > MAX_TENDERS) return { ok: false, error: "too_many_tenders" };
  if (!Number.isSafeInteger(options.due) || options.due < 0) return { ok: false, error: "invalid_amount" };

  const openSlices = tenders.filter((tender) => tender.amount === undefined || tender.amount === null);
  if (openSlices.length > 1) return { ok: false, error: "payment_total_mismatch" };
  const priced = tenders.reduce((sum, tender) => sum + (tender.amount ?? 0), 0);
  const rest = options.due - priced;

  const resolved: ResolvedTender[] = [];
  for (const tender of tenders) {
    const amount = tender.amount ?? rest;
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: "invalid_amount" };
    if (!isPaymentSettlement(tender.settlement)) return { ok: false, error: "invalid_payment_method" };
    if (tender.settlement === "credit" && !options.hasCustomer) return { ok: false, error: "customer_required" };
    resolved.push({
      methodId: tender.methodId ?? null,
      settlement: tender.settlement,
      amount,
      reference: tender.reference?.trim() || null,
    });
  }
  const total = tenderTotal(resolved);
  if (total !== options.due) {
    if (!options.allowDifference) return { ok: false, error: "payment_total_mismatch" };
    // A difference is a balance on a person's account — never a walk-in's.
    if (!options.hasCustomer) return { ok: false, error: "customer_required" };
  }
  return { ok: true, value: resolved };
}

/** How a tender set that differs from the bill splits into debt and credit. */
export interface SettlementDifference {
  /** The unpaid remainder — posted as a debit to accounts receivable. */
  balanceDue: Rial;
  /** The overpaid excess — posted as a credit to the store-credit liability. */
  customerCredit: Rial;
}

/**
 * The difference between what was tendered and what the bill came to, split
 * into the two balances it can become: underpayment is the customer's debt,
 * overpayment is the customer's credit. Zero/zero for an exact settlement.
 */
export function settlementDifference(
  tenders: readonly { amount: Rial }[],
  due: Rial,
): SettlementDifference {
  const total = tenderTotal(tenders);
  if (total <= due) return { balanceDue: due - total, customerCredit: 0 };
  return { balanceDue: 0, customerCredit: total - due };
}

/**
 * Which slice of a split a tip rides on.
 *
 * `payments` rows have always recorded the bill and nothing else — a tip lives
 * on `orders.tip_amount`, and the ledger debits it on top of the payment (it
 * is money that changed hands, credited to a liability rather than revenue).
 * That was unambiguous while a bill had one tender; split across three, the
 * tip has to be attributed to one of them, and the answer is the first slice
 * that actually collected money: a tip is not put on a customer's tab, so a
 * `credit` slice is passed over unless the whole bill is on credit.
 *
 * Returns -1 for no tenders at all.
 */
export function tipTenderIndex(tenders: readonly { settlement: PaymentSettlement }[]): number {
  if (tenders.length === 0) return -1;
  const collected = tenders.findIndex((tender) => tender.settlement !== "credit");
  return collected >= 0 ? collected : 0;
}

/**
 * The tenders as the *ledger* sees them: the same slices, with the tip folded
 * into the one `tipTenderIndex` picks, so the debit side adds up to what the
 * customer actually handed over (bill + tip) while the `payments` rows keep
 * recording the bill alone.
 */
export function tendersWithTip<T extends { settlement: PaymentSettlement; amount: Rial }>(
  tenders: readonly T[],
  tip: Rial,
): T[] {
  if (tip <= 0) return [...tenders];
  const index = tipTenderIndex(tenders);
  if (index < 0) return [...tenders];
  return tenders.map((tender, position) =>
    position === index ? { ...tender, amount: tender.amount + tip } : { ...tender },
  );
}

/**
 * The tenders collapsed to one row per settlement, in `PAYMENT_SETTLEMENTS`
 * order — what the ledger posts (one debit line per account, never two lines
 * hitting the same account) and what a receipt summarises.
 */
export function tendersBySettlement(
  tenders: readonly { settlement: PaymentSettlement; amount: Rial }[],
): { settlement: PaymentSettlement; amount: Rial }[] {
  const totals = new Map<PaymentSettlement, Rial>();
  for (const tender of tenders) {
    totals.set(tender.settlement, (totals.get(tender.settlement) ?? 0) + tender.amount);
  }
  return PAYMENT_SETTLEMENTS.filter((settlement) => totals.has(settlement)).map((settlement) => ({
    settlement,
    amount: totals.get(settlement)!,
  }));
}
