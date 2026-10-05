/**
 * Report builder — pure logic. Defines the whitelist of reporting views a
 * custom (or standard) report is allowed to query, and turns a validated
 * {view, metric, dimension, filters} config into a parameterized SQL
 * query. No DB access here (see reports-service.ts for that) — this file
 * is what's unit tested, the same split as ledger.ts/ledger-service.ts.
 *
 * SAFETY: a report config only ever supplies *keys* (view/metric/dimension/
 * filter names). Every key is resolved against REPORT_VIEWS — a whitelist
 * this file owns — before it touches SQL; an unknown key is rejected, never
 * interpolated. Filter *values* are always bound as query parameters. This
 * is what makes "custom reports only ever query views, never raw
 * transactional tables" true by construction, not by convention.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import type { Industry } from "./industries";
import { hasCapability, hasModule, type CapabilityKey, type ModuleKey } from "./industry-profile";
import { PRODUCT_WORKSPACE_INDUSTRIES } from "./product-workspace";
import { addDays } from "./rollup";

export type Aggregation = "sum" | "avg" | "count" | "count_distinct";
export type DateGranularity = "day" | "week" | "month";

export interface MetricDef {
  key: string;
  label: string;
  /**
   * null = COUNT(*) (row count); ignores the aggregation column. A metric
   * offering "count_distinct" needs a real column — that's how a view whose
   * grain is finer than the thing being counted (v_purchase_summary is one row
   * per purchase *line*) still counts parents rather than lines.
   */
  column: string | null;
  /**
   * The metric is an amount of money, stored in integer Rial like every other
   * amount in the product.
   *
   * It exists because a report's value column is the one number in the app
   * that reaches a screen without passing a money formatter: the chart and the
   * table render whatever `value` the view returned, so a business displaying
   * «تومان» read its sales report in Rial — a figure ten times too large, with
   * no unit beside it to reveal the mistake. `useMoney().format` converts and
   * labels it now, and this flag is what says which metrics that applies to
   * (a count of orders or a duration in minutes must not be divided by ten).
   *
   * Storage and the wire stay Rial; this is display only. See
   * docs/design-system.md and AGENTS.md on the business-selected money unit.
   */
  money?: boolean;
  aggregations: Aggregation[];
}

export interface DimensionDef {
  key: string;
  label: string;
  /** date-bucket dimension: truncates the view's dateColumn to this granularity. */
  dateTrunc?: DateGranularity;
  /** entity dimension: columns to GROUP BY; the last one is the display label. */
  columns?: string[];
}

export interface FilterDef {
  key: string;
  label: string;
  column: string;
}

/**
 * What a business must have for a report to mean anything.
 *
 * `undefined` — every trade gets it. That is the default and covers most of the
 * library: a ledger, a sale, a customer and a staff member exist in a café and
 * in a jewellery shop alike, and the views behind those reports read tables
 * (`orders`, `journal_entries`, `customers`) that every industry writes.
 *
 * A report naming `modules`/`capabilities` is one whose *subject* only exists
 * in some trades — a table has no meaning without table service, a recipe has
 * none without F&B's recipe-costed store. Those are resolved against
 * `industry-profile.ts`, the same source the sidebar and the API guards use, so
 * a report can never be offered by a nav that the guard would then refuse.
 *
 * Every listed key must match (AND), because the requirements are facts about
 * one subject rather than alternatives: «واریانس بهای تمام‌شده غذا» needs the
 * recipe store *and* a menu to cost against, not either one.
 */
export interface ReportRequirement {
  modules?: readonly ModuleKey[];
  capabilities?: readonly CapabilityKey[];
  /**
   * An explicit industry set, for the handful of reports whose audience is not
   * any one module: variant sell-through belongs to the five trade-goods
   * industries that share the products workspace, and `stock` — the nearest
   * module — is carried by jewellery and watch too, which write no variant
   * sale events at all.
   */
  industries?: readonly Industry[];
}

export interface ReportViewDef {
  label: string;
  /** the view's date column (used by date-bucket dimensions and date-range filters), if any. */
  dateColumn: string | null;
  dimensions: DimensionDef[];
  metrics: MetricDef[];
  filters?: FilterDef[];
  /**
   * What a business must have for this source to hold anything — the same
   * model `StandardReportDef.requires` uses, declared here because the report
   * *builder* offers these directly. Without it a jeweller's source picker
   * lists «چرخش میزها» and «عملکرد پیک‌ها», builds a report on them, and gets a
   * permanently empty chart: the view is a join over `tables`/`deliveries`,
   * which that trade never writes. Omitted = every trade (see
   * ReportRequirement).
   *
   * This gates what is *offered*, not what is permitted: `buildReportQuery`
   * still runs any whitelisted view, and RLS still scopes every row, so an
   * existing saved report keeps working if a business changes trade.
   */
  requires?: ReportRequirement;
}

/**
 * Every reporting view from migrations/0008_reporting.sql. Keys here (view
 * names) are the only strings ever interpolated into `FROM <view>` — since
 * this whole object is a fixed compile-time constant, that's equivalent to
 * a hard-coded allowlist, not user input.
 */
