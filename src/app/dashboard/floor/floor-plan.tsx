"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BanIcon,
  CircleCheckIcon,
  RefreshCwIcon,
  ReceiptIcon,
  SparklesIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { TABLE_STATUS_LABELS, type TableStatus } from "@/lib/table-sessions";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useRealtime } from "../use-realtime";
import { KnowledgeHelpButton } from "../knowledge-help";
import { PageShell, cardClass } from "../page-chrome";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  ErrorBox,
  errorMessage,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { SessionPanel } from "./session-panel";

export interface FloorSection {
  id: string;
  name: string;
  color: string | null;
  assigned_waiter_id: string | null;
  waiter_name: string | null;
  sort_order: number;
}
export interface UpcomingReservation {
  id: string;
  customer_name: string;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
}
export interface FloorTable {
  id: string;
  name: string;
  section_id: string | null;
  capacity: number;
  status: TableStatus;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  shape: "rect" | "circle";
  sort_order: number;
  session_id: string | null;
  party_size: number | null;
  guest_name: string | null;
  session_opened_at: string | null;
  bill_requested_at: string | null;
  order_count: number | string;
  session_total: number | string;
  upcoming_reservation: UpcomingReservation | null;
}
interface Waiter {
  id: string;
  full_name: string;
}

const STATUS_STYLE: Record<TableStatus, string> = {
  free: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  seated: "border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300",
  bill_requested: "border-chart-7/25 bg-chart-7/5 text-chart-7",
  cleaning: "border-border/80 bg-muted text-muted-foreground",
  out_of_service: "border-destructive/30 bg-destructive/5 text-destructive",
};
/* Status is never color-only: each state also carries an icon (and label in the legend). */
const STATUS_ICON: Record<TableStatus, LucideIcon> = {
  free: CircleCheckIcon,
  seated: UsersIcon,
  bill_requested: ReceiptIcon,
  cleaning: SparklesIcon,
  out_of_service: BanIcon,
};
/*
  'bill_requested' is deliberately not advertised here: no action puts a table
  into it any more (the bill belongs to an order, settled at the order's own
  checkout). Its style and icon above are kept so a table left in that state by
  the old flow still renders correctly and can be moved out of it.
*/
const LEGEND: TableStatus[] = ["free", "seated", "cleaning", "out_of_service"];
const GRID = 10;
const snap = (n: number) => Math.max(0, Math.round(n / GRID) * GRID);
const SURFACE = cardClass;
const CONTROL =
  "min-h-12 rounded-xl border px-3 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98] motion-reduce:transition-none";

