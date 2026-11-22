/**
 * «تحلیل مالی» — the financial-ratio catalogue and its arithmetic, as pure
 * functions.
 *
 * This is a DERIVED reporting layer, not a second source of truth. It never
 * stores a balance and never reads anything but the inputs the calculation
 * service hands it, which are read from the authoritative journal lines (see
 * `financial-ratios-service.ts`). The service decides *which* accounts make up
 * each input; this file decides what the ratio means and what happens when it
 * cannot be computed.
 *
 * ## The three rules every ratio here follows
 *
 *  1. **A missing input is never zero.** If the ledger cannot supply a value,
 *     the ratio is `unavailable` with a reason and the inputs that were missing.
 *  2. **A denominator that is zero, negative, or economically meaningless is
 *     never turned into a number.** No `Infinity`, no `NaN`, no fabricated
 *     estimate — `unavailable`/`not_applicable` with the reason.
 *  3. **Exact arithmetic, presentation rounding.** Amounts are integer Rial and
 *     the arithmetic runs in `decimal.js`; rounding happens only in
 *     `formatRatioValue`, which is also what the export uses, so the file and
 *     the screen show the same figure.
 *
 * ## Period conventions
 *
 *  - `movement` — an income-statement measure for the selected period
 *    (revenue, COGS, expenses, net income). Never a year-to-date figure.
 *  - `point_in_time` — a balance-sheet measure as of the period end.
 *  - `average_balance` — the mean of the balance at `dateFrom - 1` and at
 *    `dateTo`. Without an opening balance the ratio is unavailable; the fallback
 *    of using the closing balance alone would quietly change what the ratio
 *    means.
 *
 * ## Versioning
 *
 * `FINANCIAL_RATIO_CATALOGUE_VERSION` changes whenever a formula, an input
 * definition or an account-classification rule changes. The report prints it so
 * a figure can be traced to the definition that produced it.
 */
import Decimal from "decimal.js";
import { toPersianDigits } from "./digits";

export const FINANCIAL_RATIO_CATALOGUE_VERSION = "1.0.0";

export type RatioGroup = "liquidity" | "leverage" | "profitability" | "efficiency";

/** The order the report groups are read in: can we pay, how are we funded, do we earn, how hard do the assets work. */
export const RATIO_GROUP_ORDER: readonly RatioGroup[] = [
  "liquidity",
  "leverage",
  "profitability",
  "efficiency",
];

export const RATIO_GROUP_LABELS: Record<RatioGroup, string> = {
  liquidity: "نقدینگی",
  leverage: "اهرم و توان بازپرداخت",
  profitability: "سودآوری",
  efficiency: "کارایی عملیاتی",
};

export const RATIO_GROUP_DESCRIPTIONS: Record<RatioGroup, string> = {
  liquidity: "توان پرداخت بدهی‌های جاری از دارایی‌های جاری.",
  leverage: "سهم بدهی در تأمین دارایی‌ها و توان پوشش هزینهٔ بهره.",
  profitability: "سود باقی‌مانده از هر ریال فروش و بازده سرمایهٔ به‌کارگرفته‌شده.",
  efficiency: "سرعت گردش موجودی، مطالبات و بدهی‌ها در دورهٔ انتخابی.",
};

export type RatioUnit = "ratio" | "percent" | "days";

export type RatioPeriodConvention = "movement" | "point_in_time" | "average_balance";

/** Where a ratio's inputs come from, named the way the report library names its statements. */
export type RatioSourceReport = "profit_and_loss" | "balance_sheet" | "ledger";

export const RATIO_SOURCE_LABELS: Record<RatioSourceReport, string> = {
  profit_and_loss: "صورت سود و زیان",
  balance_sheet: "ترازنامه",
  ledger: "دفتر کل",
};

/** Every value a ratio may need. The service fills absent ones with `null`, never `0`. */
export type RatioInputKey =
  | "cashAndEquivalents"
  | "tradeReceivables"
  | "tradePayables"
  | "inventory"
  | "currentAssets"
  | "currentLiabilities"
  | "totalAssets"
  | "totalLiabilities"
  | "totalEquity"
  | "netRevenue"
  | "costOfSales"
  | "grossProfit"
  | "operatingExpenses"
  | "operatingProfit"
  | "interestExpense"
  | "netIncome"
  | "periodDays"
  | "openingTotalAssets"
  | "openingTotalEquity"
  | "openingInventory"
  | "openingTradeReceivables"
  | "openingTradePayables";