export const REPORT_VIEWS: Record<string, ReportViewDef> = {
  v_sales_by_day: {
    label: "فروش روزانه",
    dateColumn: "sale_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
    ],
    metrics: [
      { key: "total", label: "جمع فروش", column: "total", money: true, aggregations: ["sum", "avg"] },
      { key: "subtotal", label: "جمع جزء", column: "subtotal", money: true, aggregations: ["sum", "avg"] },
      { key: "discount", label: "تخفیف", column: "discount", money: true, aggregations: ["sum", "avg"] },
      { key: "tax", label: "مالیات", column: "tax", money: true, aggregations: ["sum", "avg"] },
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد روز", column: null, aggregations: ["count"] },
    ],
  },
  v_menu_item_performance: {
    requires: { modules: ["menu"] },
    label: "عملکرد اقلام منو",
    dateColumn: "sale_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "item", label: "قلم منو", columns: ["menu_item_id", "item_name"] },
      { key: "category", label: "دسته", columns: ["category_id", "category_name"] },
    ],
    metrics: [
      { key: "quantity", label: "تعداد فروش", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", money: true, aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد ردیف", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "category", label: "دسته", column: "category_id" }],
  },
  // Add-on grain. v_menu_item_performance.revenue already includes these
  // deltas inside each item's revenue; this view breaks them out so add-on
  // sales are reportable on their own.
  v_modifier_performance: {
    requires: { modules: ["menu"] },
    label: "عملکرد افزودنی‌ها",
    dateColumn: "sale_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "modifier", label: "افزودنی", columns: ["modifier_id", "modifier_name"] },
      { key: "group", label: "گروه افزودنی", columns: ["modifier_group_id", "modifier_group_name"] },
      { key: "item", label: "قلم منو", columns: ["menu_item_id", "item_name"] },
    ],
    metrics: [
      { key: "quantity", label: "تعداد فروش", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد افزودنی", column: "revenue", money: true, aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد ردیف", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "group", label: "گروه افزودنی", column: "modifier_group_id" }],
  },
  v_inventory_valuation: {
    requires: { modules: ["inventory"] },
    label: "ارزش‌گذاری موجودی",
    dateColumn: null,
    dimensions: [{ key: "item", label: "کالا", columns: ["inventory_item_id", "item_name"] }],
    metrics: [
      { key: "stock_qty", label: "موجودی", column: "stock_qty", aggregations: ["sum", "avg"] },
      { key: "valuation", label: "ارزش موجودی", column: "valuation", money: true, aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد کالا", column: null, aggregations: ["count"] },
    ],
  },
  v_inventory_nrv_valuation: {
    requires: { modules: ["inventory"] },
    label: "ارزش نهایی موجودی پس از ذخیره کاهش ارزش",
    dateColumn: null,
    dimensions: [{ key: "item", label: "کالا", columns: ["inventory_item_id", "item_name"] }],
    metrics: [
      { key: "stock_qty", label: "موجودی", column: "stock_qty", aggregations: ["sum", "avg"] },
      { key: "gross_value", label: "ارزش ناخالص", column: "gross_carrying_value", money: true, aggregations: ["sum"] },
      { key: "nrv_allowance", label: "ذخیره کاهش ارزش", column: "nrv_allowance_rial", money: true, aggregations: ["sum"] },
      { key: "valuation", label: "ارزش نهایی", column: "valuation", money: true, aggregations: ["sum", "avg"] },
    ],
  },
  v_inventory_history_coverage: {
    requires: { modules: ["inventory"] },
    label: "پوشش تاریخی موجودی و بهای تمام‌شده",
    dateColumn: "effective_at",
    dimensions: [
      { key: "classification", label: "وضعیت پوشش", columns: ["classification"] },
      { key: "source_type", label: "نوع منبع", columns: ["source_type"] },
      { key: "cogs_available", label: "بهای تمام‌شده موجود", columns: ["cogs_available"] },
    ],
    metrics: [
      { key: "source_count", label: "تعداد سوابق", column: "source_count", aggregations: ["sum"] },
      { key: "rows", label: "تعداد گروه‌ها", column: null, aggregations: ["count"] },
    ],
    filters: [
      { key: "classification", label: "وضعیت پوشش", column: "classification" },
      { key: "source_type", label: "نوع منبع", column: "source_type" },
    ],
  },
  v_ledger_by_account: {
    label: "دفتر حساب‌ها",
    dateColumn: "entry_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "account", label: "حساب", columns: ["account_id", "account_code", "account_name"] },
      { key: "account_type", label: "نوع حساب", columns: ["account_type"] },
    ],
    metrics: [
      { key: "debit", label: "بدهکار", column: "debit", money: true, aggregations: ["sum", "avg"] },
      { key: "credit", label: "بستانکار", column: "credit", money: true, aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد سطر", column: null, aggregations: ["count"] },
    ],
    filters: [
      { key: "account_code", label: "کد حساب", column: "account_code" },
      { key: "account_type", label: "نوع حساب", column: "account_type" },
    ],
  },
  v_shift_reconciliation: {
    label: "تطبیق شیفت",
    dateColumn: "business_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "staff", label: "صندوق‌دار", columns: ["closed_by", "cashier_name"] },
    ],
    metrics: [
      { key: "gross_total", label: "جمع فروش", column: "gross_total", money: true, aggregations: ["sum", "avg"] },
      { key: "cash_total", label: "نقدی", column: "cash_total", money: true, aggregations: ["sum", "avg"] },
      { key: "card_total", label: "کارت‌خوان", column: "card_total", money: true, aggregations: ["sum", "avg"] },
      { key: "online_total", label: "آنلاین", column: "online_total", money: true, aggregations: ["sum", "avg"] },
      { key: "credit_total", label: "نسیه", column: "credit_total", money: true, aggregations: ["sum", "avg"] },
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
    ],
  },
  // Per-shift grain, from the real employee_shifts entity (migration 0061) —
  // unlike v_shift_reconciliation above (one row per business day per cashier)
  // each row is one shift and carries its own start/end time.
  v_employee_shift_reconciliation: {
    label: "تطبیق شیفت (به تفکیک شیفت)",
    dateColumn: "business_date",
    dimensions: [
      { key: "shift", label: "شیفت", columns: ["shift_id", "shift_window"] },
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "staff", label: "کارمند", columns: ["employee_id", "employee_name"] },
    ],
    metrics: [
      { key: "gross_total", label: "جمع فروش", column: "gross_total", money: true, aggregations: ["sum", "avg"] },
      { key: "cash_total", label: "نقدی", column: "cash_total", money: true, aggregations: ["sum", "avg"] },
      { key: "card_total", label: "کارت‌خوان", column: "card_total", money: true, aggregations: ["sum", "avg"] },
      { key: "online_total", label: "آنلاین", column: "online_total", money: true, aggregations: ["sum", "avg"] },
      { key: "credit_total", label: "نسیه", column: "credit_total", money: true, aggregations: ["sum", "avg"] },
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
      { key: "opening_float", label: "موجودی اولیهٔ صندوق", column: "opening_float", money: true, aggregations: ["sum", "avg"] },
      { key: "closing_float", label: "موجودی پایانی صندوق", column: "closing_float", money: true, aggregations: ["sum", "avg"] },
      { key: "cash_variance", label: "اختلاف صندوق", column: "cash_variance", money: true, aggregations: ["sum", "avg"] },
      { key: "duration_minutes", label: "مدت شیفت (دقیقه)", column: "duration_minutes", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد شیفت", column: null, aggregations: ["count"] },
    ],
  },
  v_table_turnover: {
    requires: { modules: ["tables"] },
    label: "چرخش میزها",
    dateColumn: "closed_at",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "table", label: "میز", columns: ["table_id", "table_name"] },
    ],
    metrics: [
      { key: "duration_minutes", label: "مدت اشغال (دقیقه)", column: "duration_minutes", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", money: true, aggregations: ["sum", "avg"] },
      { key: "party_size", label: "تعداد مهمان", column: "party_size", aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد نشست", column: null, aggregations: ["count"] },
    ],
  },
  v_staff_performance: {
    label: "عملکرد کارکنان",
    dateColumn: "business_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "staff", label: "کارمند", columns: ["staff_id", "staff_name"] },
    ],
    metrics: [
      { key: "order_count", label: "تعداد سفارش", column: "order_count", aggregations: ["sum", "avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", money: true, aggregations: ["sum", "avg"] },
      { key: "avg_ticket", label: "میانگین صورتحساب", column: "avg_ticket", money: true, aggregations: ["avg"] },
    ],
  },
  v_delivery_performance: {
    requires: { modules: ["delivery"] },
    label: "عملکرد ارسال",
    dateColumn: "delivery_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "courier", label: "پیک", columns: ["courier_id", "courier_name"] },
      { key: "status", label: "وضعیت", columns: ["delivery_status"] },
    ],
    metrics: [
      { key: "delivery_minutes", label: "زمان تحویل (دقیقه)", column: "delivery_minutes", aggregations: ["avg", "sum"] },
      { key: "revenue", label: "درآمد", column: "revenue", money: true, aggregations: ["sum", "avg"] },
      { key: "fee", label: "هزینهٔ ارسال", column: "fee", money: true, aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد ارسال", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "status", label: "وضعیت", column: "delivery_status" }],
  },
  v_courier_performance: {
    requires: { modules: ["delivery"] },
    label: "عملکرد پیک‌ها",
    dateColumn: "delivery_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "courier", label: "پیک", columns: ["courier_id", "courier_name"] },
    ],
    metrics: [
      { key: "delivery_count", label: "تعداد تحویل", column: "delivery_count", aggregations: ["sum", "avg"] },
      { key: "avg_delivery_minutes", label: "میانگین زمان تحویل (دقیقه)", column: "avg_delivery_minutes", aggregations: ["avg"] },
      { key: "revenue", label: "درآمد", column: "revenue", money: true, aggregations: ["sum", "avg"] },
      { key: "fees", label: "هزینهٔ ارسال", column: "fees", money: true, aggregations: ["sum", "avg"] },
    ],
  },
  v_waste_summary: {
    requires: { modules: ["inventory"] },
    label: "گزارش ضایعات",
    dateColumn: "waste_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "item", label: "کالا", columns: ["inventory_item_id", "item_name"] },
      { key: "reason", label: "دلیل ضایعات", columns: ["waste_reason"] },
    ],
    metrics: [
      { key: "quantity", label: "مقدار", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "cost", label: "بهای ضایعات", column: "cost", money: true, aggregations: ["sum", "avg"] },
    ],
  },
  // Phase 29 — in-house production. One row per run. Every additive column is
  // signed, so a reversal nets its original out and a period total is simply a
  // sum; `unit_cost` is a rate rather than a quantity, so only `avg` makes
  // sense on it and it stays positive on a reversal.
  v_production_summary: {
    requires: { modules: ["inventory"] },
    label: "گزارش تولید",
    dateColumn: "production_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "product", label: "محصول", columns: ["output_inventory_item_id", "output_item_name"] },
      { key: "formula", label: "فرمول", columns: ["formula_id", "formula_name"] },
    ],
    metrics: [
      { key: "quantity", label: "مقدار تولید", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "material_cost", label: "بهای مواد", column: "material_cost", money: true, aggregations: ["sum", "avg"] },
      { key: "conversion_cost", label: "هزینهٔ تبدیل", column: "conversion_cost", money: true, aggregations: ["sum", "avg"] },
      { key: "total_cost", label: "بهای تمام‌شده", column: "total_cost", money: true, aggregations: ["sum", "avg"] },
      { key: "unit_cost", label: "بهای هر واحد", column: "unit_cost", money: true, aggregations: ["avg"] },
      // Positive means the batches came out short of what their formulas
      // promised — the direction that costs money.
      { key: "yield_variance", label: "انحراف مقدار", column: "yield_variance", aggregations: ["sum", "avg"] },
    ],
  },
  // Purchase-line grain (migration 0063): one row per line, so "how much of
  // this item did we buy" and "what did we spend with this supplier" are both
  // answerable. `purchase_count` is count(DISTINCT purchase_id) precisely
  // because the grain is finer than a purchase — plain count() here would count
  // lines. All statuses are present; filter on status for received-only spend.
  v_purchase_summary: {
    requires: { modules: ["inventory"] },
    label: "خریدها",
    dateColumn: "purchase_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "supplier", label: "تأمین‌کننده", columns: ["supplier_id", "supplier_name"] },
      { key: "item", label: "کالا", columns: ["inventory_item_id", "item_name"] },
      { key: "status", label: "وضعیت", columns: ["status"] },
    ],
    metrics: [
      { key: "cost", label: "مبلغ خرید", column: "cost", money: true, aggregations: ["sum", "avg"] },
      { key: "quantity", label: "مقدار", column: "quantity", aggregations: ["sum", "avg"] },
      { key: "unit_cost", label: "بهای واحد", column: "unit_cost", money: true, aggregations: ["avg"] },
      { key: "purchase_count", label: "تعداد خرید", column: "purchase_id", aggregations: ["count_distinct"] },
      { key: "rows", label: "تعداد ردیف", column: null, aggregations: ["count"] },
    ],
    filters: [
      { key: "status", label: "وضعیت", column: "status" },
      { key: "supplier", label: "تأمین‌کننده", column: "supplier_id" },
    ],
  },
  // Expense grain (migration 0063): one row per expense. The expense account
  // *is* the category (see 0030), so "دستهٔ هزینه" below is that account.
  v_expense_summary: {
    label: "هزینه‌ها",
    dateColumn: "expense_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "category", label: "دستهٔ هزینه", columns: ["account_id", "account_code", "account_name"] },
      { key: "payment_account", label: "حساب پرداخت", columns: ["payment_account_id", "payment_account_name"] },
      { key: "vendor", label: "طرف حساب", columns: ["vendor"] },
    ],
    metrics: [
      { key: "amount", label: "مبلغ هزینه", column: "amount", money: true, aggregations: ["sum", "avg"] },
      { key: "rows", label: "تعداد هزینه", column: null, aggregations: ["count"] },
    ],
    filters: [
      { key: "account_code", label: "کد حساب هزینه", column: "account_code" },
      { key: "vendor", label: "طرف حساب", column: "vendor" },
    ],
  },
  // Phase 36 — the CRM's three views (migration 0119). All three count only
  // non-merged customers and use the same "completed order on a business day"
  // rule as the CRM's own screens, so a number here and a number on a
  // customer's file are the same number.
  //
  // Customer grain (one row per customer, dated by first purchase): who we
  // won, and when.
  v_customer_acquisition: {
    label: "جذب مشتری",
    dateColumn: "acquired_date",
    dimensions: [
      { key: "day", label: "روز", dateTrunc: "day" },
      { key: "week", label: "هفته", dateTrunc: "week" },
      { key: "month", label: "ماه", dateTrunc: "month" },
      { key: "lifecycle", label: "مرحلهٔ چرخهٔ عمر", columns: ["lifecycle_stage"] },
    ],
    metrics: [
      { key: "customers", label: "تعداد مشتری تازه", column: "customer_count", aggregations: ["sum"] },
      {
        key: "first_order_total",
        label: "مبلغ نخستین خرید",
        column: "first_order_total",
        money: true,
        aggregations: ["sum", "avg"],
      },
      { key: "rows", label: "تعداد ردیف", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "lifecycle_stage", label: "مرحلهٔ چرخهٔ عمر", column: "lifecycle_stage" }],
  },
  // Customer grain (one row per customer, dated by *last* purchase): what the
  // relationship has been worth, and how long since it last showed a sign of
  // life. Retention and CLV are the same rows read two ways.
  v_customer_value: {
    label: "ارزش و ماندگاری مشتری",
    dateColumn: "last_purchase_date",
    dimensions: [
      { key: "month", label: "ماه آخرین خرید", dateTrunc: "month" },
      { key: "week", label: "هفتهٔ آخرین خرید", dateTrunc: "week" },
      { key: "lifecycle", label: "مرحلهٔ چرخهٔ عمر", columns: ["lifecycle_stage"] },
      { key: "customer", label: "مشتری", columns: ["customer_id", "customer_name"] },
    ],
    metrics: [
      { key: "total_spent", label: "ارزش کل مشتری", column: "total_spent", money: true, aggregations: ["sum", "avg"] },
      { key: "order_count", label: "تعداد خرید", column: "order_count", aggregations: ["sum", "avg"] },
      { key: "average_order", label: "میانگین هر خرید", column: "average_order", money: true, aggregations: ["avg"] },
      {
        key: "days_since_last_purchase",
        label: "روز از آخرین خرید",
        column: "days_since_last_purchase",
        aggregations: ["avg"],
      },
      {
        key: "relationship_days",
        label: "طول رابطه (روز)",
        column: "relationship_days",
        aggregations: ["avg"],
      },
      { key: "customers", label: "تعداد مشتری", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "lifecycle_stage", label: "مرحلهٔ چرخهٔ عمر", column: "lifecycle_stage" }],
  },
  // Customer grain, one row per customer: permission and reachability side by
  // side, because they are different numbers and only reporting the first one
  // promises an audience that cannot be delivered to.
  v_customer_consent: {
    label: "پوشش رضایت ارتباط",
    dateColumn: "registered_date",
    dimensions: [
      { key: "month", label: "ماه ثبت", dateTrunc: "month" },
      { key: "consent_state", label: "وضعیت رضایت", columns: ["consent_state"] },
    ],
    metrics: [
      { key: "customers", label: "تعداد مشتری", column: "customer_count", aggregations: ["sum"] },
      { key: "sms_granted", label: "اجازهٔ پیامک", column: "sms_granted", aggregations: ["sum"] },
      { key: "sms_reachable", label: "پیامک قابل ارسال", column: "sms_reachable", aggregations: ["sum"] },
      { key: "email_granted", label: "اجازهٔ ایمیل", column: "email_granted", aggregations: ["sum"] },
      { key: "email_reachable", label: "ایمیل قابل ارسال", column: "email_reachable", aggregations: ["sum"] },
      { key: "rows", label: "تعداد ردیف", column: null, aggregations: ["count"] },
    ],
    filters: [{ key: "consent_state", label: "وضعیت رضایت", column: "consent_state" }],
  },
};

