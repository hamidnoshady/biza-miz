"use client";

import { useEffect, useMemo, useState } from "react";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  overlayPanelClass,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, isoDateToJalali, JALALI_MONTHS, todayJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { OverlayDialog } from "./ledger-ui";
import {
  CalendarIcon,
  CheckCircle2Icon,
  HistoryIcon,
  LayersIcon,
  PlusIcon,
  SearchIcon,
  TrendingDownIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

export interface FixedAssetRow {
  id: string;
  name: string;
  acquisitionDate: string;
  inServiceDate?: string;
  acquisitionSource?: "journal" | "opening_balance" | "unlinked";
  acquisitionEntryId?: string | null;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  accumulatedDepreciation: number;
  bookValue: number;
  createdAt: string;
  depreciationCount?: number;
  locationId?: string | null;
  locationName?: string | null;
}

export interface DepreciationHistoryItem {
  id: string;
  fixedAssetId: string;
  periodKey?: string | null;
  periodLabel: string;
  entryDate: string;
  amount: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  journalEntryId: string | null;
}

const ERROR_TRANSLATIONS: Record<string, string> = {
  fixed_asset_not_found: "دارایی ثابت پیدا نشد.",
  fixed_asset_has_depreciation: "برای این دارایی استهلاک ثبت شده و قابل حذف نیست.",
  period_label_required: "عنوان دوره الزامی است.",
  period_already_depreciated: "استهلاک این دوره قبلاً برای این دارایی ثبت شده است.",
  fully_depreciated: "این دارایی به‌طور کامل مستهلک شده است و امکان ثبت استهلاک بیشتر وجود ندارد.",
  fiscal_period_locked: "دوره مالی این تاریخ قفل است و امکان ثبت سند وجود ندارد.",
  fiscal_period_soft_closed: "دوره مالی این تاریخ بسته‌ی موقت است؛ فقط مالک یا حسابدار می‌تواند سند ثبت کند.",
  ledger_account_missing: "سرفصل حساب‌های استهلاک (۵۷۰۰ یا ۱۵۱۰) در سیستم تعریف نشده است.",
  period_label_too_long: "یادداشت دوره بیش از حد طولانی است.",
  invalid_period: "ماه استهلاک معتبر نیست.",
  invalid_entry_date: "تاریخ سند معتبر نیست.",
  entry_date_outside_period: "تاریخ سند باید داخل همان ماه استهلاک باشد.",
  period_before_in_service: "این ماه پیش از تاریخ بهره‌برداری دارایی است؛ استهلاک از ماه بهره‌برداری شروع می‌شود.",
  period_in_future: "این ماه هنوز شروع نشده است؛ استهلاک ماه آینده را نمی‌توان از پیش ثبت کرد.",
  invalid_acquisition_source: "منشأ ثبت بهای دارایی معتبر نیست.",
  acquisition_entry_required: "برای اتصال به سند خرید، یک سند را انتخاب کنید.",
  acquisition_entry_not_found: "سند خرید انتخاب‌شده پیدا نشد.",
  acquisition_entry_reversed: "سند انتخاب‌شده برگشت خورده است و نمی‌تواند سند خرید دارایی باشد.",
  acquisition_entry_insufficient: "مبلغ ثبت‌شده در حساب دارایی‌های ثابت این سند، کمتر از بهای این دارایی (پس از کسر دارایی‌های دیگرِ متصل) است.",
};

export interface FixedAssetReconciliationView {
  registerCost: string;
  ledgerCost: string;
  costDifference: string;
  registerAccumulated: string;
  ledgerAccumulated: string;
  accumulatedDifference: string;
  unlinkedCount: number;
  unlinkedCost: string;
  status: "reconciled" | "difference";
}

interface AcquisitionCandidate {
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debitedRial: string;
  availableRial: string;
}

const ACQUISITION_SOURCE_LABELS: Record<NonNullable<FixedAssetRow["acquisitionSource"]>, string> = {
  journal: "متصل به سند خرید",
  opening_balance: "در سند افتتاحیه",
  unlinked: "بدون سند مرتبط",
};

function resolveErrorMessage(code: string | undefined): string {
  if (!code) return "خطای غیرمنتظره رخ داد.";
  if (ERROR_TRANSLATIONS[code]) return ERROR_TRANSLATIONS[code];
  // If the server returned Persian validation text directly, display it
  if (/[\u0600-\u06FF]/.test(code)) return code;
  return errorMessageOrRaw(code);
}

/**
 * Fixed-asset register + straight-line depreciation (Phase 22 Wave 5,
 * second slice, issue #160 §2). Registering an asset posts nothing;
 * depreciation is posted separately, per period, per asset — the same
 * "record, then post" split payroll's accrual/payment already uses.
 */
export function FixedAssetsSection({ busy, refreshKey }: { busy: boolean; refreshKey: number }) {
  const money = useMoney();
  const [assets, setAssets] = useState<FixedAssetRow[] | null>(null);
  const [localError, setLocalError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New asset form state
  const [name, setName] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [cost, setCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [inServiceDate, setInServiceDate] = useState("");
  const [acquisitionSource, setAcquisitionSource] = useState<NonNullable<FixedAssetRow["acquisitionSource"]>>("unlinked");
  const [acquisitionEntryId, setAcquisitionEntryId] = useState("");
  const [candidates, setCandidates] = useState<AcquisitionCandidate[] | null>(null);
  const [reconciliation, setReconciliation] = useState<FixedAssetReconciliationView | null>(null);

  // Search & Filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "depreciated">("all");
  const [sortBy, setSortBy] = useState<"date_desc" | "date_asc" | "cost_desc" | "book_value_desc">("date_desc");

  // Dialog targets
  const [depreciateTarget, setDepreciateTarget] = useState<FixedAssetRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<FixedAssetRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FixedAssetRow | null>(null);

  function refresh() {
    api<{ fixedAssets: FixedAssetRow[]; reconciliation?: FixedAssetReconciliationView }>("/api/ledger/fixed-assets").then(({ ok, data }) => {
      if (ok) {
        setAssets(data.fixedAssets);
        setReconciliation(data.reconciliation ?? null);
      } else {
        setAssets([]);
        setLocalError("بارگذاری فهرست دارایی‌های ثابت ناموفق بود.");
      }
    });
  }

  useEffect(refresh, [refreshKey]);

  useEffect(() => {
    if (acquisitionSource !== "journal" || candidates) return;
    api<{ candidates: AcquisitionCandidate[] }>("/api/ledger/fixed-assets/acquisition-candidates").then(({ ok, data }) => {
      setCandidates(ok ? data.candidates : []);
    });
  }, [acquisitionSource, candidates]);

  // Live calculation preview for new asset form
  const parsedCost = useMemo(() => {
    if (!cost.trim()) return 0;
    try {
      return money.parse(cost);
    } catch {
      return 0;
    }
  }, [cost, money]);

  const parsedSalvage = useMemo(() => {
    if (!salvageValue.trim()) return 0;
    try {
      return money.parse(salvageValue);
    } catch {
      return 0;
    }
  }, [salvageValue, money]);

  const parsedMonths = useMemo(() => {
    const num = Number(usefulLifeMonths);
    return Number.isInteger(num) && num > 0 ? num : 0;
  }, [usefulLifeMonths]);

  const liveDepreciableBase = useMemo(() => {
    return Math.max(0, parsedCost - parsedSalvage);
  }, [parsedCost, parsedSalvage]);

  const liveMonthlyDepreciation = useMemo(() => {
    if (parsedMonths <= 0 || liveDepreciableBase <= 0) return 0;
    return Math.round(liveDepreciableBase / parsedMonths);
  }, [liveDepreciableBase, parsedMonths]);

  // Summary statistics
  const kpis = useMemo(() => {
    if (!assets) return { totalCost: 0, totalDepreciation: 0, totalBookValue: 0, count: 0, activeCount: 0, depreciatedCount: 0 };
    let totalCost = 0;
    let totalDepreciation = 0;
    let totalBookValue = 0;
    let activeCount = 0;
    let depreciatedCount = 0;

    for (const a of assets) {
      totalCost += a.cost;
      totalDepreciation += a.accumulatedDepreciation;
      totalBookValue += a.bookValue;
      const isFullyDepreciated = a.bookValue <= a.salvageValue || a.accumulatedDepreciation >= a.cost - a.salvageValue;
      if (isFullyDepreciated) {
        depreciatedCount++;
      } else {
        activeCount++;
      }
    }

    return {
      totalCost,
      totalDepreciation,
      totalBookValue,
      count: assets.length,
      activeCount,
      depreciatedCount,
    };
  }, [assets]);

  // Filtered & sorted assets
  const filteredAssets = useMemo(() => {
    if (!assets) return [];
    let list = assets.filter((a) => {
      if (searchTerm.trim()) {
        const query = searchTerm.trim().toLowerCase();
        const matchName = a.name.toLowerCase().includes(query);
        const matchLocation = a.locationName?.toLowerCase().includes(query) ?? false;
        if (!matchName && !matchLocation) return false;
      }
      const isFullyDepreciated = a.bookValue <= a.salvageValue || a.accumulatedDepreciation >= a.cost - a.salvageValue;
      if (statusFilter === "active" && isFullyDepreciated) return false;
      if (statusFilter === "depreciated" && !isFullyDepreciated) return false;
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sortBy === "date_desc") return Date.parse(b.acquisitionDate) - Date.parse(a.acquisitionDate);
      if (sortBy === "date_asc") return Date.parse(a.acquisitionDate) - Date.parse(b.acquisitionDate);
      if (sortBy === "cost_desc") return b.cost - a.cost;
      if (sortBy === "book_value_desc") return b.bookValue - a.bookValue;
      return 0;
    });

    return list;
  }, [assets, searchTerm, statusFilter, sortBy]);

  async function submitAsset(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    setLocalNotice("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError("نام دارایی الزامی است.");
      return;
    }
    if (!acquisitionDate) {
      setLocalError("تاریخ خرید / شروع بهره‌برداری الزامی است.");
      return;
    }
    if (!cost.trim()) {
      setLocalError("بهای تمام‌شده الزامی است.");
      return;
    }
    if (!usefulLifeMonths.trim()) {
      setLocalError("عمر مفید (ماه) الزامی است.");
      return;
    }

    let costRial: number;
    let salvageRial: number;
    try {
      costRial = money.parse(cost);
      salvageRial = salvageValue.trim() ? money.parse(salvageValue) : 0;
    } catch {
      setLocalError("مبالغ واردشده معتبر نیستند.");
      return;
    }

    if (costRial <= 0) {
      setLocalError("بهای تمام‌شده باید عددی مثبت و بزرگ‌تر از صفر باشد.");
      return;
    }
    if (salvageRial < 0) {
      setLocalError("ارزش اسقاط نمی‌تواند منفی باشد.");
      return;
    }
    if (salvageRial >= costRial) {
      setLocalError("ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.");
      return;
    }
    const monthsNum = Number(usefulLifeMonths);
    if (!Number.isInteger(monthsNum) || monthsNum <= 0) {
      setLocalError("عمر مفید باید یک عدد صحیح مثبت (حداقل ۱ ماه) باشد.");
      return;
    }
    if (inServiceDate && inServiceDate < acquisitionDate) {
      setLocalError("تاریخ بهره‌برداری نمی‌تواند پیش از تاریخ خرید باشد.");
      return;
    }
    if (acquisitionSource === "journal" && !acquisitionEntryId) {
      setLocalError("برای اتصال به سند خرید، یک سند را انتخاب کنید.");
      return;
    }

    setIsSubmitting(true);
    const { ok, data } = await api<{ fixedAsset?: FixedAssetRow; error?: string }>("/api/ledger/fixed-assets", {
      method: "POST",
      body: JSON.stringify({
        name: trimmedName,
        acquisitionDate,
        inServiceDate: inServiceDate || null,
        acquisitionSource,
        acquisitionEntryId: acquisitionSource === "journal" ? acquisitionEntryId : null,
        cost: costRial,
        salvageValue: salvageRial,
        usefulLifeMonths: monthsNum,
      }),
    });
    setIsSubmitting(false);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    setName("");
    setAcquisitionDate("");
    setCost("");
    setSalvageValue("");
    setUsefulLifeMonths("");
    setInServiceDate("");
    setAcquisitionSource("unlinked");
    setAcquisitionEntryId("");
    setCandidates(null);
    setLocalNotice("دارایی ثابت جدید با موفقیت در دفتر ثبت شد.");
    refresh();
  }

  async function handleDeleteConfirm(assetId: string) {
    setLocalError("");
    setLocalNotice("");
    setIsSubmitting(true);
    const { ok, data } = await api<{ ok?: boolean; error?: string }>(`/api/ledger/fixed-assets/${assetId}`, {
      method: "DELETE",
    });
    setIsSubmitting(false);
    setDeleteTarget(null);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    setLocalNotice("دارایی ثابت با موفقیت حذف شد.");
    refresh();
  }

  return (
    <div className="space-y-5">
      {/* KPI Cards Header */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">بهای تمام‌شده کل</span>
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100/70 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <LayersIcon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {money.format(kpis.totalCost)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            ارزش ناخالص دارایی‌های ثبت‌شده
          </p>
        </div>

        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">استهلاک انباشته کل</span>
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100/70 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <TrendingDownIcon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {money.format(kpis.totalDepreciation)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            مجموع استهلاک‌های سند خورده
          </p>
        </div>

        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">ارزش دفتری خالص کل</span>
            <span className="grid size-9 place-items-center rounded-xl bg-emerald-100/80 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
              <CheckCircle2Icon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {money.format(kpis.totalBookValue)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            مانده دفتری جاری دارایی‌ها
          </p>
        </div>

        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">تعداد دارایی‌ها</span>
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100/70 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <CalendarIcon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {toPersianDigits(kpis.count)} <span className="text-sm font-normal text-muted-foreground">مورد</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {toPersianDigits(kpis.activeCount)} در جریان / {toPersianDigits(kpis.depreciatedCount)} مستهلک‌شده
          </p>
        </div>
      </div>

      <FixedAssetReconciliationNotice reconciliation={reconciliation} />

      {/* Global error & notice messages */}
      <ErrorBox>{localError}</ErrorBox>
      {localNotice ? (
        <p
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <span>{localNotice}</span>
          <button
            type="button"
            onClick={() => setLocalNotice("")}
            className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-300 dark:hover:text-emerald-100"
            aria-label="بستن پیام"
          >
            <XIcon className="size-4" />
          </button>
        </p>
      ) : null}

      {/* Register Asset Form Section */}
      <section className={cardClass} aria-labelledby="fixed-asset-form-heading">
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دفتر اموال و دارایی‌های ثابت</p>
          <h2 id="fixed-asset-form-heading" className="mt-1 text-base font-semibold text-foreground">
            ثبت دارایی ثابت جدید
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            استهلاک به روش خط مستقیم محاسبه می‌شود؛ ثبت دارایی به‌تنهایی سندی صادر نمی‌کند — استهلاک هر دوره را جداگانه ثبت کنید.
          </p>
        </header>

        <form onSubmit={submitAsset} className="p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="نام دارایی" hint="نام دقیق یا مدل دستگاه">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً یخچال صنعتی ۳ درب یا سیستم حسابداری"
                required
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="تاریخ خرید" hint="تاریخ تحصیل دارایی">
              <JalaliDatePicker
                value={acquisitionDate}
                onChange={setAcquisitionDate}
                placeholder="انتخاب تاریخ خرید"
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="تاریخ بهره‌برداری" hint="استهلاک از ماه بهره‌برداری شروع می‌شود (اختیاری — پیش‌فرض: تاریخ خرید)">
              <JalaliDatePicker
                value={inServiceDate}
                onChange={setInServiceDate}
                placeholder="همان تاریخ خرید"
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="بهای دارایی در دفاتر" hint="ثبت دارایی سندی صادر نمی‌کند؛ مشخص کنید بهای آن کجا در دفاتر آمده است">
              <select
                className={inputClass}
                value={acquisitionSource}
                onChange={(e) => setAcquisitionSource(e.target.value as typeof acquisitionSource)}
                disabled={busy || isSubmitting}
              >
                <option value="unlinked">{ACQUISITION_SOURCE_LABELS.unlinked}</option>
                <option value="journal">{ACQUISITION_SOURCE_LABELS.journal}</option>
                <option value="opening_balance">{ACQUISITION_SOURCE_LABELS.opening_balance}</option>
              </select>
            </Field>

            {acquisitionSource === "journal" ? (
              <Field label="سند خرید" hint="اسنادی که حساب دارایی‌های ثابت (۱۵۰۰) را بدهکار کرده‌اند">
                {candidates === null ? (
                  <LoadingSkeleton rows={1} />
                ) : candidates.length === 0 ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    سندی با بدهکار دارایی ثابت که هنوز به دارایی دیگری متصل نشده باشد پیدا نشد.
                  </p>
                ) : (
                  <select
                    className={inputClass}
                    value={acquisitionEntryId}
                    onChange={(e) => setAcquisitionEntryId(e.target.value)}
                    disabled={busy || isSubmitting}
                  >
                    <option value="">انتخاب سند…</option>
                    {candidates.map((c) => (
                      <option key={c.entryId} value={c.entryId}>
                        {formatJalali(c.entryDate)} — {c.memo ?? "بدون شرح"} — قابل اتصال: {money.format(Number(c.availableRial))}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}

            <Field label="عمر مفید (ماه)" hint="تعداد ماه‌های استهلاک (مثلاً ۶۰ برای ۵ سال)">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={usefulLifeMonths}
                onChange={(e) => setUsefulLifeMonths(e.target.value)}
                placeholder="مثلاً ۶۰"
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label={`بهای تمام‌شده (${money.unitLabel})`} hint="مبلغ پرداختی یا بهای خرید">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="۰"
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field
              label={`ارزش اسقاط (${money.unitLabel})`}
              hint="ارزش تخمینی پایان عمر مفید (اختیاری — پیش‌فرض ۰)"
            >
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={salvageValue}
                onChange={(e) => setSalvageValue(e.target.value)}
                placeholder="۰"
                disabled={busy || isSubmitting}
              />
            </Field>
          </div>

          {/* Live Preview calculation box */}
          {parsedCost > 0 && parsedMonths > 0 ? (
            <div className="mt-2 mb-4 rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs sm:text-sm dark:bg-amber-500/10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-muted-foreground">
                  پیش‌نمایش محاسبه استهلاک ماهانه:
                </span>
                <span className="font-bold tabular-nums text-foreground">
                  استهلاک ماهانه تخمینی: {money.format(liveMonthlyDepreciation)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>مبلغ کل استهلاک‌پذیر: {money.format(liveDepreciableBase)}</span>
                <span>مدت استهلاک: {toPersianDigits(parsedMonths)} ماه ({toPersianDigits((parsedMonths / 12).toFixed(1).replace(".0", ""))} سال)</span>
              </div>
            </div>
          ) : null}

          <div className="mt-4 max-w-xs">
            <PrimaryButton disabled={busy || isSubmitting || !name.trim() || !acquisitionDate || !cost.trim() || !usefulLifeMonths.trim()}>
              <span className="flex items-center justify-center gap-2">
                <PlusIcon className="size-4" />
                {isSubmitting ? "در حال ثبت دارایی…" : "ثبت دارایی در دفتر"}
              </span>
            </PrimaryButton>
          </div>
        </form>
      </section>

      {/* Asset Register List Section */}
      <section className={cardClass} aria-labelledby="fixed-assets-list-heading">
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">فهرست دارایی‌ها</p>
              <h2 id="fixed-assets-list-heading" className="mt-1 text-base font-semibold text-foreground">
                دارایی‌های ثابت ثبت‌شده
              </h2>
            </div>
            {assets && assets.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                نمایش {toPersianDigits(filteredAssets.length)} از {toPersianDigits(assets.length)} دارایی
              </span>
            ) : null}
          </div>

          {/* Search, Filter & Sort Toolbar */}
          {assets && assets.length > 0 ? (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* Search input */}
              <div className="relative min-w-[240px] flex-1">
                <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="جستجو بر اساس نام دارایی یا شعبه…"
                  className={`${inputClass} ps-9`}
                />
                {searchTerm ? (
                  <button
                    type="button"
                    onClick={() => setSearchTerm("")}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="پاک کردن جستجو"
                  >
                    <XIcon className="size-4" />
                  </button>
                ) : null}
              </div>

              {/* Status filter chips & Sort */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-border p-1 bg-muted/60">
                  <button
                    type="button"
                    onClick={() => setStatusFilter("all")}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            statusFilter === "all"
                        ? "bg-amber-100 text-amber-950 font-semibold dark:bg-amber-500/20 dark:text-amber-200"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    همه ({toPersianDigits(kpis.count)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("active")}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            statusFilter === "active"
                        ? "bg-amber-100 text-amber-950 font-semibold dark:bg-amber-500/20 dark:text-amber-200"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    در جریان ({toPersianDigits(kpis.activeCount)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("depreciated")}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            statusFilter === "depreciated"
                        ? "bg-amber-100 text-amber-950 font-semibold dark:bg-amber-500/20 dark:text-amber-200"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    مستهلک‌شده ({toPersianDigits(kpis.depreciatedCount)})
                  </button>
                </div>

                <select
                  aria-label="مرتب‌سازی دارایی‌ها"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="h-9 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
                >
                  <option value="date_desc">جدیدترین تاریخ خرید</option>
                  <option value="date_asc">قدیمی‌ترین تاریخ خرید</option>
                  <option value="cost_desc">بیشترین بهای تمام‌شده</option>
                  <option value="book_value_desc">بیشترین ارزش دفتری</option>
                </select>
              </div>
            </div>
          ) : null}
        </header>

        <div className="p-4 sm:p-5">
          {!assets ? (
            <LoadingSkeleton rows={4} />
          ) : assets.length === 0 ? (
            <EmptyState>هنوز دارایی ثابتی در این کسب‌وکار ثبت نشده است.</EmptyState>
          ) : filteredAssets.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              دارایی ثابتی با فیلترهای انتخابی یافت نشد.
            </p>
          ) : (
            <>
              {/* Desktop Table View */}
              <DataTable caption="فهرست دارایی‌های ثابت و وضعیت استهلاک" className="hidden lg:block">
                <DataTableHead>
                  <Th>نام دارایی</Th>
                  <Th>تاریخ خرید</Th>
                  <Th>بهای تمام‌شده</Th>
                  <Th>ارزش اسقاط</Th>
                  <Th>پیشرفت استهلاک</Th>
                  <Th>استهلاک انباشته</Th>
                  <Th>ارزش دفتری</Th>
                  <Th>وضعیت</Th>
                  <Th>عملیات</Th>
                </DataTableHead>
                <DataTableBody>
                  {filteredAssets.map((a) => {
                    const depreciable = Math.max(0, a.cost - a.salvageValue);
                    const percent = depreciable > 0 ? Math.min(100, Math.round((a.accumulatedDepreciation / depreciable) * 100)) : 100;
                    const isFullyDepreciated = a.bookValue <= a.salvageValue || a.accumulatedDepreciation >= depreciable;
                    const postedPeriods = a.depreciationCount ?? 0;

                    return (
                      <DataTableRow key={a.id}>
                        <Td className="font-semibold">
                          <div>
                            <span>{a.name}</span>
                            {a.locationName ? (
                              <span className="ms-2 text-xs font-normal text-muted-foreground">
                                ({a.locationName})
                              </span>
                            ) : null}
                          </div>
                        </Td>
                        <Td nowrap muted>
                          {toPersianDigits(formatJalali(a.acquisitionDate))}
                        </Td>
                        <Td nowrap className="font-medium">
                          {money.format(a.cost)}
                        </Td>
                        <Td nowrap muted>
                          {money.format(a.salvageValue)}
                        </Td>
                        <Td>
                          <div className="w-28 space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">
                                {toPersianDigits(postedPeriods)}/{toPersianDigits(a.usefulLifeMonths)} ماه
                              </span>
                              <span className="font-semibold tabular-nums text-foreground">
                                {toPersianDigits(percent)}٪
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                              <div
                                className={`h-full rounded-full transition-all ${
        isFullyDepreciated
                                    ? "bg-emerald-500 dark:bg-emerald-400"
                                    : "bg-amber-500 dark:bg-amber-400"
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        </Td>
                        <Td nowrap>
                          {money.format(a.accumulatedDepreciation)}
                        </Td>
                        <Td numeric nowrap className="font-bold">
                          {money.format(a.bookValue)}
                        </Td>
                        <Td>
                          {isFullyDepreciated ? (
                            <StatusBadge tone="positive">مستهلک‌شده</StatusBadge>
                          ) : (
                            <StatusBadge tone="active">در جریان استهلاک</StatusBadge>
                          )}
                        </Td>
                        <Td>
                          <div className="flex items-center gap-1.5">
                            {!isFullyDepreciated ? (
                              <button
                                type="button"
                                onClick={() => setDepreciateTarget(a)}
                                disabled={busy || isSubmitting}
                                className="rounded-lg px-2.5 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20"
                              >
                                ثبت استهلاک
                              </button>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => setHistoryTarget(a)}
                              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-stone-800/60"
                              title="مشاهده تاریخچه استهلاک"
                            >
                              <HistoryIcon className="size-3.5" />
                              <span>تاریخچه</span>
                            </button>

                            {a.accumulatedDepreciation === 0 ? (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(a)}
                                disabled={busy || isSubmitting}
                                className="rounded-lg p-1 text-destructive transition-colors hover:bg-destructive/10"
                                title="حذف دارایی"
                                aria-label={`حذف ${a.name}`}
                              >
                                <Trash2Icon className="size-4" />
                              </button>
                            ) : null}
                          </div>
                        </Td>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>

              {/* Mobile / Tablet Cards View */}
              <div className="space-y-3 lg:hidden">
                {filteredAssets.map((a) => {
                  const depreciable = Math.max(0, a.cost - a.salvageValue);
                  const percent = depreciable > 0 ? Math.min(100, Math.round((a.accumulatedDepreciation / depreciable) * 100)) : 100;
                  const isFullyDepreciated = a.bookValue <= a.salvageValue || a.accumulatedDepreciation >= depreciable;
                  const postedPeriods = a.depreciationCount ?? 0;

                  return (
                    <article
                      key={a.id}
                      className="rounded-xl border border-border/80 bg-muted/60 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-foreground">{a.name}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            خرید: {toPersianDigits(formatJalali(a.acquisitionDate))}
                            {a.inServiceDate && a.inServiceDate !== a.acquisitionDate
                              ? ` — بهره‌برداری: ${toPersianDigits(formatJalali(a.inServiceDate))}`
                              : ""}
                            {a.locationName ? ` — شعبه: ${a.locationName}` : ""}
                          </p>
                          {a.acquisitionSource ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              بهای دارایی: {ACQUISITION_SOURCE_LABELS[a.acquisitionSource]}
                            </p>
                          ) : null}
                        </div>
                        <div>
                          {isFullyDepreciated ? (
                            <StatusBadge tone="positive">مستهلک‌شده</StatusBadge>
                          ) : (
                            <StatusBadge tone="active">در جریان استهلاک</StatusBadge>
                          )}
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div className="mt-3 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            پیشرفت: {toPersianDigits(postedPeriods)} از {toPersianDigits(a.usefulLifeMonths)} ماه استهلاک
                          </span>
                          <span className="font-semibold tabular-nums text-foreground">
                            {toPersianDigits(percent)}٪
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                          <div
                            className={`h-full rounded-full transition-all ${
            isFullyDepreciated
                                ? "bg-emerald-500 dark:bg-emerald-400"
                                : "bg-amber-500 dark:bg-amber-400"
                            }`}
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm sm:grid-cols-4">
                        <div>
                          <dt className="text-xs text-muted-foreground">بهای تمام‌شده</dt>
                          <dd className="mt-1 font-medium tabular-nums text-foreground">{money.format(a.cost)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">ارزش اسقاط</dt>
                          <dd className="mt-1 tabular-nums text-muted-foreground">{money.format(a.salvageValue)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">استهلاک انباشته</dt>
                          <dd className="mt-1 tabular-nums text-foreground">{money.format(a.accumulatedDepreciation)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">ارزش دفتری خالص</dt>
                          <dd className="mt-1 font-bold tabular-nums text-foreground">{money.format(a.bookValue)}</dd>
                        </div>
                      </dl>

                      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                        <button
                          type="button"
                          onClick={() => setHistoryTarget(a)}
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-stone-800/60"
                        >
                          <HistoryIcon className="size-3.5" />
                          <span>تاریخچه استهلاک</span>
                        </button>

                        {a.accumulatedDepreciation === 0 ? (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(a)}
                            disabled={busy || isSubmitting}
                            className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                          >
                            حذف دارایی
                          </button>
                        ) : null}

                        {!isFullyDepreciated ? (
                          <button
                            type="button"
                            onClick={() => setDepreciateTarget(a)}
                            disabled={busy || isSubmitting}
                            className="rounded-lg bg-amber-100 px-3.5 py-1.5 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30"
                          >
                            ثبت استهلاک این دوره
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Post Depreciation Modal Dialog */}
      {depreciateTarget ? (
        <DepreciateDialog
          asset={depreciateTarget}
          busy={busy || isSubmitting}
          onClose={() => setDepreciateTarget(null)}
          onSuccess={() => {
            setDepreciateTarget(null);
            setLocalNotice(`استهلاک دوره برای «${depreciateTarget.name}» با موفقیت ثبت شد.`);
            refresh();
          }}
        />
      ) : null}

      {/* Depreciation History Modal */}
      {historyTarget ? (
        <DepreciationHistoryModal
          asset={historyTarget}
          onClose={() => setHistoryTarget(null)}
        />
      ) : null}

      {/* Delete Confirmation Modal */}
      {deleteTarget ? (
        <DeleteConfirmModal
          asset={deleteTarget}
          busy={busy || isSubmitting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => handleDeleteConfirm(deleteTarget.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * Modal dialog to post one period's depreciation for an asset.
 */
function DepreciateDialog({
  asset,
  busy,
  onClose,
  onSuccess,
}: {
  asset: FixedAssetRow;
  busy: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const money = useMoney();
  const today = todayJalali();
  const inService = isoDateToJalali(asset.inServiceDate ?? asset.acquisitionDate);
  const firstYear = inService?.jy ?? today.jy;
  const years = Array.from({ length: Math.max(1, today.jy - firstYear + 1) }, (_, i) => today.jy - i);

  const [periodYear, setPeriodYear] = useState(today.jy);
  const [periodMonth, setPeriodMonth] = useState(today.jm);
  const [entryDate, setEntryDate] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const periodKey = `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
  const monthDisabled = (jy: number, jm: number) =>
    (jy === today.jy && jm > today.jm) || (inService != null && (jy < inService.jy || (jy === inService.jy && jm < inService.jm)));

  const depreciableBase = Math.max(0, asset.cost - asset.salvageValue);
  const remaining = Math.max(0, depreciableBase - asset.accumulatedDepreciation);
  const periodsPosted = asset.depreciationCount ?? 0;
  const isFinalScheduledPeriod = periodsPosted + 1 >= asset.usefulLifeMonths;
  const regularMonthly = Math.round(depreciableBase / asset.usefulLifeMonths);
  const calculatedPeriodAmount = isFinalScheduledPeriod ? remaining : Math.min(regularMonthly, remaining);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");

    if (monthDisabled(periodYear, periodMonth)) {
      setLocalError("این ماه پیش از بهره‌برداری دارایی یا در آینده است.");
      return;
    }

    setSubmitting(true);
    const { ok, data } = await api<{ amount?: number; error?: string }>(
      `/api/ledger/fixed-assets/${asset.id}/depreciate`,
      {
        method: "POST",
        body: JSON.stringify({
          periodKey,
          entryDate: entryDate || undefined,
        }),
      },
    );
    setSubmitting(false);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    onSuccess();
  }

  return (
    <OverlayDialog
      headingId="depreciate-dialog-heading"
      onClose={onClose}
      dismissible={!(busy || submitting)}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات استهلاک</p>
            <h3 id="depreciate-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
              ثبت استهلاک دوره برای «{asset.name}»
            </h3>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
            <XIcon className="size-4" />
          </Button>
        </header>

        <ErrorBox>{localError}</ErrorBox>

        {/* Asset summary details */}
        <div className="mb-4 rounded-xl border border-border/80 bg-muted/60 p-3.5 text-xs text-muted-foreground">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-xs text-muted-foreground">بهای تمام‌شده:</span>
              <p className="font-semibold tabular-nums text-foreground">{money.format(asset.cost)}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">استهلاک انباشته جاری:</span>
              <p className="font-semibold tabular-nums text-foreground">{money.format(asset.accumulatedDepreciation)}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">مانده استهلاک‌پذیر:</span>
              <p className="font-semibold tabular-nums text-foreground">{money.format(remaining)}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">شماره دوره استهلاک:</span>
              <p className="font-semibold tabular-nums text-foreground">
                دوره {toPersianDigits(periodsPosted + 1)} از {toPersianDigits(asset.usefulLifeMonths)}
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="ماه استهلاک" hint="هر ماه فقط یک‌بار برای هر دارایی ثبت می‌شود">
            <div className="grid grid-cols-2 gap-2">
              <select
                className={inputClass}
                aria-label="ماه"
                value={periodMonth}
                onChange={(e) => setPeriodMonth(Number(e.target.value))}
                disabled={busy || submitting}
              >
                {JALALI_MONTHS.map((month, i) => (
                  <option key={month} value={i + 1} disabled={monthDisabled(periodYear, i + 1)}>
                    {month}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                aria-label="سال"
                value={periodYear}
                onChange={(e) => setPeriodYear(Number(e.target.value))}
                disabled={busy || submitting}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {toPersianDigits(y)}
                  </option>
                ))}
              </select>
            </div>
          </Field>

          <Field label="تاریخ سند حسابداری" hint="باید داخل همان ماه باشد — پیش‌فرض: آخر ماه، یا امروز برای ماه جاری">
            <JalaliDatePicker
              value={entryDate}
              onChange={setEntryDate}
              placeholder="آخر ماه"
              disabled={busy || submitting}
            />
          </Field>

          {/* Amount and ledger posting notice */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs dark:bg-amber-500/10">
            <div className="flex items-center justify-between font-semibold text-foreground">
              <span>مبلغ استهلاک این دوره:</span>
              <span className="text-sm tabular-nums text-amber-800 dark:text-amber-300">
                {money.format(calculatedPeriodAmount)}
              </span>
            </div>
            <p className="mt-1.5 text-muted-foreground">
              سند حسابداری صادر خواهد شد: بدهکار <strong className="text-foreground">هزینه استهلاک (۵۷۰۰)</strong> / بستانکار <strong className="text-foreground">استهلاک انباشته (۱۵۱۰)</strong>
            </p>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <SecondaryButton onClick={onClose} disabled={busy || submitting}>
              انصراف
            </SecondaryButton>
            <PrimaryButton disabled={busy || submitting || monthDisabled(periodYear, periodMonth) || calculatedPeriodAmount <= 0}>
              {submitting ? "در حال ثبت سند…" : "ثبت و صدور سند"}
            </PrimaryButton>
          </div>
        </form>
      </OverlayDialog>
  );
}

/**
 * Modal dialog to view the complete history of posted depreciation entries for an asset.
 */
function DepreciationHistoryModal({
  asset,
  onClose,
}: {
  asset: FixedAssetRow;
  onClose: () => void;
}) {
  const money = useMoney();
  const [entries, setEntries] = useState<DepreciationHistoryItem[] | null>(null);
  const [error, setError] = useState("");


  useEffect(() => {
    setError("");
    api<{ depreciationEntries: DepreciationHistoryItem[] }>(`/api/ledger/fixed-assets/${asset.id}`)
      .then(({ ok, data }) => {
        if (ok) setEntries(data.depreciationEntries);
        else setError("بارگذاری تاریخچه استهلاک این دارایی ناموفق بود.");
      })
      .catch(() => setError("ارتباط با سرور برقرار نشد."));
  }, [asset.id]);

  const totalPosted = useMemo(() => {
    return (entries ?? []).reduce((sum, e) => sum + e.amount, 0);
  }, [entries]);

  return (
    <OverlayDialog
      headingId="history-dialog-heading"
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}
    >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق و اسناد استهلاک</p>
            <h3 id="history-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
              تاریخچه استهلاک «{asset.name}»
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              خرید: {toPersianDigits(formatJalali(asset.acquisitionDate))} — بهای تمام‌شده: {money.format(asset.cost)}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            بستن
          </Button>
        </header>

        {error ? (
          <ErrorBox>{error}</ErrorBox>
        ) : entries === null ? (
          <LoadingSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            هنوز استهلاکی برای این دارایی ثبت نشده است.
          </p>
        ) : (
          <div className="space-y-3">
            <DataTable caption="تاریخچه استهلاک این دارایی">
              <DataTableHead>
                <Th>ماه استهلاک</Th>
                <Th>تاریخ سند</Th>
                <Th>مبلغ استهلاک</Th>
                <Th>ثبت‌کننده</Th>
              </DataTableHead>
              <DataTableBody>
                {entries.map((entry) => (
                  <DataTableRow key={entry.id}>
                    <Td className="font-semibold">
                      {entry.periodKey ? toPersianDigits(periodKeyLabel(entry.periodKey)) : entry.periodLabel}
                    </Td>
                    <Td nowrap muted>
                      {toPersianDigits(formatJalali(entry.entryDate))}
                    </Td>
                    <Td numeric nowrap className="font-bold">
                      {money.format(entry.amount)}
                    </Td>
                    <Td muted className="text-xs">
                      {entry.createdByName ?? "سیستم"}
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                جمع استهلاک‌های ثبت‌شده ({toPersianDigits(entries.length)} دوره)
              </span>
              <span className="font-bold tabular-nums text-foreground">
                {money.format(totalPosted)}
              </span>
            </div>
          </div>
        )}
      </OverlayDialog>
  );
}

/**
 * Modal dialog to confirm hard-deletion of an asset with no depreciation history.
 */
function DeleteConfirmModal({
  asset,
  busy,
  onClose,
  onConfirm,
}: {
  asset: FixedAssetRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const money = useMoney();

  return (
    <OverlayDialog
      headingId="delete-dialog-heading"
      onClose={onClose}
      dismissible={!busy}
      className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-6`}
    >
        <header className="mb-3">
          <p className="text-xs font-semibold text-destructive">حذف دارایی ثابت</p>
          <h3 id="delete-dialog-heading" className="mt-1 text-base font-bold text-foreground">
            آیا از حذف «{asset.name}» اطمینان دارید؟
          </h3>
        </header>

        <p className="text-xs leading-5 text-muted-foreground">
          این دارایی با بهای تمام‌شده {money.format(asset.cost)} از دفتر اموال حذف خواهد شد. این عملیات غیرقابل بازگشت است.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={busy}
            className="w-full font-semibold"
          >
            {busy ? "در حال حذف…" : "تأیید و حذف"}
          </Button>
        </div>
      </OverlayDialog>
  );
}

function periodKeyLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return JALALI_MONTHS[m - 1] ? `${JALALI_MONTHS[m - 1]} ${y}` : key;
}

/**
 * Register ↔ general ledger (audit F09): says plainly when the register's
 * cost or accumulated depreciation disagrees with the 1500 accounts, and how
 * much of the register is not tied to any document.
 */
function FixedAssetReconciliationNotice({ reconciliation }: { reconciliation: FixedAssetReconciliationView | null }) {
  const money = useMoney();
  if (!reconciliation) return null;
  const costDiff = Number(reconciliation.costDifference);
  const accDiff = Number(reconciliation.accumulatedDifference);
  if (reconciliation.status === "reconciled" && reconciliation.unlinkedCount === 0) return null;
  return (
    <InfoBox>
      <p className="font-semibold">تطبیق دفتر اموال با دفتر کل</p>
      <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs leading-6">
        {costDiff !== 0 ? (
          <li>
            بهای دارایی‌ها در دفتر اموال {money.format(Number(reconciliation.registerCost))} و در حساب‌های دارایی ثابت دفتر کل{" "}
            {money.format(Number(reconciliation.ledgerCost))} است (اختلاف {money.format(Math.abs(costDiff))}).
          </li>
        ) : null}
        {accDiff !== 0 ? (
          <li>
            استهلاک انباشته در دفتر اموال {money.format(Number(reconciliation.registerAccumulated))} و در دفتر کل{" "}
            {money.format(Number(reconciliation.ledgerAccumulated))} است (اختلاف {money.format(Math.abs(accDiff))}).
          </li>
        ) : null}
        {reconciliation.unlinkedCount > 0 ? (
          <li>
            {toPersianDigits(reconciliation.unlinkedCount)} دارایی به ارزش {money.format(Number(reconciliation.unlinkedCost))} به هیچ سند
            خرید یا افتتاحیه‌ای متصل نیست؛ تا مشخص نشود، بهای آن‌ها در دفاتر تأیید نشده است.
          </li>
        ) : null}
      </ul>
    </InfoBox>
  );
}
