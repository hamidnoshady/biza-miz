/**
 * Issue #799 §30 — the AEC report set, as a pure catalogue.
 *
 * §30 lists seventeen reports and one rule: *"Financial amounts must use
 * Accounting as the source where they represent posted financial facts."* The
 * rule is why this file is a catalogue of **questions** rather than a second set
 * of calculations: every entry names the capability that has to be on for the
 * question to exist, the columns the answer prints, and — in the service that
 * fills it — which existing register or function answers it. A report whose
 * rows were recomputed here would be a second answer to a question the register
 * already answers, which is how a cockpit and a report start disagreeing.
 *
 * Two shapes are deliberately absent from §30's list:
 *
 *   * There is **no report for a figure only the books own** (receipts,
 *     payments, A/R, A/P, payroll, tax). Those are Accounting's reports, and
 *     §30 says so; the AEC report that needs actual cost reads it from the
 *     ledger through `projectReport`, and an actor without `ledger.view` sees
 *     the column as «—» rather than as a zero.
 *   * There is **no report page of its own per register**, because the register
 *     *is* the page — §34's "duplicate screens for the same information" is
 *     exactly a «Procurement delays» report that repeats the procurement tab.
 *     What a report adds is the cross-register question (§30's list is written
 *     that way: "aging", "exposure", "variance", "performance") and the totals
 *     the register does not print.
 *
 * The wave that owns a report is the wave that first had data for it, so a
 * business that switched a capability off sees fewer reports rather than empty
 * ones — the same rule the cockpit's tabs follow.
 */

import { type AecAiToolName, type AecCapabilityKey } from "./aec";

export const AEC_REPORT_KEYS = [
  // §30's own order, as far as this build can answer it.
  "project_health",
  "schedule_variance",
  "budget_vs_actual",
  "committed_vs_budget",
  "forecast_final_cost",
  "project_margin",
  "boq_variance",
  "change_order_exposure",
  "procurement_delay",
  "rfi_aging",
  "submittal_aging",
  "document_status",
  "contractor_performance",
  "site_productivity",
  "snag_aging",
  "inspection_status",
  "certificate_status",
] as const;
export type AecReportKey = (typeof AEC_REPORT_KEYS)[number];

/**
 * How a column is rendered. The UI reads this rather than guessing from the
 * value: a rial figure must go through `useMoney()` (the business's own
 * formatting, which a report must not reimplement), a date through the shared
 * Shamsi cell, and a percent through the Persian-digit formatter.
 */
export const AEC_REPORT_CELL_KINDS = ["text", "number", "money", "date", "percent", "status"] as const;
export type AecReportCellKind = (typeof AEC_REPORT_CELL_KINDS)[number];

export interface AecReportColumn {
  key: string;
  label: string;
  kind: AecReportCellKind;
}

export interface AecReportDefinition {
  key: AecReportKey;
  label: string;
  description: string;
  /**
   * The capability that must be on for the report to exist. `null` means every
   * AEC project has it — the schedule, the RFI register and the project's own
   * health are not optional parts of running a project.
   */
  capability: AecCapabilityKey | null;
  columns: readonly AecReportColumn[];
  /** Shown in place of the table when the answer is empty. */
  emptyMessage: string;
  /**
   * The sentence a reader needs to read the numbers correctly — which figure is
   * a forecast, which one is the ledger's, which one is a register's.
   */
  note?: string;
}

/**
 * §30's list, each entry naming the register or function that answers it.
 *
 * The columns are the *question's* columns, not the register's: a report prints
 * what the reader compares (a variance, an age in days, a promised date) beside
 * what identifies the row. Where a register already prints a richer row, the
 * report links to it instead of copying it.
 */
