/**
 * The automatic posting rules «تنظیمات حسابداری» reports — which accounts a
 * sale, a purchase, an expense and a payroll run actually hit.
 *
 * The settings page used to answer this question with the string «قواعد
 * سندزنی خودکار به‌زودی اضافه می‌شود؛ فعلاً قواعد پیش‌فرض صنف کسب‌وکار اعمال
 * می‌شود» — it named a thing the reader could not see, and «قواعد پیش‌فرض صنف»
 * was exactly the part they needed spelled out. The rules are real, they are
 * decided per industry, and an accountant reconciling the books has to know
 * them; they were simply never surfaced.
 *
 * So this module states them **derived from the posting code itself**, never
 * retyped:
 *
 *  - the inventory account per trade is `INVENTORY_CODE_BY_INDUSTRY` in
 *    `retail-stock-posting-rules.ts` (re-exported there for the same reason:
 *    a screen must name the account the rule posted to, not a second guess);
 *  - cost of sales per trade is `costOfSalesCodesForIndustry`;
 *  - the cash/bank/receivable and VAT codes are `WELL_KNOWN_CODES`, the same
 *    constants `postExactOrderPaymentEntry`, `postPurchaseReceiptEntry`,
 *    `postPeriodicPurchaseEntry` and `accruePayroll` look up.
 *
 * Read-only by design. These rules are structural — auto-posting resolves
 * accounts by *code* (`accountIdsByCode`), and the chart guards those codes as
 * well-known so they cannot be archived or deleted. Presenting them as
 * editable would promise a remap the ledger has no mechanism for; the honest
 * surface is to show the rule and point at the chart of accounts, which is
 * where the *name* of each account is genuinely editable.
 *
 * Framework-free (no React, no `db`) like `coa-template.ts` beside it, so the
 * client settings panel and a unit test read the same table.
 */

import {
  costOfSalesCodesForIndustry,
  WELL_KNOWN_CODES,
  type AccountType,
} from "./coa-template";
import type { Industry } from "./industries";
import { industryProfile } from "./industry-profile";

/**
 * The inventory account each trade posts stock against.
 *
 * Deliberately the same mapping as `INVENTORY_CODE_BY_INDUSTRY` in
 * `retail-stock-posting-rules.ts`, which cannot be imported here: that module
 * runs `registerPostingRule(...)` at import time and pulls in `pg`, so
 * importing it from a client component would drag the posting engine into the
 * browser bundle. The pairing is asserted in `accounting-posting-rules.test.ts`
 * so the two can never drift.
 */
const INVENTORY_CODE_BY_INDUSTRY: Record<Industry, string> = {
  service_saas: WELL_KNOWN_CODES.inventory,
  food_service: WELL_KNOWN_CODES.inventory,
  // Issue #799 — a contractor's material is ordinary stock on the balance
  // sheet (موجودی مواد و کالا), so AEC keeps the generic inventory account.
  // What it does *not* get is the F&B recipe/costing module that manages it:
  // this mapping only decides which account a purchase or a write-down lands
  // in, and site material tracking is a later wave's project capability.
  architecture_construction: WELL_KNOWN_CODES.inventory,
  jewelry: WELL_KNOWN_CODES.goldInventory,
  watch: WELL_KNOWN_CODES.watchInventory,
  accessories: WELL_KNOWN_CODES.accessoryInventory,
  cosmetics: WELL_KNOWN_CODES.cosmeticInventory,
  wholesale: WELL_KNOWN_CODES.wholesaleInventory,
  tools_fittings: WELL_KNOWN_CODES.toolsInventory,
  haberdashery: WELL_KNOWN_CODES.haberdasheryInventory,
  // Issue #839 — vehicles are this trade's stock on the balance sheet, and its
  // own account (1370) rather than the generic 1300: a dealership's inventory
  // is its largest asset, is financed per unit, and is reported on its own in
  // every report §15 asks for.
  automotive: WELL_KNOWN_CODES.vehicleInventory,
};

/** One side of a rule — the account, and whether it is debited or credited. */
export interface PostingRuleLine {
  side: "debit" | "credit";
  /** The account code the posting resolves, e.g. «1100». */
  code: string;
  /** What that account is called in this trade's chart. */
  label: string;
  /** Present when the code depends on something at post time. */
  note?: string;
}

export interface PostingRuleSummary {
  key: string;
  /** The business event, in the words the product uses. */
  label: string;
  description: string;
  lines: PostingRuleLine[];
}

