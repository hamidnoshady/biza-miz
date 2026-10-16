/**
 * The Financial Accounts reports, as pure table builders (issue #862).
 *
 * Three reports the issue asks for — the account card (صورت حساب), the transfer
 * register and the balance summary — shaped as `ReportTable`s rather than as
 * files. Each route then renders the same table as CSV or Excel through the
 * platform's one export layer (`rowsToCsv` / `rowsToXlsxBuffer`), so the BOM,
 * the CRLF, the Shamsi dates and the formula-injection guard are whatever every
 * other report in the product already uses; this module only decides *what the
 * columns are and what the numbers say*.
 *
 * It lives outside the services for the repo's usual reason: a DB-touching
 * module has no direct unit test, so the part that decides what a number *says*
 * has to be reachable from one (`financial-account-reports.test.ts`).
 *
 * ## The money cells
 *
 * Every figure here arrives already summed from `journal_lines` as exact deci
 * mal text (see `financial-accounts-service.financialAccountCard`), and is
 * emitted in the business's own display unit without ever passing through
 * `Number` — a Rial integer is 64-bit in Postgres and `Number` stops being
 * exact at 2^53, which is a real balance in Rial for a busy business. A value
 * that still fits a safe integer is written as a *number* so a spreadsheet can
 * add the column up; anything larger stays text rather than being silently
 * rounded.
 */
import { formatJalali } from "./jalali";
import { moneyColumnLabel, type ReportTable } from "./report-export";
import type { MoneyUnit } from "./money";
import {
  FINANCIAL_ACCOUNT_KIND_META,
  type FinancialAccountKind,
} from "./financial-accounts";
import { TRANSFER_STATUS_LABELS, type TransferStatus } from "./financial-transfers";

/** A Rial amount in the business's unit, exactly — BigInt, never `Number`. */
function moneyText(rialText: string, unit: MoneyUnit): string {
  const value = BigInt(rialText);
  // Toman drops the single Rial digit, exactly as `rialToToman` does, and
  // truncates toward zero for a negative balance (an overdrawn account).
  return (unit === "rial" ? value : value / 10n).toString();
}

/** The same value for a spreadsheet: a number while that is still exact. */
function moneyCell(rialText: string, unit: MoneyUnit): string | number {
  const text = moneyText(rialText, unit);
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : text;
}

function shamsi(value: string | null | undefined): string {
  return value ? formatJalali(value) : "";
}

// ---------------------------------------------------------------------------
// Account card
// ---------------------------------------------------------------------------

export interface AccountCardExportRow {
  entryDate: string;
  entryId: string;
  memo: string | null;
  counterparty: string;
  /** Exact Rial, as decimal text. */
  debit: string;
  credit: string;
  balance: string;
}

export interface AccountCardExportMeta {
  accountName: string;
  accountKind: FinancialAccountKind;
  glAccountCode: string;
  glAccountName: string;
  branchName: string;
  currencyCode: string;
  from: string | null;
  to: string | null;
  opening: string;
  totalDebit: string;
  totalCredit: string;
  closing: string;
  ledgerBalance: string;
  reconciliationDifference: string;
}

/**
 * The account card as two tables: the account's own identity and reconciliation
 * header, then its movements.
 *
 * The header repeats the reconciliation the screen shows — opening, movements,
 * closing and the ledger's own balance — because a card that leaves the system
 * has to prove it agrees with the ledger it came from without anyone opening
 * the app.
 */
export function accountCardTables(
  meta: AccountCardExportMeta,
  rows: readonly AccountCardExportRow[],
  unit: MoneyUnit,
): { header: ReportTable; movements: ReportTable } {
  const kindLabel = FINANCIAL_ACCOUNT_KIND_META[meta.accountKind]?.label ?? "";
  const header: ReportTable = {
    columns: [
      { key: "label", label: "شرح" },
      { key: "value", label: "مقدار" },
    ],
    rows: [
      { label: "حساب", value: meta.accountName },
      { label: "نوع", value: kindLabel },
      { label: "سرفصل دفتر کل", value: `${meta.glAccountName} (${meta.glAccountCode})` },
      { label: "شعبه", value: meta.branchName },
      { label: "ارز", value: meta.currencyCode },
      { label: "از تاریخ", value: meta.from ? shamsi(meta.from) : "—" },
      { label: "تا تاریخ", value: meta.to ? shamsi(meta.to) : "—" },
      { label: moneyColumnLabel("مانده ابتدای دوره", unit), value: moneyCell(meta.opening, unit) },
      { label: moneyColumnLabel("جمع بدهکار", unit), value: moneyCell(meta.totalDebit, unit) },
      { label: moneyColumnLabel("جمع بستانکار", unit), value: moneyCell(meta.totalCredit, unit) },
      { label: moneyColumnLabel("مانده پایان دوره", unit), value: moneyCell(meta.closing, unit) },
      { label: moneyColumnLabel("مانده دفتر کل", unit), value: moneyCell(meta.ledgerBalance, unit) },
      {
        label: moneyColumnLabel("مغایرت با دفتر کل", unit),
        value: moneyCell(meta.reconciliationDifference, unit),
      },
    ],
  };
  const movements: ReportTable = {
    columns: [
      { key: "entryDate", label: "تاریخ" },
      { key: "entryId", label: "شماره سند" },
      { key: "memo", label: "شرح" },
      { key: "counterparty", label: "طرف مقابل" },
      { key: "debit", label: moneyColumnLabel("بدهکار", unit) },
      { key: "credit", label: moneyColumnLabel("بستانکار", unit) },
      { key: "balance", label: moneyColumnLabel("مانده", unit) },
    ],
    rows: rows.map((row) => ({
      entryDate: shamsi(row.entryDate),
      entryId: row.entryId,
      memo: row.memo ?? "",
      counterparty: row.counterparty,
      debit: moneyCell(row.debit, unit),
      credit: moneyCell(row.credit, unit),
      balance: moneyCell(row.balance, unit),
    })),
  };
  return { header, movements };
}