export const AEC_REPORTS: readonly AecReportDefinition[] = [
  {
    key: "project_health",
    label: "سلامت پروژه",
    description: "وضعیت، پیشرفت، وظایف عقب‌افتاده و بودجه در برابر هزینهٔ ثبت‌شده",
    capability: null,
    columns: [
      { key: "project", label: "پروژه", kind: "text" },
      { key: "status", label: "وضعیت", kind: "status" },
      { key: "progressPercent", label: "پیشرفت", kind: "percent" },
      { key: "taskCount", label: "وظایف", kind: "number" },
      { key: "overdueTaskCount", label: "عقب‌افتاده", kind: "number" },
      { key: "budgetRial", label: "بودجه", kind: "money" },
      { key: "spentRial", label: "هزینهٔ ثبت‌شده", kind: "money" },
      { key: "remainingRial", label: "مانده", kind: "money" },
      { key: "endDate", label: "مهلت پایان", kind: "date" },
    ],
    emptyMessage: "این پروژه در دسترس نیست.",
    note: "هزینه از دفتر روزنامهٔ حسابداری خوانده می‌شود؛ بدون دسترسی به دفاتر، ستون هزینه «—» می‌ماند.",
  },
  {
    key: "schedule_variance",
    label: "انحراف زمان‌بندی",
    description: "فازها و وظایف: تاریخ برنامه‌ای در برابر واقعیت و روزهای تأخیر",
    capability: null,
    columns: [
      { key: "phase", label: "فاز", kind: "text" },
      { key: "phaseStatus", label: "وضعیت فاز", kind: "status" },
      { key: "plannedStart", label: "شروع برنامه‌ای", kind: "date" },
      { key: "plannedEnd", label: "پایان برنامه‌ای", kind: "date" },
      { key: "taskCount", label: "وظایف", kind: "number" },
      { key: "doneTaskCount", label: "انجام‌شده", kind: "number" },
      { key: "overdueTaskCount", label: "عقب‌افتاده", kind: "number" },
      { key: "worstOverdueDays", label: "بیشترین تأخیر (روز)", kind: "number" },
    ],
    emptyMessage: "فازی برای این پروژه ثبت نشده است.",
    note: "تأخیر از مهلت وظایف بازِ همان فاز در برابر امروز محاسبه می‌شود.",
  },
  {
    key: "budget_vs_actual",
    label: "بودجه در برابر واقعی",
    description: "برآورد مصوب یا بودجهٔ پروژه در برابر هزینهٔ ثبت‌شده در دفاتر",
    capability: "financials",
    columns: [
      { key: "label", label: "مبنا", kind: "text" },
      { key: "budgetRial", label: "مبلغ مبنا", kind: "money" },
      { key: "actualCostRial", label: "هزینهٔ ثبت‌شده", kind: "money" },
      { key: "varianceRial", label: "انحراف", kind: "money" },
      { key: "usedPercent", label: "مصرف‌شده", kind: "percent" },
    ],
    emptyMessage: "برآورد مصوب یا بودجه‌ای ثبت نشده است.",
    note: "انحراف مثبت یعنی هنوز بودجه باقی است؛ هزینه همان عدد دفتر روزنامه است، نه یک برآورد.",
  },
  {
    key: "committed_vs_budget",
    label: "تعهد در برابر بودجه",
    description: "تعهدات تأمین و پیمان در برابر برآورد مصوب و ماندهٔ قابل تعهد",
    capability: "financials",
    columns: [
      { key: "label", label: "مبنا", kind: "text" },
      { key: "baselineRial", label: "برآورد مصوب", kind: "money" },
      { key: "actualCostRial", label: "هزینهٔ ثبت‌شده", kind: "money" },
      { key: "committedRial", label: "تعهدشده", kind: "money" },
      { key: "deliveredRial", label: "تحویل‌شده", kind: "money" },
      { key: "uncommittedRial", label: "بدون تعهد", kind: "money" },
    ],
    emptyMessage: "برآورد مصوبی برای مقایسه ثبت نشده است.",
    note: "تعهد هنوز هزینه نیست: از لحظهٔ تسویه، عدد دفترِ روزنامه جای آن را می‌گیرد و هرگز با آن جمع نمی‌شود.",
  },
  {
    key: "forecast_final_cost",
    label: "برآورد هزینهٔ نهایی",
    description: "هزینهٔ نهایی و مبلغ لازم برای اتمام کار، با مبنای محاسبه",
    capability: "financials",
    columns: [
      { key: "label", label: "مبنا", kind: "text" },
      { key: "actualCostRial", label: "هزینهٔ ثبت‌شده", kind: "money" },
      { key: "committedRial", label: "تعهدشده", kind: "money" },
      { key: "costToCompleteRial", label: "تا اتمام کار", kind: "money" },
      { key: "forecastFinalCostRial", label: "هزینهٔ نهایی", kind: "money" },
    ],
    emptyMessage: "برای برآورد هزینهٔ نهایی، برآورد مصوب و دسترسی به دفاتر لازم است.",
    note: "روش محاسبه زیر همین جدول نوشته می‌شود؛ نبودِ هر نیمه، عدد را «—» می‌کند نه صفر.",
  },
  {
    key: "project_margin",
    label: "حاشیهٔ سود پیش‌بینی‌شده",
    description: "ارزش اصلاح‌شدهٔ قرارداد منهای هزینهٔ نهایی پیش‌بینی‌شده",
    capability: "financials",
    columns: [
      { key: "label", label: "مبنا", kind: "text" },
      { key: "revisedContractRial", label: "ارزش اصلاح‌شدهٔ قرارداد", kind: "money" },
      { key: "forecastFinalCostRial", label: "هزینهٔ نهایی", kind: "money" },
      { key: "marginRial", label: "حاشیه", kind: "money" },
      { key: "marginPercent", label: "درصد حاشیه", kind: "percent" },
    ],
    emptyMessage: "برای حاشیه، قرارداد و برآورد هزینهٔ نهایی لازم است.",
    note: "این حاشیهٔ *پیش‌بینی‌شده* است؛ سود شناسایی‌شده و حاشیهٔ محقق‌شدهٔ نهایی گزارش حسابداری است.",
  },
  {
    key: "boq_variance",
    label: "انحراف متره و برآورد",
    description: "برآورد مصوب به تفکیک فصل در برابر هزینهٔ ثبت‌شدهٔ پروژه",
    capability: "boq",
    columns: [
      { key: "section", label: "فصل", kind: "text" },
      { key: "totalRial", label: "مبلغ فصل", kind: "money" },
      { key: "sharePercent", label: "سهم از برآورد", kind: "percent" },
    ],
    emptyMessage: "نسخهٔ مصوب برآوردی برای این پروژه وجود ندارد.",
    note: "مقایسهٔ سطر‌به‌سطر فصل‌ها با دفتر کل ممکن نیست؛ هزینهٔ ثبت‌شده در سطح پروژه در همین کارت آمده است.",
  },
  {
    key: "change_order_exposure",
    label: "مواجهه با تغییرات",
    description: "تغییرات به‌تفکیک وضعیت: مبلغ ارسالی، تأییدشده و در انتظار تصمیم",
    capability: "variations",
    columns: [
      { key: "variationNumber", label: "شماره", kind: "text" },
      { key: "description", label: "موضوع", kind: "text" },
      { key: "status", label: "وضعیت", kind: "status" },
      { key: "submittedAmountRial", label: "مبلغ ارسالی", kind: "money" },
      { key: "approvedAmountRial", label: "مبلغ تأییدشده", kind: "money" },
      { key: "scheduleImpactDays", label: "اثر زمانی (روز)", kind: "number" },
      { key: "submittedDate", label: "تاریخ ارسال", kind: "date" },
      { key: "ageDays", label: "عمر (روز)", kind: "number" },
      { key: "agingBucket", label: "بازه", kind: "text" },
    ],
    emptyMessage: "تغییری برای این پروژه ثبت نشده است.",
    note: "مبلغ تأییدشدهٔ تغییرات همان چیزی است که ارزش اصلاح‌شدهٔ قرارداد را می‌سازد.",
  },
  {
    key: "procurement_delay",
    label: "تأخیر تأمین",
    description: "تعهدات خرید و پیمان گذشته از موعد تحویل، به‌ترتیب بدترین تأخیر",
    capability: "procurement",
    columns: [
      { key: "commitmentNumber", label: "شمارهٔ تعهد", kind: "text" },
      { key: "kind", label: "نوع", kind: "text" },
      { key: "supplierName", label: "تأمین‌کننده", kind: "text" },
      { key: "title", label: "موضوع", kind: "text" },
      { key: "valueRial", label: "مبلغ", kind: "money" },
      { key: "expectedDeliveryDate", label: "تحویل مورد انتظار", kind: "date" },
      { key: "delayDays", label: "تأخیر (روز)", kind: "number" },
      { key: "agingBucket", label: "بازه", kind: "text" },
    ],
    emptyMessage: "هیچ تعهد تأمینی از موعد تحویل خود نگذشته است.",
    note: "همان تعهدهایی که تب «تأمین کالا» و هشدار ساعتی می‌بینند — یک تعریف از «تأخیر»، نه سه عدد.",
  },
  {
    key: "rfi_aging",
    label: "عمر استعلام‌ها (RFI)",
    description: "استعلام‌های باز با سررسید و تعداد روزهای گذشته از آن",
    capability: null,
    columns: [
      { key: "rfiNumber", label: "شماره", kind: "text" },
      { key: "subject", label: "موضوع", kind: "text" },
      { key: "assignedToName", label: "مسئول پاسخ", kind: "text" },
      { key: "responsiblePartyName", label: "طرف مسئول", kind: "text" },
      { key: "dueDate", label: "سررسید", kind: "date" },
      { key: "daysOverdue", label: "روز تأخیر", kind: "number" },
      { key: "agingBucket", label: "بازه", kind: "text" },
    ],
    emptyMessage: "استعلام باز و بدون پاسخ‌مانده‌ای نیست.",
    note: "همان صف تب استعلام‌ها و ابزار دستیار؛ بیش از سررسید اولین سطرها می‌آیند.",
  },
  {
    key: "submittal_aging",
    label: "عمر ارسال مدارک",
    description: "ارسال‌هایی که در دست بررسی‌اند یا بازنگری‌شان معطل مانده است",
    capability: "document_control",
    columns: [
      { key: "submittalNumber", label: "شماره", kind: "text" },
      { key: "title", label: "عنوان", kind: "text" },
      { key: "submissionType", label: "نوع", kind: "text" },
      { key: "status", label: "وضعیت", kind: "status" },
      { key: "reviewerName", label: "بازبین", kind: "text" },
      { key: "dueDate", label: "مهلت پاسخ", kind: "date" },
      { key: "daysOverdue", label: "روز از مهلت گذشته", kind: "number" },
      { key: "agingBucket", label: "بازه", kind: "text" },
    ],
    emptyMessage: "ارسالی در انتظار بررسی نیست.",
  },
  {
    key: "document_status",
    label: "وضعیت مدارک و بازنگری‌ها",
    description: "نقشه‌ها و اسناد با آخرین بازنگری، وضعیت آن و تعداد بازنگری",
    capability: "document_control",
    columns: [
      { key: "documentNumber", label: "شمارهٔ سند", kind: "text" },
      { key: "title", label: "عنوان", kind: "text" },
      { key: "documentType", label: "نوع", kind: "text" },
      { key: "latestRevisionCode", label: "آخرین بازنگری", kind: "text" },
      { key: "latestRevisionStatus", label: "وضعیت بازنگری", kind: "status" },
      { key: "revisionCount", label: "تعداد بازنگری", kind: "number" },
      { key: "updatedAt", label: "آخرین تغییر", kind: "date" },
    ],
    emptyMessage: "سندی برای این پروژه ثبت نشده است.",
    note: "«آخرین بازنگری» را تریگر بانک اطلاعاتی می‌سازد؛ گزارش آن را از نو مرتب نمی‌کند.",
  },
  {
    key: "contractor_performance",
    label: "عملکرد تأمین‌کنندگان",
    description: "تعهدات هر طرف: مبلغ، تحویل‌شده، تأخیر و بدترین تأخیر",
    capability: "procurement",
    columns: [
      { key: "supplierName", label: "طرف", kind: "text" },
      { key: "commitmentCount", label: "تعداد تعهد", kind: "number" },
      { key: "committedRial", label: "مبلغ تعهد", kind: "money" },
      { key: "deliveredRial", label: "تحویل‌شده", kind: "money" },
      { key: "deliveredOnTimeCount", label: "به‌موقع", kind: "number" },
      { key: "lateCount", label: "با تأخیر", kind: "number" },
      { key: "worstDelayDays", label: "بدترین تأخیر (روز)", kind: "number" },
    ],
    emptyMessage: "تعهدی با تأمین‌کننده‌ای ثبت نشده است.",
    note: "«به‌موقع» یعنی تحویل تا تاریخ مورد انتظار همان تعهد؛ تأخیر تعهدهای بازِ گذشته از موعد جدا شمرده می‌شود.",
  },
  {
    key: "site_productivity",
    label: "بهره‌وری کارگاه",
    description: "روزهای ثبت‌شدهٔ کارگاه: نیرو، تأخیر، رخداد و مصالح رسیده",
    capability: "site_operations",
    columns: [
      { key: "logDate", label: "تاریخ", kind: "date" },
      { key: "status", label: "وضعیت", kind: "status" },
      { key: "workforce", label: "نیرو", kind: "number" },
      { key: "lineCount", label: "سطرهای گزارش", kind: "number" },
      { key: "deliveryCount", label: "مصالح رسیده", kind: "number" },
      { key: "incidentCount", label: "رخداد", kind: "number" },
      { key: "authorName", label: "ثبت‌کننده", kind: "text" },
    ],
    emptyMessage: "گزارش روزانه‌ای برای این پروژه ثبت نشده است.",
  },
  {
    key: "snag_aging",
    label: "عمر نقص‌ها",
    description: "نقص‌های باز کارگاه با شدت، مسئول و روزهای گذشته از مهلت",
    capability: "snagging",
    columns: [
      { key: "issueNumber", label: "شماره", kind: "text" },
      { key: "title", label: "موضوع", kind: "text" },
      { key: "severity", label: "شدت", kind: "status" },
      { key: "status", label: "وضعیت", kind: "status" },
      { key: "assigneeName", label: "مسئول", kind: "text" },
      { key: "dueDate", label: "مهلت", kind: "date" },
      { key: "daysOverdue", label: "روز تأخیر", kind: "number" },
      { key: "agingBucket", label: "بازه", kind: "text" },
    ],
    emptyMessage: "نقص باز و عقب‌افتاده‌ای ثبت نشده است.",
  },
  {
    key: "inspection_status",
    label: "وضعیت بازرسی‌ها و عدم‌انطباق‌ها",
    description: "بازرسی، عدم‌انطباق، اقدام اصلاحی و تحویل: باز، در جریان و مانده",
    capability: "qa_qc",
    columns: [
      { key: "kind", label: "نوع", kind: "text" },
      { key: "openCount", label: "باز", kind: "number" },
      { key: "inProgressCount", label: "در جریان", kind: "number" },
      { key: "resolvedCount", label: "حل‌شده", kind: "number" },
      { key: "overdueCount", label: "از مهلت گذشته", kind: "number" },
      { key: "oldestOpenDays", label: "قدیمی‌ترین (روز)", kind: "number" },
    ],
    emptyMessage: "موردی در دفتر کیفیت این پروژه ثبت نشده است.",
    note: "«حل‌شده» هنوز بسته نشده است: بستن، تأیید جداگانه‌ای می‌خواهد.",
  },
  {
    key: "certificate_status",
    label: "وضعیت صورت‌وضعیت‌ها و گواهی‌ها",
    description: "صورت‌وضعیت‌ها و گواهی‌ها با مبلغ خالص، تأییدشده و تاریخ‌ها",
    capability: "progress_claims",
    columns: [
      { key: "certificateNumber", label: "شماره", kind: "text" },
      { key: "kind", label: "نوع", kind: "text" },
      { key: "status", label: "وضعیت", kind: "status" },
      { key: "periodEnd", label: "پایان دوره", kind: "date" },
      { key: "netRial", label: "خالص", kind: "money" },
      { key: "approvedAmountRial", label: "تأییدشده", kind: "money" },
      { key: "certifiedDate", label: "تاریخ گواهی", kind: "date" },
    ],
    emptyMessage: "صورت‌وضعیت یا گواهی‌ای برای این پروژه ثبت نشده است.",
    note: "«گواهی‌شده ≠ وصول‌شده»: دریافت و پرداخت در حسابداری ثبت می‌شود و این گزارش آن را تکرار نمی‌کند.",
  },
];

