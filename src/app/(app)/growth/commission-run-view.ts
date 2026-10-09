/**
 * What the commission settlement screens show, decided in one place (issue #869):
 * the tones, the button styles, which actions ask for a reason or a confirmation,
 * and how a payout's choice of account becomes the request.
 *
 * Pure and framework-free. Which actions a person may take is decided by the
 * lifecycle module and the run's `actions` list from the server; this file only
 * says how each one looks and behaves on the screen.
 */
import {
  COMMISSION_RUN_ACTION_LABELS,
  COMMISSION_RUN_STATUS_LABELS,
  type CommissionRunAction,
  type CommissionRunStatus,
} from "@/lib/commission-settlement-lifecycle";
import { formatJalali } from "@/lib/jalali";

export type RunTone = "active" | "positive" | "neutral" | "danger";

const STATUS_TONE: Record<CommissionRunStatus, RunTone> = {
  draft: "neutral",
  calculated: "active",
  reviewed: "active",
  approved: "active",
  payable: "active",
  partially_paid: "active",
  paid: "positive",
  closed: "neutral",
  voided: "danger",
};

export function runStatusLabel(status: CommissionRunStatus): string {
  return COMMISSION_RUN_STATUS_LABELS[status];
}

export function runStatusTone(status: CommissionRunStatus): RunTone {
  return STATUS_TONE[status];
}

/** Forward steps are the primary button; the ones that undo work are destructive; the rest are outline. */
export function actionVariant(action: CommissionRunAction): "default" | "outline" | "destructive" {
  switch (action) {
    case "void":
    case "reject":
    case "reverse_payout":
      return "destructive";
    case "calculate":
    case "approve":
    case "release":
    case "pay":
      return "default";
    default:
      return "outline";
  }
}

export function actionLabel(action: CommissionRunAction): string {
  return COMMISSION_RUN_ACTION_LABELS[action];
}

/** A void is refused without a written reason, which the screen asks for before it sends anything. */
export function actionRequiresReason(action: CommissionRunAction): boolean {
  return action === "void";
}

/** Actions that move money, undo work or cannot be taken back from the screen: the screen asks once more. */
export function actionNeedsConfirmation(action: CommissionRunAction): boolean {
  return action === "void" || action === "reject" || action === "release" || action === "close" || action === "reverse_payout";
}

const EVENT_LABELS: Record<string, string> = {
  create: "ساخت دوره",
  calculate: "محاسبه",
  review: "بازبینی",
  approve: "تأیید",
  reject: "بازگشت به پیش‌نویس",
  release: "آزادسازی برای پرداخت",
  payout: "پرداخت",
  payout_reversal: "ابطال پرداخت",
  close: "بستن دوره",
  void: "ابطال دوره",
};

export function eventLabel(action: string): string {
  return EVENT_LABELS[action] ?? action;
}

export function payoutKindLabel(kind: "payout" | "reversal"): string {
  return kind === "payout" ? "پرداخت" : "ابطال پرداخت";
}

export function methodLabel(method: "cash" | "bank"): string {
  return method === "cash" ? "صندوق" : "بانک";
}

export function lineKindLabel(kind: "accrual" | "carry_forward"): string {
  return kind === "accrual" ? "پورسانت" : "مانده دورهٔ قبل";
}

/** A Shamsi date for a stored `YYYY-MM-DD` or timestamp; a dash when there is none. */
export function shamsiDate(value: string | null | undefined): string {
  return value ? formatJalali(value) : "—";
}

/** A Shamsi date and time for a stored timestamp, in the business's zone. */
export function shamsiDateTime(value: string | null | undefined): string {
  return value ? formatJalali(value, { withTime: true }) : "—";
}

/**
 * The payment choice a payout form offers: one of the business's accounts, or
 * a plain method (cash or bank). Returns what the request body carries.
 */
export function parsePaymentChoice(value: string): { paymentAccountId: string | null; method: "cash" | "bank" | null } {
  if (value.startsWith("account:")) return { paymentAccountId: value.slice("account:".length), method: null };
  if (value === "method:cash") return { paymentAccountId: null, method: "cash" };
  if (value === "method:bank") return { paymentAccountId: null, method: "bank" };
  return { paymentAccountId: null, method: null };
}

/** One member's row in the payout form: «everything owed» or a typed amount, in the business's unit. */
export interface PayoutFormRow {
  all: boolean;
  text: string;
}

export type PayoutAllocationBody = { employeeId: string; all: true } | { employeeId: string; amount: string };

/**
 * The request's allocations from the form. A row that says «everything owed»
 * is sent as `all` and resolved by the server, so the amount is exact in any
 * unit; a typed amount is converted to Rial by `toRial` (which may throw on a
 * value the unit cannot hold — the caller reports it). Blank rows are left out.
 */
export function allocationsFromForm(
  rows: Record<string, PayoutFormRow>,
  toRial: (text: string) => string,
): PayoutAllocationBody[] {
  const out: PayoutAllocationBody[] = [];
  for (const [employeeId, row] of Object.entries(rows)) {
    if (row.all) {
      out.push({ employeeId, all: true });
      continue;
    }
    if (row.text.trim() === "") continue;
    out.push({ employeeId, amount: toRial(row.text) });
  }
  return out;
}
