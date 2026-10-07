"use client";

import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, FilterIcon, RefreshCwIcon, SearchIcon, ShoppingBagIcon, XIcon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { formatModifierDelta, linePriceBreakdown } from "@/lib/modifier-display";
import { formatQueueLabel } from "@/lib/orders";
import { paymentMethodLabel } from "@/lib/receipt-template";
import type { ShiftOrder, ShiftOrderLine } from "@/lib/shift-orders";
import { ModifierBadges } from "../modifier-badges";
import { Button } from "@/components/ui/button";
import { api, inputClass } from "../ui";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "../jalali-date-picker";
import { BusinessDayRangePresets } from "./business-day-range";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** Mirrors shift-orders-service.ts's ShiftOrdersReport — declared here rather than imported so the client bundle never reaches a module that imports db.ts. */
interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

interface ShiftOrdersReport {
  shift: ShiftOption | null;
  shifts: ShiftOption[];
  orders: ShiftOrder[];
  totalCount: number;
  totalAmount: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const STATUS_LABELS: Record<string, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};

const TYPE_LABELS: Record<ShiftOrder["type"], string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";
  return new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** A picker option spans days, so unlike timeLabel it carries the Jalali date — same wording the shift history tab uses for an open shift. */
function shiftLabel(shift: ShiftOption): string {
  const start = toPersianDigits(formatJalali(shift.startedAt, { withMonthName: true, withTime: true }));
  // Include the date when a shift crosses midnight; showing only the end time
  // made a 23:00–01:00 shift look like it ended before it started.
  const end = shift.endedAt
    ? toPersianDigits(formatJalali(shift.endedAt, { withMonthName: true, withTime: true }))
    : "در حال انجام";
  return `${shift.employeeName} · ${start} تا ${end}`;
}

/** «تخفیف» reads differently when it was a percentage — the rate is what the reviewer is checking, not just the money it came to. */
function discountLabel(order: ShiftOrder): string {
  if (order.discountType === "percent" && order.discountValue !== null) {
    return `تخفیف (${toPersianDigits(order.discountValue)}٪)`;
  }
  return "تخفیف";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/** Everything about the order that isn't a line or an amount: who, where, when. */
function OrderFacts({ order }: { order: ShiftOrder }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
      <Fact label="نوع" value={TYPE_LABELS[order.type]} />
      {order.tableName ? <Fact label="میز" value={order.tableName} /> : null}
      {order.guestCount ? <Fact label="تعداد نفرات" value={toPersianDigits(order.guestCount)} /> : null}
      {order.customerName ? <Fact label="مشتری" value={order.customerName} /> : null}
      <Fact label="ساعت ثبت" value={toPersianDigits(timeLabel(order.openedAt))} />
      {order.closedAt ? <Fact label="ساعت تسویه" value={toPersianDigits(timeLabel(order.closedAt))} /> : null}
      {order.openedByName ? <Fact label="ثبت‌کننده" value={order.openedByName} /> : null}
      {order.closedByName ? <Fact label="تسویه‌کننده" value={order.closedByName} /> : null}
      {order.amendedAt ? (
        <Fact label="اصلاح‌شده" value={toPersianDigits(timeLabel(order.amendedAt))} />
      ) : null}
    </dl>
  );
}

/**
 * One line of the order, whole: what was sold, the add-ons that were rung in
 * with it and what each cost, the unit price they add up to, and any note or
 * void reason recorded against it. The add-on chips are the same
 * `ModifierBadges` the POS cart and the order dialog draw, so an add-on reads
 * identically wherever it is shown.
 */
function LineRow({ line }: { line: ShiftOrderLine }) {
  const money = useMoney();
  const breakdown = linePriceBreakdown({
    unitPrice: line.unitPrice,
    modifierDeltas: line.modifiers.map((modifier) => modifier.priceDelta),
    quantity: line.quantity,
  });

  return (
    <DataTableRow className="align-top">
      <Td>
        <span className={line.voided ? "text-muted-foreground line-through" : "text-foreground"}>{line.name}</span>
        {line.voided ? <span className="ms-2 text-[11px] font-bold text-destructive">باطل‌شده</span> : null}
        <ModifierBadges modifiers={line.modifiers} tone="amber" className="mt-1.5" />
        <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
          {`هر واحد: ${money.format(breakdown.base)}`}
          {breakdown.addOns !== 0
            ? ` ${formatModifierDelta(breakdown.addOns, { withUnit: false, unit: money.unit })} = ${money.format(breakdown.unit)}`
            : ""}
        </p>
        {line.note ? <p className="mt-1 text-xs text-muted-foreground">یادداشت: {line.note}</p> : null}
        {line.voidReason ? (
          <p className="mt-1 text-xs text-destructive">دلیل ابطال: {line.voidReason}</p>
        ) : null}
      </Td>
      <Td numeric muted>×{toPersianDigits(line.quantity)}</Td>
      <Td numeric muted>{money.format(line.amount)}</Td>
    </DataTableRow>
  );
}

