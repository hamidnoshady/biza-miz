"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useDeferredValue,
} from "react";
import {
  CalendarDaysIcon,
  ClockIcon,
  InfoIcon,
  LayoutGridIcon,
  ListFilterIcon,
  RefreshCwIcon,
  SearchIcon,
  ShoppingBagIcon,
  UserIcon,
} from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, isoDateInTimeZone } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { formatQueueLabel } from "@/lib/orders";
import { useRealtime } from "../use-realtime";
import { KnowledgeHelpButton } from "../knowledge-help";
import { EmptyState, PageShell, cardClass } from "../page-chrome";
import {
  FilterChip,
  FilterChipRow,
  FilterToolbar,
  FilterToolbarButton,
  FilterToolbarSearch,
} from "../filters";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api } from "../ui";
import { OrderDetailModal } from "./order-detail-modal";

type OrderStatus = "open" | "held" | "completed" | "voided";
type OrderType = "dine_in" | "takeaway" | "delivery";

/** A row of either list the orders screen shows: the open queue, or an order closed this shift. */
interface OrderRow {
  id: string;
  order_number: number;
  type: OrderType;
  status: OrderStatus;
  table_name: string | null;
  /** Whom the sale is attributed to — null for the walk-in that most orders are. */
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  guest_count: number | null;
  total: string | number;
  opened_at: string;
  /** Set once the order is paid or voided — null for everything still in the queue. */
  closed_at: string | null;
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};

/**
 * The branch's trading day as the orders route reports it. Absent (null) for a
 * branch with no business day configured, which keeps this screen's original
 * calendar-day-plus-open-shift window untouched.
 */
interface BusinessDayWindow {
  enabled: boolean;
  businessDate: string;
  /** Where the closed list starts: the day's start, or whatever ended the night early. */
  windowStart: string;
  /** "shift" = the cashier cashed up, "manual" = «بستن روز کاری», null = still running. */
  closedBy: "manual" | "shift" | null;
  manuallyClosed: boolean;
}

/** One of the branch's recent shifts — only owners/managers are sent these. */
interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

/** Spans days, so it carries the Jalali date — the same wording the reports tab uses. */
function shiftOptionLabel(shift: ShiftOption): string {
  const start = toPersianDigits(
    formatJalali(shift.startedAt, { withMonthName: true, withTime: true }),
  );
  const end = shift.endedAt
    ? toPersianDigits(orderTimeLabel(shift.endedAt))
    : "در حال انجام";
  return `${shift.employeeName} · ${start} تا ${end}`;
}

/** Closed = it left the queue. The pair `listSettledOrdersInWindow` reads back. */
const CLOSED_STATUSES: OrderStatus[] = ["completed", "voided"];

function isClosed(order: OrderRow): boolean {
  return CLOSED_STATUSES.includes(order.status);
}

/** Voided orders are muted rather than amber: they are history, not takings. */
function statusBadgeClass(status: OrderStatus): string {
  return status === "voided"
    ? "bg-muted text-muted-foreground"
    : status === "completed"
      ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300";
}

const TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};

/**
 * The day an order belongs to, as the date filter's calendar counts days.
 * Tehran rather than UTC: JalaliDatePicker hands back the ISO date behind the
 * Jalali day the user tapped, and that calendar is Tehran's (todayJalali), so
 * bucketing in UTC would drop every order rung up after 20:30 local into the
 * previous day and hide it.
 */
function orderDateValue(value: string): string | null {
  return isoDateInTimeZone(value);
}

function orderTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function orderDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "تاریخ نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    day: "numeric",
    month: "long",
  }).format(date);
}

