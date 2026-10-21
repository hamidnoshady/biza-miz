/**
 * What the two checkout screens hold while the cashier decides how a bill is
 * being paid, and how that turns into a request body.
 *
 * Kept out of the components because it is the part that can be wrong: the
 * amounts are Toman strings typed by a person (Persian digits, thousands
 * separators, an empty box halfway through typing), the bill is integer Rial,
 * and the server will refuse anything that doesn't add up to the Rial. Both
 * screens ask the same questions of it — what is still owed, is this ready to
 * send, what does the receipt say, does the drawer open — so they ask here.
 */
import { parseToRial, type MoneyUnit, type Rial } from "./money";
import type { PaymentMethodView } from "./payment-methods";

export interface PaymentDraftRow {
  /** Stable across re-renders so React keys and focus survive a row being removed. */
  key: string;
  methodId: string;
  /** As typed, in the business's display unit. Empty while the cashier is still typing. */
  amount: string;
  reference: string;
}

export interface PaymentDraft {
  /**
   * False — the ordinary sale — means one way takes the whole bill and no
   * amount is typed at all. True is the split: every row carries its own
   * amount and they have to add up.
   */
  split: boolean;
  /** The chosen way when not splitting. */
  methodId: string;
  rows: PaymentDraftRow[];
  /**
   * The manual «مبلغ دریافتی» — what the customer actually handed over — as
   * typed, in the business's display unit, when NOT splitting. Empty means
   * "take the whole bill this way" (the ordinary sale, no amount sent).
   *
   * A value that differs from the bill is settled onto the customer's
   * account: less is their debt, more is their credit — both of which need a
   * customer named before the payment can go through.
   */
  receivedAmount?: string;
  /**
   * Whether the cashier opened the «مبلغ دریافتی» entry at all.
   *
   * The field used to be a permanently visible box, so "is a manual amount in
   * play" was inferred from whether it happened to be non-empty — which made
   * a stale keystroke behind a later mode change able to change what was
   * charged. Now the entry is a deliberate, collapsible action beside «تقسیم
   * بین چند روش», and this flag *is* the mode: false (the ordinary sale) means
   * the chosen way covers the whole invoice and no amount is sent, whatever
   * text `receivedAmount` still holds.
   *
   * Mutually exclusive with `split` by construction: every reader below
   * ignores it while splitting, and the two toggles turn each other off, so a
   * slice can never be charged twice.
   */
  manualReceived?: boolean;
}

/** Whether this draft is in the manual «مبلغ دریافتی» mode (never while splitting). */
export function draftUsesManualAmount(draft: PaymentDraft): boolean {
  return !draft.split && draft.manualReceived === true;
}

let rowCounter = 0;

export function newDraftRow(methodId: string, amount = ""): PaymentDraftRow {
  rowCounter += 1;
  return { key: `tender-${rowCounter}`, methodId, amount, reference: "" };
}

/** The draft a screen opens with: the first way offered, whole bill, no split. */
export function emptyPaymentDraft(methods: readonly PaymentMethodView[]): PaymentDraft {
  const first = methods[0]?.id ?? "";
  return {
    split: false,
    methodId: first,
    rows: [newDraftRow(first)],
    receivedAmount: "",
    manualReceived: false,
  };
}

/** A row's amount in Rial, or null while it is empty or not a number yet. */
export function draftRowRial(row: PaymentDraftRow, unit: MoneyUnit = "toman"): Rial | null {
  if (!row.amount.trim()) return null;
  try {
    const rial = parseToRial(row.amount, unit);
    return rial > 0 ? rial : null;
  } catch {
    return null;
  }
}

/**
 * The manually typed «مبلغ دریافتی» in Rial, or null while it is empty or not
 * a number yet. Only meaningful when not splitting — a split types each slice.
 */
export function draftReceivedRial(draft: PaymentDraft, unit: MoneyUnit = "toman"): Rial | null {
  // Splitting types each slice, and a collapsed «مبلغ دریافتی» means "the
  // whole invoice" no matter what text is left in the (hidden) box.
  if (!draftUsesManualAmount(draft)) return null;
  const text = draft.receivedAmount?.trim();
  if (!text) return null;
  try {
    const rial = parseToRial(text, unit);
    return rial > 0 ? rial : null;
  } catch {
    return null;
  }
}

