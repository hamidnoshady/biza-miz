"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { api, errorMessage, Field, InfoBox, inputClass } from "../ui";
import { LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { toPersianDigits } from "@/lib/digits";
import {
  KITCHEN_SOUND_EVENT_KEYS,
  KITCHEN_SOUND_EVENT_LABELS,
  KITCHEN_ALERT_MAX_MINUTES,
  KITCHEN_ALERT_MIN_MINUTES,
  type KitchenAlertThresholds,
  type KitchenSoundEventKey,
  type KitchenSoundPreferences,
} from "@/lib/kitchen-alerts";
import {
  type NotificationChannel,
  type NotificationEventKey,
} from "@/lib/notifications";
import { DEFAULT_TICKET_AGING_MINUTES } from "@/lib/order-item-status";

const KITCHEN_EVENT_KEYS: NotificationEventKey[] = [
  "kitchen.ticket_created",
  "kitchen.items_added",
  "kitchen.ticket_aged",
];

interface RuleEvent {
  key: NotificationEventKey;
  label: string;
  description: string;
}

interface RulePreference {
  eventKey: NotificationEventKey;
  enabled: boolean;
  channels: NotificationChannel[];
  isDefault: boolean;
}

interface RulesResponse {
  events?: RuleEvent[];
  preferences?: RulePreference[];
  error?: string;
}

interface ThresholdFormResult {
  ok: boolean;
  error?: string;
}

/**
 * «اعلان‌ها و صدای آشپزخانه» — one panel, three deliberately separate
 * concerns, because conflating them is how a restaurant ends up with a
 * hard-coded mini notification system:
 *
 *   اعلان‌ها  → the shared `/settings/notifications` rules (bell + push),
 *               scoped by role/branch and enforced by the notification engine.
 *   صدا       → this browser only. Opt-in, permission-safe, never autoplayed.
 *   چاپ       → the shared print-behaviour policy; the worker already respects
 *               its `notifications: all|failures|off` setting.
 */
export function KitchenAlertSettings({
  canEditThresholds,
  thresholds,
  thresholdsWarning,
  soundPreferences,
  soundBlocked,
  audioReady,
  onToggleSound,
  onToggleSoundEvent,
  onTestSound,
  onSaveThresholds,
}: {
  canEditThresholds: boolean;
  thresholds: KitchenAlertThresholds;
  thresholdsWarning: string | null;
  soundPreferences: KitchenSoundPreferences;
  soundBlocked: boolean;
  audioReady: boolean;
  onToggleSound: () => void;
  onToggleSoundEvent: (event: KitchenSoundEventKey) => void;
  onTestSound: () => void;
  onSaveThresholds: (thresholds: KitchenAlertThresholds) => Promise<ThresholdFormResult>;
}) {
  const [rules, setRules] = useState<RulesResponse | null>(null);
  const [rulesError, setRulesError] = useState("");
  const [approaching, setApproaching] = useState(
    thresholds.approachingMinutes === null ? "" : String(thresholds.approachingMinutes),
  );
  const [overdue, setOverdue] = useState(String(thresholds.overdueMinutes));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  useEffect(() => {
    setApproaching(thresholds.approachingMinutes === null ? "" : String(thresholds.approachingMinutes));
    setOverdue(String(thresholds.overdueMinutes));
  }, [thresholds]);

  useEffect(() => {
    const controller = new AbortController();
    void api<RulesResponse>("/api/notifications/rules", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setRules(result.data);
      else setRulesError(errorMessage(result.data.error));
    }).catch(() => {
      if (!controller.signal.aborted) setRulesError("وضعیت قواعد اعلان خوانده نشد.");
    });
    return () => controller.abort();
  }, []);

  const rulesByKey = useMemo(() => {
    const map = new Map<NotificationEventKey, { event: RuleEvent; preference: RulePreference | null }>();
    for (const event of rules?.events ?? []) {
      if (!KITCHEN_EVENT_KEYS.includes(event.key)) continue;
      map.set(event.key, {
        event,
        preference: rules?.preferences?.find((item) => item.eventKey === event.key) ?? null,
      });
    }
    return map;
  }, [rules]);

  const overdueNumber = overdue === "" ? Number.NaN : Number(overdue);
  const approachingNumber = approaching === "" ? null : Number(approaching);
  const validNumbers =
    Number.isInteger(overdueNumber) &&
    overdueNumber >= KITCHEN_ALERT_MIN_MINUTES &&
    overdueNumber <= KITCHEN_ALERT_MAX_MINUTES &&
    (approachingNumber === null ||
      (Number.isInteger(approachingNumber) &&
        approachingNumber >= KITCHEN_ALERT_MIN_MINUTES &&
        approachingNumber < overdueNumber));

  async function saveThresholds() {
    if (!validNumbers) return;
    setSaving(true);
    setSaveError("");
    setSaveNotice("");
    try {
      const result = await onSaveThresholds({
        approachingMinutes: approachingNumber,
        overdueMinutes: overdueNumber,
      });
      if (!result.ok) {
        setSaveError(result.error || "ذخیرهٔ آستانه‌ها انجام نشد.");
        return;
      }
      setSaveNotice("آستانه‌های این شعبه ذخیره شد.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="اعلان‌ها، صدا و چاپ آشپزخانه"
      description="این سه با هم یکی نیستند: اعلان‌ها از قواعد مشترک بیزامیز می‌آیند، صدا فقط روی همین دستگاه است، و چاپ سیاست چاپ همین شعبه را دنبال می‌کند."
    >
      <div className="space-y-5">
        <section aria-labelledby="kitchen-alert-rules" className="space-y-3">
          <div>
            <h3 id="kitchen-alert-rules" className="font-semibold text-foreground">
              اعلان‌های داخل برنامه و Push
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              این رویدادها در «تنظیمات ← اعلان‌ها» زیر دستهٔ «سفارش و کار روزانه» هستند و
              نقش، شعبه، دستگاه و ساعت سکوت شما را رعایت می‌کنند. هیچ نقشی به‌صورت
              پیش‌فرض این اعلان‌ها را دریافت نمی‌کند؛ وضعیت ارسال ناموفق هر دستگاه هم در
              همان صفحه دیده می‌شود.
            </p>
          </div>
          {rulesError ? <p role="alert" className="text-sm text-destructive">{rulesError}</p> : null}
          {!rules && !rulesError ? <LoadingSkeleton rows={2} /> : null}
          {rules ? (
            <ul className="divide-y divide-border rounded-xl border border-border/80">
              {KITCHEN_EVENT_KEYS.map((key) => {
                const entry = rulesByKey.get(key);
                if (!entry) {
                  return (
                    <li key={key} className="px-3 py-3 text-sm text-muted-foreground">
                      این اعلان برای نقش شما در دسترس نیست.
                    </li>
                  );
                }
                const { event, preference } = entry;
                return (
                  <li key={key} className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                        {event.label}
                        {preference?.enabled ? (
                          <StatusBadge tone="positive">روشن</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">خاموش</StatusBadge>
                        )}
                        {preference?.isDefault ? <StatusBadge>پیش‌فرض</StatusBadge> : null}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{event.description}</p>
                      {preference?.enabled && preference.channels.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          کانال‌ها: {preference.channels.map((channel) =>
                            channel === "push" ? "اعلان دستگاه" : "زنگولهٔ برنامه",
                          ).join("، ")}
                        </p>
                      ) : null}
                    </div>
                    <Link
                      href="/settings/notifications"
                      className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      تنظیم در اعلان‌ها
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <section aria-labelledby="kitchen-alert-sound" className="space-y-3 border-t border-border pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="kitchen-alert-sound" className="font-semibold text-foreground">
                صدای این دستگاه
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                صدا به‌صورت پیش‌فرض خاموش است و فقط با انتخاب شما روشن می‌شود. اگر مرورگر
                پخش خودکار را مسدود کند، هشدارهای بصری همچنان نمایش داده می‌شوند.
              </p>
            </div>
            <Button
              type="button"
              variant={soundPreferences.enabled ? "outline" : "default"}
              aria-pressed={soundPreferences.enabled}
              onClick={onToggleSound}
              className="min-h-[44px]"
            >
              {soundPreferences.enabled
                ? audioReady ? "خاموش کردن صدا" : "فعال‌سازی صدای این دستگاه"
                : "روشن کردن صدا"}
            </Button>
          </div>
          {soundBlocked ? (
            <p
              role="alert"
              className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200"
            >
              پخش صدا در این مرورگر مسدود شده است. هشدارهای بصری فعال‌اند؛ برای تلاش دوباره
              دکمهٔ «روشن کردن صدا» را بزنید.
            </p>
          ) : null}
          <fieldset className="space-y-2" disabled={!soundPreferences.enabled}>
            <legend className="text-sm font-semibold text-foreground/80">کدام رویدادها صدا داشته باشند</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {KITCHEN_SOUND_EVENT_KEYS.map((key) => (
                <label key={key} className="flex min-h-[44px] items-center gap-2 rounded-lg border border-border/80 px-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-amber-600 dark:accent-amber-400"
                    checked={soundPreferences.events[key]}
                    onChange={() => onToggleSoundEvent(key)}
                  />
                  {KITCHEN_SOUND_EVENT_LABELS[key]}
                </label>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={!soundPreferences.enabled}
              onClick={onTestSound}
            >
              پخش آزمایشی صدا
            </Button>
          </fieldset>
        </section>

        <section aria-labelledby="kitchen-alert-aging" className="space-y-3 border-t border-border pt-5">
          <div>
            <h3 id="kitchen-alert-aging" className="font-semibold text-foreground">
              آستانه‌های سن سفارش این شعبه
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              سن از زمان ثبت‌شدهٔ ارسال به آشپزخانه محاسبه می‌شود. آستانهٔ تأخیر پیش‌فرض
              {" "}{toPersianDigits(DEFAULT_TICKET_AGING_MINUTES)} دقیقه است؛ آستانهٔ نزدیک‌شدن
              اختیاری است و تا وقتی تنظیم نشود هشداری برای آن ساخته نمی‌شود.
            </p>
          </div>
          {thresholdsWarning ? <InfoBox>{thresholdsWarning}</InfoBox> : null}
          {canEditThresholds ? (
            <div className="grid gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))_auto] sm:items-end">
              <Field label="آستانهٔ تأخیر (دقیقه)">
                <PersianNumberInput
                  className={inputClass}
                  inputMode="numeric"
                  min={KITCHEN_ALERT_MIN_MINUTES}
                  max={KITCHEN_ALERT_MAX_MINUTES}
                  value={overdue}
                  disabled={saving}
                  onChange={(event) => setOverdue(event.currentTarget.value)}
                />
              </Field>
              <Field label="آستانهٔ نزدیک‌شدن (دقیقه؛ خالی = خاموش)">
                <PersianNumberInput
                  className={inputClass}
                  inputMode="numeric"
                  min={KITCHEN_ALERT_MIN_MINUTES}
                  max={KITCHEN_ALERT_MAX_MINUTES - 1}
                  placeholder="خاموش"
                  value={approaching}
                  disabled={saving}
                  onChange={(event) => setApproaching(event.currentTarget.value)}
                />
              </Field>
              <Button
                type="button"
                className="min-h-[44px]"
                disabled={saving || !validNumbers}
                onClick={() => void saveThresholds()}
              >
                {saving ? "در حال ذخیره…" : "ذخیرهٔ آستانه‌ها"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-foreground/80">
              آستانهٔ تأخیر این شعبه: {toPersianDigits(thresholds.overdueMinutes)} دقیقه
              {thresholds.approachingMinutes === null
                ? ""
                : ` · آستانهٔ نزدیک‌شدن: ${toPersianDigits(thresholds.approachingMinutes)} دقیقه`}
              . برای تغییر، از مدیر یا مالک بخواهید.
            </p>
          )}
          {!validNumbers ? (
            <p role="alert" className="text-sm text-destructive">
              آستانهٔ تأخیر باید بین {toPersianDigits(KITCHEN_ALERT_MIN_MINUTES)} و{" "}
              {toPersianDigits(KITCHEN_ALERT_MAX_MINUTES)} دقیقه باشد و آستانهٔ نزدیک‌شدن
              کمتر از آن.
            </p>
          ) : null}
          {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}
          {saveNotice ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{saveNotice}</p> : null}
        </section>

        <section aria-labelledby="kitchen-alert-print" className="space-y-2 border-t border-border pt-5">
          <h3 id="kitchen-alert-print" className="font-semibold text-foreground">
            چاپ آشپزخانه
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            خطاهای ارسال به چاپگر از سیاست مشترک چاپ پیروی می‌کنند: «همه»، «فقط خطاها» یا
            «خاموش». روشن‌بودن چاپ خودکار و اعلان خطا در تنظیمات چاپ همین شعبه تعیین می‌شود.
          </p>
          {canEditThresholds ? (
            <Link
              href="/settings/printers"
              className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              تنظیمات چاپ و اعلان خطا
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">تغییر سیاست چاپ نیازمند دسترسی تنظیمات است.</p>
          )}
        </section>
      </div>
    </SectionCard>
  );
}