// ---------------------------------------------------------------------------
// Transfer register
// ---------------------------------------------------------------------------

export interface TransferRegisterExportRow {
  transferNumber: string;
  transferDate: string;
  sourceAccountName: string | null;
  destinationAccountName: string | null;
  amount: string;
  feeAmount: string;
  feePayerLabel: string;
  currencyCode: string;
  status: TransferStatus;
  referenceNumber: string | null;
  description: string | null;
  projectName: string | null;
  branchName: string | null;
  createdByName: string | null;
  journalEntryId: string;
}

export function transferRegisterTable(
  rows: readonly TransferRegisterExportRow[],
  unit: MoneyUnit,
): ReportTable {
  return {
    columns: [
      { key: "transferNumber", label: "شماره انتقال" },
      { key: "transferDate", label: "تاریخ" },
      { key: "sourceAccountName", label: "از حساب" },
      { key: "destinationAccountName", label: "به حساب" },
      { key: "amount", label: moneyColumnLabel("مبلغ", unit) },
      { key: "feeAmount", label: moneyColumnLabel("کارمزد", unit) },
      { key: "feePayerLabel", label: "پرداخت کارمزد" },
      { key: "currencyCode", label: "ارز" },
      { key: "status", label: "وضعیت" },
      { key: "referenceNumber", label: "شماره پیگیری" },
      { key: "description", label: "شرح" },
      { key: "projectName", label: "پروژه" },
      { key: "branchName", label: "شعبه" },
      { key: "createdByName", label: "ثبت‌کننده" },
      { key: "journalEntryId", label: "شناسه سند" },
    ],
    rows: rows.map((row) => ({
      transferNumber: row.transferNumber,
      transferDate: shamsi(row.transferDate),
      sourceAccountName: row.sourceAccountName ?? "",
      destinationAccountName: row.destinationAccountName ?? "",
      amount: moneyCell(row.amount, unit),
      feeAmount: moneyCell(row.feeAmount, unit),
      feePayerLabel: row.feePayerLabel,
      currencyCode: row.currencyCode,
      status: TRANSFER_STATUS_LABELS[row.status] ?? row.status,
      referenceNumber: row.referenceNumber ?? "",
      description: row.description ?? "",
      projectName: row.projectName ?? "",
      branchName: row.branchName ?? "",
      createdByName: row.createdByName ?? "",
      journalEntryId: row.journalEntryId,
    })),
  };
}

// ---------------------------------------------------------------------------
// Balance summary
// ---------------------------------------------------------------------------

export interface BalanceSummaryExportRow {
  kind: FinancialAccountKind;
  name: string;
  code: string | null;
  glAccountCode: string;
  glAccountName: string;
  branchName: string;
  currencyCode: string;
  isDefault: boolean;
  isActive: boolean;
  balance: string;
}

export function balanceSummaryTable(
  rows: readonly BalanceSummaryExportRow[],
  unit: MoneyUnit,
): ReportTable {
  const total = rows.reduce((sum, row) => sum + BigInt(row.balance), 0n).toString();
  return {
    columns: [
      { key: "kind", label: "نوع" },
      { key: "name", label: "حساب" },
      { key: "code", label: "کد حساب" },
      { key: "glAccountCode", label: "سرفصل دفتر کل" },
      { key: "glAccountName", label: "نام سرفصل" },
      { key: "branchName", label: "شعبه" },
      { key: "currencyCode", label: "ارز" },
      { key: "isDefault", label: "پیش‌فرض" },
      { key: "status", label: "وضعیت" },
      { key: "balance", label: moneyColumnLabel("مانده", unit) },
    ],
    rows: [
      ...rows.map((row) => ({
        kind: FINANCIAL_ACCOUNT_KIND_META[row.kind]?.label ?? row.kind,
        name: row.name,
        code: row.code ?? "",
        glAccountCode: row.glAccountCode,
        glAccountName: row.glAccountName,
        branchName: row.branchName,
        currencyCode: row.currencyCode,
        isDefault: row.isDefault ? "بله" : "خیر",
        status: row.isActive ? "فعال" : "بایگانی",
        balance: moneyCell(row.balance, unit),
      })),
      {
        kind: "",
        name: "جمع کل",
        code: "",
        glAccountCode: "",
        glAccountName: "",
        branchName: "",
        currencyCode: "",
        isDefault: "",
        status: "",
        balance: moneyCell(total, unit),
      },
    ],
  };
}

/** The filename a download lands as: what it is, then the day it covers. */
export function financialReportFilename(
  report: "account-card" | "transfer-register" | "balance-summary",
  format: "csv" | "xlsx",
  options: { accountCode?: string | null; from?: string | null; to?: string | null } = {},
): string {
  const stamp = options.to ?? options.from ?? null;
  const suffix = stamp ? `-${stamp.replaceAll("-", "")}` : "";
  const base =
    report === "account-card"
      ? `financial-account-card${options.accountCode ? `-${options.accountCode}` : ""}`
      : report === "transfer-register"
        ? "financial-transfer-register"
        : "financial-account-balances";
  return `${base}${suffix}.${format}`;
}
