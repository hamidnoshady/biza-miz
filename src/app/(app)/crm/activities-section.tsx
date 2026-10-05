"use client";

/**
 * Activities and tasks (Phase 36).
 *
 * One list for both, because they are one table: an activity with a future
 * `dueAt` and no `completedAt` *is* a task. `activityState` resolves which of
 * «انجام‌شده / امروز / عقب‌افتاده / برنامه‌ریزی‌شده» a row is, against the
 * **business date the server sends back with the list** rather than the
 * browser's clock — a shop whose day starts at 18:00 must not see tomorrow's
 * work turn red at midnight, and a till whose clock is set wrong must not be
 * able to recolour the whole list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali, isoDateInTimeZone } from "@/lib/jalali";
import {
  ACTIVITY_ASSIGNEE_MAX,
  ACTIVITY_BODY_MAX,
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_STATE_LABELS,
  ACTIVITY_STATE_TONES,
  ACTIVITY_SUBJECT_MAX,
  activityState,
  type ActivityKind,
  type ActivityState,
} from "@/lib/crm-shared";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { crmCustomerHref } from "./crm-routes";
import { CustomerSearchField } from "./customer-search";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmTodayQueues } from "./today-queues";

interface Activity {
  id: string;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  caseId: string | null;
  kind: ActivityKind;
  subject: string;
  body: string;
  dueAt: string | null;
  completedAt: string | null;
  assignedTo: string;
  createdBy: string;
  createdAt: string;
}

interface ActivityListPayload {
  activities: Activity[];
  /** The branch's own «امروز» (YYYY-MM-DD) — see the module comment. */
  today: string;
  error?: string;
}

/** The list's own view filter. The server filters open/due; the rest is local. */
type ViewFilter = "all" | "open" | "due" | "done";

const VIEW_LABELS: Record<ViewFilter, string> = {
  open: "انجام‌نشده",
  due: "سررسیدشده",
  done: "انجام‌شده",
  all: "همه",
};

const VIEW_ORDER: readonly ViewFilter[] = ["open", "due", "done", "all"];

/** A fallback «امروز» for the first paint, before the server's answer lands. */
function browserToday(): string {
  return isoDateInTimeZone(new Date()) ?? new Date().toISOString().slice(0, 10);
}

