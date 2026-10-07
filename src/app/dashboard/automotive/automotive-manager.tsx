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
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ErrorBox, Field, PrimaryButton, SecondaryButton, errorMessage, inputClass } from "../ui";
import { IndustryManagerShell, type Runner, type ManagerTab } from "../industry-manager-shell";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { FilterChip, FilterChipRow, FilterToolbar, FilterToolbarSearch, SearchField } from "../filters";
import { VEHICLE_STATE_LABELS, VEHICLE_CONDITION_LABELS, type VehicleState } from "@/lib/automotive";
import { formatJalali } from "@/lib/jalali";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { JalaliDatePicker } from "../jalali-date-picker";

type SectionKey = "overview" | "stock" | "acquire" | "reservations" | "sales" | "expenses";

const TABS: readonly ManagerTab<SectionKey>[] = [
  { key: "overview", label: "نمای کلی" },
  { key: "stock", label: "موجودی خودرو" },
  { key: "acquire", label: "ثبت و خرید خودرو" },
  { key: "reservations", label: "رزروها" },
  { key: "sales", label: "فروش خودرو" },
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

interface OverviewDto {
  onDate: string;
  canSeeCost?: boolean;
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
  };
}

function money(value: number | undefined | null): string {
  if (value == null) return "—";
  return value.toLocaleString("fa-IR");
}

