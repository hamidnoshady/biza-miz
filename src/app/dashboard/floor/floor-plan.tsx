"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatTimeInTimeZone } from "@/lib/reservations";
import { TABLE_STATUS_LABELS, type TableStatus } from "@/lib/table-sessions";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { KnowledgeHelpButton } from "../knowledge-help";
import { useRealtime } from "../use-realtime";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { cardClass, LoadingSkeleton, PageShell } from "../page-chrome";
import { SessionPanel } from "./session-panel";

export interface FloorSection {
  id: string;
  name: string;
  color: string;
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
  zone: string | null;
  section_id: string | null;
  capacity: number;
  status: TableStatus;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  shape: "rect" | "round" | "booth";
  note?: string | null;
  session_id: string | null;
  party_size: number | null;
  guest_name: string | null;
  session_opened_at: string | null;
  bill_requested_at: string | null;
  session_note: string | null;
  active_order_count?: number;
  order_count: number;
  session_total: string | number;
  upcoming_reservation: UpcomingReservation | null;
}

interface StaffMember {
  id: string;
  full_name: string;
  role: string;
}

const STATUS_STYLE: Record<TableStatus, { bg: string; ring: string; dot: string }> = {
  free: {
    bg: "bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/60 text-emerald-950 dark:text-emerald-100",
    ring: "ring-emerald-500 dark:ring-emerald-400",
    dot: "bg-emerald-500 dark:bg-emerald-500",
  },
  reserved: {
    bg: "bg-sky-50 dark:bg-sky-500/15 border-sky-400 dark:border-sky-500/60 text-sky-950 dark:text-sky-100",
    ring: "ring-sky-500 dark:ring-sky-400",
    dot: "bg-sky-500 dark:bg-sky-500",
  },
  seated: {
    bg: "bg-amber-50 dark:bg-amber-500/15 border-amber-400 dark:border-amber-500/60 text-amber-950 dark:text-amber-100",
    ring: "ring-amber-500 dark:ring-amber-400",
    dot: "bg-amber-500 dark:bg-amber-500",
  },
  bill_requested: {
    bg: "bg-amber-50 dark:bg-amber-500/15 border-amber-400 dark:border-amber-500/60 text-amber-950 dark:text-amber-100",
    ring: "ring-amber-500 dark:ring-amber-400",
    dot: "bg-amber-500 dark:bg-amber-500",
  },
  cleaning: {
    bg: "bg-muted border-border text-foreground",
    ring: "ring-ring",
    dot: "bg-muted-foreground",
  },
  out_of_service: {
    bg: "bg-muted/60 border-border text-muted-foreground",
    ring: "ring-border",
    dot: "bg-muted-foreground/50",
  },
};

const CANVAS_MIN_W = 860;
const CANVAS_MIN_H = 540;
const CANVAS_MAX_W = 2400;
const CANVAS_MAX_H = 1600;
const GRID = 20;

const MANUAL_STATUS_CHOICES: TableStatus[] = [
  "free",
  "seated",
  "cleaning",
  "out_of_service",
];

function snap(n: number) {
  return Math.max(0, Math.round(n / GRID) * GRID);
}

function clampCoord(n: number, max: number) {
  return Math.min(Math.max(0, n), max);
}

