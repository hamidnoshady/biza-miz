"use client";

/**
 * Issue #839 Wave 2 — the automotive manager: the dealer's board.
 *
 * The sections are the issue's own list (§17) minus the ones later waves own:
 * نمای کلی (VW: the automotive KPIs only — never café operations), موجودی
 * خودرو (the stock table with §10's filters and search), ثبت و خرید (add /
 * acquire) and هزینهٔ خودرو (costs).
 *
 * One rule this file follows deliberately: **money the caller may not see is
 * never fetched into the client at all**. The API decides that from
 * `vehicles.cost_view` and the manager renders what it received, so a cashier's
 * browser never holds the owner's costs and margins even in a devtools panel.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, ErrorBox, Field, PrimaryButton, SecondaryButton, errorMessage, inputClass } from "../ui";
import { IndustryManagerShell, type Runner, type ManagerTab } from "../industry-manager-shell";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { FilterChip, FilterChipRow, FilterToolbar, FilterToolbarSearch, SearchField } from "../filters";
import { VEHICLE_STATE_LABELS, VEHICLE_CONDITION_LABELS, VEHICLE_STATES, type VehicleState } from "@/lib/automotive";
import { VehicleDetailDialog } from "./vehicle-detail-dialog";
import { formatJalali } from "@/lib/jalali";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { JalaliDatePicker } from "../jalali-date-picker";
import { useMoney } from "@/components/money/money-context";
import { PaymentWays, usePaymentMethods } from "../payment-ways";
import { emptyPaymentDraft, paymentDraftBody, type PaymentDraft } from "@/lib/payment-draft";
import { ledgerSettlementFor } from "@/lib/payment-methods";

type SectionKey = "overview" | "stock" | "acquire" | "reservations" | "sales" | "leads" | "expenses";

const TABS: readonly ManagerTab<SectionKey>[] = [
  { key: "overview", label: "نمای کلی" },
  { key: "stock", label: "موجودی خودرو" },
  { key: "acquire", label: "ثبت و خرید خودرو" },
  { key: "reservations", label: "رزروها" },
  { key: "sales", label: "فروش خودرو" },
  { key: "leads", label: "مشتریان و سرنخ‌ها" },
  { key: "expenses", label: "هزینهٔ خودرو" },
];

const STATE_TONE: Partial<Record<VehicleState, "active" | "positive" | "neutral" | "danger">> = {
  in_stock: "positive",
  acquired: "positive",
  reserved: "active",
  sold: "neutral",
  transferred: "active",
  draft: "neutral",
  archived: "neutral",
  returned: "danger",
};

export interface VehicleListItemDto {
  serialId: string;
  stockNumber: string;
  displayName: string;
  make: string;
  model: string;
  trim: string | null;
  modelYear: number | null;
  condition: "new" | "used";
  mileageKm: number | null;
  state: VehicleState;
  locationId: string;
  locationName: string | null;
  purchaseCostRial?: number;
  effectiveCostRial?: number;
  askingPriceRial: number;
  minimumPriceRial?: number | null;
  potentialMarginRial?: number;
  acquiredOn: string;
  daysInStock: number;
  vin: string | null;
  chassisNumber: string | null;
  plateNumber: string | null;
  reservedForName: string | null;
  reservedForCustomerId: string | null;
  reservedDepositRial: number;
  reservedUntil: string | null;
  soldOn: string | null;
  soldPriceRial: number | null;
}

interface LocationOptionDto {
  id: string;
  name: string;
}

interface VehicleListResponseDto {
  total: number;
  vehicles: VehicleListItemDto[];
  locations?: LocationOptionDto[];
  activeLocationId?: string | null;
  selectedLocationId?: string | null;
  allBranches?: boolean;
  error?: string;
  message?: string;
}

interface OverviewDto {
  onDate: string;
  canSeeCost?: boolean;
  error?: string;
  message?: string;
  summary: {
    inStock: number;
    reserved: number;
    sold: number;
    stockValueRial?: number;
    askingValueRial?: number;
    potentialMarginRial?: number;
    averageAgeDays: number | null;
    slowCount: number;
    deadCount: number;
    soldThisMonth: number;
    revenueThisMonthRial?: number;
    grossProfitThisMonthRial?: number;
    averageMarginThisMonth?: number | null;
  };
}

/**
 * Amounts are stored and sent as integer Rial, but typed and shown in the
 * business's chosen unit (تومان or ریال). This is the screen's only
 * conversion point: `toRial` on the way to the API, `toInput` when a stored
 * figure seeds a field.
 */
function useVehicleMoney() {
  const api = useMoney();
  return useMemo(
    () => ({
      unit: api.unit,
      unitLabel: api.unitLabel,
      money: (value: number | undefined | null): string => (value == null ? "—" : api.format(value, { withUnit: false })),
      toRial: (input: string): number => {
        const value = Math.trunc(Number(input.trim() || 0));
        return Number.isFinite(value) && value > 0 ? api.fromInput(value) : 0;
      },
      toInput: (rial: number | null | undefined): string => (rial ? String(api.toInput(rial)) : ""),
    }),
    [api],
  );
}

function branchScopeParams(branchFilter: string): URLSearchParams {
  const params = new URLSearchParams();
  if (branchFilter === "all") params.set("allBranches", "1");
  else if (branchFilter !== "active") params.set("locationId", branchFilter);
  return params;
}

async function fetchVehiclePages(
  baseParams: URLSearchParams,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; aborted: boolean; data: VehicleListResponseDto }> {
  const vehicles: VehicleListItemDto[] = [];
  let offset = 0;
  let page: { ok: boolean; status: number; aborted: boolean; data: VehicleListResponseDto } | null = null;
  do {
    const params = new URLSearchParams(baseParams);
    params.set("limit", "500");
    params.set("offset", String(offset));
    page = await api<VehicleListResponseDto>(`/api/automotive/vehicles?${params.toString()}`, { signal });
    if (!page.ok || page.aborted) return page;
    const rows = page.data.vehicles ?? [];
    vehicles.push(...rows);
    offset += rows.length;
    if (rows.length === 0 || offset >= page.data.total) break;
  } while (true);
  return page
    ? { ...page, data: { ...page.data, vehicles } }
    : { ok: true, status: 200, aborted: false, data: { total: 0, vehicles } };
}