export interface ReportFilters {
  /** inclusive, ISO date (YYYY-MM-DD); only applies if the view has a dateColumn */
  dateFrom?: string;
  dateTo?: string;
  /** key -> value; each key must be one of the view's declared FilterDef keys */
  equals?: Record<string, string>;
}

export interface ReportSort {
  by: "dimension" | "metric";
  dir: "asc" | "desc";
}

export interface ReportConfig {
  view: string;
  metric: string;
  aggregation: Aggregation;
  dimension: string;
  filters?: ReportFilters;
  sort?: ReportSort;
  /** max rows returned; undefined = no limit */
  limit?: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a report config against the view whitelist. Empty array = valid. Persian error strings. */
export function validateReportConfig(config: ReportConfig): string[] {
  const errors: string[] = [];
  const view = Object.hasOwn(REPORT_VIEWS, config.view) ? REPORT_VIEWS[config.view] : undefined;
  if (!view) {
    errors.push("منبع داده نامعتبر است.");
    return errors;
  }

  const metric = view.metrics.find((m) => m.key === config.metric);
  if (!metric) {
    errors.push("معیار انتخاب‌شده برای این منبع داده معتبر نیست.");
  } else if (!metric.aggregations.includes(config.aggregation)) {
    errors.push("نوع تجمیع برای این معیار پشتیبانی نمی‌شود.");
  } else if (config.aggregation !== "count" && metric.column === null) {
    // Only "count" ignores the column (it's COUNT(*)); every other aggregation
    // interpolates metric.column into SQL, so a null column here would emit the
    // literal string "null". Unreachable via REPORT_VIEWS as written — the test
    // suite asserts the whitelist never pairs the two — but this is the last
    // line of defense for the whitelist, so it checks rather than assumes.
    errors.push("نوع تجمیع برای این معیار پشتیبانی نمی‌شود.");
  }

  const dimension = view.dimensions.find((d) => d.key === config.dimension);
  if (!dimension) {
    errors.push("بُعد انتخاب‌شده برای این منبع داده معتبر نیست.");
  }
  if (dimension?.dateTrunc && !view.dateColumn) {
    errors.push("این منبع داده بُعد زمانی ندارد.");
  }

  if (config.filters?.dateFrom && !ISO_DATE_RE.test(config.filters.dateFrom)) {
    errors.push("تاریخ شروع نامعتبر است.");
  }
  if (config.filters?.dateTo && !ISO_DATE_RE.test(config.filters.dateTo)) {
    errors.push("تاریخ پایان نامعتبر است.");
  }
  if (config.filters?.dateFrom && config.filters?.dateTo && config.filters.dateFrom > config.filters.dateTo) {
    errors.push("تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.");
  }
  if ((config.filters?.dateFrom || config.filters?.dateTo) && !view.dateColumn) {
    errors.push("این منبع داده قابل فیلتر بر اساس تاریخ نیست.");
  }

  if (config.filters?.equals) {
    for (const key of Object.keys(config.filters.equals)) {
      if (!view.filters?.some((f) => f.key === key)) {
        errors.push(`فیلتر «${key}» برای این منبع داده معتبر نیست.`);
      }
    }
  }

  if (config.limit !== undefined && (!Number.isInteger(config.limit) || config.limit <= 0)) {
    errors.push("محدودیت تعداد ردیف باید عدد صحیح مثبت باشد.");
  }

  return errors;
}

/**
 * Builds a parameterized SQL query for a validated config. Throws if the
 * config is invalid — callers should run validateReportConfig first (the
 * API route does; this is the last line of defense, not the primary check).
 * $1 is always businessId. Public API callers additionally bind one
 * locationId, so a branch-scoped API key can never aggregate sibling data.
 */
export function buildReportQuery(
  config: ReportConfig,
  businessId: string,
  locationId?: string,
): { sql: string; params: unknown[] } {
  const errors = validateReportConfig(config);
  if (errors.length > 0) {
    throw new Error(`invalid_report_config: ${errors.join(" | ")}`);
  }
  const view = REPORT_VIEWS[config.view]!;
  const metric = view.metrics.find((m) => m.key === config.metric)!;
  const dimension = view.dimensions.find((d) => d.key === config.dimension)!;

  let dimSelect: string;
  let groupBy: string;
  if (dimension.dateTrunc) {
    const expr = `date_trunc('${dimension.dateTrunc}', ${view.dateColumn})::date`;
    dimSelect = `${expr} AS dim`;
    groupBy = expr;
  } else {
    const cols = dimension.columns!;
    dimSelect = `${cols[cols.length - 1]} AS dim`;
    groupBy = cols.join(", ");
  }

  const aggExpr =
    config.aggregation === "count"
      ? "count(*)"
      : config.aggregation === "count_distinct"
        ? `count(DISTINCT ${metric.column})`
        : `${config.aggregation}(${metric.column})`;

  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (locationId) {
    params.push(locationId);
    where.push(`location_id = $${params.length}`);
  }
  if (view.dateColumn && config.filters?.dateFrom) {
    params.push(config.filters.dateFrom);
    where.push(`${view.dateColumn} >= $${params.length}`);
  }
  if (view.dateColumn && config.filters?.dateTo) {
    params.push(config.filters.dateTo);
    where.push(`${view.dateColumn} <= $${params.length}`);
  }
  if (config.filters?.equals) {
    for (const [key, value] of Object.entries(config.filters.equals)) {
      const filterDef = view.filters!.find((f) => f.key === key)!;
      params.push(value);
      where.push(`${filterDef.column} = $${params.length}`);
    }
  }

  const sortBy = config.sort?.by === "metric" ? "value" : "dim";
  const sortDir = config.sort?.dir === "desc" ? "DESC" : "ASC";

  let sql = `SELECT ${dimSelect}, ${aggExpr} AS value FROM ${config.view} WHERE ${where.join(" AND ")} GROUP BY ${groupBy} ORDER BY ${sortBy} ${sortDir}`;
  if (config.limit) {
    params.push(config.limit);
    sql += ` LIMIT $${params.length}`;
  }
  return { sql, params };
}

/** Persian labels for a config's dimension/metric — used to build export table headers and chart axis labels. */
export function reportConfigLabels(config: ReportConfig): { viewLabel: string; dimensionLabel: string; metricLabel: string } {
  const view = REPORT_VIEWS[config.view];
  if (!view) throw new Error(`unknown_view: ${config.view}`);
  const dimension = view.dimensions.find((d) => d.key === config.dimension);
  const metric = view.metrics.find((m) => m.key === config.metric);
  if (!dimension || !metric) throw new Error("invalid_report_config");
  return { viewLabel: view.label, dimensionLabel: dimension.label, metricLabel: metric.label };
}

export type ChartType = "line" | "bar" | "pie" | "number";

/**
 * The shelf a report sits on in «گزارش‌های آماده».
 *
 * A group is a subject, not a trade: a café owner and a jeweller both open
 * «مالی و حسابداری» to find the P&L. What differs between trades is *which*
 * reports exist inside a group (see `requires` below), never the shelving —
 * so the library reads the same everywhere and a business that changes nothing
 * about how it reports still finds its reports where it left them.
 */
export const REPORT_GROUPS = ["finance", "sales", "inventory", "people", "customers", "operations"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export const REPORT_GROUP_LABELS: Record<ReportGroup, string> = {
  finance: "مالی و حسابداری",
  sales: "فروش و درآمد",
  inventory: "موجودی و خرید",
  people: "کارکنان",
  customers: "مشتریان",
  operations: "عملیات کسب‌وکار",
};

/**
 * The order the groups are shown in — finance first because the statements are
 * what an owner opens the section for, operations last because it is the only
 * group whose contents change completely from one trade to the next.
 */
export const REPORT_GROUP_ORDER: readonly ReportGroup[] = [
  "finance",
  "sales",
  "inventory",
  "people",
  "customers",
  "operations",
];


/**
 * How a report's payload is shaped, and therefore which view renders it.
 *
 * `rows` is the ordinary case: a view dump the chart/table pair can draw
 * without knowing anything about the subject. Everything else is a report
 * whose answer has its own structure — an account rollup, a weight
 * reconciliation, a warranty register — computed by its own service function
 * and rendered by its own component.
 */
export type ReportShape =
  | "rows"
  | "profit_and_loss"
  | "balance_sheet"
  | "cash_flow"
  | "food_cost_variance"
  | "weight_reconciliation"
  | "consignor_statements"
  | "layaway_book"
  | "warranty"
  | "repairs"
  | "variant_sales"
  | "brand_sales"
  | "near_expiry"
  | "low_stock"
  | "dead_stock";

export interface StandardReportDef {
  key: string;
  label: string;
  /** One line on what question this answers — shown under the report's title. */
  description?: string;
  /** Which shelf it sits on. */
  group: ReportGroup;
  /**
   * What the business must have for this report to exist. Omitted = shared:
   * every trade sees it. See ReportRequirement.
   */
  requires?: ReportRequirement;
  /** How the payload is shaped; defaults to `rows`. See ReportShape. */
  shape?: ReportShape;
  /** underlying view for a plain row dump (table display); pnl/balance_sheet are computed separately. */
  view: string | null;
  defaultChart: { chartType: ChartType; config: ReportConfig } | null;
}

/** A report's shape, defaulting to the ordinary view dump. */
export function reportShape(report: StandardReportDef): ReportShape {
  return report.shape ?? "rows";
}

/**
 * Whether a config's measure is an amount of money — i.e. whether the `value`
 * column it produces must be rendered through the business's money formatter
 * rather than printed as a bare number.
 *
 * `count`/`count_distinct` are never money whatever they count: «تعداد خرید»
 * counts purchases over the `purchase_id` column, and a count of rows is not
 * Rial just because the column it counted holds them. An unknown view or
 * metric answers false rather than throwing — this is a display hint, and a
 * caller that is about to render is the wrong place to raise a config error.
 */
export function reportConfigIsMoney(config: {
  view?: string;
  metric?: string;
  aggregation?: Aggregation;
} | null | undefined): boolean {
  if (!config?.view || !config.metric) return false;
  if (config.aggregation === "count" || config.aggregation === "count_distinct") return false;
  return Boolean(REPORT_VIEWS[config.view]?.metrics.find((m) => m.key === config.metric)?.money);
}

/**
 * Whether an industry satisfies a requirement. `undefined` — no requirement —
 * is shared by every trade. Every listed key must match; see ReportRequirement
 * for why the keys are AND-ed rather than OR-ed.
 */
export function requirementMet(industry: Industry, requires: ReportRequirement | undefined): boolean {
  if (!requires) return true;
  for (const module of requires.modules ?? []) {
    if (!hasModule(industry, module)) return false;
  }
  for (const capability of requires.capabilities ?? []) {
    if (!hasCapability(industry, capability)) return false;
  }
  if (requires.industries && !requires.industries.includes(industry)) return false;
  return true;
}

/** Whether an industry has everything a report requires. A report with no `requires` is shared. */
export function industryHasReport(industry: Industry, report: StandardReportDef): boolean {
  return requirementMet(industry, report.requires);
}

/**
 * The report library as one industry actually sees it — the shared reports plus
 * the ones its own trade brings, in `STANDARD_REPORTS` order.
 *
 * This is the single filter: every surface that lists or runs a standard report
 * (the dashboard API, the public v1 API, the assistant's `list_reports`, the
 * MCP catalogue, the saved-report seeder) goes through it, so a trade can never
 * be offered «چرخش میزها» in one place and refused it in another.
 *
 * A null industry (a business whose row is unreadable, which `getBusinessIndustry`
 * returns rather than throwing) falls back to F&B, the same default the rest of
 * the app uses — the caller sees the historical library rather than an empty
 * screen.
 */
export function standardReportsFor(industry: Industry | null | undefined): StandardReportDef[] {
  const resolved: Industry = industry ?? "food_service";
  return STANDARD_REPORTS.filter((report) => industryHasReport(resolved, report));
}

/**
 * The builder's source list for one industry — the same filter
 * `standardReportsFor` applies, over the view whitelist.
 *
 * Keeps the two halves of the section honest with each other: if a trade is
 * not offered «چرخش میزها» as a ready-made report, it must not be offered the
 * view behind it as a place to build one from either.
 */
export function reportViewsFor(
  industry: Industry | null | undefined,
): { key: string; view: ReportViewDef }[] {
  const resolved: Industry = industry ?? "food_service";
  return Object.entries(REPORT_VIEWS)
    .filter(([, view]) => requirementMet(resolved, view.requires))
    .map(([key, view]) => ({ key, view }));
}

/** One industry's library, split into the groups the UI renders, empty groups dropped. */
export function groupedStandardReportsFor(
  industry: Industry | null | undefined,
): { group: ReportGroup; label: string; reports: StandardReportDef[] }[] {
  const reports = standardReportsFor(industry);
  return REPORT_GROUP_ORDER.map((group) => ({
    group,
    label: REPORT_GROUP_LABELS[group],
    reports: reports.filter((report) => report.group === group),
  })).filter((entry) => entry.reports.length > 0);
}

/**
 * The pre-built report library (Phase 8 scope: "daily sales summary, shift
 * reconciliation, COGS trend, inventory valuation, top-selling items, waste
 * report, P&L, Balance Sheet, staff performance, table turnover time").
 * P&L/Balance Sheet have no single metric/dimension shape (they're
 * structured account-type rollups) — reports-service.ts computes those
 * directly from v_ledger_by_account instead of through buildReportQuery.
 *
 * One flat list, read through `standardReportsFor(industry)`.
 *
 * The list was flat *and* served unfiltered until Phase 43: a jewellery shop's
 * report library offered «چرخش میزها»، «گزارش ضایعات» and «عملکرد پیک‌ها»
 * beside its own numbers, all three of which query views over tables that
 * trade never writes — so they were always empty, and the four reports the
 * shop actually wanted (weight reconciliation, layaway, consignors, variant
 * sell-through) lived somewhere else entirely, under `/api/{trade}/reports`.
 * Each entry now carries the shelf it belongs on and, when its subject only
 * exists in some trades, what the business must have for it to appear.
 */
export const STANDARD_REPORTS: StandardReportDef[] = [
  {
    key: "daily_sales_summary",
    label: "خلاصه فروش روزانه",
    description: "فروش هر روز کاری: تعداد سند، جمع جزء، تخفیف، مالیات و فروش خالص.",
    group: "sales",
    view: "v_sales_by_day",
    defaultChart: {
      chartType: "bar",
      config: { view: "v_sales_by_day", metric: "total", aggregation: "sum", dimension: "day" },
    },
  },
  {
    key: "shift_reconciliation",
    label: "تطبیق شیفت",
    description: "هر شیفت و آنچه در آن دریافت شده: نقدی، کارت‌خوان، آنلاین و نسیه.",
    group: "finance",
    // Per-shift since migration 0061 — the report now reports the real
    // employee_shifts entity (with each shift's own start/end time) instead
    // of v_shift_reconciliation's (day × cashier) proxy. Existing saved rows
    // are re-pointed automatically: ensureStandardSavedReports upserts
    // `config` on every call.
    view: "v_employee_shift_reconciliation",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_employee_shift_reconciliation",
        metric: "gross_total",
        aggregation: "sum",
        dimension: "day",
      },
    },
  },
  {
    key: "cogs_trend",
    label: "روند بهای تمام‌شده کالا (COGS)",
    description: "روند بهای تمام‌شدهٔ کالای فروش‌رفته بر پایهٔ اسناد دفتر کل.",
    group: "finance",
    view: "v_ledger_by_account",
    defaultChart: {
      chartType: "line",
      config: {
        view: "v_ledger_by_account",
        metric: "debit",
        aggregation: "sum",
        dimension: "day",
        filters: { equals: { account_code: WELL_KNOWN_CODES.cogs } },
      },
    },
  },
  {
    key: "inventory_valuation",
    label: "ارزش‌گذاری موجودی",
    description: "ارزش ریالی موجودی هر کالا در انبار مواد اولیه.",
    group: "inventory",
    requires: { modules: ["inventory"] },
    view: "v_inventory_valuation",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_inventory_valuation",
        metric: "valuation",
        aggregation: "sum",
        dimension: "item",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "top_selling_items",
    label: "پرفروش‌ترین اقلام",
    description: "پرفروش‌ترین اقلام منو بر پایهٔ تعداد فروش.",
    group: "sales",
    requires: { modules: ["menu"] },
    view: "v_menu_item_performance",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_menu_item_performance",
        metric: "quantity",
        aggregation: "sum",
        dimension: "item",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "top_selling_add_ons",
    label: "پرفروش‌ترین افزودنی‌ها",
    description: "درآمد افزودنی‌ها به تفکیک افزودنی و گروه.",
    group: "sales",
    requires: { modules: ["menu"] },
    view: "v_modifier_performance",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_modifier_performance",
        metric: "revenue",
        aggregation: "sum",
        dimension: "modifier",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "waste_report",
    label: "گزارش ضایعات",
    description: "ضایعات ثبت‌شده به تفکیک علت، با بهای تمام‌شدهٔ هر علت.",
    group: "inventory",
    requires: { modules: ["inventory"] },
    view: "v_waste_summary",
    defaultChart: {
      chartType: "pie",
      config: { view: "v_waste_summary", metric: "cost", aggregation: "sum", dimension: "reason" },
    },
  },
  {
    key: "production_by_product",
    label: "تولید به تفکیک محصول",
    description: "تولید داخلی به تفکیک محصول، با بهای تمام‌شدهٔ هر اجرا.",
    group: "inventory",
    requires: { modules: ["inventory"] },
    view: "v_production_summary",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_production_summary",
        metric: "total_cost",
        aggregation: "sum",
        dimension: "product",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "purchases_by_supplier",
    label: "خرید به تفکیک تأمین‌کننده",
    description: "خرید هر تأمین‌کننده در بازه، شامل خریدهای ثبت‌شده و تحویل‌نشده.",
    group: "inventory",
    requires: { modules: ["inventory"] },
    view: "v_purchase_summary",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_purchase_summary",
        metric: "cost",
        aggregation: "sum",
        dimension: "supplier",
        sort: { by: "metric", dir: "desc" },
        limit: 10,
      },
    },
  },
  {
    key: "expenses_by_category",
    label: "هزینه به تفکیک دسته",
    description: "هزینه‌های ثبت‌شده به تفکیک حساب هزینه.",
    group: "finance",
    view: "v_expense_summary",
    defaultChart: {
      chartType: "pie",
      config: { view: "v_expense_summary", metric: "amount", aggregation: "sum", dimension: "category" },
    },
  },
  // The three statements are the same statement in every trade — what changes
  // between them is which expense codes count as cost of sales, and that is
  // already resolved per-industry inside getProfitAndLoss.
  {
    key: "profit_and_loss",
    label: "صورت سود و زیان",
    description: "درآمد، بهای تمام‌شده، دستمزد و سود خالص دوره، با امکان مقایسه با دورهٔ قبل.",
    group: "finance",
    shape: "profit_and_loss",
    view: null,
    defaultChart: null,
  },
  {
    key: "balance_sheet",
    label: "ترازنامه",
    description: "دارایی‌ها، بدهی‌ها و حقوق صاحبان سرمایه در یک تاریخ معین.",
    group: "finance",
    shape: "balance_sheet",
    view: null,
    defaultChart: null,
  },
  {
    key: "cash_flow",
    label: "صورت گردش وجوه نقد",
    description: "ورود و خروج نقد دوره به تفکیک نوع رویداد، با موجودی ابتدا و پایان.",
    group: "finance",
    shape: "cash_flow",
    view: null,
    defaultChart: null,
  },
  {
    key: "food_cost_variance",
    label: "واریانس بهای تمام‌شده غذا",
    description: "بهای استاندارد دستور پخت در برابر بهای واقعی دفاتر، و شکاف توضیح‌داده‌نشده.",
    group: "operations",
    // The recipe-costed store *and* the menu to cost against: this compares a
    // menu item's recipe to the ledger's posted COGS, so a trade with one and
    // not the other could only ever produce half the comparison.
    requires: { modules: ["inventory", "menu"] },
    shape: "food_cost_variance",
    view: null,
    defaultChart: null,
  },
  {
    key: "staff_performance",
    label: "عملکرد کارکنان",
    description: "فروش و میانگین مبلغ سند به تفکیک کارمند بستن‌کنندهٔ سند.",
    group: "people",
    view: "v_staff_performance",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_staff_performance",
        metric: "revenue",
        aggregation: "sum",
        dimension: "staff",
        sort: { by: "metric", dir: "desc" },
      },
    },
  },
  {
    key: "table_turnover",
    label: "چرخش میزها",
    description: "میانگین مدت اشغال هر میز — از نشستن مهمان تا تسویه.",
    group: "operations",
    requires: { modules: ["tables"] },
    view: "v_table_turnover",
    defaultChart: {
      chartType: "bar",
      config: { view: "v_table_turnover", metric: "duration_minutes", aggregation: "avg", dimension: "table" },
    },
  },
  {
    key: "delivery_performance",
    label: "عملکرد ارسال",
    description: "میانگین زمان ارسال در هر روز، از ثبت سفارش تا تحویل.",
    group: "operations",
    requires: { modules: ["delivery"] },
    view: "v_delivery_performance",
    defaultChart: {
      chartType: "line",
      config: { view: "v_delivery_performance", metric: "delivery_minutes", aggregation: "avg", dimension: "day" },
    },
  },
  {
    key: "courier_performance",
    label: "عملکرد پیک‌ها",
    description: "تعداد و زمان تحویل هر پیک.",
    group: "operations",
    requires: { modules: ["delivery"] },
    view: "v_courier_performance",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_courier_performance",
        metric: "delivery_count",
        aggregation: "sum",
        dimension: "courier",
        sort: { by: "metric", dir: "desc" },
      },
    },
  },
  // Phase 36 — the CRM's four. They live in the shared report library rather
  // than only inside the CRM app so that they export, schedule and appear in
  // the assistant's `list_reports` like everything else; an owner should not
  // have to learn a second place where reports live.
  {
    key: "customer_acquisition",
    label: "جذب مشتری تازه",
    description: "مشتریان تازه در هر ماه.",
    group: "customers",
    view: "v_customer_acquisition",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_customer_acquisition",
        metric: "customers",
        aggregation: "sum",
        dimension: "month",
      },
    },
  },
  {
    key: "customer_retention",
    label: "ماندگاری و ریزش مشتری",
    description: "توزیع مشتریان بین مراحل چرخهٔ عمر: فعال، در خطر و از دست‌رفته.",
    group: "customers",
    view: "v_customer_value",
    defaultChart: {
      chartType: "pie",
      // Churn as a distribution over lifecycle stages, not a single ratio: «۱۸٪
      // ریزش» tells an owner nothing they can act on, whereas «۴۰ مشتری در
      // خطر، ۱۲ مشتری از دست‌رفته» names who to call tomorrow.
      config: {
        view: "v_customer_value",
        metric: "customers",
        aggregation: "count",
        dimension: "lifecycle",
        sort: { by: "metric", dir: "desc" },
      },
    },
  },
  {
    key: "customer_lifetime_value",
    label: "ارزش طول عمر مشتری",
    description: "پرارزش‌ترین مشتریان بر پایهٔ مجموع خرید.",
    group: "customers",
    view: "v_customer_value",
    defaultChart: {
      chartType: "bar",
      config: {
        view: "v_customer_value",
        metric: "total_spent",
        aggregation: "sum",
        dimension: "customer",
        sort: { by: "metric", dir: "desc" },
        limit: 20,
      },
    },
  },
  {
    key: "consent_coverage",
    label: "پوشش رضایت ارتباط",
    description: "پوشش رضایت ارتباط بازاریابی در پروندهٔ مشتریان.",
    group: "customers",
    view: "v_customer_consent",
    defaultChart: {
      chartType: "pie",
      config: {
        view: "v_customer_consent",
        metric: "customers",
        aggregation: "sum",
        dimension: "consent_state",
        sort: { by: "metric", dir: "desc" },
      },
    },
  },

  /* ---------------------------------------------------------------- *
   * Phase 43 — the retail trades' own reports.
   *
   * These are not new numbers. Each one already existed behind
   * `/api/{trade}/reports`, rendered by that trade's own «گزارش» tab, and
   * was invisible from «گزارش‌ها» — so a jeweller had two report sections
   * and neither one held everything. They are declared here for the same
   * reason the CRM's four are (see above): one library, one export path, one
   * `list_reports`, one place an owner looks.
   *
   * They keep `view: null` and their own `shape`, because their subject has
   * a structure the generic dim/value pair cannot carry — a weight
   * reconciliation is per-purity with a variance, a warranty register is per
   * serial with a state. `defaultChart: null` follows from that: there is no
   * single metric to pin to a dashboard tile, exactly as for the statements.
   * ---------------------------------------------------------------- */
  {
    key: "weight_reconciliation",
    label: "تطبیق وزنی",
    description: "وزن خالص دفاتر در برابر آخرین شمارش فیزیکی هر عیار، با مغایرت گرمی.",
    group: "inventory",
    requires: { modules: ["jewelry"] },
    shape: "weight_reconciliation",
    view: null,
    defaultChart: null,
  },
  {
    key: "consignor_statements",
    label: "صورت‌حساب امانت‌گذاران",
    description: "بدهی هر امانت‌گذار از روی فروش‌های ثبت‌شده: ارزش فلز و اجرت، منهای پرداختی‌ها.",
    group: "finance",
    requires: { modules: ["jewelry"] },
    shape: "consignor_statements",
    view: null,
    defaultChart: null,
  },
  {
    key: "layaway_book",
    label: "دفتر لیاوی",
    description: "طرح‌های اقساطی باز، وزن رزروشده و مانده‌ی دریافتنی هر طرح.",
    group: "finance",
    requires: { modules: ["jewelry"] },
    shape: "layaway_book",
    view: null,
    defaultChart: null,
  },
  {
    key: "warranty_register",
    label: "دفتر گارانتی‌ها",
    description: "گارانتی‌های صادرشده و وضعیت هرکدام: معتبر، رو به پایان یا منقضی.",
    // `repairs` rather than the `watch` module: a jeweller repairs and
    // warranties too (industry-profile.ts gives both trades the capability),
    // and the register reads `item_serials`, which both write.
    group: "operations",
    requires: { capabilities: ["repairs"] },
    shape: "warranty",
    view: null,
    defaultChart: null,
  },
  {
    key: "repair_profitability",
    label: "سودآوری تعمیرات",
    description: "تیکت‌های تعمیر به تفکیک وضعیت، با درآمد، بهای قطعات و حاشیهٔ هر دوره.",
    group: "operations",
    requires: { capabilities: ["repairs"] },
    shape: "repairs",
    view: null,
    defaultChart: null,
  },
  {
    key: "variant_sales",
    label: "تحلیل فروش تنوع‌ها",
    description: "کدام تنوع‌ها می‌فروشند: تعداد، درآمد، بهای تمام‌شده و حاشیهٔ هر تنوع.",
    group: "sales",
    // The variant-board trades, not `stock`: jewellery and watch carry that
    // module too but sell weighted pieces and serialised units, which write no
    // variant sale event for this to read. Taken from the one place that set
    // is declared rather than restated — issue #799's coverage guard fails the
    // build on a hard-coded industry list (industry-coverage.test.ts).
    requires: { industries: PRODUCT_WORKSPACE_INDUSTRIES },
    shape: "variant_sales",
    view: null,
    defaultChart: null,
  },
  {
    key: "brand_sales",
    label: "فروش به تفکیک برند",
    description: "سهم هر برند از فروش و حاشیهٔ سود، برای تصمیم دربارهٔ سبد برندها.",
    group: "sales",
    requires: { modules: ["cosmetics"] },
    shape: "brand_sales",
    view: null,
    defaultChart: null,
  },
  {
    key: "near_expiry_batches",
    label: "بچ‌های نزدیک انقضا",
    description: "بچ‌های منقضی و زیر ۹۰ روز مانده تا انقضا، برای تخفیف یا مرجوعی به‌موقع.",
    group: "inventory",
    requires: { capabilities: ["batch_expiry"] },
    shape: "near_expiry",
    view: null,
    defaultChart: null,
  },
  {
    key: "low_stock",
    label: "کمبود موجودی",
    description: "کالاهای زیر نقطهٔ سفارش یا تمام‌شده، برای سفارش دوباره.",
    group: "inventory",
    requires: { modules: ["stock"] },
    shape: "low_stock",
    view: null,
    defaultChart: null,
  },
  {
    key: "dead_stock",
    label: "کالای راکد",
    description: "کالاهایی که ۹۰ روز فروش نرفته‌اند و سرمایهٔ خوابیده در آن‌ها.",
    group: "inventory",
    requires: { modules: ["stock"] },
    shape: "dead_stock",
    view: null,
    defaultChart: null,
  },
];

