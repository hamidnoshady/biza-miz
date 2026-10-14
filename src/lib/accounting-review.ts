/**
 * Phase 32 — «بازبینی حساب‌ها»: the deterministic accounting checker.
 *
 * "Look at my books and tell me what's wrong" is the request this exists for,
 * and it is deliberately NOT a model prompt. Every finding below is a rule with
 * an arithmetic or referential basis — a debit total that differs from a credit
 * total, an inventory event that never reached the ledger, a cheque past its
 * due date still sitting in the register. A language model asked to audit a
 * trial balance will produce plausible findings, and a plausible finding about
 * money is worse than none: the owner cannot tell it from a real one.
 *
 * So the review is a pure function over a snapshot, and the assistant's role is
 * to explain what it found, not to find it. `accounting-review-service.ts`
 * gathers the snapshot; this file decides what is wrong with it.
 *
 * Every finding carries three things the owner actually needs: how bad it is,
 * what it costs (where that is knowable), and which screen fixes it.
 */

import { formatJalali } from "./jalali";
import { formatRial } from "./money";
import { formatQuantity, toPersianDigits } from "./digits";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import { RECONCILABLE_ACCOUNTS } from "./bank-reconciliation";
import { RECONCILABLE_ACCOUNT_LABELS } from "./ai-labels";

/**
 * «صندوق، بانک یا کارت‌خوان (در راه)» — the accounts an unreconciled line can
 * sit on, spelled from the same list the reconciliation service uses rather
 * than typed into the sentence.
 *
 * This copy said «صندوق یا کارت‌خوان» while the service had already learned to
 * reconcile بانک, so the audit named two of the three places its own count came
 * from — a reader on a cheque-taking business was told to look everywhere
 * except the account holding the money. Deriving it means a fourth reconcilable
 * account shows up here by itself instead of by somebody remembering.
 */
export const RECONCILABLE_ACCOUNT_NAMES: readonly string[] = RECONCILABLE_ACCOUNTS.map(
  (key) => RECONCILABLE_ACCOUNT_LABELS[key] ?? key,
);

