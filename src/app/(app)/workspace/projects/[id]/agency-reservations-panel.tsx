"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  readReservation,
  reservationWindow,
  type ReservationInput,
} from "@/lib/agency-reservation";
import type { ReservationRow } from "@/lib/agency-reservation-service";
interface Data {
  rows: ReservationRow[];
  nextOffset: number | null;
  timeZone: string;
  tasks: { id: string; title: string }[];
  workers: { id: string; name: string }[];
  canWrite: boolean;
}
export function AgencyReservationsPanel({ projectId }: { projectId: string }) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [task, setTask] = useState(""),
    [worker, setWorker] = useState(""),
    [startDay, setStartDay] = useState(""),
    [endDay, setEndDay] = useState("");
  const [startClock, setStartClock] = useState(""),
    [endClock, setEndClock] = useState(""),
    [offset, setOffset] = useState(""),
    [note, setNote] = useState("");
  const [previous, setPrevious] = useState<string | null>(null),
    [status, setStatus] = useState<"reserved" | "cancelled">("reserved");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [preview, setPreview] = useState<ReservationInput | null>(null);
  const controller = useRef<AbortController | null>(null);
  const url = `/api/agency/projects/${projectId}/reservations`;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    setPreview(null);
  }, [
    task,
    worker,
    startDay,
    endDay,
    startClock,
    endClock,
    offset,
    note,
    previous,
    status,
    requestId,
  ]);
  const load = useCallback(
    async (page = 0) => {
      const params = new URLSearchParams({ from, to, offset: String(page) });
      try {
        reservationWindow(params);
      } catch {
        setError("بازهٔ معتبر حداکثر ۹۳ روزه انتخاب کنید.");
        return;
      }
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      setBusy(true);
      setError("");
      try {
        const r = await api<Data>(`${url}?${params}`, { signal: c.signal });
        if (c.signal.aborted || r.aborted) return;
        if (!r.ok) {
          setData(null);
          setError("خواندن رزروها ممکن نشد؛ دسترسی پروژه را بررسی کنید.");
          return;
        }
        setData((old) => ({
          ...r.data,
          rows:
            page === 0
              ? r.data.rows
              : Array.from(
                  new Map(
                    [...(old?.rows ?? []), ...r.data.rows].map((row) => [
                      row.id,
                      row,
                    ]),
                  ).values(),
                ),
        }));
      } finally {
        if (!c.signal.aborted) setBusy(false);
      }
    },
    [from, to, url],
  );
  function filterChanged() {
    controller.current?.abort();
    setBusy(false);
    setData(null);
    setPreview(null);
    setError("");
    setNotice("");
  }
  function reset() {
    setPrevious(null);
    setStatus("reserved");
    setNote("");
    setRequestId(crypto.randomUUID());
    setPreview(null);
  }
  function select(row: ReservationRow, cancel: boolean) {
    setPrevious(row.id);
    setStatus(cancel ? "cancelled" : "reserved");
    setTask(row.taskId);
    setWorker(row.workerId);
    setStartDay(row.startAt.slice(0, 10));
    setEndDay(row.endAt.slice(0, 10));
    setStartClock(row.startAt.slice(11, 16));
    setEndClock(row.endAt.slice(11, 16));
    setOffset("Z");
    setNote("");
    setRequestId(crypto.randomUUID());
    setPreview(null);
    setNotice("");
  }
  function prepare() {
    setError("");
    setPreview(null);
    try {
      setPreview(
        readReservation({
          taskId: task,
          workerId: worker,
          startAt: `${startDay}T${startClock}${offset}`,
          endAt: `${endDay}T${endClock}${offset}`,
          note,
          status,
          supersedesId: previous,
          requestId,
        }),
      );
    } catch {
      setError(
        "عضو، وظیفه، شرح و زمان معتبر با فاصلهٔ مثبت حداکثر ۲۴ ساعت و جابه‌جایی صریح UTC لازم است.",
      );
    }
  }
  async function save() {
    if (!preview) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const r = await api(url, {
        method: "POST",
        body: JSON.stringify(preview),
      });
      if (!r.ok) {
        setError(
          "نتیجهٔ ثبت نامشخص است یا پذیرفته نشد؛ مجوز، عضویت، نسخه و تداخل بازه را بررسی کنید. جزئیات پروژه‌های دیگر نمایش داده نمی‌شود. برای تلاش مجدد همین فرم و شناسه را حفظ کنید.",
        );
        return;
      }
      reset();
      await load();
      setNotice(
        "نسخه ثبت شد؛ اگر بازه تغییر کرده، برای دیدن زمان جدید فیلتر تاریخ را تغییر دهید.",
      );
    } finally {
      setSaving(false);
    }
  }
  const display = (value: string) =>
    formatJalali(value, { withTime: true, timeZone: data?.timeZone ?? "UTC" });
  return (
    <SectionCard title="رزرو منابع پروژه">
      <div className="space-y-3">
        <p className="text-sm">
          رزرو برنامه‌ریزی‌شده است، نه کارکرد واقعی، مرخصی، ساعت تأییدشده، هزینه
          یا صورتحساب. تداخل رزروهای فعال همین عضو در همهٔ پروژه‌های کسب‌وکار رد
          می‌شود؛ ساعات کاری و ظرفیت قراردادی بررسی نمی‌شوند.
        </p>
        <Field label="آغاز فیلتر رزرو" as="div">
          <JalaliDatePicker
            ariaLabel="آغاز فیلتر رزرو"
            value={from}
            disabled={busy || saving}
            onChange={(v) => {
              filterChanged();
              setFrom(v);
            }}
          />
        </Field>
        <Field label="پایان فیلتر رزرو" as="div">
          <JalaliDatePicker
            ariaLabel="پایان فیلتر رزرو"
            value={to}
            disabled={busy || saving}
            onChange={(v) => {
              filterChanged();
              setTo(v);
            }}
          />
        </Field>
        <SecondaryButton disabled={busy || saving} onClick={() => void load()}>
          نمایش رزروها
        </SecondaryButton>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <p>{notice}</p> : null}
        {busy && !data ? <SectionCardSkeleton /> : null}
        {data ? (
          <>
            <p className="text-xs">
              تاریخ فیلتر و نمایش در منطقهٔ {data.timeZone}؛ هر صفحه ۱۰۰ نسخه،
              بدون جمع ظرفیت. تغییر هم‌زمان برنامه ممکن است ترتیب صفحات را
              جابه‌جا کند؛ از صفحهٔ اول تازه کنید.
            </p>
            {data.rows.length === 0 ? (
              <p>رزروی در این پروژه و بازه نیست.</p>
            ) : null}
            {data.rows.map((row) => (
              <article
                key={row.id}
                className="space-y-1 rounded-xl border border-border p-3"
              >
                <p>
                  {row.workerName} — {row.taskTitle}
                </p>
                <p>
                  {display(row.startAt)} تا {display(row.endAt)} —{" "}
                  {toPersianDigits(
                    (Date.parse(row.endAt) - Date.parse(row.startAt)) / 60000,
                  )}{" "}
                  دقیقه
                </p>
                <p>
                  {row.superseded
                    ? "نسخهٔ جایگزین‌شده"
                    : row.status === "cancelled"
                      ? "لغوشده"
                      : "رزرو فعال"}{" "}
                  — {row.createdByName} — {display(row.createdAt)}
                </p>
                <p className="whitespace-pre-wrap">{row.note}</p>
                {data.canWrite &&
                !row.superseded &&
                row.status === "reserved" ? (
                  <div className="flex gap-2">
                    <SecondaryButton
                      disabled={busy || saving}
                      onClick={() => select(row, false)}
                    >
                      جابه‌جایی با حفظ تاریخچه
                    </SecondaryButton>
                    <SecondaryButton
                      disabled={busy || saving}
                      onClick={() => select(row, true)}
                    >
                      لغو با ثبت دلیل
                    </SecondaryButton>
                  </div>
                ) : null}
              </article>
            ))}
            {data.nextOffset !== null ? (
              <SecondaryButton
                disabled={busy || saving}
                onClick={() => void load(data.nextOffset!)}
              >
                صفحهٔ بعدی رزروها
              </SecondaryButton>
            ) : null}
            {data.canWrite ? (
              <fieldset
                disabled={saving || busy}
                className="space-y-3 rounded-xl border border-border p-3"
              >
                <legend>
                  {previous
                    ? status === "cancelled"
                      ? "لغو رزرو؛ بازه تغییر نمی‌کند"
                      : "جابه‌جایی رزرو همان عضو و وظیفه"
                    : "رزرو جدید"}
                </legend>
                <Field label="عضو رزرو">
                  <select
                    className={inputClass}
                    disabled={Boolean(previous)}
                    value={worker}
                    onChange={(e) => setWorker(e.target.value)}
                  >
                    <option value="">انتخاب عضو</option>
                    {data.workers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                    {previous && !data.workers.some((w) => w.id === worker) ? (
                      <option value={worker}>عضو نسخهٔ قبلی</option>
                    ) : null}
                  </select>
                </Field>
                <Field label="وظیفهٔ رزرو">
                  <select
                    className={inputClass}
                    disabled={Boolean(previous)}
                    value={task}
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
                  حداکثر ۲۰۰ وظیفهٔ اخیر و ۲۰۰ عضو فعال مشارکت‌کنندهٔ پروژه.
                  تغییر عضو یا وظیفه با لغو رزرو قبلی و ثبت رزرو جدید انجام
                  می‌شود.
                </p>
                <Field label="روز آغاز رزرو" as="div">
                  <JalaliDatePicker
                    ariaLabel="روز آغاز رزرو"
                    value={startDay}
                    onChange={setStartDay}
                    disabled={saving || status === "cancelled"}
                  />
                </Field>
                <Field label="ساعت آغاز رزرو">
                  <input
                    className={inputClass}
                    type="time"
                    value={startClock}
                    disabled={status === "cancelled"}
                    onChange={(e) => setStartClock(e.target.value)}
                  />
                </Field>
                <Field label="روز پایان رزرو" as="div">
                  <JalaliDatePicker
                    ariaLabel="روز پایان رزرو"
                    value={endDay}
                    onChange={setEndDay}
                    disabled={saving || status === "cancelled"}
                  />
                </Field>
                <Field label="ساعت پایان رزرو">
                  <input
                    className={inputClass}
                    type="time"
                    value={endClock}
                    disabled={status === "cancelled"}
                    onChange={(e) => setEndClock(e.target.value)}
                  />
                </Field>
                <Field
                  label="جابه‌جایی UTC زمان واردشده"
                  hint="صریحاً Z یا مانند +03:30 وارد کنید. مرورگر منطقهٔ زمانی را حدس نمی‌زند؛ پیش‌نمایش را در منطقهٔ کسب‌وکار بررسی کنید."
                >
                  <input
                    className={inputClass}
                    dir="ltr"
                    aria-label="جابه‌جایی UTC زمان واردشده"
                    value={offset}
                    disabled={status === "cancelled"}
                    onChange={(e) => setOffset(e.target.value)}
                  />
                </Field>
                <Field label="شرح یا دلیل تغییر رزرو">
                  <textarea
                    className={inputClass}
                    value={note}
                    maxLength={1000}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <SecondaryButton onClick={prepare}>
                  پیش‌نمایش رزرو
                </SecondaryButton>
                {preview ? (
                  <div className="space-y-2">
                    <p>
                      پیش‌نمایش در {data.timeZone}: {display(preview.startAt)}{" "}
                      تا {display(preview.endAt)} —{" "}
                      {preview.status === "cancelled" ? "لغو" : "رزرو"}
                    </p>
                    <PrimaryButton
                      type="button"
                      disabled={saving || busy}
                      onClick={() => void save()}
                    >
                      تأیید و ثبت نسخهٔ رزرو
                    </PrimaryButton>
                  </div>
                ) : null}
                <SecondaryButton onClick={reset}>
                  شروع رزرو جدید
                </SecondaryButton>
              </fieldset>
            ) : null}
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