export function isAecReportKey(value: string): value is AecReportKey {
  return (AEC_REPORT_KEYS as readonly string[]).includes(value);
}

export function aecReportDefinition(key: AecReportKey): AecReportDefinition {
  const found = AEC_REPORTS.find((report) => report.key === key);
  if (!found) throw new Error(`unknown AEC report: ${key}`);
  return found;
}

/**
 * The reports a business with these capabilities has — §21's rule applied to
 * §30's list. An ungated report (the project's health, the schedule, the RFI
 * aging) is always present; a gated one appears with the capability that owns
 * its register, so switching `procurement` off removes the delay and the
 * supplier reports rather than emptying them.
 */
export function reportsForCapabilities(
  capabilities: readonly AecCapabilityKey[],
): readonly AecReportDefinition[] {
  const on = new Set<string>(capabilities);
  return AEC_REPORTS.filter((report) => report.capability === null || on.has(report.capability));
}

/** §30's list for the phase doc and the tests: every entry this build answers. */
export function aecReportKeysFor(keys: readonly AecReportKey[]): readonly AecReportDefinition[] {
  return AEC_REPORTS.filter((report) => keys.includes(report.key));
}

/**
 * The AI-read tools each report's question is answered by, where one exists.
 *
 * §34 asks for "AI summaries with transparent source links", and §23's tools and
 * §30's reports are two readers of the same registers. Naming the tool here means
 * the screen can say *which* read produced a figure — the link a reviewer needs
 * when a number and a narration disagree — instead of a report and an assistant
 * each claiming to be the source.
 */
