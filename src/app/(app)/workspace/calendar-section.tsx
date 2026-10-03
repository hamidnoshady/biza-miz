"use client";

/**
 * «تقویم» — five date sources on one Shamsi month grid.
 *
 * Four of the five are derived — a project's end date, a task's due date, a
 * contract's expiry, an approval's deadline — and only «رویداد» is a stored
 * row. The month grid is built from `jalali.ts`, so it starts on شنبه, reads
 * right to left and never depends on a Gregorian week boundary.
 */

import type { WorkspaceIntent } from "./workspace-routes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { workspaceSectionHref } from "@/lib/app-routes";
import { toPersianDigits } from "@/lib/digits";
import {
  JALALI_MONTHS,
  isoDateToJalali,
  jalaliMonthLength,
  jalaliToIsoDate,
  jalaliWeekdayColumn,
  todayJalali,
} from "@/lib/jalali";
import {
  CALENDAR_SOURCES,
  CALENDAR_SOURCE_LABELS,
  EVENT_KINDS,
  EVENT_KIND_LABELS,
  type WorkspaceCalendarSource,
  type WorkspaceEventKind,
} from "@/lib/workspace-shared";
import {
  DateField,
  PickerField,
  SelectField,
  workspaceError,
  WorkspaceFormDialog,
} from "./workspace-ui";
import type { WorkspaceLookups } from "./use-workspace-lookups";
import { WorkspaceEntityDrawer, type WorkspaceEntityRef } from "./workspace-entity-drawer";

interface CalendarEntry {
  id: string;
  source: WorkspaceCalendarSource;
  title: string;
  date: string;
  startTime: string | null;
  kind: WorkspaceEventKind | null;
  projectId: string | null;
  projectName: string | null;
  location: string;
  endTime: string | null;
  refId: string;
  description: string;
}

/** شنبه-first, which is what a Persian calendar reads as a week. */
const WEEKDAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