export const RATIO_INPUT_LABELS: Record<RatioInputKey, string> = {
  cashAndEquivalents: "نقد و معادل نقد (صندوق، بانک و تنخواه)",
  tradeReceivables: "دریافتنی‌های تجاری از مشتریان",
  tradePayables: "پرداختنی‌های تجاری به تأمین‌کنندگان",
  inventory: "موجودی کالا و کار در جریان",
  currentAssets: "کل دارایی‌های جاری",
  currentLiabilities: "کل بدهی‌های جاری",
  totalAssets: "کل دارایی‌ها",
  totalLiabilities: "کل بدهی‌ها",
  totalEquity: "حقوق صاحبان سرمایه (با سود انباشته)",
  netRevenue: "درآمد خالص دوره",
  costOfSales: "بهای تمام‌شدهٔ فروش",
  grossProfit: "سود ناخالص",
  operatingExpenses: "هزینه‌های عملیاتی (بدون بهای تمام‌شده و بهره)",
  operatingProfit: "سود عملیاتی",
  interestExpense: "هزینهٔ بهره",
  netIncome: "سود (زیان) خالص",
  periodDays: "تعداد روزهای دوره",
  openingTotalAssets: "کل دارایی‌ها در ابتدای دوره",
  openingTotalEquity: "حقوق صاحبان سرمایه در ابتدای دوره",
  openingInventory: "موجودی کالا در ابتدای دوره",
  openingTradeReceivables: "دریافتنی‌های تجاری در ابتدای دوره",
  openingTradePayables: "پرداختنی‌های تجاری در ابتدای دوره",
};

export type RatioStatus = "available" | "unavailable" | "not_applicable";

export type RatioReasonCode =
  | "missing_input"
  | "zero_denominator"
  | "negative_denominator"
  | "non_positive_numerator"
  | "no_revenue"
  | "non_positive_equity"
  | "no_opening_comparative"
  | "no_period_days"
  | "interest_expense_not_classified"
  | "derived_unavailable";

export const RATIO_REASON_LABELS: Record<RatioReasonCode, string> = {
  missing_input: "دادهٔ لازم برای محاسبه در گزارش‌های منبع در دسترس نیست.",
  zero_denominator: "مخرج کسر صفر است؛ نسبت تعریف‌شده نیست.",
  negative_denominator: "مخرج کسر منفی است؛ نسبت معنادار نیست.",
  non_positive_numerator: "صورت کسر صفر یا منفی است؛ این نسبت معنادار نیست.",
  no_revenue: "درآمد خالص دوره صفر یا منفی است؛ نسبت حاشیه معنا ندارد.",
  non_positive_equity: "حقوق صاحبان سرمایه صفر یا منفی است؛ این نسبت معنادار نیست.",
  no_opening_comparative: "ماندهٔ ابتدای دوره در دسترس نیست؛ برای این نسبت میانگین ابتدا و پایان دوره لازم است.",
  no_period_days: "طول دورهٔ انتخابی معتبر نیست.",
  interest_expense_not_classified: "حساب هزینهٔ بهره برای این کسب‌وکار تعیین نشده است؛ تا تعیین آن، نسبت پوشش بهره محاسبه نمی‌شود.",
  derived_unavailable: "نسبت پایهٔ لازم برای این عدد در دسترس نیست.",
};

export type RatioKey =
  | "current_ratio"
  | "quick_ratio"
  | "cash_ratio"
  | "debt_to_assets"
  | "debt_to_equity"
  | "interest_coverage"
  | "gross_margin"
  | "operating_margin"
  | "net_margin"
  | "return_on_assets"
  | "return_on_equity"
  | "inventory_turnover"
  | "days_inventory_outstanding"
  | "receivables_turnover"
  | "days_sales_outstanding"
  | "payables_turnover"
  | "days_payable_outstanding"
  | "asset_turnover";

/** The one documented definition of a ratio. Everything the report prints about a ratio comes from here. */
export interface RatioDefinition {
  key: RatioKey;
  label: string;
  group: RatioGroup;
  unit: RatioUnit;
  /** What the ratio answers, in plain language — descriptive, never advice. */
  explanation: string;
  /** The formula exactly as it is computed. */
  formula: string;
  /** Human-readable numerator / denominator, for the documentation and the detail panel. */
  numerator: string;
  denominator: string;
  periodConvention: RatioPeriodConvention;
  source: RatioSourceReport;
  /** Inputs the formula must have. `null` for any of them makes the ratio unavailable. */
  requires: readonly RatioInputKey[];
}

