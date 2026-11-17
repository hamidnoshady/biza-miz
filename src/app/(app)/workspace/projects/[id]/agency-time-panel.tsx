"use client";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import type { AgencyTimeRow } from "@/lib/agency-time-service";
interface TimeData {
  rows: AgencyTimeRow[];
  tasks: { id: string; title: string }[];
  totalMinutes: string | null;
  actorUserId: string;
  canWrite: boolean;
}
export function AgencyTimePanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<TimeData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [task, setTask] = useState(""),
    [day, setDay] = useState(""),
    [minutes, setMinutes] = useState(""),
    [note, setNote] = useState("");
  const [previous, setPrevious] = useState<string | null>(null),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const url = `/api/agency/projects/${projectId}/time`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const r = await api<TimeData>(url, { signal });
      if (signal?.aborted || r.aborted) return;
      if (!r.ok) {
        setError("خواندن زمان‌های ثبت‌شده ممکن نشد.");
        return;
      }
      setData(r.data);
      setError("");
    },
    [url],
  );
  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);
  function reset() {
    setPrevious(null);
    setRequestId(crypto.randomUUID());
    setMinutes("");
    setNote("");
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api(url, {
        method: "POST",
        body: JSON.stringify({
          taskId: task,
          workDate: day,
          minutes: Number(minutes),
          note,
          supersedesId: previous,
          requestId,
        }),
      });
      if (!r.ok) {
        setError(
          "ثبت زمان پذیرفته نشد؛ مجوز، تاریخ، وظیفه، سقف روزانه یا نسخهٔ قبلی را بررسی کنید. در تلاش مجدد همان شناسه حفظ می‌شود.",
        );
        return;
      }
      reset();
      await load();
    } finally {
      setBusy(false);
    }
  }
  if (!data && !error) return <SectionCardSkeleton />;
  return (
    <SectionCard title="زمان واقعی کار روی وظایف">
      <div className="space-y-3">
        <p className="text-sm">
          ثبت دستی توسط خود عضو؛ نه حضور و غیاب، تأیید مدیر، هزینهٔ حقوق یا
          صورتحساب. سقف ثبت فعال برای هر عضو در یک روز در همهٔ پروژه‌ها ۱۴۴۰
          دقیقه است؛ این سقف به معنی نبود همپوشانی یا تأیید کارکرد نیست.
        </p>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <SecondaryButton disabled={busy} onClick={() => void load()}>
          تازه‌کردن زمان‌ها
        </SecondaryButton>
        <p>
          جمع همهٔ ثبت‌های فعال پروژه (دقیقه):{" "}
          {data?.totalMinutes == null
            ? "نامشخص؛ ثبت فعالی نیست"
            : toPersianDigits(data.totalMinutes)}
        </p>
        <p className="text-xs">
          ۱۰۰ نسخهٔ اخیر؛ جمع بالا از کل ثبت‌های فعال است، نه از این صفحه.
          نسخه‌های اصلاح‌شده و ابطال‌شده جمع نمی‌شوند.
        </p>
        {data?.rows.map((r) => (
          <article
            key={r.id}
            className="space-y-1 rounded-xl border border-border p-3"
          >
            <p>
              {r.taskTitle} — {formatJalali(r.workDate)} —{" "}
              {toPersianDigits(r.minutes)} دقیقه
            </p>
            <p>
              {r.createdByName} — ثبت {formatJalali(r.createdAt)} —{" "}
              {r.superseded
                ? "نسخهٔ جایگزین‌شده"
                : r.minutes === 0
                  ? "ابطال‌شده"
                  : "فعال"}
            </p>
            <p className="whitespace-pre-wrap">{r.note}</p>
            {data.canWrite &&
            r.createdBy === data.actorUserId &&
            !r.superseded &&
            r.minutes > 0 ? (
              <SecondaryButton
                disabled={busy}
                onClick={() => {
                  setPrevious(r.id);
                  setTask(r.taskId);
                  setDay(r.workDate);
                  setMinutes(String(r.minutes));
                  setNote("");
                  setRequestId(crypto.randomUUID());
                }}
              >
                اصلاح یا ابطال با حفظ تاریخچه
              </SecondaryButton>
            ) : null}
          </article>
        ))}
        {data?.canWrite ? (
          <fieldset
            disabled={busy}
            className="space-y-3 rounded-xl border border-border p-3"
          >
            <legend>
              {previous
                ? "اصلاحیهٔ زمان خودم؛ صفر یعنی ابطال"
                : "ثبت زمان خودم"}
            </legend>
            <Field label="وظیفهٔ زمان">
              <select
                className={inputClass}
                value={task}
                disabled={Boolean(previous)}
                onChange={(e) => setTask(e.target.value)}
              >
                <option value="">انتخاب وظیفه</option>
                {data.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
                {previous && !data.tasks.some((t) => t.id === task) ? (
                  <option value={task}>وظیفهٔ نسخهٔ قبلی</option>
                ) : null}
              </select>
            </Field>
            <p className="text-xs">
              حداکثر ۲۰۰ وظیفهٔ اخیر. مشارکت‌کننده فقط روی وظیفهٔ واگذارشده ثبت
              جدید دارد؛ اصلاحیه فقط برای ثبت خودتان است.
            </p>
            <Field label="روز انجام کار" as="div">
              <JalaliDatePicker
                ariaLabel="روز انجام کار"
                value={day}
                onChange={setDay}
                disabled={Boolean(previous) || busy}
              />
            </Field>
            <Field label="مدت کار به دقیقه">
              <PersianNumberInput
                className={inputClass}
                value={minutes}
                allowDecimal={false}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </Field>
            <Field label="شرح کار یا دلیل اصلاح و ابطال">
              <textarea
                className={inputClass}
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <PrimaryButton
              type="button"
              disabled={busy || !task || !day || !minutes || !note.trim()}
              onClick={() => void save()}
            >
              ثبت نسخهٔ زمان
            </PrimaryButton>
            <SecondaryButton disabled={busy} onClick={reset}>
              شروع ثبت جدید
            </SecondaryButton>
          </fieldset>
        ) : null}
      </div>
    </SectionCard>
  );
}