export const AEC_REPORT_AI_TOOL: Partial<Record<AecReportKey, AecAiToolName>> = {
  boq_variance: "get_boq_variance",
  change_order_exposure: "list_change_orders",
  procurement_delay: "list_procurement_delays",
  rfi_aging: "list_pending_rfis",
  submittal_aging: "list_pending_submittals",
  document_status: "get_latest_drawing_revision",
  snag_aging: "list_site_issues",
  certificate_status: "list_payment_certificates",
  project_margin: "list_project_commercial_risks",
  project_health: "get_aec_project_financial_health",
  schedule_variance: "list_delayed_project_activities",
};

/**
 * Aging buckets, so two reports do not invent two thresholds.
 *
 * The buckets are the ones the reminder scans already use: fourteen days is the
 * point a claim or a submission is "waiting" (§29), and thirty is the point a
 * register reads as neglected on a dashboard.
 */
export const AEC_AGING_BUCKETS = [0, 14, 30, 60] as const;

export function agingBucket(days: number): "on_time" | "waiting" | "late" | "stale" {
  if (days <= AEC_AGING_BUCKETS[0]) return "on_time";
  if (days <= AEC_AGING_BUCKETS[1]) return "waiting";
  if (days <= AEC_AGING_BUCKETS[2]) return "late";
  return "stale";
}

export const AEC_AGING_BUCKET_LABELS: Record<ReturnType<typeof agingBucket>, string> = {
  on_time: "به‌موقع",
  waiting: "تا ۱۴ روز",
  late: "تا ۳۰ روز",
  stale: "بیش از ۳۰ روز",
};

/** Whole days between two `YYYY-MM-DD` days; 0 when either is unreadable. */
export function reportAgeDays(from: string | null | undefined, today: string): number {
  if (!from) return 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((now - start) / 86_400_000));
}

/** A ratio as a whole percent, or `null` when the denominator is missing or zero. */
export function reportPercent(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole === 0) return null;
  return Math.round((part / whole) * 100);
}
