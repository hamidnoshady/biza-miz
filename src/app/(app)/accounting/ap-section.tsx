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
  agingTotalLabel: "جمع کل حساب‌های پرداختنی",
  directoryHref: accountingSuppliersHref(),
  directoryLinkLabel: "تأمین‌کنندگان در حسابداری",
  unknownExplanation: "ماندهٔ «بدون تأمین‌کننده مشخص» یک استثنای تطبیق است، نه حساب یک تأمین‌کننده. ردیف‌ها در صورتحساب این بخش، همراه با منبع، وضعیت انتساب و پیوند دقیق به سند روزنامه بررسی می‌شوند.",

  unknownKey: UNKNOWN_SUPPLIER_KEY,
  listEndpoint: "/api/ledger/ap/suppliers",
  agingEndpoint: "/api/ledger/ap/aging",
  readParties: (raw) => {
    const data = raw as { suppliers?: SupplierBalance[] };
    return (data.suppliers ?? []).map((s) => ({
      id: s.supplierId,
      name: s.supplierId === UNKNOWN_SUPPLIER_KEY ? "استثنای تطبیق — بدون تأمین‌کننده" : s.supplierName,
      phone: s.supplierPhone,
      balance: s.balance,
      partyId: s.supplierPartyId,
      locationName: s.locationName,
    }));
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
    failed: "بارگذاری صورتحساب این تأمین‌کننده ناموفق بود.",
    directoryLabel: "تأمین‌کنندگان در حسابداری",
    directoryHrefFor: (id, partyId) =>
      id !== UNKNOWN_SUPPLIER_KEY && partyId ? accountingSupplierHref(partyId) : null,
  },
};

export function ApSection({ canSettle = false }: { canSettle?: boolean }) {
  return <SubledgerSection side={PAYABLES_SIDE} canSettle={canSettle} />;
}
