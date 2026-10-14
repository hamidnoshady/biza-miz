"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeftIcon,
  CircleDotIcon,
  RefreshCwIcon,
  UsersIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { TABLE_STATUS_LABELS, type TableStatus } from "@/lib/table-sessions";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useRealtime } from "../use-realtime";
import { api } from "../ui";
import { TableOrderPanel } from "./table-order-panel";
import { cardClass } from "../page-chrome";

interface WaiterTable {
  id: string;
  name: string;
  section_id: string | null;
  capacity: number;
  status: TableStatus;
  session_id: string | null;
  party_size: number | null;
  guest_name: string | null;
  order_id: string | null;
  order_number: number | null;
  item_status_counts: Record<string, number>;
}

interface Section {
  id: string;
  name: string;
  color: string | null;
}

interface BoardData {
  sections: Section[];
  tables: WaiterTable[];
}

const STATUS_STYLE: Record<
  TableStatus,
  { card: string; dot: string; badge: string }
> = {
  free: {
    card: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500 dark:bg-emerald-500",
    badge: "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  seated: {
    card: "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300",
    dot: "bg-amber-500 dark:bg-amber-400",
    badge: "bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300",
  },
  bill_requested: {
    card: "border-chart-7/25 bg-chart-7/5 text-chart-7",
    dot: "bg-chart-7",
    badge: "bg-chart-7/5 text-chart-7",
  },
  cleaning: {
    card: "border-amber-100 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300",
    dot: "bg-amber-600 dark:bg-amber-400",
    badge: "bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300",
  },
  out_of_service: {
    card: "border-destructive/30 bg-destructive/5 text-destructive",
    dot: "bg-destructive",
    badge: "bg-destructive/10 text-destructive",
  },
};

function itemProgress(table: WaiterTable): { ready: number; cooking: number } {
  return {
    ready: table.item_status_counts.ready ?? 0,
    cooking:
      (table.item_status_counts.sent ?? 0) +
      (table.item_status_counts.preparing ?? 0),
  };
}

