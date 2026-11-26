/**
 * The opening-balance step's account contract (issue #1583).
 *
 * The wizard used to hand-build its own account list and let the browser guess
 * which rows were postable (`children === 0`). That had two consequences the
 * issue reports as one symptom — «no accounts»:
 *
 *  1. a failed `GET /api/setup/opening` was rendered as an *empty picker*, so a
 *     permission/entitlement/transport failure looked exactly like a business
 *     that had no chart;
 *  2. a chart that exists but has no postable leaf, or an Accounting app that
 *     was never selected, had no distinct message either.
 *
 * This module is the single, framework-free answer: what counts as an eligible
 * opening account, and — separately — which structured state the step is in.
 * The route (`/api/setup/opening`) and the screen both read it, so the empty
 * state can no longer mean five different things.
 *
 * It is deliberately pure: no db, no next, no React, so it is unit-tested
 * against the same edge cases the API reports.
 */
import { WELL_KNOWN_CODES } from "./coa-template";

/** The distinct reasons the opening step may not be able to offer accounts. */
export const SETUP_OPENING_STATES = [
  "ready",
  "chart_missing",
  "no_eligible_leaf",
  "accounting_not_enabled",
  "permission_denied",
  "unavailable",
  "load_failed",
] as const;

export type SetupOpeningState = (typeof SETUP_OPENING_STATES)[number];

/** The states a *successful* read can legitimately report. */
export type SetupOpeningDataState = Extract<
  SetupOpeningState,
  "ready" | "chart_missing" | "no_eligible_leaf" | "accounting_not_enabled"
>;

/**
 * The owner-facing sentence for a state. The screen shows this *instead of* an
 * empty select, so every state has to be understandable without a code.
 */
export const SETUP_OPENING_STATE_MESSAGES: Record<SetupOpeningState, string> = {
  ready: "",
  chart_missing:
    "سرفصل حساب‌ها هنوز ساخته نشده است. می‌توانید همین‌جا سرفصل پیشنهادی صنف را بسازید یا در مرحلهٔ «سرفصل حساب‌ها» آن را کامل کنید.",
  no_eligible_leaf:
    "سرفصل حساب‌ها وجود دارد، اما هیچ حساب قابل ثبت (بدون زیرحساب و فعال) در آن نیست. یک حساب تفصیلی اضافه کنید یا سرفصل را در مرحلهٔ «سرفصل حساب‌ها» بررسی کنید.",
  accounting_not_enabled:
    "برنامهٔ حسابداری برای این کسب‌وکار انتخاب یا فعال نشده است؛ بنابراین دفتر کل و مانده‌های افتتاحیه معنا ندارند. می‌توانید این مرحله را رد کنید.",
  permission_denied:
    "برای خواندن سرفصل حساب‌ها دسترسی لازم را ندارید. با مالک یا حسابدار کسب‌وکار هماهنگ کنید.",
  unavailable:
    "خواندن اطلاعات افتتاحیه ممکن نشد. دوباره تلاش کنید؛ اگر ادامه داشت با پشتیبانی تماس بگیرید.",
  load_failed:
    "اطلاعات این مرحله بارگذاری نشد. اتصال را بررسی و دوباره تلاش کنید.",
};

/** The minimum an account row has to expose to be judged for the opening picker. */
export interface SetupOpeningAccountFacts {
  id: string;
  code: string;
  type: string;
  parentId: string | null;
  isActive: boolean;
  /** Whether anything in the chart names this row as its parent (any state). */
  hasChildren: boolean;
}

/**
 * Every account in the inventory-control subtree.
 *
 * Opening inventory is posted automatically by the inventory branch of this
 * step (`1300` and its counterpart `3900`); offering the same control account in
 * the manual picker is how the same stock would be posted twice. The old route
 * excluded the exact `1300` row only, which left a customized child of it
 * selectable — the same double-posting hole one level down.
 */
export function inventoryControlSubtreeIds(
  accounts: readonly SetupOpeningAccountFacts[],
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.parentId) continue;
    const siblings = childrenByParent.get(account.parentId) ?? [];
    siblings.push(account.id);
    childrenByParent.set(account.parentId, siblings);
  }
  const roots = accounts
    .filter((account) => account.code === WELL_KNOWN_CODES.inventory)
    .map((account) => account.id);
  const excluded = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    queue.push(...(childrenByParent.get(id) ?? []));
  }
  return excluded;
}

/** Whether one chart row may be offered as an opening-balance line. */
export function isEligibleOpeningAccount(
  account: SetupOpeningAccountFacts,
  excludedIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!account.isActive) return false;
  if (account.hasChildren) return false;
  if (excludedIds.has(account.id)) return false;
  return true;
}

/** The postable, active leaves the opening form may offer, in chart order. */
export function eligibleOpeningAccounts<T extends SetupOpeningAccountFacts>(
  accounts: readonly T[],
): T[] {
  const excluded = inventoryControlSubtreeIds(accounts);
  return accounts.filter((account) => isEligibleOpeningAccount(account, excluded));
}

/**
 * Which state a *successful* read is in.
 *
 * `accountingEnabled` comes from the business's saved app selection plus the
 * effective app availability (the route decides it and hands the boolean in).
 * `chartAccountCount` is every row, archived included, because a chart with only
 * archived rows is a chart that exists but cannot be posted to — a different
 * situation from a chart that was never created.
 */
export function resolveSetupOpeningState(input: {
  accountingEnabled: boolean;
  chartAccountCount: number;
  accounts: readonly SetupOpeningAccountFacts[];
}): SetupOpeningDataState {
  if (!input.accountingEnabled) return "accounting_not_enabled";
  if (input.chartAccountCount <= 0) return "chart_missing";
  if (eligibleOpeningAccounts(input.accounts).length === 0) return "no_eligible_leaf";
  return "ready";
}

/**
 * The one-line label for an account in the opening picker.
 *
 * A linked bank/till/terminal is named in the owner's words beside its code,
 * because «۱۱۱۰ — بانک» does not tell a person *which* bank account they are
 * opening. The linked GL identity itself still travels separately; this is
 * display only and never a second source of truth.
 */
export function openingAccountLabel(
  account: { code: string; name: string },
  financialAccountName?: string | null,
): string {
  const base = `${account.code} — ${account.name}`;
  return financialAccountName ? `${base} (${financialAccountName})` : base;
}