export function FloorPlan({ canEdit }: { canEdit: boolean }) {
  const [sections, setSections] = useState<FloorSection[]>([]);
  const [tables, setTables] = useState<FloorTable[]>([]);
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await api<{ sections: FloorSection[]; tables: FloorTable[] }>(
        "/api/floor",
      );
      if (res.ok) {
        setSections(res.data.sections);
        setTables(res.data.tables);
        setLoadError("");
      } else {
        setLoadError(
          "به‌روزرسانی پلان سالن ناموفق بود. داده‌های موجود حفظ شده‌اند.",
        );
      }
    } catch {
      setLoadError(
        "ارتباط با پلان سالن برقرار نشد. داده‌های موجود حفظ شده‌اند.",
      );
    } finally {
      setInitialLoading(false);
      setIsRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(
    useCallback(
      (event) => {
        if (
          [
            "table.status",
            "table_session.updated",
            "order.created",
            "order.updated",
          ].includes(event.type)
        )
          void load();
      },
      [load],
    ),
  );
  useEffect(() => {
    if (canEdit)
      api<{ waiters: Waiter[] }>("/api/staff").then(
        (r) => r.ok && setWaiters(r.data.waiters),
      );
  }, [canEdit]);

  const selected = tables.find((t) => t.id === selectedId) ?? null;

  function setWorkspaceMode(nextMode: "view" | "edit") {
    setMode(nextMode);
    setSelectedId(null);
    setError("");
  }

  function scrollToEditor(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  }

  return (
    <PageShell>
      <header className={`mb-3 ${SURFACE} overflow-hidden`}>
        <div className="flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            >
              <UsersIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold text-foreground">
                میزها و پلان سالن
              </h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                نمای عملیاتی سالن، نشست مهمان و چیدمان میزها
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 lg:justify-end">
            <KnowledgeHelpButton section="floor" />
            <span
              className="text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {isRefreshing
                ? "در حال به‌روزرسانی…"
                : `${toPersianDigits(tables.length)} میز فعال`}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              disabled={isRefreshing}
              className={`${CONTROL} flex shrink-0 items-center gap-2 border-border/80 bg-card text-muted-foreground hover:bg-muted disabled:opacity-60`}
              aria-label={
                isRefreshing
                  ? "در حال به‌روزرسانی پلان سالن"
                  : "به‌روزرسانی پلان سالن"
              }
            >
              <RefreshCwIcon
                className={`size-4 ${isRefreshing ? "ops-sync-rotate" : ""}`}
                aria-hidden="true"
              />
              <span>به‌روزرسانی</span>
            </button>
          </div>
        </div>

        <div className="border-t border-border/80 px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            {canEdit ? (
              <div
                className="inline-flex min-h-12 self-start rounded-xl border border-border/80 bg-muted p-1"
                role="tablist"
                aria-label="حالت نمایش پلان سالن"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "view"}
                  onClick={() => setWorkspaceMode("view")}
                  className={`min-h-10 rounded-lg px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 motion-reduce:transition-none ${
                    mode === "view"
                      ? "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 shadow-[0_1px_2px_rgb(41_37_36/0.05)]"
                      : "text-muted-foreground hover:bg-card"
                  }`}
                >
                  نمای سالن
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "edit"}
                  onClick={() => setWorkspaceMode("edit")}
                  className={`min-h-10 rounded-lg px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 motion-reduce:transition-none ${
                    mode === "edit"
                      ? "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 shadow-[0_1px_2px_rgb(41_37_36/0.05)]"
                      : "text-muted-foreground hover:bg-card"
                  }`}
                >
                  ویرایش پلان
                </button>
              </div>
            ) : (
              <span className="inline-flex min-h-12 items-center rounded-xl bg-amber-50 dark:bg-amber-500/15 px-3 text-sm font-bold text-amber-700 dark:text-amber-300">
                نمای سالن
              </span>
            )}

            {mode === "edit" && canEdit ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => scrollToEditor("floor-sections-editor")}
                  className={`${CONTROL} border-border/80 bg-card text-muted-foreground hover:bg-muted`}
                >
                  بخش‌ها و گارسون‌ها
                </button>
                <button
                  type="button"
                  onClick={() => scrollToEditor("floor-add-table")}
                  className={`${CONTROL} border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20`}
                >
                  افزودن میز
                </button>
              </div>
            ) : null}
          </div>

          {/*
            On a 360px phone the legend scrolls sideways and holds no control,
            so it has to take focus itself or a keyboard user can never reach
            the statuses past the edge (axe scrollable-region-focusable). The
            role makes the aria-label something a screen reader announces.
          */}
          <div
            role="group"
            tabIndex={0}
            className="mt-3 flex min-h-11 gap-2 overflow-x-auto rounded-xl pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
            aria-label="راهنمای وضعیت میزها"
          >
            {LEGEND.map((status) => {
              const Icon = STATUS_ICON[status];
              return (
                <span
                  key={status}
                  className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-bold ${STATUS_STYLE[status]}`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {TABLE_STATUS_LABELS[status]}
                </span>
              );
            })}
          </div>
        </div>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {loadError ? (
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

      {initialLoading ? (
        <FloorPlanSkeleton />
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Canvas
            tables={tables}
            sections={sections}
            mode={mode}
            selectedId={selectedId}
            loadError={tables.length === 0 ? loadError : ""}
            onRetry={() => void load()}
            onSelect={setSelectedId}
            onMove={(id, x, y) =>
              setTables((prev) =>
                prev.map((t) =>
                  t.id === id ? { ...t, pos_x: x, pos_y: y } : t,
                ),
              )
            }
            onPersistMove={async (id, x, y) => {
              const res = await api(`/api/tables/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ posX: x, posY: y }),
              });
              if (!res.ok)
                setError(errorMessage((res.data as { error?: string }).error));
            }}
          />

          <aside className="min-w-0 md:sticky md:top-4 md:max-h-[calc(100vh-2rem)] md:overflow-y-auto md:pb-1">
            {mode === "edit" ? (
              <EditorPanel
                sections={sections}
                tables={tables}
                waiters={waiters}
                selected={selected}
                onChange={load}
                setError={setError}
              />
            ) : selected ? (
              <ViewPanel
                table={selected}
                onChange={load}
                setError={setError}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <NoSelectionPanel />
            )}
          </aside>
        </div>
      )}
    </PageShell>
  );
}

