"use client";

/**
 * دارایی‌های نامشهود — the register, management and reporting screen (issue
 * #1326, Linear ESH-163).
 *
 * The service layer owns every accounting rule (amortization, impairment,
 * disposal, prospective estimate changes, reconciliation); this screen only
 * reflects its authoritative state. It never derives a balance of its own: the
 * register columns, the schedule, the totals and the exported files all come
 * from the same server reads.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cardClass,
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  overlayPanelClass,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, JALALI_MONTHS } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  api,
  ErrorBox,
  errorMessageOrRaw,
  Field,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { OverlayDialog } from "./ledger-ui";
import { JournalPeekDialog } from "./journal-peek-dialog";
import type { AccountRow } from "./accounting-manager";
import {
  ASSET_ACQUISITION_SOURCE_ROLES,
  ASSET_SALE_PROCEEDS_ROLES,
  classifyAccounts,
  type AccountRole,
} from "@/lib/account-classification";
import {
  DISPOSAL_KIND_LABELS,
  INTANGIBLE_ASSET_CLASSES,
  INTANGIBLE_ASSET_CLASS_LABELS,
  INTANGIBLE_EVIDENCE_MAX_LENGTH,
  INTANGIBLE_POLICY_NOTE_MAX_LENGTH,
  INTANGIBLE_REASON_MAX_LENGTH,
  USEFUL_LIFE_TYPES,
  USEFUL_LIFE_TYPE_LABELS,
  type DisposalKind,
  type IntangibleAssetClass,
  type UsefulLifeType,
} from "@/lib/intangible-assets";
import { INTANGIBLE_ASSET_ERROR_TRANSLATIONS } from "@/lib/intangible-assets-errors";
import {
  BookOpenTextIcon,
  CalculatorIcon,
  CalendarIcon,
  CheckCircle2Icon,
  FileDownIcon,
  HistoryIcon,
  LayersIcon,
  PlusIcon,
  TrendingDownIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Shapes — the API's, in one place so the screen and its dialogs agree.
// ---------------------------------------------------------------------------

export interface IntangibleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  assetClass: IntangibleAssetClass;
  acquisitionDate: string;
  availableForUseDate: string;
  acquisitionSource: string;
  cost: number;
  directlyAttributableCost: number;
  usefulLifeType: UsefulLifeType;
  usefulLifeMonths: number | null;
  residualValue: number;
  assetAccountId: string | null;
  accumulatedAmortizationAccountId: string | null;
  amortizationExpenseAccountId: string | null;
  impairmentLossAccountId: string | null;
  accumulatedImpairmentAccountId: string | null;
  capitalizationPolicyNote: string | null;
  evidenceReference: string | null;
  custodianPartyId: string | null;
  notes: string | null;
  status: "active" | "disposed";
  locationId: string | null;
  disposalKind: DisposalKind | null;
  disposalDate: string | null;
  disposalProceeds: number | null;
  disposalReason: string | null;
  accumulatedAmortization: number;
  accumulatedImpairment: number;
  carryingAmount: number;
  amortizableBase: number;
  remainingLifeMonths: number | null;
  periodsPosted: number;
  locationName: string | null;
  custodianName: string | null;
  lastPostingDate: string | null;
  lastReviewDate: string | null;
  createdAt: string;
}

interface AmortizationEntry {
  id: string;
  periodKey: string;
  periodLabel: string;
  entryDate: string;
  amount: number;
  reversedAt: string | null;
  journalEntryId: string | null;
}

interface ImpairmentEntry {
  id: string;
  assessmentDate: string;
  effectiveDate: string;
  recoverableAmount: number;
  carryingAmountBefore: number;
  impairmentAmount: number;
  reason: string;
  evidenceReference: string | null;
  reversedAt: string | null;
  reversalOf: string | null;
  journalEntryId: string | null;
}

export interface EstimateChangeEntry {
  id: string;
  effectiveDate: string;
  effectivePeriodKey: string;
  previousUsefulLifeType: UsefulLifeType;
  previousUsefulLifeMonths: number | null;
  previousResidualValue: number;
  newUsefulLifeType: UsefulLifeType;
  newUsefulLifeMonths: number | null;
  newResidualValue: number;
  remainingBase: number;
  remainingLifeMonths: number | null;
  accumulatedAmortizationAtChange: number;
  accumulatedImpairmentAtChange: number;
  periodsPostedAtChange: number;
  reason: string;
  evidenceReference: string | null;
  approvedByName: string | null;
  changedByName: string | null;
  createdAt: string;
}

interface ScheduleRow {
  periodKey: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: "posted" | "forecast";
  openingCarrying: number;
  amortization: number;
  closingCarrying: number;
  accumulated: number;
  entryId: string | null;
  journalEntryId: string | null;
}

interface ScheduleTotals {
  cost: number;
  residualValue: number;
  amortizableBase: number;
  postedAmortization: number;
  forecastAmortization: number;
  accumulated: number;
  closingCarrying: number;
}

interface AssetDetail {
  asset: IntangibleRow;
  entries: AmortizationEntry[];
  impairments: ImpairmentEntry[];
  estimateChanges: EstimateChangeEntry[];
  schedule: ScheduleRow[];
  totals: ScheduleTotals;
}

interface ReconciliationView {
  registerCost: string;
  ledgerCost: string;
  costDifference: string;
  registerAccumulatedAmortization: string;
  ledgerAccumulatedAmortization: string;
  amortizationDifference: string;
  registerAccumulatedImpairment: string;
  ledgerAccumulatedImpairment: string;
  impairmentDifference: string;
  unmappedCount: number;
  status: "reconciled" | "difference";
}

interface LocationOption {
  id: string;
  name: string;
}

const ERROR_TRANSLATIONS: Record<string, string> = INTANGIBLE_ASSET_ERROR_TRANSLATIONS;

function resolveErrorMessage(code: string | undefined): string {
  if (!code) return "خطای غیرمنتظره رخ داد.";
  if (ERROR_TRANSLATIONS[code]) return ERROR_TRANSLATIONS[code];
  if (/[\u0600-\u06FF]/.test(code)) return code;
  return errorMessageOrRaw(code);
}

function periodLabelOf(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return JALALI_MONTHS[m - 1] ? `${JALALI_MONTHS[m - 1]} ${toPersianDigits(y)}` : key;
}

function jalaliOrDash(iso: string | null | undefined): string {
  return iso ? formatJalali(iso) : "—";
}

/** The register's one status vocabulary — table, chips and export agree. */
function statusView(asset: IntangibleRow): { label: string; tone: "active" | "positive" | "neutral" | "danger" } {
  if (asset.status === "disposed") {
    return {
      label: `${DISPOSAL_KIND_LABELS[asset.disposalKind ?? "sale"]}‌شده`,
      tone: "neutral",
    };
  }
  if (asset.usefulLifeType === "indefinite") return { label: "عمر نامحدود", tone: "active" };
  if (asset.remainingLifeMonths === 0 || asset.carryingAmount === asset.residualValue) {
    return { label: "مستهلک‌شده", tone: "positive" };
  }
  return { label: "در جریان استهلاک", tone: "active" };
}

/** The acquisition-settlement accounts of one allowed-role set (canonical classification). */
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