export const FINANCIAL_RATIO_DEFINITIONS: readonly RatioDefinition[] = [
  {
    key: "current_ratio",
    label: "نسبت جاری",
    group: "liquidity",
    unit: "ratio",
    explanation:
      "برای هر ریال بدهی جاری، چند ریال دارایی جاری وجود دارد. عدد بزرگ‌تر از یک یعنی دارایی‌های جاری بدهی‌های جاری را پوشش می‌دهند.",
    formula: "دارایی‌های جاری ÷ بدهی‌های جاری",
    numerator: "دارایی‌های جاری",
    denominator: "بدهی‌های جاری",
    periodConvention: "point_in_time",
    source: "balance_sheet",
    requires: ["currentAssets", "currentLiabilities"],
  },
  {
    key: "quick_ratio",
    label: "نسبت آنی",
    group: "liquidity",
    unit: "ratio",
    explanation:
      "دارایی‌های جاری بدون موجودی کالا، در برابر بدهی‌های جاری. فقط نقد و دریافتنی‌های تجاری از مشتریان «سریع‌الوصول» شمرده می‌شوند.",
    formula: "(نقد و معادل نقد + دریافتنی‌های تجاری) ÷ بدهی‌های جاری",
    numerator: "نقد و معادل نقد + دریافتنی‌های تجاری",
    denominator: "بدهی‌های جاری",
    periodConvention: "point_in_time",
    source: "balance_sheet",
    requires: ["cashAndEquivalents", "tradeReceivables", "currentLiabilities"],
  },
  {
    key: "cash_ratio",
    label: "نسبت نقد",
    group: "liquidity",
    unit: "ratio",
    explanation:
      "تنها نقد و معادل نقد (صندوق، بانک و تنخواه) در برابر بدهی‌های جاری. سخت‌گیرانه‌ترین سنجهٔ نقدینگی است.",
    formula: "نقد و معادل نقد ÷ بدهی‌های جاری",
    numerator: "نقد و معادل نقد",
    denominator: "بدهی‌های جاری",
    periodConvention: "point_in_time",
    source: "balance_sheet",
    requires: ["cashAndEquivalents", "currentLiabilities"],
  },
  {
    key: "debt_to_assets",
    label: "بدهی به دارایی",
    group: "leverage",
    unit: "ratio",
    explanation:
      "چه سهمی از دارایی‌ها با بدهی تأمین شده است. باقیِ آن از حقوق صاحبان سرمایه آمده است.",
    formula: "کل بدهی‌ها ÷ کل دارایی‌ها",
    numerator: "کل بدهی‌ها",
    denominator: "کل دارایی‌ها",
    periodConvention: "point_in_time",
    source: "balance_sheet",
    requires: ["totalLiabilities", "totalAssets"],
  },
  {
    key: "debt_to_equity",
    label: "بدهی به حقوق صاحبان سرمایه",
    group: "leverage",
    unit: "ratio",
    explanation:
      "در برابر هر ریال سرمایهٔ صاحبان کسب‌وکار، چند ریال بدهی وجود دارد. وقتی حقوق صاحبان سرمایه صفر یا منفی باشد این نسبت معنا ندارد.",
    formula: "کل بدهی‌ها ÷ حقوق صاحبان سرمایه",
    numerator: "کل بدهی‌ها",
    denominator: "حقوق صاحبان سرمایه",
    periodConvention: "point_in_time",
    source: "balance_sheet",
    requires: ["totalLiabilities", "totalEquity"],
  },
  {
    key: "interest_coverage",
    label: "پوشش بهره",
    group: "leverage",
    unit: "ratio",
    explanation:
      "چند برابر هزینهٔ بهره، سود پیش از بهره و مالیات به دست آمده است. صورت کسر «سود خالص + هزینهٔ بهره» است و برای محاسبه، حساب هزینهٔ بهره باید در تنظیمات این گزارش تعیین شده باشد.",
    formula: "(سود خالص + هزینهٔ بهره) ÷ هزینهٔ بهره",
    numerator: "سود خالص + هزینهٔ بهره (EBIT)",
    denominator: "هزینهٔ بهره",
    periodConvention: "movement",
    source: "profit_and_loss",
    requires: ["netIncome", "interestExpense"],
  },
  {
    key: "gross_margin",
    label: "حاشیهٔ سود ناخالص",
    group: "profitability",
    unit: "percent",
    explanation:
      "سهمی از هر ریال فروش که پس از کسر بهای تمام‌شدهٔ فروش باقی می‌ماند و برای پوشش هزینه‌های عملیاتی و سود در دسترس است.",
    formula: "سود ناخالص ÷ درآمد خالص × ۱۰۰",
    numerator: "سود ناخالص",
    denominator: "درآمد خالص",
    periodConvention: "movement",
    source: "profit_and_loss",
    requires: ["grossProfit", "netRevenue"],
  },
  {
    key: "operating_margin",
    label: "حاشیهٔ سود عملیاتی",
    group: "profitability",
    unit: "percent",
    explanation:
      "سود پس از کسر بهای تمام‌شده و همهٔ هزینه‌های عملیاتی، به‌صورت درصدی از فروش. هزینهٔ بهره در صورت تعیین‌شدن از هزینه‌های عملیاتی جدا می‌شود.",
    formula: "سود عملیاتی ÷ درآمد خالص × ۱۰۰",
    numerator: "سود عملیاتی",
    denominator: "درآمد خالص",
    periodConvention: "movement",
    source: "profit_and_loss",
    requires: ["operatingProfit", "netRevenue"],
  },
  {
    key: "net_margin",
    label: "حاشیهٔ سود خالص",
    group: "profitability",
    unit: "percent",
    explanation: "سود (زیان) خالص دوره به‌صورت درصدی از فروش خالص.",
    formula: "سود خالص ÷ درآمد خالص × ۱۰۰",
    numerator: "سود (زیان) خالص",
    denominator: "درآمد خالص",
    periodConvention: "movement",
    source: "profit_and_loss",
    requires: ["netIncome", "netRevenue"],
  },
  {
    key: "return_on_assets",
    label: "بازده دارایی‌ها",
    group: "profitability",
    unit: "percent",
    explanation:
      "سود خالص دوره در برابر میانگین دارایی‌های ابتدا و پایان دوره. میانگین گرفته می‌شود تا سود یک دوره به دارایی‌ای که در همان دوره اضافه شده نسبت داده نشود.",
    formula: "سود خالص ÷ میانگین کل دارایی‌ها × ۱۰۰",
    numerator: "سود خالص",
    denominator: "میانگین کل دارایی‌ها",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["netIncome", "totalAssets", "openingTotalAssets"],
  },
  {
    key: "return_on_equity",
    label: "بازده حقوق صاحبان سرمایه",
    group: "profitability",
    unit: "percent",
    explanation:
      "سود خالص دوره در برابر میانگین حقوق صاحبان سرمایه. وقتی میانگین سرمایه صفر یا منفی باشد نسبت معنادار نیست.",
    formula: "سود خالص ÷ میانگین حقوق صاحبان سرمایه × ۱۰۰",
    numerator: "سود خالص",
    denominator: "میانگین حقوق صاحبان سرمایه",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["netIncome", "totalEquity", "openingTotalEquity"],
  },
  {
    key: "inventory_turnover",
    label: "گردش موجودی کالا",
    group: "efficiency",
    unit: "ratio",
    explanation:
      "چند بار در دوره، موجودی کالا فروخته و جایگزین شده است. مبنای محاسبه، بهای تمام‌شدهٔ فروش و میانگین موجودی ابتدا و پایان دوره است.",
    formula: "بهای تمام‌شدهٔ فروش ÷ میانگین موجودی کالا",
    numerator: "بهای تمام‌شدهٔ فروش",
    denominator: "میانگین موجودی کالا",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["costOfSales", "inventory", "openingInventory"],
  },
  {
    key: "days_inventory_outstanding",
    label: "روزهای نگهداری موجودی",
    group: "efficiency",
    unit: "days",
    explanation:
      "به‌طور میانگین چند روز طول می‌کشد تا موجودی کالا فروخته شود؛ از تقسیم طول دوره بر گردش موجودی.",
    formula: "تعداد روزهای دوره ÷ گردش موجودی کالا",
    numerator: "تعداد روزهای دوره",
    denominator: "گردش موجودی کالا",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["costOfSales", "inventory", "openingInventory", "periodDays"],
  },
  {
    key: "receivables_turnover",
    label: "گردش دریافتنی‌های تجاری",
    group: "efficiency",
    unit: "ratio",
    explanation:
      "چند بار در دوره، دریافتنی‌های تجاری از مشتریان وصول شده‌اند. چون فروش نسیه در دفتر از فروش نقدی تفکیک نشده است، صورت کسر «کل درآمد خالص» است و این مبنا روی گزارش نوشته می‌شود.",
    formula: "درآمد خالص ÷ میانگین دریافتنی‌های تجاری",
    numerator: "درآمد خالص (مبنای کل فروش)",
    denominator: "میانگین دریافتنی‌های تجاری",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["netRevenue", "tradeReceivables", "openingTradeReceivables"],
  },
  {
    key: "days_sales_outstanding",
    label: "دورهٔ وصول مطالبات",
    group: "efficiency",
    unit: "days",
    explanation:
      "به‌طور میانگین چند روز طول می‌کشد تا مطالبات از مشتریان وصول شود؛ بر مبنای کل فروش خالص.",
    formula: "تعداد روزهای دوره ÷ گردش دریافتنی‌های تجاری",
    numerator: "تعداد روزهای دوره",
    denominator: "گردش دریافتنی‌های تجاری",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["netRevenue", "tradeReceivables", "openingTradeReceivables", "periodDays"],
  },
  {
    key: "payables_turnover",
    label: "گردش پرداختنی‌های تجاری",
    group: "efficiency",
    unit: "ratio",
    explanation:
      "چند بار در دوره، بدهی به تأمین‌کنندگان پرداخت و دوباره ایجاد شده است. چون خرید نسیه در دفتر تفکیک نشده، صورت کسر «بهای تمام‌شدهٔ فروش» است و این مبنا روی گزارش نوشته می‌شود.",
    formula: "بهای تمام‌شدهٔ فروش ÷ میانگین پرداختنی‌های تجاری",
    numerator: "بهای تمام‌شدهٔ فروش (مبنای خرید)",
    denominator: "میانگین پرداختنی‌های تجاری",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["costOfSales", "tradePayables", "openingTradePayables"],
  },
  {
    key: "days_payable_outstanding",
    label: "دورهٔ پرداخت بدهی‌ها",
    group: "efficiency",
    unit: "days",
    explanation:
      "به‌طور میانگین چند روز طول می‌کشد تا بدهی به تأمین‌کنندگان پرداخت شود؛ بر مبنای بهای تمام‌شدهٔ فروش.",
    formula: "تعداد روزهای دوره ÷ گردش پرداختنی‌های تجاری",
    numerator: "تعداد روزهای دوره",
    denominator: "گردش پرداختنی‌های تجاری",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["costOfSales", "tradePayables", "openingTradePayables", "periodDays"],
  },
  {
    key: "asset_turnover",
    label: "گردش دارایی‌ها",
    group: "efficiency",
    unit: "ratio",
    explanation:
      "در هر دوره، به ازای هر ریال میانگین دارایی چند ریال فروش ایجاد شده است.",
    formula: "درآمد خالص ÷ میانگین کل دارایی‌ها",
    numerator: "درآمد خالص",
    denominator: "میانگین کل دارایی‌ها",
    periodConvention: "average_balance",
    source: "balance_sheet",
    requires: ["netRevenue", "totalAssets", "openingTotalAssets"],
  },
];

