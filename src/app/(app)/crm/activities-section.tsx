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
 *
 * ## One filter document, and the server applies all of it
 *
 * The controls write into a single `ActivityViewFilters` — the document
 * `crm-activity-views.ts` parses, serialises and describes. Two things this
 * replaced were *silently* wrong: the search box filtered the rows already
 * loaded, so a task beyond the page (or one completed a minute ago, when the
 * screen had asked for the open ones) looked as though it did not exist; and a
 * saved view stored against `activities` could carry keys no part of this screen
 * had ever read. Now the query string the server reads and the chips a person
 * reads are the same document, and the search is a real filter over the whole
 * table rather than over the twenty rows that happened to arrive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { crmCustomerHref } from "./crm-routes";
import { CustomerSearchField } from "./customer-search";
import { CrmAssigneePicker, type CrmAssignee } from "./crm-assignee-picker";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmTodayQueues } from "./today-queues";
import { SavedViewsBar } from "./saved-views-bar";
import {
  ACTIVITY_VIEW_STATE_LABELS,
  ACTIVITY_VIEW_STATES,
  ACTIVITY_VIEW_FILTER_KEYS,
  EMPTY_ACTIVITY_VIEW_FILTERS,
  activityViewErrorLine,
  activityViewFilterCount,
  activityViewQuery,
  activityViewSearchParams,
  describeActivityView,
  parseActivityViewFilters,
  type ActivityViewFilters,
} from "@/lib/crm-activity-views";

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
  /** The display snapshot of the assignee (see `crm-ownership.ts`). */
  assignedTo: string;
  /** The member it belongs to, when the assignee is one. */
  assigneeUserId: string | null;
  createdBy: string;
  createdAt: string;
}

interface ActivityListPayload {
  activities: Activity[];
  /** The branch's own «امروز» (YYYY-MM-DD) — see the module comment. */
  today: string;
  /** The member names the assignee filter's chips can use. */
  members?: { id: string; name: string; isActive: boolean }[];
  error?: string;
  /** The field that made a filter impossible, when one did. */
  field?: string;
}

/** A fallback «امروز» for the first paint, before the server's answer lands. */
function browserToday(): string {
  return isoDateInTimeZone(new Date()) ?? new Date().toISOString().slice(0, 10);
}