/**
 * The immediately-preceding period of the same length, for a P&L/cash-flow
 * statement's "vs previous period" comparison — e.g. [2025-04-01, 2025-04-30]
 * (30 days) shifts back to [2025-03-02, 2025-03-31] (also 30 days), not
 * naively to the previous calendar month, so a comparison is always
 * apples-to-apples regardless of which range the caller picked.
 */
export function previousPeriodRange(dateFrom: string, dateTo: string): { dateFrom: string; dateTo: string } {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  const prevTo = addDays(dateFrom, -1);
  const prevFrom = addDays(prevTo, -days);
  return { dateFrom: prevFrom, dateTo: prevTo };
}

/**
 * Food-cost variance (#160 §4's "actual vs. recipe-standard consumption"
 * deferral, picked up once tip capture shipped). One menu item's
 * *theoretical* cost is its recipe (menu_item_ingredients + modifier
 * deltas, frozen per sale in order_item_inventory_snapshots) priced at each
 * ingredient's *current* avg_cost — "what this item should cost to make
 * right now". `actualCogs`/`wasteCost` are the real posted ledger totals for
 * the same period (5100/5150), independent of any per-item allocation: the
 * system can't attribute a shared-ingredient order's real FIFO/weighted-
 * average cost back to one menu item without guessing, so this only ever
 * compares *totals*, not a per-item actual figure.
 */
