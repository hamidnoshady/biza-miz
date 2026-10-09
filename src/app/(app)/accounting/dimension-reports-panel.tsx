"use client";

/**
 * «گزارش‌های ابعاد» — the three views a person reads a dimension by:
 *
 *   * «ماتریس حساب × بعد»  — every account, against every value of one kind;
 *   * «سود به تفکیک مرکز سود» — profit and loss per profit centre;
 *   * «کارت حساب مرکز هزینه» — one account's lines for one value, with its balance.
 *
 * Every view reads one kind at a time, and every total is the sum of the
 * columns above it. The server checks that sum against the unfiltered ledger
 * and sends `reconciled`; a report that does not reconcile says so in red
 * instead of looking correct.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DownloadIcon, PrinterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { ErrorBox, api, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { toCsv } from "@/lib/data-transfer/csv";
import { todayIsoDate } from "@/lib/jalali";
import {
  UNASSIGNED_DIMENSION,
  dimensionErrorMessage,
  type DimensionKind,
  type DimensionValueRecord,
} from "@/lib/accounting-dimensions";
import { columnKey } from "@/lib/accounting-dimension-reports";
import {
  cardTable,
  matrixCellDrill,
  matrixTable,
  profitTable,
  type PlainTable,
} from "./dimension-report-table";
import { currentJalaliMonthStartIso, isoToJalaliText } from "./dimension-catalog";

type View = "matrix" | "profit" | "card";

const VIEWS: readonly { key: View; label: string }[] = [
  { key: "matrix", label: "ماتریس حساب × بعد" },
  { key: "profit", label: "سود به تفکیک مرکز سود" },
  { key: "card", label: "کارت حساب مرکز هزینه" },
];

const ACCOUNT_TYPE_OPTIONS = [
  { value: "", label: "همهٔ حساب‌ها" },
  { value: "expense", label: "هزینه‌ها" },
  { value: "revenue", label: "درآمدها" },
  { value: "asset", label: "دارایی‌ها" },
  { value: "liability", label: "بدهی‌ها" },
  { value: "equity", label: "سرمایه" },
];

interface AccountOption {
  id: string;
  code: string;
  name: string;
}

interface MatrixReport {
  columns: { valueId: string | null; code: string | null; name: string; isActive: boolean }[];
  rows: { accountId: string; code: string; name: string; type: string; cells: Record<string, number>; total: number }[];
  columnTotals: Record<string, number>;
  grandTotal: number;
  reconciled: boolean;
}

interface ProfitReport {
  groups: {
    valueId: string | null;
    code: string | null;
    name: string;
    revenue: number;
    costOfSales: number;
    grossProfit: number;
    laborCost: number;
    operatingExpenses: number;
    netIncome: number;
  }[];
  total: {
    revenue: number;
    costOfSales: number;
    grossProfit: number;
    laborCost: number;
    operatingExpenses: number;
    netIncome: number;
  };
  reconciled: boolean;
}

interface CardStatement {
  accountCode: string;
  accountName: string;
  openingBalance: number;
  closingBalance: number;
  lines: { entryId: string; date: string; memo: string | null; debit: number; credit: number; balance: number }[];
}

type Loaded =
  | { view: "matrix"; report: MatrixReport; kind: DimensionKind; dateFrom: string; dateTo: string }
  | { view: "profit"; report: ProfitReport }
  | { view: "card"; report: CardStatement };

function errorText(code: string | undefined): string {
  if (!code) return "گزارش بارگذاری نشد.";
  if (code === "invalid_report_scope") return "بازهٔ گزارش معتبر نیست.";
  if (code === "account_not_found") return "حساب انتخاب‌شده در این کسب‌وکار پیدا نشد.";
  if (code === "unknown_dimension_kind") return "نوع بُعد ناشناخته است.";
  if (code === "invalid_account_type") return "نوع حساب معتبر نیست.";
  return dimensionErrorMessage(code);
}

/** Whether a loaded report has anything to draw. A card with no lines still has a balance worth showing. */
function hasContent(loaded: Loaded): boolean {
  if (loaded.view === "matrix") return loaded.report.rows.length > 0;
  if (loaded.view === "profit") return loaded.report.groups.length > 0;
  return true;
}

/** The journal link for one body cell of the matrix, or null (issue #868). */
function matrixDrillHref(loaded: Loaded | null, rowIndex: number, cellIndex: number): string | null {
  if (!loaded || loaded.view !== "matrix") return null;
  return matrixCellDrill({
    report: loaded.report,
    kind: loaded.kind,
    period: { dateFrom: loaded.dateFrom, dateTo: loaded.dateTo },
    rowIndex,
    cellIndex,
    columnKeyOf: columnKey,
  });
}

function reportTable(loaded: Loaded): PlainTable {
  if (loaded.view === "matrix") return matrixTable(loaded.report, columnKey);
  if (loaded.view === "profit") return profitTable(loaded.report);
  return cardTable(loaded.report);
}

