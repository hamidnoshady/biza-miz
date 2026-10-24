"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { CalendarDaysIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali, jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import {
  formatTimeInTimeZone,
  isNoShowOverdue,
  zonedDateTimeToIso,
  zonedDayBoundsIso,
} from "@/lib/reservations";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { KnowledgeHelpButton } from "../knowledge-help";
import { useRealtime } from "../use-realtime";
import { api, ErrorBox, errorMessage, Field, inputClass } from "../ui";
import { cardClass, LoadingSkeleton, PageHeader, PageShell } from "../page-chrome";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Iran no longer observes DST, so wall-clock Tehran time is a fixed +03:30.
const TEHRAN_OFFSET = "+03:30";

interface Reservation {
  id: string;
  table_id: string | null;
  table_name: string | null;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
  status: "booked" | "seated" | "completed" | "cancelled" | "no_show";
  note: string | null;
  seated_session_id: string | null;
}

interface Table {
  id: string;
  name: string;
}

interface Conflict {
  customer_name: string;
  reserved_at: string;
}

type PanelMode = "none" | "form" | "details";
type ReservationAction = "seat" | "cancel" | "no_show" | "complete";

const STATUS_META: Record<
  Reservation["status"],
  { label: string; toneClass: string; dotClass: string }
> = {
  booked: {
    label: "رزرو",
    toneClass: "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300",
    dotClass: "bg-amber-500 dark:bg-amber-400",
  },
  seated: {
    label: "نشسته",
    toneClass: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500 dark:bg-emerald-500",
  },
  completed: {
    label: "تکمیل",
    toneClass: "border-border/80 bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
  cancelled: {
    label: "لغو",
    toneClass: "border-border/80 bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/30",
  },
  no_show: {
    label: "عدم حضور",
    toneClass: "border-destructive/30 bg-destructive/5 text-red-800 dark:text-red-200",
    dotClass: "bg-destructive",
  },
};

function tehranTime(iso: string, tz = "Asia/Tehran"): string {
  return toPersianDigits(formatTimeInTimeZone(iso, tz));
}

function todayIso(): string {
  const day = todayJalali();
  return jalaliToIsoDate(day.jy, day.jm, day.jd);
}

function dayWindow(date: string, tz = "Asia/Tehran"): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const bounds = zonedDayBoundsIso(date, tz);
  return { from: bounds.startIso, to: bounds.endIso };
}

function formatRefreshTime(timestamp: number, tz = "Asia/Tehran"): string {
  return toPersianDigits(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(timestamp),
  );
}

function ReservationStatusBadge({ status }: { status: Reservation["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={
        "inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold " +
        meta.toneClass
      }
    >
      <span
        className={"size-2 rounded-full " + meta.dotClass}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}

/**
 * The reservations board while its first read is in flight.
 *
 * Reserves the real two-column shape (schedule + booking rail) with the shared
 * `Skeleton` primitive rather than hand-rolled `animate-pulse` bars, so the
 * shimmer, its warm ink and the reduced-motion opt-out all come from one
 * definition. The spoken label lives on the region; the bars are decorative.
 */
function ReservationSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="در حال بارگذاری رزروها"
      className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_23rem]"
    >
      <section aria-hidden="true" className={`${cardClass} p-4 md:col-start-1`}>
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-6 w-16 rounded-xl" />
        </div>
        <div className="mt-4">
          <LoadingSkeleton rows={3} label="در حال بارگذاری برنامهٔ روز" />
        </div>
      </section>
      <aside
        className={`hidden ${cardClass} p-4 md:col-start-2 md:block`}
        aria-hidden="true"
      >
        <Skeleton className="h-5 w-28" />
        <div className="mt-6 space-y-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-[52px] w-full rounded-lg" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function EmptySchedule({
  canBook,
  onCreate,
}: {
  canBook: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="rounded-xl border border-dashed border-border/80 bg-muted px-5 py-12 text-center">
      <p className="font-semibold text-foreground/80">
        رزروی در بازهٔ پیش‌رو ثبت نشده است.
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        برای این روز، رزروی در برنامهٔ میزها دیده نمی‌شود.
      </p>
      {canBook ? (
        <Button
          type="button"
          onClick={onCreate}
          className="mt-5 min-h-[52px] bg-amber-500 dark:bg-amber-400 px-5 font-semibold text-amber-950 hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
        >
          رزرو جدید
        </Button>
      ) : null}
    </section>
  );
}