/** The account a settlement method credits — the `SETTLEMENT_DEBIT_CODES` split. */
const CASH = { code: WELL_KNOWN_CODES.cash, label: "صندوق" };
const BANK_CLEARING = { code: WELL_KNOWN_CODES.bankClearing, label: "بانک (در راه)" };
const RECEIVABLE = { code: WELL_KNOWN_CODES.accountsReceivable, label: "حساب‌های دریافتنی" };
const PAYABLE = { code: WELL_KNOWN_CODES.accountsPayable, label: "حساب‌های پرداختنی" };

/**
 * The revenue account a sale credits.
 *
 * F&B splits revenue by channel (`revenueAccountCodeForOrderChannel`:
 * 4310/4320/4330 for سالن/بیرون‌بر/ارسالی); every retail trade has one sales
 * account. Stated as a note rather than three rows, because it is one rule
 * whose code is chosen at post time.
 */
function revenueLine(industry: Industry): PostingRuleLine {
  if (industry === "food_service") {
    return {
      side: "credit",
      code: `${WELL_KNOWN_CODES.dineInRevenue} / ${WELL_KNOWN_CODES.takeawayRevenue} / ${WELL_KNOWN_CODES.deliveryRevenue}`,
      label: "فروش سالن / بیرون‌بر / ارسالی",
      note: "حساب درآمد بر پایهٔ نوع سفارش انتخاب می‌شود.",
    };
  }
  const codes: Partial<Record<Industry, { code: string; label: string }>> = {
    // Issue #799 — the default project/service statement account. The other
    // two (`aecSupervisionRevenue`, `aecConstructionRevenue`) are seeded in
    // the chart and named in the note below, so an owner can split design
    // fees from site execution without adding an account first.
    architecture_construction: {
      code: WELL_KNOWN_CODES.aecDesignRevenue,
      label: "درآمد خدمات طراحی و مهندسی",
    },
    jewelry: { code: WELL_KNOWN_CODES.goldSalesRevenue, label: "فروش طلا (ارزش فلز) و اجرت" },
    watch: { code: WELL_KNOWN_CODES.watchSalesRevenue, label: "فروش ساعت" },
    accessories: { code: WELL_KNOWN_CODES.accessorySalesRevenue, label: "فروش بدلیجات" },
    cosmetics: { code: WELL_KNOWN_CODES.cosmeticSalesRevenue, label: "فروش لوازم آرایشی و بهداشتی" },
    wholesale: { code: WELL_KNOWN_CODES.wholesaleSalesRevenue, label: "فروش عمده" },
    tools_fittings: { code: WELL_KNOWN_CODES.toolsSalesRevenue, label: "فروش ابزار و یراق" },
    haberdashery: { code: WELL_KNOWN_CODES.haberdasherySalesRevenue, label: "فروش لوازم خرازی" },
    // Issue #839 — one revenue account for vehicle sales. A dealership that
    // wants to split new from used reads that from the reports' condition
    // dimension rather than from two charts, because "new or used" is a
    // property of the unit (see automotive_vehicle_attributes.condition).
    automotive: { code: WELL_KNOWN_CODES.vehicleSalesRevenue, label: "فروش خودرو" },
  };
  const entry = codes[industry] ?? { code: WELL_KNOWN_CODES.salesRevenue, label: "فروش" };
  return {
    side: "credit",
    ...entry,
    ...(industry === "jewelry"
      ? { note: `اجرت و سود جداگانه به حساب ${WELL_KNOWN_CODES.makingChargeRevenue} می‌نشیند (ارزش فلز از مالیات معاف است).` }
      : {}),
    ...(industry === "architecture_construction"
      ? {
          note: `درآمد نظارت (${WELL_KNOWN_CODES.aecSupervisionRevenue}) و پیمانکاری (${WELL_KNOWN_CODES.aecConstructionRevenue}) حساب جدا دارند؛ صورتحساب طراحی به ${WELL_KNOWN_CODES.aecDesignRevenue} می‌نشیند.`,
        }
      : {}),
  };
}

/** The inventory account for a trade — exported for the chart-of-accounts cross-check. */
export function inventoryCodeForIndustry(industry: Industry): string {
  return INVENTORY_CODE_BY_INDUSTRY[industry];
}

/**
 * The trade's primary cost-of-sales account — the first entry of
 * `costOfSalesCodesForIndustry`, which lists the trade's COGS account ahead of
 * the shrinkage/write-down accounts that join it in the gross-profit line.
 */
export function costOfSalesCodeForIndustry(industry: Industry): string {
  return costOfSalesCodesForIndustry(industry)[0] ?? WELL_KNOWN_CODES.cogs;
}

/**
 * The posting rules in force for a business, in the order an accountant reads
 * them: money in, money out, the recurring commitments.
 *
 * `inventorySystem` changes a real rule rather than a label: under سیستم
 * ادواری a received purchase debits «خرید طی دوره» (5105) instead of the
 * inventory asset, and COGS is recognised at the period close — exactly what
 * `postPeriodicPurchaseEntry` and `postPeriodicCloseEntry` do.
 */