/** Persian "a، b یا c" — the last item joined with «یا», the rest with «،». */
function persianList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join("، ")} یا ${items[items.length - 1]}`;
}

export type AccountingReviewSeverity = "high" | "medium" | "low";

export interface AccountingFindingSample {
  label: string;
  ref?: string;
}

export interface AccountingFinding {
  code: string;
  severity: AccountingReviewSeverity;
  title: string;
  detail: string;
  /** How many rows the rule matched. Always ≥ 1 for an emitted finding. */
  count: number;
  /** Integer Rial where the rule has a meaningful amount, else null. */
  amountRial: number | null;
  /** What the owner should do about it, in Persian. */
  suggestion: string;
  /** Dashboard path that fixes it, or null when there is no single screen. */
  href: string | null;
  samples: AccountingFindingSample[];
}

// ---------------------------------------------------------------------------
// The snapshot — exactly what the service reads, and the only thing a rule sees
// ---------------------------------------------------------------------------

export interface AccountingReviewSnapshot {
  /** ISO date the review was taken as of. */
  asOfDate: string;
  /** How many days back the windowed rules looked. */
  windowDays: number;
  /** Entries whose debit total ≠ credit total. Should always be empty. */
  unbalancedEntries: { id: string; entryDate: string; memo: string; debitRial: number; creditRial: number }[];
  /** Inventory events that never produced their ledger entry. */
  unpostedInventoryEvents: { id: string; eventType: string; occurredAt: string; status: string }[];
  /** Manual journal drafts still waiting for a second pair of eyes. */
  pendingDrafts: { id: string; memo: string; createdAt: string; ageDays: number; amountRial: number }[];
  staleDraftAfterDays: number;
  /** Closed shifts whose counted drawer differed from the expected cash. */
  shiftVariances: { shiftId: string; employeeName: string; endedAt: string; varianceRial: number }[];
  varianceThresholdRial: number;
  /** Chart-of-accounts codes the product needs and this business does not have. */
  missingAccountCodes: { code: string; name: string }[];
  /** Items sitting at a negative quantity — a costing bug in the making. */
  negativeStock: { id: string; name: string; quantity: string; unit: string }[];
  /** Bank lines never matched to a statement. */
  unreconciledBankLines: { count: number; oldestAgeDays: number | null; amountRial: number };
  /** Settled orders in the window with no journal entry against them. */
  closedOrdersWithoutEntry: { id: string; reference: string; closedAt: string; totalRial: number }[];
  /** Customer balances older than the ageing floor. */
  agedReceivables: { customerId: string; customerName: string; amountRial: number; ageDays: number }[];
  receivableAgeFloorDays: number;
  /** Cheques past their due date still in a pending state. */
  overdueCheques: { id: string; serialNumber: string; dueDate: string; amountRial: number; direction: string; status: string }[];
  /** Purchase drafts never received. */
  staleDraftPurchases: { id: string; supplierName: string | null; createdAt: string; ageDays: number }[];
  staleDraftPurchaseAfterDays: number;
  /** Fiscal periods that ended but were never soft-closed or locked. */
  unlockedPastPeriods: { id: string; label: string; endsOn: string }[];
  /**
   * Journal entries dated outside every configured fiscal period (audit F08),
   * and how many fiscal years exist at all. Reported, never rejected: the
   * database permits an uncovered date on purpose.
   */
  uncoveredFiscalEntries: { count: number; earliest: string | null; latest: string | null; fiscalYearCount: number };
  /**
   * Codes of findings whose row list hit the service's row cap, so their count
   * is a floor rather than a total. An audit tool that prints «۵۰ مورد» when
   * there are six hundred is lying in the same way one that finds nothing
   * because its query broke is — see `unavailableChecks` for the sibling case.
   */
  truncatedChecks: string[];
}

/** An empty snapshot, so a caller that cannot read one table still gets a review. */
export function emptyAccountingSnapshot(asOfDate: string, windowDays = 30): AccountingReviewSnapshot {
  return {
    asOfDate,
    windowDays,
    unbalancedEntries: [],
    unpostedInventoryEvents: [],
    pendingDrafts: [],
    staleDraftAfterDays: 7,
    shiftVariances: [],
    varianceThresholdRial: 500_000,
    missingAccountCodes: [],
    negativeStock: [],
    unreconciledBankLines: { count: 0, oldestAgeDays: null, amountRial: 0 },
    closedOrdersWithoutEntry: [],
    agedReceivables: [],
    receivableAgeFloorDays: 60,
    overdueCheques: [],
    staleDraftPurchases: [],
    staleDraftPurchaseAfterDays: 14,
    unlockedPastPeriods: [],
    uncoveredFiscalEntries: { count: 0, earliest: null, latest: null, fiscalYearCount: 0 },
    truncatedChecks: [],
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<AccountingReviewSeverity, number> = { high: 3, medium: 2, low: 1 };

function sample(label: string, ref?: string): AccountingFindingSample {
  return ref === undefined ? { label } : { label, ref };
}

/** Keeps a finding's sample list short enough to render on a card. */
function firstSamples<T>(rows: T[], toSample: (row: T) => AccountingFindingSample): AccountingFindingSample[] {
  return rows.slice(0, 5).map(toSample);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// ---------------------------------------------------------------------------
// Display helpers
//
// A finding is read by a shop owner on a Persian phone, so it follows the same
// display conventions as every other screen: Persian digits, thousands
// grouping, Jalali dates. Storage stays integer Rial and ISO/Gregorian — only
// these strings shift. `amountRial` on the finding itself stays a raw integer,
// which is what the public API and the coworker inbox consume.
// ---------------------------------------------------------------------------

/** e.g. 619_224_620 → «۶۱۹٬۲۲۴٬۶۲۰ ریال» rather than a bare `619224620`. */
function money(rial: number): string {
  return formatRial(rial);
}

/**
 * An ISO/Gregorian date (or the leading date of a timestamp) as Jalali. Falls
 * back to the raw value rather than throwing: every rule runs outside the
 * service's `safely` wrapper, so one bad date must not take down the review.
 */
function day(iso: string): string {
  const date = iso.slice(0, 10);
  try {
    return toPersianDigits(formatJalali(date));
  } catch {
    return date;
  }
}

function fa(value: number): string {
  return toPersianDigits(value);
}

const CHEQUE_DIRECTION_LABELS: Record<string, string> = {
  receivable: "دریافتی",
  payable: "پرداختی",
};

/**
 * Appended when the service's row cap swallowed the rest of the matches, so
 * the count reads as "at least this many" instead of a total the owner would
 * otherwise take as exact.
 */
function truncated(s: AccountingReviewSnapshot, code: string): string {
  return s.truncatedChecks.includes(code)
    ? " این فهرست به سقف نمایش رسیده، پس شمار واقعی می‌تواند از این بیشتر باشد."
    : "";
}

type Rule = (snapshot: AccountingReviewSnapshot) => AccountingFinding | null;

const RULES: Rule[] = [
  // The one finding that should be impossible. postExactJournalEntry balances
  // every entry it writes, so a hit here means something bypassed it — which is
  // worth shouting about even though it will almost always find nothing.
  (s) => {
    const rows = s.unbalancedEntries;
    if (rows.length === 0) return null;
    const gap = sum(rows.map((row) => Math.abs(row.debitRial - row.creditRial)));
    return {
      code: "unbalanced_entry",
      severity: "high",
      title: "سند حسابداری نامتوازن",
      detail: `${fa(rows.length)} سند پیدا شد که جمع بدهکار و بستانکار آن برابر نیست (اختلاف کل: ${money(gap)}). تراز آزمایشی تا اصلاح این اسناد درست نخواهد بود.${truncated(s, "unbalanced_entry")}`,
      count: rows.length,
      amountRial: gap,
      suggestion: "هر سند را در دفتر روزنامه باز کنید و ردیف جاافتاده را اضافه یا اصلاح کنید. اگر سند از یک عملیات خودکار آمده، آن عملیات را برگردانید و دوباره ثبت کنید.",
      href: "/accounting/entries",
      samples: firstSamples(rows, (row) => sample(`${day(row.entryDate)} — ${row.memo || "بدون شرح"}`, row.id)),
    };
  },

  // An inventory event that moved stock but never posted is a silent gap
  // between the store room and the ledger: COGS and inventory value disagree.
  //
  // `pending`/`failed` only — never `reversed`. A reversed event WAS posted and
  // then deliberately undone by a compensating entry (see stock-count-service
  // and production-service, which flip the original to `reversed` and post the
  // reversal in the same transaction), so both halves are in the ledger and
  // there is nothing to fix. Treating it as unposted told owners to re-post
  // corrections they had already made, which would double-count them.
  (s) => {
    const rows = s.unpostedInventoryEvents;
    if (rows.length === 0) return null;
    return {
      code: "unposted_inventory_event",
      severity: "high",
      title: "رویداد انباری ثبت‌نشده در دفتر",
      detail: `${fa(rows.length)} رویداد انبار (خرید، ضایعات، شمارش یا تولید) موجودی را جابه‌جا کرده اما سند حسابداری آن ثبت نشده است. ارزش انبار و بهای تمام‌شده تا اصلاح این موارد با هم نمی‌خواند.${truncated(s, "unposted_inventory_event")}`,
      count: rows.length,
      amountRial: null,
      suggestion: "این رویدادها معمولاً به‌دلیل نبودِ یک سرفصل حساب متوقف می‌مانند. ابتدا سرفصل‌های جاافتاده را بسازید، سپس رویداد را دوباره ثبت کنید.",
      href: ACCOUNTING_WORKSPACE_HREFS.inventory,
      samples: firstSamples(rows, (row) => sample(`${row.eventType} — ${day(row.occurredAt)} (${row.status})`, row.id)),
    };
  },

  (s) => {
    const rows = s.closedOrdersWithoutEntry;
    if (rows.length === 0) return null;
    const total = sum(rows.map((row) => row.totalRial));
    return {
      code: "closed_order_without_entry",
      severity: "high",
      title: "فروش تسویه‌شده بدون سند",
      detail: `${fa(rows.length)} سفارش در ${fa(s.windowDays)} روز گذشته بسته و تسویه شده اما هیچ سند حسابداری برای آن ثبت نشده است (جمع: ${money(total)}). این مبلغ در گزارش فروش هست و در دفاتر نیست.${truncated(s, "closed_order_without_entry")}`,
      count: rows.length,
      amountRial: total,
      suggestion: "این سفارش‌ها را در صفحهٔ سفارش‌ها بررسی کنید. اگر پرداختشان واقعی بوده، سند فروش را دستی ثبت کنید و علت جاافتادن آن را پیگیری کنید.",
      href: "/accounting/orders",
      samples: firstSamples(rows, (row) => sample(`${row.reference} — ${money(row.totalRial)}`, row.id)),
    };
  },

  (s) => {
    const rows = s.missingAccountCodes;
    if (rows.length === 0) return null;
    return {
      code: "missing_account_code",
      severity: "high",
      title: "سرفصل حساب جاافتاده",
      detail: `${fa(rows.length)} سرفصل که نرم‌افزار برای ثبت خودکار به آن نیاز دارد در جدول حساب‌های شما نیست: ${rows.map((row) => `${row.code} ${row.name}`).join("، ")}.`,
      count: rows.length,
      amountRial: null,
      suggestion: "این سرفصل‌ها را در «سرفصل حساب‌ها» بسازید. تا وقتی نباشند، هر عملیاتی که به آن‌ها نیاز دارد با خطای «سرفصل حساب موجود نیست» متوقف می‌شود.",
      href: "/accounting/chart-of-accounts",
      samples: rows.slice(0, 5).map((row) => sample(`${row.code} — ${row.name}`)),
    };
  },

  (s) => {
    const rows = s.pendingDrafts.filter((row) => row.ageDays >= s.staleDraftAfterDays);
    if (rows.length === 0) return null;
    const total = sum(rows.map((row) => row.amountRial));
    const oldest = Math.max(...rows.map((row) => row.ageDays));
    return {
      code: "stale_journal_draft",
      severity: "medium",
      title: "پیش‌نویس سند معطل‌مانده",
      detail: `${fa(rows.length)} پیش‌نویس سند بیش از ${fa(s.staleDraftAfterDays)} روز است که منتظر تأیید مانده (قدیمی‌ترین: ${fa(oldest)} روز، جمع: ${money(total)}). تا تأیید نشوند در هیچ گزارشی دیده نمی‌شوند.`,
      count: rows.length,
      amountRial: total,
      // «تأیید یا رد» — deliberately not «اصلاح». There is no draft-edit
      // workflow: the API can list, get, create, approve and reject a draft,
      // and nothing else. Recommending an action the screen does not have sent
      // an owner looking for an edit button that was never built, and the
      // honest alternative (reject it and type the corrected document again)
      // is what the route actually supports.
      suggestion: "پیش‌نویس‌ها را در صف تأیید اسناد بررسی و تعیین‌تکلیف کنید: تأیید یا رد (و در صورت نیاز، ثبت دوبارهٔ سند اصلاح‌شده).",
      href: "/accounting/manual",
      samples: firstSamples(rows, (row) => sample(`${row.memo} — ${fa(row.ageDays)} روز`, row.id)),
    };
  },

  (s) => {
    const rows = s.shiftVariances.filter((row) => Math.abs(row.varianceRial) >= s.varianceThresholdRial);
    if (rows.length === 0) return null;
    const net = sum(rows.map((row) => row.varianceRial));
    return {
      code: "shift_cash_variance",
      severity: "medium",
      title: "کسری یا اضافهٔ صندوق",
      detail: `${fa(rows.length)} شیفت در ${fa(s.windowDays)} روز گذشته با اختلاف قابل‌توجه بین موجودی شمرده‌شده و مبلغ مورد انتظار بسته شده است (خالص: ${money(net)}).`,
      count: rows.length,
      amountRial: Math.abs(net),
      suggestion: "شیفت‌ها را با صندوق‌دار مرور کنید. اختلاف تکرارشونده معمولاً یا از ثبت‌نشدن یک پرداخت است یا از تحویل نادرست صندوق؛ مانده را در سرفصل «کسری و اضافهٔ صندوق» ببندید.",
      href: ACCOUNTING_WORKSPACE_HREFS.reports,
      samples: firstSamples(rows, (row) => sample(`${row.employeeName} — ${money(row.varianceRial)}`, row.shiftId)),
    };
  },

  (s) => {
    const rows = s.overdueCheques;
    if (rows.length === 0) return null;
    const total = sum(rows.map((row) => row.amountRial));
    return {
      code: "overdue_cheque",
      severity: "high",
      title: "چک سررسیدگذشته بدون تعیین‌تکلیف",
      detail: `${fa(rows.length)} چک از سررسید گذشته و هنوز در وضعیت باز است (جمع: ${money(total)}). چک دریافتی وصول‌نشده یعنی طلبی که هنوز نقد نشده، و چک پرداختی سررسیدگذشته یعنی بدهی که ممکن است برگشت خورده باشد.${truncated(s, "overdue_cheque")}`,
      count: rows.length,
      amountRial: total,
      suggestion: "هر چک را در دفتر چک‌ها به وضعیت واقعی‌اش ببرید: وصول، برگشت یا ابطال. وضعیت اشتباه، هم مانده بانک و هم مانده طرف حساب را غلط نشان می‌دهد.",
      href: "/accounting/cheques",
      samples: firstSamples(rows, (row) =>
        sample(
          `${CHEQUE_DIRECTION_LABELS[row.direction] ?? row.direction} ${row.serialNumber} — سررسید ${day(row.dueDate)}`,
          row.id,
        ),
      ),
    };
  },

  (s) => {
    const { count, amountRial, oldestAgeDays } = s.unreconciledBankLines;
    if (count === 0) return null;
    const age = oldestAgeDays === null ? "" : ` قدیمی‌ترین ${fa(oldestAgeDays)} روز پیش ثبت شده است.`;
    return {
      code: "unreconciled_bank_lines",
      severity: count > 20 ? "medium" : "low",
      title: "ردیف بانکی مغایرت‌گیری‌نشده",
      detail: `${fa(count)} ردیف ${persianList(RECONCILABLE_ACCOUNT_NAMES)} هنوز با صورتحساب تطبیق داده نشده است (جمع: ${money(amountRial)}).${age}`,
      count,
      amountRial,
      suggestion: "در «مغایرت‌گیری بانکی» صورتحساب دوره را وارد و ردیف‌ها را تطبیق دهید. هرچه دیرتر انجام شود، پیدا کردن ردیف جاافتاده سخت‌تر می‌شود.",
      href: "/accounting/reconciliation",
      samples: [],
    };
  },

  (s) => {
    const rows = s.agedReceivables;
    if (rows.length === 0) return null;
    const total = sum(rows.map((row) => row.amountRial));
    return {
      code: "aged_receivable",
      severity: "medium",
      title: "طلب معوق از مشتری",
      detail: `${fa(rows.length)} مشتری بیش از ${fa(s.receivableAgeFloorDays)} روز است که بدهی تسویه‌نشده دارند (جمع: ${money(total)}).`,
      count: rows.length,
      amountRial: total,
      suggestion: "فهرست را در گزارش سنی حساب‌های دریافتنی مرور کنید. برای مانده‌هایی که دیگر وصول نمی‌شوند، ذخیرهٔ مطالبات مشکوک‌الوصول ثبت کنید تا سود دوره واقعی شود.",
      href: "/crm/directory",
      samples: firstSamples(rows, (row) => sample(`${row.customerName} — ${money(row.amountRial)} (${fa(row.ageDays)} روز)`, row.customerId)),
    };
  },

  (s) => {
    const rows = s.negativeStock;
    if (rows.length === 0) return null;
    return {
      code: "negative_stock",
      severity: "medium",
      title: "موجودی منفی",
      detail: `${fa(rows.length)} کالا موجودی منفی دارد. یعنی فروش یا مصرفی ثبت شده که خریدِ متناظرش هنوز وارد نشده؛ تا اصلاح، بهای تمام‌شدهٔ آن کالا تخمینی است.${truncated(s, "negative_stock")}`,
      count: rows.length,
      amountRial: null,
      suggestion: "رسید خریدهای ثبت‌نشدهٔ این کالاها را وارد کنید. اگر خریدی در کار نبوده، با یک شمارش انبار موجودی را اصلاح کنید.",
      href: ACCOUNTING_WORKSPACE_HREFS.inventory,
      // formatQuantity already returns Persian digits, and trims the nine
      // decimal places migration 0015 stores cost-basis quantities with.
      samples: firstSamples(rows, (row) => sample(`${row.name} — ${formatQuantity(row.quantity)} ${row.unit}`, row.id)),
    };
  },

  (s) => {
    const rows = s.staleDraftPurchases.filter((row) => row.ageDays >= s.staleDraftPurchaseAfterDays);
    if (rows.length === 0) return null;
    return {
      code: "stale_draft_purchase",
      severity: "low",
      title: "پیش‌نویس خرید رسید نشده",
      detail: `${fa(rows.length)} پیش‌نویس سفارش خرید بیش از ${fa(s.staleDraftPurchaseAfterDays)} روز است که رسید نشده است.`,
      count: rows.length,
      amountRial: null,
      suggestion: "اگر کالا رسیده، رسید خرید را ثبت کنید تا موجودی و بدهی تأمین‌کننده درست شود؛ اگر منتفی شده، پیش‌نویس را لغو کنید.",
      href: ACCOUNTING_WORKSPACE_HREFS.inventory,
      samples: firstSamples(rows, (row) => sample(`${row.supplierName ?? "بدون تأمین‌کننده"} — ${fa(row.ageDays)} روز`, row.id)),
    };
  },

  (s) => {
    const rows = s.unlockedPastPeriods;
    if (rows.length === 0) return null;
    return {
      code: "unlocked_past_period",
      severity: "low",
      title: "دورهٔ مالی بسته‌نشده",
      detail: `${fa(rows.length)} دورهٔ مالی به پایان رسیده اما هنوز بسته یا قفل نشده است. تا قفل نشود، ثبت سند با تاریخ گذشته در آن دوره ممکن است و گزارش‌های نهایی‌شده می‌توانند تغییر کنند.`,
      count: rows.length,
      amountRial: null,
      suggestion: "پس از اطمینان از کامل‌بودن اسناد، دوره را در «دوره‌های مالی» ببندید و سپس قفل کنید.",
      href: "/accounting/fiscal-periods",
      samples: firstSamples(rows, (row) => sample(`${row.label} — پایان ${day(row.endsOn)}`, row.id)),
    };
  },

  (s) => {
    const u = s.uncoveredFiscalEntries;
    if (u.count === 0 || !u.earliest || !u.latest) return null;
    const noYear = u.fiscalYearCount === 0;
    return {
      code: "uncovered_fiscal_dates",
      severity: "medium",
      title: noYear ? "سال مالی تعریف نشده" : "سند بیرون از دوره‌های مالی",
      detail: `${fa(u.count)} سند حسابداری از ${day(u.earliest)} تا ${day(u.latest)} در هیچ دورهٔ مالی تعریف‌شده‌ای نیست${
        noYear ? "؛ هنوز هیچ سال مالی‌ای تعریف نشده است" : ""
      }. این اسناد رد یا جابه‌جا نمی‌شوند، اما تا زیر پوشش دوره نروند قابل قفل نیستند و بستن حساب‌های سال ممکن نیست.`,
      count: u.count,
      amountRial: null,
      suggestion: "سال مالیِ تاریخ‌های این اسناد را در «دوره‌های مالی» تعریف کنید؛ تعریف سال، سندی را تغییر نمی‌دهد.",
      href: "/accounting/fiscal-periods",
      samples: [],
    };
  },
];

/**
 * Runs every rule and returns what is wrong, worst first. Ties keep the rule
 * order above, which runs roughly "the books are wrong" → "the books are
 * behind", so the top of the list is always the thing that makes a report lie.
 */
export function reviewAccounting(snapshot: AccountingReviewSnapshot): AccountingFinding[] {
  const findings: AccountingFinding[] = [];
  for (const rule of RULES) {
    const finding = rule(snapshot);
    if (finding) findings.push(finding);
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export function filterFindings(
  findings: AccountingFinding[],
  minSeverity: AccountingReviewSeverity,
): AccountingFinding[] {
  return findings.filter((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minSeverity]);
}

/**
 * A short Persian headline for a digest, a chat reply, or the run's summary.
 *
 * `unavailableChecks` is not decoration: "nothing found" from a review that
 * only managed nine of its twelve checks reads as clean books, which is the one
 * thing an audit tool must never imply. Every caller that has the list — the
 * panel, the assistant's tool, a scheduled job — passes it, so the headline can
 * never assert more than the review actually established.
 */
export function summarizeFindings(findings: AccountingFinding[], unavailableChecks: string[] = []): string {
  const caveat = unavailableChecks.length
    ? ` ${toPersianDigits(unavailableChecks.length)} بررسی در این نوبت انجام نشد، پس این فهرست کامل نیست.`
    : "";
  if (findings.length === 0) {
    return unavailableChecks.length
      ? `در بررسی‌هایی که انجام شد اشکالی پیدا نشد، اما${caveat}`
      : "در بازبینی حساب‌ها اشکالی پیدا نشد.";
  }
  const high = findings.filter((finding) => finding.severity === "high").length;
  const medium = findings.filter((finding) => finding.severity === "medium").length;
  const low = findings.filter((finding) => finding.severity === "low").length;
  const parts: string[] = [];
  if (high) parts.push(`${toPersianDigits(high)} مورد بحرانی`);
  if (medium) parts.push(`${toPersianDigits(medium)} مورد مهم`);
  if (low) parts.push(`${toPersianDigits(low)} مورد جزئی`);
  return `بازبینی حساب‌ها: ${parts.join("، ")} پیدا شد.${caveat}`;
}

export const ACCOUNTING_REVIEW_SEVERITY_LABELS: Record<AccountingReviewSeverity, string> = {
  high: "بحرانی",
  medium: "مهم",
  low: "جزئی",
};