/** How an input is written on screen: money (in the business's display unit) or a day count. */
export const RATIO_INPUT_UNITS: Record<RatioInputKey, "money" | "days"> = {
  ...Object.fromEntries(
    (Object.keys(RATIO_INPUT_LABELS) as RatioInputKey[]).map((key) => [key, "money"]),
  ) as Record<RatioInputKey, "money" | "days">,
  periodDays: "days",
};

/** Inputs with the values the ledger produced, plus why an absent one is absent. */
export interface FinancialRatioInputSet {
  values: Partial<Record<RatioInputKey, number | null>>;
  /**
   * Optional, more specific reason for an absent input. `interestExpense: null`
   * with `{ interestExpense: "interest_expense_not_classified" }` says the chart
   * has no interest account, rather than that the read failed.
   */
  reasons?: Partial<Record<RatioInputKey, RatioReasonCode>>;
}

export interface RatioInputLine {
  key: RatioInputKey;
  label: string;
  value: number | null;
}

export interface FinancialRatioResult {
  key: RatioKey;
  label: string;
  group: RatioGroup;
  unit: RatioUnit;
  explanation: string;
  formula: string;
  numerator: string;
  denominator: string;
  periodConvention: RatioPeriodConvention;
  source: RatioSourceReport;
  status: RatioStatus;
  /** Unrounded for storage/JSON; presentation uses `display`. `null` unless available. */
  value: number | null;
  /** The figure exactly as the screen and every export show it (Persian digits, unit included). */
  display: string | null;
  reason: RatioReasonCode | null;
  reasonText: string | null;
  missingInputs: RatioInputKey[];
  /** Every input this ratio used, in catalogue order. */
  inputs: RatioInputLine[];
}