export function FloorPlan({ canEdit }: { canEdit: boolean }) {
  const [timezone, setTimezone] = useState("Asia/Tehran");
  const [sections, setSections] = useState<FloorSection[]>([]);
  const [tables, setTables] = useState<FloorTable[]>([]);
  const [archivedTables, setArchivedTables] = useState<FloorTable[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [activeSection, setActiveSection] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"canvas" | "list">("canvas");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{
      timezone?: string;
      sections: FloorSection[];
      tables: FloorTable[];
      archivedTables?: FloorTable[];
    }>("/api/floor");
    if (res.ok) {
      if (res.data.timezone) setTimezone(res.data.timezone);
      setSections(res.data.sections);
      setTables(res.data.tables);
      setArchivedTables(res.data.archivedTables ?? []);
    } else {
      setError(errorMessage((res.data as { error?: string }).error));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    if (canEdit) {
      void api<{ staff?: StaffMember[]; waiters?: StaffMember[] }>("/api/staff").then(
        ({ ok, data }) => {
          if (ok) setStaff(data.staff ?? data.waiters ?? []);
        },
      );
    }
  }, [load, canEdit]);

  useRealtime(
    useCallback(
      (event) => {
        if (
          event.type === "table.status" ||
          event.type === "table_session.updated" ||
          event.type === "floor.updated"
        ) {
          void load();
        }
      },
      [load],
    ),
  );

  const visibleTables =
    activeSection === "all"
      ? tables
      : activeSection === "none"
        ? tables.filter((t) => !t.section_id)
        : tables.filter((t) => t.section_id === activeSection);

  const selected = tables.find((t) => t.id === selectedId) ?? null;

  return (
    <PageShell>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">نقشه سالن و میزها</h1>
          <p className="text-xs text-muted-foreground">
            وضعیت زنده میزها، مدیریت بخش‌ها و چیدمان
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <KnowledgeHelpButton section="floor" />
          <SecondaryButton
            onClick={() =>
              setLayoutMode((m) => (m === "canvas" ? "list" : "canvas"))
            }
          >
            {layoutMode === "canvas" ? "نمایش فهرستی" : "نمایش نقشه"}
          </SecondaryButton>
          {canEdit ? (
            <SecondaryButton onClick={() => setEditMode((v) => !v)}>
              {editMode ? "پایان ویرایش چیدمان" : "ویرایش چیدمان"}
            </SecondaryButton>
          ) : null}
        </div>
      </div>
      <ErrorBox>{error}</ErrorBox>

      {/* Section tabs + legend */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          <SectionTab
            active={activeSection === "all"}
            onClick={() => setActiveSection("all")}
            label={`همه (${toPersianDigits(tables.length)})`}
          />
          {sections.map((s) => (
            <SectionTab
              key={s.id}
              active={activeSection === s.id}
              onClick={() => setActiveSection(s.id)}
              color={s.color}
              label={`${s.name}${s.waiter_name ? ` · ${s.waiter_name}` : ""}`}
            />
          ))}
          {tables.some((t) => !t.section_id) ? (
            <SectionTab
              active={activeSection === "none"}
              onClick={() => setActiveSection("none")}
              label="بدون بخش"
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {(["free", "seated", "cleaning", "out_of_service"] as TableStatus[]).map(
            (st) => (
              <span key={st} className="inline-flex items-center gap-1.5">
                <span className={`size-2.5 rounded-full ${STATUS_STYLE[st].dot}`} />
                {TABLE_STATUS_LABELS[st]}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {layoutMode === "canvas" ? (
          <Canvas
            tables={visibleTables}
            sections={sections}
            selectedId={selectedId}
            onSelect={setSelectedId}
            editMode={editMode && canEdit}
            timezone={timezone}
            onMoved={(id, pos_x, pos_y) => {
              setTables((prev) =>
                prev.map((t) => (t.id === id ? { ...t, pos_x, pos_y } : t)),
              );
            }}
            onMoveFailed={() => {
              void load();
            }}
            setError={setError}
          />
        ) : (
          <TableListFallback
            tables={visibleTables}
            sections={sections}
            selectedId={selectedId}
            onSelect={setSelectedId}
            timezone={timezone}
          />
        )}

        <div className="w-full shrink-0 lg:w-96">
          {editMode && canEdit ? (
            <EditorPanel
              sections={sections}
              tables={tables}
              archivedTables={archivedTables}
              staff={staff}
              selected={selected}
              onChange={() => void load()}
              onDeselect={() => setSelectedId(null)}
              setError={setError}
            />
          ) : selected ? (
            <ViewPanel
              table={selected}
              sections={sections}
              tables={tables}
              timezone={timezone}
              onRefresh={() => void load()}
              setError={setError}
            />
          ) : loaded ? (
            <div className={`${cardClass} p-6 text-center text-sm text-muted-foreground`}>
              یک میز را از روی نقشه انتخاب کنید.
            </div>
          ) : (
            <LoadingSkeleton rows={4} label="در حال بارگذاری پلان سالن" />
          )}
        </div>
      </div>
    </PageShell>
  );
}

function SectionTab({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
      }`}
    >
      {color ? (
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: color }}
        />
      ) : null}
      {label}
    </button>
  );
}

function TableListFallback({
  tables,
  sections,
  selectedId,
  onSelect,
  timezone,
}: {
  tables: FloorTable[];
  sections: FloorSection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  timezone: string;
}) {
  const sectionMap = new Map(sections.map((s) => [s.id, s]));
  return (
    <div className={`flex-1 ${cardClass} p-4`}>
      {tables.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          میزی در این بخش وجود ندارد.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tables.map((t) => {
            const st = STATUS_STYLE[t.status] ?? STATUS_STYLE.free;
            const sec = t.section_id ? sectionMap.get(t.section_id) : null;
            const activeOrders = t.active_order_count ?? 0;
            const isSelected = t.id === selectedId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelect(t.id)}
                className={`flex flex-col justify-between rounded-xl border-2 p-3 text-right transition ${st.bg} ${
                  isSelected ? `ring-2 ${st.ring}` : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-sm font-bold">{t.name}</span>
                    {sec ? (
                      <span className="mr-2 text-[11px] opacity-75">
                        ({sec.name})
                      </span>
                    ) : null}
                  </div>
                  <span className="rounded-full bg-background/80 px-2 py-0.5 text-[11px] font-semibold">
                    {TABLE_STATUS_LABELS[t.status]}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>ظرفیت {toPersianDigits(t.capacity)} نفر</span>
                  {activeOrders > 0 ? (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 font-bold text-primary">
                      {toPersianDigits(activeOrders)} سفارش فعال
                    </span>
                  ) : null}
                  {t.upcoming_reservation ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                      رزرو{" "}
                      {toPersianDigits(
                        formatTimeInTimeZone(
                          t.upcoming_reservation.reserved_at,
                          timezone,
                        ),
                      )}
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Canvas({
  tables,
  sections,
  selectedId,
  onSelect,
  editMode,
  timezone,
  onMoved,
  onMoveFailed,
  setError,
}: {
  tables: FloorTable[];
  sections: FloorSection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  editMode: boolean;
  timezone: string;
  onMoved: (id: string, x: number, y: number) => void;
  onMoveFailed: () => void;
  setError: (msg: string) => void;
}) {
  const money = useMoney();
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    width: number;
    height: number;
  } | null>(null);

  const sectionColor = new Map(sections.map((s) => [s.id, s.color]));

  const maxRight = tables.reduce(
    (acc, t) => Math.max(acc, (t.pos_x ?? 0) + (t.width ?? 96) + 60),
    CANVAS_MIN_W,
  );
  const maxBottom = tables.reduce(
    (acc, t) => Math.max(acc, (t.pos_y ?? 0) + (t.height ?? 96) + 60),
    CANVAS_MIN_H,
  );
  const canvasW = Math.min(CANVAS_MAX_W, Math.max(CANVAS_MIN_W, maxRight));
  const canvasH = Math.min(CANVAS_MAX_H, Math.max(CANVAS_MIN_H, maxBottom));

  function onMouseMove(e: React.MouseEvent) {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / zoom;
    const dy = (e.clientY - drag.startY) / zoom;
    const maxX = Math.max(0, CANVAS_MAX_W - drag.width);
    const maxY = Math.max(0, CANVAS_MAX_H - drag.height);
    onMoved(
      drag.id,
      clampCoord(snap(drag.origX + dx), maxX),
      clampCoord(snap(drag.origY + dy), maxY),
    );
  }

  async function onMouseUp() {
    if (!drag) return;
    const currentDrag = drag;
    setDrag(null);
    const t = tables.find((x) => x.id === currentDrag.id);
    if (
      t &&
      (t.pos_x !== currentDrag.origX || t.pos_y !== currentDrag.origY)
    ) {
      const r = await api<{ error?: string }>(`/api/tables/${t.id}`, {
        method: "PATCH",
        body: JSON.stringify({ posX: t.pos_x, posY: t.pos_y }),
      });
      if (!r.ok) {
        onMoved(currentDrag.id, currentDrag.origX, currentDrag.origY);
        onMoveFailed();
        setError(errorMessage(r.data.error));
      }
    }
  }

  return (
    <div className="flex-1 overflow-auto rounded-2xl border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-end gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.1).toFixed(2))))}
          className="rounded border border-border bg-card px-2 py-1 font-bold hover:bg-muted"
          aria-label="کوچک‌نمایی"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="rounded border border-border bg-card px-2 py-1 text-muted-foreground hover:bg-muted"
        >
          {toPersianDigits(Math.round(zoom * 100))}٪
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(1.5, Number((z + 0.1).toFixed(2))))}
          className="rounded border border-border bg-card px-2 py-1 font-bold hover:bg-muted"
          aria-label="بزرگ‌نمایی"
        >
          +
        </button>
      </div>
      <div
        ref={ref}
        onMouseMove={onMouseMove}
        onMouseUp={() => void onMouseUp()}
        onMouseLeave={() => void onMouseUp()}
        dir="ltr"
        style={{
          width: canvasW,
          height: canvasH,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
          backgroundImage: editMode
            ? "radial-gradient(circle, #d6d3d1 1px, transparent 1px)"
            : undefined,
          backgroundSize: `${GRID}px ${GRID}px`,
        }}
        className="relative select-none rounded-xl bg-card shadow-inner"
      >
        {tables.map((t) => {
          const st = STATUS_STYLE[t.status] ?? STATUS_STYLE.free;
          const selected = t.id === selectedId;
          const secColor = t.section_id ? sectionColor.get(t.section_id) : undefined;
          const activeOrderCount = t.active_order_count ?? 0;
          const radius =
            t.shape === "round"
              ? "rounded-full"
              : t.shape === "booth"
                ? "rounded-3xl"
                : "rounded-xl";
          return (
            <button
              key={t.id}
              type="button"
              dir="rtl"
              onClick={() => onSelect(t.id)}
              onMouseDown={(e) => {
                if (!editMode) return;
                e.stopPropagation();
                setDrag({
                  id: t.id,
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: t.pos_x,
                  origY: t.pos_y,
                  width: t.width || 96,
                  height: t.height || 96,
                });
              }}
              style={{
                left: clampCoord(t.pos_x, Math.max(0, canvasW - (t.width || 96))),
                top: clampCoord(t.pos_y, Math.max(0, canvasH - (t.height || 96))),
                width: t.width,
                height: t.height,
              }}
              className={`absolute flex flex-col items-center justify-center border-2 p-2 text-center transition ${radius} ${st.bg} ${
                selected ? `ring-2 ring-offset-2 ${st.ring}` : ""
              } ${editMode ? "cursor-move" : "cursor-pointer"}`}
            >
              {secColor ? (
                <span
                  className="absolute top-1.5 right-1.5 size-2.5 rounded-full"
                  style={{ backgroundColor: secColor }}
                />
              ) : null}
              <span className="text-sm font-bold leading-tight">{t.name}</span>
              <span className="text-[11px] opacity-75">
                {t.party_size
                  ? `${toPersianDigits(t.party_size)}/${toPersianDigits(t.capacity)} نفر`
                  : `${toPersianDigits(t.capacity)} نفر`}
              </span>
              {t.guest_name ? (
                <span className="mt-0.5 max-w-full truncate text-[10px] font-medium">
                  {t.guest_name}
                </span>
              ) : null}
              {activeOrderCount > 0 ? (
                <span className="mt-0.5 rounded bg-background/80 px-1.5 text-[10px] font-semibold">
                  {toPersianDigits(activeOrderCount)} سفارش ·{" "}
                  {money.format(Number(t.session_total))}
                </span>
              ) : Number(t.session_total) > 0 ? (
                <span className="mt-0.5 rounded bg-background/70 px-1.5 text-[10px] font-semibold">
                  {money.format(Number(t.session_total))}
                </span>
              ) : null}
              {t.upcoming_reservation && t.status === "free" ? (
                <span className="mt-0.5 rounded bg-primary/10 px-1 text-[10px] text-primary">
                  رزرو{" "}
                  {toPersianDigits(
                    formatTimeInTimeZone(
                      t.upcoming_reservation.reserved_at,
                      timezone,
                    ),
                  )}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Runtime view panel (seat / status / session) ---------------- */

function ViewPanel({
  table,
  sections,
  tables,
  timezone,
  onRefresh,
  setError,
}: {
  table: FloorTable;
  sections: FloorSection[];
  tables: FloorTable[];
  timezone: string;
  onRefresh: () => void;
  setError: (s: string) => void;
}) {
  const [partySize, setPartySize] = useState(String(table.capacity));
  const [guestName, setGuestName] = useState("");
  const [extraTables, setExtraTables] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictReservation, setConflictReservation] = useState<{
    customerName?: string;
    reservedAt?: string;
  } | null>(null);

  useEffect(() => {
    setPartySize(String(table.capacity));
    setGuestName("");
    setExtraTables([]);
    setNote("");
    setConflictReservation(null);
  }, [table.id, table.capacity]);

  const section = sections.find((s) => s.id === table.section_id);
  const freeOthers = tables.filter(
    (t) => t.id !== table.id && t.status === "free",
  );
  const activeOrderCount = table.active_order_count ?? 0;

  async function setStatus(status: TableStatus) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/tables/${table.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onRefresh();
  }

  async function openSession(ignoreUpcomingReservation = false) {
    setBusy(true);
    setError("");
    const res = await api<{
      error?: string;
      reservation?: { customerName?: string; reservedAt?: string };
    }>("/api/table-sessions", {
      method: "POST",
      body: JSON.stringify({
        tableIds: [table.id, ...extraTables],
        partySize: Number(partySize) || null,
        guestName: guestName || null,
        note: note || null,
        ignoreUpcomingReservation,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.data.error === "upcoming_reservation_conflict") {
        setConflictReservation(res.data.reservation ?? {});
        return;
      }
      return setError(errorMessage(res.data.error));
    }
    setConflictReservation(null);
    onRefresh();
  }

  async function seatReservation(resId: string) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/reservations/${resId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "seat" }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onRefresh();
  }

  return (
    <div className={`${cardClass} p-4`}>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold">{table.name}</h2>
          <p className="text-xs text-muted-foreground">
            ظرفیت {toPersianDigits(table.capacity)} نفر
            {section
              ? ` · ${section.name}${section.waiter_name ? ` (${section.waiter_name})` : ""}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {activeOrderCount > 0 ? (
            <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-bold text-primary">
              {toPersianDigits(activeOrderCount)} سفارش فعال
            </span>
          ) : null}
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[table.status].bg}`}
          >
            {TABLE_STATUS_LABELS[table.status]}
          </span>
        </div>
      </div>

      {table.note ? (
        <p className="mb-3 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          یادداشت میز: {table.note}
        </p>
      ) : null}

      {/* Manual physical status controls: always available, independent of orders */}
      <div className="mb-4 rounded-xl border border-border/80 bg-muted/30 p-2.5">
        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
          وضعیت فیزیکی میز (مستقل از سفارش‌ها)
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {MANUAL_STATUS_CHOICES.map((st) => {
            const isCurrent = table.status === st;
            return (
              <button
                key={st}
                type="button"
                disabled={busy || isCurrent}
                onClick={() => void setStatus(st)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                  isCurrent
                    ? `${STATUS_STYLE[st].bg} font-bold`
                    : "border-border bg-card text-foreground hover:bg-muted"
                } disabled:opacity-60`}
              >
                {TABLE_STATUS_LABELS[st]}
              </button>
            );
          })}
        </div>
      </div>

      {table.upcoming_reservation ? (
        <div className="mb-3 rounded-lg border border-primary/20 bg-primary/10 p-2.5 text-xs">
          <div className="font-semibold text-foreground">
            رزرو بعدی: {table.upcoming_reservation.customer_name} (
            {toPersianDigits(table.upcoming_reservation.party_size)} نفر)
          </div>
          <div className="text-primary">
            ساعت{" "}
            {toPersianDigits(
              formatTimeInTimeZone(
                table.upcoming_reservation.reserved_at,
                timezone,
              ),
            )}
          </div>
          {!table.session_id ? (
            <button
              type="button"
              onClick={() =>
                seatReservation(table.upcoming_reservation!.id)
              }
              disabled={busy}
              className="mt-2 rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring focus-visible:ring-ring/50 outline-none"
            >
              نشاندن این رزرو
            </button>
          ) : null}
        </div>
      ) : null}

      {conflictReservation ? (
        <div className="mb-3 space-y-2 rounded-lg border border-amber-400/60 bg-amber-50/80 dark:bg-amber-500/15 p-3 text-xs">
          <p className="font-bold text-amber-950 dark:text-amber-100">
            هشدار تداخل با رزرو نزدیک روی این میز
          </p>
          <p className="text-amber-900 dark:text-amber-200">
            رزرو به نام {conflictReservation.customerName ?? "مهمان"} در ساعت{" "}
            {conflictReservation.reservedAt
              ? toPersianDigits(
                  formatTimeInTimeZone(
                    conflictReservation.reservedAt,
                    timezone,
                  ),
                )
              : "نزدیک"}{" "}
            ثبت شده است.
          </p>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton
              type="button"
              disabled={busy}
              onClick={() => void openSession(true)}
            >
              نشاندن با آگاهی از رزرو
            </PrimaryButton>
            <SecondaryButton
              onClick={() => setConflictReservation(null)}
              disabled={busy}
            >
              انصراف
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      {!table.session_id && table.status !== "out_of_service" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="تعداد نفرات">
              <PersianNumberInput
                inputMode="numeric"
                className={inputClass}
                value={partySize}
                onChange={(e) => setPartySize(e.target.value)}
              />
            </Field>
            <Field label="نام مهمان (اختیاری)">
              <input
                className={inputClass}
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
              />
            </Field>
          </div>
          {freeOthers.length > 0 ? (
            <Field label="ادغام با میز دیگر (برای گروه‌های بزرگ)">
              <div className="flex flex-wrap gap-1.5">
                {freeOthers.map((o) => {
                  const picked = extraTables.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() =>
                        setExtraTables((prev) =>
                          picked
                            ? prev.filter((x) => x !== o.id)
                            : [...prev, o.id],
                        )
                      }
                      className={`rounded-lg border px-2.5 py-1 text-xs ${
                        picked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-card text-foreground transition-colors hover:bg-muted"
                      }`}
                    >
                      {o.name} ({toPersianDigits(o.capacity)})
                    </button>
                  );
                })}
              </div>
            </Field>
          ) : null}
          <Field label="یادداشت نشست">
            <input
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton
              type="button"
              onClick={() => void openSession(false)}
              disabled={busy}
            >
              نشاندن مهمان
            </PrimaryButton>
          </div>
        </div>
      )}

      {table.session_id ? (
        <SessionPanel
          sessionId={table.session_id}
          onChange={onRefresh}
          setError={setError}
        />
      ) : null}
    </div>
  );
}

/* ---------------- Layout editor panel ---------------- */

function EditorPanel({
  sections,
  tables,
  archivedTables,
  staff,
  selected,
  onChange,
  onDeselect,
  setError,
}: {
  sections: FloorSection[];
  tables: FloorTable[];
  archivedTables: FloorTable[];
  staff: StaffMember[];
  selected: FloorTable | null;
  onChange: () => void;
  onDeselect: () => void;
  setError: (s: string) => void;
}) {
  return (
    <div className="space-y-4">
      {selected ? (
        <TableEditor
          table={selected}
          tables={tables}
          sections={sections}
          onChange={onChange}
          onDeleted={() => {
            onDeselect();
            onChange();
          }}
          setError={setError}
        />
      ) : null}
      <AddTable
        sections={sections}
        archivedTables={archivedTables}
        onAdded={onChange}
        setError={setError}
      />
      <SectionEditor
        sections={sections}
        staff={staff}
        onChange={onChange}
        setError={setError}
      />
    </div>
  );
}

function TableEditor({
  table,
  tables,
  sections,
  onChange,
  onDeleted,
  setError,
}: {
  table: FloorTable;
  tables: FloorTable[];
  sections: FloorSection[];
  onChange: () => void;
  onDeleted: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState(table.name);
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [sectionId, setSectionId] = useState(table.section_id ?? "");
  const [shape, setShape] = useState(table.shape);
  const [width, setWidth] = useState(String(table.width));
  const [height, setHeight] = useState(String(table.height));
  const [note, setNote] = useState(table.note ?? "");
  const [dirty, setDirty] = useState(false);
  const prevTableIdRef = useRef(table.id);

  const [futureResConflict, setFutureResConflict] = useState<number | null>(
    null,
  );
  const [reassignTableId, setReassignTableId] = useState("");

  // Seed local editor fields when selecting a different table or when the form
  // has no unsaved edits, so background realtime refreshes do not wipe dirty state.
  useEffect(() => {
    if (prevTableIdRef.current !== table.id || !dirty) {
      prevTableIdRef.current = table.id;
      setName(table.name);
      setCapacity(String(table.capacity));
      setSectionId(table.section_id ?? "");
      setShape(table.shape);
      setWidth(String(table.width));
      setHeight(String(table.height));
      setNote(table.note ?? "");
      setDirty(false);
      setFutureResConflict(null);
      setReassignTableId("");
    }
  }, [table, dirty]);

  async function save() {
    setError("");
    const res = await api<{ error?: string }>(`/api/tables/${table.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name,
        capacity: Number(capacity),
        sectionId: sectionId || null,
        shape,
        width: Number(width),
        height: Number(height),
        note: note || null,
      }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    setDirty(false);
    onChange();
  }

  async function remove(opts?: {
    reassignToTableId?: string;
    unassignFutureReservations?: boolean;
  }) {
    setError("");
    const params = new URLSearchParams();
    if (opts?.reassignToTableId) {
      params.set("reassignToTableId", opts.reassignToTableId);
    }
    if (opts?.unassignFutureReservations) {
      params.set("unassignFutureReservations", "true");
    }
    const qs = params.toString();
    const url = `/api/tables/${table.id}${qs ? `?${qs}` : ""}`;
    const res = await api<{
      error?: string;
      futureReservationCount?: number;
    }>(url, { method: "DELETE" });
    if (!res.ok) {
      if (res.data.error === "table_has_future_reservations") {
        setFutureResConflict(res.data.futureReservationCount ?? 1);
        return;
      }
      return setError(errorMessage(res.data.error));
    }
    setFutureResConflict(null);
    onDeleted();
  }

  const otherTables = tables.filter((t) => t.id !== table.id);

  return (
    <div className={`${cardClass} space-y-2.5 p-4`}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold">ویرایش {table.name}</h3>
        <button
          type="button"
          onClick={() => void remove()}
          className="text-xs text-destructive hover:underline"
        >
          بایگانی / حذف میز
        </button>
      </div>

      {futureResConflict !== null ? (
        <div className="space-y-2 rounded-lg border border-amber-400/60 bg-amber-50/80 dark:bg-amber-500/15 p-3 text-xs">
          <p className="font-bold text-amber-950 dark:text-amber-100">
            این میز دارای {toPersianDigits(futureResConflict)} رزرو آینده است.
          </p>
          {otherTables.length > 0 ? (
            <div className="flex items-center gap-2">
              <SearchableSelect
                className={`${inputClass} py-1 text-xs`}
                value={reassignTableId}
                onChange={setReassignTableId}
                options={[
                  { value: "", label: "انتقال رزروها به میز دیگر…" },
                  ...otherTables.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
              <SecondaryButton
                onClick={() =>
                  reassignTableId &&
                  void remove({ reassignToTableId: reassignTableId })
                }
                disabled={!reassignTableId}
              >
                انتقال و بایگانی
              </SecondaryButton>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              onClick={() => void remove({ unassignFutureReservations: true })}
            >
              آزادسازی رزروها (بدون میز) و بایگانی
            </SecondaryButton>
            <SecondaryButton onClick={() => setFutureResConflict(null)}>
              انصراف
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="نام">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field label="ظرفیت">
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            value={capacity}
            onChange={(e) => {
              setCapacity(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field label="بخش">
          <SearchableSelect
            className={inputClass}
            value={sectionId}
            onChange={(v) => {
              setSectionId(v);
              setDirty(true);
            }}
            options={[
              { value: "", label: "بدون بخش" },
              ...sections.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </Field>
        <Field label="شکل">
          <SearchableSelect
            className={inputClass}
            value={shape}
            onChange={(value) => {
              setShape(value as FloorTable["shape"]);
              setDirty(true);
            }}
            options={[
              { value: "rect", label: "مستطیل" },
              { value: "round", label: "گرد" },
              { value: "booth", label: "غرفه" },
            ]}
          />
        </Field>
        <Field label="عرض (px)">
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            value={width}
            onChange={(e) => {
              setWidth(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field label="ارتفاع (px)">
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            value={height}
            onChange={(e) => {
              setHeight(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
      </div>
      <Field label="یادداشت میز">
        <input
          className={inputClass}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setDirty(true);
          }}
        />
      </Field>
      <PrimaryButton type="button" onClick={() => void save()}>
        ذخیره تغییرات میز
      </PrimaryButton>
    </div>
  );
}

function AddTable({
  sections,
  archivedTables,
  onAdded,
  setError,
}: {
  sections: FloorSection[];
  archivedTables: FloorTable[];
  onAdded: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("4");
  const [sectionId, setSectionId] = useState("");
  const [shape, setShape] = useState<"rect" | "round" | "booth">("rect");
  const [archivedMatch, setArchivedMatch] = useState<string | null>(null);

  async function add(restoreArchived = false) {
    if (!name.trim()) return;
    setError("");
    const res = await api<{
      error?: string;
      archivedTable?: { id: string; name: string };
    }>("/api/tables", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        capacity: Number(capacity) || 4,
        sectionId: sectionId || null,
        shape,
        posX: 40,
        posY: 40,
        restoreArchived,
      }),
    });
    if (!res.ok) {
      if (res.data.error === "table_exists_archived") {
        setArchivedMatch(res.data.archivedTable?.name ?? name.trim());
        return;
      }
      return setError(errorMessage(res.data.error));
    }
    setName("");
    setArchivedMatch(null);
    onAdded();
  }

  async function restoreById(tableId: string) {
    setError("");
    const res = await api<{ error?: string }>(`/api/tables/${tableId}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: true }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    onAdded();
  }

  return (
    <div className={`${cardClass} space-y-2.5 p-4`}>
      <h3 className="font-bold">افزودن میز جدید</h3>
      {archivedMatch ? (
        <div className="space-y-2 rounded-lg border border-amber-400/60 bg-amber-50/80 dark:bg-amber-500/15 p-3 text-xs">
          <p className="font-semibold text-amber-950 dark:text-amber-100">
            میزی با نام «{archivedMatch}» در بایگانی وجود دارد.
          </p>
          <div className="flex gap-2">
            <PrimaryButton type="button" onClick={() => void add(true)}>
              بازیابی میز بایگانی‌شده
            </PrimaryButton>
            <SecondaryButton onClick={() => setArchivedMatch(null)}>
              انصراف
            </SecondaryButton>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Field label="نام میز">
          <input
            className={inputClass}
            placeholder="مثلاً میز ۱۲"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="ظرفیت">
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
        </Field>
        <Field label="بخش">
          <SearchableSelect
            className={inputClass}
            value={sectionId}
            onChange={setSectionId}
            options={[
              { value: "", label: "بدون بخش" },
              ...sections.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </Field>
        <Field label="شکل">
          <SearchableSelect
            className={inputClass}
            value={shape}
            onChange={(value) => setShape(value as typeof shape)}
            options={[
              { value: "rect", label: "مستطیل" },
              { value: "round", label: "گرد" },
              { value: "booth", label: "غرفه" },
            ]}
          />
        </Field>
      </div>
      <PrimaryButton type="button" onClick={() => void add(false)}>
        افزودن میز
      </PrimaryButton>

      {archivedTables.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
            میزهای بایگانی‌شده ({toPersianDigits(archivedTables.length)})
          </p>
          <ul className="space-y-1 text-xs">
            {archivedTables.map((at) => (
              <li
                key={at.id}
                className="flex items-center justify-between rounded bg-muted px-2.5 py-1.5"
              >
                <span>
                  {at.name} ({toPersianDigits(at.capacity)} نفر)
                </span>
                <button
                  type="button"
                  onClick={() => void restoreById(at.id)}
                  className="font-semibold text-primary hover:underline"
                >
                  بازیابی
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const PALETTE = [
  "#0f766e",
  "#1d4ed8",
  "#7c3aed",
  "#b45309",
  "#be123c",
  "#374151",
];

function SectionEditor({
  sections,
  staff,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  staff: StaffMember[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [waiterId, setWaiterId] = useState("");
  const [conflictSection, setConflictSection] = useState<{
    id: string;
    name: string;
    tableCount: number;
  } | null>(null);
  const [reassignSectionId, setReassignSectionId] = useState("");

  async function add() {
    if (!name.trim()) return;
    setError("");
    const res = await api<{ error?: string }>("/api/floor/sections", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        color,
        assignedWaiterId: waiterId || null,
      }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    setName("");
    onChange();
  }

  async function assignWaiter(sectionId: string, assignedWaiterId: string | null) {
    await api(`/api/floor/sections/${sectionId}`, {
      method: "PATCH",
      body: JSON.stringify({ assignedWaiterId }),
    });
    onChange();
  }

  async function remove(
    section: FloorSection,
    opts?: { reassignToSectionId?: string; allowUnassign?: boolean },
  ) {
    setError("");
    const params = new URLSearchParams();
    if (opts?.reassignToSectionId) {
      params.set("reassignToSectionId", opts.reassignToSectionId);
    }
    if (opts?.allowUnassign) {
      params.set("allowUnassign", "true");
    }
    const qs = params.toString();
    const res = await api<{ error?: string; tableCount?: number }>(
      `/api/floor/sections/${section.id}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      if (res.data.error === "section_has_tables") {
        setConflictSection({
          id: section.id,
          name: section.name,
          tableCount: res.data.tableCount ?? 1,
        });
        setReassignSectionId("");
        return;
      }
      return setError(errorMessage(res.data.error));
    }
    setConflictSection(null);
    onChange();
  }

  return (
    <div className={`${cardClass} space-y-2.5 p-4`}>
      <h3 className="font-bold">بخش‌های سالن و گارسون مسئول</h3>

      {conflictSection ? (
        <div className="space-y-2 rounded-lg border border-amber-400/60 bg-amber-50/80 dark:bg-amber-500/15 p-3 text-xs">
          <p className="font-bold text-amber-950 dark:text-amber-100">
            بخش «{conflictSection.name}» دارای{" "}
            {toPersianDigits(conflictSection.tableCount)} میز است.
          </p>
          {sections.filter((s) => s.id !== conflictSection.id).length > 0 ? (
            <div className="flex items-center gap-2">
              <SearchableSelect
                className={`${inputClass} py-1 text-xs`}
                value={reassignSectionId}
                onChange={setReassignSectionId}
                options={[
                  { value: "", label: "انتقال میزها به بخش دیگر…" },
                  ...sections
                    .filter((s) => s.id !== conflictSection.id)
                    .map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
              <SecondaryButton
                onClick={() => {
                  const target = sections.find(
                    (s) => s.id === conflictSection.id,
                  );
                  if (target && reassignSectionId) {
                    void remove(target, {
                      reassignToSectionId: reassignSectionId,
                    });
                  }
                }}
                disabled={!reassignSectionId}
              >
                انتقال و حذف بخش
              </SecondaryButton>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              onClick={() => {
                const target = sections.find(
                  (s) => s.id === conflictSection.id,
                );
                if (target) {
                  void remove(target, { allowUnassign: true });
                }
              }}
            >
              حذف بخش و قرار دادن میزها در «بدون بخش»
            </SecondaryButton>
            <SecondaryButton onClick={() => setConflictSection(null)}>
              انصراف
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      <ul className="space-y-1.5 text-xs">
        {sections.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-muted p-2"
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.name}
            </span>
            <SearchableSelect
              className="rounded border border-border bg-card px-2 py-1 text-xs"
              value={s.assigned_waiter_id ?? ""}
              onChange={(value) => void assignWaiter(s.id, value || null)}
              options={[
                { value: "", label: "بدون مسئول" },
                ...staff.map((u) => ({ value: u.id, label: u.full_name })),
              ]}
            />
            <button
              type="button"
              onClick={() => void remove(s)}
              className="text-destructive hover:underline"
            >
              حذف
            </button>
          </li>
        ))}
      </ul>

      <div className="border-t border-border pt-2.5 space-y-2">
        <Field label="بخش جدید (مثلاً تراس، طبقه بالا)">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="flex items-center gap-1.5">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              style={{ backgroundColor: c }}
              className={`size-6 rounded-full ${
                color === c ? "ring-2 ring-ring ring-offset-2" : ""
              }`}
            />
          ))}
        </div>
        <Field label="گارسون مسئول">
          <SearchableSelect
            className={inputClass}
            value={waiterId}
            onChange={setWaiterId}
            options={[
              { value: "", label: "بدون مسئول" },
              ...staff.map((u) => ({ value: u.id, label: u.full_name })),
            ]}
          />
        </Field>
        <SecondaryButton onClick={() => void add()}>افزودن بخش</SecondaryButton>
      </div>
    </div>
  );
}
