"use client";

/**
 * «حساب‌های دریافتنی» — the receivables side of the subledger.
 *
 * This file is the side's *words, endpoints and payload keys* and nothing
 * else: the balances list, the aging report, the statement overlay and the
 * settle dialog all live once in `subledger-section.tsx`, shared with the
 * A/P mirror (`ap-section.tsx`). A/R keys a customer by their `parties` id —
 * the same id the one directory opens a file with — which is why every row's
 * `partyId` is the row's own id here, and why a negative balance wears
 * «بستانکار»: a customer who paid ahead has a credit, not a debt.
 *
 * The side also knows where its source records live: an A/R line raised by an
 * order can open that order (`/accounting/orders?order=<id>`, the deep link the
 * order queue already answers). A receipt or a cheque has no screen of its
 * own, so those lines drill into the journal entry instead — see
 * `SubledgerStatementPanel`.
 */

import { UNKNOWN_CUSTOMER_KEY } from "@/lib/aging";
import { accountingCustomerHref, accountingCustomersHref } from "./accounting-routes";
import { SubledgerSection, type SubledgerSide } from "./subledger-section";

interface CustomerBalance {
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  balance: number;
}

interface AgingRow {
  customerId: string;
  customerName: string;
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
}

interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, "customerId" | "customerName">;
}

interface ReconciliationSummaryPayload {
  receivableTotal: number;
  advanceTotal: number;
  netTotal: number;
  controlBalance: number;
  difference: number;
  reconciles: boolean;
}

interface BalancesPayload {
  customers?: CustomerBalance[];
  total?: number;
  summary?: ReconciliationSummaryPayload | null;
}

/** The receivables side — shared with the directory's statement overlay (`ar-statement-panel.tsx`). */
export const RECEIVABLES_SIDE: SubledgerSide = {
  eyebrow: "مطالبات مشتریان",
  title: "حساب‌های دریافتنی",
  description: "مانده حساب‌ها و نمای سنی بدهی مشتریان، بر پایه ثبت‌های فعلی.",
  partyNoun: "مشتری",
  balancesCaption: "مانده حساب‌های دریافتنی به تفکیک مشتری",
  agingCaption: "نمای سنی بدهی مشتریان",
  emptyBalances: "هیچ حساب دریافتنی بازی وجود ندارد.",
  loadBalancesFailed: "بارگذاری مانده‌های دریافتنی ناموفق بود.",
  noSearchMatches: "مشتری‌ای با این جست‌وجو پیدا نشد.",
  agingTotalLabel: "جمع کل حساب‌های دریافتنی",
  directoryHref: accountingCustomersHref(),
  directoryLinkLabel: "مشتریان در حسابداری",
  searchLabel: "جست‌وجوی مشتری",

  unknownKey: UNKNOWN_CUSTOMER_KEY,
  listEndpoint: "/api/ledger/ar/customers",
  agingEndpoint: "/api/ledger/ar/aging",
  readBalances: (raw) => {
    const data = raw as BalancesPayload;
    const rows = data.customers ?? [];
    return {
      rows: rows.map((c) => ({
        id: c.customerId,
        name: c.customerName,
        phone: c.customerPhone,
        balance: c.balance,
        // A/R's id *is* the party's id in the one directory.
        partyId: c.customerId,
      })),
      // An endpoint that answered without a window (an older caller, a mock)
      // still yields a usable total rather than «۰ از ۰».
      total: data.total ?? rows.length,
      summary: data.summary
        ? {
            primaryTotal: data.summary.receivableTotal,
            advanceTotal: data.summary.advanceTotal,
            netTotal: data.summary.netTotal,
            controlBalance: data.summary.controlBalance,
            difference: data.summary.difference,
            reconciles: data.summary.reconciles,
          }
        : null,
    };
  },
  readAging: (raw) => {
    const data = raw as AgingReport;
    return {
      asOfDate: data.asOfDate,
      rows: (data.rows ?? []).map((r) => ({
        id: r.customerId,
        name: r.customerName,
        current: r.current,
        d31_60: r.d31_60,
        d61_90: r.d61_90,
        over90: r.over90,
        total: r.total,
        partyId: r.customerId,
      })),
      totals: data.totals,
    };
  },

  negativeBalanceLabel: "بستانکار / پیش‌پرداخت مشتری",

  summary: {
    primaryLabel: "جمع مطالبات",
    advanceLabel: "پیش‌دریافت و بستانکاری مشتریان",
    netLabel: "خالص مطالبات",
    controlLabel: "مانده حساب کنترل دریافتنی",
    reconciled: "با حساب کنترل مطابقت دارد",
    difference: "تفاوت با حساب کنترل",
  },

  settle: {
    actionLabel: "دریافت وجه",
    headingId: "receive-payment-heading",
    endpoint: "/api/ledger/ar/receipts",
    idField: "customerId",
    dateField: "receiptDate",
    eyebrow: "ثبت دریافت",
    titlePrefix: "دریافت وجه از ",
    methodLabel: "روش دریافت",
    dateLabel: "تاریخ دریافت (اختیاری)",
    submitLabel: "ثبت دریافت",
  },

  statement: {
    headingId: "ar-statement-heading",
    endpointFor: (id) => `/api/ledger/ar/customers/${id}`,
    typeLabels: {
      invoice: "فاکتور",
      receipt: "دریافت",
      other: "سایر",
    },
    caption: "گردش حساب این مشتری",
    empty: "هنوز فعالیتی برای این مشتری ثبت نشده است.",
    failed: "بارگذاری صورت‌حساب این مشتری ناموفق بود.",
    directoryLabel: "مشتریان در حسابداری",
    directoryHrefFor: (id, partyId) =>
      id !== UNKNOWN_CUSTOMER_KEY && partyId ? accountingCustomerHref(partyId) : null,
    sourceColumnLabel: "منبع",
    entryLinkLabel: "نمایش سند",
    entryFailed: "بارگذاری سند حسابداری این ردیف ناموفق بود.",
    // The order queue answers `?order=<id>` (see `orders/[id]/page.tsx`), so
    // an invoice line can open the sale it came from. The amendment bridge is
    // resolved server-side, so a corrected order still links to itself.
    orderHrefFor: (source) => (source?.orderId ? `/accounting/orders?order=${encodeURIComponent(source.orderId)}` : null),
    orderLinkLabel: "مشاهدهٔ سفارش",
  },
};

/**
 * The receivables screen. `canSettle` is the member's effective
 * `finance.receivables_manage` — the same permission the receipts endpoint
 * enforces — and nothing is drawn from it here: a member holding only
 * `ledger.view` reads the balances, the aging and the statements, and sees no
 * receive action at all.
 */
export function ArSection({ canSettle }: { canSettle: boolean }) {
  return <SubledgerSection side={RECEIVABLES_SIDE} canSettle={canSettle} />;
}