export function DimensionReportsPanel({
  enabledKinds,
  kindLabel,
  values,
}: {
  enabledKinds: readonly DimensionKind[];
  /** The business's name for a kind, the detail kind included. */
  kindLabel: (kind: DimensionKind) => string;
  /** Every value, archived ones included: last year's report still names last year's centres. */
  values: readonly DimensionValueRecord[];
}) {
  const money = useMoney();
  const [view, setView] = useState<View>("matrix");
  const [kind, setKind] = useState<DimensionKind>(enabledKinds[0] ?? "cost_center");
  const [dateFrom, setDateFrom] = useState(() => currentJalaliMonthStartIso());
  const [dateTo, setDateTo] = useState(() => todayIsoDate());
  const [accountType, setAccountType] = useState("");
  const [accountId, setAccountId] = useState("");
  const [valueId, setValueId] = useState<string>(UNASSIGNED_DIMENSION);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  // The chart, read once, for the card's account picker.
  useEffect(() => {
    let cancelled = false;
    void api<{ accounts?: AccountOption[] }>("/api/ledger/accounts").then((r) => {
      if (!cancelled) setAccounts(r.ok ? (r.data.accounts ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A kind the business has since switched off cannot stay selected.
  useEffect(() => {
    if (enabledKinds.length > 0 && !enabledKinds.includes(kind)) setKind(enabledKinds[0]);
  }, [enabledKinds, kind]);

  const kindValues = useMemo(() => values.filter((v) => v.kind === kind), [values, kind]);
  const periodProblem = dateFrom > dateTo ? "بازهٔ گزارش برعکس است؛ تاریخ شروع باید پیش از پایان باشد." : "";
  const cardNeedsAccount = view === "card" && !accountId;

  useEffect(() => {
    if (periodProblem || enabledKinds.length === 0 || cardNeedsAccount) return;
    const id = ++requestRef.current;
    const params = new URLSearchParams({ view, kind, dateFrom, dateTo });
    if (view === "matrix" && accountType) params.set("accountType", accountType);
    if (view === "card") {
      params.set("accountId", accountId);
      params.set("value", valueId);
    }
    setLoading(true);
    setError("");
    void api<Record<string, unknown>>(`/api/ledger/dimension-reports?${params.toString()}`).then((r) => {
      if (id !== requestRef.current) return;
      setLoading(false);
      if (!r.ok) {
        setLoaded(null);
        setError(errorText(typeof r.data.error === "string" ? r.data.error : undefined));
        return;
      }
      if (view === "card") {
        setLoaded({ view, report: r.data.statement as unknown as CardStatement });
      } else if (view === "matrix") {
        setLoaded({ view, report: r.data as unknown as MatrixReport, kind, dateFrom, dateTo });
      } else {
        setLoaded({ view, report: r.data as unknown as ProfitReport });
      }
    });
  }, [view, kind, dateFrom, dateTo, accountType, accountId, valueId, periodProblem, cardNeedsAccount, enabledKinds.length]);

  const table = useMemo(() => (loaded && hasContent(loaded) ? reportTable(loaded) : null), [loaded]);
  const reconciled = loaded && loaded.view !== "card" ? loaded.report.reconciled : null;
  const viewLabel = VIEWS.find((v) => v.key === view)?.label ?? "";

  function exportCsv(): void {
    if (!table) return;
    const blob = new Blob([toCsv(table.headers, table.rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dimension-${view}-${kind}-${dateFrom}-${dateTo}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (enabledKinds.length === 0) {
    return (
      <EmptyState title="هنوز هیچ بُعدی فعال نشده است">
        برای گزارش به تفکیک بُعد، ابتدا یک نوع بُعد را در «مدیریت ابعاد» فعال و مقدارهایش را تعریف کنید.
      </EmptyState>
    );
  }

  const kindOptions = enabledKinds.map((k) => ({ value: k, label: kindLabel(k) }));

  return (
    <div className="space-y-4">
      <FilterChipRow label="نوع گزارش">
        {VIEWS.map((item) => (
          <FilterChip key={item.key} selected={view === item.key} onClick={() => setView(item.key)}>
            {item.label}
          </FilterChip>
        ))}
      </FilterChipRow>

      <SectionCard>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-sm font-medium text-foreground">نوع بُعد</span>
            <SearchableSelect
              value={kind}
              onChange={(next) => {
                setKind(next as DimensionKind);
                setValueId(UNASSIGNED_DIMENSION);
              }}
              options={kindOptions}
              ariaLabel="نوع بُعد گزارش"
            />
          </label>
          <div className="block min-w-0">
            <span className="mb-1.5 block text-sm font-medium text-foreground">از تاریخ</span>
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} ariaLabel="از تاریخ" clearable={false} />
          </div>
          <div className="block min-w-0">
            <span className="mb-1.5 block text-sm font-medium text-foreground">تا تاریخ</span>
            <JalaliDatePicker value={dateTo} onChange={setDateTo} ariaLabel="تا تاریخ" clearable={false} />
          </div>
          {view === "matrix" ? (
            <label className="block min-w-0">
              <span className="mb-1.5 block text-sm font-medium text-foreground">نوع حساب</span>
              <SearchableSelect value={accountType} onChange={setAccountType} options={ACCOUNT_TYPE_OPTIONS} ariaLabel="نوع حساب ماتریس" />
            </label>
          ) : null}
          {view === "card" ? (
            <>
              <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-medium text-foreground">حساب</span>
                <SearchableSelect
                  value={accountId}
                  onChange={setAccountId}
                  options={[
                    { value: "", label: "انتخاب حساب…" },
                    ...accounts.map((a) => ({ value: a.id, label: `${toPersianDigits(a.code)} · ${a.name}`, searchString: `${a.code} ${a.name}` })),
                  ]}
                  ariaLabel="حساب کارت"
                />
              </label>
              <label className="block min-w-0">
                <span className="mb-1.5 block text-sm font-medium text-foreground">{kindLabel(kind)}</span>
                <SearchableSelect
                  value={valueId}
                  onChange={setValueId}
                  options={[
                    { value: UNASSIGNED_DIMENSION, label: "بدون بُعد" },
                    ...kindValues.map((v) => ({
                      value: v.id,
                      label: `${toPersianDigits(v.code)} · ${v.name}${v.isActive ? "" : " (بایگانی)"}`,
                      searchString: `${v.code} ${v.name}`,
                    })),
                  ]}
                  ariaLabel={`${kindLabel(kind)} کارت`}
                />
              </label>
            </>
          ) : null}
        </div>
        {periodProblem ? <p className="mt-2 text-sm text-destructive">{periodProblem}</p> : null}
      </SectionCard>

      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={viewLabel}
        description={`${kindLabel(kind)} · ${isoToJalaliText(dateFrom)} تا ${isoToJalaliText(dateTo)}${
          view === "matrix" ? " · روی هر مبلغ بزنید تا سطرهای سند آن را ببینید" : ""
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {reconciled === null ? null : reconciled ? (
              <StatusBadge tone="positive" dot>
                با دفتر تطبیق دارد
              </StatusBadge>
            ) : (
              <StatusBadge tone="danger" dot>
                عدم تطبیق با دفتر
              </StatusBadge>
            )}
            <Button type="button" variant="outline" onClick={exportCsv} disabled={!table || loading}>
              <DownloadIcon aria-hidden="true" />
              خروجی CSV
            </Button>
            <SecondaryButton onClick={() => window.print()} disabled={!table || loading}>
              <PrinterIcon aria-hidden="true" className="size-4" />
              چاپ
            </SecondaryButton>
          </div>
        }
        flush
      >
        {loading && !loaded ? (
          <SectionCardSkeleton rows={4} label="در حال آماده‌سازی گزارش" />
        ) : table && loaded ? (
          <DataTable caption={viewLabel}>
            <DataTableHead>
              {table.headers.map((header, index) => (
                <Th key={`${header}-${index}`} numeric={index > 0}>
                  {header}
                </Th>
              ))}
            </DataTableHead>
            <DataTableBody>
              {table.rows.slice(0, -1).map((row, rowIndex) => (
                <DataTableRow key={`row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => {
                    const text = typeof cell === "number" ? money.format(cell) : toPersianDigits(cell);
                    const href = typeof cell === "number" ? matrixDrillHref(loaded, rowIndex, cellIndex) : null;
                    return (
                      <Td key={cellIndex} numeric={typeof cell === "number"} nowrap={cellIndex === 0}>
                        {href ? (
                          <Link href={href} className="text-primary underline-offset-4 hover:underline">
                            {text}
                          </Link>
                        ) : (
                          text
                        )}
                      </Td>
                    );
                  })}
                </DataTableRow>
              ))}
            </DataTableBody>
            <DataTableFoot>
              <DataTableRow>
                {table.rows[table.rows.length - 1].map((cell, cellIndex) => (
                  <Td key={cellIndex} numeric={typeof cell === "number"}>
                    {typeof cell === "number" ? money.format(cell) : toPersianDigits(cell)}
                  </Td>
                ))}
              </DataTableRow>
            </DataTableFoot>
          </DataTable>
        ) : cardNeedsAccount ? (
          <EmptyState title="حسابی برای کارت انتخاب کنید">
            کارت حساب، گردش یک حساب را برای یک مرکز نشان می‌دهد.
          </EmptyState>
        ) : !loading && loaded ? (
          <EmptyState title="سندی در این بازه نیست">برای این بازه و این بُعد، هیچ سندی ثبت نشده است.</EmptyState>
        ) : null}
      </SectionCard>
      <p className="sr-only" aria-live="polite">
        {loading ? "در حال آماده‌سازی گزارش" : ""}
      </p>
    </div>
  );
}
