/**
 * Cheques (چک) — the framework-free half.
 *
 * What a cheque can do next, what a صیاد id looks like, and how a due date
 * buckets. No database, no Next.js: this is what `cheques.test.ts` covers, and
 * what `cheques-service.ts` consults before it posts anything.
 *
 * The one idea worth stating: a cheque is a promise with a date on it, not a
 * payment. Everything here follows from that. It has a life (taken → deposited →
 * cleared, or endorsed onward, or bounced), each step of which moves money
 * between real accounts, and the register exists to answer questions about that
 * life — which is why the *status* is modelled here and not merely inferred from
 * a balance.
 */
import { bucketForAge, type AgingBucket } from "./aging";

export const CHEQUE_DIRECTIONS = ["receivable", "payable"] as const;
export type ChequeDirection = (typeof CHEQUE_DIRECTIONS)[number];

export const CHEQUE_STATUSES = [
  "on_hand",
  "in_collection",
  "endorsed",
  "issued",
  "cleared",
  "bounced",
  "cancelled",
  "resolved",
] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

export const CHEQUE_ACTIONS = [
  "deposit",
  "endorse",
  "clear",
  "bounce",
  "present",
  "cancel",
  "settle",
  "restore",
] as const;
export type ChequeAction = (typeof CHEQUE_ACTIONS)[number];

/** The status a cheque starts in, which its direction decides entirely. */
export function initialStatus(direction: ChequeDirection): ChequeStatus {
  return direction === "receivable" ? "on_hand" : "issued";
}

/**
 * The transition table — the authoritative one; the CHECK constraint in
 * migration 0095 only stops a direction holding the other's statuses.
 *
 * `endorsed` is a status and not an account, deliberately: an endorsed cheque
 * has left our assets (the supplier's balance really did go down) but comes back
 * if it bounces, and carrying that as an asset would need an unbalanced memo
 * pair. See the migration's header and WELL_KNOWN_CODES' note.
 *
 * A bounced cheque is *not* terminal. The instrument is dead — it never loops
 * back to `on_hand`, so "what happened to this cheque" stays answerable — but
 * its value is sitting in چک‌های برگشتی (1244) or چک‌های پرداختنی برگشتی (2122)
 * and something has to move it out. Two resolutions do that, and they are the
 * only two shapes the money can take:
 *
 *   settle  — it was paid another way (bank/cash), so the returned account
 *             clears against بانک and the cheque ends `cleared`.
 *   restore — the debt goes back to its control account (حساب‌های دریافتنی /
 *             حساب‌های پرداختنی) and the cheque ends `resolved`. A replacement
 *             cheque is then registered as an ordinary new cheque: its own
 *             entry credits/debits the control account again, so the pair nets
 *             out instead of double-settling A/R or A/P.
 */
const TRANSITIONS: Record<ChequeDirection, Partial<Record<ChequeStatus, Partial<Record<ChequeAction, ChequeStatus>>>>> = {
  receivable: {
    on_hand: { deposit: "in_collection", endorse: "endorsed", bounce: "bounced" },
    in_collection: { clear: "cleared", bounce: "bounced" },
    endorsed: { clear: "cleared", bounce: "bounced" },
    bounced: { settle: "cleared", restore: "resolved" },
  },
  payable: {
    issued: { present: "cleared", bounce: "bounced", cancel: "cancelled" },
    bounced: { settle: "cleared", restore: "resolved" },
  },
};

/** The status this action moves the cheque to, or `null` if it cannot be taken. */
export function nextStatus(
  direction: ChequeDirection,
  status: ChequeStatus,
  action: ChequeAction,
): ChequeStatus | null {
  return TRANSITIONS[direction][status]?.[action] ?? null;
}

/** Every action available from here, in the order a register should offer them. */
export function availableActions(direction: ChequeDirection, status: ChequeStatus): ChequeAction[] {
  const from = TRANSITIONS[direction][status];
  if (!from) return [];
  return CHEQUE_ACTIONS.filter((action) => from[action] !== undefined);
}

/** Whether the cheque's life is over — nothing more can happen to it. */
export function isTerminal(direction: ChequeDirection, status: ChequeStatus): boolean {
  return availableActions(direction, status).length === 0;
}

/**
 * A صیاد id is exactly 16 digits. Optional — a cheque written before the صیاد
 * system, or one whose id the counter didn't capture, is still a cheque — but
 * when given it must be well formed, since it is the identifier a bank and a
 * counterparty will both quote.
 *
 * Persian/Arabic-Indic digits are accepted and normalised: the number is read
 * off a printed cheque, and refusing «۱۲۳» while accepting "123" would be a
 * trap rather than a validation.
 */
export function normalizeSayadId(raw: string): string | null {
  const digits = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s-]/g, "");
  return /^[0-9]{16}$/.test(digits) ? digits : null;
}

export interface ChequeDueItem {
  id: string;
  dueDate: string;
  amount: number;
}

export interface ChequeDueBucket {
  bucket: AgingBucket;
  count: number;
  total: number;
}

/**
 * Group outstanding cheques by how overdue they are, reusing the AR/AP aging
 * buckets (`aging.ts`) rather than inventing a second set — «سررسید گذشته» on a
 * cheque means the same thing to a treasurer as an overdue invoice does, and one
 * vocabulary across the three registers is worth more than a bespoke one here.
 *
 * A cheque not yet due ages to 0, so it lands in the current bucket instead of
 * a negative one.
 */
export function bucketChequesByDueDate(items: ChequeDueItem[], asOfDate: string): ChequeDueBucket[] {
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);
  const totals = new Map<AgingBucket, ChequeDueBucket>();
  for (const item of items) {
    const due = Date.parse(`${item.dueDate}T00:00:00Z`);
    const ageDays = Math.max(0, Math.floor((asOf - due) / 86_400_000));
    const bucket = bucketForAge(ageDays);
    const existing = totals.get(bucket) ?? { bucket, count: 0, total: 0 };
    existing.count += 1;
    existing.total += item.amount;
    totals.set(bucket, existing);
  }
  return [...totals.values()];
}