const TABS = [
  { key: "general", label: "اطلاعات عمومی" },
  { key: "policy", label: "سرمایه‌گذاری و تأیید" },
  { key: "schedule", label: "برنامهٔ استهلاک" },
  { key: "postings", label: "اسناد ثبت‌شده" },
  { key: "estimates", label: "تغییر برآوردها" },
  { key: "impairment", label: "کاهش ارزش و برگشت" },
  { key: "disposal", label: "واگذاری" },
  { key: "audit", label: "تطبیق و سابقه" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// ---------------------------------------------------------------------------

export function IntangibleAssetsSection({
  busy,
  refreshKey,
  canManage,
  accounts = [],
}: {
  busy: boolean;
  refreshKey: number;
  /** `undefined` = capability unknown: read-only until it is known. */
  canManage?: boolean;
  accounts?: AccountRow[];
}) {
  const money = useMoney();
  const readOnly = canManage !== true;

  const [assets, setAssets] = useState<IntangibleRow[] | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locations, setLocations] = useState<LocationOption[]>([]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "disposed">("all");
  const [lifeType, setLifeType] = useState<"" | UsefulLifeType>("");
  const [assetClass, setAssetClass] = useState<"" | IntangibleAssetClass>("");
  const [branch, setBranch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [action, setAction] = useState<
    | { kind: "amortize" | "impair" | "dispose" | "estimate"; asset: IntangibleRow }
    | null
  >(null);
  const [journalPeek, setJournalPeek] = useState<{ entryId: string; title: string } | null>(null);

  const requestId = useRef(0);
  const assetsRef = useRef<IntangibleRow[] | null>(null);
  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  const query = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status !== "all") params.set("status", status);
    if (lifeType) params.set("usefulLifeType", lifeType);
    if (assetClass) params.set("assetClass", assetClass);
    if (branch) params.set("locationId", branch);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    return params;
  }, [search, status, lifeType, assetClass, branch, dateFrom, dateTo]);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    const { ok, data } = await api<{
      intangibleAssets: IntangibleRow[];
      reconciliation?: ReconciliationView;
      error?: string;
    }>(`/api/ledger/intangible-assets?${query()}`);
    if (current !== requestId.current) return;
    if (ok) {
      setAssets(data.intangibleAssets);
      setReconciliation(data.reconciliation ?? null);
      setPage(1);
    } else if (assetsRef.current === null) {
      // The first load for this scope failed: there is nothing to protect, so
      // say so instead of leaving a permanent skeleton.
      setAssets([]);
      setError("بارگذاری فهرست دارایی‌های نامشهود ناموفق بود.");
    } else {
      setError("تازه‌سازی فهرست ناموفق بود؛ داده‌های پیشین نمایش داده می‌شود.");
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search, refreshKey]);

  useEffect(() => {
    api<{ locations: LocationOption[] }>("/api/locations/active").then(({ ok, data }) => {
      if (ok) setLocations(data.locations.map((l) => ({ id: l.id, name: l.name })));
    });
  }, []);

  const kpis = useMemo(() => {
    const rows = assets ?? [];
    return {
      count: rows.length,
      activeCount: rows.filter((a) => a.status === "active").length,
      disposedCount: rows.filter((a) => a.status === "disposed").length,
      cost: rows.reduce((sum, a) => sum + a.cost, 0),
      accumulatedAmortization: rows.reduce((sum, a) => sum + a.accumulatedAmortization, 0),
      accumulatedImpairment: rows.reduce((sum, a) => sum + a.accumulatedImpairment, 0),
      carryingAmount: rows.reduce((sum, a) => sum + a.carryingAmount, 0),
    };
  }, [assets]);

  const pageCount = Math.max(1, Math.ceil((assets?.length ?? 0) / PAGE_SIZE));
  const visible = (assets ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const exportHref = (format: "xlsx" | "csv" | "pdf", report: string): string => {
    const params = query();
    params.set("format", format);
    params.set("report", report);
    return `/api/ledger/intangible-assets/export?${params}`;
  };

  function afterMutation(message: string) {
    setError("");
    setNotice(message);
    setAction(null);
    void load();
  }

  return (
    <div className="space-y-5">
      {/* KPIs — the server's own totals over the filtered register. */}
      <KpiRow>
        <KpiCard
          label="بهای تمام‌شدهٔ کل"
          value={money.format(kpis.cost)}
          hint="ارزش سرمایه‌ای‌شدهٔ دارایی‌های نامشهود"
          icon={LayersIcon}
        />
        <KpiCard
          label="استهلاک انباشته"
          value={money.format(kpis.accumulatedAmortization)}
          hint="مجموع استهلاک‌های سند خورده"
          icon={TrendingDownIcon}
        />
        <KpiCard
          label="ارزش دفتری جاری"
          value={money.format(kpis.carryingAmount)}
          hint="بهای تمام‌شده منهای استهلاک و کاهش ارزش"
          icon={CheckCircle2Icon}
        />
        <KpiCard
          label="تعداد دارایی‌ها"
          value={`${toPersianDigits(kpis.count)} مورد`}
          hint={`${toPersianDigits(kpis.activeCount)} در جریان${
            kpis.disposedCount ? ` / ${toPersianDigits(kpis.disposedCount)} واگذارشده` : ""
          }`}
          icon={CalendarIcon}
        />
      </KpiRow>

      <ReconciliationNotice reconciliation={reconciliation} money={money} />

      <ReportsStrip exportHref={exportHref} />

      <ErrorBox>{error}</ErrorBox>
      {notice ? (
        <p
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice("")}
            aria-label="بستن پیام"
            className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-300 dark:hover:text-emerald-100"
          >
            <XIcon className="size-4" />
          </button>
        </p>
      ) : null}

      {readOnly ? (
        <InfoBox>
          شما دسترسی فقط‌خواندنی به دفتر دارایی‌های نامشهود دارید؛ ثبت، استهلاک، کاهش ارزش، تغییر برآورد و واگذاری
          برای شما فعال نیست.
        </InfoBox>
      ) : null}

      <section className={cardClass} aria-labelledby="intangible-register-heading">
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دفتر دارایی‌های نامشهود</p>
              <h2 id="intangible-register-heading" className="mt-1 text-base font-semibold text-foreground">
                دارایی‌های نامشهود ثبت‌شده
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={exportHref("xlsx", "register")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="دریافت اکسل کامل: دفتر، برنامهٔ استهلاک، سابقهٔ ثبت‌شده، کاهش ارزش، واگذاری، تغییر برآورد و تطبیق"
              >
                <FileDownIcon className="size-3.5" />
                <span>دریافت اکسل</span>
              </a>
              <a
                href={exportHref("csv", "register")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FileDownIcon className="size-3.5" />
                <span>CSV</span>
              </a>
              <a
                href={exportHref("pdf", "register")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FileDownIcon className="size-3.5" />
                <span>PDF</span>
              </a>
              {readOnly ? null : (
                <Button type="button" size="sm" onClick={() => setRegisterOpen(true)} disabled={busy}>
                  <PlusIcon className="size-4" />
                  ثبت دارایینامشهود
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <SearchField
              label="جستجوی دارایی نامشهود"
              value={search}
              onChange={setSearch}
              placeholder="جستجو بر اساس نام یا کد دارایی…"
            />
            <FilterChipRow label="فیلتر وضعیت دارایی نامشهود">
              <FilterChip selected={status === "all"} onClick={() => setStatus("all")}>
                همه
              </FilterChip>
              <FilterChip selected={status === "active"} onClick={() => setStatus("active")}>
                در جریان
              </FilterChip>
              <FilterChip selected={status === "disposed"} onClick={() => setStatus("disposed")}>
                واگذارشده
              </FilterChip>
              <FilterChip selected={lifeType === "finite"} onClick={() => setLifeType(lifeType === "finite" ? "" : "finite")}>
                عمر محدود
              </FilterChip>
              <FilterChip
                selected={lifeType === "indefinite"}
                onClick={() => setLifeType(lifeType === "indefinite" ? "" : "indefinite")}
              >
                عمر نامحدود
              </FilterChip>
            </FilterChipRow>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="فیلتر طبقه"
                value={assetClass}
                onChange={(e) => setAssetClass(e.target.value as typeof assetClass)}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
              >
                <option value="">همهٔ طبقه‌ها</option>
                {INTANGIBLE_ASSET_CLASSES.map((key) => (
                  <option key={key} value={key}>
                    {INTANGIBLE_ASSET_CLASS_LABELS[key]}
                  </option>
                ))}
              </select>
              <select
                aria-label="فیلتر شعبه"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="h-9 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
              >
                <option value="">همهٔ شعبه‌ها</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
              <div className="w-32">
                <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ تحصیل" />
              </div>
              <span className="text-xs text-muted-foreground">تا</span>
              <div className="w-32">
                <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ تحصیل" />
              </div>
              {search || status !== "all" || lifeType || assetClass || branch || dateFrom || dateTo ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setStatus("all");
                    setLifeType("");
                    setAssetClass("");
                    setBranch("");
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  پاک کردن فیلترها
                </button>
              ) : null}
            </div>
          </div>
        </header>

        <div className="p-4 sm:p-5">
          {assets === null ? (
            <LoadingSkeleton rows={6} />
          ) : assets.length === 0 ? (
            <EmptyState title="دارایی نامشهودی ثبت نشده است">
              نرم‌افزار، مجوز، اختراع، علامت تجاری یا هزینهٔ توسعهٔ واجد شرایط را با سیاست سرمایه‌ای‌سازی مشخص ثبت کنید.
            </EmptyState>
          ) : (
            <>
              <DataTable caption="دفتر دارایی‌های نامشهود">
                <DataTableHead>
                  <Th>کد</Th>
                  <Th>نام دارایی</Th>
                  <Th>طبقه</Th>
                  <Th>وضعیت</Th>
                  <Th numeric>بهای تمام‌شده</Th>
                  <Th numeric>استهلاک انباشته</Th>
                  <Th numeric>کاهش ارزش</Th>
                  <Th numeric>ارزش دفتری</Th>
                  <Th numeric>عمر باقی‌مانده</Th>
                  <Th>شعبه</Th>
                  <Th>آخرین ثبت</Th>
                </DataTableHead>
                <DataTableBody>
                  {visible.map((asset) => {
                    const view = statusView(asset);
                    return (
                      <DataTableRow
                        key={asset.id}
                        onClick={() => setOpenAssetId(asset.id)}
                        aria-label={`جزئیات ${asset.name}`}
                      >
                        <Td nowrap>
                          <span dir="ltr" className="tabular-nums text-muted-foreground">
                            {asset.code}
                          </span>
                        </Td>
                        <Td>
                          <span className="font-medium text-foreground">{asset.name}</span>
                        </Td>
                        <Td muted>{INTANGIBLE_ASSET_CLASS_LABELS[asset.assetClass]}</Td>
                        <Td>
                          <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
                        </Td>
                        <Td numeric>{money.format(asset.cost)}</Td>
                        <Td numeric>{money.format(asset.accumulatedAmortization)}</Td>
                        <Td numeric>{money.format(asset.accumulatedImpairment)}</Td>
                        <Td numeric>{money.format(asset.carryingAmount)}</Td>
                        <Td numeric>
                          {asset.usefulLifeType === "indefinite"
                            ? "نامحدود"
                            : asset.remainingLifeMonths === null
                              ? "—"
                              : `${toPersianDigits(asset.remainingLifeMonths)} ماه`}
                        </Td>
                        <Td muted>{asset.locationName ?? "—"}</Td>
                        <Td nowrap muted>
                          {asset.lastPostingDate ? jalaliOrDash(asset.lastPostingDate) : "بدون ثبت"}
                        </Td>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  نمایش {toPersianDigits(visible.length)} از {toPersianDigits(assets.length)} دارایی
                </span>
                <div className="flex items-center gap-2">
                  <SecondaryButton disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    صفحهٔ قبل
                  </SecondaryButton>
                  <span>
                    {toPersianDigits(page)} / {toPersianDigits(pageCount)}
                  </span>
                  <SecondaryButton disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                    صفحهٔ بعد
                  </SecondaryButton>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {openAssetId ? (
        <AssetDetailDialog
          assetId={openAssetId}
          canManage={!readOnly}
          busy={busy}
          onClose={() => setOpenAssetId(null)}
          onOpenJournal={(entryId, title) => setJournalPeek({ entryId, title })}
          onAction={(kind, asset) => setAction({ kind, asset })}
        />
      ) : null}

      {registerOpen ? (
        <RegisterDialog
          accounts={accounts}
          busy={busy}
          onClose={() => setRegisterOpen(false)}
          onSuccess={(message) => {
            setRegisterOpen(false);
            afterMutation(message);
          }}
        />
      ) : null}

      {action?.kind === "amortize" ? (
        <AmortizeDialog
          asset={action.asset}
          busy={busy}
          onClose={() => setAction(null)}
          onSuccess={() => afterMutation("استهلاک ماه ثبت و سند آن صادر شد.")}
        />
      ) : null}

      {action?.kind === "impair" ? (
        <ImpairDialog
          asset={action.asset}
          busy={busy}
          onClose={() => setAction(null)}
          onSuccess={() => afterMutation("کاهش ارزش ثبت و سند آن صادر شد.")}
        />
      ) : null}

      {action?.kind === "dispose" ? (
        <DisposeDialog
          asset={action.asset}
          accounts={accounts}
          busy={busy}
          onClose={() => setAction(null)}
          onSuccess={() => afterMutation("واگذاری دارایی نامشهود ثبت شد.")}
        />
      ) : null}

      {action?.kind === "estimate" ? (
        <EstimateDialog
          asset={action.asset}
          busy={busy}
          onClose={() => setAction(null)}
          onSuccess={() => afterMutation("تغییر برآورد ثبت شد؛ فقط دوره‌های آیندهٔ ثبت‌نشده تغییر می‌کند.")}
        />
      ) : null}

      {journalPeek ? (
        <JournalPeekDialog
          entryId={journalPeek.entryId}
          title={journalPeek.title}
          onClose={() => setJournalPeek(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The six accounting reports, each downloadable as CSV or PDF over the same
 * filtered population. The workbook link writes every sheet at once; the
 * per-report links exist because an accountant often needs one file to attach
 * to a review, not a whole workbook to split apart again.
 */
const REPORT_LINKS = [
  { key: "register", label: "دفتر دارایی‌های نامشهود" },
  { key: "schedule", label: "برنامهٔ استهلاک دوره‌ای" },
  { key: "history", label: "سابقهٔ استهلاک ثبت‌شده" },
  { key: "impairment", label: "کاهش ارزش و برگشت" },
  { key: "disposal", label: "واگذاری دارایی‌ها" },
  { key: "estimate", label: "تغییر برآوردها" },
  { key: "reconciliation", label: "تطبیق با دفتر کل" },
] as const;

function ReportsStrip({ exportHref }: { exportHref: (format: "xlsx" | "csv" | "pdf", report: string) => string }) {
  return (
    <section className={cardClass} aria-labelledby="intangible-reports-heading">
      <header className="border-b border-border/80 px-4 py-3 sm:px-5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">گزارش‌ها و خروجی</p>
        <h2 id="intangible-reports-heading" className="mt-1 text-sm font-semibold text-foreground">
          گزارش‌های دفتر دارایی‌های نامشهود
        </h2>
      </header>
      <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3 sm:p-5">
        {REPORT_LINKS.map((report) => (
          <div
            key={report.key}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2"
          >
            <span className="text-xs font-medium text-foreground">{report.label}</span>
            <span className="flex items-center gap-2 text-xs">
              <a
                href={exportHref("csv", report.key)}
                className="rounded-lg border border-border px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                CSV
              </a>
              <a
                href={exportHref("pdf", report.key)}
                className="rounded-lg border border-border px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                PDF
              </a>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReconciliationNotice({
  reconciliation,
  money,
}: {
  reconciliation: ReconciliationView | null;
  money: ReturnType<typeof useMoney>;
}) {
  if (!reconciliation) return null;
  if (reconciliation.status === "reconciled") {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
        <p>
          دفتر دارایی‌های نامشهود با دفتر کل مطابق است
          {reconciliation.unmappedCount > 0
            ? ` — ${toPersianDigits(reconciliation.unmappedCount)} دارایی بدون نگاشت کامل حساب است.`
            : "."}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm dark:bg-amber-500/10">
      <p className="font-semibold text-foreground">اختلاف تطبیق با دفتر کل</p>
      <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
        <li>
          بهای تمام‌شده: دفتر {money.formatText(reconciliation.registerCost)} — کل{" "}
          {money.formatText(reconciliation.ledgerCost)} — اختلاف {money.formatText(reconciliation.costDifference)}
        </li>
        <li>
          استهلاک انباشته: اختلاف {money.formatText(reconciliation.amortizationDifference)}
        </li>
        <li>کاهش ارزش انباشته: اختلاف {money.formatText(reconciliation.impairmentDifference)}</li>
        {reconciliation.unmappedCount > 0 ? (
          <li>{toPersianDigits(reconciliation.unmappedCount)} دارایی نگاشت حساب کامل ندارد.</li>
        ) : null}
      </ul>
    </div>
  );
}

function AssetDetailDialog({
  assetId,
  canManage,
  busy,
  onClose,
  onOpenJournal,
  onAction,
}: {
  assetId: string;
  canManage: boolean;
  busy: boolean;
  onClose: () => void;
  onOpenJournal: (entryId: string, title: string) => void;
  onAction: (kind: "amortize" | "impair" | "dispose" | "estimate", asset: IntangibleRow) => void;
}) {
  const money = useMoney();
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("general");
  const [reloadKey, setReloadKey] = useState(0);
  const [reverseTarget, setReverseTarget] = useState<
    | { kind: "amortization"; entryId: string; label: string }
    | { kind: "impairment"; entryId: string; label: string; outstanding: number }
    | null
  >(null);

  useEffect(() => {
    let active = true;
    api<AssetDetail>(`/api/ledger/intangible-assets/${assetId}`)
      .then(({ ok, data }) => {
        if (!active) return;
        if (ok) setDetail(data);
        else setError("بارگذاری جزئیات دارایی ناموفق بود.");
      })
      .catch(() => active && setError("ارتباط با سرور برقرار نشد."));
    return () => {
      active = false;
    };
  }, [assetId, reloadKey]);

  const asset = detail?.asset;
  const view = asset ? statusView(asset) : null;

  return (
    <OverlayDialog
      headingId="intangible-detail-heading"
      onClose={onClose}
      dismissible={!busy}
      className={`${overlayPanelClass} max-h-[92vh] w-full max-w-4xl overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پروندهٔ دارایی نامشهود</p>
          <h3 id="intangible-detail-heading" className="mt-1 truncate text-lg font-bold text-foreground">
            {asset ? `${asset.name} — ${asset.code}` : "در حال بارگذاری…"}
          </h3>
          {view ? <div className="mt-2"><StatusBadge tone={view.tone}>{view.label}</StatusBadge></div> : null}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>

      <ErrorBox>{error}</ErrorBox>

      {!detail ? (
        <LoadingSkeleton rows={5} />
      ) : (
        <div className="space-y-4">
          {canManage && detail.asset.status === "active" ? (
            <div className="flex flex-wrap gap-2">
              {detail.asset.usefulLifeType === "finite" ? (
                <SecondaryButton onClick={() => onAction("amortize", detail.asset)} disabled={busy}>
                  <CalculatorIcon className="size-4" />
                  ثبت استهلاک ماه
                </SecondaryButton>
              ) : null}
              <SecondaryButton onClick={() => onAction("impair", detail.asset)} disabled={busy}>
                <TrendingDownIcon className="size-4" />
                کاهش ارزش
              </SecondaryButton>
              <SecondaryButton onClick={() => onAction("estimate", detail.asset)} disabled={busy}>
                <HistoryIcon className="size-4" />
                تغییر برآورد
              </SecondaryButton>
              <SecondaryButton onClick={() => onAction("dispose", detail.asset)} disabled={busy}>
                <Undo2Icon className="size-4" />
                واگذاری
              </SecondaryButton>
            </div>
          ) : null}

          <div role="tablist" aria-label="بخش‌های پروندهٔ دارایی" className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/60 p-1">
            {TABS.map((candidate) => (
              <button
                key={candidate.key}
                role="tab"
                type="button"
                aria-selected={tab === candidate.key}
                onClick={() => setTab(candidate.key)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  tab === candidate.key
                    ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {candidate.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="rounded-xl border border-border p-4">
            {tab === "general" ? (
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <Row label="کد دارایی" value={<span dir="ltr">{detail.asset.code}</span>} />
                <Row label="طبقه" value={INTANGIBLE_ASSET_CLASS_LABELS[detail.asset.assetClass]} />
                <Row label="تاریخ تحصیل" value={jalaliOrDash(detail.asset.acquisitionDate)} />
                <Row label="آمادهٔ بهره‌برداری" value={jalaliOrDash(detail.asset.availableForUseDate)} />
                <Row label="منبع تحصیل" value={detail.asset.acquisitionSource} />
                <Row label="شعبه" value={detail.asset.locationName ?? "—"} />
                <Row label="متصدی" value={detail.asset.custodianName ?? "—"} />
                <Row label="عمر مفید" value={USEFUL_LIFE_TYPE_LABELS[detail.asset.usefulLifeType]} />
                <Row
                  label="مدت عمر (ماه)"
                  value={
                    detail.asset.usefulLifeType === "indefinite"
                      ? "نامحدود"
                      : `${toPersianDigits(detail.asset.usefulLifeMonths ?? 0)} ماه`
                  }
                />
                <Row label="عمر باقی‌مانده" value={detail.asset.remainingLifeMonths === null ? "نامحدود" : `${toPersianDigits(detail.asset.remainingLifeMonths)} ماه`} />
                <Row label="شرح" value={detail.asset.description ?? "—"} span />
                <Row label="یادداشت" value={detail.asset.notes ?? "—"} span />
              </dl>
            ) : null}

            {tab === "policy" ? (
              <div className="space-y-4">
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <Row label="بهای سرمایه‌ای‌شده" value={money.format(detail.asset.cost)} />
                  <Row label="هزینهٔ مستقیم قابل انتساب" value={money.format(detail.asset.directlyAttributableCost)} />
                  <Row label="ارزش باقی‌مانده" value={money.format(detail.asset.residualValue)} />
                  <Row label="مبنای استهلاک" value={money.format(detail.asset.amortizableBase)} />
                  <Row label="ارزش دفتری جاری" value={money.format(detail.asset.carryingAmount)} />
                  <Row label="مرجع مستندات" value={detail.asset.evidenceReference ?? "—"} />
                </dl>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">یادداشت سیاست سرمایه‌ای‌سازی</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                    {detail.asset.capitalizationPolicyNote ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">حساب‌های منتخب حسابدار</p>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    <li>حساب دارایی: {detail.asset.assetAccountId ? "نگاشت‌شده" : "نگاشت‌نشده"}</li>
                    <li>استهلاک انباشته: {detail.asset.accumulatedAmortizationAccountId ? "نگاشت‌شده" : "نگاشت‌نشده"}</li>
                    <li>هزینهٔ استهلاک: {detail.asset.amortizationExpenseAccountId ? "نگاشت‌شده" : "نگاشت‌نشده"}</li>
                    <li>زیان کاهش ارزش: {detail.asset.impairmentLossAccountId ? "نگاشت‌شده" : "نگاشت‌نشده"}</li>
                    <li>کاهش ارزش انباشته: {detail.asset.accumulatedImpairmentAccountId ? "نگاشت‌شده" : "نگاشت‌نشده"}</li>
                  </ul>
                </div>
              </div>
            ) : null}

            {tab === "schedule" ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <MiniStat label="استهلاک ثبت‌شده" value={money.format(detail.totals.postedAmortization)} />
                  <MiniStat label="استهلاک پیش‌بینی‌شده" value={money.format(detail.totals.forecastAmortization)} />
                  <MiniStat label="ارزش دفتری پایان برنامه" value={money.format(detail.totals.closingCarrying)} />
                </div>
                {detail.schedule.length === 0 ? (
                  <EmptyState title="برنامهٔ استهلاک وجود ندارد">
                    دارایی با عمر نامحدود استهلاک نمی‌شود و از طریق کاهش ارزش بازبینی می‌شود.
                  </EmptyState>
                ) : (
                  <DataTable caption="برنامهٔ استهلاک">
                    <DataTableHead>
                      <Th>دوره</Th>
                      <Th>وضعیت</Th>
                      <Th numeric>ارزش دفتری ابتدا</Th>
                      <Th numeric>استهلاک</Th>
                      <Th numeric>ارزش دفتری پایان</Th>
                      <Th>سند</Th>
                    </DataTableHead>
                    <DataTableBody>
                      {detail.schedule.map((row) => (
                        <DataTableRow key={row.periodKey}>
                          <Td nowrap>{row.label}</Td>
                          <Td>
                            <StatusBadge tone={row.status === "posted" ? "positive" : "neutral"}>
                              {row.status === "posted" ? "ثبت‌شده" : "پیش‌بینی"}
                            </StatusBadge>
                          </Td>
                          <Td numeric>{money.format(row.openingCarrying)}</Td>
                          <Td numeric>{money.format(row.amortization)}</Td>
                          <Td numeric>{money.format(row.closingCarrying)}</Td>
                          <Td>
                            {row.journalEntryId ? (
                              <button
                                type="button"
                                onClick={() => onOpenJournal(row.journalEntryId!, `استهلاک ${row.label}`)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                              >
                                <BookOpenTextIcon className="size-3.5" />
                                مشاهدهٔ سند
                              </button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </Td>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                )}
              </div>
            ) : null}

            {tab === "postings" ? (
              detail.entries.length === 0 ? (
                <EmptyState title="سند استهلاکی ثبت نشده است">
                  برای این دارایی هنوز ماهی استهلاک نشده است.
                </EmptyState>
              ) : (
                <DataTable caption="اسناد استهلاک ثبت‌شده">
                  <DataTableHead>
                    <Th>دوره</Th>
                    <Th>تاریخ سند</Th>
                    <Th numeric>مبلغ</Th>
                    <Th>وضعیت</Th>
                    <Th>سند</Th>
                  </DataTableHead>
                  <DataTableBody>
                    {detail.entries.map((entry) => (
                      <DataTableRow key={entry.id}>
                        <Td nowrap>{entry.periodLabel}</Td>
                        <Td nowrap>{jalaliOrDash(entry.entryDate)}</Td>
                        <Td numeric>{money.format(entry.amount)}</Td>
                        <Td>
                          <StatusBadge tone={entry.reversedAt ? "neutral" : "positive"}>
                            {entry.reversedAt ? "برگشت‌خورده" : "ثبت‌شده"}
                          </StatusBadge>
                        </Td>
                                                  <Td>
                            <span className="flex flex-wrap items-center gap-2">
                              {entry.journalEntryId ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenJournal(entry.journalEntryId!, `استهلاک ${entry.periodLabel}`)}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                                >
                                  <BookOpenTextIcon className="size-3.5" />
                                  سند
                                </button>
                              ) : null}
                              {canManage && !entry.reversedAt ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setReverseTarget({
                                      kind: "amortization",
                                      entryId: entry.id,
                                      label: `استهلاک ${entry.periodLabel}`,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                                >
                                  <Undo2Icon className="size-3.5" />
                                  برگشت
                                </button>
                              ) : null}
                            </span>
                          </Td>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
              )
            ) : null}

            {tab === "estimates" ? (
              detail.estimateChanges.length === 0 ? (
                <EmptyState title="تغییر برآوردی ثبت نشده است">
                  تغییر عمر مفید یا ارزش باقی‌مانده به‌صورت آینده‌نگر و با تاریخ اجرا ثبت می‌شود؛ دوره‌های ثبت‌شده تغییر
                  نمی‌کنند.
                </EmptyState>
              ) : (
                <div className="space-y-3">
                  {detail.estimateChanges.map((change) => (
                    <article key={change.id} className="rounded-xl border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">
                          اجرا از {change.effectivePeriodKey ? periodLabelOf(change.effectivePeriodKey) : jalaliOrDash(change.effectiveDate)}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          ثبت: {change.changedByName ?? "—"}
                          {change.approvedByName && change.approvedByName !== change.changedByName
                            ? ` / تأیید: ${change.approvedByName}`
                            : ""}
                        </span>
                      </div>
                      <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-4">
                        <div>
                          <dt className="text-muted-foreground">عمر پیشین → جدید</dt>
                          <dd className="mt-0.5 text-foreground">
                            {change.previousUsefulLifeType === "finite"
                              ? `${toPersianDigits(change.previousUsefulLifeMonths ?? 0)} ماه`
                              : "نامحدود"}{" "}
                            →{" "}
                            {change.newUsefulLifeType === "finite"
                              ? `${toPersianDigits(change.newUsefulLifeMonths ?? 0)} ماه`
                              : "نامحدود"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">ارزش باقی‌مانده پیشین → جدید</dt>
                          <dd className="mt-0.5 text-foreground">
                            {money.format(change.previousResidualValue)} → {money.format(change.newResidualValue)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">مبنای استهلاک باقی‌مانده</dt>
                          <dd className="mt-0.5 text-foreground">{money.format(change.remainingBase)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">وضعیت در زمان تغییر</dt>
                          <dd className="mt-0.5 text-foreground">
                            {toPersianDigits(change.periodsPostedAtChange)} دوره ثبت‌شده
                          </dd>
                        </div>
                      </dl>
                      <p className="mt-2 text-xs text-muted-foreground">دلیل: {change.reason}</p>
                      {change.evidenceReference ? (
                        <p className="mt-1 text-xs text-muted-foreground">مستندات: {change.evidenceReference}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              )
            ) : null}

            {tab === "impairment" ? (
              detail.impairments.length === 0 ? (
                <EmptyState title="کاهش ارزشی ثبت نشده است">
                  ارزیابی کاهش ارزش با مبلغ بازیافتنی و مستندات آن در همین بخش ثبت می‌شود.
                </EmptyState>
              ) : (
                <DataTable caption="سابقهٔ کاهش ارزش و برگشت">
                  <DataTableHead>
                    <Th>تاریخ ارزیابی</Th>
                    <Th>تاریخ اجرا</Th>
                    <Th numeric>مبلغ بازیافتنی</Th>
                    <Th numeric>ارزش دفتری پیش از ثبت</Th>
                    <Th numeric>مبلغ کاهش ارزش</Th>
                    <Th>نوع</Th>
                    <Th>سند</Th>
                  </DataTableHead>
                  <DataTableBody>
                    {detail.impairments.map((entry) => (
                      <DataTableRow key={entry.id}>
                        <Td nowrap>{jalaliOrDash(entry.assessmentDate)}</Td>
                        <Td nowrap>{jalaliOrDash(entry.effectiveDate)}</Td>
                        <Td numeric>{money.format(entry.recoverableAmount)}</Td>
                        <Td numeric>{money.format(entry.carryingAmountBefore)}</Td>
                        <Td numeric>{money.format(entry.impairmentAmount)}</Td>
                        <Td>
                          <StatusBadge tone={entry.reversalOf ? "neutral" : entry.reversedAt ? "neutral" : "active"}>
                            {entry.reversalOf ? "برگشت کاهش ارزش" : entry.reversedAt ? "برگشت‌خورده" : "ثبت‌شده"}
                          </StatusBadge>
                        </Td>
                                                    <Td>
                              <span className="flex flex-wrap items-center gap-2">
                                {entry.journalEntryId ? (
                                  <button
                                    type="button"
                                    onClick={() => onOpenJournal(entry.journalEntryId!, "کاهش ارزش دارایی نامشهود")}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                                  >
                                    <BookOpenTextIcon className="size-3.5" />
                                    سند
                                  </button>
                                ) : null}
                                {canManage && !entry.reversedAt && !entry.reversalOf ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setReverseTarget({
                                        kind: "impairment",
                                        entryId: entry.id,
                                        label: `کاهش ارزش ${jalaliOrDash(entry.effectiveDate)}`,
                                        outstanding: entry.impairmentAmount,
                                      })
                                    }
                                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                                  >
                                    <Undo2Icon className="size-3.5" />
                                    برگشت
                                  </button>
                                ) : null}
                              </span>
                            </Td>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              )
            ) : null}

            {tab === "disposal" ? (
              detail.asset.status !== "disposed" ? (
                <InfoBox>این دارایی هنوز واگذار نشده است. واگذاری، کنارگذاری یا حذف از همین پرونده ثبت می‌شود.</InfoBox>
              ) : (
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <Row label="نوع واگذاری" value={DISPOSAL_KIND_LABELS[detail.asset.disposalKind ?? "sale"]} />
                  <Row label="تاریخ واگذاری" value={jalaliOrDash(detail.asset.disposalDate)} />
                  <Row label="مبلغ وصولی" value={money.format(detail.asset.disposalProceeds ?? 0)} />
                  <Row label="ارزش دفتری در واگذاری" value={money.format(detail.asset.carryingAmount)} />
                  <Row label="دلیل" value={detail.asset.disposalReason ?? "—"} span />
                </dl>
              )
            ) : null}

            {tab === "audit" ? (
              <div className="space-y-3 text-sm">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <Row label="تاریخ ثبت پرونده" value={jalaliOrDash(detail.asset.createdAt)} />
                  <Row label="آخرین ثبت استهلاک" value={jalaliOrDash(detail.asset.lastPostingDate)} />
                  <Row label="آخرین بازبینی کاهش ارزش" value={jalaliOrDash(detail.asset.lastReviewDate)} />
                  <Row label="دوره‌های ثبت‌شده" value={toPersianDigits(detail.asset.periodsPosted)} />
                  <Row label="استهلاک انباشته" value={money.format(detail.asset.accumulatedAmortization)} />
                  <Row label="کاهش ارزش انباشته" value={money.format(detail.asset.accumulatedImpairment)} />
                </dl>
                <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  مانده‌های این پرونده از تاریخ زندهٔ اسناد ساخته می‌شوند؛ سند برگشت‌خورده در محاسبه نمی‌آید. تطبیق کامل با
                  حساب‌های کنترل در گزارش «تطبیق با دفتر کل» و در پیام بالای دفتر نمایش داده می‌شود.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {reverseTarget ? (
        <ReverseDialog
          assetId={assetId}
          target={reverseTarget}
          busy={busy}
          onClose={() => setReverseTarget(null)}
          onSuccess={() => {
            setReverseTarget(null);
            setReloadKey((key) => key + 1);
          }}
        />
      ) : null}
    </OverlayDialog>
  );
}

/**
 * Reversing a posted document — never deleting it. The correction is its own
 * approved document that mirrors the original, so the history reads as the
 * sequence of decisions that was actually made.
 */
function ReverseDialog({
  assetId,
  target,
  busy,
  onClose,
  onSuccess,
}: {
  assetId: string;
  target:
    | { kind: "amortization"; entryId: string; label: string }
    | { kind: "impairment"; entryId: string; label: string; outstanding: number };
  busy: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const money = useMoney();
  const [reversalDate, setReversalDate] = useState("");
  const [reason, setReason] = useState("");
  // Empty = reverse the whole outstanding impairment, which is the common case.
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!reason.trim()) return setError("ذکر دلیل برگشت الزامی است.");
    let parsedAmount: number | null = null;
    if (target.kind === "impairment" && amount.trim()) {
      try {
        parsedAmount = money.parse(amount);
      } catch {
        return setError("مبلغ برگشت باید عدد صحیح معتبر در واحد نمایش کسب‌وکار باشد.");
      }
      if (parsedAmount <= 0) return setError("مبلغ برگشت باید بزرگ‌تر از صفر باشد.");
    }
    setSubmitting(true);
    const endpoint = target.kind === "amortization" ? "amortize" : "impair";
    const body =
      target.kind === "amortization"
        ? { action: "reverse", amortizationEntryId: target.entryId, reversalDate: reversalDate || null, reason }
        : {
            action: "reverse",
            impairmentId: target.entryId,
            amount: parsedAmount,
            reversalDate: reversalDate || null,
            reason,
          };
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/intangible-assets/${assetId}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    setSubmitting(false);
    if (!ok) return setError(resolveErrorMessage((data as { error?: string }).error));
    onSuccess();
  }

  return (
    <OverlayDialog
      headingId="intangible-reverse-heading"
      onClose={onClose}
      dismissible={!disabled}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">برگشت سند</p>
          <h3 id="intangible-reverse-heading" className="mt-1 text-lg font-bold text-foreground">
            برگشت {target.label}
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>
      <ErrorBox>{error}</ErrorBox>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        سند اصلی حذف یا ویرایش نمی‌شود؛ یک سند برگشت معادل ثبت می‌شود و تاریخچه هر دو را نگه می‌دارد.
        {target.kind === "impairment" ? ` مبلغ قابل برگشت: ${money.format(target.outstanding)}.` : ""}
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="تاریخ برگشت">
          <JalaliDatePicker value={reversalDate} onChange={setReversalDate} disabled={disabled} />
        </Field>
        {target.kind === "impairment" ? (
          <Field label={`مبلغ برگشت (${money.unitLabel})`} hint="خالی = برگشت کامل">
            <PersianNumberInput className={inputClass} dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled} />
          </Field>
        ) : null}
        <Field label="دلیل برگشت" hint="الزامی">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={INTANGIBLE_REASON_MAX_LENGTH} disabled={disabled} />
        </Field>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton type="button" onClick={onClose} disabled={disabled}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={disabled || !reason.trim()}>{submitting ? "در حال ثبت…" : "ثبت برگشت"}</PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

function Row({ label, value, span = false }: { label: string; value: React.ReactNode; span?: boolean }) {
  return (
    <div className={span ? "sm:col-span-2" : undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function RegisterDialog({
  accounts,
  busy,
  onClose,
  onSuccess,
}: {
  accounts: AccountRow[];
  busy: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const money = useMoney();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [assetClass, setAssetClass] = useState<IntangibleAssetClass>("software");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [availableDate, setAvailableDate] = useState("");
  const [cost, setCost] = useState("");
  const [directCost, setDirectCost] = useState("");
  const [lifeType, setLifeType] = useState<UsefulLifeType>("finite");
  const [months, setMonths] = useState("");
  const [residual, setResidual] = useState("");
  const [assetAccountId, setAssetAccountId] = useState("");
  const [accumulatedAccountId, setAccumulatedAccountId] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [impairmentLossAccountId, setImpairmentLossAccountId] = useState("");
  const [accumulatedImpairmentAccountId, setAccumulatedImpairmentAccountId] = useState("");
  const [settlementAccountId, setSettlementAccountId] = useState("");
  const [policyNote, setPolicyNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const assetAccounts = accounts.filter((a) => a.type === "asset");
  const expenseAccounts = accounts.filter((a) => a.type === "expense");
  const settlementAccounts = settlementAccountOptions(accounts, ASSET_ACQUISITION_SOURCE_ROLES);
  const disabled = busy || submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let parsedCost = 0;
    let parsedDirect = 0;
    let parsedResidual = 0;
    try {
      parsedCost = money.parse(cost);
      parsedDirect = directCost.trim() ? money.parse(directCost) : 0;
      parsedResidual = residual.trim() ? money.parse(residual) : 0;
    } catch {
      return setError("مبلغ‌ها باید عدد صحیح معتبر در واحد نمایش کسب‌وکار باشند.");
    }
    if (!policyNote.trim()) return setError("یادداشت سیاست سرمایه‌ای‌سازی الزامی است.");
    if (!assetAccountId) return setError("حساب دارایی نامشهود را انتخاب کنید.");
    if (lifeType === "finite" && (!accumulatedAccountId || !expenseAccountId)) {
      return setError("برای دارایی با عمر محدود، حساب استهلاک انباشته و هزینهٔ استهلاک الزامی است.");
    }
    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>("/api/ledger/intangible-assets", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        name,
        code: code.trim() || null,
        assetClass,
        acquisitionDate,
        availableForUseDate: availableDate || null,
        cost: parsedCost,
        directlyAttributableCost: parsedDirect,
        usefulLifeType: lifeType,
        usefulLifeMonths: lifeType === "finite" ? Number(months) : null,
        residualValue: parsedResidual,
        assetAccountId,
        accumulatedAmortizationAccountId: accumulatedAccountId || null,
        amortizationExpenseAccountId: expenseAccountId || null,
        impairmentLossAccountId: impairmentLossAccountId || null,
        accumulatedImpairmentAccountId: accumulatedImpairmentAccountId || null,
        capitalizationPolicyNote: policyNote,
        evidenceReference: evidence.trim() || null,
        notes: notes.trim() || null,
        acquisitionAccountId: settlementAccountId || null,
      }),
    });
    setSubmitting(false);
    if (!ok) return setError(resolveErrorMessage((data as { error?: string }).error));
    onSuccess("دارایی نامشهود ثبت شد.");
  }

  return (
    <OverlayDialog
      headingId="intangible-register-heading"
      onClose={onClose}
      dismissible={!disabled}
      className={`${overlayPanelClass} max-h-[92vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سرمایه‌ای‌سازی دارایی نامشهود</p>
          <h3 id="intangible-register-heading" className="mt-1 text-lg font-bold text-foreground">
            ثبت دارایی نامشهود
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>

      <ErrorBox>{error}</ErrorBox>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        سرمایه‌ای‌سازی یک تصمیم صریح و مستند است: یادداشت سیاست و تأییدکننده ثبت می‌شوند. اشتراک یا هزینهٔ جاری
        صرفاً به این دلیل که در فاکتور آمده، دارایی نیست.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام دارایی">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} disabled={disabled} />
          </Field>
          <Field label="کد دارایی" hint="خالی بگذارید تا خودکار (IA-0001) ساخته شود">
            <input className={inputClass} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} disabled={disabled} />
          </Field>
          <Field label="طبقه">
            <select className={inputClass} value={assetClass} onChange={(e) => setAssetClass(e.target.value as IntangibleAssetClass)} disabled={disabled}>
              {INTANGIBLE_ASSET_CLASSES.map((key) => (
                <option key={key} value={key}>
                  {INTANGIBLE_ASSET_CLASS_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="تاریخ تحصیل">
            <JalaliDatePicker value={acquisitionDate} onChange={setAcquisitionDate} placeholder="انتخاب تاریخ تحصیل" disabled={disabled} />
          </Field>
          <Field label="تاریخ آمادهٔ بهره‌برداری" hint="استهلاک از این ماه شروع می‌شود؛ خالی = تاریخ تحصیل">
            <JalaliDatePicker value={availableDate} onChange={setAvailableDate} placeholder="همان تاریخ تحصیل" disabled={disabled} />
          </Field>
          <Field label={`بهای تمام‌شده (${money.unitLabel})`}>
            <PersianNumberInput className={inputClass} dir="ltr" value={cost} onChange={(e) => setCost(e.target.value)} disabled={disabled} />
          </Field>
          <Field label={`هزینهٔ مستقیم قابل انتساب (${money.unitLabel})`} hint="کارمزد ثبت، آزمون و آماده‌سازی">
            <PersianNumberInput className={inputClass} dir="ltr" value={directCost} onChange={(e) => setDirectCost(e.target.value)} disabled={disabled} />
          </Field>
          <Field label="نوع عمر مفید">
            <select className={inputClass} value={lifeType} onChange={(e) => setLifeType(e.target.value as UsefulLifeType)} disabled={disabled}>
              {USEFUL_LIFE_TYPES.map((key) => (
                <option key={key} value={key}>
                  {USEFUL_LIFE_TYPE_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          {lifeType === "finite" ? (
            <Field label="عمر مفید (ماه)">
              <PersianNumberInput className={inputClass} dir="ltr" value={months} onChange={(e) => setMonths(e.target.value)} disabled={disabled} />
            </Field>
          ) : null}
          <Field label={`ارزش باقی‌مانده (${money.unitLabel})`}>
            <PersianNumberInput className={inputClass} dir="ltr" value={residual} onChange={(e) => setResidual(e.target.value)} disabled={disabled} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="حساب دارایی نامشهود">
            <select className={inputClass} value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)} disabled={disabled}>
              <option value="">انتخاب کنید…</option>
              {assetAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="حساب پرداخت خرید" hint="اختیاری: سند تحصیل در همان ثبت صادر می‌شود">
            <select className={inputClass} value={settlementAccountId} onChange={(e) => setSettlementAccountId(e.target.value)} disabled={disabled}>
              <option value="">بدون سند تحصیل</option>
              {settlementAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="حساب استهلاک انباشته">
            <select className={inputClass} value={accumulatedAccountId} onChange={(e) => setAccumulatedAccountId(e.target.value)} disabled={disabled}>
              <option value="">انتخاب کنید…</option>
              {assetAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="حساب هزینهٔ استهلاک">
            <select className={inputClass} value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)} disabled={disabled}>
              <option value="">انتخاب کنید…</option>
              {expenseAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="حساب زیان کاهش ارزش" hint="برای ارزیابی کاهش ارزش">
            <select className={inputClass} value={impairmentLossAccountId} onChange={(e) => setImpairmentLossAccountId(e.target.value)} disabled={disabled}>
              <option value="">اختیاری</option>
              {expenseAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="حساب کاهش ارزش انباشته">
            <select className={inputClass} value={accumulatedImpairmentAccountId} onChange={(e) => setAccumulatedImpairmentAccountId(e.target.value)} disabled={disabled}>
              <option value="">اختیاری</option>
              {assetAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="یادداشت سیاست سرمایه‌ای‌سازی" hint="مبنای شناسایی دارایی — الزامی">
          <textarea
            className={inputClass}
            rows={2}
            value={policyNote}
            onChange={(e) => setPolicyNote(e.target.value)}
            maxLength={INTANGIBLE_POLICY_NOTE_MAX_LENGTH}
            disabled={disabled}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="مرجع مستندات">
            <input className={inputClass} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={INTANGIBLE_EVIDENCE_MAX_LENGTH} disabled={disabled} />
          </Field>
          <Field label="یادداشت">
            <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={INTANGIBLE_POLICY_NOTE_MAX_LENGTH} disabled={disabled} />
          </Field>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton type="button" onClick={onClose} disabled={disabled}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={disabled || !name.trim()}>{submitting ? "در حال ثبت…" : "ثبت دارایی"}</PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

function AmortizeDialog({
  asset,
  busy,
  onClose,
  onSuccess,
}: {
  asset: IntangibleRow;
  busy: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const money = useMoney();
  const [entryDate, setEntryDate] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const { ok, data } = await api<{ amount?: number; error?: string }>(
      `/api/ledger/intangible-assets/${asset.id}/amortize`,
      { method: "POST", body: JSON.stringify({ entryDate, periodLabel: label.trim() || null }) },
    );
    setSubmitting(false);
    if (!ok) return setError(resolveErrorMessage((data as { error?: string }).error));
    onSuccess();
  }

  return (
    <OverlayDialog
      headingId="intangible-amortize-heading"
      onClose={onClose}
      dismissible={!disabled}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت استهلاک</p>
          <h3 id="intangible-amortize-heading" className="mt-1 text-lg font-bold text-foreground">
            استهلاک ماه — {asset.name}
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>
      <ErrorBox>{error}</ErrorBox>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        مبلغ این ماه با همان برنامهٔ تأییدشدهٔ استهلاک محاسبه و در همان تراکنش سند زده می‌شود؛ ماهی که قبلاً ثبت شده
        دوباره ثبت نمی‌شود. ارزش دفتری جاری: <strong>{money.format(asset.carryingAmount)}</strong>
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="تاریخ سند" hint="باید داخل همان ماه باشد">
          <JalaliDatePicker value={entryDate} onChange={setEntryDate} disabled={disabled} />
        </Field>
        <Field label="عنوان دوره" hint="اختیاری؛ پیش‌فرض نام ماه شمسی است">
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} disabled={disabled} />
        </Field>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton type="button" onClick={onClose} disabled={disabled}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={disabled || !entryDate}>ثبت استهلاک</PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

function ImpairDialog({
  asset,
  busy,
  onClose,
  onSuccess,
}: {
  asset: IntangibleRow;
  busy: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const money = useMoney();
  const [assessmentDate, setAssessmentDate] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [recoverable, setRecoverable] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let amount = 0;
    try {
      amount = money.parse(recoverable);
    } catch {
      return setError("مبلغ بازیافتنی باید عدد صحیح معتبر باشد.");
    }
    if (!reason.trim()) return setError("دلیل ارزیابی کاهش ارزش الزامی است.");
    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/intangible-assets/${asset.id}/impair`, {
      method: "POST",
      body: JSON.stringify({
        assessmentDate: assessmentDate || null,
        effectiveDate,
        recoverableAmount: amount,
        reason,
        evidenceReference: evidence.trim() || null,
      }),
    });
    setSubmitting(false);
    if (!ok) return setError(resolveErrorMessage((data as { error?: string }).error));
    onSuccess();
  }

  return (
    <OverlayDialog
      headingId="intangible-impair-heading"
      onClose={onClose}
      dismissible={!disabled}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ارزیابی کاهش ارزش</p>
          <h3 id="intangible-impair-heading" className="mt-1 text-lg font-bold text-foreground">
            کاهش ارزش — {asset.name}
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>
      <ErrorBox>{error}</ErrorBox>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        ارزش دفتری جاری: <strong>{money.format(asset.carryingAmount)}</strong>. مبلغی که ارزش دفتری از آن بیشتر است، به‌عنوان
        زیان کاهش ارزش سند می‌خورد.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="تاریخ ارزیابی">
          <JalaliDatePicker value={assessmentDate} onChange={setAssessmentDate} disabled={disabled} />
        </Field>
        <Field label="تاریخ اجرا">
          <JalaliDatePicker value={effectiveDate} onChange={setEffectiveDate} disabled={disabled} />
        </Field>
        <Field label={`مبلغ بازیافتنی (${money.unitLabel})`}>
          <PersianNumberInput className={inputClass} dir="ltr" value={recoverable} onChange={(e) => setRecoverable(e.target.value)} disabled={disabled} />
        </Field>
        <Field label="دلیل ارزیابی" hint="الزامی">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={INTANGIBLE_REASON_MAX_LENGTH} disabled={disabled} />
        </Field>
        <Field label="مرجع مستندات">
          <input className={inputClass} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={INTANGIBLE_EVIDENCE_MAX_LENGTH} disabled={disabled} />
        </Field>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton type="button" onClick={onClose} disabled={disabled}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={disabled || !effectiveDate || !recoverable.trim() || !reason.trim()}>
            ثبت کاهش ارزش
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

function DisposeDialog({
  asset,
  accounts,
  busy,
  onClose,
  onSuccess,
}: {
  asset: IntangibleRow;
  accounts: AccountRow[];
  busy: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const money = useMoney();
  const [kind, setKind] = useState<DisposalKind>("sale");
  const [disposalDate, setDisposalDate] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [proceedsAccountId, setProceedsAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;
  const proceedsAccounts = settlementAccountOptions(accounts, ASSET_SALE_PROCEEDS_ROLES);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let amount: number | null = null;
    if (kind === "sale") {
      try {
        amount = money.parse(proceeds);
      } catch {
        return setError("مبلغ وصولی باید عدد صحیح معتبر باشد.");
      }
      if (!proceedsAccountId) return setError("حساب وصول مبلغ فروش را انتخاب کنید.");
    }
    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/intangible-assets/${asset.id}/dispose`, {
      method: "POST",
      body: JSON.stringify({
        kind,
        disposalDate: disposalDate || null,
        proceeds: amount,
        proceedsAccountId: kind === "sale" ? proceedsAccountId : null,
        reason: reason.trim() || null,
      }),
    });
    setSubmitting(false);
    if (!ok) return setError(resolveErrorMessage((data as { error?: string }).error));
    onSuccess();
  }

  return (
    <OverlayDialog
      headingId="intangible-dispose-heading"
      onClose={onClose}
      dismissible={!disabled}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">واگذاری دارایی</p>
          <h3 id="intangible-dispose-heading" className="mt-1 text-lg font-bold text-foreground">
            واگذاری — {asset.name}
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>
      <ErrorBox>{error}</ErrorBox>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        واگذاری، بهای تمام‌شده و انباشته‌ها را از حساب‌های کنترل خارج و سود/زیان را بر مبنای ارزش دفتری جاری
        (<strong>{money.format(asset.carryingAmount)}</strong>) شناسایی می‌کند. این عملیات بازگشت‌پذیر نیست.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="نوع واگذاری">
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as DisposalKind)} disabled={disabled}>
            {(Object.keys(DISPOSAL_KIND_LABELS) as DisposalKind[]).map((key) => (
              <option key={key} value={key}>
                {DISPOSAL_KIND_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تاریخ واگذاری">
          <JalaliDatePicker value={disposalDate} onChange={setDisposalDate} disabled={disabled} />
        </Field>
        {kind === "sale" ? (
          <>
            <Field label={`مبلغ وصولی (${money.unitLabel})`}>
              <PersianNumberInput className={inputClass} dir="ltr" value={proceeds} onChange={(e) => setProceeds(e.target.value)} disabled={disabled} />
            </Field>
            <Field label="حساب وصول مبلغ فروش">
              <select className={inputClass} value={proceedsAccountId} onChange={(e) => setProceedsAccountId(e.target.value)} disabled={disabled}>
                <option value="">انتخاب کنید…</option>
                {proceedsAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
        <Field label="دلیل">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={INTANGIBLE_REASON_MAX_LENGTH} disabled={disabled} />
        </Field>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton type="button" onClick={onClose} disabled={disabled}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={disabled || !disposalDate}>
            {submitting ? "در حال ثبت…" : "ثبت واگذاری"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}

function EstimateDialog({
  asset,
  busy,
  onClose,
  onSuccess,
}: {
  asset: IntangibleRow;
  busy: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const money = useMoney();
  const [effectiveDate, setEffectiveDate] = useState("");
  const [lifeType, setLifeType] = useState<UsefulLifeType>(asset.usefulLifeType);
  const [months, setMonths] = useState(asset.usefulLifeMonths ? String(asset.usefulLifeMonths) : "");
  const [residual, setResidual] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [preview, setPreview] = useState<{ remainingBase: number; monthlyAmount: number | null } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;

  const parsedResidual = (() => {
    if (!residual.trim()) return null;
    try {
      return money.parse(residual);
    } catch {
      return null;
    }
  })();

  // Preview the accountant's own proposal: the same arithmetic the posting
  // path will use, with nothing written.
  useEffect(() => {
    if (!effectiveDate) {
      setPreview(null);
      return;
    }
    const params = new URLSearchParams({ effectiveDate });
    if (lifeType) params.set("usefulLifeType", lifeType);
    if (lifeType === "finite" && months.trim()) params.set("usefulLifeMonths", months.trim());
    if (parsedResidual !== null) params.set("residualValue", String(parsedResidual));
    let active = true;
    api<{ remainingBase: number; monthlyAmount: number | null; error?: string }>(
      `/api/ledger/intangible-assets/${asset.id}/estimate?${params}`,
    ).then(({ ok, data }) => {
      if (!active) return;
      if (ok) {
        setPreview({ remainingBase: data.remainingBase, monthlyAmount: data.monthlyAmount });
        setPreviewError("");
      } else {
        setPreview(null);
        setPreviewError(resolveErrorMessage((data as { error?: string }).error));
      }
    });
    return () => {
      active = false;
    };
  }, [asset.id, effectiveDate, lifeType, months, parsedResidual]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!reason.trim()) return setError("ذکر دلیل تغییر برآورد الزامی است.");
    setSubmitting(true);
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/intangible-assets/${asset.id}/estimate`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        effectiveDate,
        usefulLifeType: lifeType,
        usefulLifeMonths: lifeType === "finite" ? Number(months) : null,
        residualValue: parsedResidual,
        reason,
        evidenceReference: evidence.trim() || null,
      }),
    });
    setSubmitting(false);
    if (!ok) return setError(resolveErrorMessage((data as { error?: string }).error));
    onSuccess();
  }

  return (
    <OverlayDialog
      headingId="intangible-estimate-heading"
      onClose={onClose}
      dismissible={!disabled}
      className={`${overlayPanelClass} max-h-[90vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تغییر برآورد حسابداری</p>
          <h3 id="intangible-estimate-heading" className="mt-1 text-lg font-bold text-foreground">
            تغییر آینده‌نگر — {asset.name}
          </h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
          <XIcon className="size-4" />
        </Button>
      </header>
      <ErrorBox>{error}</ErrorBox>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        این تغییر فقط دوره‌های <strong>آیندهٔ ثبت‌نشده</strong> را تغییر می‌دهد؛ {toPersianDigits(asset.periodsPosted)}{" "}
        دورهٔ ثبت‌شده و اسناد آن دست‌نخورده می‌مانند. مبنای محاسبه، ارزش دفتری جاری ({money.format(asset.carryingAmount)})
        منهای ارزش باقی‌ماندهٔ جدید است.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="تاریخ اجرا" hint="دورهٔ جاری یا بعد">
          <JalaliDatePicker value={effectiveDate} onChange={setEffectiveDate} disabled={disabled} />
        </Field>
        <Field label="نوع عمر مفید">
          <select className={inputClass} value={lifeType} onChange={(e) => setLifeType(e.target.value as UsefulLifeType)} disabled={disabled}>
            {USEFUL_LIFE_TYPES.map((key) => (
              <option key={key} value={key}>
                {USEFUL_LIFE_TYPE_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        {lifeType === "finite" ? (
          <Field label="عمر مفید جدید (ماه)" hint={`فعلی: ${toPersianDigits(asset.usefulLifeMonths ?? 0)} ماه`}>
            <PersianNumberInput className={inputClass} dir="ltr" value={months} onChange={(e) => setMonths(e.target.value)} disabled={disabled} />
          </Field>
        ) : null}
        <Field label={`ارزش باقی‌ماندهٔ جدید (${money.unitLabel})`} hint={`فعلی: ${money.format(asset.residualValue)}`}>
          <PersianNumberInput className={inputClass} dir="ltr" value={residual} onChange={(e) => setResidual(e.target.value)} disabled={disabled} />
        </Field>
        <Field label="دلیل تغییر برآورد" hint="الزامی — برای رسیدگی حسابداری">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={INTANGIBLE_REASON_MAX_LENGTH} disabled={disabled} />
        </Field>
        <Field label="مرجع مستندات تأیید">
          <input className={inputClass} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={INTANGIBLE_EVIDENCE_MAX_LENGTH} disabled={disabled} />
        </Field>

        {previewError ? <ErrorBox>{previewError}</ErrorBox> : null}
        {preview ? (
          <div className="rounded-xl border border-amber-500/20 bg-amber-50/60 p-3 text-xs dark:bg-amber-500/10">
            <div className="flex items-center justify-between font-semibold text-foreground">
              <span>استهلاک ماهانهٔ دوره‌های بعد (پیش‌نمایش):</span>
              <span className="text-sm tabular-nums text-amber-800 dark:text-amber-300">
                {preview.monthlyAmount === null ? "—" : money.format(preview.monthlyAmount)}
              </span>
            </div>
            <p className="mt-1.5 text-muted-foreground">
              مبنای استهلاک باقی‌مانده: {money.format(preview.remainingBase)}
            </p>
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton type="button" onClick={onClose} disabled={disabled}>
            انصراف
          </SecondaryButton>
          <PrimaryButton disabled={disabled || !effectiveDate || !reason.trim() || (lifeType === "finite" && !months.trim())}>
            {submitting ? "در حال ثبت…" : "ثبت تغییر برآورد"}
          </PrimaryButton>
        </div>
      </form>
    </OverlayDialog>
  );
}