export interface FoodCostVarianceItemInput {
  menuItemId: string | null;
  menuItemName: string;
  unitsSold: number;
  /** Recipe cost of the units sold, at each ingredient's current avg_cost. */
  theoreticalCost: number;
  revenue: number;
}

export interface FoodCostVarianceItemLine extends FoodCostVarianceItemInput {
  /** theoreticalCost / revenue — the item's "ideal" food-cost ratio; null when revenue is 0. */
  foodCostPct: number | null;
}

export interface FoodCostVariance {
  /** Sorted worst (highest food-cost %) first, items with no revenue last. */
  items: FoodCostVarianceItemLine[];
  theoreticalCost: number;
  actualCogs: number;
  wasteCost: number;
  /** actualCogs + wasteCost — everything that actually left inventory value, sale or shrinkage. */
  actualTotalCost: number;
  /** actualTotalCost - theoreticalCost. Positive = spent more than the recipes predict. */
  variance: number;
  variancePct: number | null;
  /** variance with recorded waste backed out — the portion price drift/portioning/theft would explain. */
  unexplainedVariance: number;
}

export interface BranchOverviewMetrics {
  grossProfit: number;
  grossMarginPct: number;
  avgTicket: number;
  revenueSharePct: number;
}

/**
 * Computes derived metrics (Gross Profit, Gross Margin %, Average Ticket, and Revenue Share %)
 * for a branch comparison row. Guaranteed not to divide by zero.
 */
