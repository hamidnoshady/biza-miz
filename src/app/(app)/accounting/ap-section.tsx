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
  locationName: string | null;
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
  locationName: string | null;
}

interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, "supplierId" | "supplierName" | "locationName">;
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
  description: "مانده حساب‌ها و نمای سنی بدهی تأمین‌کنندگان، بر پایه ثبت‌های فعلی. ماندهٔ منفی یعنی پیش‌پرداخت یا بستانکاری شما نزد تأمین‌کننده، نه بدهی.",
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
  unknownExplanation: "ماندهٔ «بدون تأمین‌کننده مشخص» یک استثنای تطبیق است، نه حساب یک تأمین‌کننده. ردیف‌ها در صورت‌حساب این بخش، همراه با منبع، وضعیت انتساب و پیوند دقیق به سند روزنامه بررسی می‌شوند.",

  unknownKey: UNKNOWN_SUPPLIER_KEY,
  listEndpoint: "/api/ledger/ap/suppliers",
  agingEndpoint: "/api/ledger/ap/aging",
  readBalances: (raw) => {
    const data = raw as BalancesPayload;
    const rows = data.suppliers ?? [];
    return {
      rows: rows.map((s) => ({
        id: s.supplierId,
        name: s.supplierId === UNKNOWN_SUPPLIER_KEY ? "استثنای تطبیق — بدون تأمین‌کننده" : s.supplierName,
        phone: s.supplierPhone,
        balance: s.balance,
        partyId: s.supplierPartyId,
        locationName: s.locationName,
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
        name: r.supplierId === UNKNOWN_SUPPLIER_KEY ? "استثنای تطبیق — بدون تأمین‌کننده" : r.supplierName,
        current: r.current,
        d31_60: r.d31_60,
        d61_90: r.d61_90,
        over90: r.over90,
        total: r.total,
        // The aging payload names the branch alias only; the directory link
        // stays hidden rather than pointing at a guessed party.
        partyId: null,
        locationName: r.locationName,
      })),
      totals: data.totals,
    };
  },

  negativeBalanceLabel: "پیش‌پرداخت / بستانکاری نزد تأمین‌کننده",
  negativeSettleActionLabel: "افزودن پیش‌پرداخت",
  negativeTitlePrefix: "پیش‌پرداخت به ",
  negativeBalanceMessage: "ماندهٔ منفی یعنی پیش‌پرداخت یا بستانکاری شما نزد این تأمین‌کننده است، نه بدهی. پرداخت تازه، مبلغ پیش‌پرداخت را بیشتر می‌کند.",

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
      payment_reversal: "برگشت پرداخت",
      return: "برگشت",
      cheque: "رویداد چک",
      interest: "سود اقساط",
      adjustment: "تعدیل / استثنای تطبیق",
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
    /*
     * Only A/P has an attribution contract to explain: a line with no supplier
     * is either a deliberate control-account adjustment or a source that was
     * added without an attribution rule, and the two must not look alike in a
     * report whose job is reconciling to GL 2100.
     */
    attributionNoteFor: (status) => {
      switch (status) {
        case "intentional_unknown":
          return "استثنای آگاهانه؛ بدون طرف معین";
        case "automatic_missing":
          return "خطای تطبیق؛ منبع خودکار بدون تأمین‌کننده";
        case "conditional_missing":
          return "نیازمند بررسی؛ انتساب مشروط پیدا نشد";
        case "unclassified":
          return "منبع هنوز در قرارداد انتساب دسته‌بندی نشده";
        default:
          return null;
      }
    },
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
