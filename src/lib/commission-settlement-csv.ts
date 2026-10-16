/**
 * CSV exports of the settlement screens (issue #869).
 *
 * Dates are Shamsi, as on the screen (the file is read by the people who read
 * the screen). Amounts are exact signed text in the business's display unit, via
 * `moneyToExportText`, so the file agrees with the screen and never divides by
 * ten here. The unit's name comes from the business setting, never a fixed
 * label. The bytes come from the shared `toCsv` codec (BOM, CRLF and the
 * formula-injection guard for every cell).
 */
import { toCsv } from "./data-transfer/codecs";
import { formatJalali } from "./jalali";
import { moneyToExportText, type MoneyUnit } from "./money";
import { COMMISSION_RUN_STATUS_LABELS, type CommissionRunStatus } from "./commission-settlement-lifecycle";

export interface LineExportRow {
  runNumber: number;
  lineKind: "accrual" | "carry_forward";
  saleDate: string | null;
  employeeName: string;
  employeeCode: string | null;
  sourceLabel: string;
  orderNumber: string | null;
  itemName: string | null;
  /** Integer Rial, as text. */
  basisAmount: string;
  /** Integer Rial, signed, as text. */
  amount: string;
  ruleVersion: string | null;
  entryId: string | null;
}

export interface RunExportRow {
  runNumber: number;
  title: string | null;
  periodFrom: string;
  periodTo: string;
  status: CommissionRunStatus;
  lineCount: number;
  employeeCount: number;
  /** Integer Rial, as text. */
  commissionTotal: string;
  paidTotal: string;
  outstandingTotal: string;
  /** How many calculation warnings the run carries (blocked balances, unmapped sellers, payroll-claimed rows, …). */
  warningCount: number;
  createdAt: string;
}

function unitWord(unit: MoneyUnit): string {
  return unit === "rial" ? "ریال" : "تومان";
}

function shamsi(value: string | null): string {
  return value ? formatJalali(value) : "";
}

function displayAmount(rialText: string, unit: MoneyUnit): string {
  return moneyToExportText(rialText, unit);
}

export function runLinesToCsv(rows: readonly LineExportRow[], unit: MoneyUnit): string {
  const word = unitWord(unit);
  const headers = [
    "شماره دوره",
    "تاریخ فروش",
    "فروشنده",
    "کد پرسنلی",
    "نوع ردیف",
    "منبع",
    "شماره سفارش",
    "کالا",
    `مبنای محاسبه (${word})`,
    `پورسانت (${word})`,
    "نسخهٔ قانون",
    "شناسهٔ سند",
  ];
  const body = rows.map((row) => [
    row.runNumber,
    shamsi(row.saleDate),
    row.employeeName,
    row.employeeCode ?? "",
    row.lineKind === "carry_forward" ? "مانده دورهٔ قبل" : "پورسانت",
    row.sourceLabel,
    row.orderNumber ?? "",
    row.itemName ?? "",
    displayAmount(row.basisAmount, unit),
    displayAmount(row.amount, unit),
    row.ruleVersion ?? "",
    row.entryId ?? "",
  ]);
  return toCsv(headers, body);
}

export function runsToCsv(rows: readonly RunExportRow[], unit: MoneyUnit): string {
  const word = unitWord(unit);
  const headers = [
    "شماره دوره",
    "عنوان",
    "از تاریخ",
    "تا تاریخ",
    "وضعیت",
    "تعداد ردیف",
    "تعداد فروشنده",
    `کل پورسانت (${word})`,
    `پرداخت‌شده (${word})`,
    `باقی‌مانده (${word})`,
    "تعداد هشدار",
    "تاریخ ایجاد",
  ];
  const body = rows.map((row) => [
    row.runNumber,
    row.title ?? "",
    shamsi(row.periodFrom),
    shamsi(row.periodTo),
    COMMISSION_RUN_STATUS_LABELS[row.status],
    row.lineCount,
    row.employeeCount,
    displayAmount(row.commissionTotal, unit),
    displayAmount(row.paidTotal, unit),
    displayAmount(row.outstandingTotal, unit),
    row.warningCount,
    formatJalali(row.createdAt, { withTime: true }),
  ]);
  return toCsv(headers, body);
}

/** A complete filtered history, with lifetime totals repeated explicitly as such. */
export function statementToCsv(statement: import("./commission-settlement-service").CommissionStatement, unit: MoneyUnit): string {
  const amount = (value: string) => displayAmount(value, unit);
  const totals = statement.totals;
  const common = [statement.employee.fullName, amount(totals.accrued), amount(totals.paidThroughPayroll),
    amount(totals.paidThroughRuns), amount(totals.unpaid)];
  return toCsv([
    "فروشنده", `کل پورسانت ثبت‌شده (${unitWord(unit)})`, "کل پرداخت از حقوق", "کل پرداخت از تسویه", "کل مانده",
    "نوع ردیف", "شناسه", "تاریخ", "منبع", `مبلغ (${unitWord(unit)})`, "دوره تسویه", "دوره حقوق", "سند", "فروش",
  ], [
    // Even an empty detail selection must export the lifetime position.
    [...common, "جمع کل", "", "", "", "", "", "", "", ""],
    ...statement.accruals.map((row) => [...common, "ثبت پورسانت", row.id, shamsi(row.saleDate), row.sourceLabel,
      amount(row.amount), row.settlementRunId ?? "", row.payrollRunId ?? "", row.entryId ?? "", row.orderId ?? ""]),
    ...statement.payouts.map((row) => [...common, row.kind === "reversal" ? "برگشت پرداخت" : "پرداخت", row.payoutId,
      shamsi(row.paidDate), "", amount(row.amount), row.runId, "", row.entryId ?? "", ""]),
  ]);
}
