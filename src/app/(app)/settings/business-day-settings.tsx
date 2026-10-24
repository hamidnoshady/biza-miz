"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * روز کاری — the management panel for the branch's trading day.
 *
 * Optional by design: a branch that leaves it off keeps the calendar day it
 * always had, and the panel says so rather than hiding the choice. Turning it
 * on is one number — the hour the day starts — and everything else follows
 * from it: a café that sets 18:00 has business days running 18:00 → 18:00, so
 * its 18:00–03:00 service is one day on one date instead of an evening and a
 * morning either side of midnight.
 *
 * The second half is the manual close: "we have cashed up, start the next day
 * now" without waiting for the start time to come round. It resets what is on
 * screen — the dashboard KPIs, the orders screen's closed list — and moves no
 * money, which is why it can be undone with a single button.
 *
 * The two halves are gated differently and the panel draws that difference:
 * the start time needs `settings.manage`, the close needs owner/manager, and
 * the tab itself opens on `team.manage`. A member who holds one but not the
 * other used to be shown both sets of buttons and told «دسترسی مجاز نیست» on
 * click; now they see only what they can actually do, with a line saying why.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatStartTime, parseStartTime } from "@/lib/business-day";
import { formatJalali } from "@/lib/jalali";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { newIdempotencyKey } from "@/lib/idempotency";

interface BusinessDayStatus {
  timeZone: string;
  startMinutes: number | null;
  enabled: boolean;
  businessDate: string;
  scheduledStart: string;
  scheduledEnd: string;
  windowStart: string;
  /** "shift" = the cashier cashed up, "manual" = «بستن روز کاری», null = still running. */
  closedBy: "manual" | "shift" | null;
  manuallyClosed: boolean;
  lastClosedAt: string | null;
  lastClosedByName: string | null;
  lastShiftEndedAt: string | null;
  hasOpenShift: boolean;
}

interface Closure {
  id: string;
  businessDate: string;
  closedAt: string;
  closedByName: string | null;
  note: string | null;
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenNote: string | null;
}

function formatMoment(iso: string | null): string {
  if (!iso) return "—";
  return toPersianDigits(
    formatJalali(iso, { withMonthName: true, withTime: true }),
  );
}