export function WaiterBoard() {
  const [sections, setSections] = useState<Section[]>([]);
  const [tables, setTables] = useState<WaiterTable[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [mobileLayout, setMobileLayout] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const result = await api<BoardData>("/api/waiter/board");
      if (!result.ok) {
        // The board lists the sections assigned to *this* member, so the API
        // admits only cashiers and waiters. An owner or manager used to be told
        // to "try again" — a retry that can never succeed.
        setError(
          result.status === 403
            ? "این تابلو میزهای بخشِ تخصیص‌داده‌شده به گارسون یا صندوق‌دار را نشان می‌دهد و با نقش شما باز نمی‌شود. همهٔ میزها در «میزها» است."
            : "دریافت میزهای تخصیص‌داده‌شده ممکن نشد. دوباره تلاش کنید.",
        );
        return;
      }
      setSections(result.data.sections);
      setTables(result.data.tables);
      setError("");
    } catch {
      setError(
        "دریافت میزهای تخصیص‌داده‌شده ممکن نشد. اتصال را بررسی کنید و دوباره تلاش کنید.",
      );
    } finally {
      setLoaded(true);
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const updateOnlineState = () => setOnline(navigator.onLine);
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const updateLayout = () => setMobileLayout(media.matches);
    updateLayout();
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);

  useRealtime(
    useCallback(
      (event) => {
        if (
          [
            "order.created",
            "order.updated",
            "order.item_status",
            "table.status",
            "table_session.updated",
          ].includes(event.type)
        ) {
          void load();
        }
      },
      [load],
    ),
  );

  const selected = tables.find((table) => table.id === selectedId) ?? null;
  const viewingTable = tables.find((table) => table.id === viewingId) ?? null;
  const sectionNames = useMemo(
    () => new Map(sections.map((section) => [section.id, section.name])),
    [sections],
  );
  const tablesBySection = useMemo(() => {
    const grouped = new Map<string | null, WaiterTable[]>();
    for (const table of tables) {
      const sectionTables = grouped.get(table.section_id) ?? [];
      sectionTables.push(table);
      grouped.set(table.section_id, sectionTables);
    }
    return [...grouped.entries()];
  }, [tables]);

  if (viewingTable) {
    return (
      <TableOrderPanel
        table={viewingTable}
        onBack={() => setViewingId(null)}
        onChanged={() => void load()}
      />
    );
  }

  if (!loaded) return <WaiterBoardSkeleton />;

  const today = toPersianDigits(
    formatJalali(new Date(), { withMonthName: true }),
  );
  const selectedSectionName = selected
    ? (sectionNames.get(selected.section_id ?? "") ?? "بدون بخش")
    : "";

  return (
    <section className="space-y-4" aria-label="فضای کاری میزهای من">
      <div className={`flex flex-col gap-3 ${cardClass} p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4`}>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">
            {toPersianDigits(tables.length)} میز تخصیص‌داده‌شده به شما
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{today}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1" role="status">
              {online ? (
                <span
                  className="size-2 rounded-full bg-emerald-500 dark:bg-emerald-500"
                  aria-hidden="true"
                />
              ) : (
                <WifiOffIcon
                  className="size-3.5 text-destructive"
                  aria-hidden="true"
                />
              )}
              {online ? "همگام‌سازی خودکار فعال است" : "اتصال قطع است"}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-border/80 bg-muted px-4 text-sm font-semibold text-muted-foreground transition hover:bg-amber-50 dark:hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {refreshing ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
        </button>
      </div>

      {error && tables.length === 0 ? (
        <BoardError message={error} onRetry={() => void load(true)} />
      ) : (
        <>
          {error ? (
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void load(true)}
                className="min-h-11 rounded-lg border border-destructive/30 bg-card px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                تلاش دوباره
              </button>
            </div>
          ) : null}

          {tables.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_19rem] lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
              <div className="min-w-0 space-y-5">
                {tablesBySection.map(([sectionId, sectionTables]) => {
                  const sectionName =
                    sectionNames.get(sectionId ?? "") ?? "بدون بخش";
                  return (
                    <section
                      key={sectionId ?? "none"}
                      aria-labelledby={`my-tables-section-${sectionId ?? "none"}`}
                    >
                      <div className="mb-2 flex items-center justify-between gap-3 px-1">
                        <h2
                          id={`my-tables-section-${sectionId ?? "none"}`}
                          className="text-sm font-bold text-foreground/80"
                        >
                          {sectionName}
                        </h2>
                        <span className="text-xs text-muted-foreground">
                          {toPersianDigits(sectionTables.length)} میز
                        </span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                        {sectionTables.map((table) => (
                          <TableCard
                            key={table.id}
                            table={table}
                            sectionName={sectionName}
                            selected={table.id === selected?.id}
                            onSelect={() => setSelectedId(table.id)}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>

              <aside
                className="hidden md:block"
                aria-label="جزئیات میز انتخاب‌شده"
              >
                {selected ? (
                  <TableDetails
                    table={selected}
                    sectionName={selectedSectionName}
                    onClose={() => setSelectedId(null)}
                    onOpen={() => setViewingId(selected.id)}
                  />
                ) : (
                  <div className={`sticky top-4 ${cardClass} p-5 text-right`}>
                    <CircleDotIcon
                      className="size-5 text-amber-700 dark:text-amber-300"
                      aria-hidden="true"
                    />
                    <h2 className="mt-4 text-base font-bold text-foreground">
                      یک میز را انتخاب کنید
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      جزئیات میز و مسیر موجود برای مشاهدهٔ آن اینجا نمایش داده
                      می‌شود.
                    </p>
                  </div>
                )}
              </aside>
            </div>
          )}

          {mobileLayout && selected ? (
            <Sheet open onOpenChange={(open) => !open && setSelectedId(null)}>
              <SheetContent
                side="bottom"
                showCloseButton={false}
                className="max-h-[88dvh] overflow-y-auto rounded-t-3xl border-border/80 bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] data-[state=open]:duration-200 data-[state=closed]:duration-150"
              >
                <SheetHeader className="sr-only">
                  <SheetTitle>جزئیات میز انتخاب‌شده</SheetTitle>
                </SheetHeader>
                <TableDetails
                  table={selected}
                  sectionName={selectedSectionName}
                  onClose={() => setSelectedId(null)}
                  onOpen={() => setViewingId(selected.id)}
                />
              </SheetContent>
            </Sheet>
          ) : null}
        </>
      )}
    </section>
  );
}

function TableCard({
  table,
  sectionName,
  selected,
  onSelect,
}: {
  table: WaiterTable;
  sectionName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const style = STATUS_STYLE[table.status];
  const { ready, cooking } = itemProgress(table);
  const label = `${table.name}، ${TABLE_STATUS_LABELS[table.status]}، بخش ${sectionName}، ظرفیت ${toPersianDigits(table.capacity)} نفر`;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={label}
      className={`min-h-36 rounded-2xl border p-4 text-right transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:focus-visible:ring-amber-400/45 active:scale-[0.99] motion-reduce:transition-none ${style.card} ${selected ? "border-amber-500 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 ring-2 ring-amber-500/25 dark:ring-amber-400/45" : "hover:border-amber-500/70 dark:hover:border-amber-500/60 hover:shadow-[0_5px_16px_rgb(41_37_36/0.05)]"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-base font-bold text-foreground">{table.name}</span>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${style.badge}`}
        >
          <span
            className={`size-2 rounded-full ${style.dot}`}
            aria-hidden="true"
          />
          {TABLE_STATUS_LABELS[table.status]}
        </span>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <UsersIcon className="size-3.5" aria-hidden="true" />
          {toPersianDigits(table.capacity)} نفر
        </span>
        <span className="truncate">{sectionName}</span>
      </div>
      {ready > 0 || cooking > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-medium">
          {ready > 0 ? (
            <span className="rounded-full bg-emerald-50 dark:bg-emerald-500/15 px-2 py-1 text-emerald-700 dark:text-emerald-300">
              {toPersianDigits(ready)} آماده
            </span>
          ) : null}
          {cooking > 0 ? (
            <span className="rounded-full bg-white/70 px-2 py-1 text-amber-900 dark:text-amber-200">
              {toPersianDigits(cooking)} در حال آماده‌سازی
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function TableDetails({
  table,
  sectionName,
  onClose,
  onOpen,
}: {
  table: WaiterTable;
  sectionName: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  const style = STATUS_STYLE[table.status];
  const { ready, cooking } = itemProgress(table);

  return (
    <section
      className={`sticky top-4 ${cardClass} p-4 sm:p-5`}
      aria-labelledby={`table-details-${table.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">میز انتخاب‌شده</p>
          <h2
            id={`table-details-${table.id}`}
            className="mt-1 text-xl font-bold text-foreground"
          >
            {table.name}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 motion-reduce:transition-none"
          aria-label="بستن جزئیات میز"
        >
          <XIcon className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div
        className={`mt-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${style.badge}`}
      >
        <span
          className={`size-2.5 rounded-full ${style.dot}`}
          aria-hidden="true"
        />
        {TABLE_STATUS_LABELS[table.status]}
      </div>

      <dl className="mt-5 divide-y divide-border rounded-xl border border-border/80 px-3">
        <DetailRow label="بخش" value={sectionName} />
        <DetailRow
          label="ظرفیت"
          value={`${toPersianDigits(table.capacity)} نفر`}
        />
        {table.party_size ? (
          <DetailRow
            label="مهمان‌ها"
            value={`${toPersianDigits(table.party_size)} نفر`}
          />
        ) : null}
        {table.guest_name ? (
          <DetailRow label="نام مهمان" value={table.guest_name} />
        ) : null}
        {table.order_number ? (
          <DetailRow
            label="سفارش باز"
            value={`#${toPersianDigits(table.order_number)}`}
          />
        ) : null}
      </dl>

      {ready > 0 || cooking > 0 ? (
        <div className="mt-4 rounded-xl bg-muted p-3 text-sm">
          <p className="font-semibold text-foreground/80">وضعیت آماده‌سازی</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {ready > 0 ? (
              <span className="rounded-full bg-emerald-50 dark:bg-emerald-500/15 px-2.5 py-1 text-emerald-700 dark:text-emerald-300">
                {toPersianDigits(ready)} قلم آماده است
              </span>
            ) : null}
            {cooking > 0 ? (
              <span className="rounded-full bg-amber-100 dark:bg-amber-500/20 px-2.5 py-1 text-amber-800 dark:text-amber-300">
                {toPersianDigits(cooking)} قلم در حال آماده‌سازی است
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onOpen}
        className="mt-5 inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 transition hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.99] motion-reduce:transition-none"
      >
        مشاهده میز
        <ChevronLeftIcon className="size-4" aria-hidden="true" />
      </button>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-left font-semibold text-foreground/80">
        {value}
      </dd>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted px-6 text-center">
      <h2 className="text-base font-bold text-foreground">
        میزی برای نمایش وجود ندارد
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        میزی به شما تخصیص داده نشده است.
      </p>
    </section>
  );
}

function BoardError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section
      role="alert"
      className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/5 px-6 text-center"
    >
      <WifiOffIcon className="size-6 text-destructive" aria-hidden="true" />
      <h2 className="mt-4 text-base font-bold text-foreground">
        میزهای من در دسترس نیست
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-destructive">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 min-h-12 rounded-xl bg-amber-500 dark:bg-amber-400 px-5 text-sm font-bold text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
      >
        تلاش دوباره
      </button>
    </section>
  );
}

function WaiterBoardSkeleton() {
  return (
    <section
      className="space-y-4"
      aria-busy="true"
      aria-label="در حال بارگذاری میزهای من"
    >
      <div className={`flex flex-col gap-3 ${cardClass} p-4 sm:flex-row sm:items-center sm:justify-between`}>
        <div className="space-y-2">
          <div className="ops-skeleton h-5 w-44 rounded-lg" />
          <div className="ops-skeleton h-4 w-56 rounded-lg" />
        </div>
        <div className="ops-skeleton h-12 w-32 rounded-xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_19rem] lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-5">
          {[1, 2].map((section) => (
            <div key={section}>
              <div className="mb-3 flex justify-between">
                <div className="ops-skeleton h-5 w-24 rounded-lg" />
                <div className="ops-skeleton h-4 w-12 rounded-lg" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {[1, 2, 3].map((table) => (
                  <div
                    key={table}
                    className="ops-skeleton min-h-36 rounded-2xl"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <aside className={`hidden ${cardClass} p-5 md:block`}>
          <div className="ops-skeleton h-5 w-28 rounded-lg" />
          <div className="mt-4 space-y-3">
            <div className="ops-skeleton h-12 rounded-xl" />
            <div className="ops-skeleton h-12 rounded-xl" />
            <div className="ops-skeleton h-12 rounded-xl" />
          </div>
          <div className="ops-skeleton mt-5 h-[52px] rounded-xl" />
        </aside>
      </div>
    </section>
  );
}