function FloorPlanSkeleton() {
  return (
    <div
      className="grid gap-3 md:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_22rem]"
      aria-busy="true"
      aria-label="در حال بارگذاری پلان سالن"
    >
      <section className={`${SURFACE} min-h-[500px] overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-border/80 px-4 py-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="relative min-h-[448px] bg-muted">
          {[
            ["top-16", "end-12"],
            ["top-36", "end-1/3"],
            ["top-64", "end-20"],
            ["top-24", "start-16"],
            ["bottom-14", "start-1/3"],
          ].map(([vertical, horizontal], index) => (
            <Skeleton
              key={index}
              className={`absolute ${vertical} ${horizontal} size-20 ${cardClass}`}
            />
          ))}
        </div>
      </section>
      <aside className={`${SURFACE} min-h-56 p-4`}>
        <Skeleton className="block h-5 w-32" />
        <Skeleton className="mt-4 block h-12 w-full rounded-xl" />
        <Skeleton className="mt-3 block h-12 w-full rounded-xl" />
      </aside>
    </div>
  );
}

function NoSelectionPanel() {
  return (
    <div
      className={`${SURFACE} flex min-h-56 flex-col justify-center p-5 text-center`}
    >
      <span
        className="mx-auto flex size-11 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
        aria-hidden="true"
      >
        <UsersIcon className="size-5" />
      </span>
      <h2 className="mt-3 text-sm font-bold text-foreground">
        یک میز را انتخاب کنید
      </h2>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        برای مشاهدهٔ وضعیت و انجام عملیات مجازِ همان میز، آن را از روی پلان لمس
        یا انتخاب کنید.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ canvas */

function Canvas({
  tables,
  sections,
  mode,
  selectedId,
  loadError,
  onRetry,
  onSelect,
  onMove,
  onPersistMove,
}: {
  tables: FloorTable[];
  sections: FloorSection[];
  mode: "view" | "edit";
  selectedId: string | null;
  loadError: string;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onPersistMove: (id: string, x: number, y: number) => void;
}) {
  const money = useMoney();
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: string;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);
  const sectionName = (id: string | null) =>
    sections.find((s) => s.id === id)?.name;

  /* pos_x is the inline-start offset, so in RTL it is measured from the right edge —
     mirror the pointer's x accordingly so dragging tracks the cursor in both directions. */
  function inlineStartX(clientX: number, rect: DOMRect) {
    const rtl = canvasRef.current
      ? getComputedStyle(canvasRef.current).direction === "rtl"
      : false;
    return rtl ? rect.right - clientX : clientX - rect.left;
  }

  function onPointerDown(
    e: React.PointerEvent<HTMLButtonElement>,
    t: FloorTable,
  ) {
    if (mode !== "edit") {
      onSelect(t.id);
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    drag.current = {
      id: t.id,
      dx: inlineStartX(e.clientX, rect) - t.pos_x,
      dy: e.clientY - rect.top - t.pos_y,
      moved: false,
    };
    onSelect(t.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = snap(inlineStartX(e.clientX, rect) - drag.current.dx);
    const y = snap(e.clientY - rect.top - drag.current.dy);
    drag.current.moved = true;
    onMove(drag.current.id, x, y);
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved) {
      const t = tables.find((x) => x.id === d.id);
      if (t) onPersistMove(t.id, t.pos_x, t.pos_y);
    }
  }

  function onPointerCancel() {
    drag.current = null;
  }

  return (
    <section
      className={`${SURFACE} min-w-0 overflow-hidden`}
      aria-label="پلان سالن"
    >
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-foreground">پلان سالن</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {mode === "edit"
              ? "برای جابه‌جایی، میز را بکشید؛ تغییر مکان با همان سازوکار فعلی ذخیره می‌شود."
              : "برای مشاهدهٔ وضعیت یا عملیات مجاز، یک میز را انتخاب کنید."}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {toPersianDigits(tables.length)} میز
        </span>
      </div>
      <div
        ref={canvasRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="relative min-h-[480px] overflow-hidden bg-muted sm:min-h-[540px] xl:min-h-[620px]"
        style={{
          backgroundImage:
            mode === "edit"
              ? "linear-gradient(to right,var(--border) 1px,transparent 1px),linear-gradient(to bottom,var(--border) 1px,transparent 1px)"
              : undefined,
          backgroundSize: `${GRID * 2}px ${GRID * 2}px`,
        }}
      >
        {tables.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <span
              className="flex size-11 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            >
              <UsersIcon className="size-5" />
            </span>
            <h3 className="mt-3 text-sm font-bold text-foreground">
              {loadError
                ? "پلان سالن در دسترس نیست"
                : "هنوز میزی روی پلان نیست"}
            </h3>
            <p className="mt-2 max-w-80 text-xs leading-6 text-muted-foreground">
              {loadError ||
                (mode === "edit"
                  ? "از بخش «افزودن میز» برای ساخت اولین میز استفاده کنید."
                  : "پس از افزودن میز، وضعیت آن‌ها در اینجا دیده می‌شود.")}
            </p>
            {loadError ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-4 min-h-12 rounded-xl bg-amber-100 dark:bg-amber-500/20 px-4 text-sm font-bold text-amber-700 dark:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                تلاش دوباره
              </button>
            ) : null}
          </div>
        ) : null}
        {tables.map((t) => {
          const Icon = STATUS_ICON[t.status];
          const total = Number(t.session_total);
          const reserved = t.upcoming_reservation;
          const section = sectionName(t.section_id);
          const compact = t.width < 100 || t.height < 100;
          return (
            <button
              key={t.id}
              type="button"
              onPointerDown={(event) => onPointerDown(event, t)}
              onClick={() => onSelect(t.id)}
              aria-pressed={selectedId === t.id}
              aria-label={`میز ${t.name}، ${TABLE_STATUS_LABELS[t.status]}، ${toPersianDigits(t.capacity)} نفره${section ? `، بخش ${section}` : ""}`}
              className={`absolute flex min-h-16 min-w-16 flex-col items-center justify-center border-2 p-1.5 text-center text-xs shadow-[0_1px_2px_rgb(41_37_36/0.08)] transition-[color,background-color,border-color,box-shadow,transform] duration-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:focus-visible:ring-amber-400/45 focus-visible:ring-offset-2 active:scale-[0.98] motion-reduce:transition-none ${STATUS_STYLE[t.status]} ${
                selectedId === t.id
                  ? "z-10 ring-2 ring-amber-500 dark:ring-amber-400/45 ring-offset-2 ring-offset-background"
                  : ""
              } ${mode === "edit" ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
              style={{
                insetInlineStart: t.pos_x,
                top: t.pos_y,
                width: Math.max(t.width, 64),
                height: Math.max(t.height, 64),
                borderRadius: t.shape === "circle" ? "9999px" : "0.875rem",
              }}
            >
              <span className="flex max-w-full items-center gap-1 truncate font-bold leading-tight">
                <Icon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{t.name}</span>
              </span>
              <span className="mt-0.5 max-w-full truncate rounded-xl bg-background/65 px-1 text-[9px] font-bold leading-4">
                {TABLE_STATUS_LABELS[t.status]}
              </span>
              {!compact ? (
                <span className="mt-0.5 max-w-full truncate text-[10px] opacity-75">
                  {toPersianDigits(t.capacity)} نفره
                  {section ? ` · ${section}` : ""}
                </span>
              ) : null}
              {!compact && t.session_id ? (
                <span className="mt-0.5 max-w-full truncate text-[10px] font-bold">
                  {money.format(total)}
                </span>
              ) : null}
              {!compact && reserved && t.status === "free" ? (
                <span className="mt-0.5 max-w-full truncate rounded-xl bg-chart-1 px-1 text-[9px] font-bold text-primary-foreground">
                  رزرو{" "}
                  {toPersianDigits(formatJalali(reserved.reserved_at).slice(5))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- view panel */

function ViewPanel({
  table,
  onChange,
  setError,
  onClose,
}: {
  table: FloorTable;
  onChange: () => void;
  setError: (s: string) => void;
  onClose: () => void;
}) {
  const [seating, setSeating] = useState(false);
  const [partySize, setPartySize] = useState("");
  const [guestName, setGuestName] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(body: object, url = `/api/tables/${table.id}`) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(url, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }

  async function seat() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>("/api/table-sessions", {
      method: "POST",
      body: JSON.stringify({
        tableId: table.id,
        partySize: partySize ? Number(partySize) : undefined,
        guestName: guestName || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setSeating(false);
    setPartySize("");
    setGuestName("");
    onChange();
  }

  return (
    <div className={`${SURFACE} p-4 sm:p-5`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-foreground">
              میز {table.name}
            </h2>
            <span
              className={`inline-flex min-h-7 items-center rounded-lg border px-2 text-[11px] font-bold ${STATUS_STYLE[table.status]}`}
            >
              {TABLE_STATUS_LABELS[table.status]}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {toPersianDigits(table.capacity)} نفره
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98] motion-reduce:transition-none"
          aria-label="بستن جزئیات میز"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      {table.upcoming_reservation ? (
        <div className="mb-4 rounded-xl border border-chart-1/25 bg-chart-1/5 px-3 py-2.5 text-xs leading-6 text-chart-1">
          رزرو پیش‌رو: {table.upcoming_reservation.customer_name} ·{" "}
          {toPersianDigits(
            formatJalali(table.upcoming_reservation.reserved_at, {
              withMonthName: true,
            }),
          )}{" "}
          ·{" "}
          {toPersianDigits(
            new Date(table.upcoming_reservation.reserved_at).toLocaleTimeString(
              "en-GB",
              {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Asia/Tehran",
              },
            ),
          )}
        </div>
      ) : null}

      {table.status === "free" ? (
        seating ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/80 bg-muted p-3">
              <h3 className="text-sm font-bold text-foreground">نشاندن مهمان</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                اطلاعات نشست فقط با همین جریان فعلی ثبت می‌شود.
              </p>
              <label className="mt-3 block">
                <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
                  تعداد نفرات
                </span>
                <PersianNumberInput
                  className={`${inputClass} min-h-12 border-border/80 bg-card`}
                  inputMode="numeric"
                  dir="ltr"
                  value={partySize}
                  onChange={(e) => setPartySize(e.target.value)}
                  placeholder="اختیاری"
                  aria-label="تعداد نفرات مهمان"
                />
              </label>
              <label className="mt-3 block">
                <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
                  نام مهمان{" "}
                  <span className="font-normal text-muted-foreground">(اختیاری)</span>
                </span>
                <input
                  className={`${inputClass} min-h-12 border-border/80 bg-card`}
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="نام مهمان"
                  aria-label="نام مهمان"
                />
              </label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <PrimaryButton type="button" onClick={seat} disabled={busy}>
                نشاندن مهمان
              </PrimaryButton>
              <SecondaryButton onClick={() => setSeating(false)}>
                انصراف
              </SecondaryButton>
            </div>
          </div>
        ) : (
          <PrimaryButton type="button" onClick={() => setSeating(true)}>
            باز کردن میز (نشاندن مهمان)
          </PrimaryButton>
        )
      ) : null}

      {table.status === "cleaning" ? (
        <PrimaryButton
          type="button"
          onClick={() => act({ status: "free" })}
          disabled={busy}
        >
          میز تمیز شد
        </PrimaryButton>
      ) : null}

      {table.status === "out_of_service" ? (
        <PrimaryButton
          type="button"
          onClick={() => act({ status: "free" })}
          disabled={busy}
        >
          بازگرداندن به سرویس
        </PrimaryButton>
      ) : null}

      {table.status === "free" && !seating ? (
        <button
          type="button"
          onClick={() => act({ status: "out_of_service" })}
          className="mt-3 min-h-11 px-1 text-xs font-bold text-muted-foreground transition hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
        >
          خارج کردن از سرویس
        </button>
      ) : null}

      {table.session_id ? (
        <SessionPanel
          sessionId={table.session_id}
          onChange={onChange}
          setError={setError}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ editor panel */

function EditorPanel({
  sections,
  tables,
  waiters,
  selected,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  tables: FloorTable[];
  waiters: Waiter[];
  selected: FloorTable | null;
  onChange: () => void;
  setError: (s: string) => void;
}) {
  return (
    <div className="space-y-3">
      <SectionEditor
        sections={sections}
        waiters={waiters}
        onChange={onChange}
        setError={setError}
      />
      <AddTable sections={sections} onChange={onChange} setError={setError} />
      {selected ? (
        <TableEditor
          table={selected}
          sections={sections}
          onChange={onChange}
          setError={setError}
        />
      ) : (
        <div className={`${SURFACE} p-4 text-xs leading-6 text-muted-foreground`}>
          برای ویرایش یک میز، آن را روی پلان انتخاب کنید. برای جابه‌جایی، میز را
          بکشید.
        </div>
      )}
      <p className="px-1 text-xs text-muted-foreground">
        تعداد میزهای فعال: {toPersianDigits(tables.length)}
      </p>
    </div>
  );
}

function SectionEditor({
  sections,
  waiters,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  waiters: Waiter[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function addSection() {
    if (!name.trim()) return;
    setBusy(true);
    const res = await api<{ error?: string }>("/api/floor/sections", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setName("");
    onChange();
  }
  async function assignWaiter(id: string, waiterId: string) {
    const res = await api<{ error?: string }>(`/api/floor/sections/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ assignedWaiterId: waiterId || null }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }
  async function removeSection(id: string) {
    const res = await api<{ error?: string }>(`/api/floor/sections/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }

  return (
    <section
      id="floor-sections-editor"
      className={`${SURFACE} scroll-mt-4 p-4`}
      aria-labelledby="floor-sections-title"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3
            id="floor-sections-title"
            className="text-sm font-bold text-foreground"
          >
            بخش‌ها و گارسون‌ها
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            مدیریت بخش‌های موجود و گارسون هر بخش
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {toPersianDigits(sections.length)} بخش
        </span>
      </div>
      <div className="mb-4 rounded-xl border border-border/80 bg-muted p-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            نام بخش جدید
          </span>
          <input
            className={`${inputClass} min-h-12 border-border/80 bg-card`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً سالن اصلی"
            aria-label="نام بخش جدید"
          />
        </label>
        <button
          type="button"
          onClick={addSection}
          disabled={busy}
          className={`mt-3 w-full ${CONTROL} border-border/80 bg-card text-muted-foreground hover:bg-muted disabled:opacity-60`}
        >
          افزودن بخش
        </button>
      </div>
      <ul className="space-y-2">
        {sections.map((s) => (
          <li
            key={s.id}
            className={`${cardClass} p-3`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-bold text-foreground">
                {s.name}
              </span>
              <button
                type="button"
                onClick={() => removeSection(s.id)}
                className="min-h-10 shrink-0 px-1 text-xs font-bold text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                حذف
              </button>
            </div>
            <label className="mt-2 block">
              <span className="mb-1 block text-[11px] font-bold text-muted-foreground">
                گارسون بخش
              </span>
              <SearchableSelect
                className={`${inputClass} min-h-11 border-border/80 bg-muted py-1 text-xs`}
                value={s.assigned_waiter_id ?? ""}
                onChange={(value) => assignWaiter(s.id, value)}
                ariaLabel={`گارسون بخش ${s.name}`}
                options={[
                  { value: "", label: "بدون گارسون" },
                  ...waiters.map((w) => ({ value: w.id, label: w.full_name })),
                ]}
              />
            </label>
          </li>
        ))}
        {sections.length === 0 ? (
          <li className="rounded-xl border border-dashed border-border/80 bg-muted p-3 text-xs leading-6 text-muted-foreground">
            هنوز بخشی تعریف نشده است.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function AddTable({
  sections,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("4");
  const [sectionId, setSectionId] = useState("");
  const [shape, setShape] = useState<"rect" | "circle">("rect");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return setError(errorMessage("missing_fields"));
    setBusy(true);
    const res = await api<{ error?: string }>("/api/tables", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        capacity: Number(capacity) || 2,
        sectionId: sectionId || undefined,
        shape,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setName("");
    onChange();
  }

  return (
    <section
      id="floor-add-table"
      className={`${SURFACE} scroll-mt-4 p-4`}
      aria-labelledby="floor-add-table-title"
    >
      <div className="mb-3">
        <h3
          id="floor-add-table-title"
          className="text-sm font-bold text-foreground"
        >
          افزودن میز
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          نام، ظرفیت، شکل و بخش با همان اعتبارسنجی فعلی ثبت می‌شوند.
        </p>
      </div>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            نام یا شمارهٔ میز
          </span>
          <input
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً ۱۲"
            aria-label="نام یا شمارهٔ میز"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            ظرفیت
          </span>
          <PersianNumberInput
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            inputMode="numeric"
            dir="ltr"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="۴"
            aria-label="ظرفیت میز"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            بخش
          </span>
          <SearchableSelect
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            value={sectionId}
            onChange={setSectionId}
            ariaLabel="بخش میز"
            options={[
              { value: "", label: "بدون بخش" },
              ...sections.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            شکل میز
          </span>
          <SearchableSelect
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            value={shape}
            onChange={(value) => setShape(value as "rect" | "circle")}
            ariaLabel="شکل میز"
            options={[
              { value: "rect", label: "مربع/مستطیل" },
              { value: "circle", label: "گرد" },
            ]}
          />
        </label>
      </div>
      <button
        type="button"
        onClick={add}
        disabled={busy}
        className={`mt-4 w-full ${CONTROL} border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 disabled:opacity-60`}
      >
        افزودن میز
      </button>
    </section>
  );
}

function TableEditor({
  table,
  sections,
  onChange,
  setError,
}: {
  table: FloorTable;
  sections: FloorSection[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState(table.name);
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [sectionId, setSectionId] = useState(table.section_id ?? "");
  const [shape, setShape] = useState<"rect" | "circle">(table.shape);
  const [width, setWidth] = useState(String(table.width));
  const [height, setHeight] = useState(String(table.height));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(table.name);
    setCapacity(String(table.capacity));
    setSectionId(table.section_id ?? "");
    setShape(table.shape);
    setWidth(String(table.width));
    setHeight(String(table.height));
  }, [table]);

  async function save() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/tables/${table.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: name.trim(),
        capacity: Number(capacity) || 2,
        sectionId: sectionId || null,
        shape,
        width: Number(width) || 80,
        height: Number(height) || 80,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }
  async function remove() {
    setBusy(true);
    const res = await api<{ error?: string }>(`/api/tables/${table.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }

  return (
    <section
      className={`${SURFACE} p-4`}
      aria-labelledby="floor-table-editor-title"
    >
      <div className="mb-3">
        <h3
          id="floor-table-editor-title"
          className="text-sm font-bold text-foreground"
        >
          ویرایش میز {table.name}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          مشخصات و ابعاد با همان مدل ذخیره‌سازی پلان به‌روزرسانی می‌شوند.
        </p>
      </div>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            نام میز
          </span>
          <input
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="نام میز"
            aria-label="نام میز"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            ظرفیت
          </span>
          <PersianNumberInput
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            inputMode="numeric"
            dir="ltr"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="ظرفیت"
            aria-label="ظرفیت میز"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            بخش
          </span>
          <SearchableSelect
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            value={sectionId}
            onChange={setSectionId}
            ariaLabel="بخش میز"
            options={[
              { value: "", label: "بدون بخش" },
              ...sections.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
            شکل میز
          </span>
          <SearchableSelect
            className={`${inputClass} min-h-12 border-border/80 bg-muted`}
            value={shape}
            onChange={(value) => setShape(value as "rect" | "circle")}
            ariaLabel="شکل میز"
            options={[
              { value: "rect", label: "مربع/مستطیل" },
              { value: "circle", label: "گرد" },
            ]}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
              عرض
            </span>
            <PersianNumberInput
              className={`${inputClass} min-h-12 border-border/80 bg-muted`}
              inputMode="numeric"
              dir="ltr"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              placeholder="عرض"
              aria-label="عرض میز"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold text-muted-foreground">
              ارتفاع
            </span>
            <PersianNumberInput
              className={`${inputClass} min-h-12 border-border/80 bg-muted`}
              inputMode="numeric"
              dir="ltr"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              placeholder="ارتفاع"
              aria-label="ارتفاع میز"
            />
          </label>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <PrimaryButton type="button" onClick={save} disabled={busy}>
          ذخیرهٔ تغییرات
        </PrimaryButton>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="min-h-11 self-start px-1 text-xs font-bold text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-60"
        >
          حذف میز
        </button>
      </div>
    </section>
  );
}
