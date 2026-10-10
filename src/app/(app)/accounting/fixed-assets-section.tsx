"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { JournalPeekDialog } from "./journal-peek-dialog";
import type { AccountRow } from "./accounting-manager";
import {
  ArchiveIcon,
  ArrowLeftRightIcon,
  BookOpenTextIcon,
  CalculatorIcon,
  CalendarIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FileDownIcon,
  HistoryIcon,
  LayersIcon,
  PackageXIcon,
  PlusIcon,
  SearchIcon,
  TrendingDownIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FIXED_ASSET_ERROR_TRANSLATIONS } from "@/lib/fixed-assets-errors";
import {
  ASSET_ACQUISITION_SOURCE_ROLES,
  ASSET_SALE_PROCEEDS_ROLES,
  classifyAccounts,
  type AccountRole,
} from "@/lib/account-classification";

// ---------------------------------------------------------------------------
// Shapes — the API's, kept in one place so the section and its dialogs agree.
// ---------------------------------------------------------------------------

export interface FixedAssetRow {
  id: string;
  code: string | null;
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
  category?: string | null;
  serialNumber?: string | null;
  vendorPartyId?: string | null;
  vendorName?: string | null;
  custodianPartyId?: string | null;
  custodianName?: string | null;
  purchaseReference?: string | null;
  notes?: string | null;
  assetAccountId?: string | null;
  assetAccountCode?: string | null;
  status: "active" | "disposed";
  disposalKind?: "sale" | "retirement" | "write_off" | null;
  disposalDate?: string | null;
  disposalProceeds?: number | null;
  disposalJournalEntryId?: string | null;
  disposalReason?: string | null;
  archivedAt?: string | null;
  fullyDepreciated?: boolean;
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
  postingLocationName?: string | null;
  reversedAt?: string | null;
  reversedByName?: string | null;
  reversalReason?: string | null;
  reversalJournalEntryId?: string | null;
}

export interface FixedAssetTransferItem {
  id: string;
  fromLocationId: string | null;
  fromLocationName: string | null;
  toLocationId: string | null;
  toLocationName: string | null;
  effectiveDate: string;
  reason: string;
  transferredByName: string | null;
  createdAt: string;
}

export interface FixedAssetEstimateChangeItem {
  id: string;
  changedAt: string;
  effectivePeriodKey: string;
  oldUsefulLifeMonths: number;
  newUsefulLifeMonths: number;
  oldSalvageValue: number;
  newSalvageValue: number;
  remainingLifeMonths: number;
  remainingBase: number;
  reason: string;
  changedByName: string | null;
}

interface FixedAssetKpis {
  count: number;
  totalCost: number;
  totalAccumulatedDepreciation: number;
  totalBookValue: number;
  activeCount: number;
  fullyDepreciatedCount: number;
  disposedCount: number;
}

interface LocationOption {
  id: string;
  name: string;
}

interface PartyOption {
  id: string;
  displayName?: string;
  name?: string;
}

const ERROR_TRANSLATIONS: Record<string, string> = FIXED_ASSET_ERROR_TRANSLATIONS;

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

/**
 * The settlement accounts of one allowed-role set, from the SAME canonical
 * classification the server checks against (issue #833): the pickers offer
 * exactly what the service will accept — never a control that 400s on click.
 */
function settlementAccountOptions(accounts: AccountRow[], allowed: ReadonlySet<AccountRole>): AccountRow[] {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const roles = classifyAccounts(
    accounts.map((a) => ({
      id: a.id,
      code: a.code,
      parentId: a.parent_code ? (byCode.get(a.parent_code)?.id ?? null) : null,
      type: a.type,
    })),
  );
  return accounts.filter((a) => allowed.has(roles.get(a.id) ?? ("" as AccountRole)));
}

const ACQUISITION_SOURCE_LABELS: Record<NonNullable<FixedAssetRow["acquisitionSource"]>, string> = {
  journal: "متصل به سند خرید",
  opening_balance: "در سند افتتاحیه",
  unlinked: "بدون سند مرتبط",
};

const DISPOSAL_KIND_LABELS: Record<NonNullable<FixedAssetRow["disposalKind"]>, string> = {
  sale: "فروش",
  retirement: "اسقاط",
  write_off: "حذف از دفاتر",
};

function resolveErrorMessage(code: string | undefined): string {
  if (!code) return "خطای غیرمنتظره رخ داد.";
  if (ERROR_TRANSLATIONS[code]) return ERROR_TRANSLATIONS[code];
  // If the server returned Persian validation text directly, display it
  if (/[\u0600-\u06FF]/.test(code)) return code;
  return errorMessageOrRaw(code);
}

function periodKeyLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return JALALI_MONTHS[m - 1] ? `${JALALI_MONTHS[m - 1]} ${y}` : key;
}

/** The register's one status vocabulary — derived states included, so the table, the chips and the export agree. */
function assetStatusView(a: FixedAssetRow): { label: string; tone: "active" | "positive" | "neutral" | "danger" } {
  if (a.status === "disposed") return { label: DISPOSAL_KIND_LABELS[a.disposalKind ?? "sale"] + "‌شده", tone: "neutral" };
  if (a.archivedAt) return { label: "بایگانی‌شده", tone: "neutral" };
  if (a.fullyDepreciated) return { label: "مستهلک‌شده", tone: "positive" };
  return { label: "در جریان استهلاک", tone: "active" };
}

type StatusFilterKey = "all" | "active" | "fully" | "disposed" | "archived";

/**
 * The fixed-asset register (issue #833's UI half): the service layer owns
 * every accounting rule; this screen only reflects its authoritative state —
 * server-backed filters, pagination and KPIs, the full lifecycle
 * (depreciate, reverse, dispose, transfer, revise estimate, archive), and a
 * genuinely read-only mode for members without `finance.assets_manage`.
 */