export function ActivitiesSection() {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [today, setToday] = useState<string>(browserToday);
  const [view, setView] = useState<ViewFilter>("open");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<Activity | null>(null);

  // Every load carries a sequence number: a slow first request must not be
  // allowed to overwrite the result of a faster later one (flipping the filter
  // twice quickly used to leave the previous filter's rows on screen).
  const requestRef = useRef(0);

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      const seq = ++requestRef.current;
      if (!opts.quiet) setRefreshing(true);
      const params = new URLSearchParams();
      if (view === "open") params.set("open", "1");
      if (view === "due") {
        params.set("open", "1");
        params.set("due", "1");
      }
      const query = params.toString();
      const { ok, data, aborted } = await api<ActivityListPayload>(
        `/api/crm/activities${query ? `?${query}` : ""}`,
      );
      if (aborted || seq !== requestRef.current) return;
      if (ok) {
        setActivities(data.activities ?? []);
        if (data.today) setToday(data.today);
        setError("");
      } else {
        // Keep whatever is on screen rather than blanking the list: a dropped
        // connection should not look like "you have no work".
        setError(data?.error ? errorMessage(data.error) : "بارگذاری کارها ناموفق بود.");
        setActivities((current) => current ?? []);
      }
      setRefreshing(false);
    },
    [view],
  );

  useEffect(() => {
    void load({ quiet: true });
  }, [load]);

  const markPending = (id: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * Ticking a box is optimistic: the row flips immediately and is reconciled
   * with the server's answer. Previously each tick re-read the whole list, so
   * on the «فقط انجام‌نشده‌ها» view the row vanished a second after it was
   * ticked with no way to undo a mis-tap.
   */
  const toggle = async (activity: Activity) => {
    if (pending.has(activity.id)) return;
    const completed = !activity.completedAt;
    const optimistic = completed ? new Date().toISOString() : null;
    markPending(activity.id, true);
    setActivities((current) =>
      current?.map((row) => (row.id === activity.id ? { ...row, completedAt: optimistic } : row)) ??
      current,
    );
    const { ok, data } = await api<{ activity?: Activity; error?: string }>(
      `/api/crm/activities/${activity.id}`,
      { method: "PATCH", body: JSON.stringify({ completed }) },
    );
    markPending(activity.id, false);
    if (!ok) {
      setError(errorMessage(data?.error));
      // Put the row back the way it was — the server said no.
      setActivities((current) =>
        current?.map((row) =>
          row.id === activity.id ? { ...row, completedAt: activity.completedAt } : row,
        ) ?? current,
      );
      return;
    }
    setError("");
    const saved = data?.activity;
    if (saved) {
      setActivities((current) => current?.map((row) => (row.id === saved.id ? saved : row)) ?? current);
    }
  };

  const remove = async (activity: Activity) => {
    setConfirming(null);
    markPending(activity.id, true);
    const { ok, data } = await api<{ error?: string }>(`/api/crm/activities/${activity.id}`, {
      method: "DELETE",
    });
    markPending(activity.id, false);
    if (!ok) {
      setError(errorMessage(data?.error));
      return;
    }
    setError("");
    setActivities((current) => current?.filter((row) => row.id !== activity.id) ?? current);
  };

  // The search box filters what is already loaded, so typing is instant and
  // does not put a request on the wire per keystroke.
  const term = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!activities) return [];
    const byView = activities.filter((activity) => {
      if (view === "done") return Boolean(activity.completedAt);
      return true;
    });
    if (!term) return byView;
    return byView.filter((activity) =>
      [activity.subject, activity.body, activity.assignedTo, activity.customerName ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [activities, term, view]);

  const counts = useMemo(() => {
    const tally = { done: 0, due: 0, overdue: 0, planned: 0 } as Record<ActivityState, number>;
    for (const activity of activities ?? []) tally[activityState(activity, today)] += 1;
    return tally;
  }, [activities, today]);

  if (!activities) {
    return <SectionCardSkeleton rows={4} label="در حال بارگذاری کارها و پیگیری‌ها" />;
  }

  const overdue = counts.overdue;

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      {/* Overdue and due-today, above the list they belong to. The section
          already counts the overdue ones; the queue names them. */}
      <CrmTodayQueues section="activities" title="پیگیری‌های نیازمند توجه" />

      <SectionCard
        title={
          <CrmCardHeading kicker="پیگیری‌ها و وظایف" title="کارها و پیگیری‌ها" />
        }
        description={
          overdue > 0
            ? `${formatPersianNumber(overdue)} کار از موعدش گذشته است.`
            : "تماس‌ها، جلسه‌ها و یادآوری‌های مربوط به مشتریان."
        }
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void load()}
              disabled={refreshing}
              aria-label={refreshing ? "در حال بازخوانی…" : "بازخوانی"}
            >
              {/* No spinner: the design system says a busy action reports
                  itself by being disabled and renaming itself, not by
                  animating (docs/design-system.md §Charts and loading). */}
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" className="flex-1 sm:flex-none" onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" className="size-4" />
              کار جدید
            </Button>
          </div>
        }
      >
        {/* Filters. A real row of chips instead of one checkbox: «سررسیدشده»
            (overdue + today) is the question an owner actually opens this page
            with, and it was not answerable before. */}
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="group"
            aria-label="نمای فهرست"
            className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 pb-1"
          >
            {VIEW_ORDER.map((key) => (
              <Button
                key={key}
                type="button"
                size="xs"
                variant={view === key ? "default" : "outline"}
                aria-pressed={view === key}
                className="shrink-0"
                onClick={() => setView(key)}
              >
                {VIEW_LABELS[key]}
              </Button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            />
            <input
              type="search"
              className={`${inputClass} ps-9 pe-9`}
              placeholder="جستجو در عنوان، مشتری یا مسئول…"
              aria-label="جستجو در کارها"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="پاک کردن جستجو"
                className="absolute inset-y-0 end-2 my-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            ) : null}
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState>
            {term
              ? "هیچ کاری با این جستجو پیدا نشد."
              : view === "open"
                ? "کار انجام‌نشده‌ای نمانده است."
                : view === "due"
                  ? "هیچ کاری سررسید نشده است."
                  : view === "done"
                    ? "هنوز کاری انجام‌شده علامت نخورده است."
                    : "هنوز کاری ثبت نشده است. یک تماس پیگیری، یک یادآوری تولد، یا جلسه‌ای که باید گرفته شود."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {visible.map((activity) => {
              const state = activityState(activity, today);
              const busy = pending.has(activity.id);
              return (
                <li
                  key={activity.id}
                  className={`flex items-start gap-2 py-3 sm:gap-3 ${busy ? "opacity-60" : ""}`}
                >
                  <Checkbox
                    checked={Boolean(activity.completedAt)}
                    disabled={busy}
                    onCheckedChange={() => void toggle(activity)}
                    aria-label={
                      activity.completedAt
                        ? `«${activity.subject}» دوباره باز شود`
                        : `«${activity.subject}» انجام شد`
                    }
                    className="mt-1 size-5 shrink-0 sm:size-4"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={`leading-6 break-words ${
                        activity.completedAt
                          ? "text-muted-foreground line-through"
                          : "text-foreground"
                      }`}
                    >
                      {activity.subject}
                    </p>
                    {activity.body ? (
                      <p className="mt-0.5 text-xs leading-5 break-words whitespace-pre-line text-muted-foreground">
                        {activity.body}
                      </p>
                    ) : null}
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
                      <StatusBadge tone={ACTIVITY_STATE_TONES[state]}>
                        {ACTIVITY_STATE_LABELS[state]}
                      </StatusBadge>
                      <StatusBadge tone="neutral">{ACTIVITY_KIND_LABELS[activity.kind]}</StatusBadge>
                      {activity.dueAt ? (
                        <span className="whitespace-nowrap">
                          موعد {toPersianDigits(formatJalali(activity.dueAt, { withTime: true }))}
                        </span>
                      ) : null}
                      {activity.customerId ? (
                        <Link
                          href={crmCustomerHref(activity.customerId)}
                          className="max-w-full truncate text-foreground hover:underline"
                        >
                          {activity.customerName ?? "پروندهٔ مشتری"}
                        </Link>
                      ) : null}
                      {activity.assignedTo ? (
                        <span className="truncate">مسئول: {activity.assignedTo}</span>
                      ) : null}
                    </p>
                  </div>
                  {/* Kept as a column on narrow screens so both controls stay
                      inside the viewport instead of pushing the row wider. */}
                  <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      onClick={() => setEditing(activity)}
                      aria-label={`ویرایش «${activity.subject}»`}
                    >
                      <PencilIcon aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      onClick={() => setConfirming(activity)}
                      aria-label={`حذف «${activity.subject}»`}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {activities.length > 0 ? (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              نمایش {formatPersianNumber(visible.length)} از {formatPersianNumber(activities.length)}{" "}
              کار
            </span>
            {counts.overdue > 0 ? (
              <span className="text-destructive">
                عقب‌افتاده: {formatPersianNumber(counts.overdue)}
              </span>
            ) : null}
            {counts.due > 0 ? <span>امروز: {formatPersianNumber(counts.due)}</span> : null}
            <span>تاریخ امروز: {toPersianDigits(formatJalali(`${today}T12:00:00Z`))}</span>
          </p>
        ) : null}
      </SectionCard>

      {adding || editing ? (
        <ActivityDialog
          activity={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={(saved) => {
            setAdding(false);
            setEditing(null);
            // Reconcile locally first so the row updates without a flash, then
            // re-read so the server's ordering (and any filter) is authoritative.
            setActivities((current) =>
              current?.some((row) => row.id === saved.id)
                ? current.map((row) => (row.id === saved.id ? saved : row))
                : [saved, ...(current ?? [])],
            );
            void load({ quiet: true });
          }}
        />
      ) : null}

      {confirming ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setConfirming(null))}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>حذف کار</DialogTitle>
              <DialogDescription>
                «{confirming.subject}» برای همیشه حذف می‌شود. این کار برگشت‌پذیر نیست.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                انصراف
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void remove(confirming)}
              >
                حذف
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/** `HH:MM` in Tehran for an instant — the edit dialog's time field. */
function timeInTehran(iso: string): string {
  const formatted = formatJalali(iso, { withTime: true });
  return formatted.slice(formatted.length - 5);
}

function ActivityDialog({
  activity,
  onClose,
  onSaved,
}: {
  /** The row being edited, or null for «کار جدید». */
  activity: Activity | null;
  onClose: () => void;
  onSaved: (activity: Activity) => void;
}) {
  const [kind, setKind] = useState<ActivityKind>(activity?.kind ?? "call");
  const [subject, setSubject] = useState(activity?.subject ?? "");
  const [body, setBody] = useState(activity?.body ?? "");
  // A Shamsi date + a 24-hour time, not `<input type="datetime-local">`: the
  // native control renders a *Gregorian* calendar, which in a Persian-only UI
  // is the one field a user cannot read. Same picker the deals screen uses.
  const [dueDate, setDueDate] = useState(
    activity?.dueAt ? (isoDateInTimeZone(activity.dueAt) ?? "") : "",
  );
  const [dueTime, setDueTime] = useState(activity?.dueAt ? timeInTehran(activity.dueAt) : "");
  const [assignedTo, setAssignedTo] = useState(activity?.assignedTo ?? "");
  // Attaching an activity to a customer is what makes it show on their file, so
  // the picker searches the live directory rather than asking for an id.
  const [customerName, setCustomerName] = useState(activity?.customerName ?? "");
  const [customerId, setCustomerId] = useState<string | null>(activity?.customerId ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = subject.trim();
    if (!trimmed) {
      setError(errorMessage("activity_subject_required"));
      return;
    }
    if (trimmed.length > ACTIVITY_SUBJECT_MAX) {
      setError(errorMessage("activity_subject_too_long"));
      return;
    }
    // A time with no date is a moeed nobody can act on; ask for the date rather
    // than silently dropping the time the user typed.
    if (dueTime && !dueDate) {
      setError("برای ساعت موعد، تاریخ را هم انتخاب کنید.");
      return;
    }
    const dueAt = dueDate ? new Date(`${dueDate}T${dueTime || "09:00"}:00+03:30`).toISOString() : null;

    setBusy(true);
    setError("");
    const payload = {
      kind,
      subject: trimmed,
      body: body.trim(),
      dueAt,
      assignedTo: assignedTo.trim(),
      customerId,
    };
    const { ok, data } = await api<{ activity?: Activity; error?: string }>(
      activity ? `/api/crm/activities/${activity.id}` : "/api/crm/activities",
      { method: activity ? "PATCH" : "POST", body: JSON.stringify(payload) },
    );
    setBusy(false);
    if (!ok || !data.activity) {
      setError(errorMessage(data?.error));
      return;
    }
    onSaved(data.activity);
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{activity ? "ویرایش کار" : "کار جدید"}</DialogTitle>
          <DialogDescription>
            تماس، جلسه یا یادآوری‌ای که باید پیگیری شود.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="نوع">
            <select
              className={inputClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as ActivityKind)}
            >
              {ACTIVITY_KINDS.map((key) => (
                <option key={key} value={key}>
                  {ACTIVITY_KIND_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="عنوان">
            <input
              className={inputClass}
              value={subject}
              maxLength={ACTIVITY_SUBJECT_MAX}
              autoFocus
              required
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <Field
            label="مشتری (اختیاری)"
            hint="با ثبت مشتری، این کار در پروندهٔ او هم دیده می‌شود."
            as="div"
          >
            <CustomerSearchField
              selectedId={customerId}
              selectedName={customerName}
              onPick={(match) => {
                setCustomerId(match.id);
                setCustomerName(match.name);
              }}
              onClear={() => {
                setCustomerId(null);
                setCustomerName("");
              }}
              emptyText="مشتری‌ای با این نام یا شماره پیدا نشد. می‌توانید کار را بدون مشتری ثبت کنید."
            />
          </Field>
          <Field
            label="موعد (اختیاری)"
            hint="بدون موعد، این کار «برنامه‌ریزی‌شده» می‌ماند و هرگز عقب‌افتاده نمی‌شود."
            as="div"
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1">
                <JalaliDatePicker
                  value={dueDate}
                  onChange={setDueDate}
                  ariaLabel="تاریخ موعد"
                  placeholder="بدون موعد"
                />
              </div>
              <input
                type="time"
                dir="ltr"
                aria-label="ساعت موعد"
                className={`${inputClass} sm:w-32`}
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </div>
          </Field>
          <Field label="مسئول (اختیاری)">
            <input
              className={inputClass}
              value={assignedTo}
              maxLength={ACTIVITY_ASSIGNEE_MAX}
              onChange={(e) => setAssignedTo(e.target.value)}
            />
          </Field>
          <Field label="توضیح (اختیاری)">
            <textarea
              className={`${inputClass} h-auto min-h-20 py-2`}
              rows={3}
              maxLength={ACTIVITY_BODY_MAX}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              انصراف
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