export function CalendarSection({
  lookups,
  intent,
  canManage,
  projectId,
}: {
  lookups: WorkspaceLookups;
  /** A consumed URL intent — see `WorkspaceIntent`. */
  intent?: WorkspaceIntent;
  canManage: boolean;
  projectId?: string;
}) {
  const today = useMemo(() => todayJalali(), []);
  const [year, setYear] = useState(today.jy);
  const [month, setMonth] = useState(today.jm);
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState<Set<WorkspaceCalendarSource>>(new Set());
  const [creating, setCreating] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEntry | null>(null);
  const [drawer, setDrawer] = useState<WorkspaceEntityRef | null>(null);
  const router = useRouter();
  const openEntry = (entry: CalendarEntry) => {
    if (entry.source === "event") setEditingEvent(entry);
    else if (entry.source === "task_due") setDrawer({ kind: "task", id: entry.refId });
    else if (entry.source === "contract_expiry") setDrawer({ kind: "contract", id: entry.refId });
    else if (entry.source === "project_deadline") setDrawer({ kind: "project", id: entry.refId });
    else router.push(`${workspaceSectionHref("approvals")}?mine=true`);
  };
  useEffect(() => {
    if (intent?.create) setCreating(true);
  }, [intent]);
  const [selected, setSelected] = useState<string | null>(null);

  const monthLength = jalaliMonthLength(year, month);
  const from = jalaliToIsoDate(year, month, 1);
  const to = jalaliToIsoDate(year, month, monthLength);

  const load = useCallback(() => {
    if (!from || !to) return;
    const params = new URLSearchParams({ from, to });
    if (projectId) params.set("projectId", projectId);
    api<{ entries: CalendarEntry[] }>(`/api/workspace/calendar?${params}`).then(({ ok, data }) => {
      if (ok) setEntries(data.entries);
      else setError(workspaceError((data as unknown as { error?: string }).error));
    });
  }, [from, to, projectId]);

  useEffect(load, [load]);

  const visible = useMemo(
    () => (entries ?? []).filter((entry) => !hidden.has(entry.source)),
    [entries, hidden],
  );

  const byDay = useMemo(() => {
    const map = new Map<number, CalendarEntry[]>();
    for (const entry of visible) {
      const jalali = isoDateToJalali(entry.date);
      if (!jalali || jalali.jy !== year || jalali.jm !== month) continue;
      const list = map.get(jalali.jd);
      if (list) list.push(entry);
      else map.set(jalali.jd, [entry]);
    }
    return map;
  }, [visible, year, month]);

  function step(delta: number) {
    const next = month + delta;
    if (next < 1) {
      setYear(year - 1);
      setMonth(12);
    } else if (next > 12) {
      setYear(year + 1);
      setMonth(1);
    } else {
      setMonth(next);
    }
    setSelected(null);
  }

  const offset = jalaliWeekdayColumn(year, month, 1);
  const cells: Array<number | null> = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: monthLength }, (_, i) => i + 1),
  ];

  const selectedEntries = selected ? (byDay.get(Number(selected)) ?? []) : [];

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="تقویم میز کار"
        description="مهلت پروژه‌ها و وظایف، جلسه‌ها، انقضای قراردادها و مهلت تأییدها روی یک تقویم شمسی"
        actions={
          canManage ? (
            <PrimaryButton type="button" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" aria-hidden />
              رویداد جدید
            </PrimaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-col gap-3 border-b border-border/80 p-4">
          <div className="flex items-center justify-between gap-2">
            {/* Logical arrows: in RTL, «قبلی» sits on the right and points that way. */}
            <SecondaryButton onClick={() => step(-1)}>
              <ChevronRightIcon className="size-4" aria-hidden />
              ماه قبل
            </SecondaryButton>
            <h3 className="text-sm font-semibold">
              {JALALI_MONTHS[month - 1]} {toPersianDigits(String(year))}
            </h3>
            <SecondaryButton onClick={() => step(1)}>
              ماه بعد
              <ChevronLeftIcon className="size-4" aria-hidden />
            </SecondaryButton>
          </div>
          <FilterChipRow label="فیلتر منبع رویدادها">
            {CALENDAR_SOURCES.map((source) => (
              <FilterChip
                key={source}
                selected={!hidden.has(source)}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(source)) next.delete(source);
                    else next.add(source);
                    return next;
                  })
                }
              >
                {CALENDAR_SOURCE_LABELS[source]}
              </FilterChip>
            ))}
          </FilterChipRow>
        </div>

        {entries === null ? (
          <LoadingSkeleton rows={6} label="در حال بارگذاری تقویم" />
        ) : (
          <div className="p-4">
            <div className="grid grid-cols-7 gap-1" role="grid" aria-label="تقویم ماه">
              {WEEKDAYS.map((day) => (
                <div
                  key={day}
                  className="py-1 text-center text-xs font-medium text-muted-foreground"
                >
                  {day}
                </div>
              ))}
              {cells.map((day, index) => {
                if (day === null) return <div key={`pad-${index}`} />;
                const items = byDay.get(day) ?? [];
                const isToday = year === today.jy && month === today.jm && day === today.jd;
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setSelected(String(day))}
                    aria-pressed={selected === String(day)}
                    className={cn(
                      "flex min-h-20 flex-col gap-1 rounded-lg border p-1.5 text-start transition-colors",
                      isToday
                        ? "border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10"
                        : "border-border/80 bg-card hover:bg-muted/60",
                    )}
                  >
                    <span className="text-xs font-medium tabular-nums">
                      {toPersianDigits(String(day))}
                    </span>
                    {items.slice(0, 2).map((entry) => (
                      <span
                        key={entry.id}
                        className="truncate rounded bg-muted px-1 py-0.5 text-[0.65rem] text-muted-foreground"
                      >
                        {entry.title}
                      </span>
                    ))}
                    {items.length > 2 ? (
                      <span className="text-[0.65rem] text-muted-foreground">
                        +{toPersianDigits(String(items.length - 2))} مورد
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </SectionCard>

      {selected ? (
        <SectionCard
          title={`رویدادهای ${toPersianDigits(selected)} ${JALALI_MONTHS[month - 1]}`}
          actions={<SecondaryButton onClick={() => setSelected(null)}>بستن</SecondaryButton>}
        >
          {selectedEntries.length === 0 ? (
            <EmptyState icon={CalendarDaysIcon} title="این روز خالی است">
              رویداد، مهلت یا انقضایی برای این روز ثبت نشده است.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80">
              {selectedEntries.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  {/* Each entry opens the record that owns its date (#761 §10):
                      a stored event its editor, a task / contract / project
                      the shared drawer, an approval deadline the inbox. */}
                  <button
                    type="button"
                    onClick={() => openEntry(entry)}
                    className="min-w-0 flex-1 truncate text-start font-medium underline-offset-4 hover:underline"
                  >
                    {entry.title}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {CALENDAR_SOURCE_LABELS[entry.source]}
                  </span>
                  {entry.startTime ? (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {toPersianDigits(entry.startTime)}
                    </span>
                  ) : null}
                  {entry.projectName ? (
                    <span className="text-xs text-muted-foreground">{entry.projectName}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {creating || editingEvent ? (
        <EventDialog
          lookups={lookups}
          event={editingEvent ?? undefined}
          canEdit={canManage}
          defaultProjectId={projectId ?? intent?.projectId}
          onClose={() => {
            setCreating(false);
            setEditingEvent(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditingEvent(null);
            load();
          }}
          onError={setError}
        />
      ) : null}

      <WorkspaceEntityDrawer entity={drawer} onClose={() => setDrawer(null)} lookups={lookups} onChanged={load} />
    </div>
  );
}

function EventDialog({
  lookups,
  event,
  canEdit = true,
  defaultProjectId,
  onClose,
  onSaved,
  onError,
}: {
  lookups: WorkspaceLookups;
  /** Set to edit a stored event; absent to create one. */
  event?: CalendarEntry;
  canEdit?: boolean;
  defaultProjectId?: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(event?.title ?? "");
  const [kind, setKind] = useState<WorkspaceEventKind | "">(event?.kind ?? "meeting");
  const [eventDate, setEventDate] = useState(event?.date ?? "");
  const [startTime, setStartTime] = useState(event?.startTime ?? "");
  const [endTime, setEndTime] = useState(event?.endTime ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [projectId, setProjectId] = useState(event?.projectId ?? defaultProjectId ?? "");
  const [saving, setSaving] = useState(false);

  async function remove() {
    if (!event || saving) return;
    setSaving(true);
    const { ok, data } = await api(`/api/workspace/calendar?id=${event.refId}`, { method: "DELETE" });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  async function submit() {
    if (!title.trim() || !eventDate || saving) return;
    setSaving(true);
    const payload = JSON.stringify({
      title,
      kind: kind || "meeting",
      eventDate,
      startTime: startTime || null,
      endTime: endTime || null,
      location,
      description,
      projectId: projectId || null,
    });
    const { ok, data } = event
      ? await api(`/api/workspace/calendar?id=${event.refId}`, { method: "PATCH", body: payload })
      : await api("/api/workspace/calendar", { method: "POST", body: payload });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <WorkspaceFormDialog title={event ? "رویداد" : "رویداد جدید"} width="xl" onClose={onClose}>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="عنوان">
            <input
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </Field>
        </div>
        <SelectField
          label="نوع"
          value={kind}
          onChange={setKind}
          options={EVENT_KINDS}
          labels={EVENT_KIND_LABELS}
        />
        <DateField label="تاریخ" value={eventDate} onChange={setEventDate} />
        <Field label="ساعت شروع" hint="اختیاری">
          <input
            className={inputClass}
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            placeholder="۰۹:۳۰"
            type="time"
          />
        </Field>
        <Field label="ساعت پایان" hint="اختیاری">
          <input
            className={inputClass}
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            type="time"
          />
        </Field>
        <PickerField
          label="پروژه"
          value={projectId}
          onChange={setProjectId}
          options={lookups.projects.map((p) => ({ id: p.id, label: p.name }))}
          placeholder="— بدون پروژه —"
        />
        <div className="sm:col-span-2">
          <Field label="مکان">
            <input
              className={inputClass}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="توضیح" hint="اختیاری">
            <textarea
              className={`${inputClass} min-h-20`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border/80 p-4">
        {event && canEdit ? (
          <SecondaryButton onClick={remove} disabled={saving}>
            حذف رویداد
          </SecondaryButton>
        ) : null}
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        {canEdit ? (
          <PrimaryButton
            type="button"
            onClick={submit}
            disabled={!title.trim() || !eventDate || saving}
          >
            {saving ? "در حال ذخیره" : event ? "ذخیرهٔ تغییرات" : "ثبت رویداد"}
          </PrimaryButton>
        ) : null}
      </div>
    </WorkspaceFormDialog>
  );
}