export function AutomotiveManager({
  canSeeCost,
  canCreateVehicle,
  canEditCost,
  canOverrideMinPrice,
  canEditVehicle,
  canEditPrice,
  canReserveVehicle,
  canCancelReservation,
  canSellVehicle,
  canRecordCost,
  canViewLeads,
  canManageLeads,
  canCreateCustomer,
  canTransferVehicle,
  canArchiveVehicle,
  canViewMedia,
  canManageMedia,
  defaultVatPercent,
}: {
  canSeeCost: boolean;
  canCreateVehicle: boolean;
  canEditCost: boolean;
  canOverrideMinPrice: boolean;
  canEditVehicle: boolean;
  canEditPrice: boolean;
  canReserveVehicle: boolean;
  canCancelReservation: boolean;
  canSellVehicle: boolean;
  canRecordCost: boolean;
  canViewLeads: boolean;
  canManageLeads: boolean;
  canCreateCustomer: boolean;
  canTransferVehicle: boolean;
  canArchiveVehicle: boolean;
  canViewMedia: boolean;
  canManageMedia: boolean;
  defaultVatPercent: number;
}) {
  const [section, setSection] = useState<SectionKey>("overview");
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [vehicles, setVehicles] = useState<VehicleListItemDto[]>([]);
  const [stockTotal, setStockTotal] = useState(0);
  const [workflowVehicles, setWorkflowVehicles] = useState<VehicleListItemDto[]>([]);
  const [locations, setLocations] = useState<LocationOptionDto[]>([]);
  const [activeLocationId, setActiveLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [workflowLoading, setWorkflowLoading] = useState(true);
  const [workflowError, setWorkflowError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [search, setSearch] = useState("");
  const [condition, setCondition] = useState<"all" | "new" | "used">("all");
  const [stateFilter, setStateFilter] = useState<"available" | "reserved" | "sold" | "all">("available");
  const [branchFilter, setBranchFilter] = useState("active");
  const [makeFilter, setMakeFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [modelYearFrom, setModelYearFrom] = useState("");
  const [modelYearTo, setModelYearTo] = useState("");
  const [minPriceRial, setMinPriceRial] = useState("");
  const [maxPriceRial, setMaxPriceRial] = useState("");
  const [minMileageKm, setMinMileageKm] = useState("");
  const [maxMileageKm, setMaxMileageKm] = useState("");
  const [minAgeDays, setMinAgeDays] = useState("");
  const [maxAgeDays, setMaxAgeDays] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const { money, unitLabel, toRial } = useVehicleMoney();
  const pageSize = 25;

  const run: Runner = useCallback(async (fn) => {
    const result = await fn();
    if (!result.ok) {
      setError(errorMessage(result.data.error) || result.data.message || result.data.error || "");
      return false;
    }
    setError("");
    setReloadKey((key) => key + 1);
    return true;
  }, []);

  function updateListFilter(setter: Dispatch<SetStateAction<string>>, value: string) {
    setter(value);
    setPageIndex(0);
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);

    const overviewParams = branchScopeParams(branchFilter);
    const stockParams = branchScopeParams(branchFilter);
    if (search.trim()) stockParams.set("q", search.trim());
    if (condition !== "all") stockParams.set("condition", condition);
    if (stateFilter === "available") stockParams.set("states", "draft,acquired,in_stock");
    else if (stateFilter !== "all") stockParams.set("states", stateFilter);
    if (makeFilter.trim()) stockParams.set("make", makeFilter.trim());
    if (modelFilter.trim()) stockParams.set("model", modelFilter.trim());
    for (const [key, value] of [
      ["modelYearFrom", modelYearFrom], ["modelYearTo", modelYearTo],
      ["minPriceRial", minPriceRial.trim() ? String(toRial(minPriceRial)) : ""],
      ["maxPriceRial", maxPriceRial.trim() ? String(toRial(maxPriceRial)) : ""],
      ["minMileageKm", minMileageKm], ["maxMileageKm", maxMileageKm],
      ["minAgeDays", minAgeDays], ["maxAgeDays", maxAgeDays],
    ]) {
      if (value.trim()) stockParams.set(key, value.trim());
    }
    stockParams.set("limit", String(pageSize));
    stockParams.set("offset", String(pageIndex * pageSize));
    const overviewUrl = `/api/automotive/overview${overviewParams.size ? `?${overviewParams.toString()}` : ""}`;

    void (async () => {
      const [overviewResult, stockResult] = await Promise.all([
        api<OverviewDto>(overviewUrl, { signal: controller.signal }),
        api<VehicleListResponseDto>(`/api/automotive/vehicles?${stockParams.toString()}`, { signal: controller.signal }),
      ]);
      if (cancelled || overviewResult.aborted || stockResult.aborted) return;
      if (overviewResult.ok) setOverview(overviewResult.data);
      if (stockResult.ok) {
        setVehicles(stockResult.data.vehicles ?? []);
        setStockTotal(stockResult.data.total ?? 0);
        setLocations(stockResult.data.locations ?? []);
        setActiveLocationId(stockResult.data.activeLocationId ?? null);
        const nextTotal = stockResult.data.total ?? 0;
        if (nextTotal === 0 && pageIndex !== 0) setPageIndex(0);
        else if (pageIndex > 0 && pageIndex * pageSize >= nextTotal) {
          setPageIndex(Math.max(0, Math.ceil(nextTotal / pageSize) - 1));
        }
      }
      const failures = [
        !overviewResult.ok
          ? `نمای کلی: ${errorMessage(overviewResult.data.error) || overviewResult.data.message || overviewResult.data.error || "خطا در دریافت داده‌ها"}`
          : null,
        !stockResult.ok
          ? `موجودی: ${errorMessage(stockResult.data.error) || stockResult.data.message || stockResult.data.error || "خطا در دریافت داده‌ها"}`
          : null,
      ].filter((message): message is string => message !== null);
      setError(failures.join(" · "));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    search, condition, stateFilter, branchFilter, makeFilter, modelFilter,
    modelYearFrom, modelYearTo, minPriceRial, maxPriceRial,
    minMileageKm, maxMileageKm, minAgeDays, maxAgeDays, pageIndex, reloadKey, toRial,
  ]);

  // Workflow pickers have their own unfiltered, paginated dataset. Searching or
  // paging the stock table can therefore never remove a vehicle from a sale,
  // reservation, expense, or CRM selector.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setWorkflowLoading(true);
    const params = new URLSearchParams({ states: VEHICLE_STATES.join(",") });
    void (async () => {
      const result = await fetchVehiclePages(params, controller.signal);
      if (cancelled || result.aborted) return;
      if (result.ok) {
        setWorkflowVehicles(result.data.vehicles ?? []);
        setWorkflowError("");
      } else {
        setWorkflowVehicles([]);
        setWorkflowError(errorMessage(result.data.error) || result.data.message || result.data.error || "خطا در دریافت خودروهای گردش کار");
      }
      setWorkflowLoading(false);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey]);

  // §16's "sold this month" — the *same-month* count, not the lifetime `sold`
  // total the summary also carries.
  const soldThisMonth = useMemo(() => overview?.summary.soldThisMonth ?? 0, [overview]);
  const shellError = [error, workflowError ? `گردش کار خودرو: ${workflowError}` : ""].filter(Boolean).join(" · ");
  const pageCount = Math.max(1, Math.ceil(stockTotal / pageSize));
  const activeLocationName = locations.find(({ id }) => id === activeLocationId)?.name;
  const visibleTabs = useMemo(
    () => TABS.filter(({ key }) =>
      (key !== "acquire" || canCreateVehicle) &&
      (key !== "leads" || canViewLeads) &&
      (key !== "expenses" || canRecordCost),
    ),
    [canCreateVehicle, canViewLeads, canRecordCost],
  );

  return (
    <IndustryManagerShell
      idPrefix="automotive"
      navLabel="بخش‌های نمایشگاه"
      tabs={visibleTabs}
      activeTab={section}
      onTabChange={setSection}
      error={shellError}
    >
      {section === "overview" ? (
        <div role="tabpanel" id="automotive-panel-overview" aria-labelledby="automotive-tab-overview" className="space-y-4">
          {loading && !overview ? (
            <KpiRow>
              <SectionCardSkeleton />
              <SectionCardSkeleton />
            </KpiRow>
          ) : (
            <KpiRow>
              <KpiCard label="خودروهای موجود" value={String(overview?.summary.inStock ?? 0)} />
              <KpiCard label="رزروشده" value={String(overview?.summary.reserved ?? 0)} />
              <KpiCard label="فروش‌رفتهٔ این ماه" value={String(soldThisMonth)} />
              {canSeeCost ? (
                <KpiCard label={`درآمد این ماه (بی‌مالیات، ${unitLabel})`} value={money(overview?.summary.revenueThisMonthRial)} />
              ) : null}
              {canSeeCost ? (
                <KpiCard label={`سود ناخالص این ماه (${unitLabel})`} value={money(overview?.summary.grossProfitThisMonthRial)} />
              ) : null}
              {canSeeCost ? (
                <KpiCard
                  label="میانگین حاشیهٔ این ماه"
                  value={
                    overview?.summary.averageMarginThisMonth == null
                      ? "—"
                      : `${overview.summary.averageMarginThisMonth.toLocaleString("fa-IR")}٪`
                  }
               />
              ) : null}
              <KpiCard
                label="میانگین روز در انبار"
                value={overview?.summary.averageAgeDays == null ? "—" : String(overview.summary.averageAgeDays)}
             />
              {canSeeCost ? (
                <>
                  <KpiCard label={`ارزش موجودی (${unitLabel})`} value={money(overview?.summary.stockValueRial)} />
                  <KpiCard label={`حاشیهٔ بالقوه (${unitLabel})`} value={money(overview?.summary.potentialMarginRial)} />
                </>
              ) : null}
              <KpiCard label="کند / راکد" value={`${overview?.summary.slowCount ?? 0} / ${overview?.summary.deadCount ?? 0}`} />
            </KpiRow>
          )}
          <SectionCard title="راکد و کند" description="هشدار موجودی">
            {(overview?.summary.deadCount ?? 0) + (overview?.summary.slowCount ?? 0) === 0 ? (
              <EmptyState title="موجودی سالم است">هیچ خودرویی از آستانهٔ ۶۰ روز عبور نکرده است.</EmptyState>
            ) : (
              <p className="text-sm text-muted-foreground">
                {overview?.summary.deadCount ?? 0} خودرو بیش از ۹۰ روز و {overview?.summary.slowCount ?? 0} خودرو بین ۶۰ تا ۹۰ روز
                در انبار مانده است؛ برای جزئیات به «موجودی خودرو» بروید و بر پایهٔ سن موجودی فیلتر کنید.
              </p>
            )}
          </SectionCard>
        </div>
      ) : null}

      {section === "stock" ? (
        <div role="tabpanel" id="automotive-panel-stock" aria-labelledby="automotive-tab-stock" className="space-y-4">
          <FilterToolbar>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <FilterToolbarSearch
                value={search}
                onChange={(value) => updateListFilter(setSearch, value)}
                label="جست‌وجوی خودرو"
                placeholder="شماره شاسی، VIN، شماره انبار، پلاک، برند/مدل یا نام مشتری"
             />
              <Field label="شعبهٔ موجودی">
                <select
                  className={inputClass}
                  value={branchFilter}
                  onChange={(event) => updateListFilter(setBranchFilter, event.target.value)}
                >
                  <option value="active">شعبهٔ فعال{activeLocationName ? ` — ${activeLocationName}` : ""}</option>
                  <option value="all">همهٔ شعبه‌های مجاز</option>
                  {locations.map((branch) => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <FilterChipRow label="وضعیت">
              {(
                [
                  ["available", "قابل فروش"],
                  ["reserved", "رزرو"],
                  ["sold", "فروخته‌شده"],
                  ["all", "همه"],
                ] as const
              ).map(([value, label]) => (
                <FilterChip
                  key={value}
                  selected={stateFilter === value}
                  onClick={() => { setPageIndex(0); setStateFilter(value); }}
                >
                  {label}
                </FilterChip>
              ))}
            </FilterChipRow>
            <FilterChipRow label="نو / کارکرده">
              {(
                [
                  ["all", "همه"],
                  ["new", "نو"],
                  ["used", "کارکرده"],
                ] as const
              ).map(([value, label]) => (
                <FilterChip
                  key={value}
                  selected={condition === value}
                  onClick={() => { setPageIndex(0); setCondition(value); }}
                >
                  {label}
                </FilterChip>
              ))}
            </FilterChipRow>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="برند">
                <input className={inputClass} value={makeFilter} onChange={(event) => updateListFilter(setMakeFilter, event.target.value)} />
              </Field>
              <Field label="مدل">
                <input className={inputClass} value={modelFilter} onChange={(event) => updateListFilter(setModelFilter, event.target.value)} />
              </Field>
              <Field label="سال ساخت از">
                <PersianNumberInput className={inputClass} inputMode="numeric" value={modelYearFrom} onChange={(event) => updateListFilter(setModelYearFrom, event.target.value)} />
              </Field>
              <Field label="سال ساخت تا">
                <PersianNumberInput className={inputClass} inputMode="numeric" value={modelYearTo} onChange={(event) => updateListFilter(setModelYearTo, event.target.value)} />
              </Field>
              <Field label={`حداقل قیمت فروش (${unitLabel})`}>
                <PersianNumberInput className={inputClass} inputMode="numeric" value={minPriceRial} onChange={(event) => updateListFilter(setMinPriceRial, event.target.value)} />
              </Field>
              <Field label={`حداکثر قیمت فروش (${unitLabel})`}>
                <PersianNumberInput className={inputClass} inputMode="numeric" value={maxPriceRial} onChange={(event) => updateListFilter(setMaxPriceRial, event.target.value)} />
              </Field>
              <Field label="حداقل کارکرد (کیلومتر)">
                <PersianNumberInput className={inputClass} inputMode="numeric" value={minMileageKm} onChange={(event) => updateListFilter(setMinMileageKm, event.target.value)} />
              </Field>
              <Field label="حداکثر کارکرد (کیلومتر)">
                <PersianNumberInput className={inputClass} inputMode="numeric" value={maxMileageKm} onChange={(event) => updateListFilter(setMaxMileageKm, event.target.value)} />
              </Field>
              <Field label="حداقل روز در انبار">
                <PersianNumberInput className={inputClass} inputMode="numeric" value={minAgeDays} onChange={(event) => updateListFilter(setMinAgeDays, event.target.value)} />
              </Field>
              <Field label="حداکثر روز در انبار">
                <PersianNumberInput className={inputClass} inputMode="numeric" value={maxAgeDays} onChange={(event) => updateListFilter(setMaxAgeDays, event.target.value)} />
              </Field>
            </div>
          </FilterToolbar>

          {loading ? (
            <SectionCardSkeleton />
          ) : stockTotal === 0 ? (
            <EmptyState title="خودرویی یافت نشد">با این فیلترها خودرویی در موجودی نیست.</EmptyState>
          ) : (
            <div className="space-y-3">
              <DataTable caption="موجودی خودرو">
              <DataTableHead>
                <Th>شماره انبار</Th>
                <Th>خودرو</Th>
                <Th>نوع</Th>
                <Th>کارکرد</Th>
                {canSeeCost ? <Th>بهای خرید ({unitLabel})</Th> : null}
                {canSeeCost ? <Th>بهای تمام‌شده ({unitLabel})</Th> : null}
                <Th>قیمت فروش ({unitLabel})</Th>
                {canSeeCost ? <Th>حاشیهٔ بالقوه ({unitLabel})</Th> : null}
                <Th>روز در انبار</Th>
                <Th>وضعیت</Th>
                <Th>شعبه</Th>
                <Th>عملیات</Th>
              </DataTableHead>
              <DataTableBody>
                {vehicles.map((vehicle) => (
                  <DataTableRow key={vehicle.serialId}>
                    <Td className="font-mono text-xs">{vehicle.stockNumber}</Td>
                    <Td>
                      <div className="font-medium">{vehicle.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {vehicle.vin ?? vehicle.chassisNumber ?? "—"}
                        {vehicle.reservedForName ? ` · رزرو برای ${vehicle.reservedForName}` : ""}
                      </div>
                    </Td>
                    <Td>{VEHICLE_CONDITION_LABELS[vehicle.condition]}</Td>
                    <Td>{vehicle.mileageKm == null ? "—" : `${vehicle.mileageKm.toLocaleString("fa-IR")} کیلومتر`}</Td>
                    {canSeeCost ? <Td>{money(vehicle.purchaseCostRial)}</Td> : null}
                    {canSeeCost ? <Td>{money(vehicle.effectiveCostRial)}</Td> : null}
                    <Td>{money(vehicle.askingPriceRial)}</Td>
                    {canSeeCost ? <Td>{money(vehicle.potentialMarginRial)}</Td> : null}
                    <Td>{vehicle.daysInStock.toLocaleString("fa-IR")}</Td>
                    <Td>
                      <StatusBadge tone={STATE_TONE[vehicle.state] ?? "neutral"}>
                        {VEHICLE_STATE_LABELS[vehicle.state]}
                      </StatusBadge>
                    </Td>
                    <Td>{vehicle.locationName ?? "—"}</Td>
                    <Td>
                      <SecondaryButton type="button" onClick={() => setSelectedVehicleId(vehicle.serialId)}>
                        جزئیات
                        <span className="sr-only"> خودروی {vehicle.stockNumber}</span>
                      </SecondaryButton>
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
              </DataTable>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p aria-live="polite" className="text-muted-foreground">
                  نمایش {Math.min(stockTotal, pageIndex * pageSize + 1).toLocaleString("fa-IR")} تا {Math.min(stockTotal, (pageIndex + 1) * pageSize).toLocaleString("fa-IR")} از {stockTotal.toLocaleString("fa-IR")} خودرو
                </p>
                <div className="flex items-center gap-2">
                  <SecondaryButton type="button" disabled={loading || pageIndex === 0} onClick={() => setPageIndex((page) => Math.max(0, page - 1))}>
                    قبلی
                  </SecondaryButton>
                  <span aria-current="page" className="min-w-20 text-center">صفحهٔ {(pageIndex + 1).toLocaleString("fa-IR")} از {pageCount.toLocaleString("fa-IR")}</span>
                  <SecondaryButton type="button" disabled={loading || pageIndex + 1 >= pageCount} onClick={() => setPageIndex((page) => Math.min(pageCount - 1, page + 1))}>
                    بعدی
                  </SecondaryButton>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {section === "acquire" ? (
        <div role="tabpanel" id="automotive-panel-acquire" aria-labelledby="automotive-tab-acquire">
          <AcquireSection run={run} canEditCost={canEditCost} canOverrideMinPrice={canOverrideMinPrice} />
        </div>
      ) : null}

      {section === "reservations" ? (
        <div
          role="tabpanel"
          id="automotive-panel-reservations"
          aria-labelledby="automotive-tab-reservations"
        >
          <ReservationsSection
            vehicles={workflowVehicles}
            vehiclesLoading={workflowLoading}
            canReserve={canReserveVehicle}
            canCancel={canCancelReservation}
            run={run}
         />
        </div>
      ) : null}

      {section === "sales" ? (
        <div role="tabpanel" id="automotive-panel-sales" aria-labelledby="automotive-tab-sales">
          <SalesSection
            vehicles={workflowVehicles}
            vehiclesLoading={workflowLoading}
            canSeeCost={canSeeCost}
            canOverrideMinPrice={canOverrideMinPrice}
            canSell={canSellVehicle}
            canCreateCustomer={canCreateCustomer}
            defaultVatPercent={defaultVatPercent}
            run={run}
         />
        </div>
      ) : null}

      {section === "leads" ? (
        <div role="tabpanel" id="automotive-panel-leads" aria-labelledby="automotive-tab-leads">
          <LeadsSection
            vehicles={workflowVehicles}
            vehiclesLoading={workflowLoading}
            canManage={canManageLeads}
            run={run}
         />
        </div>
      ) : null}

      {section === "expenses" ? (
        <div role="tabpanel" id="automotive-panel-expenses" aria-labelledby="automotive-tab-expenses">
          <ExpensesSection vehicles={workflowVehicles} vehiclesLoading={workflowLoading} canRecord={canRecordCost} run={run} />
        </div>
      ) : null}
      {selectedVehicleId ? (
        <VehicleDetailDialog
          serialId={selectedVehicleId}
          activeLocationId={activeLocationId}
          locations={locations}
          canSeeCost={canSeeCost}
          canEditVehicle={canEditVehicle}
          canEditPrice={canEditPrice}
          canOverrideMinPrice={canOverrideMinPrice}
          canTransferVehicle={canTransferVehicle}
          canArchiveVehicle={canArchiveVehicle}
          canViewMedia={canViewMedia}
          canManageMedia={canManageMedia}
          onClose={() => setSelectedVehicleId(null)}
          onChanged={() => setReloadKey((key) => key + 1)}
       />
      ) : null}
    </IndustryManagerShell>
  );
}

const ACQUISITION_SOURCES = [
  { value: "dealer_purchase", label: "خرید از نمایندگی" },
  { value: "direct_purchase", label: "خرید مستقیم" },
  { value: "supplier_purchase", label: "خرید از تأمین‌کننده" },
  { value: "customer_purchase", label: "خرید از مشتری" },
  { value: "trade_in", label: "معاوضه" },
  { value: "import", label: "واردات" },
  { value: "opening_stock", label: "موجودی اول دوره" },
];

const SETTLEMENTS = [
  { value: "payable", label: "بستانکار (پرداختنی)" },
  { value: "cash", label: "نقدی" },
  { value: "bank", label: "بانکی" },
  { value: "clearing", label: "از حساب واسط حمل/ترخیص" },
  { value: "trade_in", label: "معاوضه" },
  { value: "opening_equity", label: "تراز افتتاحیه" },
];

function AcquireSection({ run, canEditCost, canOverrideMinPrice }: { run: Runner; canEditCost: boolean; canOverrideMinPrice: boolean }) {
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [modelYear, setModelYear] = useState("");
  const [condition, setCondition] = useState<"new" | "used">("new");
  const [vin, setVin] = useState("");
  const [chassisNumber, setChassisNumber] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [stockNumber, setStockNumber] = useState("");
  const [mileageKm, setMileageKm] = useState("");
  const [priorOwners, setPriorOwners] = useState("");
  const [acquisitionSource, setAcquisitionSource] = useState("dealer_purchase");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [settlement, setSettlement] = useState("payable");
  const [askingPrice, setAskingPrice] = useState("");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const { unitLabel, toRial } = useVehicleMoney();

  async function submit() {
    setBusy(true);
    await run(async () => {
      const result = await api<{ error?: string; message?: string }>("/api/automotive/vehicles", {
        method: "POST",
        body: JSON.stringify({
          make,
          model,
          trim: trim || null,
          modelYear: modelYear ? Number(modelYear) : null,
          condition,
          vin: vin || null,
          chassisNumber: chassisNumber || null,
          plateNumber: plateNumber || null,
          stockNumber: stockNumber || null,
          mileageKm: mileageKm ? Number(mileageKm) : null,
          priorOwners: priorOwners ? Number(priorOwners) : null,
          acquisition: canEditCost ? {
            date: acquisitionDate,
            source: acquisitionSource,
            costRial: toRial(purchaseCost),
            settlement,
          } : null,
          askingPriceRial: toRial(askingPrice),
          minimumPriceRial: canOverrideMinPrice && minimumPrice ? toRial(minimumPrice) : null,
        }),
      });
      if (result.ok) {
        setMake("");
        setModel("");
        setTrim("");
        setVin("");
        setChassisNumber("");
        setPlateNumber("");
        setStockNumber("");
        setMileageKm("");
        setPriorOwners("");
        setPurchaseCost("");
        setAskingPrice("");
        setMinimumPrice("");
      }
      return result as { ok: boolean; data: { error?: string; message?: string } };
    });
    setBusy(false);
  }

  return (
    <SectionCard title="ثبت خودرو و خرید" description="موجودی">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="برند (سازنده)">
          <input className={inputClass} value={make} onChange={(event) => setMake(event.target.value)} />
        </Field>
        <Field label="مدل">
          <input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} />
        </Field>
        <Field label="تیپ / نسخه">
          <input className={inputClass} value={trim} onChange={(event) => setTrim(event.target.value)} />
        </Field>
        <Field label="سال ساخت (مدل) — شمسی">
          <input className={inputClass} inputMode="numeric" value={modelYear} onChange={(event) => setModelYear(event.target.value)} />
        </Field>
        <Field label="وضعیت">
          <select className={inputClass} value={condition} onChange={(event) => setCondition(event.target.value as "new" | "used")}>
            <option value="new">نو</option>
            <option value="used">کارکرده</option>
          </select>
        </Field>
        <Field label="شماره شاسی (VIN)">
          <input className={inputClass} value={vin} onChange={(event) => setVin(event.target.value)} />
        </Field>
        <Field label="شماره شاسی/تنه">
          <input className={inputClass} value={chassisNumber} onChange={(event) => setChassisNumber(event.target.value)} />
        </Field>
        <Field label="شماره انبار">
          <input
            className={inputClass}
            value={stockNumber}
            onChange={(event) => setStockNumber(event.target.value)}
            placeholder="خالی بگذارید تا خودکار شماره‌گذاری شود"
         />
        </Field>
        <Field label="پلاک">
          <input className={inputClass} value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} />
        </Field>
        {condition === "used" ? (
          <>
            <Field label="کارکرد (کیلومتر)">
              <input className={inputClass} inputMode="numeric" value={mileageKm} onChange={(event) => setMileageKm(event.target.value)} />
            </Field>
            <Field label="تعداد مالکان قبلی">
              <input
                className={inputClass}
                inputMode="numeric"
                value={priorOwners}
                onChange={(event) => setPriorOwners(event.target.value)}
             />
            </Field>
          </>
        ) : null}
        {canEditCost ? (
          <>
            <Field label="نحوهٔ خرید">
              <select className={inputClass} value={acquisitionSource} onChange={(event) => setAcquisitionSource(event.target.value)}>
                {ACQUISITION_SOURCES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </Field>
            <Field as="div" label="تاریخ خرید">
              <JalaliDatePicker value={acquisitionDate} onChange={setAcquisitionDate} ariaLabel="تاریخ خرید خودرو" />
            </Field>
            <Field label={`بهای خرید (${unitLabel})`}>
              <PersianNumberInput className={inputClass} inputMode="numeric" value={purchaseCost} onChange={(event) => setPurchaseCost(event.target.value)} />
            </Field>
            <Field label="طرف حساب پرداخت">
              <select className={inputClass} value={settlement} onChange={(event) => setSettlement(event.target.value)}>
                {SETTLEMENTS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <p className="self-center text-xs text-muted-foreground">خودرو به‌صورت پیش‌نویس ثبت می‌شود؛ ثبت خرید و بهای آن به دسترسی مستقل «ویرایش بهای خودرو» نیاز دارد.</p>
        )}
        <Field label={`قیمت فروش (${unitLabel})`}>
          <PersianNumberInput className={inputClass} inputMode="numeric" value={askingPrice} onChange={(event) => setAskingPrice(event.target.value)} />
        </Field>
        {canOverrideMinPrice ? <Field label={`حداقل قیمت (${unitLabel})`}><PersianNumberInput className={inputClass} inputMode="numeric" value={minimumPrice} onChange={(event) => setMinimumPrice(event.target.value)} /></Field> : null}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <PrimaryButton onClick={submit} disabled={busy || !make.trim() || !model.trim()}>
          {busy ? "در حال ثبت…" : "ثبت خودرو"}
        </PrimaryButton>
        <span className="text-xs text-muted-foreground">
          {canEditCost ? "بهای تمام‌شدهٔ مؤثر = بهای خرید + هزینه‌های سرمایه‌ای خودرو." : "ثبت خودرو بدون معاملهٔ خرید، آن را پیش‌نویس نگه می‌دارد تا خرید با دسترسی مالی ثبت شود."}
        </span>
      </div>
    </SectionCard>
  );
}

const EXPENSE_CATEGORIES = [
  { value: "repair", label: "تعمیر" },
  { value: "paint_body", label: "صافکاری و نقاشی" },
  { value: "detailing", label: "پولیش و نظافت" },
  { value: "tires", label: "لاستیک" },
  { value: "parts", label: "قطعات" },
  { value: "inspection", label: "معاینهٔ فنی" },
  { value: "registration", label: "ثبت و پلاک" },
  { value: "transport", label: "حمل" },
  { value: "customs", label: "ترخیص و گمرک" },
  { value: "advertising", label: "تبلیغات" },
  { value: "preparation", label: "آماده‌سازی" },
  { value: "other", label: "سایر" },
];

function ExpensesSection({ vehicles, vehiclesLoading, canRecord, run }: { vehicles: VehicleListItemDto[]; vehiclesLoading: boolean; canRecord: boolean; run: Runner }) {
  const [serialId, setSerialId] = useState("");
  const [category, setCategory] = useState("repair");
  const [posting, setPosting] = useState<"capitalized" | "period_expense">("capitalized");
  const [amount, setAmount] = useState("");
  const [incurredOn, setIncurredOn] = useState("");
  const [settlement, setSettlement] = useState("payable");
  const [documentRef, setDocumentRef] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const { money, unitLabel, toRial } = useVehicleMoney();

  const selected = vehicles.find((vehicle) => vehicle.serialId === serialId);
  if (!canRecord) return null;

  async function submit() {
    if (!serialId) return;
    setBusy(true);
    await run(async () => {
      const result = await api<{ error?: string; message?: string }>(
        `/api/automotive/vehicles/${serialId}/costs`,
        {
          method: "POST",
          body: JSON.stringify({
            category,
            posting,
            amountRial: toRial(amount),
            incurredOn,
            settlement,
            documentRef: documentRef || null,
            notes: notes || null,
          }),
        },
      );
      if (result.ok) {
        setAmount("");
        setDocumentRef("");
        setNotes("");
      }
      return result as { ok: boolean; data: { error?: string; message?: string } };
    });
    setBusy(false);
  }

  return (
    <SectionCard title="هزینهٔ خودرو" description="سرمایه‌ای یا دوره‌ای">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="خودرو">
          <select className={inputClass} value={serialId} disabled={vehiclesLoading} onChange={(event) => setSerialId(event.target.value)}>
            <option value="">{vehiclesLoading ? "در حال دریافت خودروها…" : "— انتخاب خودرو —"}</option>
            {vehicles.map((vehicle) => (
              <option key={vehicle.serialId} value={vehicle.serialId}>
                {vehicle.stockNumber} — {vehicle.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="نوع هزینه">
          <select className={inputClass} value={category} onChange={(event) => setCategory(event.target.value)}>
            {EXPENSE_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="اثر حسابداری">
          <select
            className={inputClass}
            value={posting}
            onChange={(event) => setPosting(event.target.value as "capitalized" | "period_expense")}
          >
            <option value="capitalized">سرمایه‌ای — افزودن به بهای تمام‌شدهٔ خودرو</option>
            <option value="period_expense">هزینهٔ دوره — بازسازی و آماده‌سازی</option>
          </select>
        </Field>
        <Field label={`مبلغ (${unitLabel})`}>
          <PersianNumberInput className={inputClass} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field as="div" label="تاریخ هزینه">
          <JalaliDatePicker value={incurredOn} onChange={setIncurredOn} ariaLabel="تاریخ هزینهٔ خودرو" />
        </Field>
        <Field label="پرداخت">
          <select className={inputClass} value={settlement} onChange={(event) => setSettlement(event.target.value)}>
            <option value="payable">بستانکار (پرداختنی)</option>
            <option value="cash">نقدی</option>
            <option value="bank">بانکی</option>
            <option value="clearing">از حساب واسط حمل/ترخیص</option>
          </select>
        </Field>
        <Field label="شماره سند">
          <input className={inputClass} value={documentRef} onChange={(event) => setDocumentRef(event.target.value)} />
        </Field>
        <Field label="توضیح">
          <input className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
      {selected ? (
        <p className="mt-3 text-xs text-muted-foreground">
          خودروی {selected.displayName} — وضعیت {VEHICLE_STATE_LABELS[selected.state]}
          {selected.effectiveCostRial != null ? ` · بهای تمام‌شدهٔ مؤثر فعلی: ${money(selected.effectiveCostRial)} ${unitLabel}` : ""}
        </p>
      ) : null}
      <div className="mt-4">
        <PrimaryButton onClick={submit} disabled={busy || !serialId || !amount}>
          {busy ? "در حال ثبت…" : "ثبت هزینه"}
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}

/* ===========================================================================
 * §7 — reservations and their deposits
 * ===========================================================================
 *
 * The hold is the dealership's promise: this car, for this customer, until
 * this day, with this much of their money already in. The screen does three
 * things and refuses to blur them:
 *
 *   * a hold can only be taken on a car that is actually on the shelf, so the
 *     picker lists `in_stock`/`acquired` cars only — the server refuses the
 *     rest anyway, and offering them here would just be a button that fails;
 *   * the deposit carries an explicit method and an explicit refundability
 *     checkbox, because «ودیعه برمی‌گردد یا نه» is a promise to a person, not
 *     a default;
 *   * releasing demands a reason, which is what the owner reads later.
 *
 * Money the caller may not see never reaches this component: deposits are
 * ordinary money, so they travel; costs and margins do not (see the file's
 * header).
 */

export interface VehicleReservationDto {
  id: string;
  serialId: string;
  stockNumber: string;
  displayName: string;
  customerId: string;
  customerName: string | null;
  status: "active" | "converted" | "released" | "expired";
  expiresAt: string | null;
  expiresAtTime: string | null;
  depositRial: number;
  depositMethod: string | null;
  depositRefundable: boolean;
  depositNote: string | null;
  note: string | null;
  releaseReason: string | null;
  createdAt: string;
  closedAt: string | null;
}

const HOLD_STATUS_LABELS: Record<VehicleReservationDto["status"], string> = {
  active: "فعال",
  converted: "تبدیل به فروش",
  released: "آزادشده",
  expired: "منقضی",
};

const HOLD_STATUS_TONE: Record<VehicleReservationDto["status"], "active" | "positive" | "neutral" | "danger"> = {
  active: "active",
  converted: "positive",
  released: "neutral",
  expired: "danger",
};

const DEPOSIT_METHODS = [
  { value: "cash", label: "نقدی" },
  { value: "card", label: "کارت‌خوان" },
  { value: "card_to_card", label: "کارت به کارت" },
  { value: "online", label: "آنلاین" },
];

function ReservationsSection({ vehicles, vehiclesLoading, canReserve, canCancel, run }: { vehicles: VehicleListItemDto[]; vehiclesLoading: boolean; canReserve: boolean; canCancel: boolean; run: Runner }) {
  const [reservations, setReservations] = useState<VehicleReservationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [serialId, setSerialId] = useState("");
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [expiresAtTime, setExpiresAtTime] = useState("");
  const [deposit, setDeposit] = useState("");
  const [depositMethod, setDepositMethod] = useState("cash");
  const [depositRefundable, setDepositRefundable] = useState(true);
  const [depositNote, setDepositNote] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [releaseReason, setReleaseReason] = useState<Record<string, string>>({});
  const { money, unitLabel, toRial } = useVehicleMoney();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await api<{ reservations: VehicleReservationDto[]; error?: string; message?: string }>("/api/automotive/reservations");
      if (cancelled) return;
      if (result.ok) {
        setReservations(result.data.reservations ?? []);
        setLoadError("");
      } else {
        setLoadError(errorMessage(result.data.error) || result.data.message || result.data.error || "خطا در دریافت رزروها");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reservable = vehicles.filter((vehicle) => vehicle.state === "in_stock" || vehicle.state === "acquired");
  const depositRial = toRial(deposit);

  async function submit() {
    if (!serialId || !customer) return;
    setBusy(true);
    const ok = await run(async () => {
      const result = await api<{ error?: string; message?: string }>("/api/automotive/reservations", {
        method: "POST",
        body: JSON.stringify({
          serialId,
          customerId: customer.id,
          expiresAt: expiresAt || null,
          expiresAtTime: expiresAtTime || null,
          depositRial,
          depositMethod: depositRial > 0 ? depositMethod : null,
          depositRefundable,
          depositNote: depositNote || null,
          note: note || null,
        }),
      });
      if (result.ok) setReloadKey((key) => key + 1);
      return result;
    });
    if (ok) {
      setSerialId("");
      setCustomer(null);
      setExpiresAt("");
      setExpiresAtTime("");
      setDeposit("");
      setDepositNote("");
      setNote("");
    }
    setBusy(false);
  }

  async function release(id: string) {
    const reason = (releaseReason[id] ?? "").trim();
    if (!reason) return;
    setBusy(true);
    const ok = await run(async () => {
      const result = await api<{ error?: string; message?: string }>(`/api/automotive/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ reason }),
      });
      if (result.ok) setReloadKey((key) => key + 1);
      return result;
    });
    if (ok) setReleaseReason((map) => ({ ...map, [id]: "" }));
    setBusy(false);
  }

  const active = reservations.filter((reservation) => reservation.status === "active");

  return (
    <div className="space-y-4">
      {canReserve ? <SectionCard title="رزرو خودرو برای مشتری" description="یک خودرو، یک مشتری، تا یک تاریخ">
        <p className="text-xs leading-5 text-muted-foreground">
          خودروی رزروشده تا وقتی رزرو فعال است به نام مشتری دیگری فروخته نمی‌شود؛ ودیعهٔ دریافتی به حساب
          «پیش‌دریافت از مشتری» می‌رود (نه درآمد) و هنگام فروش به همان مشتری از فاکتور کسر می‌شود. رزروی که
          تاریخش گذشته باشد، خودبه‌خود منقضی می‌شود و مانع فروش نمی‌ماند.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="خودرو">
            <select className={inputClass} value={serialId} disabled={vehiclesLoading} onChange={(event) => setSerialId(event.target.value)}>
              <option value="">{vehiclesLoading ? "در حال دریافت خودروها…" : "— انتخاب خودرو —"}</option>
              {reservable.map((vehicle) => (
                <option key={vehicle.serialId} value={vehicle.serialId}>
                  {vehicle.stockNumber} — {vehicle.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="مشتری">
            <CustomerPicker customer={customer} onChange={setCustomer} idPrefix="automotive-reserve" canCreate={false} />
          </Field>
          <Field label="تاریخ انقضا">
            <JalaliDatePicker value={expiresAt} onChange={setExpiresAt} ariaLabel="تاریخ انقضای رزرو" />
          </Field>
          <Field label="ساعت انقضا (اختیاری)">
            <input
              className={inputClass}
              dir="ltr"
              placeholder="18:00"
              value={expiresAtTime}
              onChange={(event) => setExpiresAtTime(event.target.value)}
           />
          </Field>
          <Field label={`ودیعه (${unitLabel})`}>
            <PersianNumberInput
              className={inputClass}
              inputMode="numeric"
              value={deposit}
              onChange={(event) => setDeposit(event.target.value)}
           />
          </Field>
          <Field label="روش دریافت ودیعه">
            <select
              className={inputClass}
              value={depositMethod}
              disabled={depositRial === 0}
              onChange={(event) => setDepositMethod(event.target.value)}
            >
              {DEPOSIT_METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="توضیح ودیعه">
            <input className={inputClass} value={depositNote} onChange={(event) => setDepositNote(event.target.value)} />
          </Field>
          <Field label="یادداشت رزرو">
            <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Field label="قابل استرداد؟">
            <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={depositRefundable}
                onChange={(event) => setDepositRefundable(event.target.checked)}
             />
              ودیعه در صورت لغو به مشتری برگردد
            </label>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={submit} disabled={busy || !serialId || !customer}>
            {busy ? "در حال ثبت…" : "ثبت رزرو"}
          </PrimaryButton>
          {reservable.length === 0 ? (
            <span className="text-xs text-muted-foreground">خودروی قابل رزروی در این شعبه موجود نیست.</span>
          ) : null}
        </div>
      </SectionCard> : null}

      <SectionCard title="رزروهای فعال" description={`${active.length.toLocaleString("fa-IR")} رزرو باز`}>
        {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}
        {loading ? (
          <SectionCardSkeleton />
        ) : active.length === 0 ? (
          <EmptyState title="رزرو فعالی نیست">همهٔ خودروهای این شعبه آزادند.</EmptyState>
        ) : (
          <DataTable caption="رزروهای فعال">
            <DataTableHead>
              <Th>خودرو</Th>
              <Th>مشتری</Th>
              <Th>تا تاریخ</Th>
              <Th>ودیعه</Th>
              <Th>استرداد</Th>
              {canCancel ? <Th>آزادسازی</Th> : null}
            </DataTableHead>
            <DataTableBody>
              {active.map((reservation) => (
                <DataTableRow key={reservation.id}>
                  <Td>
                    <div className="font-medium">{reservation.displayName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{reservation.stockNumber}</div>
                  </Td>
                  <Td>{reservation.customerName ?? "—"}</Td>
                  <Td>
                    {reservation.expiresAt ? formatJalali(reservation.expiresAt) : "تا آزادسازی"}
                    {reservation.expiresAtTime ? ` — ${reservation.expiresAtTime}` : ""}
                  </Td>
                  <Td>
                    {money(reservation.depositRial)} {unitLabel}
                    {reservation.depositRial > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        {DEPOSIT_METHODS.find((method) => method.value === reservation.depositMethod)?.label ??
                          reservation.depositMethod}
                        {reservation.depositRefundable ? " · قابل استرداد" : " · غیرقابل استرداد"}
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge tone={HOLD_STATUS_TONE[reservation.status]}>
                      {HOLD_STATUS_LABELS[reservation.status]}
                    </StatusBadge>
                  </Td>
                  {canCancel ? (
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className={`${inputClass} sm:max-w-xs`}
                          aria-label={`دلیل آزادسازی رزرو ${reservation.stockNumber}`}
                          placeholder="دلیل آزادسازی"
                          value={releaseReason[reservation.id] ?? ""}
                          onChange={(event) =>
                            setReleaseReason((map) => ({ ...map, [reservation.id]: event.target.value }))
                          }
                       />
                        <SecondaryButton
                          onClick={() => release(reservation.id)}
                          disabled={busy || !(releaseReason[reservation.id] ?? "").trim()}
                        >
                          آزادسازی
                        </SecondaryButton>
                      </div>
                    </Td>
                  ) : null}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      <SectionCard title="تاریخچهٔ رزروها" description="شامل رزروهای بسته‌شده">
        {loading ? (
          <SectionCardSkeleton />
        ) : reservations.filter((reservation) => reservation.status !== "active").length === 0 ? (
          <EmptyState title="تاریخچه‌ای نیست">هنوز رزروی بسته نشده است.</EmptyState>
        ) : (
          <DataTable caption="تاریخچهٔ رزروها">
            <DataTableHead>
              <Th>خودرو</Th>
              <Th>مشتری</Th>
              <Th>وضعیت</Th>
              <Th>ودیعه</Th>
              <Th>دلیل آزادسازی</Th>
            </DataTableHead>
            <DataTableBody>
              {reservations
                .filter((reservation) => reservation.status !== "active")
                .map((reservation) => (
                  <DataTableRow key={reservation.id}>
                    <Td>
                      <div className="font-medium">{reservation.displayName}</div>
                      <div className="font-mono text-xs text-muted-foreground">{reservation.stockNumber}</div>
                    </Td>
                    <Td>{reservation.customerName ?? "—"}</Td>
                    <Td>
                      <StatusBadge tone={HOLD_STATUS_TONE[reservation.status]}>
                        {HOLD_STATUS_LABELS[reservation.status]}
                      </StatusBadge>
                    </Td>
                    <Td>{money(reservation.depositRial)} {unitLabel}</Td>
                    <Td>{reservation.releaseReason ?? "—"}</Td>
                  </DataTableRow>
                ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}

/* ===========================================================================
 * §8 — selling one exact car, through the ordinary retail invoice
 * ===========================================================================
 *
 * The screen does not post anything itself: it builds the `vehicle` line and
 * hands it to `/api/sales/invoices`, which is the same till that sells
 * everything else in this business. Two consequences worth stating, because
 * they are the reason this section is small:
 *
 *   * the invoice — not this form — is the document, the accounting and the
 *     print; a car sale is a retail sale whose line names the car;
 *   * the permission checks that matter (`vehicles.sell`, and
 *     `vehicles.override_min_price` for crossing the floor) live on the server.
 *     The override checkbox is shown only to somebody who holds it, but hiding
 *     it is a courtesy, not the gate.
 *
 * A reserved car is offered only to the customer whose hold it is: the server
 * refuses a sale to anybody else, so the form says so before the cashier finds
 * out the hard way.
 */

function SalesSection({
  vehicles,
  vehiclesLoading,
  canSeeCost,
  canOverrideMinPrice,
  canSell,
  canCreateCustomer,
  defaultVatPercent,
  run,
}: {
  vehicles: VehicleListItemDto[];
  vehiclesLoading: boolean;
  canSeeCost: boolean;
  canOverrideMinPrice: boolean;
  canSell: boolean;
  canCreateCustomer: boolean;
  defaultVatPercent: number;
  run: Runner;
}) {
  const [serialId, setSerialId] = useState("");
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const vatPercent = defaultVatPercent;
  const { money, unit, unitLabel, toRial, toInput } = useVehicleMoney();
  // The business's own payment ways, through the same panel the POS uses, so a
  // renamed, disabled or reference-required way behaves here as it does at the
  // till, and a car can be paid in slices. Only ways the invoice engine can
  // post are offered (a cheque settles the account in its register instead).
  const paymentWays = usePaymentMethods(canSell);
  const settlementWays = useMemo(
    () => paymentWays.methods.filter((way) => way.isActive && ledgerSettlementFor(way.settlement) !== null),
    [paymentWays.methods],
  );
  const [paymentDraftState, setPaymentDraft] = useState<PaymentDraft | null>(null);
  const paymentDraft = paymentDraftState ?? emptyPaymentDraft(settlementWays);
  const [paymentError, setPaymentError] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ orderNumber: string; total: string } | null>(null);
  const [reversalReason, setReversalReason] = useState<Record<string, string>>({});

  const sellable = vehicles.filter((vehicle) => vehicle.state === "in_stock" || vehicle.state === "reserved");
  const sold = vehicles.filter((vehicle) => vehicle.state === "sold");
  const selected = sellable.find((vehicle) => vehicle.serialId === serialId);

  const priceRial = toRial(price);
  const discountRial = toRial(discount);
  const net = Math.max(0, priceRial - discountRial);
  const vat = Math.round((net * vatPercent) / 100);
  const total = net + vat;
  // The deposit the customer paid when they reserved is *applied*, not
  // collected again: what is still due today is the invoice less that money.
  const depositApplied = Math.min(selected?.reservedDepositRial ?? 0, total);
  const dueNow = total - depositApplied;

  const belowFloor = selected?.minimumPriceRial != null && net < selected.minimumPriceRial;

  async function submit() {
    if (!selected) return;
    let tenders: { method: string; amount?: number; paymentMethodId: string; reference?: string }[] = [];
    if (dueNow > 0) {
      const built = paymentDraftBody(paymentDraft, settlementWays, dueNow, unit);
      if (!built.ok) {
        setPaymentError(errorMessage(built.error) || built.error);
        return;
      }
      tenders = built.value.map((slice) => ({
        method: ledgerSettlementFor(settlementWays.find((way) => way.id === slice.methodId)!.settlement)!,
        amount: slice.amount,
        paymentMethodId: slice.methodId,
        reference: slice.reference,
      }));
    }
    setPaymentError("");
    setBusy(true);
    setReceipt(null);
    const result = await run(async () => {
      const closed = await api<{ invoice?: { orderNumber: string; total: string }; error?: string; message?: string }>(
        "/api/sales/invoices",
        {
          method: "POST",
          body: JSON.stringify({
            customerId: customer?.id ?? null,
            // One line, one exact car — the whole point of §3's identity.
            lines: [
              {
                kind: "vehicle",
                serialId: selected.serialId,
                price: priceRial,
                discount: discountRial,
                vatPercent,
                overrideMinPrice: override,
              },
            ],
            tenders,
          }),
        },
      );
      if (closed.ok && closed.data.invoice) {
        setReceipt({ orderNumber: closed.data.invoice.orderNumber, total: closed.data.invoice.total });
      }
      return closed;
    });
    if (result) {
      setSerialId("");
      setCustomer(null);
      setPrice("");
      setDiscount("");
      setOverride(false);
      setPaymentDraft(null);
    }
    setBusy(false);
  }

  async function reverse(vehicle: VehicleListItemDto) {
    const reason = (reversalReason[vehicle.serialId] ?? "").trim();
    if (!reason) return;
    setBusy(true);
    await run(async () => {
      const result = await api<{ error?: string; message?: string }>(
        `/api/automotive/vehicles/${vehicle.serialId}/sale/reverse`,
        { method: "POST", body: JSON.stringify({ reason }) },
      );
      return result;
    });
    setReversalReason((map) => ({ ...map, [vehicle.serialId]: "" }));
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      {canSell ? <SectionCard title="فروش خودرو" description="فاکتور خرده‌فروشی با ردیف خودرو">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="خودرو">
            <select
              className={inputClass}
              value={serialId}
              disabled={vehiclesLoading}
              onChange={(event) => {
                setSerialId(event.target.value);
                const next = sellable.find((vehicle) => vehicle.serialId === event.target.value);
                if (next) {
                  setPrice(toInput(next.askingPriceRial));
                  if (next.reservedForCustomerId && next.reservedForName) {
                    setCustomer({ id: next.reservedForCustomerId, name: next.reservedForName } as PickerCustomer);
                  }
                }
              }}
            >
              <option value="">{vehiclesLoading ? "در حال دریافت خودروها…" : "— انتخاب خودرو —"}</option>
              {sellable.map((vehicle) => (
                <option key={vehicle.serialId} value={vehicle.serialId}>
                  {vehicle.stockNumber} — {vehicle.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="مشتری">
            <CustomerPicker customer={customer} onChange={setCustomer} idPrefix="automotive-sale" canCreate={canCreateCustomer} />
          </Field>
          <Field label={`مبلغ خودرو (${unitLabel})`}>
            <PersianNumberInput
              className={inputClass}
              inputMode="numeric"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
           />
          </Field>
          <Field label={`تخفیف (${unitLabel})`}>
            <PersianNumberInput
              className={inputClass}
              inputMode="numeric"
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
           />
          </Field>
          <Field label="مالیات بر ارزش افزوده">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm" aria-live="polite">
              <span dir="ltr">{vatPercent.toLocaleString("fa-IR")}٪</span>
              <span className="ms-2 text-muted-foreground">طبق تنظیمات مالیات کسب‌وکار</span>
            </div>
          </Field>
        </div>

        {dueNow > 0 ? (
          <div className="mt-3">
            <PaymentWays
              methods={settlementWays}
              draft={paymentDraft}
              onChange={(next) => {
                setPaymentDraft(next);
                setPaymentError("");
              }}
              due={dueNow}
              disabled={busy}
              loaded={paymentWays.loaded}
              loadError={paymentWays.error}
              onReload={paymentWays.reload}
              idPrefix="automotive-sale-pay"
              customer={customer ? { id: customer.id, name: customer.name } : null}
            />
            {paymentError ? <p className="mt-2 text-sm text-rose-700 dark:text-rose-300" role="alert">{paymentError}</p> : null}
          </div>
        ) : null}

        <div className="mt-3 space-y-1 text-sm text-muted-foreground">
          <p>
            جمع فاکتور: <span className="font-medium text-foreground">{money(total)}</span> {unitLabel} (خالص {money(net)} +
            مالیات {money(vat)})
          </p>
          {depositApplied > 0 ? (
            <p>
              بیعانهٔ رزرو کسر می‌شود: {money(depositApplied)} {unitLabel} — مبلغ قابل دریافت امروز{" "}
              <span className="font-medium text-foreground">{money(dueNow)}</span> {unitLabel}
            </p>
          ) : null}
          {selected?.reservedForName ? (
            <p className="text-amber-700 dark:text-amber-300">
              این خودرو برای «{selected.reservedForName}» رزرو شده است؛ فاکتور باید به نام همان مشتری باشد.
            </p>
          ) : null}
          {belowFloor ? (
            <p className="text-rose-700 dark:text-rose-300">
              مبلغ واردشده از حداقل قیمت تعیین‌شده ({money(selected?.minimumPriceRial)} {unitLabel}) کمتر است
              {canSeeCost ? "" : " — برای فروش زیر این حد با مدیر هماهنگ کنید"}.
            </p>
          ) : null}
          {canSeeCost && selected?.effectiveCostRial != null && net > 0 ? (
            <p>حاشیهٔ ناخالص این فروش: {money(net - selected.effectiveCostRial)} {unitLabel}</p>
          ) : null}
        </div>

        {canOverrideMinPrice ? (
          <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />
            مجوز من برای فروش زیر حداقل قیمت استفاده شود
          </label>
        ) : null}
        {dueNow === 0 && depositApplied > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            تمام مبلغ فاکتور از ودیعهٔ قبلی پوشش داده می‌شود؛ امروز وجهی دریافت نمی‌شود.
          </p>
        ) : null}

        <div className="mt-4">
          <PrimaryButton onClick={submit} disabled={busy || !selected || priceRial <= 0}>
            {busy ? "در حال صدور…" : "صدور فاکتور فروش خودرو"}
          </PrimaryButton>
        </div>

        {receipt ? (
          <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">
            فاکتور {receipt.orderNumber} به مبلغ {money(Number(receipt.total))} {unitLabel} صادر شد؛ خودرو فروخته‌شده
            علامت خورده و بیعانهٔ رزرو (در صورت وجود) از فاکتور کسر شده است.
          </p>
        ) : null}
      </SectionCard> : null}

      <SectionCard title="فروخته‌شده‌ها" description={canSell ? "با امکان برگشت فروش" : "فروش‌های ثبت‌شده؛ فقط خواندنی"}>
        {sold.length === 0 ? (
          <EmptyState title="فروشی ثبت نشده">خودروی فروخته‌شده‌ای در این فهرست نیست.</EmptyState>
        ) : (
          <DataTable caption="خودروهای فروخته‌شده">
            <DataTableHead>
              <Th>خودرو</Th>
              {canSeeCost ? <Th>بهای تمام‌شدهٔ منجمد ({unitLabel})</Th> : null}
              <Th>مبلغ فروش ({unitLabel})</Th>
              <Th>تاریخ فروش</Th>
              <Th>وضعیت</Th>
              {canSell ? <Th>برگشت فروش</Th> : null}
            </DataTableHead>
            <DataTableBody>
              {sold.map((vehicle) => (
                <DataTableRow key={vehicle.serialId}>
                  <Td>
                    <div className="font-medium">{vehicle.displayName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{vehicle.stockNumber}</div>
                  </Td>
                  {canSeeCost ? <Td>{money(vehicle.effectiveCostRial)}</Td> : null}
                  <Td>{money(vehicle.soldPriceRial)}</Td>
                  <Td>{vehicle.soldOn ? formatJalali(vehicle.soldOn) : "—"}</Td>
                  <Td>
                    <StatusBadge tone="neutral">{VEHICLE_STATE_LABELS[vehicle.state]}</StatusBadge>
                  </Td>
                  {canSell ? <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputClass} sm:max-w-xs`}
                        aria-label={`دلیل برگشت فروش ${vehicle.stockNumber}`}
                        placeholder="دلیل برگشت"
                        value={reversalReason[vehicle.serialId] ?? ""}
                        onChange={(event) =>
                          setReversalReason((map) => ({ ...map, [vehicle.serialId]: event.target.value }))
                        }
                     />
                      <SecondaryButton
                        onClick={() => reverse(vehicle)}
                        disabled={busy || !(reversalReason[vehicle.serialId] ?? "").trim()}
                      >
                        برگشت فروش
                      </SecondaryButton>
                    </div>
                  </Td> : null}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}

/* ===========================================================================
 * §12 — customers and leads: what each one is looking for
 * ===========================================================================
 *
 * The lead itself is the CRM's, and this section does not duplicate it: it
 * reads `/api/crm/leads` for the list and adds only the car-shaped half —
 * make/model interest, new-or-used, a year and a budget range, trade-in
 * interest, a test drive, and the cars on this lot that lead has been shown.
 *
 * The interesting button is «یافتن خودروهای مناسب»: it asks the *lot* which
 * cars match a lead's stated ranges. That query only exists because the
 * preferences are typed columns rather than a note (migration 0213), and it is
 * the reason a salesperson keeps them filled in.
 */

export interface LeadListDto {
  id: string;
  name: string;
  status: string;
  phone: string | null;
}

export interface LeadVehicleProfileDto {
  leadId: string;
  leadName: string | null;
  leadStatus: string | null;
  phone: string | null;
  preferences: {
    make: string | null;
    model: string | null;
    trim: string | null;
    condition: "new" | "used" | "any";
    vehicleYearCalendar: "jalali" | "gregorian";
    modelYearFrom: number | null;
    modelYearTo: number | null;
    budgetFromRial: number | null;
    budgetToRial: number | null;
    tradeIn: boolean;
    tradeInDescription: string | null;
    testDriveRequestedAt: string | null;
    notes: string | null;
  } | null;
  links: {
    id: string;
    serialId: string;
    stockNumber: string;
    displayName: string;
    purpose: "interest" | "test_drive" | "offer" | "trade_in";
    note: string | null;
    createdAt: string;
  }[];
}

export interface InterestedLeadDto {
  leadId: string;
  leadName: string;
  status: string;
  phone: string | null;
  bestPurpose: "interest" | "test_drive" | "offer" | "trade_in" | null;
  budgetToRial: number | null;
  note: string | null;
}

const LEAD_STATUS_LABELS: Record<string, string> = {
  new: "جدید",
  contacted: "تماس گرفته‌شده",
  working: "در حال پیگیری",
  qualified: "واجد شرایط",
  unqualified: "رد‌شده",
  converted: "تبدیل‌شده",
};

const LINK_PURPOSES = [
  { value: "interest", label: "مورد علاقه" },
  { value: "test_drive", label: "تست درایو" },
  { value: "offer", label: "پیشنهاد قیمت" },
  { value: "trade_in", label: "معاوضه" },
] as const;

const PREFERENCE_CONDITIONS = [
  { value: "any", label: "فرقی نمی‌کند" },
  { value: "new", label: "نو" },
  { value: "used", label: "کارکرده" },
] as const;

function LeadsSection({ vehicles, vehiclesLoading, canManage, run }: { vehicles: VehicleListItemDto[]; vehiclesLoading: boolean; canManage: boolean; run: Runner }) {
  const [leads, setLeads] = useState<LeadListDto[]>([]);
  const [leadId, setLeadId] = useState("");
  const [profile, setProfile] = useState<LeadVehicleProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { unitLabel, toRial, toInput } = useVehicleMoney();

  // Preferences form, seeded from the profile each time one is opened.
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [condition, setCondition] = useState<"new" | "used" | "any">("any");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [budgetFrom, setBudgetFrom] = useState("");
  const [budgetTo, setBudgetTo] = useState("");
  const [tradeIn, setTradeIn] = useState(false);
  const [tradeInDescription, setTradeInDescription] = useState("");
  const [testDrive, setTestDrive] = useState(false);
  const [notes, setNotes] = useState("");

  // The link form: which car was shown, why.
  const [linkSerialId, setLinkSerialId] = useState("");
  const [linkPurpose, setLinkPurpose] = useState<"interest" | "test_drive" | "offer" | "trade_in">("interest");
  const [linkNote, setLinkNote] = useState("");

  // "Which cars suit this lead": asked of the lot, computed on the client from
  // the same rows the stock table shows.
  const [matchOnly, setMatchOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await api<{ leads: LeadListDto[] }>("/api/crm/leads?limit=50");
      if (cancelled) return;
      if (result.ok) setLeads(result.data.leads ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!leadId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await api<{ profile: LeadVehicleProfileDto }>(`/api/automotive/leads/${leadId}`);
      if (cancelled || !result.ok) return;
      const next = result.data.profile;
      setProfile(next);
      const preferences = next.preferences;
      setMake(preferences?.make ?? "");
      setModel(preferences?.model ?? "");
      setCondition(preferences?.condition ?? "any");
      setYearFrom(preferences?.modelYearFrom == null ? "" : String(preferences.modelYearFrom));
      setYearTo(preferences?.modelYearTo == null ? "" : String(preferences.modelYearTo));
      setBudgetFrom(toInput(preferences?.budgetFromRial));
      setBudgetTo(toInput(preferences?.budgetToRial));
      setTradeIn(preferences?.tradeIn ?? false);
      setTradeInDescription(preferences?.tradeInDescription ?? "");
      setTestDrive(preferences?.testDriveRequestedAt != null);
      setNotes(preferences?.notes ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [leadId, toInput]);

  const digits = (value: string) => value.replace(/[^0-9]/g, "");

  async function savePreferences() {
    if (!leadId) return;
    setBusy(true);
    await run(async () => {
      const result = await api<{ error?: string; message?: string }>(`/api/automotive/leads/${leadId}`, {
        method: "PUT",
        body: JSON.stringify({
          make: make || null,
          model: model || null,
          condition,
          modelYearFrom: yearFrom ? Number(yearFrom) : null,
          modelYearTo: yearTo ? Number(yearTo) : null,
          budgetFromRial: budgetFrom ? toRial(budgetFrom) : null,
          budgetToRial: budgetTo ? toRial(budgetTo) : null,
          tradeIn,
          tradeInDescription: tradeInDescription || null,
          // Present means "set (or clear) it", so unticking the box clears a
          // recorded request rather than leaving a stale date behind.
          testDriveRequestedAt: testDrive ? (profile?.preferences?.testDriveRequestedAt ??
            new Date().toISOString()) : null,
          notes: notes || null,
        }),
      });
      return result;
    });
    setBusy(false);
  }

  async function linkVehicle() {
    if (!leadId || !linkSerialId) return;
    setBusy(true);
    await run(async () => {
      const result = await api<{ error?: string; message?: string }>(
        `/api/automotive/vehicles/${linkSerialId}/leads`,
        { method: "POST", body: JSON.stringify({ leadId, purpose: linkPurpose, note: linkNote || null }) },
      );
      return result;
    });
    setLinkSerialId("");
    setLinkNote("");
    setBusy(false);
  }

  async function unlinkVehicle(serialId: string) {
    if (!leadId) return;
    setBusy(true);
    await run(async () => {
      const result = await api<{ error?: string; message?: string }>(
        `/api/automotive/vehicles/${serialId}/leads?leadId=${encodeURIComponent(leadId)}`,
        { method: "DELETE" },
      );
      return result;
    });
    setBusy(false);
  }

  const preferences = profile?.preferences ?? null;
  const matchedVehicles = matchOnly
    ? vehicles.filter((vehicle) => {
        if (!preferences) return false;
        if (preferences.condition !== "any" && preferences.condition !== vehicle.condition) return false;
        if (preferences.make && !vehicle.make.toLowerCase().includes(preferences.make.toLowerCase())) return false;
        if (preferences.model && !vehicle.model.toLowerCase().includes(preferences.model.toLowerCase())) return false;
        if (preferences.modelYearFrom != null && vehicle.modelYear != null && vehicle.modelYear < preferences.modelYearFrom) {
          return false;
        }
        if (preferences.modelYearTo != null && vehicle.modelYear != null && vehicle.modelYear > preferences.modelYearTo) {
          return false;
        }
        if (preferences.budgetToRial != null && vehicle.askingPriceRial > preferences.budgetToRial) return false;
        return true;
      })
    : [];

  return (
    <div className="space-y-4">
      <SectionCard title="سرنخ‌ها و مشتریان" description="چه خودرویی می‌خواهند و چه خودرویی دیده‌اند">
        {loading ? (
          <SectionCardSkeleton />
        ) : leads.length === 0 ? (
          <EmptyState title="سرنخی ثبت نشده">سرنخ‌ها در بخش «مشتریان» ساخته می‌شوند.</EmptyState>
        ) : (
          <Field label="سرنخ">
            <select className={inputClass} value={leadId} onChange={(event) => setLeadId(event.target.value)}>
              <option value="">— انتخاب سرنخ —</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.name} — {LEAD_STATUS_LABELS[lead.status] ?? lead.status}
                </option>
              ))}
            </select>
          </Field>
        )}
      </SectionCard>

      {leadId ? (
        <SectionCard title="خودروی مورد نظر" description="بازه‌ها برای پیشنهاد خودرو به کار می‌روند">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="برند">
              <input className={inputClass} value={make} onChange={(event) => setMake(event.target.value)} disabled={!canManage} />
            </Field>
            <Field label="مدل">
              <input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} disabled={!canManage} />
            </Field>
            <Field label="نو / کارکرده">
              <select
                className={inputClass}
                value={condition}
                disabled={!canManage}
                onChange={(event) => setCondition(event.target.value as "new" | "used" | "any")}
              >
                {PREFERENCE_CONDITIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="از سال مدل">
              <input
                className={inputClass}
                inputMode="numeric"
                value={yearFrom}
                disabled={!canManage}
                onChange={(event) => setYearFrom(digits(event.target.value))}
             />
            </Field>
            <Field label="تا سال مدل">
              <input
                className={inputClass}
                inputMode="numeric"
                value={yearTo}
                disabled={!canManage}
                onChange={(event) => setYearTo(digits(event.target.value))}
             />
            </Field>
            <Field label={`حداقل بودجه (${unitLabel})`}>
              <input
                className={inputClass}
                inputMode="numeric"
                value={budgetFrom}
                disabled={!canManage}
                onChange={(event) => setBudgetFrom(digits(event.target.value))}
             />
            </Field>
            <Field label={`حداکثر بودجه (${unitLabel})`}>
              <input
                className={inputClass}
                inputMode="numeric"
                value={budgetTo}
                disabled={!canManage}
                onChange={(event) => setBudgetTo(digits(event.target.value))}
             />
            </Field>
            <Field label="معاوضه">
              <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={tradeIn} disabled={!canManage} onChange={(event) => setTradeIn(event.target.checked)} />
                خودروی مشتری به‌عنوان معاوضه
              </label>
            </Field>
            <Field label="خودروی معاوضه">
              <input
                className={inputClass}
                value={tradeInDescription}
                disabled={!canManage || !tradeIn}
                onChange={(event) => setTradeInDescription(event.target.value)}
             />
            </Field>
            <Field label="تست درایو">
              <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={testDrive} disabled={!canManage} onChange={(event) => setTestDrive(event.target.checked)} />
                تست درایو درخواست شده است
              </label>
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!canManage} />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {canManage ? <PrimaryButton onClick={savePreferences} disabled={busy}>
              {busy ? "در حال ذخیره…" : "ذخیرهٔ خودروی مورد نظر"}
            </PrimaryButton> : <p className="text-xs text-muted-foreground">دسترسی «مدیریت CRM» برای ویرایش ترجیحات لازم است.</p>}
            <SecondaryButton onClick={() => setMatchOnly((value) => !value)} disabled={!preferences}>
              {matchOnly ? "نمایش همهٔ موجودی" : "یافتن خودروهای مناسب در موجودی"}
            </SecondaryButton>
          </div>
          {matchOnly ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {matchedVehicles.length === 0
                ? "خودرویی در موجودی با این مشخصات و بودجه نیست."
                : `${matchedVehicles.length.toLocaleString("fa-IR")} خودرو با این درخواست می‌خواند.`}
            </p>
          ) : null}
        </SectionCard>
      ) : null}

      {leadId ? (
        <SectionCard title="خودروهای نشان‌داده‌شده" description="کدام شمارهٔ انبار به این مشتری معرفی شده است">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="خودرو">
              <select className={inputClass} value={linkSerialId} disabled={!canManage || vehiclesLoading} onChange={(event) => setLinkSerialId(event.target.value)}>
                <option value="">{vehiclesLoading ? "در حال دریافت خودروها…" : "— انتخاب خودرو —"}</option>
                {(matchOnly ? matchedVehicles : vehicles).map((vehicle) => (
                  <option key={vehicle.serialId} value={vehicle.serialId}>
                    {vehicle.stockNumber} — {vehicle.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="دلیل">
              <select
                className={inputClass}
                value={linkPurpose}
                disabled={!canManage}
                onChange={(event) => setLinkPurpose(event.target.value as typeof linkPurpose)}
              >
                {LINK_PURPOSES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={linkNote} onChange={(event) => setLinkNote(event.target.value)} disabled={!canManage} />
            </Field>
          </div>
          {canManage ? <div className="mt-3">
            <PrimaryButton onClick={linkVehicle} disabled={busy || !linkSerialId}>
              {busy ? "در حال ثبت…" : "ثبت معرفی خودرو"}
            </PrimaryButton>
          </div> : null}

          <div className="mt-4">
            {(profile?.links ?? []).length === 0 ? (
              <EmptyState title="هنوز خودرویی معرفی نشده">با فرم بالا، خودروی معرفی‌شده را ثبت کنید.</EmptyState>
            ) : (
              <DataTable caption="خودروهای نشان‌داده‌شده">
                <DataTableHead>
                  <Th>خودرو</Th>
                  <Th>دلیل</Th>
                  <Th>یادداشت</Th>
                  {canManage ? <Th>حذف</Th> : null}
                </DataTableHead>
                <DataTableBody>
                  {(profile?.links ?? []).map((link) => (
                    <DataTableRow key={link.id}>
                      <Td>
                        <div className="font-medium">{link.displayName}</div>
                        <div className="font-mono text-xs text-muted-foreground">{link.stockNumber}</div>
                      </Td>
                      <Td>
                        {LINK_PURPOSES.find((purpose) => purpose.value === link.purpose)?.label ?? link.purpose}
                      </Td>
                      <Td>{link.note ?? "—"}</Td>
                      {canManage ? <Td>
                        <SecondaryButton onClick={() => unlinkVehicle(link.serialId)} disabled={busy}>
                          حذف
                        </SecondaryButton>
                      </Td> : null}
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            )}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

export function AutomotiveManagerFallback() {
  return (
    <div className="space-y-4">
      <SectionCardSkeleton />
      <SectionCardSkeleton />
    </div>
  );
}

export { SecondaryButton, ErrorBox };