function formatDate(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

function formatClock(minutes: number): string {
  return toPersianDigits(formatStartTime(minutes));
}

export function BusinessDaySettings() {
  const [status, setStatus] = useState<BusinessDayStatus | null>(null);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [locationName, setLocationName] = useState("");
  const [canConfigure, setCanConfigure] = useState(false);
  const [canClose, setCanClose] = useState(false);
  /**
   * What a reopen does *not* undo (#933 item 8). A close queues a coworker
   * `day_close` event and a notification; reopening the window leaves both in
   * place. The panel says so instead of implying a rollback.
   */
  const [reopenEffects, setReopenEffects] = useState<string[]>([]);
  const [startTime, setStartTime] = useState("18:00");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /**
   * The panel unmounts as soon as the member navigates to another settings
   * section, and every action here ends in `await load()`. Without this the
   * reload's setState lands after unmount — a React warning in development and,
   * worse, a stale «روز کاری بسته شد» notice re-applied to a panel the member
   * has already left and come back to.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      businessDay: BusinessDayStatus;
      locationName: string;
      closures: Closure[];
      canConfigure?: boolean;
      canClose?: boolean;
      canManage?: boolean;
      error?: string;
    }>("/api/business-day");
    if (!alive.current) return;
    setLoaded(true);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setStatus(data.businessDay);
    setClosures(data.closures ?? []);
    setLocationName(data.locationName ?? "");
    setCanConfigure(data.canConfigure ?? false);
    setCanClose(data.canClose ?? data.canManage ?? false);
    if (data.businessDay.startMinutes !== null) {
      setStartTime(formatStartTime(data.businessDay.startMinutes));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(
    path: string,
    init: RequestInit,
    successMessage: string,
  ): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    setReopenEffects([]);
    const { ok, data } = await api<{ error?: string; reopenEffects?: string[] }>(path, init);
    if (!alive.current) return;
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setReopenEffects(data.reopenEffects ?? []);
    setNotice(successMessage);
    await load();
  }

  const save = () => {
    // Checked here as well as on the server: an empty or half-typed time field
    // would otherwise be sent as «خاموش کن» (the API reads "" as null), so a
    // member who cleared the box and pressed «ذخیره» silently turned the whole
    // business day off instead of being told the value was incomplete.
    if (parseStartTime(startTime) === null) {
      setNotice("");
      setError(errorMessage("invalid_start_time"));
      return;
    }
    return send(
      "/api/business-day",
      { method: "PATCH", body: JSON.stringify({ startTime }) },
      "ساعت شروع روز کاری ذخیره شد.",
    );
  };

  const disable = () => {
    if (
      !window.confirm(
        "روز کاری غیرفعال شود؟ از این پس مبنای داشبورد، فهرست سفارش‌ها و گزارش‌ها روز تقویمی (نیمه‌شب تا نیمه‌شب) خواهد بود و گزارش‌های گذشته هم بر همین مبنا دسته‌بندی می‌شوند.",
      )
    )
      return;
    return send(
      "/api/business-day",
      { method: "PATCH", body: JSON.stringify({ startTime: null }) },
      "روز کاری غیرفعال شد؛ از این پس روز تقویمی (نیمه‌شب تا نیمه‌شب) ملاک است.",
    );
  };

  const closeDay = () => {
    if (
      !window.confirm(
        "روز کاری بسته شود؟ داشبورد و فهرست سفارش‌ها از همین لحظه صفر می‌شوند و رویداد «پایان روز» برای اتوماسیون‌ها صف می‌شود. گزارش‌ها جابه‌جا نمی‌شوند؛ اما اگر بعداً روز را باز کنید، کارهایی که همان لحظه اجرا شده‌اند برنمی‌گردند.",
      )
    )
      return;
    return send(
      "/api/business-day/close",
      {
        method: "POST",
        // A retried request (a dropped response, a double click) finds the
        // closure it already wrote instead of reporting «قبلاً بسته شده».
        headers: { "Idempotency-Key": newIdempotencyKey() },
      },
      "روز کاری بسته شد. داشبورد و فهرست سفارش‌ها از همین لحظه صفر شدند.",
    );
  };

  const reopenDay = (closureId?: string) => {
    const message = closureId
      ? "این بسته‌شدن بازگردانی شود؟ فقط پنجرهٔ شمارش باز می‌شود؛ رویدادهای پایان روزی که قبلاً به اتوماسیون‌ها داده شده‌اند و اعلان‌ها بازنمی‌گردند. اگر موجودی یا سندی به‌صورت خودکار ثبت شده باشد، باید جداگانه اصلاح شود."
      : "روز کاری دوباره باز شود؟ فقط پنجرهٔ شمارش باز می‌شود؛ رویدادهای پایان روزی که قبلاً به اتوماسیون‌ها داده شده‌اند و اعلان‌ها بازنمی‌گردند.";
    if (!window.confirm(message)) return;
    const query = new URLSearchParams();
    if (closureId) query.set("closureId", closureId);
    return send(
      `/api/business-day/close${query.size ? `?${query.toString()}` : ""}`,
      { method: "DELETE" },
      "روز کاری دوباره باز شد. فقط پنجرهٔ داشبورد و فهرست سفارش‌ها بازگشت.",
    );
  };

  const dirty =
    status !== null &&
    (status.startMinutes === null || formatStartTime(status.startMinutes) !== startTime);

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سرویس و شعبه</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">روز کاری{locationName ? ` — ${locationName}` : ""}</h2>
        </div>
      }
      description="اگر کار شعبه از شب تا بامداد ادامه دارد، ساعت شروع روز کاری را تعیین کنید تا کل یک سرویس — مثلاً ۱۸:۰۰ تا ۰۳:۰۰ بامداد — یک روز کاری واحد حساب شود و داشبورد، فهرست سفارش‌ها و گزارش‌ها نیمه‌شب دو تکه نشوند. این تنظیم اختیاری است؛ تا وقتی فعالش نکنید همه‌چیز مثل قبل بر مبنای روز تقویمی کار می‌کند."
    >

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {reopenEffects.length > 0 ? (
        <InfoBox>
          رویداد «پایان روز» قبلاً برای اتوماسیون‌ها صف شده است. بازگشایی روز آن را لغو
          نمی‌کند؛ اگر کاری بر اساس آن انجام شده، اصلاح جداگانه لازم است.
        </InfoBox>
      ) : null}

      {!loaded ? (
        <LoadingSkeleton rows={3} label="در حال بارگذاری وضعیت روز کاری" />
      ) : null}

      {loaded && status ? (
        <>
          <div className="mb-5 rounded-xl border border-input px-3 py-3 text-sm sm:px-4">
            {status.enabled ? (
              <>
                <p className="font-medium">
                  روز کاری فعال است و از ساعت{" "}
                  <span className="tabular-nums">{formatClock(status.startMinutes ?? 0)}</span> شروع می‌شود.
                </p>
                <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-[11px]">روز کاری جاری</dt>
                    <dd className="font-medium text-foreground">{formatDate(status.businessDate)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[11px]">بازهٔ روز کاری</dt>
                    <dd className="break-words">
                      از {formatMoment(status.scheduledStart)} تا {formatMoment(status.scheduledEnd)}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-[11px]">شمارش آمار داشبورد و سفارش‌ها از</dt>
                    <dd className="break-words">
                      {formatMoment(status.windowStart)}
                      {status.closedBy === "shift"
                        ? " — شیفت بسته شده؛ کار شب تمام شده است."
                        : status.closedBy === "manual"
                          ? ` — روز به‌صورت دستی بسته شده${
                              status.lastClosedByName ? ` توسط ${status.lastClosedByName}` : ""
                            }.`
                          : status.hasOpenShift
                            ? " — شیفت باز است."
                            : "."}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="text-muted-foreground">
                روز کاری تعریف نشده است؛ مبنای گزارش‌ها و داشبورد، روز تقویمی
                شعبه (نیمه‌شب تا نیمه‌شب) است.
              </p>
            )}
          </div>

          {canConfigure ? (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">ساعت شروع روز کاری</span>
                  <input
                    className={inputClass + " w-full tabular-nums sm:w-36"}
                    dir="ltr"
                    type="time"
                    step={60}
                    required
                    value={startTime}
                    disabled={busy}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={save}
                    disabled={busy || (status.enabled && !dirty)}
                    className="min-w-0 flex-1 sm:flex-none"
                  >
                    {busy
                      ? "در حال ذخیره…"
                      : status.enabled
                        ? "ذخیرهٔ ساعت شروع"
                        : "فعال‌سازی روز کاری"}
                  </Button>
                  {status.enabled ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={disable}
                      disabled={busy}
                      className="min-w-0 flex-1 sm:flex-none"
                    >
                      غیرفعال‌کردن
                    </Button>
                  ) : null}
                </div>
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                تغییر ساعت شروع، گزارش‌های گذشته را هم بر همین مبنا دسته‌بندی
                می‌کند؛ هیچ سفارشی حذف یا جابه‌جا نمی‌شود.
              </p>
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
              تغییر ساعت شروع روز کاری به مجوز «مدیریت تنظیمات» نیاز دارد. شما
              این بخش را فقط می‌بینید.
            </p>
          )}

          {status.enabled && canClose ? (
            <div className="mt-6 border-t border-border/80 pt-5">
              <h3 className="mb-1 text-sm font-semibold">بستن دستی روز کاری</h3>
              <p className="mb-3 text-xs leading-6 text-muted-foreground">
                معمولاً به این دکمه نیازی نیست: وقتی صندوق‌دار شیفتش را می‌بندد
                و کسی دیگر در شعبه شیفت باز ندارد، همان بستن شیفت پایانِ کار شب
                حساب می‌شود و داشبورد و فهرست سفارش‌ها خودبه‌خود برای شیفت بعد
                صفر می‌شوند. این دکمه برای شعبه‌ای است که کارکنانش شیفت ثبت
                نمی‌کنند. در هر دو حالت گزارش‌ها دست‌نخورده می‌مانند و هر فروشی
                در روز کاری خودش باقی است.
              </p>
              {status.manuallyClosed ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => reopenDay()}
                  disabled={busy}
                  className="w-full sm:w-auto"
                >
                  بازکردن دوبارهٔ روز کاری
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={closeDay}
                  disabled={busy}
                  className="w-full sm:w-auto"
                >
                  بستن روز کاری
                </Button>
              )}

              {closures.length > 0 ? (
                <div className="mt-4 space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    بسته‌شدن‌های اخیر
                  </p>
                  <ul className="space-y-1.5">
                    {closures.map((closure) => (
                      <li
                        key={closure.id}
                        className="flex flex-wrap items-start justify-between gap-2 text-xs break-words text-muted-foreground"
                      >
                        <span className="min-w-0">
                          روز {formatDate(closure.businessDate)} — بسته‌شده در{" "}
                          {formatMoment(closure.closedAt)}
                          {closure.closedByName ? ` توسط ${closure.closedByName}` : ""}
                          {closure.note ? ` — ${closure.note}` : ""}
                          {closure.reopenedAt ? (
                            <span className="ms-1 text-muted-foreground/80">
                              (بازگشایی‌شده در {formatMoment(closure.reopenedAt)}
                              {closure.reopenedByName ? ` توسط ${closure.reopenedByName}` : ""})
                            </span>
                          ) : null}
                        </span>
                        {!closure.reopenedAt && canClose ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => reopenDay(closure.id)}
                          >
                            بازگشایی همین بسته‌شدن
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}