export function FixedAssetsSection({
  busy,
  refreshKey,
  canManage,
  accounts,
}: {
  busy: boolean;
  refreshKey: number;
  /**
   * Whether the member may mutate the register. `undefined` = effective
   * permissions are not known yet (still loading, or could not be read):
   * read-only until they are — a member whose capability is merely unknown
   * must not be shown live accounting controls that will 403 on click. The
   * API remains the authoritative gate either way; this only stops the UI
   * from offering what it cannot promise.
   */
  canManage?: boolean;
  /** The chart of accounts the workspace already loaded — for the asset-account and proceeds-account pickers. */
  accounts?: AccountRow[];
}) {
  const money = useMoney();
  const [assets, setAssets] = useState<FixedAssetRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  /** The keyset cursor of the last loaded row — «load more» resumes here. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kpis, setKpis] = useState<FixedAssetKpis | null>(null);
  const [reconciliation, setReconciliation] = useState<FixedAssetReconciliationView | null>(null);
  const [localError, setLocalError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Unknown (`undefined`) is read-only too — capability must be affirmatively
  // known before a mutation control is drawn.
  const readOnly = canManage !== true;

  // Server-backed filters (issue #833: the browser must not download the
  // whole register to search it).
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState<"date_desc" | "date_asc" | "cost_desc" | "book_value_desc">("date_desc");
  const [categories, setCategories] = useState<string[]>([]);
  const [locations, setLocations] = useState<LocationOption[] | null>(null);

  // Dialog targets
  const [depreciateTarget, setDepreciateTarget] = useState<FixedAssetRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<FixedAssetRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FixedAssetRow | null>(null);
  const [disposeTarget, setDisposeTarget] = useState<FixedAssetRow | null>(null);
  const [transferTarget, setTransferTarget] = useState<FixedAssetRow | null>(null);
  const [estimateTarget, setEstimateTarget] = useState<FixedAssetRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<FixedAssetRow | null>(null);
  const [reverseTarget, setReverseTarget] = useState<{ asset: FixedAssetRow; entry: DepreciationHistoryItem } | null>(null);
  const [journalPeekTarget, setJournalPeekTarget] = useState<{ entryId: string; title: string } | null>(null);

  // Stale-response guard: a filter change invalidates whatever is in flight,
  // so a slow answer for the previous query can never flash into the new
  // filter's results (same discipline as the journal's «دفتر روزنامه»).
  const requestId = useRef(0);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (searchTerm.trim()) params.set("search", searchTerm.trim());
    if (statusFilter === "active") {
      params.set("status", "active");
      params.set("depreciationState", "open");
    } else if (statusFilter === "fully") {
      params.set("status", "active");
      params.set("depreciationState", "fully");
    } else if (statusFilter === "disposed") {
      params.set("status", "disposed");
    } else if (statusFilter === "archived") {
      params.set("status", "archived");
    }
    if (categoryFilter) params.set("category", categoryFilter);
    if (branchFilter) params.set("locationId", branchFilter);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (sortBy !== "date_desc") params.set("sortBy", sortBy);
    return params;
  }, [searchTerm, statusFilter, categoryFilter, branchFilter, dateFrom, dateTo, sortBy]);

  const load = useCallback(
    async (cursor: string | null = null, append = false) => {
      const params = filterParams();
      if (cursor) params.set("cursor", cursor);
      const current = ++requestId.current;
      if (append) setLoadingMore(true);
      const { ok, data } = await api<{
        fixedAssets: FixedAssetRow[];
        hasMore?: boolean;
        nextCursor?: string | null;
        kpis?: FixedAssetKpis;
        reconciliation?: FixedAssetReconciliationView;
        error?: string;
      }>(`/api/ledger/fixed-assets?${params}`);
      if (current !== requestId.current) return; // a newer request superseded this one
      if (ok) {
        setAssets((previous) => (append && previous ? [...previous, ...data.fixedAssets] : data.fixedAssets));
        setHasMore(!!data.hasMore);
        setNextCursor(data.nextCursor ?? null);
        setKpis(data.kpis ?? null);
        setReconciliation(data.reconciliation ?? null);
      } else {
        setAssets([]);
        setLocalError("بارگذاری فهرست دارایی‌های ثابت ناموفق بود.");
      }
      if (append) setLoadingMore(false);
    },
    [filterParams],
  );

  useEffect(() => {
    // Invalidate an in-flight request immediately when a filter changes; the
    // search debounce must not let results for the previous query flash into
    // the new filter's empty state.
    requestId.current += 1;
    setAssets(null);
    setHasMore(false);
    setNextCursor(null);
    setLoadingMore(false);
    const timer = setTimeout(() => void load(), searchTerm ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, searchTerm, refreshKey]);

  // The filter vocabulary and the branches, once per mount (plus refreshes).
  useEffect(() => {
    api<{ categories: string[] }>("/api/ledger/fixed-assets/filter-options").then(({ ok, data }) => {
      if (ok) setCategories(data.categories);
    });
    api<{ locations: LocationOption[] }>("/api/locations/active").then(({ ok, data }) => {
      if (ok) setLocations(data.locations.map((l) => ({ id: l.id, name: l.name })));
    });
  }, [refreshKey]);

  function refresh() {
    void load();
  }

  function clearFilters() {
    setSearchTerm("");
    setStatusFilter("all");
    setCategoryFilter("");
    setBranchFilter("");
    setDateFrom("");
    setDateTo("");
    setSortBy("date_desc");
  }

  const filtersActive =
    !!searchTerm.trim() || statusFilter !== "all" || !!categoryFilter || !!branchFilter || !!dateFrom || !!dateTo;

  const exportHref = useMemo(() => {
    const params = filterParams();
    return `/api/ledger/fixed-assets/export?${params}`;
  }, [filterParams]);

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
      {/* KPI Cards Header — the server's totals over the whole filtered register, never one page's */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">بهای تمام‌شده کل</span>
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100/70 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <LayersIcon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {money.format(kpis?.totalCost ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">ارزش ناخالص دارایی‌های ثبت‌شده</p>
        </div>

        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">استهلاک انباشته کل</span>
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100/70 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <TrendingDownIcon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {money.format(kpis?.totalAccumulatedDepreciation ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">مجموع استهلاک‌های سند خورده</p>
        </div>

        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">ارزش دفتری خالص کل</span>
            <span className="grid size-9 place-items-center rounded-xl bg-emerald-100/80 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
              <CheckCircle2Icon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {money.format(kpis?.totalBookValue ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">مانده دفتری جاری دارایی‌ها</p>
        </div>

        <div className={cardClass + " p-4 sm:p-5"}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground dark:text-muted-foreground">تعداد دارایی‌ها</span>
            <span className="grid size-9 place-items-center rounded-xl bg-amber-100/70 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <CalendarIcon className="size-4" />
            </span>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
            {toPersianDigits(kpis?.count ?? 0)} <span className="text-sm font-normal text-muted-foreground">مورد</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {toPersianDigits(kpis?.activeCount ?? 0)} در جریان / {toPersianDigits(kpis?.fullyDepreciatedCount ?? 0)} مستهلک‌شده
            {kpis?.disposedCount ? ` / ${toPersianDigits(kpis.disposedCount)} واگذارشده` : ""}
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

      {readOnly ? (
        <InfoBox>
          شما دسترسی فقط‌خواندنی به دفتر اموال دارید؛ ثبت دارایی، استهلاک، واگذاری و سایر تغییرات برای شما فعال نیست.
        </InfoBox>
      ) : null}

      {/* Register Asset Form Section */}
      {readOnly ? null : (
        <AssetForm
          busy={busy}
          accounts={accounts}
          onNotice={(message) => {
            setLocalError("");
            setLocalNotice(message);
          }}
          onError={(message) => {
            setLocalNotice("");
            setLocalError(message);
          }}
          onCreated={() => {
            refresh();
            api<{ categories: string[] }>("/api/ledger/fixed-assets/filter-options").then(({ ok, data }) => {
              if (ok) setCategories(data.categories);
            });
          }}
        />
      )}

      {/* Asset Register List Section */}
      <section className={cardClass} aria-labelledby="fixed-assets-list-heading">
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">فهرست دارایی‌ها</p>
              <h2 id="fixed-assets-list-heading" className="mt-1 text-base font-semibold text-foreground">
                دارایی‌های ثابت ثبت‌شده
              </h2>
            </div>
            <a
              href={exportHref}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="دریافت اکسل کل داده‌های فیلترشده — کامل و بدون سقف ردیف: دفتر اموال، برنامه استهلاک، برنامه باقیمانده، واگذاری‌ها، انتقال‌ها، تغییر برآوردها، خلاصهٔ دسته‌ها و شعب و گزارش حرکت"
            >
              <FileDownIcon className="size-3.5" />
              <span>دریافت اکسل</span>
            </a>
          </div>

          {/* Search, Filter & Sort Toolbar — server-backed */}
          <div className="mt-4 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative min-w-[240px] flex-1">
                <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="جستجو بر اساس نام، کد، سریال، شعبه یا فروشنده…"
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

            <div className="flex flex-wrap items-center gap-2">
              {/* Status filter chips */}
              <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/60 p-1">
                {(
                  [
                    { key: "all", label: "همه" },
                    { key: "active", label: "در جریان" },
                    { key: "fully", label: "مستهلک‌شده" },
                    { key: "disposed", label: "واگذارشده" },
                    { key: "archived", label: "بایگانی" },
                  ] as { key: StatusFilterKey; label: string }[]
                ).map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => setStatusFilter(chip.key)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      statusFilter === chip.key
                        ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>

              <select
                aria-label="فیلتر دسته"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
              >
                <option value="">همه دسته‌ها</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                aria-label="فیلتر شعبه"
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
              >
                <option value="">همه شعب</option>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-1.5">
                <div className="w-32">
                  <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ خرید" />
                </div>
                <span className="text-xs text-muted-foreground">تا</span>
                <div className="w-32">
                  <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ خرید" />
                </div>
              </div>

              {filtersActive ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  حذف فیلترها
                </button>
              ) : null}
            </div>
          </div>
        </header>

        <div className="p-4 sm:p-5">
          {!assets ? (
            <LoadingSkeleton rows={4} />
          ) : assets.length === 0 ? (
            <EmptyState>دارایی ثابتی با فیلترهای انتخابی یافت نشد.</EmptyState>
          ) : (
            <>
              {/* Desktop Table View */}
              <DataTable caption="فهرست دارایی‌های ثابت و وضعیت استهلاک" className="hidden lg:block">
                <DataTableHead>
                  <Th>کد و نام دارایی</Th>
                  <Th>تاریخ خرید</Th>
                  <Th>بهای تمام‌شده</Th>
                  <Th>پیشرفت استهلاک</Th>
                  <Th>استهلاک انباشته</Th>
                  <Th>ارزش دفتری</Th>
                  <Th>وضعیت</Th>
                  <Th>عملیات</Th>
                </DataTableHead>
                <DataTableBody>
                  {assets.map((a) => {
                    const depreciable = Math.max(0, a.cost - a.salvageValue);
                    const percent = depreciable > 0 ? Math.min(100, Math.round((a.accumulatedDepreciation / depreciable) * 100)) : 100;
                    const status = assetStatusView(a);
                    const postedPeriods = a.depreciationCount ?? 0;

                    return (
                      <DataTableRow key={a.id}>
                        <Td className="font-semibold">
                          <div>
                            <span>{a.name}</span>
                            {a.code ? (
                              <span className="ms-2 font-mono text-xs font-normal text-muted-foreground" dir="ltr">
                                {a.code}
                              </span>
                            ) : null}
                            {a.locationName ? (
                              <span className="ms-2 text-xs font-normal text-muted-foreground">({a.locationName})</span>
                            ) : null}
                            {a.category ? (
                              <span className="ms-2 text-xs font-normal text-muted-foreground">— {a.category}</span>
                            ) : null}
                          </div>
                        </Td>
                        <Td nowrap muted>
                          {toPersianDigits(formatJalali(a.acquisitionDate))}
                        </Td>
                        <Td nowrap className="font-medium">
                          {money.format(a.cost)}
                        </Td>
                        <Td>
                          <div className="w-28 space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">
                                {toPersianDigits(postedPeriods)}/{toPersianDigits(a.usefulLifeMonths)} ماه
                              </span>
                              <span className="font-semibold tabular-nums text-foreground">{toPersianDigits(percent)}٪</span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  a.fullyDepreciated ? "bg-emerald-500 dark:bg-emerald-400" : "bg-amber-500 dark:bg-amber-400"
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        </Td>
                        <Td nowrap>{money.format(a.accumulatedDepreciation)}</Td>
                        <Td numeric nowrap className="font-bold">
                          {money.format(a.bookValue)}
                        </Td>
                        <Td>
                          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        </Td>
                        <Td>
                          <AssetActions
                            asset={a}
                            busy={busy || isSubmitting}
                            canManage={!readOnly}
                            onDepreciate={() => setDepreciateTarget(a)}
                            onHistory={() => setHistoryTarget(a)}
                            onDispose={() => setDisposeTarget(a)}
                            onTransfer={() => setTransferTarget(a)}
                            onEstimate={() => setEstimateTarget(a)}
                            onArchive={() => setArchiveTarget(a)}
                            onDelete={() => setDeleteTarget(a)}
                          />
                        </Td>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>

              {/* Mobile / Tablet Cards View */}
              <div className="space-y-3 lg:hidden">
                {assets.map((a) => {
                  const depreciable = Math.max(0, a.cost - a.salvageValue);
                  const percent = depreciable > 0 ? Math.min(100, Math.round((a.accumulatedDepreciation / depreciable) * 100)) : 100;
                  const status = assetStatusView(a);
                  const postedPeriods = a.depreciationCount ?? 0;

                  return (
                    <article key={a.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-foreground">{a.name}</h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {a.code ? `${a.code} — ` : ""}
                            خرید: {toPersianDigits(formatJalali(a.acquisitionDate))}
                            {a.inServiceDate && a.inServiceDate !== a.acquisitionDate
                              ? ` — بهره‌برداری: ${toPersianDigits(formatJalali(a.inServiceDate))}`
                              : ""}
                            {a.locationName ? ` — شعبه: ${a.locationName}` : ""}
                          </p>
                          {a.acquisitionSource ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">بهای دارایی: {ACQUISITION_SOURCE_LABELS[a.acquisitionSource]}</p>
                          ) : null}
                        </div>
                        <div>
                          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div className="mt-3 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            پیشرفت: {toPersianDigits(postedPeriods)} از {toPersianDigits(a.usefulLifeMonths)} ماه استهلاک
                          </span>
                          <span className="font-semibold tabular-nums text-foreground">{toPersianDigits(percent)}٪</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                          <div
                            className={`h-full rounded-full transition-all ${
                              a.fullyDepreciated ? "bg-emerald-500 dark:bg-emerald-400" : "bg-amber-500 dark:bg-amber-400"
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
                          <span>تاریخچه</span>
                        </button>
                        {readOnly ? null : (
                          <AssetActions
                            asset={a}
                            busy={busy || isSubmitting}
                            canManage
                            compact={false}
                            onDepreciate={() => setDepreciateTarget(a)}
                            onHistory={() => setHistoryTarget(a)}
                            onDispose={() => setDisposeTarget(a)}
                            onTransfer={() => setTransferTarget(a)}
                            onEstimate={() => setEstimateTarget(a)}
                            onArchive={() => setArchiveTarget(a)}
                            onDelete={() => setDeleteTarget(a)}
                          />
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>

              {hasMore ? (
                <div className="mt-4 flex justify-center">
                  <SecondaryButton disabled={loadingMore || !nextCursor} onClick={() => void load(nextCursor, true)}>
                    {loadingMore ? "در حال بارگذاری…" : "دارایی‌های بیشتر"}
                  </SecondaryButton>
                </div>
              ) : null}
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
          canManage={!readOnly}
          busy={busy || isSubmitting}
          onClose={() => setHistoryTarget(null)}
          onReverse={(entry) => setReverseTarget({ asset: historyTarget, entry })}
          onOpenJournal={(entryId, title) => setJournalPeekTarget({ entryId, title })}
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

      {/* Disposal / retirement / write-off */}
      {disposeTarget ? (
        <DisposeDialog
          asset={disposeTarget}
          accounts={accounts}
          busy={busy || isSubmitting}
          onClose={() => setDisposeTarget(null)}
          onSuccess={(message) => {
            setDisposeTarget(null);
            setLocalNotice(message);
            refresh();
          }}
        />
      ) : null}

      {/* Branch transfer */}
      {transferTarget ? (
        <TransferDialog
          asset={transferTarget}
          locations={locations ?? []}
          busy={busy || isSubmitting}
          onClose={() => setTransferTarget(null)}
          onSuccess={(message) => {
            setTransferTarget(null);
            setLocalNotice(message);
            refresh();
          }}
        />
      ) : null}

      {/* Prospective estimate change */}
      {estimateTarget ? (
        <EstimateDialog
          asset={estimateTarget}
          busy={busy || isSubmitting}
          onClose={() => setEstimateTarget(null)}
          onSuccess={(message) => {
            setEstimateTarget(null);
            setLocalNotice(message);
            refresh();
          }}
        />
      ) : null}

      {/* Archive */}
      {archiveTarget ? (
        <ArchiveDialog
          asset={archiveTarget}
          busy={busy || isSubmitting}
          onClose={() => setArchiveTarget(null)}
          onSuccess={(message) => {
            setArchiveTarget(null);
            setLocalNotice(message);
            refresh();
          }}
        />
      ) : null}

      {/* Reverse a posted depreciation entry */}
      {reverseTarget ? (
        <ReverseDialog
          asset={reverseTarget.asset}
          entry={reverseTarget.entry}
          busy={busy || isSubmitting}
          onClose={() => setReverseTarget(null)}
          onSuccess={(message) => {
            setReverseTarget(null);
            setLocalNotice(message);
            refresh();
          }}
        />
      ) : null}

      {/* Journal entry drill-down */}
      {journalPeekTarget ? (
        <JournalPeekDialog entryId={journalPeekTarget.entryId} title={journalPeekTarget.title} onClose={() => setJournalPeekTarget(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The create form — master data an asset register actually needs, plus the
// idempotency key that makes a double-submit harmless.
// ---------------------------------------------------------------------------

function AssetForm({
  busy,
  accounts,
  onNotice,
  onError,
  onCreated,
}: {
  busy: boolean;
  accounts?: AccountRow[];
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onCreated: () => void;
}) {
  const money = useMoney();
  const [showDetails, setShowDetails] = useState(false);
  const [name, setName] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [cost, setCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [inServiceDate, setInServiceDate] = useState("");
  const [acquisitionSource, setAcquisitionSource] = useState<NonNullable<FixedAssetRow["acquisitionSource"]> | "post_now">("unlinked");
  const [acquisitionEntryId, setAcquisitionEntryId] = useState("");
  /** «post_now»: the registration itself posts Dr fixed-asset / Cr settlement. */
  const [acquisitionAccountId, setAcquisitionAccountId] = useState("");
  const [acquisitionEntryDate, setAcquisitionEntryDate] = useState("");
  const [candidates, setCandidates] = useState<AcquisitionCandidate[] | null>(null);
  const [category, setCategory] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [code, setCode] = useState("");
  const [purchaseReference, setPurchaseReference] = useState("");
  const [notes, setNotes] = useState("");
  const [vendorPartyId, setVendorPartyId] = useState("");
  const [custodianPartyId, setCustodianPartyId] = useState("");
  const [assetAccountId, setAssetAccountId] = useState("");
  const [suppliers, setSuppliers] = useState<PartyOption[] | null>(null);
  const acquisitionSettlementAccounts = useMemo(
    () => settlementAccountOptions(accounts ?? [], ASSET_ACQUISITION_SOURCE_ROLES),
    [accounts],
  );
  const [staff, setStaff] = useState<PartyOption[] | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (acquisitionSource !== "journal" || candidates) return;
    api<{ candidates: AcquisitionCandidate[] }>("/api/ledger/fixed-assets/acquisition-candidates").then(({ ok, data }) => {
      setCandidates(ok ? data.candidates : []);
    });
  }, [acquisitionSource, candidates]);

  useEffect(() => {
    if (!showDetails || suppliers !== null) return;
    api<{ parties: PartyOption[] }>("/api/parties?role=Supplier&limit=100").then(({ ok, data }) => {
      setSuppliers(ok ? data.parties : []);
    });
  }, [showDetails, suppliers]);

  useEffect(() => {
    if (!showDetails || staff !== null) return;
    api<{ parties: PartyOption[] }>("/api/parties?role=Employee&limit=100").then(({ ok, data }) => {
      setStaff(ok ? data.parties : []);
    });
  }, [showDetails, staff]);

  const fixedAssetAccounts = useMemo(() => {
    // The 1500–1599 block minus the accumulated-depreciation contra and its
    // extensions — the accounts a cost may be classified under.
    return (accounts ?? []).filter((a) => a.type === "asset" && a.code.startsWith("15") && !a.code.startsWith("1510"));
  }, [accounts]);

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

  const liveDepreciableBase = Math.max(0, parsedCost - parsedSalvage);
  const liveMonthlyDepreciation =
    parsedMonths <= 0 || liveDepreciableBase <= 0 ? 0 : Math.round(liveDepreciableBase / parsedMonths);

  async function submitAsset(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    onNotice("");

    const trimmedName = name.trim();
    if (!trimmedName) return onError("نام دارایی الزامی است.");
    if (!acquisitionDate) return onError("تاریخ خرید الزامی است.");
    if (!cost.trim()) return onError("بهای تمام‌شده الزامی است.");
    if (!usefulLifeMonths.trim()) return onError("عمر مفید (ماه) الزامی است.");

    let costRial: number;
    let salvageRial: number;
    try {
      costRial = money.parse(cost);
      salvageRial = salvageValue.trim() ? money.parse(salvageValue) : 0;
    } catch {
      return onError("مبالغ واردشده معتبر نیستند.");
    }
    if (costRial <= 0) return onError("بهای تمام‌شده باید عددی مثبت و بزرگ‌تر از صفر باشد.");
    if (salvageRial < 0) return onError("ارزش اسقاط نمی‌تواند منفی باشد.");
    if (salvageRial >= costRial) return onError("ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.");
    const monthsNum = Number(usefulLifeMonths);
    if (!Number.isInteger(monthsNum) || monthsNum <= 0) return onError("عمر مفید باید یک عدد صحیح مثبت (حداقل ۱ ماه) باشد.");
    if (inServiceDate && inServiceDate < acquisitionDate) return onError("تاریخ بهره‌برداری نمی‌تواند پیش از تاریخ خرید باشد.");
    if (acquisitionSource === "journal" && !acquisitionEntryId) return onError("برای اتصال به سند خرید، یک سند را انتخاب کنید.");
    if (acquisitionSource === "post_now" && !acquisitionAccountId) {
      return onError("برای ثبت سند خرید، حساب پرداخت (صندوق، بانک یا پرداختنی) را انتخاب کنید.");
    }

    setIsSubmitting(true);
    const idempotencyKey = `asset-${crypto.randomUUID()}`;
    const { ok, data } = await api<{ fixedAsset?: FixedAssetRow; error?: string }>("/api/ledger/fixed-assets", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        name: trimmedName,
        acquisitionDate,
        inServiceDate: inServiceDate || null,
        acquisitionSource,
        acquisitionEntryId: acquisitionSource === "journal" ? acquisitionEntryId : null,
        acquisitionAccountId: acquisitionSource === "post_now" ? acquisitionAccountId : null,
        acquisitionEntryDate: acquisitionSource === "post_now" && acquisitionEntryDate ? acquisitionEntryDate : null,
        cost: costRial,
        salvageValue: salvageRial,
        usefulLifeMonths: monthsNum,
        code: code.trim() || null,
        category: category.trim() || null,
        serialNumber: serialNumber.trim() || null,
        vendorPartyId: vendorPartyId || null,
        custodianPartyId: custodianPartyId || null,
        purchaseReference: purchaseReference.trim() || null,
        notes: notes.trim() || null,
        assetAccountId: assetAccountId || null,
      }),
    });
    setIsSubmitting(false);

    if (!ok) {
      return onError(resolveErrorMessage((data as { error?: string }).error));
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
    setCategory("");
    setSerialNumber("");
    setCode("");
    setPurchaseReference("");
    setNotes("");
    setVendorPartyId("");
    setCustodianPartyId("");
    setAssetAccountId("");
    setShowDetails(false);
    onNotice("دارایی ثابت جدید با موفقیت در دفتر ثبت شد.");
    onCreated();
  }

  return (
    <section className={cardClass} aria-labelledby="fixed-asset-form-heading">
      <header className="border-b border-border/80 px-4 py-4 sm:px-5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دفتر اموال و دارایی‌های ثابت</p>
        <h2 id="fixed-asset-form-heading" className="mt-1 text-base font-semibold text-foreground">
          ثبت دارایی ثابت جدید
        </h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
          استهلاک به روش خط مستقیم محاسبه می‌شود؛ ثبت دارایی به‌تنهایی سندی صادر نمی‌کند — مشخص کنید بهای آن کجا در دفاتر آمده
          است و استهلاک هر دوره را جداگانه ثبت کنید.
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
              maxLength={200}
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

          <Field
            label="بهای دارایی در دفاتر"
            hint="ثبت دارایی به‌تنهایی سندی صادر نمی‌کند؛ مشخص کنید بهای آن کجا در دفاتر آمده است"
          >
            <select
              className={inputClass}
              value={acquisitionSource}
              onChange={(e) => setAcquisitionSource(e.target.value as typeof acquisitionSource)}
              disabled={busy || isSubmitting}
            >
              <option value="unlinked">{ACQUISITION_SOURCE_LABELS.unlinked}</option>
              <option value="journal">{ACQUISITION_SOURCE_LABELS.journal}</option>
              <option value="opening_balance">{ACQUISITION_SOURCE_LABELS.opening_balance}</option>
              <option value="post_now">ثبت سند خرید هم‌اکنون (بدهکار دارایی ثابت)</option>
            </select>
          </Field>

          {acquisitionSource === "post_now" ? (
            <>
              <Field label="حساب پرداخت" hint="صندوق، بانک، تنخواه یا حساب پرداختنی که بهای دارایی از آن پرداخت می‌شود">
                {acquisitionSettlementAccounts.length === 0 ? (
                  <p className="text-xs leading-5 text-muted-foreground">حساب مناسبی برای پرداخت یافت نشد.</p>
                ) : (
                  <select
                    className={inputClass}
                    value={acquisitionAccountId}
                    onChange={(e) => setAcquisitionAccountId(e.target.value)}
                    disabled={busy || isSubmitting}
                  >
                    <option value="">انتخاب حساب…</option>
                    {acquisitionSettlementAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="تاریخ سند خرید" hint="پیش‌فرض همان تاریخ خرید است؛ در دورهٔ باز دیگری هم می‌توانید ثبت کنید">
                <JalaliDatePicker
                  value={acquisitionEntryDate || acquisitionDate}
                  onChange={setAcquisitionEntryDate}
                  placeholder="همان تاریخ خرید"
                  disabled={busy || isSubmitting}
                />
              </Field>
            </>
          ) : null}

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

          <Field label={`ارزش اسقاط (${money.unitLabel})`} hint="ارزش تخمینی پایان عمر مفید (اختیاری — پیش‌فرض ۰)">
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

        {/* Optional master data, collapsed by default so the common path stays short */}
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 transition-colors hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
          aria-expanded={showDetails}
        >
          <ChevronDownIcon className={`size-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`} />
          {showDetails ? "بستن اطلاعات تکمیلی" : "اطلاعات تکمیلی (کد، دسته، سریال، فروشنده، متصدی و…)"}
        </button>

        {showDetails ? (
          <div className="mt-3 grid gap-4 rounded-xl border border-border/80 bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="کد دارایی" hint="خالی بگذارید تا خودکار اختصاص یابد (FA-۰۰۰۱)">
              <input
                className={inputClass}
                dir="ltr"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="خودکار"
                maxLength={40}
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="دسته" hint="مثلاً تجهیزات آشپزخانه یا خودرو">
              <input
                className={inputClass}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="دسته‌بندی دارایی"
                maxLength={100}
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="شماره سریال / مدل" hint="شناسه فیزیکی دستگاه">
              <input
                className={inputClass}
                dir="ltr"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                placeholder="SN-..."
                maxLength={120}
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="فروشنده / تأمین‌کننده" hint="از فهرست اشخاص (تأمین‌کنندگان)">
              {suppliers === null ? (
                <LoadingSkeleton rows={1} />
              ) : suppliers.length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">تأمین‌کننده‌ای ثبت نشده است.</p>
              ) : (
                <select
                  className={inputClass}
                  value={vendorPartyId}
                  onChange={(e) => setVendorPartyId(e.target.value)}
                  disabled={busy || isSubmitting}
                >
                  <option value="">انتخاب نشده</option>
                  {suppliers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName ?? p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="متصدی دارایی" hint="از فهرست اشخاص (کارکنان)">
              {staff === null ? (
                <LoadingSkeleton rows={1} />
              ) : staff.length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">عضوی برای انتخاب ثبت نشده است.</p>
              ) : (
                <select
                  className={inputClass}
                  value={custodianPartyId}
                  onChange={(e) => setCustodianPartyId(e.target.value)}
                  disabled={busy || isSubmitting}
                >
                  <option value="">انتخاب نشده</option>
                  {staff.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName ?? p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="حساب دارایی ثابت" hint="حسابی که بهای این دارایی در آن طبقه‌بندی می‌شود (۱۵۰۰ تا ۱۵۹۹)">
              <select
                className={inputClass}
                value={assetAccountId}
                onChange={(e) => setAssetAccountId(e.target.value)}
                disabled={busy || isSubmitting}
              >
                <option value="">پیش‌فرض سرفصل (۱۵۰۰)</option>
                {fixedAssetAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="مرجع سند خرید" hint="شماره فاکتور یا مرجع خرید">
              <input
                className={inputClass}
                dir="ltr"
                value={purchaseReference}
                onChange={(e) => setPurchaseReference(e.target.value)}
                placeholder="INV-..."
                maxLength={120}
                disabled={busy || isSubmitting}
              />
            </Field>

            <Field label="یادداشت" hint="توضیحات آزاد درباره دارایی">
              <textarea
                className={inputClass}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="یادداشت…"
                maxLength={2000}
                rows={2}
                disabled={busy || isSubmitting}
              />
            </Field>
          </div>
        ) : null}

        {/* Live Preview calculation box */}
        {parsedCost > 0 && parsedMonths > 0 ? (
          <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs sm:text-sm dark:bg-amber-500/10">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-muted-foreground">پیش‌نمایش محاسبه استهلاک ماهانه:</span>
              <span className="font-bold tabular-nums text-foreground">
                استهلاک ماهانه تخمینی: {money.format(liveMonthlyDepreciation)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>مبلغ کل استهلاک‌پذیر: {money.format(liveDepreciableBase)}</span>
              <span>
                مدت استهلاک: {toPersianDigits(parsedMonths)} ماه (
                {toPersianDigits((parsedMonths / 12).toFixed(1).replace(".0", ""))} سال)
              </span>
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
  );
}

// ---------------------------------------------------------------------------
// Row actions — one definition for the desktop table and the mobile cards.
// ---------------------------------------------------------------------------

function AssetActions({
  asset,
  busy,
  canManage,
  compact = true,
  onDepreciate,
  onHistory,
  onDispose,
  onTransfer,
  onEstimate,
  onArchive,
  onDelete,
}: {
  asset: FixedAssetRow;
  busy: boolean;
  canManage: boolean;
  compact?: boolean;
  onDepreciate: () => void;
  onHistory: () => void;
  onDispose: () => void;
  onTransfer: () => void;
  onEstimate: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  if (!canManage) {
    return compact ? (
      <button
        type="button"
        onClick={onHistory}
        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-stone-800/60"
        title="مشاهده تاریخچه استهلاک"
      >
        <HistoryIcon className="size-3.5" />
        <span>تاریخچه</span>
      </button>
    ) : null;
  }

  const disposed = asset.status === "disposed";
  const archived = !!asset.archivedAt;
  const depreciable = asset.status === "active" && !archived && !asset.fullyDepreciated;
  const canDelete = asset.status === "active" && !archived && asset.accumulatedDepreciation === 0;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {depreciable ? (
          <button
            type="button"
            onClick={onDepreciate}
            disabled={busy}
            className="rounded-lg px-2.5 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20"
          >
            ثبت استهلاک
          </button>
        ) : null}

        <button
          type="button"
          onClick={onHistory}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-stone-800/60"
          title="مشاهده تاریخچه استهلاک"
        >
          <HistoryIcon className="size-3.5" />
          <span>تاریخچه</span>
        </button>

        {!disposed && !archived ? (
          <>
            <button
              type="button"
              onClick={onTransfer}
              disabled={busy}
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="انتقال به شعبه دیگر"
              aria-label={`انتقال ${asset.name}`}
            >
              <ArrowLeftRightIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onEstimate}
              disabled={busy}
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="تغییر برآورد عمر مفید یا ارزش اسقاط"
              aria-label={`تغییر برآورد ${asset.name}`}
            >
              <CalculatorIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onDispose}
              disabled={busy}
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="واگذاری، اسقاط یا حذف از دفاتر"
              aria-label={`واگذاری ${asset.name}`}
            >
              <PackageXIcon className="size-4" />
            </button>
          </>
        ) : null}

        {!disposed && !archived ? (
          <button
            type="button"
            onClick={onArchive}
            disabled={busy}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="بایگانی دارایی"
            aria-label={`بایگانی ${asset.name}`}
          >
            <ArchiveIcon className="size-4" />
          </button>
        ) : null}

        {canDelete ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded-lg p-1 text-destructive transition-colors hover:bg-destructive/10"
            title="حذف دارایی (فقط بدون سابقه حسابداری)"
            aria-label={`حذف ${asset.name}`}
          >
            <Trash2Icon className="size-4" />
          </button>
        ) : null}
      </div>
    );
  }

  // The mobile cards' labelled buttons
  return (
    <>
      {depreciable ? (
        <button
          type="button"
          onClick={onDepreciate}
          disabled={busy}
          className="rounded-lg bg-amber-100 px-3.5 py-1.5 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30"
        >
          ثبت استهلاک این دوره
        </button>
      ) : null}

      {!disposed && !archived ? (
        <>
          <button
            type="button"
            onClick={onTransfer}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            انتقال شعبه
          </button>
          <button
            type="button"
            onClick={onEstimate}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            تغییر برآورد
          </button>
          <button
            type="button"
            onClick={onDispose}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            واگذاری / اسقاط
          </button>
          <button
            type="button"
            onClick={onArchive}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            بایگانی
          </button>
        </>
      ) : null}

      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          حذف دارایی
        </button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** Posts one period's depreciation for an asset. */
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
    const { ok, data } = await api<{ amount?: number; error?: string }>(`/api/ledger/fixed-assets/${asset.id}/depreciate`, {
      method: "POST",
      body: JSON.stringify({
        periodKey,
        entryDate: entryDate || undefined,
      }),
    });
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

      <InfoBox>
        ثبت ماه‌های گذشته (جبرانی) مجاز است: هر ماه با مبلغ برنامهٔ خودش و در شعبه‌ای که دارایی در آن تاریخ بوده ثبت
        می‌شود. اگر دوره‌ای جا مانده باشد، لازم نیست به‌ترتیب ثبت کنید؛ دورهٔ آخر برنامه، باقیمانده را کامل جذب می‌کند تا
        جمع استهلاک دقیقاً برابر «بهای تمام‌شده منهای ارزش اسقاط» شود.
      </InfoBox>

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
          <JalaliDatePicker value={entryDate} onChange={setEntryDate} placeholder="آخر ماه" disabled={busy || submitting} />
        </Field>

        {/* Amount and ledger posting notice */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs dark:bg-amber-500/10">
          <div className="flex items-center justify-between font-semibold text-foreground">
            <span>مبلغ استهلاک این دوره:</span>
            <span className="text-sm tabular-nums text-amber-800 dark:text-amber-300">{money.format(calculatedPeriodAmount)}</span>
          </div>
          <p className="mt-1.5 text-muted-foreground">
            سند حسابداری در شعبهٔ دارایی ({asset.locationName ?? "بدون شعبه"}) صادر خواهد شد: بدهکار{" "}
            <strong className="text-foreground">هزینه استهلاک (۵۷۰۰)</strong> / بستانکار{" "}
            <strong className="text-foreground">استهلاک انباشته (۱۵۱۰)</strong>
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

/** The full history of one asset: depreciation (with reversal state), transfers and estimate changes. */
function DepreciationHistoryModal({
  asset,
  canManage,
  busy,
  onClose,
  onReverse,
  onOpenJournal,
}: {
  asset: FixedAssetRow;
  canManage: boolean;
  busy: boolean;
  onClose: () => void;
  onReverse: (entry: DepreciationHistoryItem) => void;
  onOpenJournal: (entryId: string, title: string) => void;
}) {
  const money = useMoney();
  const [entries, setEntries] = useState<DepreciationHistoryItem[] | null>(null);
  const [transfers, setTransfers] = useState<FixedAssetTransferItem[] | null>(null);
  const [estimateChanges, setEstimateChanges] = useState<FixedAssetEstimateChangeItem[] | null>(null);
  const [error, setError] = useState("");
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const current = ++requestId.current;
    setError("");
    setEntries(null);
    setHistoryCursor(null);
    api<{
      depreciationEntries: DepreciationHistoryItem[];
      depreciationHasMore?: boolean;
      depreciationNextCursor?: string | null;
      transfers: FixedAssetTransferItem[];
      estimateChanges: FixedAssetEstimateChangeItem[];
    }>(`/api/ledger/fixed-assets/${asset.id}?depreciationLimit=25`)
      .then(({ ok, data }) => {
        if (current !== requestId.current) return;
        if (ok) {
          setEntries(data.depreciationEntries);
          setHistoryCursor(data.depreciationNextCursor ?? null);
          setTransfers(data.transfers);
          setEstimateChanges(data.estimateChanges);
        } else {
          setError("بارگذاری تاریخچه استهلاک این دارایی ناموفق بود.");
        }
      })
      .catch(() => {
        if (current === requestId.current) setError("ارتباط با سرور برقرار نشد.");
      });
  }, [asset.id]);

  /** «ادامه»: the next page of the depreciation history, by its keyset cursor. */
  const loadMoreHistory = async () => {
    if (!historyCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { ok, data } = await api<{
        depreciationEntries: DepreciationHistoryItem[];
        depreciationNextCursor?: string | null;
      }>(`/api/ledger/fixed-assets/${asset.id}?depreciationLimit=25&depreciationCursor=${encodeURIComponent(historyCursor)}`);
      if (ok) {
        setEntries((previous) => [...(previous ?? []), ...data.depreciationEntries]);
        setHistoryCursor(data.depreciationNextCursor ?? null);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const liveEntries = (entries ?? []).filter((e) => !e.reversedAt);
  const totalLive = liveEntries.reduce((sum, e) => sum + e.amount, 0);

  return (
    <OverlayDialog
      headingId="history-dialog-heading"
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-3xl overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق و اسناد</p>
          <h3 id="history-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
            تاریخچه «{asset.name}»
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            خرید: {toPersianDigits(formatJalali(asset.acquisitionDate))} — بهای تمام‌شده: {money.format(asset.cost)}
            {asset.disposalDate ? ` — واگذاری: ${toPersianDigits(formatJalali(asset.disposalDate))}` : ""}
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
      ) : (
        <div className="space-y-5">
          {entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز استهلاکی برای این دارایی ثبت نشده است.
            </p>
          ) : (
            <DataTable caption="تاریخچه استهلاک این دارایی">
              <DataTableHead>
                <Th>ماه استهلاک</Th>
                <Th>تاریخ سند</Th>
                <Th>مبلغ</Th>
                <Th>شعبه ثبت</Th>
                <Th>ثبت‌کننده</Th>
                <Th>وضعیت</Th>
                <Th>سند</Th>
              </DataTableHead>
              <DataTableBody>
                {entries.map((entry) => (
                  <DataTableRow key={entry.id} className={entry.reversedAt ? "opacity-60" : undefined}>
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
                      {entry.postingLocationName ?? "—"}
                    </Td>
                    <Td muted className="text-xs">
                      {entry.createdByName ?? "سیستم"}
                    </Td>
                    <Td>
                      {entry.reversedAt ? (
                        <StatusBadge tone="danger">برگشت خورده</StatusBadge>
                      ) : (
                        <StatusBadge tone="positive">قطعی</StatusBadge>
                      )}
                      {entry.reversedAt ? (
                        <p className="mt-1 max-w-48 text-xs leading-4 text-muted-foreground">
                          {entry.reversedByName ?? ""} — {entry.reversalReason ?? ""}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {entry.journalEntryId ? (
                          <button
                            type="button"
                            onClick={() => onOpenJournal(entry.journalEntryId!, `سند استهلاک ${entry.periodLabel}`)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            title="مشاهده سند حسابداری"
                          >
                            <BookOpenTextIcon className="size-3.5" />
                            <span>سند</span>
                          </button>
                        ) : null}
                        {canManage && !entry.reversedAt ? (
                          <button
                            type="button"
                            onClick={() => onReverse(entry)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20"
                            title="برگشت استهلاک این دوره"
                          >
                            <Undo2Icon className="size-3.5" />
                            <span>برگشت</span>
                          </button>
                        ) : null}
                        {entry.reversalJournalEntryId ? (
                          <button
                            type="button"
                            onClick={() => onOpenJournal(entry.reversalJournalEntryId!, `سند برگشت ${entry.periodLabel}`)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            title="مشاهده سند برگشت"
                          >
                            <BookOpenTextIcon className="size-3.5" />
                            <span>سند برگشت</span>
                          </button>
                        ) : null}
                      </div>
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
          {historyCursor ? (
            <div className="flex justify-center">
              <SecondaryButton disabled={loadingMore} onClick={() => void loadMoreHistory()}>
                {loadingMore ? "در حال بارگذاری…" : "ادامهٔ تاریخچه"}
              </SecondaryButton>
            </div>
          ) : null}

          {entries.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                جمع استهلاک‌های قطعی ({toPersianDigits(liveEntries.length)} دوره از {toPersianDigits(entries.length)})
              </span>
              <span className="font-bold tabular-nums text-foreground">{money.format(totalLive)}</span>
            </div>
          ) : null}

          {transfers && transfers.length > 0 ? (
            <section aria-labelledby="transfer-history-heading">
              <h4 id="transfer-history-heading" className="mb-2 text-sm font-semibold text-foreground">
                انتقال‌های شعبه
              </h4>
              <DataTable caption="انتقال‌های شعبه این دارایی">
                <DataTableHead>
                  <Th>تاریخ مؤثر</Th>
                  <Th>از شعبه</Th>
                  <Th>به شعبه</Th>
                  <Th>دلیل</Th>
                  <Th>انتقال‌دهنده</Th>
                </DataTableHead>
                <DataTableBody>
                  {transfers.map((t) => (
                    <DataTableRow key={t.id}>
                      <Td nowrap muted>
                        {toPersianDigits(formatJalali(t.effectiveDate))}
                      </Td>
                      <Td>{t.fromLocationName ?? "—"}</Td>
                      <Td>{t.toLocationName ?? "—"}</Td>
                      <Td muted className="text-xs">
                        {t.reason}
                      </Td>
                      <Td muted className="text-xs">
                        {t.transferredByName ?? "—"}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </section>
          ) : null}

          {estimateChanges && estimateChanges.length > 0 ? (
            <section aria-labelledby="estimate-history-heading">
              <h4 id="estimate-history-heading" className="mb-2 text-sm font-semibold text-foreground">
                تغییر برآوردها
              </h4>
              <DataTable caption="تغییر برآوردهای این دارایی">
                <DataTableHead>
                  <Th>تاریخ</Th>
                  <Th>عمر مفید</Th>
                  <Th>ارزش اسقاط</Th>
                  <Th>دلیل</Th>
                  <Th>تغییردهنده</Th>
                </DataTableHead>
                <DataTableBody>
                  {estimateChanges.map((c) => (
                    <DataTableRow key={c.id}>
                      <Td nowrap muted>
                        {toPersianDigits(formatJalali(c.changedAt.slice(0, 10)))}
                      </Td>
                      <Td nowrap>
                        {toPersianDigits(c.oldUsefulLifeMonths)} ← {toPersianDigits(c.newUsefulLifeMonths)} ماه
                      </Td>
                      <Td nowrap>
                        {money.format(c.oldSalvageValue)} ← {money.format(c.newSalvageValue)}
                      </Td>
                      <Td muted className="text-xs">
                        {c.reason}
                      </Td>
                      <Td muted className="text-xs">
                        {c.changedByName ?? "—"}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </section>
          ) : null}

          {asset.disposalDate ? (
            <div className="rounded-xl border border-border/80 bg-muted/60 p-3.5 text-xs leading-5 text-muted-foreground">
              <p className="font-semibold text-foreground">واگذاری</p>
              <p className="mt-1">
                {DISPOSAL_KIND_LABELS[asset.disposalKind ?? "sale"]} در {toPersianDigits(formatJalali(asset.disposalDate))}
                {asset.disposalProceeds ? ` به مبلغ ${money.format(asset.disposalProceeds)}` : ""}
                {asset.disposalReason ? ` — ${asset.disposalReason}` : ""}
              </p>
              {asset.disposalJournalEntryId ? (
                <button
                  type="button"
                  onClick={() => onOpenJournal(asset.disposalJournalEntryId!, "سند واگذاری دارایی")}
                  className="mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20"
                >
                  <BookOpenTextIcon className="size-3.5" />
                  <span>مشاهده سند واگذاری</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </OverlayDialog>
  );
}

/** Reverses one posted depreciation entry — the auditable correction path. */
function ReverseDialog({
  asset,
  entry,
  busy,
  onClose,
  onSuccess,
}: {
  asset: FixedAssetRow;
  entry: DepreciationHistoryItem;
  busy: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const money = useMoney();
  const [reversalDate, setReversalDate] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (!reason.trim()) {
      setLocalError("ذکر دلیل برگشت الزامی است.");
      return;
    }

    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/fixed-assets/${asset.id}/reverse`, {
      method: "POST",
      body: JSON.stringify({
        depreciationEntryId: entry.id,
        reversalDate: reversalDate || undefined,
        reason: reason.trim(),
      }),
    });
    setSubmitting(false);

    if (!ok) {
      const code = (data as { error?: string }).error;
      if (code === "fiscal_period_locked") {
        return setLocalError(
          "دوره مالی سند اصلی قفل است؛ برگشت در آن دوره ممکن نیست. یک «تاریخ برگشت» در یک دورهٔ باز انتخاب کنید.",
        );
      }
      return setLocalError(resolveErrorMessage(code));
    }

    onSuccess(`برگشت استهلاک ${entry.periodLabel} با موفقیت ثبت شد.`);
  }

  return (
    <OverlayDialog
      headingId="reverse-dialog-heading"
      onClose={onClose}
      dismissible={!(busy || submitting)}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">برگشت استهلاک</p>
          <h3 id="reverse-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
            برگشت استهلاک {entry.periodKey ? toPersianDigits(periodKeyLabel(entry.periodKey)) : entry.periodLabel}
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>

      <ErrorBox>{localError}</ErrorBox>

      <div className="mb-4 rounded-xl border border-border/80 bg-muted/60 p-3.5 text-xs leading-5 text-muted-foreground">
        <p>
          سند برگشت، آینهٔ دقیق اثر سند اصلی است: بدهکار <strong className="text-foreground">استهلاک انباشته (۱۵۱۰)</strong> به
          مبلغ {money.format(entry.amount)} / بستانکار <strong className="text-foreground">هزینه استهلاک (۵۷۰۰)</strong>. ردیف
          اصلی حذف نمی‌شود و فقط «برگشت خورده» علامت می‌خورد؛ ماه مورد نظر می‌تواند دوباره ثبت شود.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="تاریخ سند برگشت" hint="پیش‌فرض: تاریخ سند اصلی — اگر دوره قفل است، یک تاریخ در دورهٔ باز انتخاب کنید">
          <JalaliDatePicker value={reversalDate} onChange={setReversalDate} placeholder="تاریخ سند اصلی" disabled={busy || submitting} />
        </Field>

        <Field label="دلیل برگشت" hint="برای رسیدگی حسابداری الزامی است">
          <textarea
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً ثبت اشتباه مبلغ در این دوره"
            rows={2}
            maxLength={500}
            disabled={busy || submitting}
          />
        </Field>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy || submitting}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={busy || submitting || !reason.trim()}>
            {submitting ? "در حال ثبت برگشت…" : "ثبت برگشت"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

/** Disposal: sale with proceeds, or zero-proceeds retirement/write-off. */
function DisposeDialog({
  asset,
  accounts,
  busy,
  onClose,
  onSuccess,
}: {
  asset: FixedAssetRow;
  accounts?: AccountRow[];
  busy: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const money = useMoney();
  const [kind, setKind] = useState<NonNullable<FixedAssetRow["disposalKind"]>>("sale");
  const [disposalDate, setDisposalDate] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [proceedsAccountId, setProceedsAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const settlementAccounts = useMemo(
    () => settlementAccountOptions(accounts ?? [], ASSET_SALE_PROCEEDS_ROLES),
    [accounts],
  );

  const netBookValue = Math.max(0, asset.cost - asset.accumulatedDepreciation);
  let parsedProceeds = 0;
  if (kind === "sale" && proceeds.trim()) {
    try {
      parsedProceeds = money.parse(proceeds);
    } catch {
      parsedProceeds = -1;
    }
  }
  const gain = Math.max(0, parsedProceeds - netBookValue);
  const loss = Math.max(0, netBookValue - parsedProceeds);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");

    if (kind === "sale") {
      if (parsedProceeds <= 0) return setLocalError("مبلغ فروش باید عددی مثبت باشد.");
      if (!proceedsAccountId) return setLocalError("حساب وصول مبلغ فروش را انتخاب کنید.");
    }

    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/fixed-assets/${asset.id}/dispose`, {
      method: "POST",
      body: JSON.stringify({
        kind,
        disposalDate: disposalDate || undefined,
        proceeds: kind === "sale" ? parsedProceeds : undefined,
        proceedsAccountId: kind === "sale" ? proceedsAccountId : undefined,
        reason: reason.trim() || undefined,
      }),
    });
    setSubmitting(false);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    onSuccess(
      kind === "sale"
        ? `فروش «${asset.name}» ثبت شد.`
        : kind === "retirement"
          ? `اسقاط «${asset.name}» ثبت شد.`
          : `«${asset.name}» از دفاتر حذف شد.`,
    );
  }

  return (
    <OverlayDialog
      headingId="dispose-dialog-heading"
      onClose={onClose}
      dismissible={!(busy || submitting)}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پایان عمر دارایی</p>
          <h3 id="dispose-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
            واگذاری / اسقاط «{asset.name}»
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>

      <ErrorBox>{localError}</ErrorBox>

      <div className="mb-4 rounded-xl border border-border/80 bg-muted/60 p-3.5 text-xs text-muted-foreground">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-xs text-muted-foreground">بهای تمام‌شده:</span>
            <p className="font-semibold tabular-nums text-foreground">{money.format(asset.cost)}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">استهلاک انباشته:</span>
            <p className="font-semibold tabular-nums text-foreground">{money.format(asset.accumulatedDepreciation)}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">ارزش دفتری خالص:</span>
            <p className="font-semibold tabular-nums text-foreground">{money.format(netBookValue)}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">سود / زیان فروش:</span>
            <p className="font-semibold tabular-nums text-foreground">
              {gain > 0 ? `سود ${money.format(gain)}` : loss > 0 ? `زیان ${money.format(loss)}` : "—"}
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="نوع عملیات" hint="فروش با دریافت مبلغ؛ اسقاط و حذف از دفاتر بدون مبلغ">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/60 p-1">
            {(
              [
                { key: "sale", label: "فروش" },
                { key: "retirement", label: "اسقاط" },
                { key: "write_off", label: "حذف از دفاتر" },
              ] as { key: NonNullable<FixedAssetRow["disposalKind"]>; label: string }[]
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setKind(option.key)}
                className={`flex-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  kind === option.key
                    ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="تاریخ عملیات" hint="پیش‌فرض: امروز">
          <JalaliDatePicker value={disposalDate} onChange={setDisposalDate} placeholder="امروز" disabled={busy || submitting} />
        </Field>

        {kind === "sale" ? (
          <>
            <Field label={`مبلغ فروش (${money.unitLabel})`} hint="مبلغی که برای دارایی دریافت می‌شود">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={proceeds}
                onChange={(e) => setProceeds(e.target.value)}
                placeholder="۰"
                disabled={busy || submitting}
              />
            </Field>

            <Field label="حساب وصول" hint="صندوق، بانک یا حساب دیگری که مبلغ فروش به آن وصول می‌شود">
              {settlementAccounts.length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">حساب مناسبی برای وصول یافت نشد.</p>
              ) : (
                <select
                  className={inputClass}
                  value={proceedsAccountId}
                  onChange={(e) => setProceedsAccountId(e.target.value)}
                  disabled={busy || submitting}
                >
                  <option value="">انتخاب حساب…</option>
                  {settlementAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </>
        ) : null}

        <Field label="دلیل (اختیاری)" hint="برای رسیدگی حسابداری">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً فروش به خریدار نقدی"
            maxLength={500}
            disabled={busy || submitting}
          />
        </Field>

        <div className="rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs leading-5 text-muted-foreground dark:bg-amber-500/10">
          سند واگذاری صادر می‌شود: هزینه و استهلاک انباشته از ترازنامه خارج و سود یا زیان به حساب‌های مربوطه (۴۹۲۰ / ۵۷۵۰)
          منتقل می‌شود. پس از واگذاری، دیگر امکان ثبت استهلاک برای این دارایی وجود ندارد.
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy || submitting}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={busy || submitting || (kind === "sale" && (parsedProceeds <= 0 || !proceedsAccountId))}>
            {submitting ? "در حال ثبت…" : "ثبت واگذاری"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

/** Moves an asset to another branch, with an audited reason. */
function TransferDialog({
  asset,
  locations,
  busy,
  onClose,
  onSuccess,
}: {
  asset: FixedAssetRow;
  locations: LocationOption[];
  busy: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [toLocationId, setToLocationId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const options = locations.filter((l) => l.id !== asset.locationId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (!toLocationId) return setLocalError("شعبه مقصد را انتخاب کنید.");
    if (!reason.trim()) return setLocalError("ذکر دلیل انتقال الزامی است.");

    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/fixed-assets/${asset.id}/transfer`, {
      method: "POST",
      body: JSON.stringify({
        toLocationId,
        effectiveDate: effectiveDate || undefined,
        reason: reason.trim(),
      }),
    });
    setSubmitting(false);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    onSuccess("انتقال شعبه دارایی ثبت شد؛ استهلاک‌های بعدی به شعبه جدید ثبت می‌شوند.");
  }

  return (
    <OverlayDialog
      headingId="transfer-dialog-heading"
      onClose={onClose}
      dismissible={!(busy || submitting)}
      className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انتقال بین شعب</p>
          <h3 id="transfer-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
            انتقال «{asset.name}»
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>

      <ErrorBox>{localError}</ErrorBox>

      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        شعبه فعلی: <strong className="text-foreground">{asset.locationName ?? "بدون شعبه"}</strong>. پس از انتقال، اسناد
        استهلاک بعدی به شعبه جدید صادر می‌شود؛ سوابق استهلاک قبلی دست‌نخورده می‌مانند.
      </p>
      <InfoBox>
        تاریخ مؤثر یعنی دارایی از چه تاریخی در شعبهٔ جدید حساب می‌شود: استهلاک دوره‌هایی که پیش از این تاریخ هستند (حتی
        اگر بعداً به‌عنوان جبرانی ثبت شوند) به شعبهٔ قبلی می‌افتند و دوره‌های بعد از آن به شعبهٔ جدید. تاریخ نمی‌تواند پیش از
        بهره‌برداری دارایی یا پیش از آخرین انتقال قبلی باشد.
      </InfoBox>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="شعبه مقصد">
          <select className={inputClass} value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} disabled={busy || submitting}>
            <option value="">انتخاب شعبه…</option>
            {options.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="تاریخ مؤثر" hint="پیش‌فرض: امروز — نمی‌تواند در آینده باشد">
          <JalaliDatePicker value={effectiveDate} onChange={setEffectiveDate} placeholder="امروز" disabled={busy || submitting} />
        </Field>

        <Field label="دلیل انتقال" hint="برای رسیدگی حسابداری الزامی است">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً انتقال به شعبه مرکزی"
            maxLength={500}
            disabled={busy || submitting}
          />
        </Field>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy || submitting}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={busy || submitting || !toLocationId || !reason.trim()}>
            {submitting ? "در حال ثبت…" : "ثبت انتقال"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

/** Prospective change of estimate: new useful life and/or salvage value. */
function EstimateDialog({
  asset,
  busy,
  onClose,
  onSuccess,
}: {
  asset: FixedAssetRow;
  busy: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const money = useMoney();
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");
  const [salvageValue, setSalvageValue] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const posted = asset.depreciationCount ?? 0;
  const remainingBase = Math.max(0, asset.cost - asset.salvageValue - asset.accumulatedDepreciation);

  let newLife: number | null = null;
  let newSalvage: number | null = null;
  if (usefulLifeMonths.trim()) {
    const n = Number(usefulLifeMonths);
    if (Number.isInteger(n) && n > 0) newLife = n;
  }
  if (salvageValue.trim()) {
    try {
      newSalvage = money.parse(salvageValue);
    } catch {
      newSalvage = -1;
    }
  }
  const effectiveSalvage = newSalvage ?? asset.salvageValue;
  const effectiveLife = newLife ?? asset.usefulLifeMonths;
  const previewRemaining = Math.max(0, asset.cost - effectiveSalvage - asset.accumulatedDepreciation);
  const previewRemainingLife = Math.max(0, effectiveLife - posted);
  const previewMonthly = previewRemainingLife > 0 ? Math.round(previewRemaining / previewRemainingLife) : previewRemaining;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (!usefulLifeMonths.trim() && !salvageValue.trim()) {
      return setLocalError("حداقل یکی از عمر مفید یا ارزش اسقاط جدید را وارد کنید.");
    }
    if (!reason.trim()) return setLocalError("ذکر دلیل تغییر برآورد الزامی است.");

    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/fixed-assets/${asset.id}/estimate`, {
      method: "POST",
      body: JSON.stringify({
        usefulLifeMonths: newLife ?? undefined,
        salvageValue: newSalvage !== null && newSalvage >= 0 ? newSalvage : undefined,
        reason: reason.trim(),
      }),
    });
    setSubmitting(false);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    onSuccess("تغییر برآورد ثبت شد؛ از دوره بعدی اعمال می‌شود.");
  }

  return (
    <OverlayDialog
      headingId="estimate-dialog-heading"
      onClose={onClose}
      dismissible={!(busy || submitting)}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تغییر برآورد</p>
          <h3 id="estimate-dialog-heading" className="mt-1 text-lg font-bold text-foreground">
            تغییر برآورد «{asset.name}»
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>

      <ErrorBox>{localError}</ErrorBox>

      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        تغییر برآورد <strong className="text-foreground">آینده‌نگر</strong> است: {toPersianDigits(posted)} دوره استهلاک ثبت‌شده
        دست نمی‌خورد و باقی‌ماندهٔ استهلاک‌پذیر ({money.format(remainingBase)}) از دورهٔ بعد بر عمر مفید باقی‌مانده پخش می‌شود.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="عمر مفید جدید (ماه)" hint={`فعلی: ${toPersianDigits(asset.usefulLifeMonths)} ماه`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={usefulLifeMonths}
            onChange={(e) => setUsefulLifeMonths(e.target.value)}
            placeholder={String(asset.usefulLifeMonths)}
            disabled={busy || submitting}
          />
        </Field>

        <Field label={`ارزش اسقاط جدید (${money.unitLabel})`} hint={`فعلی: ${money.format(asset.salvageValue)}`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={salvageValue}
            onChange={(e) => setSalvageValue(e.target.value)}
            placeholder="۰"
            disabled={busy || submitting}
          />
        </Field>

        <Field label="دلیل تغییر برآورد" hint="برای رسیدگی حسابداری الزامی است">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً بازبینی عمر مفید طبق تجربهٔ بهره‌برداری"
            maxLength={500}
            disabled={busy || submitting}
          />
        </Field>

        {previewRemainingLife > 0 && (newLife !== null || newSalvage !== null) ? (
          <div className="rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs dark:bg-amber-500/10">
            <div className="flex items-center justify-between font-semibold text-foreground">
              <span>استهلاک ماهانهٔ دوره‌های بعد:</span>
              <span className="text-sm tabular-nums text-amber-800 dark:text-amber-300">{money.format(previewMonthly)}</span>
            </div>
            <p className="mt-1.5 text-muted-foreground">
              باقی‌مانده {money.format(previewRemaining)} در {toPersianDigits(previewRemainingLife)} ماه باقی‌مانده
            </p>
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy || submitting}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={busy || submitting || (!usefulLifeMonths.trim() && !salvageValue.trim()) || !reason.trim()}>
            {submitting ? "در حال ثبت…" : "ثبت تغییر برآورد"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

/** Archives an asset — the auditable alternative to deleting it. */
function ArchiveDialog({
  asset,
  busy,
  onClose,
  onSuccess,
}: {
  asset: FixedAssetRow;
  busy: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (!reason.trim()) return setLocalError("ذکر دلیل بایگانی الزامی است.");

    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/fixed-assets/${asset.id}/archive`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim() }),
    });
    setSubmitting(false);

    if (!ok) {
      return setLocalError(resolveErrorMessage((data as { error?: string }).error));
    }

    onSuccess("دارایی بایگانی شد؛ سوابق آن حفظ می‌شود.");
  }

  return (
    <OverlayDialog
      headingId="archive-dialog-heading"
      onClose={onClose}
      dismissible={!(busy || submitting)}
      className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-6`}
    >
      <header className="mb-3">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">بایگانی دارایی</p>
        <h3 id="archive-dialog-heading" className="mt-1 text-base font-bold text-foreground">
          بایگانی «{asset.name}»
        </h3>
      </header>

      <ErrorBox>{localError}</ErrorBox>

      <p className="text-xs leading-5 text-muted-foreground">
        دارایی بایگانی‌شده از فهرست کاری خارج می‌شود و دیگر استهلاک، انتقال یا تغییر برآورد نمی‌پذیرد؛ اما ردیف آن و تمام
        سوابق حسابداری‌اش حفظ می‌شود. حذف قطعی فقط برای دارایی بدون هیچ سابقه‌ای ممکن است.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <Field label="دلیل بایگانی" hint="برای رسیدگی حسابداری الزامی است">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً مازاد و خارج از استفاده"
            maxLength={500}
            disabled={busy || submitting}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy || submitting}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={busy || submitting || !reason.trim()}>
            {submitting ? "در حال بایگانی…" : "بایگانی دارایی"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

/** Hard-deletion — only ever offered for an asset with no accounting history. */
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
        این دارایی با بهای تمام‌شده {money.format(asset.cost)} از دفتر اموال حذف خواهد شد. حذف قطعی فقط برای دارایی بدون
        استهلاک، سند خرید یا سابقهٔ انتقال ممکن است؛ در غیر این صورت از «بایگانی» استفاده کنید.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <SecondaryButton onClick={onClose} disabled={busy}>
          انصراف
        </SecondaryButton>
        <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy} className="w-full font-semibold">
          {busy ? "در حال حذف…" : "تأیید و حذف"}
        </Button>
      </div>
    </OverlayDialog>
  );
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
            {toPersianDigits(reconciliation.unlinkedCount)} دارایی به ارزش {money.format(Number(reconciliation.unlinkedCost))} به
            هیچ سند خرید یا افتتاحیه‌ای متصل نیست؛ تا مشخص نشود، بهای آن‌ها در دفاتر تأیید نشده است.
          </li>
        ) : null}
      </ul>
    </InfoBox>
  );
}
