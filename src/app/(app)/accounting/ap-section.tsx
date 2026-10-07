"use client";

/**
 * «حساب‌های پرداختنی» — the payables side of the subledger.
 *
 * This file is the side's *words, endpoints and payload keys* and nothing
 * else: the balances list, the aging report, the statement overlay and the
 * settle dialog all live once in `subledger-section.tsx`, shared with the
 * A/R mirror (`ar-section.tsx`).
 *
 * The one real difference from A/R is the keying: `supplierId` is the
 * supplier's *branch alias*, not their `parties` id, so the directory deep
 * link has to travel as the separate `supplierPartyId` the balances payload
 * carries. The aging payload names no party at all, so its rows open the
 * statement without the directory link rather than linking by a guess.
 *
 * A/P lines have no destination of their own: a purchase has no screen at the
 * alias id, so `orderHrefFor` is deliberately absent and every line drills
 * into its journal entry instead.
 */

import { UNKNOWN_SUPPLIER_KEY } from "@/lib/aging";
import { accountingSuppliersHref, accountingSupplierHref } from "./accounting-routes";
import { SubledgerSection, type SubledgerSide } from "./subledger-section";

interface SupplierBalance {
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierPartyId: string | null;
  balance: number;
}

interface AgingRow {
  supplierId: string;
  supplierName: string;
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
}

interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, "supplierId" | "supplierName">;
}

interface ReconciliationSummaryPayload {
  payableTotal: number;
  advanceTotal: number;
  netTotal: number;
  controlBalance: number;
  difference: number;
  reconciles: boolean;
}

interface BalancesPayload {
  suppliers?: SupplierBalance[];
  total?: number;
  summary?: ReconciliationSummaryPayload | null;
}

/** The payables side — shared with the directory's statement overlay (`ap-statement-panel.tsx`). */
export const PAYABLES_SIDE: SubledgerSide = {
  eyebrow: "تعهدات تأمین‌کنندگان",
  title: "حساب‌های پرداختنی",
  description: "مانده حساب‌ها و نمای سنی بدهی تأمین‌کنندگان، بر پایه ثبت‌های فعلی.",
  partyNoun: "تأمین‌کننده",
  balancesCaption: "مانده حساب‌های پرداختنی به تفکیک تأمین‌کننده",
  agingCaption: "نمای سنی بدهی به تأمین‌کنندگان",
  emptyBalances: "هیچ حساب پرداختنی بازی وجود ندارد.",
  loadBalancesFailed: "بارگذاری مانده‌های پرداختنی ناموفق بود.",
  noSearchMatches: "تأمین‌کننده‌ای با این جست‌وجو پیدا نشد.",
  agingTotalLabel: "جمع کل حساب‌های پرداختنی",
  directoryHref: accountingSuppliersHref(),
  directoryLinkLabel: "تأمین‌کنندگان در حسابداری",
  searchLabel: "جست‌وجوی تأمین‌کننده",

  unknownKey: UNKNOWN_SUPPLIER_KEY,
  listEndpoint: "/api/ledger/ap/suppliers",
  agingEndpoint: "/api/ledger/ap/aging",
  readBalances: (raw) => {
    const data = raw as BalancesPayload;
    const rows = data.suppliers ?? [];
    return {
      rows: rows.map((s) => ({
        id: s.supplierId,
        name: s.supplierName,
        phone: s.supplierPhone,
        balance: s.balance,
        partyId: s.supplierPartyId,
      })),
      total: data.total ?? rows.length,
      summary: data.summary
        ? {
            primaryTotal: data.summary.payableTotal,
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
        id: r.supplierId,
        name: r.supplierName,
        current: r.current,
        d31_60: r.d31_60,
        d61_90: r.d61_90,
        over90: r.over90,
        total: r.total,
        // The aging payload names the branch alias only; the directory link
        // stays hidden rather than pointing at a guessed party.
        partyId: null,
      })),
      totals: data.totals,
    };
  },

  marksCreditBalances: false,

  summary: {
    primaryLabel: "جمع بدهی به تأمین‌کنندگان",
    advanceLabel: "پیش‌پرداخت به تأمین‌کنندگان",
    netLabel: "خالص بدهی",
    controlLabel: "مانده حساب کنترل پرداختنی",
    reconciled: "با حساب کنترل مطابقت دارد",
    difference: "تفاوت با حساب کنترل",
  },

  settle: {
    actionLabel: "ثبت پرداخت",
    headingId: "pay-bill-heading",
    endpoint: "/api/ledger/ap/payments",
    idField: "supplierId",
    dateField: "paymentDate",
    eyebrow: "ثبت پرداخت",
    titlePrefix: "پرداخت به ",
    methodLabel: "روش پرداخت",
    dateLabel: "تاریخ پرداخت (اختیاری)",
    submitLabel: "ثبت پرداخت",
  },

  statement: {
    headingId: "ap-statement-heading",
    endpointFor: (id) => `/api/ledger/ap/suppliers/${id}`,
    typeLabels: {
      bill: "فاکتور",
      payment: "پرداخت",
      return: "برگشت",
      other: "سایر",
    },
    caption: "گردش حساب این تأمین‌کننده",
    empty: "هنوز فعالیتی برای این تأمین‌کننده ثبت نشده است.",
    failed: "بارگذاری صورت‌حساب این تأمین‌کننده ناموفق بود.",
    directoryLabel: "تأمین‌کنندگان در حسابداری",
    directoryHrefFor: (id, partyId) =>
      id !== UNKNOWN_SUPPLIER_KEY && partyId ? accountingSupplierHref(partyId) : null,
    sourceColumnLabel: "منبع",
    entryLinkLabel: "نمایش سند",
    entryFailed: "بارگذاری سند حسابداری این ردیف ناموفق بود.",
  },
};

/**
 * The payables screen — `canSettle` is the member's effective
 * `finance.payables_manage`, the permission `ap/payments` enforces. See
 * `ar-section.tsx` for why it is a configuration value and not a check here.
 */
export function ApSection({ canSettle }: { canSettle: boolean }) {
  return <SubledgerSection side={PAYABLES_SIDE} canSettle={canSettle} />;
}