function LineTable({ lines }: { lines: ShiftOrderLine[] }) {
  if (lines.length === 0) return null;
  return (
    <DataTable
      caption="اقلام این سفارش"
      frame={false}
      className="-mx-1 px-1"
      tableClassName="min-w-[28rem]"
    >
      <DataTableHead>
        <Th>قلم</Th>
        <Th numeric>تعداد</Th>
        <Th numeric>مبلغ</Th>
      </DataTableHead>
      <DataTableBody>
        {lines.map((line) => (
          <LineRow key={line.itemId} line={line} />
        ))}
      </DataTableBody>
    </DataTable>
  );
}

function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-xs tabular-nums ${accent ? "font-bold text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The bill's arithmetic, in the same order and wording as the order dialog's
 * own summary — a reviewer comparing the two should never have to translate
 * between them. Zero-valued rows are dropped so a plain cash order stays two
 * lines long.
 */
function MoneySummary({ order }: { order: ShiftOrder }) {
  const money = useMoney();
  return (
    <dl className="space-y-1.5 rounded-xl border border-border bg-card px-3 py-2.5">
      <Row label="جمع جزء" value={money.format(order.subtotal)} />
      {order.addOnTotal !== 0 ? (
        <Row label="از این مبلغ، افزودنی‌ها" value={formatModifierDelta(order.addOnTotal, { unit: money.unit })} accent />
      ) : null}
      {order.discount > 0 ? (
        <Row label={discountLabel(order)} value={`- ${money.format(order.discount)}`} />
      ) : null}
      {order.serviceCharge > 0 ? <Row label="هزینهٔ خدمات" value={money.format(order.serviceCharge)} /> : null}
      {order.tax > 0 ? <Row label="مالیات" value={money.format(order.tax)} /> : null}
      {order.tipAmount > 0 ? <Row label="انعام" value={money.format(order.tipAmount)} /> : null}
      <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-2">
        <dt className="text-xs font-bold text-foreground">جمع کل</dt>
        <dd className="text-sm font-bold tabular-nums text-amber-700 dark:text-amber-300">{money.format(order.total)}</dd>
      </div>
    </dl>
  );
}

function NotePanel({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        danger ? "border-destructive/30 bg-destructive/5" : "border-border bg-card"
      }`}
    >
      <p className={`text-[11px] font-semibold ${danger ? "text-destructive" : "text-muted-foreground"}`}>{label}</p>
      <p className="mt-0.5 text-xs leading-6 text-muted-foreground">{value}</p>
    </div>
  );
}

/**
 * One order of the shift, collapsed to its header until opened and then shown
 * in full: its facts, its live lines with their add-ons, the lines that were
 * voided, the money breakdown, and how it was tendered.
 */
function OrderCard({ order }: { order: ShiftOrder }) {
  const money = useMoney();
  const [expanded, setExpanded] = useState(false);
  const panelId = `shift-order-lines-${order.id}`;
  const liveLines = order.lines.filter((line) => !line.voided);
  const voidedLines = order.lines.filter((line) => line.voided);

  return (
    <li className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex min-h-[64px] w-full items-center justify-between gap-3 px-4 py-3 text-start transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDownIcon
            className={`size-4 shrink-0 text-amber-700 dark:text-amber-300 transition-transform ${expanded ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-foreground">
                {toPersianDigits(formatQueueLabel(order.type, order.orderNumber))}
              </span>
              <span className="inline-flex min-h-6 items-center rounded-lg bg-amber-100 dark:bg-amber-500/20 px-2 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                {STATUS_LABELS[order.status] ?? order.status}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {TYPE_LABELS[order.type]}
              {order.tableName ? ` · ${order.tableName}` : ""}
              {order.customerName ? ` · ${order.customerName}` : ""}
              {` · ${timeLabel(order.openedAt)}`}
              {` · ${toPersianDigits(order.itemCount)} قلم`}
            </p>
          </div>
        </div>
        <span className="shrink-0 text-sm font-bold text-amber-700 dark:text-amber-300">{money.format(order.total)}</span>
      </button>

      {expanded ? (
        <div id={panelId} className="space-y-4 border-t border-border bg-muted px-4 py-3">
          <OrderFacts order={order} />

          {order.lines.length === 0 ? (
            <p className="text-xs leading-6 text-muted-foreground">قلمی برای این سفارش ثبت نشده است.</p>
          ) : (
            <>
              <LineTable lines={liveLines} />
              {voidedLines.length > 0 ? (
                <div>
                  <p className="mb-1 text-[11px] font-bold text-destructive">
                    اقلام باطل‌شده ({toPersianDigits(voidedLines.length)} مورد)
                  </p>
                  <LineTable lines={voidedLines} />
                </div>
              ) : null}
            </>
          )}

          <MoneySummary order={order} />

          {order.payments.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold text-muted-foreground">پرداخت‌ها</p>
              <ul className="space-y-1">
                {order.payments.map((payment, index) => (
                  <li
                    key={`${payment.receivedAt}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
                  >
                    <span className="min-w-0 font-semibold text-foreground">
                      {payment.methodName ?? paymentMethodLabel(payment.method)}
                      <span className="ms-2 font-normal text-muted-foreground">
                        {toPersianDigits(timeLabel(payment.receivedAt))}
                        {payment.receivedByName ? ` · ${payment.receivedByName}` : ""}
                        {payment.reference ? ` · ${payment.reference}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums text-amber-700 dark:text-amber-300">
                      {money.format(payment.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {order.note ? <NotePanel label="یادداشت سفارش" value={order.note} /> : null}
          {order.voidedReason ? (
            <NotePanel label="دلیل ابطال سفارش" value={order.voidedReason} danger />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

interface FilterState {
  shift: "latest" | "all" | string;
  from: string;
  to: string;
  orderNumber: string;
  customer: string;
  status: string;
  type: string;
  page: number;
}

const DEFAULT_FILTERS: FilterState = { shift: "latest", from: "", to: "", orderNumber: "", customer: "", status: "", type: "", page: 1 };

function FilterFields({ filters, setFilters, shifts, disabled }: {
  filters: FilterState;
  setFilters: (next: FilterState) => void;
  shifts: ShiftOption[];
  disabled: boolean;
}) {
  const patch = (value: Partial<FilterState>) => setFilters({ ...filters, ...value, page: 1 });
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">شیفت</span>
        <SearchableSelect
          className={`${inputClass} w-full text-xs`}
          ariaLabel="انتخاب شیفت"
          value={filters.shift}
          onChange={(shift) => patch({ shift })}
          disabled={disabled}
          options={[
            { value: "latest", label: "آخرین شیفت" },
            { value: "all", label: "همه شیفت‌ها" },
            ...shifts.map((option) => ({ value: option.id, label: shiftLabel(option) })),
          ]}
        />
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">شماره سفارش</span>
        <input className={`${inputClass} w-full`} dir="ltr" inputMode="numeric" value={filters.orderNumber}
          onChange={(event) => patch({ orderNumber: event.target.value })} placeholder="#۱۲۳۴" />
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">نام مشتری</span>
        <input className={`${inputClass} w-full`} value={filters.customer}
          onChange={(event) => patch({ customer: event.target.value })} placeholder="بخشی از نام مشتری" />
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">وضعیت سفارش</span>
        <select className={`${inputClass} w-full`} value={filters.status} onChange={(event) => patch({ status: event.target.value })}>
          <option value="">همه وضعیت‌ها</option><option value="open">باز</option><option value="held">نگه‌داشته</option>
          <option value="completed">تکمیل‌شده</option><option value="voided">باطل‌شده</option>
        </select>
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">نوع سفارش</span>
        <select className={`${inputClass} w-full`} value={filters.type} onChange={(event) => patch({ type: event.target.value })}>
          <option value="">همه انواع</option><option value="dine_in">حضوری</option><option value="takeaway">بیرون‌بر</option><option value="delivery">ارسالی</option>
        </select>
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">از تاریخ</span>
        <JalaliDatePicker value={filters.from} onChange={(from) => patch({ from })} placeholder="از تاریخ" className={inputClass} />
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">تا تاریخ</span>
        <JalaliDatePicker value={filters.to} onChange={(to) => patch({ to })} placeholder="تا تاریخ" className={inputClass} />
      </label>
    </div>
  );
}

function initialFilters(): FilterState {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  const p = new URLSearchParams(window.location.search);
  return {
    shift: p.get("shift") || "latest", from: p.get("from") || "", to: p.get("to") || "",
    orderNumber: p.get("order") || "", customer: p.get("customer") || "", status: p.get("status") || "",
    type: p.get("type") || "", page: Math.max(1, Number(p.get("page")) || 1),
  };
}

export function ShiftOrdersSection() {
  const money = useMoney();
  const [report, setReport] = useState<ShiftOrdersReport | null>(null);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [loaded, setLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.shift === "all") p.set("allShifts", "1");
    else if (filters.shift !== "latest") p.set("shiftId", filters.shift);
    if (filters.from) p.set("from", filters.from); if (filters.to) p.set("to", filters.to);
    if (filters.orderNumber.trim()) p.set("orderNumber", filters.orderNumber.trim());
    if (filters.customer.trim()) p.set("customer", filters.customer.trim());
    if (filters.status) p.set("status", filters.status); if (filters.type) p.set("type", filters.type);
    p.set("page", String(filters.page)); p.set("pageSize", "25");
    return p.toString();
  }, [filters]);

  useEffect(() => {
    const visible = new URLSearchParams(window.location.search);
    visible.set("tab", "shift-orders");
    for (const key of ["from", "to", "order", "customer", "status", "type", "shift", "page"]) visible.delete(key);
    if (filters.from) visible.set("from", filters.from); if (filters.to) visible.set("to", filters.to);
    if (filters.orderNumber) visible.set("order", filters.orderNumber); if (filters.customer) visible.set("customer", filters.customer);
    if (filters.status) visible.set("status", filters.status); if (filters.type) visible.set("type", filters.type);
    if (filters.shift !== "latest") visible.set("shift", filters.shift); if (filters.page > 1) visible.set("page", String(filters.page));
    window.history.replaceState(null, "", `${window.location.pathname}?${visible}`);
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setRefreshing(true); setError("");
      const result = await api<{ report: ShiftOrdersReport | null; error?: string }>(`/api/reports/shift-orders?${query}`, { signal: controller.signal });
      if (result.aborted) return;
      if (result.ok) setReport(result.data.report); else setError(result.status === 400 ? "فیلترهای انتخاب‌شده معتبر نیستند." : "گزارش سفارش‌ها به‌روز نشد.");
      setLoaded(true); setRefreshing(false);
    }, new URLSearchParams(query).has("customer") || new URLSearchParams(query).has("orderNumber") ? 320 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, refreshKey]);

  if (!loaded) return <SectionCardSkeleton rows={4} />;
  const activeCount = [filters.shift !== "latest", filters.from, filters.to, filters.orderNumber, filters.customer, filters.status, filters.type].filter(Boolean).length;
  const reset = () => setFilters(DEFAULT_FILTERS);
  const subtitle = report ? `${toPersianDigits(report.totalCount)} سفارش · جمع ${money.format(report.totalAmount)}` : "هر سفارش، قلم‌به‌قلم و در تمام تاریخچهٔ شعبه";
  const chips: { key: keyof FilterState; label: string }[] = [
    ...(filters.shift !== "latest" ? [{ key: "shift" as const, label: filters.shift === "all" ? "همه شیفت‌ها" : "شیفت انتخاب‌شده" }] : []),
    ...(filters.from ? [{ key: "from" as const, label: `از ${formatJalali(filters.from)}` }] : []),
    ...(filters.to ? [{ key: "to" as const, label: `تا ${formatJalali(filters.to)}` }] : []),
    ...(filters.orderNumber ? [{ key: "orderNumber" as const, label: `سفارش: ${toPersianDigits(filters.orderNumber)}` }] : []),
    ...(filters.customer ? [{ key: "customer" as const, label: `مشتری: ${filters.customer}` }] : []),
    ...(filters.status ? [{ key: "status" as const, label: `وضعیت: ${STATUS_LABELS[filters.status] ?? filters.status}` }] : []),
    ...(filters.type ? [{ key: "type" as const, label: `نوع: ${TYPE_LABELS[filters.type as ShiftOrder["type"]]}` }] : []),
  ];
  const removeChip = (key: keyof FilterState) => setFilters({ ...filters, [key]: key === "shift" ? "latest" : "", page: 1 });

  return (
    <SectionCard title="سفارش‌های شیفت" description={subtitle} actions={
      <div className="flex items-center gap-2">
        <Sheet>
          <SheetTrigger asChild><Button type="button" variant="outline" className="xl:hidden"><FilterIcon />فیلترها{activeCount ? ` (${toPersianDigits(activeCount)})` : ""}</Button></SheetTrigger>
          <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader><SheetTitle>فیلترهای گزارش</SheetTitle><SheetDescription>فیلترها هم‌زمان و روی تمام تاریخچهٔ شعبه اعمال می‌شوند.</SheetDescription></SheetHeader>
            <div className="px-4 pb-5"><FilterFields filters={filters} setFilters={setFilters} shifts={report?.shifts ?? []} disabled={refreshing} />
              <BusinessDayRangePresets onSelect={(r) => setFilters({ ...filters, from: r.dateFrom, to: r.dateTo, page: 1 })} onClear={() => setFilters({ ...filters, from: "", to: "", page: 1 })} />
            </div>
          </SheetContent>
        </Sheet>
        {activeCount ? <Button type="button" variant="ghost" onClick={reset}><XIcon />پاک کردن</Button> : null}
        <Button type="button" variant="outline" onClick={() => setRefreshKey((v) => v + 1)} disabled={refreshing}><RefreshCwIcon />{refreshing ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}</Button>
      </div>
    } flush>
      <div className="hidden border-b border-border bg-muted/40 p-4 xl:block">
        <FilterFields filters={filters} setFilters={setFilters} shifts={report?.shifts ?? []} disabled={refreshing} />
        <BusinessDayRangePresets onSelect={(r) => setFilters({ ...filters, from: r.dateFrom, to: r.dateTo, page: 1 })} onClear={() => setFilters({ ...filters, from: "", to: "", page: 1 })} />
      </div>
      <div className="border-b border-border p-3 xl:hidden">
        <label className="relative block"><SearchIcon className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input className={`${inputClass} w-full pe-10`} value={filters.orderNumber || filters.customer} onChange={(e) => {
            const value = e.target.value;
            const looksLikeNumber = /^#?\s*\d*$/.test(toLatinDigits(value));
            setFilters({ ...filters, orderNumber: looksLikeNumber ? value : "", customer: looksLikeNumber ? "" : value, page: 1 });
          }} placeholder="شماره سفارش یا نام مشتری" />
        </label>
      </div>
      {chips.length ? <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5" aria-label="فیلترهای فعال">
        {chips.map((chip) => <button key={chip.key} type="button" onClick={() => removeChip(chip.key)} className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-amber-100 px-2.5 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200">
          {chip.label}<XIcon className="size-3.5" aria-hidden="true" />
        </button>)}
        <button type="button" onClick={reset} className="min-h-8 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground">پاک کردن همه</button>
      </div> : null}
      {error ? <p role="status" className="border-b border-border bg-amber-50 px-4 py-2 text-xs text-muted-foreground dark:bg-amber-500/15">{error}</p> : null}
      {!report ? (
        <div className="flex min-h-48 flex-col items-center justify-center p-6 text-center"><ShoppingBagIcon className="size-8 text-amber-700 dark:text-amber-300" /><p className="mt-4 text-sm font-semibold">شیفت انتخاب‌شده در این شعبه پیدا نشد</p><Button className="mt-3" variant="outline" onClick={reset}>پاک کردن فیلترها</Button></div>
      ) : report.orders.length === 0 ? (
        <div className="p-5"><EmptyState>{activeCount ? "سفارشی با فیلترهای انتخاب‌شده پیدا نشد." : "در این بازه سفارشی ثبت نشده است."}</EmptyState>{activeCount ? <div className="mt-3 text-center"><Button variant="outline" onClick={reset}>پاک کردن فیلترها</Button></div> : null}</div>
      ) : <ul className={`divide-y divide-border transition-opacity ${refreshing ? "opacity-60" : ""}`}>{report.orders.map((order) => <OrderCard key={order.id} order={order} />)}</ul>}
      {report && report.pageCount > 1 ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4 text-xs text-muted-foreground">
        <span>نمایش {toPersianDigits((report.page - 1) * report.pageSize + 1)} تا {toPersianDigits(Math.min(report.page * report.pageSize, report.totalCount))} از {toPersianDigits(report.totalCount)} سفارش</span>
        <div className="flex gap-2"><Button variant="outline" disabled={report.page <= 1 || refreshing} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>قبلی</Button><Button variant="outline" disabled={report.page >= report.pageCount || refreshing} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>بعدی</Button></div>
      </div> : null}
    </SectionCard>
  );
}