function DetailsPlaceholder({ canBook }: { canBook: boolean }) {
  return (
    <section className="rounded-xl border border-dashed border-border/80 bg-muted p-6 text-center">
      <p className="font-semibold text-foreground/80">
        {canBook
          ? "رزروی را انتخاب کنید یا رزرو جدید ثبت کنید"
          : "یک رزرو را انتخاب کنید"}
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        جزئیات مهمان و اقدام‌های مجاز رزرو در این بخش نمایش داده می‌شود.
      </p>
    </section>
  );
}

function ReservationRow({
  reservation,
  selected,
  onSelect,
  now,
}: {
  reservation: Reservation;
  selected: boolean;
  onSelect: () => void;
  now: number;
}) {
  const overdue =
    reservation.status === "booked" &&
    isNoShowOverdue(new Date(reservation.reserved_at).getTime(), now);

  return (
    <article
      // cn()/twMerge, not string concatenation: cardClass already carries
      // `border-border/80`, and the selected/overdue border must win by
      // *source* order, not by Tailwind's emission order.
      className={cn(
        "overflow-hidden transition-colors motion-reduce:transition-none",
        cardClass,
        selected
          ? "border-amber-500 dark:border-amber-500/60 ring-2 ring-amber-500/20 dark:ring-amber-400/45"
          : overdue
            ? "border-destructive/30"
            : "border-border/80",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-h-[116px] w-full p-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:focus-visible:ring-amber-400/45"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <time
              dateTime={reservation.reserved_at}
              className="text-lg font-bold tabular-nums text-foreground"
              dir="ltr"
            >
              {tehranTime(reservation.reserved_at)}
            </time>
            <p className="mt-1 truncate text-base font-semibold text-foreground/80">
              {reservation.customer_name}
            </p>
          </div>
          <ReservationStatusBadge status={reservation.status} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span>{toPersianDigits(reservation.party_size)} نفر</span>
          <span>{toPersianDigits(reservation.duration_minutes)} دقیقه</span>
          <span>
            {reservation.table_name
              ? "میز " + reservation.table_name
              : "بدون میز مشخص"}
          </span>
        </div>
        {overdue ? (
          <p className="mt-3 text-sm font-medium text-red-800 dark:text-red-200">
            از زمان رزرو گذشته؛ احتمال عدم حضور
          </p>
        ) : null}
      </button>
    </article>
  );
}

function ReservationDetails({
  reservation,
  now,
  pendingAction,
  onAction,
}: {
  reservation: Reservation;
  now: number;
  pendingAction: string | null;
  onAction: (id: string, action: ReservationAction) => void;
}) {
  const overdue =
    reservation.status === "booked" &&
    isNoShowOverdue(new Date(reservation.reserved_at).getTime(), now);
  const actionKey = (action: ReservationAction) =>
    reservation.id + ":" + action;

  return (
    <section
      className={`${cardClass} p-4`}
      aria-label={"جزئیات رزرو " + reservation.customer_name}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">جزئیات رزرو</p>
          <h2 className="mt-1 break-words text-xl font-bold text-foreground">
            {reservation.customer_name}
          </h2>
        </div>
        <ReservationStatusBadge status={reservation.status} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 border-y border-border py-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">تاریخ</dt>
          <dd className="mt-1 font-semibold text-foreground/80">
            {toPersianDigits(
              formatJalali(reservation.reserved_at, { withMonthName: true }),
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">ساعت</dt>
          <dd
            className="mt-1 font-semibold tabular-nums text-foreground/80"
            dir="ltr"
          >
            {tehranTime(reservation.reserved_at)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">تعداد نفرات</dt>
          <dd className="mt-1 font-semibold text-foreground/80">
            {toPersianDigits(reservation.party_size)} نفر
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">مدت</dt>
          <dd className="mt-1 font-semibold text-foreground/80">
            {toPersianDigits(reservation.duration_minutes)} دقیقه
          </dd>
        </div>
      </dl>

      <dl className="mt-5 space-y-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">تلفن</dt>
          <dd className="mt-1 font-semibold text-foreground/80" dir="ltr">
            {reservation.customer_phone
              ? toPersianDigits(reservation.customer_phone)
              : "ثبت نشده"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">میز</dt>
          <dd className="mt-1 font-semibold text-foreground/80">
            {reservation.table_name
              ? "میز " + reservation.table_name
              : "بدون میز مشخص"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">یادداشت</dt>
          <dd className="mt-1 break-words font-semibold leading-6 text-foreground/80">
            {reservation.note || "ثبت نشده"}
          </dd>
        </div>
      </dl>

      {overdue ? (
        <p className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-red-800 dark:text-red-200">
          از زمان رزرو گذشته است؛ در صورت لزوم عدم حضور مهمان را ثبت کنید.
        </p>
      ) : null}

      {reservation.status === "booked" ? (
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <Button
            type="button"
            size="lg"
            onClick={() => onAction(reservation.id, "seat")}
            disabled={pendingAction !== null}
            className="min-h-[52px] w-full bg-amber-500 dark:bg-amber-400 font-semibold text-amber-950 hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
          >
            {pendingAction === actionKey("seat")
              ? "در حال نشاندن…"
              : "نشاندن روی میز"}
          </Button>
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction(reservation.id, "no_show")}
              disabled={pendingAction !== null}
              className="min-h-[52px] border-border/80 bg-muted text-muted-foreground hover:bg-amber-50 dark:hover:bg-amber-500/15"
            >
              {pendingAction === actionKey("no_show")
                ? "در حال ثبت…"
                : "ثبت عدم حضور"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction(reservation.id, "cancel")}
              disabled={pendingAction !== null}
              className="min-h-[52px] border-destructive/30 bg-card text-red-800 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-500/15"
            >
              {pendingAction === actionKey("cancel")
                ? "در حال لغو…"
                : "لغو رزرو"}
            </Button>
          </div>
        </div>
      ) : null}
      {reservation.status === "seated" ? (
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onAction(reservation.id, "complete")}
            disabled={pendingAction !== null}
            className="min-h-[52px] w-full border-border/80 bg-muted font-semibold text-foreground hover:bg-amber-50 dark:hover:bg-amber-500/15"
          >
            {pendingAction === actionKey("complete")
              ? "در حال ثبت…"
              : "ثبت پایان حضور مهمان"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function BookingForm({
  tables,
  initialDate,
  timezone = "Asia/Tehran",
  onBooked,
}: {
  tables: Table[];
  initialDate: string;
  timezone?: string;
  onBooked: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState("20:00");
  const [tableId, setTableId] = useState("");
  const [duration, setDuration] = useState("90");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldClass =
    inputClass +
    " min-h-[52px] border-border/80 bg-muted text-foreground/80 focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-500/30 dark:focus-visible:ring-amber-400/45";

  function buildReservedAt(): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const normalizedTime = toLatinDigits(time).trim();
    if (!/^\d{1,2}:\d{2}$/.test(normalizedTime)) return null;
    return zonedDateTimeToIso(date, normalizedTime, timezone);
  }

  async function submit(allowConflict = false) {
    setError("");
    setConflicts(null);
    if (!name.trim()) {
      setError(errorMessage("missing_fields"));
      return;
    }
    const reservedAt = buildReservedAt();
    if (!reservedAt) {
      setError(errorMessage("invalid_time"));
      return;
    }

    setBusy(true);
    try {
      const result = await api<{ error?: string; conflicts?: Conflict[] }>(
        "/api/reservations",
        {
          method: "POST",
          body: JSON.stringify({
            customerName: name.trim(),
            customerPhone: phone.trim() || undefined,
            partySize: Number(toLatinDigits(partySize)) || undefined,
            reservedAt,
            durationMinutes: Number(toLatinDigits(duration)) || undefined,
            tableId: tableId || undefined,
            note: note.trim() || undefined,
            allowConflict,
          }),
        },
      );

      if (!result.ok) {
        if (
          result.status === 409 &&
          result.data.error === "reservation_conflict"
        ) {
          setConflicts(result.data.conflicts ?? []);
          return;
        }
        setError(errorMessage(result.data.error));
        return;
      }

      setName("");
      setPhone("");
      setNote("");
      setConflicts(null);
      onBooked();
    } catch {
      setError("ثبت رزرو ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={`${cardClass} p-4`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
      noValidate
    >
      <div className="mb-5">
        <p className="text-xs font-medium text-muted-foreground">ثبت رزرو</p>
        <h2 className="mt-1 text-xl font-bold text-foreground">رزرو جدید</h2>
      </div>
      <ErrorBox>{error}</ErrorBox>

      <Field label="نام مهمان">
        <input
          className={fieldClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          aria-required="true"
        />
      </Field>
      <Field label="تلفن (اختیاری)">
        <input
          className={fieldClass}
          dir="ltr"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          autoComplete="tel"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="تعداد نفرات">
          <PersianNumberInput
            className={fieldClass}
            inputMode="numeric"
            dir="ltr"
            value={partySize}
            onChange={(event) => setPartySize(event.target.value)}
            aria-required="true"
          />
        </Field>
        <Field label="مدت (دقیقه)">
          <PersianNumberInput
            className={fieldClass}
            inputMode="numeric"
            dir="ltr"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            aria-required="true"
          />
        </Field>
      </div>
      <Field label="تاریخ (شمسی)">
        <JalaliDatePicker
          value={date}
          onChange={setDate}
          clearable={false}
          className={fieldClass}
        />
      </Field>
      <Field label="ساعت (۲۴ ساعته، مثل 20:00)">
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="numeric"
            value={toPersianDigits(time)}
            onChange={(event) => setTime(toLatinDigits(event.target.value))}
            placeholder="HH:MM"
            aria-required="true"
          />
      </Field>
      <Field label="میز (اختیاری — برای تشخیص تداخل لازم است)">
        <SearchableSelect
          className={fieldClass}
          value={tableId}
          onChange={setTableId}
          options={[
            { value: "", label: "بدون میز مشخص" },
            ...tables.map((table) => ({ value: table.id, label: table.name })),
          ]}
        />
      </Field>
      <Field label="یادداشت (اختیاری)">
        <input
          className={fieldClass}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      {conflicts ? (
        <section
          className="mb-4 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm text-amber-800 dark:text-amber-300"
          role="alert"
        >
          <p className="font-semibold">این میز در این بازه رزرو دیگری دارد:</p>
          <ul className="mt-2 list-disc space-y-1 pe-5 text-xs">
            {conflicts.map((conflict, index) => (
              <li key={conflict.customer_name + conflict.reserved_at + index}>
                {conflict.customer_name} — ساعت{" "}
                {tehranTime(conflict.reserved_at)}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit(true)}
            disabled={busy}
            className="mt-3 min-h-[52px] border-amber-300 dark:border-amber-500/40 bg-card text-amber-900 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-500/15"
          >
            به‌هرحال ثبت کن
          </Button>
        </section>
      ) : null}

      <Button
        type="submit"
        size="lg"
        disabled={busy}
        className="min-h-[52px] w-full bg-amber-500 dark:bg-amber-400 font-semibold text-amber-950 hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
      >
        {busy ? "در حال ثبت…" : "ثبت رزرو"}
      </Button>
    </form>
  );
}

export function ReservationsManager({ canBook }: { canBook: boolean }) {
  const [timezone, setTimezone] = useState("Asia/Tehran");
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("none");
  const [loaded, setLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const requestId = useRef(0);
  const hasLoaded = useRef(false);

  const load = useCallback(
    async ({ showRefresh = false }: { showRefresh?: boolean } = {}) => {
      const currentRequest = ++requestId.current;
      if (showRefresh) setIsRefreshing(true);
      const window = dayWindow(selectedDate, timezone);
      const reservationsUrl = window
        ? "/api/reservations?from=" +
          encodeURIComponent(window.from) +
          "&to=" +
          encodeURIComponent(window.to)
        : "/api/reservations";

      try {
        const results = await Promise.all([
          api<{ timezone?: string; reservations: Reservation[] }>(reservationsUrl),
          api<{ tables: Table[] }>("/api/tables"),
        ]);
        if (currentRequest !== requestId.current) return;

        const reservationsResult = results[0];
        const tablesResult = results[1];
        if (!reservationsResult.ok) {
          setLoadError(
            errorMessage((reservationsResult.data as { error?: string }).error),
          );
          return;
        }

        if (typeof reservationsResult.data.timezone === "string" && reservationsResult.data.timezone) {
          setTimezone(reservationsResult.data.timezone);
        }
        const nextReservations = reservationsResult.data.reservations ?? [];
        setReservations(nextReservations);
        setSelectedId((current) =>
          current &&
          !nextReservations.some((reservation) => reservation.id === current)
            ? null
            : current,
        );
        if (!tablesResult.ok) {
          setLoadError(
            "فهرست میزها دریافت نشد. برای تلاش دوباره، صفحه را به‌روزرسانی کنید.",
          );
        } else {
          setTables(tablesResult.data.tables ?? []);
          setLoadError("");
        }
        setLastUpdatedAt(Date.now());
      } catch {
        if (currentRequest === requestId.current) {
          setLoadError(
            "دریافت رزروها ممکن نشد. اتصال را بررسی کنید و دوباره تلاش کنید.",
          );
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoaded(true);
          setIsRefreshing(false);
        }
      }
    },
    [selectedDate, timezone],
  );

  useEffect(() => {
    const showRefresh = hasLoaded.current;
    hasLoaded.current = true;
    void load({ showRefresh });
  }, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (
          event.type === "floor.updated" ||
          event.type === "table.status" ||
          event.type === "table_session.updated"
        ) {
          void load();
        }
      },
      [load],
    ),
  );

  useEffect(() => {
    const syncOnlineState = () => setIsOnline(navigator.onLine);
    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
    };
  }, []);

  useEffect(() => {
    if (
      selectedId &&
      !reservations.some((reservation) => reservation.id === selectedId)
    ) {
      setSelectedId(null);
      setPanelMode("none");
    }
  }, [reservations, selectedId]);

  const selectedReservation = useMemo(
    () =>
      reservations.find((reservation) => reservation.id === selectedId) ?? null,
    [reservations, selectedId],
  );
  const now = Date.now();
  const scheduleLabel = toPersianDigits(
    formatJalali(selectedDate + "T12:00:00" + TEHRAN_OFFSET, {
      withMonthName: true,
    }),
  );
  const syncLabel = !isOnline
    ? "اتصال اینترنت در دسترس نیست"
    : isRefreshing
      ? "در حال به‌روزرسانی"
      : lastUpdatedAt
        ? "به‌روزرسانی " + formatRefreshTime(lastUpdatedAt)
        : "در حال دریافت رزروها";

  function openNewReservation() {
    setSelectedId(null);
    setPanelMode("form");
  }

  function openDetails(id: string) {
    setSelectedId(id);
    setPanelMode("details");
  }

  async function performAction(id: string, action: ReservationAction) {
    setActionError("");
    const actionKey = id + ":" + action;
    setPendingAction(actionKey);
    try {
      const result = await api<{ error?: string }>("/api/reservations/" + id, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      if (!result.ok) {
        setActionError(errorMessage(result.data.error));
        return;
      }
      await load({ showRefresh: true });
    } catch {
      setActionError("ثبت تغییر ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setPendingAction(null);
    }
  }

  const desktopPanel =
    panelMode === "details" && selectedReservation ? (
      <ReservationDetails
        reservation={selectedReservation}
        now={now}
        pendingAction={pendingAction}
        onAction={performAction}
      />
    ) : canBook ? (
      <BookingForm
        tables={tables}
        initialDate={selectedDate}
        timezone={timezone}
        onBooked={() => void load({ showRefresh: true })}
      />
    ) : (
      <DetailsPlaceholder canBook={false} />
    );

  return (
    <PageShell className="space-y-4">
      <PageHeader
        title="رزروها"
        description={scheduleLabel}
        actions={
          <>
            <label className="block min-w-0 sm:w-56">
              <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <CalendarDaysIcon className="size-4" aria-hidden="true" />
                روز رزرو
              </span>
              <JalaliDatePicker
                value={selectedDate}
                onChange={(value) => {
                  if (value) setSelectedDate(value);
                }}
                clearable={false}
                className="min-h-[52px] border-border/80 bg-muted px-3 text-foreground/80 focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-500/30 dark:focus-visible:ring-amber-400/45"
              />
            </label>
            <KnowledgeHelpButton section="reservations" />
            <p
              className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground sm:flex-none"
              role="status"
              aria-live="polite"
            >
              <span
                className={
                  "size-2.5 shrink-0 rounded-full " +
                  (isOnline ? "bg-emerald-500 dark:bg-emerald-500" : "bg-amber-500 dark:bg-amber-400")
                }
                aria-hidden="true"
              />
              <span className="truncate">{syncLabel}</span>
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load({ showRefresh: true })}
              className="min-h-[52px] shrink-0 border-border/80 bg-muted px-4 text-foreground/80 hover:bg-amber-50 dark:hover:bg-amber-500/15"
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              {isRefreshing ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
            </Button>
            {canBook ? (
              <Button
                type="button"
                onClick={openNewReservation}
                className="min-h-[52px] shrink-0 bg-amber-500 dark:bg-amber-400 px-5 font-semibold text-amber-950 hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                رزرو جدید
              </Button>
            ) : null}
          </>
        }
      />

      {loadError ? (
        <section
          className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-red-800 dark:text-red-200 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p className="text-sm font-medium">{loadError}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void load({ showRefresh: true })}
            className="min-h-[48px] shrink-0 border-destructive/30 bg-card text-red-800 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-500/15"
          >
            تلاش دوباره
          </Button>
        </section>
      ) : null}

      <ErrorBox>{actionError}</ErrorBox>

      {!loaded ? (
        <ReservationSkeleton />
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_23rem]">
          <section className="min-w-0 rounded-xl border border-border/80 bg-muted p-3 sm:p-4 md:col-start-1">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-bold text-foreground/80">برنامهٔ روز</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  به‌ترتیب ساعت رزرو
                </p>
              </div>
              <span className="shrink-0 rounded-xl bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                {toPersianDigits(reservations.length)} رزرو
              </span>
            </div>

            {reservations.length === 0 ? (
              <EmptySchedule canBook={canBook} onCreate={openNewReservation} />
            ) : (
              <div className="space-y-3">
                {reservations.map((reservation) => (
                  <ReservationRow
                    key={reservation.id}
                    reservation={reservation}
                    selected={reservation.id === selectedId}
                    onSelect={() => openDetails(reservation.id)}
                    now={now}
                  />
                ))}
              </div>
            )}
          </section>

          <aside className="hidden min-w-0 md:col-start-2 md:block">
            <div className="md:sticky md:top-4">{desktopPanel}</div>
          </aside>

          <aside className="md:hidden">
            {panelMode === "details" && selectedReservation ? (
              <ReservationDetails
                reservation={selectedReservation}
                now={now}
                pendingAction={pendingAction}
                onAction={performAction}
              />
            ) : panelMode === "form" && canBook ? (
              <BookingForm
                tables={tables}
                initialDate={selectedDate}
                timezone={timezone}
                onBooked={() => void load({ showRefresh: true })}
              />
            ) : null}
          </aside>
        </div>
      )}
    </PageShell>
  );
}