export function computeBranchOverviewMetrics(
  row: { orderCount: number; total: number; cogs: number },
  consolidatedTotal: number,
): BranchOverviewMetrics {
  const grossProfit = row.total - row.cogs;
  const grossMarginPct = row.total > 0 ? (grossProfit / row.total) * 100 : 0;
  const avgTicket = row.orderCount > 0 ? Math.round(row.total / row.orderCount) : 0;
  const revenueSharePct = consolidatedTotal > 0 ? (row.total / consolidatedTotal) * 100 : 0;
  return {
    grossProfit,
    grossMarginPct,
    avgTicket,
    revenueSharePct,
  };
}

export function buildFoodCostVariance(
  items: FoodCostVarianceItemInput[],
  actualCogs: number,
  wasteCost: number,
  summary?: { theoreticalCost: number },
): FoodCostVariance {
  const lines: FoodCostVarianceItemLine[] = items
    .map((item) => ({ ...item, foodCostPct: item.revenue > 0 ? item.theoreticalCost / item.revenue : null }))
    .sort((a, b) => (b.foodCostPct ?? -1) - (a.foodCostPct ?? -1));
  // SQL-paged readers supply the full-source total; detail lines still use the same builder.
  const theoreticalCost = summary?.theoreticalCost ?? items.reduce((sum, item) => sum + item.theoreticalCost, 0);
  const actualTotalCost = actualCogs + wasteCost;
  const variance = actualTotalCost - theoreticalCost;
  return {
    items: lines,
    theoreticalCost,
    actualCogs,
    wasteCost,
    actualTotalCost,
    variance,
    variancePct: theoreticalCost > 0 ? variance / theoreticalCost : null,
    unexplainedVariance: variance - wasteCost,
  };
}