function elapsedLabel(value: string): string | null {
  const openedAt = new Date(value).getTime();
  if (Number.isNaN(openedAt)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - openedAt) / 60_000));
  if (minutes < 1) return "همین حالا";
  if (minutes < 60) return `${toPersianDigits(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder
    ? `${toPersianDigits(hours)} ساعت و ${toPersianDigits(remainder)} دقیقه`
    : `${toPersianDigits(hours)} ساعت`;
}

function OrderRowsSkeleton() {
  return (
    <div
      className="divide-y divide-border/80"
      aria-label="در حال بارگذاری سفارش‌ها"
      aria-busy="true"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3 md:min-h-[82px] xl:min-h-[88px]"
        >
          <div className="min-w-0 flex-1">
            <div className="ops-skeleton h-4 w-24 rounded" />
            <div className="ops-skeleton mt-3 h-3 w-40 max-w-full rounded" />
          </div>
          <div className="ops-skeleton h-8 w-16 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

export function OrdersList({
  canEdit,
  canTakePayment,
  canAmendClosed = false,
  initialOrderId = null,
}: {
  /** May edit an open order (lines/details); independent of taking money. */
  canEdit: boolean;
  /** May settle an open order. */
  canTakePayment: boolean;
  /** May edit or remove an order that has already been paid for. */
  canAmendClosed?: boolean;
  /** `?order=<id>` from the URL: the dialog opens on it once, on first render. */
  initialOrderId?: string | null;
}) {
  const money = useMoney();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [closedOrders, setClosedOrders] = useState<OrderRow[]>([]);
  /** null = nobody is clocked in, so the closed list covers the business day instead of a shift. */
  const [shiftStartedAt, setShiftStartedAt] = useState<string | null>(null);
  /**
   * The branch's trading day (روز کاری), when it has one configured. It, not the
   * calendar day, is then what "the current window" means here: a service running
   * 18:00→03:00 keeps one list across midnight, and the list only goes back to
   * empty when the next business day starts — or the moment management closes
   * the day by hand.
   */
  const [businessDay, setBusinessDay] = useState<BusinessDayWindow | null>(
    null,
  );
  /** Empty for roles that may not review other people's shifts — the picker hides itself. */
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  /** "" = the default window (this shift, or today). Otherwise the shift being reviewed. */
  const [shiftFilter, setShiftFilter] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(
    initialOrderId,
  );
  /** The order whose dialog is open — independent of which row is highlighted. */
  const [detailOrderId, setDetailOrderId] = useState<string | null>(
    initialOrderId,
  );
  const [detailOpen, setDetailOpen] = useState(Boolean(initialOrderId));
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<OrderType | "all">("all");
  const [tableFilter, setTableFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");

  const load = useCallback(async () => {
    setIsRefreshing(true);
    setLoadError("");
    try {
      const { ok, data } = await api<{
        orders: OrderRow[];
        closedOrders?: OrderRow[];
        closedSince?: string | null;
        shiftStartedAt?: string | null;
        businessDay?: BusinessDayWindow | null;
        shifts?: ShiftOption[];
        selectedShift?: ShiftOption | null;
        error?: string;
      }>(
        "/api/orders?scope=shift" +
          (shiftFilter ? `&shiftId=${encodeURIComponent(shiftFilter)}` : ""),
      );
      if (ok) {
        setOrders(data.orders);
        setClosedOrders(data.closedOrders ?? []);
        setShiftStartedAt(data.shiftStartedAt ?? null);
        setBusinessDay(data.businessDay ?? null);
        setShifts(data.shifts ?? []);
        // A shift the branch no longer lists (revoked, or another branch's) is
        // answered with the default window — follow the server rather than
        // leaving the picker pointing at something it isn't showing.
        if (shiftFilter && !data.selectedShift) setShiftFilter("");
      } else {
        setLoadError("فهرست سفارش‌ها به‌روز نشد. داده‌های موجود حفظ شده‌اند.");
      }
    } catch {
      setLoadError(
        "ارتباط با سفارش‌ها برقرار نشد. داده‌های موجود حفظ شده‌اند.",
      );
    } finally {
      setInitialLoading(false);
      setIsRefreshing(false);
    }
  }, [shiftFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (
          ["order.created", "order.updated", "order.item_status"].includes(
            event.type,
          )
        )
          void load();
      },
      [load],
    ),
  );

  // The open queue stays on top, newest first as the API returns it; the
  // shift's closed orders follow, newest close first. Statuses are disjoint,
  // so the two lists never carry the same order twice.
  const orderRows = useMemo(
    () => [...(orders ?? []), ...closedOrders],
    [closedOrders, orders],
  );
  const openCount = orders?.length ?? 0;
  const reviewedShift = shiftFilter
    ? (shifts.find((shift) => shift.id === shiftFilter) ?? null)
    : null;
  const availableStatuses = useMemo(
    () => Array.from(new Set(orderRows.map((order) => order.status))),
    [orderRows],
  );
  const tableNames = useMemo(
    () =>
      Array.from(
        new Set(
          orderRows.flatMap((order) =>
            order.table_name ? [order.table_name] : [],
          ),
        ),
      ).sort((a, b) => a.localeCompare(b, "fa")),
    [orderRows],
  );
  /** What «شیفت» reads when no specific shift is being reviewed. */
  const currentShiftLabel = businessDay?.enabled
    ? "روز کاری جاری"
    : shiftStartedAt
      ? "شیفت جاری"
      : "امروز";
  /**
   * Status and type share one toolbar slot on a phone — they are one question
   * («کدام سفارش‌ها؟») asked twice, and two separate icons for them would cost
   * a target without telling anyone more.
   */
  const mobileStatusValue =
    [
      statusFilter === "all" ? null : STATUS_LABELS[statusFilter],
      typeFilter === "all" ? null : TYPE_LABELS[typeFilter],
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // ⚡ Bolt: Pre-compute the searchable string for each order to avoid
  // running expensive string allocations and normalization (O(N) operations)
  // on every keystroke during filtering.
  const normalizedOrderRows = useMemo(() => {
    return orderRows.map((order) => {
      const searchableText = [
        formatQueueLabel(order.type, order.order_number),
        TYPE_LABELS[order.type],
        order.table_name ?? "",
        order.customer_name ?? "",
        order.customer_phone ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase("fa");
      return { order, searchableText };
    });
  }, [orderRows]);

  // ⚡ Bolt: Use deferred search query to prevent UI blocking on slow text inputs.
  // Re-uses pre-computed searchable text for fast `.includes()` checking.
  const filteredOrders = useMemo(() => {
    const normalizedSearch = deferredSearchQuery.trim().toLocaleLowerCase("fa");
    return normalizedOrderRows
      .filter(({ order, searchableText }) => {
        const matchesStatus =
          statusFilter === "all" || order.status === statusFilter;
        const matchesType = typeFilter === "all" || order.type === typeFilter;
        const matchesTable =
          tableFilter === "all" || order.table_name === tableFilter;
        const matchesDate =
          !dateFilter || orderDateValue(order.opened_at) === dateFilter;
        return (
          matchesStatus &&
          matchesType &&
          matchesTable &&
          matchesDate &&
          (!normalizedSearch || searchableText.includes(normalizedSearch))
        );
      })
      .map(({ order }) => order);
  }, [
    dateFilter,
    normalizedOrderRows,
    deferredSearchQuery,
    statusFilter,
    tableFilter,
    typeFilter,
  ]);

  useEffect(() => {
    setSelectedOrderId((current) => {
      if (current && orderRows.some((order) => order.id === current))
        return current;
      return orderRows[0]?.id ?? null;
    });
  }, [orderRows]);

  useEffect(() => {
    setSelectedOrderId((current) => {
      if (current && filteredOrders.some((order) => order.id === current))
        return current;
      return filteredOrders[0]?.id ?? null;
    });
  }, [filteredOrders]);

  const hasActiveFilters = Boolean(
    searchQuery ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    tableFilter !== "all" ||
    dateFilter ||
    shiftFilter,
  );

  /**
   * The open dialog is reflected in `?order=<id>` so the address bar still
   * names what is on screen — refreshing, or sending the link to a colleague,
   * lands on the same order (that is also where /dashboard/orders/[id]
   * redirects to). `history.replaceState` rather than a router push: opening a
   * dialog should not add a step to the back button, and the queue behind it
   * must not re-render mid-service.
   */
  const syncDetailUrl = useCallback((orderId: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (orderId) url.searchParams.set("order", orderId);
    else url.searchParams.delete("order");
    window.history.replaceState(null, "", url.toString());
  }, []);

  function openDetail(orderId: string) {
    setSelectedOrderId(orderId);
    setDetailOrderId(orderId);
    setDetailOpen(true);
    syncDetailUrl(orderId);
  }

  function closeDetail() {
    setDetailOpen(false);
    syncDetailUrl(null);
    void load();
  }

  function clearFilters() {
    setSearchQuery("");
    setStatusFilter("all");
    setTypeFilter("all");
    setTableFilter("all");
    setDateFilter("");
    setShiftFilter("");
  }

  return (
    <PageShell>
      <header className={`mb-3 flex flex-col gap-3 ${cardClass} p-3 sm:p-4 md:flex-row md:items-center md:justify-between`}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
            <ShoppingBagIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-foreground">
              سفارش‌ها
            </h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              صف سفارش‌های باز و سفارش‌های بسته‌شدهٔ شعبهٔ فعال
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 md:justify-end">
          <KnowledgeHelpButton section="orders" />
          <span
            className="text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {isRefreshing
              ? "در حال به‌روزرسانی…"
              : `${toPersianDigits(openCount)} سفارش باز` +
                (closedOrders.length
                  ? ` · ${toPersianDigits(closedOrders.length)} بسته‌شده`
                  : "")}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={isRefreshing}
            className="flex min-h-12 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-xs font-bold text-muted-foreground transition duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98] disabled:opacity-60 xl:min-h-[52px] motion-reduce:transition-none"
            aria-label={
              isRefreshing
                ? "در حال به‌روزرسانی سفارش‌ها"
                : "به‌روزرسانی سفارش‌ها"
            }
          >
            <RefreshCwIcon
              className={`size-4 ${isRefreshing ? "ops-sync-rotate" : ""}`}
              aria-hidden="true"
            />
            <span>به‌روزرسانی</span>
          </button>
        </div>
      </header>

      {loadError && orders ? (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-500/25 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-11 shrink-0 px-2 font-bold text-amber-700 dark:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
          >
            تلاش دوباره
          </button>
        </div>
      ) : null}

      {/*
        Two layouts for one set of filters. The phone gets a single scrolling
        row of icon targets (FilterToolbar) so the list itself stays above the
        fold; from `sm:` up the comfortable panel below takes over unchanged.
        Both read and write the *same* filter state, so nothing is lost by
        crossing the breakpoint — and neither touches the order selection or
        the list's scroll position.
      */}
      <section className={`mb-3 ${cardClass} p-2 sm:hidden`} aria-label="فیلتر سفارش‌ها">
        <FilterToolbar onClearAll={hasActiveFilters ? clearFilters : undefined}>
          <FilterToolbarSearch
            value={searchQuery}
            onChange={setSearchQuery}
            label="جستجو در شماره، نوع یا میز سفارش"
            placeholder="جستجو…"
          />

          <FilterToolbarButton
            icon={ListFilterIcon}
            label="وضعیت و نوع سفارش"
            value={mobileStatusValue}
            onClear={() => {
              setStatusFilter("all");
              setTypeFilter("all");
            }}
          >
            <div className="space-y-3">
              <FilterChipRow label="فیلتر وضعیت سفارش" className="gap-1.5">
                <FilterChip dense selected={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
                  همهٔ وضعیت‌ها
                </FilterChip>
                {availableStatuses.map((status) => (
                  <FilterChip
                    key={status}
                    dense
                    selected={statusFilter === status}
                    onClick={() => setStatusFilter(status)}
                  >
                    {STATUS_LABELS[status]}
                  </FilterChip>
                ))}
              </FilterChipRow>
              <FilterChipRow label="فیلتر نوع سفارش" className="gap-1.5">
                <FilterChip dense selected={typeFilter === "all"} onClick={() => setTypeFilter("all")}>
                  همهٔ انواع
                </FilterChip>
                {(["dine_in", "takeaway", "delivery"] as OrderType[]).map((type) => (
                  <FilterChip
                    key={type}
                    dense
                    selected={typeFilter === type}
                    onClick={() => setTypeFilter((current) => (current === type ? "all" : type))}
                  >
                    {TYPE_LABELS[type]}
                  </FilterChip>
                ))}
              </FilterChipRow>
            </div>
          </FilterToolbarButton>

          {shifts.length > 0 ? (
            <FilterToolbarButton
              icon={ClockIcon}
              label="شیفت"
              value={reviewedShift ? shiftOptionLabel(reviewedShift) : undefined}
              onClear={() => setShiftFilter("")}
            >
              <SearchableSelect
                value={shiftFilter}
                onChange={setShiftFilter}
                className="min-h-11 w-full"
                ariaLabel="مرور سفارش‌های بسته‌شدهٔ یک شیفت"
                options={[
                  { value: "", label: currentShiftLabel },
                  ...shifts.map((shift) => ({ value: shift.id, label: shiftOptionLabel(shift) })),
                ]}
              />
            </FilterToolbarButton>
          ) : null}

          <FilterToolbarButton
            icon={LayoutGridIcon}
            label="میز"
            value={tableFilter === "all" ? undefined : tableFilter}
            onClear={() => setTableFilter("all")}
          >
            <SearchableSelect
              value={tableFilter}
              onChange={setTableFilter}
              className="min-h-11 w-full"
              ariaLabel="فیلتر میز سفارش"
              options={[
                { value: "all", label: "همهٔ میزها" },
                ...tableNames.map((tableName) => ({ value: tableName, label: tableName })),
              ]}
            />
          </FilterToolbarButton>

          <FilterToolbarButton
            icon={CalendarDaysIcon}
            label="تاریخ"
            value={dateFilter ? formatJalali(dateFilter) : undefined}
            onClear={() => setDateFilter("")}
          >
            <JalaliDatePicker
              value={dateFilter}
              onChange={setDateFilter}
              placeholder="همهٔ روزها"
              className="min-h-11 w-full"
            />
          </FilterToolbarButton>
        </FilterToolbar>
      </section>

      <section
        className={`mb-3 hidden ${cardClass} p-3 sm:block`}
        aria-label="جستجو و فیلتر سفارش‌ها"
      >
        <label className="sr-only" htmlFor="orders-search">
          جستجوی شماره، نوع یا میز سفارش
        </label>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="orders-search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="min-h-12 w-full rounded-xl border border-border/80 bg-muted py-2 pe-3 ps-10 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-2 focus-visible:ring-amber-500/25 dark:focus-visible:ring-amber-400/45"
            placeholder="جستجو در شماره، نوع یا میز سفارش"
          />
        </div>

        <div
          className="mt-3 flex min-h-12 gap-2 overflow-x-auto pb-1"
          aria-label="فیلتر وضعیت سفارش"
        >
          <FilterChip dense selected={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            همه
          </FilterChip>
          {availableStatuses.map((status) => (
            <FilterChip
              key={status}
              dense
              selected={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {STATUS_LABELS[status]}
            </FilterChip>
          ))}
          {(["dine_in", "takeaway", "delivery"] as OrderType[]).map((type) => (
            <FilterChip
              key={type}
              dense
              selected={typeFilter === type}
              onClick={() =>
                setTypeFilter((current) => (current === type ? "all" : type))
              }
            >
              {TYPE_LABELS[type]}
            </FilterChip>
          ))}
        </div>

        {shifts.length > 0 ? (
          <label className="mt-2 flex min-h-12 min-w-0 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-xs text-muted-foreground xl:min-h-[52px]">
            <span className="shrink-0">شیفت</span>
            <SearchableSelect
              value={shiftFilter}
              onChange={setShiftFilter}
              className="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none"
              ariaLabel="مرور سفارش‌های بسته‌شدهٔ یک شیفت"
              options={[
                { value: "", label: currentShiftLabel },
                ...shifts.map((shift) => ({
                  value: shift.id,
                  label: shiftOptionLabel(shift),
                })),
              ]}
            />
          </label>
        ) : null}

        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <label className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-xs text-muted-foreground xl:min-h-[52px]">
            <span className="shrink-0">میز</span>
            <SearchableSelect
              value={tableFilter}
              onChange={setTableFilter}
              className="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none"
              ariaLabel="فیلتر میز سفارش"
              options={[
                { value: "all", label: "همهٔ میزها" },
                ...tableNames.map((tableName) => ({
                  value: tableName,
                  label: tableName,
                })),
              ]}
            />
          </label>
          <div className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-xs text-muted-foreground xl:min-h-[52px]">
            <span className="shrink-0">تاریخ</span>
            <div className="min-w-0 flex-1">
              <JalaliDatePicker
                value={dateFilter}
                onChange={setDateFilter}
                placeholder="همهٔ روزها"
                className="min-h-10 w-full min-w-0 bg-transparent text-sm text-foreground outline-none"
              />
            </div>
          </div>
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="min-h-12 rounded-xl px-3 text-sm font-bold text-amber-700 dark:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 xl:min-h-[52px]"
            >
              پاک‌کردن فیلترها
            </button>
          ) : null}
        </div>
      </section>

      <div className="grid gap-3">
        <section
          className={`min-w-0 overflow-hidden ${cardClass}`}
          aria-label="فهرست سفارش‌ها"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
            <h2 className="text-sm font-bold text-foreground">صف سفارش‌ها</h2>
            <span className="text-xs text-muted-foreground">
              {toPersianDigits(filteredOrders.length)} مورد
            </span>
          </div>

          {orders ? (
            <div
              className="flex items-center gap-2 border-b border-border/80 bg-muted px-4 py-2 text-[11px] text-muted-foreground"
              role="status"
            >
              <span
                title="راهنمای بازه سفارش‌ها"
                className="inline-flex shrink-0"
                aria-label="راهنمای بازه سفارش‌ها"
              >
                <InfoIcon
                  className="size-4 text-amber-700 dark:text-amber-300"
                  aria-hidden="true"
                />
              </span>
              <span>بازه سفارش‌ها</span>
              <span className="sr-only">
                {reviewedShift
                  ? `سفارش‌های بسته‌شدهٔ شیفت ${reviewedShift.employeeName} نمایش داده می‌شوند؛ صف بازِ بالا لحظه‌ای است.`
                  : businessDay?.enabled
                    ? businessDay.closedBy === "shift"
                      ? `شیفت ساعت ${orderTimeLabel(businessDay.windowStart)} بسته شد.`
                      : businessDay.closedBy === "manual"
                        ? `روز کاری ساعت ${orderTimeLabel(businessDay.windowStart)} بسته شد.`
                        : `سفارش‌های بسته‌شدهٔ روز کاری جاری از ساعت ${orderTimeLabel(businessDay.windowStart)} نمایش داده می‌شوند.`
                    : shiftStartedAt
                      ? `سفارش‌های بسته‌شده از شروع شیفت در ساعت ${orderTimeLabel(shiftStartedAt)} نمایش داده می‌شوند.`
                      : "سفارش‌های بسته‌شدهٔ امروز نمایش داده می‌شوند."}
              </span>
            </div>
          ) : null}

          {initialLoading && !orders ? (
            <OrderRowsSkeleton />
          ) : !orders ? (
            <div
              className="flex min-h-64 flex-col items-center justify-center p-6 text-center"
              role="status"
            >
              <p className="text-sm font-bold text-foreground">
                بارگذاری سفارش‌ها ممکن نشد
              </p>
              <p className="mt-2 max-w-72 text-xs leading-6 text-muted-foreground">
                {loadError || "دوباره تلاش کنید."}
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-4 min-h-12 rounded-xl bg-amber-100 dark:bg-amber-500/20 px-4 text-sm font-bold text-amber-700 dark:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                تلاش دوباره
              </button>
            </div>
          ) : orderRows.length === 0 ? (
            <EmptyState icon={ShoppingBagIcon} title="سفارشی برای نمایش نیست">
              با ثبت سفارش جدید، این صف به‌صورت خودکار به‌روز می‌شود.
              سفارش‌های بسته‌شده تا پایان روز کاری همین‌جا می‌مانند.
            </EmptyState>
          ) : filteredOrders.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
              <SearchIcon
                className="size-6 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-bold text-foreground">
                سفارشی با این فیلتر پیدا نشد
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 min-h-11 px-3 text-sm font-bold text-amber-700 dark:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                پاک‌کردن فیلترها
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border/80">
              {filteredOrders.map((order) => {
                const isSelected = order.id === selectedOrderId;
                const closed = isClosed(order);
                const elapsed = closed ? null : elapsedLabel(order.opened_at);
                const closedLabel =
                  closed && order.closed_at
                    ? `${order.status === "voided" ? "ابطال" : "تسویه"} ${orderTimeLabel(order.closed_at)}`
                    : null;
                return (
                  <button
                    key={order.id}
                    type="button"
                    /*
                      One tap, one order. Selecting the row used to only fill the
                      summary panel, and reaching the order itself — its lines,
                      its payment, its corrections — meant finding the panel's
                      button afterwards. The card is the order, so it opens it;
                      the panel keeps showing whatever was opened last, which is
                      what it is still good for once the dialog is dismissed.
                    */
                    onClick={() => openDetail(order.id)}
                    aria-pressed={isSelected}
                    aria-haspopup="dialog"
                    className={`flex min-h-[76px] w-full items-center justify-between gap-3 px-4 py-3 text-start transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.995] md:min-h-[82px] xl:min-h-[88px] motion-reduce:transition-none ${
                      isSelected
                        ? "bg-amber-50 dark:bg-amber-500/15"
                        : "bg-card hover:bg-muted"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-foreground">
                          {toPersianDigits(
                            formatQueueLabel(order.type, order.order_number),
                          )}
                        </span>
                        <span
                          className={`inline-flex min-h-7 items-center rounded-lg px-2 text-[11px] font-bold ${statusBadgeClass(order.status)}`}
                        >
                          {STATUS_LABELS[order.status]}
                        </span>
                        {/* The table is the second thing a runner looks for
                            after the number — same visual weight as the
                            number, not a whisper on the meta line. */}
                        {order.table_name ? (
                          <span className="inline-flex min-h-7 items-center rounded-lg border border-amber-500/60 dark:border-amber-500/50 bg-amber-100 dark:bg-amber-500/20 px-2 text-[11px] font-black text-amber-700 dark:text-amber-300">
                            {order.table_name}
                          </span>
                        ) : null}
                      </div>
                      {/* The customer gets its own line rather than a slot on
                          the muted meta line below: "whose order is this" is
                          read at a glance off this list, and a name folded in
                          among the type, table and timings is not. A walk-in
                          order simply says nothing — «بدون مشتری» on every
                          second card is noise, not information. */}
                      {order.customer_name ? (
                        <p className="mt-1 flex items-center gap-1 text-sm font-bold text-foreground">
                          <UserIcon
                            className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {order.customer_name}
                          </span>
                        </p>
                      ) : null}
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {TYPE_LABELS[order.type]}
                        {elapsed ? ` · ${elapsed}` : ""}
                        {closedLabel ? ` · ${closedLabel}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p
                        className={`text-sm font-bold ${closed ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}`}
                      >
                        {money.format(Number(order.total))}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {orderTimeLabel(order.opened_at)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

      </div>

      <OrderDetailModal
        orderId={detailOrderId}
        open={detailOpen}
        onOpenChange={(next) => (next ? setDetailOpen(true) : closeDetail())}
        canEdit={canEdit}
        canTakePayment={canTakePayment}
        canAmendClosed={canAmendClosed}
        onChanged={() => void load()}
      />
    </PageShell>
  );
}
