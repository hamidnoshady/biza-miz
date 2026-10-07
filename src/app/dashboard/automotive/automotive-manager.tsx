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
import { api, ErrorBox, Field, PrimaryButton, SecondaryButton, errorMessage } from "../ui";
import { IndustryManagerShell, type Runner, type ManagerTab } from "../industry-manager-shell";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { FilterChip, FilterChipRow, FilterToolbar, FilterToolbarSearch, SearchField } from "../filters";
import { VEHICLE_STATE_LABELS, VEHICLE_CONDITION_LABELS, type VehicleState } from "@/lib/automotive";

type SectionKey = "overview" | "stock" | "acquire" | "expenses";

const TABS: readonly ManagerTab<SectionKey>[] = [
  { key: "overview", label: "نمای کلی" },
  { key: "stock", label: "موجودی خودرو" },
  { key: "acquire", label: "ثبت و خرید خودرو" },
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
  reservedUntil: string | null;
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
          <input className="input" value={make} onChange={(event) => setMake(event.target.value)} />
        </Field>
        <Field label="مدل">
          <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
        </Field>
        <Field label="تیپ / نسخه">
          <input className="input" value={trim} onChange={(event) => setTrim(event.target.value)} />
        </Field>
        <Field label="سال ساخت (مدل) — شمسی">
          <input className="input" inputMode="numeric" value={modelYear} onChange={(event) => setModelYear(event.target.value)} />
        </Field>
        <Field label="وضعیت">
          <select className="input" value={condition} onChange={(event) => setCondition(event.target.value as "new" | "used")}>
            <option value="new">نو</option>
            <option value="used">کارکرده</option>
          </select>
        </Field>
        <Field label="شماره شاسی (VIN)">
          <input className="input" value={vin} onChange={(event) => setVin(event.target.value)} />
        </Field>
        <Field label="شماره شاسی/تنه">
          <input className="input" value={chassisNumber} onChange={(event) => setChassisNumber(event.target.value)} />
        </Field>
        <Field label="شماره انبار">
          <input
            className="input"
            value={stockNumber}
            onChange={(event) => setStockNumber(event.target.value)}
            placeholder="خالی بگذارید تا خودکار شماره‌گذاری شود"
          />
        </Field>
        <Field label="پلاک">
          <input className="input" value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} />
        </Field>
        {condition === "used" ? (
          <>
            <Field label="کارکرد (کیلومتر)">
              <input className="input" inputMode="numeric" value={mileageKm} onChange={(event) => setMileageKm(event.target.value)} />
            </Field>
            <Field label="تعداد مالکان قبلی">
              <input
                className="input"
                inputMode="numeric"
                value={priorOwners}
                onChange={(event) => setPriorOwners(event.target.value)}
              />
            </Field>
          </>
        ) : null}
        <Field label="نحوهٔ خرید">
          <select className="input" value={acquisitionSource} onChange={(event) => setAcquisitionSource(event.target.value)}>
            {ACQUISITION_SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تاریخ خرید (YYYY-MM-DD)">
          <input className="input" value={acquisitionDate} onChange={(event) => setAcquisitionDate(event.target.value)} />
        </Field>
        <Field label="بهای خرید (ریال)">
          <input className="input" inputMode="numeric" value={purchaseCost} onChange={(event) => setPurchaseCost(event.target.value)} />
        </Field>
        <Field label="طرف حساب پرداخت">
          <select className="input" value={settlement} onChange={(event) => setSettlement(event.target.value)}>
            {SETTLEMENTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="قیمت فروش (ریال)">
          <input className="input" inputMode="numeric" value={askingPrice} onChange={(event) => setAskingPrice(event.target.value)} />
        </Field>
        <Field label="حداقل قیمت (ریال)">
          <input className="input" inputMode="numeric" value={minimumPrice} onChange={(event) => setMinimumPrice(event.target.value)} />
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
          <select className="input" value={serialId} onChange={(event) => setSerialId(event.target.value)}>
            <option value="">— انتخاب خودرو —</option>
            {vehicles.map((vehicle) => (
              <option key={vehicle.serialId} value={vehicle.serialId}>
                {vehicle.stockNumber} — {vehicle.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="نوع هزینه">
          <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
            {EXPENSE_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="اثر حسابداری">
          <select
            className="input"
            value={posting}
            onChange={(event) => setPosting(event.target.value as "capitalized" | "period_expense")}
          >
            <option value="capitalized">سرمایه‌ای — افزودن به بهای تمام‌شدهٔ خودرو</option>
            <option value="period_expense">هزینهٔ دوره — بازسازی و آماده‌سازی</option>
          </select>
        </Field>
        <Field label="مبلغ (ریال)">
          <input className="input" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="تاریخ (YYYY-MM-DD)">
          <input className="input" value={incurredOn} onChange={(event) => setIncurredOn(event.target.value)} />
        </Field>
        <Field label="پرداخت">
          <select className="input" value={settlement} onChange={(event) => setSettlement(event.target.value)}>
            <option value="payable">بستانکار (پرداختنی)</option>
            <option value="cash">نقدی</option>
            <option value="bank">بانکی</option>
            <option value="clearing">از حساب واسط حمل/ترخیص</option>
          </select>
        </Field>
        <Field label="شماره سند">
          <input className="input" value={documentRef} onChange={(event) => setDocumentRef(event.target.value)} />
        </Field>
        <Field label="توضیح">
          <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
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

export function AutomotiveManagerFallback() {
  return (
    <div className="space-y-4">
      <SectionCardSkeleton />
      <SectionCardSkeleton />
    </div>
  );
}

export { SecondaryButton, ErrorBox };