interface Evaluation {
  status: RatioStatus;
  value: Decimal | null;
  reason: RatioReasonCode | null;
}

const DECIMAL_PLACES = 6;

function decimalFrom(value: number): Decimal {
  return new Decimal(value);
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unavailable(reason: RatioReasonCode): Evaluation {
  return { status: "unavailable", value: null, reason };
}

function notApplicable(reason: RatioReasonCode): Evaluation {
  return { status: "not_applicable", value: null, reason };
}

function available(value: Decimal): Evaluation {
  return { status: "available", value, reason: null };
}

function asDecimal(value: number | Decimal | null | undefined): Decimal | null {
  if (value instanceof Decimal) return value.isFinite() ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return new Decimal(value);
  return null;
}

/**
 * The denominator policy, once. `denominatorReason` overrides the generic
 * `missing_input` for inputs whose absence needs its own sentence (interest
 * expense), and `nonPositiveReason` overrides `negative_denominator` for the
 * measures where zero is as meaningless as a negative (equity).
 */
function divide(
  numerator: number | Decimal | null | undefined,
  denominator: number | Decimal | null | undefined,
  options: {
    numeratorReason?: RatioReasonCode;
    denominatorReason?: RatioReasonCode;
    nonPositiveDenominatorReason?: RatioReasonCode;
    allowZeroNumerator?: boolean;
    allowNegativeNumerator?: boolean;
  } = {},
): Evaluation {
  const top = asDecimal(numerator);
  const bottom = asDecimal(denominator);
  if (!top) return unavailable(options.numeratorReason ?? "missing_input");
  if (!bottom) return unavailable(options.denominatorReason ?? "missing_input");
  if (bottom.isZero()) {
    return unavailable(options.nonPositiveDenominatorReason ?? "zero_denominator");
  }
  if (bottom.isNegative()) {
    return unavailable(options.nonPositiveDenominatorReason ?? "negative_denominator");
  }
  // A negative numerator is a real result for margins and coverage; it is only
  // refused where the measure itself is a positive quantity (a turnover).
  if (options.allowNegativeNumerator === false && top.isNegative()) {
    return notApplicable("non_positive_numerator");
  }
  if (options.allowZeroNumerator === false && top.isZero()) {
    return notApplicable("non_positive_numerator");
  }
  return available(top.div(bottom));
}

/** The mean of the opening and closing balance, or the reason it cannot be taken. */
function averageBalance(
  opening: number | null | undefined,
  closing: number | null | undefined,
  options: { closingReason?: RatioReasonCode; nonPositiveReason?: RatioReasonCode } = {},
): { value: Decimal } | { reason: RatioReasonCode } {
  if (!finite(closing)) return { reason: options.closingReason ?? "missing_input" };
  if (!finite(opening)) return { reason: "no_opening_comparative" };
  const average = decimalFrom(opening).plus(decimalFrom(closing)).div(2);
  if (average.lte(0)) return { reason: options.nonPositiveReason ?? "zero_denominator" };
  return { value: average };
}

function percentOf(evaluation: Evaluation): Evaluation {
  return evaluation.status === "available" && evaluation.value
    ? available(evaluation.value.times(100))
    : evaluation;
}

function daysFrom(turnover: Evaluation, periodDays: number | null | undefined): Evaluation {
  if (turnover.status !== "available" || !turnover.value) {
    return unavailable("derived_unavailable");
  }
  if (!finite(periodDays) || periodDays <= 0) return unavailable("no_period_days");
  if (turnover.value.lte(0)) return notApplicable("non_positive_numerator");
  return available(decimalFrom(periodDays).div(turnover.value));
}

function inputValue(inputs: FinancialRatioInputSet, key: RatioInputKey): number | null {
  const value = inputs.values[key];
  return finite(value) ? value : null;
}

function averageInputs(
  inputs: FinancialRatioInputSet,
  closingKey: RatioInputKey,
  openingKey: RatioInputKey,
  options: { nonPositiveReason?: RatioReasonCode } = {},
): Evaluation {
  const average = averageBalance(inputValue(inputs, openingKey), inputValue(inputs, closingKey), options);
  if ("reason" in average) return unavailable(average.reason);
  return available(average.value);
}

/** Evaluates one ratio from the input set. Exported so the definition and its arithmetic can be tested together. */
export function evaluateFinancialRatio(
  definition: RatioDefinition,
  inputs: FinancialRatioInputSet,
): Evaluation {
  const interestReason = inputs.reasons?.interestExpense;
  switch (definition.key) {
    case "current_ratio":
      return divide(inputValue(inputs, "currentAssets"), inputValue(inputs, "currentLiabilities"));
    case "quick_ratio": {
      const cash = inputValue(inputs, "cashAndEquivalents");
      const receivables = inputValue(inputs, "tradeReceivables");
      const liabilities = inputValue(inputs, "currentLiabilities");
      if (!finite(cash) || !finite(receivables)) return unavailable("missing_input");
      return divide(cash + receivables, liabilities);
    }
    case "cash_ratio":
      return divide(inputValue(inputs, "cashAndEquivalents"), inputValue(inputs, "currentLiabilities"));
    case "debt_to_assets":
      return divide(inputValue(inputs, "totalLiabilities"), inputValue(inputs, "totalAssets"));
    case "debt_to_equity":
      return divide(inputValue(inputs, "totalLiabilities"), inputValue(inputs, "totalEquity"), {
        nonPositiveDenominatorReason: "non_positive_equity",
      });
    case "interest_coverage": {
      const netIncome = inputValue(inputs, "netIncome");
      const interest = inputValue(inputs, "interestExpense");
      if (!finite(interest)) {
        return unavailable(interestReason ?? "interest_expense_not_classified");
      }
      if (!finite(netIncome)) return unavailable("missing_input");
      return divide(netIncome + interest, interest, {
        denominatorReason: "interest_expense_not_classified",
      });
    }
    case "gross_margin":
      return percentOf(
        divide(inputValue(inputs, "grossProfit"), inputValue(inputs, "netRevenue"), {
          denominatorReason: "no_revenue",
          nonPositiveDenominatorReason: "no_revenue",
        }),
      );
    case "operating_margin":
      return percentOf(
        divide(inputValue(inputs, "operatingProfit"), inputValue(inputs, "netRevenue"), {
          denominatorReason: "no_revenue",
          nonPositiveDenominatorReason: "no_revenue",
        }),
      );
    case "net_margin":
      return percentOf(
        divide(inputValue(inputs, "netIncome"), inputValue(inputs, "netRevenue"), {
          denominatorReason: "no_revenue",
          nonPositiveDenominatorReason: "no_revenue",
        }),
      );
    case "return_on_assets": {
      const income = inputValue(inputs, "netIncome");
      if (!finite(income)) return unavailable("missing_input");
      const average = averageInputs(inputs, "totalAssets", "openingTotalAssets");
      if (average.status !== "available") return average;
      return percentOf(divide(income, average.value));
    }
    case "return_on_equity": {
      const income = inputValue(inputs, "netIncome");
      if (!finite(income)) return unavailable("missing_input");
      const average = averageInputs(inputs, "totalEquity", "openingTotalEquity", {
        nonPositiveReason: "non_positive_equity",
      });
      if (average.status !== "available") return average;
      return percentOf(divide(income, average.value));
    }
    case "inventory_turnover": {
      const cogs = inputValue(inputs, "costOfSales");
      if (!finite(cogs)) return unavailable("missing_input");
      const average = averageInputs(inputs, "inventory", "openingInventory");
      if (average.status !== "available") return average;
      return divide(cogs, average.value, { allowZeroNumerator: false, allowNegativeNumerator: false });
    }
    case "days_inventory_outstanding": {
      const turnover = evaluateFinancialRatio(
        FINANCIAL_RATIO_DEFINITIONS.find((d) => d.key === "inventory_turnover")!,
        inputs,
      );
      return daysFrom(turnover, inputValue(inputs, "periodDays"));
    }
    case "receivables_turnover": {
      const revenue = inputValue(inputs, "netRevenue");
      if (!finite(revenue)) return unavailable("missing_input");
      if (revenue <= 0) return unavailable("no_revenue");
      const average = averageInputs(inputs, "tradeReceivables", "openingTradeReceivables");
      if (average.status !== "available") return average;
      return divide(revenue, average.value);
    }
    case "days_sales_outstanding": {
      const turnover = evaluateFinancialRatio(
        FINANCIAL_RATIO_DEFINITIONS.find((d) => d.key === "receivables_turnover")!,
        inputs,
      );
      return daysFrom(turnover, inputValue(inputs, "periodDays"));
    }
    case "payables_turnover": {
      const cogs = inputValue(inputs, "costOfSales");
      if (!finite(cogs)) return unavailable("missing_input");
      const average = averageInputs(inputs, "tradePayables", "openingTradePayables");
      if (average.status !== "available") return average;
      return divide(cogs, average.value, { allowZeroNumerator: false, allowNegativeNumerator: false });
    }
    case "days_payable_outstanding": {
      const turnover = evaluateFinancialRatio(
        FINANCIAL_RATIO_DEFINITIONS.find((d) => d.key === "payables_turnover")!,
        inputs,
      );
      return daysFrom(turnover, inputValue(inputs, "periodDays"));
    }
    case "asset_turnover": {
      const revenue = inputValue(inputs, "netRevenue");
      if (!finite(revenue)) return unavailable("missing_input");
      if (revenue <= 0) return unavailable("no_revenue");
      const average = averageInputs(inputs, "totalAssets", "openingTotalAssets");
      if (average.status !== "available") return average;
      return divide(revenue, average.value);
    }
  }
}

/**
 * The figure as the screen and every export print it.
 *
 * Ratio: two decimals. Percent: one decimal and the ٪ sign. Days: one decimal
 * and «روز». Negative values keep their sign — a negative margin or a negative
 * coverage is a fact, not an error. Persian digits and the Persian decimal
 * separator (٫) throughout.
 */
export function formatRatioValue(value: number, unit: RatioUnit): string {
  if (!Number.isFinite(value)) return "—";
  const places = unit === "ratio" ? 2 : 1;
  const fixed = new Decimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
  // A value that rounds to zero has no sign: «-0.00» is not a negative result.
  const rounded = /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
  const persian = toPersianDigits(rounded).replace(".", "٫");
  if (unit === "percent") return `${persian}٪`;
  if (unit === "days") return `${persian} روز`;
  return persian;
}

/** Computes every ratio in catalogue order, with its status, reason and the inputs it used. */
export function computeFinancialRatios(inputs: FinancialRatioInputSet): FinancialRatioResult[] {
  return FINANCIAL_RATIO_DEFINITIONS.map((definition) => {
    const evaluation = evaluateFinancialRatio(definition, inputs);
    const value =
      evaluation.status === "available" && evaluation.value
        ? evaluation.value.toDecimalPlaces(DECIMAL_PLACES, Decimal.ROUND_HALF_UP).toNumber()
        : null;
    const missingInputs =
      evaluation.status === "unavailable" && evaluation.reason === "missing_input"
        ? definition.requires.filter((key) => inputValue(inputs, key) === null)
        : [];
    return {
      key: definition.key,
      label: definition.label,
      group: definition.group,
      unit: definition.unit,
      explanation: definition.explanation,
      formula: definition.formula,
      numerator: definition.numerator,
      denominator: definition.denominator,
      periodConvention: definition.periodConvention,
      source: definition.source,
      status: evaluation.status,
      value,
      display: value === null ? null : formatRatioValue(value, definition.unit),
      reason: evaluation.reason,
      reasonText: evaluation.reason ? RATIO_REASON_LABELS[evaluation.reason] : null,
      missingInputs,
      inputs: definition.requires.map((key) => ({
        key,
        label: RATIO_INPUT_LABELS[key],
        value: inputValue(inputs, key),
      })),
    };
  });
}

/** The ratios the report groups into its four sections, in order. */
export interface RatioGroupReport {
  key: RatioGroup;
  label: string;
  description: string;
  ratios: FinancialRatioResult[];
}

export function groupFinancialRatios(ratios: readonly FinancialRatioResult[]): RatioGroupReport[] {
  return RATIO_GROUP_ORDER.map((group) => ({
    key: group,
    label: RATIO_GROUP_LABELS[group],
    description: RATIO_GROUP_DESCRIPTIONS[group],
    ratios: ratios.filter((ratio) => ratio.group === group),
  }));
}

export interface RatioComparisonChange {
  /** `current - previous`, in the ratio's own unit (percentage points for margins). */
  change: number | null;
  /** Relative change against the previous figure, in percent. Null when the previous was zero. */
  changePct: number | null;
  direction: "up" | "down" | "flat" | null;
}

/**
 * Attaches the comparable previous period to each ratio.
 *
 * A change is only computed when BOTH periods produced a figure. Two unavailable
 * ratios have no difference, and `previous = 0` has no meaningful percentage
 * change — neither is rendered as a change of zero.
 */
export function compareFinancialRatios(
  current: readonly FinancialRatioResult[],
  previous: readonly FinancialRatioResult[] | null,
): (FinancialRatioResult & { previous: FinancialRatioResult | null } & RatioComparisonChange)[] {
  const previousByKey = new Map((previous ?? []).map((ratio) => [ratio.key, ratio]));
  return current.map((ratio) => {
    const before = previousByKey.get(ratio.key) ?? null;
    if (
      ratio.value === null ||
      before === null ||
      before.value === null
    ) {
      return { ...ratio, previous: before, change: null, changePct: null, direction: null };
    }
    const change = new Decimal(ratio.value).minus(before.value);
    const changePct =
      before.value === 0
        ? null
        : change.div(Math.abs(before.value)).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    const direction = change.gt(0) ? "up" : change.lt(0) ? "down" : "flat";
    return {
      ...ratio,
      previous: before,
      change: change.toDecimalPlaces(DECIMAL_PLACES, Decimal.ROUND_HALF_UP).toNumber(),
      changePct,
      direction,
    };
  });
}

/**
 * The ratios worth plotting as a trend: one per group plus the two margins an
 * owner actually reads together. Deliberately short — a 12-line chart answers
 * nothing.
 */
export const FINANCIAL_RATIO_TREND_KEYS: readonly RatioKey[] = [
  "current_ratio",
  "quick_ratio",
  "debt_to_equity",
  "gross_margin",
  "operating_margin",
  "net_margin",
  "return_on_assets",
  "inventory_turnover",
];

/** Inclusive day count of a period, counted in UTC calendar days like every other report range. */
export function periodDayCount(dateFrom: string, dateTo: string): number | null {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

/** Catalogue metadata, for the documentation endpoint and the report's «دربارهٔ نسبتها» panel. */
export function financialRatioCatalogue(): readonly RatioDefinition[] {
  return FINANCIAL_RATIO_DEFINITIONS;
}