export function AutomotiveManager({ canSeeCost }: { canSeeCost: boolean }) {
  const [section, setSection] = useState<SectionKey>("overview");
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [vehicles, setVehicles] = useState<VehicleListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const [search, setSearch] = useState("");
  const [condition, setCondition] = useState<"all" | "new" | "used">("all");
  const [stateFilter, setStateFilter] = useState<"available" | "reserved" | "sold" | "all">("available");

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (condition !== "all") params.set("condition", condition);
    if (stateFilter === "available") params.set("states", "draft,acquired,in_stock");
    else if (stateFilter !== "all") params.set("states", stateFilter);

    void (async () => {
      const [overviewResult, stockResult] = await Promise.all([
        api<OverviewDto>("/api/automotive/overview"),
        api<{ total: number; vehicles: VehicleListItemDto[] }>(`/api/automotive/vehicles?${params.toString()}`),
      ]);
      if (cancelled) return;
      if (overviewResult.ok) setOverview(overviewResult.data);
      if (stockResult.ok) setVehicles(stockResult.data.vehicles ?? []);
      if (!overviewResult.ok && !stockResult.ok) setError(errorMessage(stockResult.data as never) || "خطا در دریافت داده‌ها");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [search, condition, stateFilter, reloadKey]);

  const soldThisMonth = useMemo(() => overview?.summary.sold ?? 0, [overview]);

  return (
    <IndustryManagerShell
      idPrefix="automotive"
      navLabel="بخش‌های نمایشگاه"
      tabs={TABS}
      activeTab={section}
      onTabChange={setSection}
      error={error}
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
              <KpiCard label="فروش‌رفته (این دوره)" value={String(soldThisMonth)} />
              <KpiCard
                label="میانگین روز در انبار"
                value={overview?.summary.averageAgeDays == null ? "—" : String(overview.summary.averageAgeDays)}
              />
              {canSeeCost ? (
                <>
                  <KpiCard label="ارزش موجودی (ریال)" value={money(overview?.summary.stockValueRial)} />
                  <KpiCard label="حاشیهٔ بالقوه (ریال)" value={money(overview?.summary.potentialMarginRial)} />
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
            <FilterToolbarSearch
              value={search}
              onChange={setSearch}
              label="جست‌وجوی خودرو"
              placeholder="شماره شاسی، VIN، شماره انبار، پلاک، برند/مدل یا نام مشتری"
            />
            <FilterChipRow label="وضعیت">
              {(
                [
                  ["available", "قابل فروش"],
                  ["reserved", "رزرو"],
                  ["sold", "فروخته‌شده"],
                  ["all", "همه"],
                ] as const
              ).map(([value, label]) => (
                <FilterChip key={value} selected={stateFilter === value} onClick={() => setStateFilter(value)}>
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
                <FilterChip key={value} selected={condition === value} onClick={() => setCondition(value)}>
                  {label}
                </FilterChip>
              ))}
            </FilterChipRow>
          </FilterToolbar>

          {loading ? (
            <SectionCardSkeleton />
          ) : vehicles.length === 0 ? (
            <EmptyState title="خودرویی یافت نشد">با این فیلترها خودرویی در موجودی نیست.</EmptyState>
          ) : (
            <DataTable caption="موجودی خودرو">
              <DataTableHead>
                <DataTableRow>
                  <Th>شماره انبار</Th>
                  <Th>خودرو</Th>
                  <Th>نوع</Th>
                  <Th>کارکرد</Th>
                  {canSeeCost ? <Th>بهای خرید</Th> : null}
                  {canSeeCost ? <Th>بهای تمام‌شده</Th> : null}
                  <Th>قیمت فروش</Th>
                  {canSeeCost ? <Th>حاشیهٔ بالقوه</Th> : null}
                  <Th>روز در انبار</Th>
                  <Th>وضعیت</Th>
                  <Th>شعبه</Th>
                </DataTableRow>
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
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </div>
      ) : null}

      {section === "acquire" ? (
        <div role="tabpanel" id="automotive-panel-acquire" aria-labelledby="automotive-tab-acquire">
          <AcquireSection run={run} />
        </div>
      ) : null}

      {section === "reservations" ? (
        <div
          role="tabpanel"
          id="automotive-panel-reservations"
          aria-labelledby="automotive-tab-reservations"
        >
          <ReservationsSection vehicles={vehicles} run={run} />
        </div>
      ) : null}

      {section === "sales" ? (
        <div role="tabpanel" id="automotive-panel-sales" aria-labelledby="automotive-tab-sales">
          <SalesSection vehicles={vehicles} canSeeCost={canSeeCost} run={run} />
        </div>
      ) : null}

      {section === "expenses" ? (
        <div role="tabpanel" id="automotive-panel-expenses" aria-labelledby="automotive-tab-expenses">
          <ExpensesSection vehicles={vehicles} run={run} />
        </div>
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

function AcquireSection({ run }: { run: Runner }) {
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
          acquisition: {
            date: acquisitionDate,
            source: acquisitionSource,
            costRial: Number(purchaseCost || 0),
            settlement,
          },
          askingPriceRial: Number(askingPrice || 0),
          minimumPriceRial: minimumPrice ? Number(minimumPrice) : null,
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
        <Field label="نحوهٔ خرید">
          <select className={inputClass} value={acquisitionSource} onChange={(event) => setAcquisitionSource(event.target.value)}>
            {ACQUISITION_SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تاریخ خرید (YYYY-MM-DD)">
          <input className={inputClass} value={acquisitionDate} onChange={(event) => setAcquisitionDate(event.target.value)} />
        </Field>
        <Field label="بهای خرید (ریال)">
          <input className={inputClass} inputMode="numeric" value={purchaseCost} onChange={(event) => setPurchaseCost(event.target.value)} />
        </Field>
        <Field label="طرف حساب پرداخت">
          <select className={inputClass} value={settlement} onChange={(event) => setSettlement(event.target.value)}>
            {SETTLEMENTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="قیمت فروش (ریال)">
          <input className={inputClass} inputMode="numeric" value={askingPrice} onChange={(event) => setAskingPrice(event.target.value)} />
        </Field>
        <Field label="حداقل قیمت (ریال)">
          <input className={inputClass} inputMode="numeric" value={minimumPrice} onChange={(event) => setMinimumPrice(event.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <PrimaryButton onClick={submit} disabled={busy || !make.trim() || !model.trim()}>
          {busy ? "در حال ثبت…" : "ثبت خودرو"}
        </PrimaryButton>
        <span className="text-xs text-muted-foreground">
          بهای تمام‌شدهٔ مؤثر = بهای خرید + هزینه‌های سرمایه‌ای خودرو.
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

function ExpensesSection({ vehicles, run }: { vehicles: VehicleListItemDto[]; run: Runner }) {
  const [serialId, setSerialId] = useState("");
  const [category, setCategory] = useState("repair");
  const [posting, setPosting] = useState<"capitalized" | "period_expense">("capitalized");
  const [amount, setAmount] = useState("");
  const [incurredOn, setIncurredOn] = useState("");
  const [settlement, setSettlement] = useState("payable");
  const [documentRef, setDocumentRef] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = vehicles.find((vehicle) => vehicle.serialId === serialId);

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
            amountRial: Number(amount || 0),
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
          <select className={inputClass} value={serialId} onChange={(event) => setSerialId(event.target.value)}>
            <option value="">— انتخاب خودرو —</option>
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
        <Field label="مبلغ (ریال)">
          <input className={inputClass} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="تاریخ (YYYY-MM-DD)">
          <input className={inputClass} value={incurredOn} onChange={(event) => setIncurredOn(event.target.value)} />
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
          {selected.effectiveCostRial != null ? ` · بهای تمام‌شدهٔ مؤثر فعلی: ${money(selected.effectiveCostRial)} ریال` : ""}
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

function ReservationsSection({ vehicles, run }: { vehicles: VehicleListItemDto[]; run: Runner }) {
  const [reservations, setReservations] = useState<VehicleReservationDto[]>([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await api<{ reservations: VehicleReservationDto[] }>("/api/automotive/reservations");
      if (cancelled) return;
      if (result.ok) setReservations(result.data.reservations ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reservable = vehicles.filter((vehicle) => vehicle.state === "in_stock" || vehicle.state === "acquired");
  const depositRial = Math.max(0, Math.trunc(Number(deposit || 0)));

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
      <SectionCard title="رزرو خودرو برای مشتری" description="یک خودرو، یک مشتری، تا یک تاریخ">
        <p className="text-xs leading-5 text-muted-foreground">
          خودروی رزروشده تا وقتی رزرو فعال است به نام مشتری دیگری فروخته نمی‌شود؛ ودیعهٔ دریافتی به حساب
          «پیش‌دریافت از مشتری» می‌رود (نه درآمد) و هنگام فروش به همان مشتری از فاکتور کسر می‌شود. رزروی که
          تاریخش گذشته باشد، خودبه‌خود منقضی می‌شود و مانع فروش نمی‌ماند.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="خودرو">
            <select className={inputClass} value={serialId} onChange={(event) => setSerialId(event.target.value)}>
              <option value="">— انتخاب خودرو —</option>
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
          <Field label="ودیعه (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={deposit}
              onChange={(event) => setDeposit(event.target.value.replace(/[^0-9]/g, ""))}
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
      </SectionCard>

      <SectionCard title="رزروهای فعال" description={`${active.length.toLocaleString("fa-IR")} رزرو باز`}>
        {loading ? (
          <SectionCardSkeleton />
        ) : active.length === 0 ? (
          <EmptyState title="رزرو فعالی نیست">همهٔ خودروهای این شعبه آزادند.</EmptyState>
        ) : (
          <DataTable caption="رزروهای فعال">
            <DataTableHead>
              <DataTableRow>
                <Th>خودرو</Th>
                <Th>مشتری</Th>
                <Th>تا تاریخ</Th>
                <Th>ودیعه</Th>
                <Th>استرداد</Th>
                <Th>آزادسازی</Th>
              </DataTableRow>
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
                    {money(reservation.depositRial)} ریال
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
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputClass} sm:max-w-xs`}
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
              <DataTableRow>
                <Th>خودرو</Th>
                <Th>مشتری</Th>
                <Th>وضعیت</Th>
                <Th>ودیعه</Th>
                <Th>دلیل آزادسازی</Th>
              </DataTableRow>
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
                    <Td>{money(reservation.depositRial)} ریال</Td>
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

const VAT_RATES = [0, 6, 9, 10];

function SalesSection({
  vehicles,
  canSeeCost,
  run,
}: {
  vehicles: VehicleListItemDto[];
  canSeeCost: boolean;
  run: Runner;
}) {
  const [serialId, setSerialId] = useState("");
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [vatPercent, setVatPercent] = useState(9);
  const [tenderMethod, setTenderMethod] = useState<"cash" | "bank" | "credit">("cash");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ orderNumber: string; total: string } | null>(null);
  const [reversalReason, setReversalReason] = useState<Record<string, string>>({});

  const sellable = vehicles.filter((vehicle) => vehicle.state === "in_stock" || vehicle.state === "reserved");
  const sold = vehicles.filter((vehicle) => vehicle.state === "sold");
  const selected = sellable.find((vehicle) => vehicle.serialId === serialId);

  const priceRial = Math.max(0, Math.trunc(Number(price || 0)));
  const discountRial = Math.max(0, Math.trunc(Number(discount || 0)));
  const net = Math.max(0, priceRial - discountRial);
  const vat = Math.round((net * vatPercent) / 100);
  const total = net + vat;
  // The deposit the customer paid when they reserved is *applied*, not
  // collected again: what is still due today is the invoice less that money.
  const depositApplied = Math.min(selected?.reservedDepositRial ?? 0, total);
  const dueNow = total - depositApplied;

  const belowFloor =
    selected?.minimumPriceRial != null && priceRial < selected.minimumPriceRial && discountRial === 0;

  async function submit() {
    if (!selected) return;
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
            tenders: [{ method: tenderMethod, amount: dueNow }],
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
      <SectionCard title="فروش خودرو" description="فاکتور خرده‌فروشی با ردیف خودرو">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="خودرو">
            <select
              className={inputClass}
              value={serialId}
              onChange={(event) => {
                setSerialId(event.target.value);
                const next = sellable.find((vehicle) => vehicle.serialId === event.target.value);
                if (next) {
                  setPrice(String(next.askingPriceRial || ""));
                  if (next.reservedForCustomerId && next.reservedForName) {
                    setCustomer({ id: next.reservedForCustomerId, name: next.reservedForName } as PickerCustomer);
                  }
                }
              }}
            >
              <option value="">— انتخاب خودرو —</option>
              {sellable.map((vehicle) => (
                <option key={vehicle.serialId} value={vehicle.serialId}>
                  {vehicle.stockNumber} — {vehicle.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="مشتری">
            <CustomerPicker customer={customer} onChange={setCustomer} idPrefix="automotive-sale" />
          </Field>
          <Field label="مبلغ خودرو (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={price}
              onChange={(event) => setPrice(event.target.value.replace(/[^0-9]/g, ""))}
            />
          </Field>
          <Field label="تخفیف (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={discount}
              onChange={(event) => setDiscount(event.target.value.replace(/[^0-9]/g, ""))}
            />
          </Field>
          <Field label="مالیات بر ارزش افزوده (٪)">
            <select
              className={inputClass}
              value={String(vatPercent)}
              onChange={(event) => setVatPercent(Number(event.target.value))}
            >
              {VAT_RATES.map((rate) => (
                <option key={rate} value={String(rate)}>
                  {rate.toLocaleString("fa-IR")}٪
                </option>
              ))}
            </select>
          </Field>
          <Field label="روش پرداخت">
            <select
              className={inputClass}
              value={tenderMethod}
              onChange={(event) => setTenderMethod(event.target.value as "cash" | "bank" | "credit")}
            >
              <option value="cash">نقدی</option>
              <option value="bank">کارت‌خوان / بانکی</option>
              <option value="credit">نسیه (حساب مشتری)</option>
            </select>
          </Field>
        </div>

        <div className="mt-3 space-y-1 text-sm text-muted-foreground">
          <p>
            جمع فاکتور: <span className="font-medium text-foreground">{money(total)}</span> ریال (خالص {money(net)} +
            مالیات {money(vat)})
          </p>
          {depositApplied > 0 ? (
            <p>
              بیعانهٔ رزرو کسر می‌شود: {money(depositApplied)} ریال — مبلغ قابل دریافت امروز{" "}
              <span className="font-medium text-foreground">{money(dueNow)}</span> ریال
            </p>
          ) : null}
          {selected?.reservedForName ? (
            <p className="text-amber-700 dark:text-amber-300">
              این خودرو برای «{selected.reservedForName}» رزرو شده است؛ فاکتور باید به نام همان مشتری باشد.
            </p>
          ) : null}
          {belowFloor ? (
            <p className="text-rose-700 dark:text-rose-300">
              مبلغ واردشده از حداقل قیمت تعیین‌شده ({money(selected?.minimumPriceRial)} ریال) کمتر است
              {canSeeCost ? "" : " — برای فروش زیر این حد با مدیر هماهنگ کنید"}.
            </p>
          ) : null}
          {canSeeCost && selected?.effectiveCostRial != null && net > 0 ? (
            <p>حاشیهٔ ناخالص این فروش: {money(net - selected.effectiveCostRial)} ریال</p>
          ) : null}
        </div>

        {canSeeCost ? (
          <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />
            فروش زیر حداقل قیمت مجاز است (تجاوز از حداقل قیمت)
          </label>
        ) : null}

        <div className="mt-4">
          <PrimaryButton onClick={submit} disabled={busy || !selected || priceRial <= 0 || dueNow <= 0}>
            {busy ? "در حال صدور…" : "صدور فاکتور فروش خودرو"}
          </PrimaryButton>
        </div>

        {receipt ? (
          <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">
            فاکتور {receipt.orderNumber} به مبلغ {money(Number(receipt.total))} ریال صادر شد؛ خودرو فروخته‌شده
            علامت خورده و بیعانهٔ رزرو (در صورت وجود) از فاکتور کسر شده است.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="فروخته‌شده‌ها" description="با امکان برگشت فروش">
        {sold.length === 0 ? (
          <EmptyState title="فروشی ثبت نشده">خودروی فروخته‌شده‌ای در این فهرست نیست.</EmptyState>
        ) : (
          <DataTable caption="خودروهای فروخته‌شده">
            <DataTableHead>
              <DataTableRow>
                <Th>خودرو</Th>
                {canSeeCost ? <Th>بهای تمام‌شدهٔ منجمد</Th> : null}
                <Th>مبلغ فروش</Th>
                <Th>تاریخ فروش</Th>
                <Th>وضعیت</Th>
                <Th>برگشت فروش</Th>
              </DataTableRow>
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
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputClass} sm:max-w-xs`}
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
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
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