/** What the typed rows come to so far — rows still being typed count as zero. */
export function draftTotal(draft: PaymentDraft, due: Rial, unit: MoneyUnit = "toman"): Rial {
  if (!draft.split) {
    // The open box with text in it counts only when the text is a real
    // amount: a malformed entry contributes zero (so `draftRemaining` still
    // shows the whole bill — nothing has been received yet) instead of
    // pretending the bill is covered. An empty box is the ordinary whole-bill
    // sale and counts as `due`, as always.
    const typed = draftUsesManualAmount(draft) ? draft.receivedAmount?.trim() : "";
    if (typed) return draftReceivedRial(draft, unit) ?? 0;
    return due;
  }
  return draft.rows.reduce((sum, row) => sum + (draftRowRial(row, unit) ?? 0), 0);
}

/** Still owed. Negative once the rows overshoot the bill. */
export function draftRemaining(draft: PaymentDraft, due: Rial, unit: MoneyUnit = "toman"): Rial {
  return due - draftTotal(draft, due, unit);
}

export function methodOf(methods: readonly PaymentMethodView[], id: string): PaymentMethodView | undefined {
  return methods.find((method) => method.id === id);
}

/** Whether this payment should kick the cash drawer — any slice of it taken in cash does. */
export function draftOpensDrawer(draft: PaymentDraft, methods: readonly PaymentMethodView[]): boolean {
  const ids = draft.split ? draft.rows.map((row) => row.methodId) : [draft.methodId];
  return ids.some((id) => methodOf(methods, id)?.opensDrawer === true);
}

/** Whether any way in this payment is a tab, and so needs a customer named. */
export function draftNeedsCustomer(draft: PaymentDraft, methods: readonly PaymentMethodView[]): boolean {
  const ids = draft.split ? draft.rows.map((row) => row.methodId) : [draft.methodId];
  return ids.some((id) => methodOf(methods, id)?.settlement === "credit");
}

/**
 * How a draft's received amount differs from the bill: the shortfall that
 * would become customer debt, or the excess that would become customer
 * credit. Zero/zero when nothing has been typed (or it matches exactly) —
 * which is what makes it safe to call on every render for the live preview.
 *
 * Needs the draft's *received* total, not the due-echoing default, so this
 * takes the numbers already computed by the caller (or draftTotal) in Rial.
 */
export function draftDifference(received: Rial, due: Rial): { balanceDue: Rial; customerCredit: Rial } {
  if (received <= due) return { balanceDue: due - received, customerCredit: 0 };
  return { balanceDue: 0, customerCredit: received - due };
}

/**
 * Whether this draft, as it stands, settles onto a person's account and so
 * needs a customer named before it can be sent: a نسیه way, a typed received
 * amount short of the bill (debt), or one beyond it (credit).
 */
export function draftRequiresCustomer(
  draft: PaymentDraft,
  methods: readonly PaymentMethodView[],
  due: Rial,
  unit: MoneyUnit = "toman",
): boolean {
  if (draftNeedsCustomer(draft, methods)) return true;
  const received = draftReceivedRial(draft, unit);
  if (received === null) return false;
  const { balanceDue, customerCredit } = draftDifference(received, due);
  return balanceDue > 0 || customerCredit > 0;
}

