"use client";

/**
 * «تقویم» — five date sources on one Shamsi month grid.
 *
 * Four of the five are derived — a project's end date, a task's due date, a
 * contract's expiry, an approval's deadline — and only «رویداد» is a stored
 * row. The month grid is built from `jalali.ts`, so it starts on شنبه, reads
 * right to left and never depends on a Gregorian week boundary.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  overlayPanelClass,
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
import { cn } from "@/lib/utils";
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
import { DateField, PickerField, SelectField, workspaceError } from "./workspace-ui";
import type { WorkspaceLookups } from "./use-workspace-lookups";

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
}

/** شنبه-first, which is what a Persian calendar reads as a week. */
const WEEKDAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

export function CalendarSection({
  lookups,
  initialCreating = false,
  createProjectId,
  canManage,
  projectId,
}: {
  lookups: WorkspaceLookups;
  /** From `?create=1` — the command bar's «+ ایجاد» opens the create dialog. */
  initialCreating?: boolean;
  /** From `?project=` — the create dialog preselects that project. */
  createProjectId?: string;
  canManage: boolean;
  projectId?: string;
}) {
  const today = useMemo(() => todayJalali(), []);
  const [year, setYear] = useState(today.jy);
  const [month, setMonth] = useState(today.jm);
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState<Set<WorkspaceCalendarSource>>(new Set());
  const [creating, setCreating] = useState(initialCreating);
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
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.title}</span>
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

      {creating ? (
        <EventDialog
          lookups={lookups}
          defaultProjectId={projectId ?? createProjectId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function EventDialog({
  lookups,
  defaultProjectId,
  onClose,
  onSaved,
  onError,
}: {
  lookups: WorkspaceLookups;
  defaultProjectId?: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<WorkspaceEventKind | "">("meeting");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [location, setLocation] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim() || !eventDate || saving) return;
    setSaving(true);
    const { ok, data } = await api("/api/workspace/calendar", {
      method: "POST",
      body: JSON.stringify({
        title,
        kind: kind || "meeting",
        eventDate,
        startTime: startTime || null,
        location,
        projectId: projectId || null,
      }),
    });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">رویداد جدید</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
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
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton
            type="button"
            onClick={submit}
            disabled={!title.trim() || !eventDate || saving}
          >
            {saving ? "در حال ذخیره" : "ثبت رویداد"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