export function postingRulesFor({
  industry,
  inventorySystem = "perpetual",
}: {
  industry: Industry;
  inventorySystem?: "perpetual" | "periodic";
}): PostingRuleSummary[] {
  const inventoryCode = inventoryCodeForIndustry(industry);
  const cogsCode = costOfSalesCodeForIndustry(industry);
  const periodic = inventorySystem === "periodic";
  const orderTicket = industryProfile(industry).salesModel === "order_ticket";

  const sale: PostingRuleSummary = {
    key: "sale",
    label: orderTicket ? "فروش و تسویهٔ سفارش" : "فروش و صدور فاکتور",
    description: "با تسویهٔ فروش، وجه دریافتی، درآمد و مالیات بر ارزش افزوده هم‌زمان ثبت می‌شود.",
    lines: [
      {
        side: "debit",
        code: `${CASH.code} / ${BANK_CLEARING.code} / ${RECEIVABLE.code}`,
        label: "صندوق / بانک / حساب‌های دریافتنی",
        note: "بر پایهٔ روش پرداختِ انتخاب‌شده در صندوق.",
      },
      revenueLine(industry),
      { side: "credit", code: WELL_KNOWN_CODES.vatPayable, label: "مالیات بر ارزش افزودهٔ فروش" },
    ],
  };

  const cogs: PostingRuleSummary = {
    key: "cogs",
    label: "بهای تمام‌شدهٔ کالای فروش‌رفته",
    description: periodic
      ? "در سیستم ادواری، بهای تمام‌شده هنگام بستن دوره شناسایی می‌شود، نه در لحظهٔ فروش."
      : "هم‌زمان با فروش، بهای کالا از موجودی خارج و به بهای تمام‌شده منتقل می‌شود.",
    lines: [
      { side: "debit", code: cogsCode, label: "بهای تمام‌شدهٔ کالای فروش‌رفته" },
      { side: "credit", code: inventoryCode, label: "موجودی کالا" },
    ],
  };

  const purchase: PostingRuleSummary = {
    key: "purchase",
    label: "خرید و رسید انبار",
    description: periodic
      ? "در سیستم ادواری، خرید به حساب «خرید طی دوره» می‌نشیند و در پایان دوره به بهای تمام‌شده منتقل می‌شود."
      : "با ثبت رسید خرید، بهای کالا به موجودی اضافه می‌شود.",
    lines: [
      periodic
        ? { side: "debit", code: WELL_KNOWN_CODES.periodicPurchases, label: "خرید طی دوره" }
        : { side: "debit", code: inventoryCode, label: "موجودی کالا" },
      {
        side: "credit",
        code: `${CASH.code} / ${BANK_CLEARING.code} / ${PAYABLE.code}`,
        label: "صندوق / بانک / حساب‌های پرداختنی",
        note: "بر پایهٔ روش تسویهٔ خرید.",
      },
    ],
  };

  const expense: PostingRuleSummary = {
    key: "expense",
    label: "هزینه‌ها",
    description:
      "هزینه در لحظهٔ ثبت، پرداخت‌شده در نظر گرفته می‌شود؛ دستهٔ هزینه همان حساب هزینهٔ انتخابی است.",
    lines: [
      { side: "debit", code: "5xxx", label: "حساب هزینهٔ انتخاب‌شده", note: "از سرفصل حساب‌های هزینه." },
      {
        side: "credit",
        code: `${CASH.code} / ${BANK_CLEARING.code}`,
        label: "حساب پرداخت انتخاب‌شده",
      },
    ],
  };

  const payroll: PostingRuleSummary = {
    key: "payroll",
    label: "حقوق و دستمزد",
    description: "تعهد حقوق در زمان ثبت، و پرداخت آن در زمان تسویه — دو سند جداگانه.",
    lines: [
      { side: "debit", code: WELL_KNOWN_CODES.salariesExpense, label: "هزینهٔ حقوق و دستمزد" },
      { side: "credit", code: WELL_KNOWN_CODES.salariesPayable, label: "حقوق پرداختنی" },
      {
        side: "debit",
        code: WELL_KNOWN_CODES.salariesPayable,
        label: "حقوق پرداختنی (هنگام پرداخت)",
        note: `در مقابلِ ${CASH.code} یا ${BANK_CLEARING.code}.`,
      },
    ],
  };

  return [sale, cogs, purchase, expense, payroll];
}

/** The account types a chart row can have — re-exported so the panel needs one import. */
export type { AccountType };