export interface PaymentDraftBody {
  methodId: string;
  /** Absent means "take whatever is left" — see TenderInput.amount in payment-methods.ts. */
  amount?: Rial;
  reference?: string;
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The `payments` array for POST /api/orders/[id]/pay, or the reason this
 * draft isn't payable yet. The error codes are the API's own, so a screen
 * shows the same Persian sentence whether the check failed here or there.
 *
 * Not splitting sends no amount at all — *unless* the cashier opened «مبلغ
 * دریافتی» and typed one, which is sent explicitly so the server can settle
 * the difference (debt or credit) onto the customer's account. Otherwise
 * "take the whole bill this way" stays one field, and the server is the only
 * place that decides what the whole bill is — a screen that computed it from
 * a stale total would be the one bug this costs nothing to make impossible.
 *
 * The three modes cannot overlap: a split sends its slices and never the
 * manual figure; a collapsed «مبلغ دریافتی» sends no amount even if text is
 * left in the box (see `draftUsesManualAmount`); and an open one sends
 * exactly what it holds. So no amount is ever charged twice.
 */
export function paymentDraftBody(
  draft: PaymentDraft,
  methods: readonly PaymentMethodView[],
  due: Rial,
  unit: MoneyUnit = "toman",
): DraftResult<PaymentDraftBody[]> {
  const rows = draft.split
    ? draft.rows
    : // One implicit row for the chosen way. Its amount is decided below by
      // the mode, not by whatever text the collapsed box still holds.
      [{ ...newDraftRow(draft.methodId), reference: draft.rows[0]?.reference ?? "" }];
  if (rows.length === 0) return { ok: false, error: "no_payment" };

  const body: PaymentDraftBody[] = [];
  for (const row of rows) {
    const method = methodOf(methods, row.methodId);
    if (!method) return { ok: false, error: "invalid_payment_method" };
    if (method.requiresReference && !row.reference.trim()) {
      return { ok: false, error: "payment_reference_required" };
    }
    if (!draft.split) {
      // The empty open box is the ordinary whole-bill sale — no amount sent.
      // But text that IS there must be a usable amount (issue #913 item 7):
      // a malformed, zero, negative or overflowed entry used to degrade into
      // `amount: undefined`, which the server reads as "take the whole bill"
      // — silently charging a different figure than the cashier typed. Never
      // substitute; refuse with a message the cashier can act on.
      const typed = draftUsesManualAmount(draft) ? draft.receivedAmount?.trim() : "";
      if (typed) {
        const received = draftReceivedRial(draft, unit);
        if (received === null) return { ok: false, error: "invalid_received_amount" };
        body.push({
          methodId: method.id,
          amount: received,
          reference: row.reference.trim() || undefined,
        });
        continue;
      }
      body.push({
        methodId: method.id,
        amount: undefined,
        reference: row.reference.trim() || undefined,
      });
      continue;
    }
    const amount = draftRowRial(row, unit);
    if (amount === null) return { ok: false, error: "invalid_amount" };
    // The last slice is sent open — "take the rest" — even though the cashier
    // typed a figure for it. The typed figures are checked against `due` just
    // below, so the two agree in every ordinary sale; sending the last one
    // open is what keeps the sale from failing outright when the screen's
    // total is a little behind the server's (see TenderInput.amount).
    const isLast = row === rows[rows.length - 1];
    body.push({
      methodId: method.id,
      amount: isLast ? undefined : amount,
      reference: row.reference.trim() || undefined,
    });
  }
  if (draft.split && draftRemaining(draft, due, unit) !== 0) {
    return { ok: false, error: "payment_total_mismatch" };
  }
  return { ok: true, value: body };
}

/**
 * The tender lines to print: the name the business gave each way, with what it
 * took. A bill that wasn't split still prints one line — the way's own name,
 * which is the point of letting a business rename «کارت‌خوان» to «پوز ملت».
 * A manually typed received amount prints what was actually taken, so the
 * receipt restates the change/credit the customer is owed.
 */
export function draftReceiptPayments(
  draft: PaymentDraft,
  methods: readonly PaymentMethodView[],
  due: Rial,
  unit: MoneyUnit = "toman",
): { label: string; amount: Rial }[] {
  if (!draft.split) {
    const method = methodOf(methods, draft.methodId);
    const received = draftReceivedRial(draft, unit);
    return method ? [{ label: method.name, amount: received ?? due }] : [];
  }
  return draft.rows.flatMap((row) => {
    const method = methodOf(methods, row.methodId);
    const amount = draftRowRial(row, unit);
    return method && amount !== null ? [{ label: method.name, amount }] : [];
  });
}