export function ActivitiesSection({ canSaveViews = false }: { canSaveViews?: boolean } = {}) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [today, setToday] = useState<string>(browserToday);
  /**
   * The one filter document this screen owns — built into the request, handed
   * to the saved-view bar and described for the chips.
   *
   * The list opens on the unfinished work, as it always has: a task list that
   * starts by showing everything ever done buries the thing somebody has to do
   * today.
   */
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<ActivityViewFilters>(() => {
    // A queue opens here with its rule as the query string («کارهای امروز» is
    // `?state=today`), so the list a person lands on *is* the rows the count
    // promised. A URL with no filters starts on the screen's own default.
    const parsed = parseActivityViewFilters(searchParams);
    if (parsed.error) return { ...EMPTY_ACTIVITY_VIEW_FILTERS, state: "open" };
    // A filter the URL names is honoured exactly; a URL that names none keeps
    // this screen's own default, because «کارها» opens on the undone ones. A
    // search-only URL is the second case: `?q=…` still means open work.
    const asked = ACTIVITY_VIEW_FILTER_KEYS.some((key) => searchParams.has(key));
    const state = asked ? parsed.filters.state : "open";
    return { ...parsed.filters, state: state || "open" };
  });
  /** The member names the assignee filter and its chip can use. */
  const [members, setMembers] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [filterError, setFilterError] = useState("");
  const [info, setInfo] = useState("");
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
    async (next: ActivityViewFilters, opts: { quiet?: boolean } = {}) => {
      const seq = ++requestRef.current;
      if (!opts.quiet) setRefreshing(true);
      // The document *is* the query string: the same serialiser the saved-view
      // bar is handed and the chips are described from.
      const params = activityViewSearchParams(next);
      const { ok, data, aborted } = await api<ActivityListPayload>(
        `/api/crm/activities${params.size > 0 ? `?${params.toString()}` : ""}`,
      );
      if (aborted || seq !== requestRef.current) return;
      if (ok) {
        setActivities(data.activities ?? []);
        if (data.today) setToday(data.today);
        if (Array.isArray(data.members)) setMembers(data.members);
        setFilterError("");
        setError("");
      } else if (data?.error === "bad_filter") {
        // The reader's own control, named beside it — and the last good rows
        // stay, because blanking the list would read as «کاری نیست» when the
        // truth is «آن فیلتر معتبر نیست».
        setFilterError(activityViewErrorLine(data.field ?? ""));
        setRefreshing(false);
      } else {
        // Keep whatever is on screen rather than blanking the list: a dropped
        // connection should not look like "you have no work".
        setError(data?.error ? errorMessage(data.error) : "بارگذاری کارها ناموفق بود.");
        setActivities((current) => current ?? []);
      }
      setRefreshing(false);
    },
    [],
  );

  useEffect(() => {
    void load(filters, { quiet: true });
  }, [load, filters]);

  /**
   * Keep the address bar equal to the filter document.
   *
   * `replaceState`, not a navigation: the reader is already here, and a filter
   * change is not a new page. Two things follow from this being kept up to date
   * — a URL copied out of the address bar reproduces exactly the list it was
   * copied from, and the queue link above stops being a one-way door (change a
   * filter and the URL no longer claims to be the queue).
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const key of ["q", "kind", "state", "assignee"]) url.searchParams.delete(key);
    for (const [key, value] of Object.entries(activityViewQuery(filters))) {
      url.searchParams.set(key, value);
    }
    window.history.replaceState(null, "", url.toString());
  }, [filters]);

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

  /** The rows the server returned — the filtering happened in SQL, not here. */
  const visible = activities ?? [];

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

      {/* Named filter sets over this list. The bar hands its filters back here
          and the screen applies every one of them, so a shared view
          («تماس‌های عقب‌افتادهٔ من») narrows the rows rather than decorating the
          header. */}
      <SavedViewsBar
        entity="activities"
        current={activityViewQuery(filters)}
        onApply={(applied) =>
          setFilters((current) => ({ ...current, ...normaliseAppliedFilters(applied) }))
        }
        canSave={canSaveViews}
        onNotice={setInfo}
      />

      {filterError ? <ErrorBox>{filterError}</ErrorBox> : null}
      {info ? <InfoBox>{info}</InfoBox> : null}

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
              onClick={() => void load(filters)}
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
        <ActivityFilterBar filters={filters} members={members} onChange={setFilters} />

        {visible.length === 0 ? (
          <EmptyState>
            {activityViewFilterCount(filters) > 0
              ? "با این فیلترها کاری پیدا نشد."
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
              نمایش {formatPersianNumber(visible.length)} کار
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
            void load(filters, { quiet: true });
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
  // Assignment is a member, not a typed name: a free-text field is how a
  // callback ends up owned by somebody who cannot sign in, and how «کارهای من»
  // becomes unanswerable. The legacy name rides along so opening an old row and
  // saving something else does not erase it — see `CrmAssigneePicker`.
  const [assignee, setAssignee] = useState<CrmAssignee>({
    userId: activity?.assigneeUserId ?? "",
    name: activity?.assignedTo ?? "",
  });
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
      assigneeUserId: assignee.userId || null,
      assignedTo: assignee.name.trim(),
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
          <CrmAssigneePicker
            label="مسئول (اختیاری)"
            value={assignee}
            onChange={setAssignee}
          />
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

/**
 * The filters a saved view applied, as a document.
 *
 * Deliberately a *replace* rather than a merge: applying «تماس‌های عقب‌افتادهٔ
 * من» after having searched for a name must not show one person's calls
 * filtered by last week's word. What the view stores is what the list shows.
 */
function normaliseAppliedFilters(applied: Record<string, string>): ActivityViewFilters {
  return {
    q: applied.q ?? "",
    kind: applied.kind ?? "",
    state: applied.state ?? "",
    assignee: applied.assignee ?? "",
  };
}

/**
 * The list's filters, as controls.
 *
 * Every control writes into the one document the request is built from, and the
 * chips under it are described *from* that document — so a filter that is on is
 * a filter that is visible, and removing it is one click rather than a hunt
 * through the form. The count is the honest one (`activityViewFilterCount`), so
 * the reset control can say how much it is about to reset.
 *
 * The search box is the one control that is not immediate: this list is the
 * screen people leave open while working the floor, and it had deliberately
 * never issued a request per keystroke. The text is typed locally and committed
 * after a pause, and the pending write always reads the *latest* document —
 * otherwise choosing a kind while a search was still typing would have written
 * the kind back out.
 */
function ActivityFilterBar({
  filters,
  members,
  onChange,
}: {
  filters: ActivityViewFilters;
  members: { id: string; name: string; isActive: boolean }[];
  onChange: (next: ActivityViewFilters) => void;
}) {
  const chips = describeActivityView(filters, {
    memberName: (id) => members.find((member) => member.id === id)?.name ?? null,
  });
  const count = activityViewFilterCount(filters);

  const [typed, setTyped] = useState(filters.q);
  const latest = useRef(filters);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = filters;
  }, [filters]);
  // A document that changed elsewhere — an applied saved view, a reset — wins
  // over whatever was half-typed.
  useEffect(() => {
    setTyped(filters.q);
  }, [filters.q]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const type = (next: string) => {
    setTyped(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange({ ...latest.current, q: next }), 300);
  };

  return (
    <div className="mb-4 grid gap-3 rounded-2xl border border-border/80 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="activity-search">
            جست‌وجو
          </label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            />
            <input
              id="activity-search"
              type="search"
              className={`${inputClass} ps-9 pe-9`}
              placeholder="عنوان، یادداشت، مشتری یا مسئول…"
              value={typed}
              onChange={(event) => type(event.target.value)}
            />
            {typed ? (
              <button
                type="button"
                onClick={() => type("")}
                aria-label="پاک کردن جستجو"
                className="absolute inset-y-0 end-2 my-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="activity-kind">
            نوع
          </label>
          <select
            id="activity-kind"
            className={inputClass}
            value={filters.kind}
            onChange={(event) => onChange({ ...filters, kind: event.target.value })}
          >
            <option value="">همهٔ نوع‌ها</option>
            {ACTIVITY_KINDS.map((key) => (
              <option key={key} value={key}>
                {ACTIVITY_KIND_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="activity-state">
            وضعیت
          </label>
          <select
            id="activity-state"
            className={inputClass}
            value={filters.state}
            onChange={(event) => onChange({ ...filters, state: event.target.value })}
          >
            <option value="">همهٔ وضعیت‌ها</option>
            {ACTIVITY_VIEW_STATES.map((key) => (
              <option key={key} value={key}>
                {ACTIVITY_VIEW_STATE_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="activity-assignee">
            مسئول
          </label>
          <select
            id="activity-assignee"
            className={inputClass}
            value={filters.assignee}
            onChange={(event) => onChange({ ...filters, assignee: event.target.value })}
          >
            <option value="">همه</option>
            <option value="mine">کارهای من</option>
            {/* Unclaimed work is the kind that quietly disappears, so "nobody"
                is a first-class answer rather than the absence of a filter. */}
            <option value="none">بدون مسئول</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
                {member.isActive ? "" : " (غیرفعال)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {count > 0 ? `${toPersianDigits(String(count))} فیلتر فعال` : "بدون فیلتر"}
        </span>
        {count > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Back to how this screen opens — unfinished work — rather than to
            // every activity ever logged: a reset that left the list showing
            // the done ones would answer a question nobody asked. The count and
            // the chips both go to zero, which is what the button promised.
            onClick={() => onChange({ ...EMPTY_ACTIVITY_VIEW_FILTERS, state: "open" })}
          >
            برداشتن فیلترها
          </Button>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="فیلترهای اعمال‌شده">
          {chips.map((chip) => (
            <li key={chip}>
              <StatusBadge tone="neutral">{chip}</StatusBadge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
