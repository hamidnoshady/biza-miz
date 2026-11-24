"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import {
  KITCHEN_ALERT_MAX_MINUTES,
  KITCHEN_ALERT_MIN_MINUTES,
  KITCHEN_ALERT_TONE_FREQUENCY,
  KITCHEN_SOUND_EVENT_KEYS,
  KITCHEN_SOUND_EVENT_LABELS,
  parseKitchenAlertThresholds,
  type KitchenAlertThresholds,
  type KitchenSoundEventKey,
  type KitchenSoundPreferences,
} from "@/lib/kitchen-alerts";
import {
  readKitchenSoundPreferences,
  subscribeKitchenSoundPreferences,
  writeKitchenSoundPreferences,
} from "@/lib/kitchen-sound-store";
import { DEFAULT_TICKET_AGING_MINUTES } from "@/lib/order-item-status";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { Field, api, inputClass } from "@/app/dashboard/ui";

interface ThresholdsResponse {
  thresholds?: unknown;
  canEdit?: boolean;
  error?: string;
}

/**
 * «اعلان‌ها و صدای آشپزخانه» — the kitchen section of /settings/notifications.
 *
 * Three deliberately separate concerns, because conflating them is how a
 * restaurant ends up with a hard-coded mini notification system:
 *
 *   اعلان‌ها  → already configured above, in this tab's own rule cards
 *               (`kitchen.*` events, «شیفت و روز کاری» group).
 *   صدا       → this browser only. Opt-in, permission-safe, never autoplayed.
 *   آستانه‌ها  → the branch's preparation-age policy, editable by a manager.
 *
 * The kitchen board keeps only its runtime sound switch; everything the
 * operator configures once lives here, and both screens read the same
 * device-local store (`kitchen-sound-store.ts`).
 */
export function KitchenNotificationSettings() {
  const [soundPreferences, setSoundPreferences] = useState<KitchenSoundPreferences>(
    () => readKitchenSoundPreferences(),
  );
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const audioContext = useRef<AudioContext | null>(null);

  const [thresholds, setThresholds] = useState<KitchenAlertThresholds | null>(null);
  const [canEditThresholds, setCanEditThresholds] = useState(false);
  const [thresholdsUnavailable, setThresholdsUnavailable] = useState(false);
  const [approaching, setApproaching] = useState("");
  const [overdue, setOverdue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  // Another surface on this device (the KDS board's master switch, or another
  // tab) may write while this panel is open; follow the store either way.
  useEffect(() => subscribeKitchenSoundPreferences(setSoundPreferences), []);

  useEffect(() => {
    return () => {
      void audioContext.current?.close().catch(() => {});
    };
  }, []);

  // The thresholds are a branch read. A member without kitchen view (or a
  // business without the kitchen module) cannot read them: the section draws
  // nothing rather than an error card, since none of it would apply.
  useEffect(() => {
    let cancelled = false;
    void api<ThresholdsResponse>("/api/kitchen/alerts")
      .then(({ ok, data }) => {
        if (cancelled) return;
        const parsed = ok ? parseKitchenAlertThresholds(data.thresholds) : null;
        if (!parsed) {
          setThresholdsUnavailable(true);
          return;
        }
        setThresholds(parsed);
        setApproaching(parsed.approachingMinutes === null ? "" : String(parsed.approachingMinutes));
        setOverdue(String(parsed.overdueMinutes));
        setCanEditThresholds(data.canEdit === true);
      })
      .catch(() => {
        if (!cancelled) setThresholdsUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Create/resume the audio context only from a user gesture (or after the
   * operator has already opted in). A denied/suspended context is a visible
   * state, not a silent failure.
   */
  async function ensureAudio(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    const AudioCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) {
      setSoundBlocked(true);
      setAudioReady(false);
      return false;
    }
    try {
      let context = audioContext.current;
      if (!context || context.state === "closed") {
        context = new AudioCtor();
        audioContext.current = context;
      }
      if (context.state === "suspended") await context.resume();
      if (context.state !== "running") {
        setSoundBlocked(true);
        setAudioReady(false);
        return false;
      }
      setAudioReady(true);
      setSoundBlocked(false);
      return true;
    } catch {
      setSoundBlocked(true);
      setAudioReady(false);
      return false;
    }
  }

  function playTone(event: KitchenSoundEventKey): boolean {
    const context = audioContext.current;
    if (!context || context.state !== "running") return false;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = KITCHEN_ALERT_TONE_FREQUENCY[event];
      gain.gain.value = 0.04;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.16);
      return true;
    } catch {
      // Browser audio policy/device failures must never block the settings.
      return false;
    }
  }

  /**
   * The one write path of this panel — the KDS board reads the same store, so
   * a change here reaches an already-open board without a reload.
   */
  function persistSoundPreferences(next: KitchenSoundPreferences) {
    setSoundPreferences(next);
    writeKitchenSoundPreferences(next);
  }

  async function toggleSound() {
    if (soundPreferences.enabled && audioReady) {
      persistSoundPreferences({ ...soundPreferences, enabled: false });
      void audioContext.current?.close().catch(() => {});
      audioContext.current = null;
      setAudioReady(false);
      setSoundBlocked(false);
      return;
    }
    const ready = await ensureAudio();
    if (!ready) {
      persistSoundPreferences({ ...soundPreferences, enabled: false });
      return;
    }
    persistSoundPreferences({ ...soundPreferences, enabled: true });
    playTone("newTicket");
  }

  function toggleSoundEvent(event: KitchenSoundEventKey) {
    persistSoundPreferences({
      ...soundPreferences,
      events: { ...soundPreferences.events, [event]: !soundPreferences.events[event] },
    });
  }

  async function testSound() {
    if (!(await ensureAudio())) return;
    playTone("newTicket");
  }

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
      const next: KitchenAlertThresholds = {
        approachingMinutes: approachingNumber,
        overdueMinutes: overdueNumber,
      };
      const result = await api<ThresholdsResponse>("/api/kitchen/alerts", {
        method: "PUT",
        body: JSON.stringify({ thresholds: next }),
      });
      if (!result.ok) {
        setSaveError("ذخیرهٔ آستانه‌ها انجام نشد.");
        return;
      }
      setThresholds(next);
      setSaveNotice("آستانه‌های این شعبه ذخیره شد.");
    } finally {
      setSaving(false);
    }
  }

  // No kitchen read, no kitchen section — the rest of the tab stays useful.
  if (thresholdsUnavailable && thresholds === null) return null;

  return (
    <SectionCard
      title="اعلان‌ها و صدای آشپزخانه"
      description="اعلان‌های آشپزخانه در همین صفحه، زیر دستهٔ «شیفت و روز کاری» تنظیم می‌شوند؛ صدای هشدار مال همین دستگاه است و آستانهٔ تأخیر، سیاست کل شعبه."
    >
      <div className="space-y-5">
        <section aria-labelledby="kitchen-settings-sound" className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="kitchen-settings-sound" className="font-semibold text-foreground">
                صدای این دستگاه
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                صدا به‌صورت پیش‌فرض خاموش است و فقط با انتخاب شما روشن می‌شود. اگر مرورگر
                پخش خودکار را مسدود کند، هشدارهای بصری صفحهٔ آشپزخانه همچنان نمایش داده
                می‌شوند. کلید سریع روی خود صفحهٔ آشپزخانه هم هست.
              </p>
            </div>
            <Button
              type="button"
              variant={soundPreferences.enabled ? "outline" : "default"}
              aria-pressed={soundPreferences.enabled}
              onClick={() => void toggleSound()}
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
                    onChange={() => toggleSoundEvent(key)}
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
              onClick={() => void testSound()}
            >
              پخش آزمایشی صدا
            </Button>
          </fieldset>
        </section>

        <section aria-labelledby="kitchen-settings-aging" className="space-y-3 border-t border-border pt-5">
          <div>
            <h3 id="kitchen-settings-aging" className="font-semibold text-foreground">
              آستانه‌های سن سفارش این شعبه
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              سن از زمان ثبت‌شدهٔ ارسال به آشپزخانه محاسبه می‌شود. آستانهٔ تأخیر پیش‌فرض
              {" "}{toPersianDigits(DEFAULT_TICKET_AGING_MINUTES)} دقیقه است؛ آستانهٔ نزدیک‌شدن
              اختیاری است و تا وقتی تنظیم نشود هشداری برای آن ساخته نمی‌شود.
            </p>
          </div>
          {thresholds === null ? (
            <div role="status" className="ops-skeleton h-16 rounded-xl" />
          ) : null}
          {thresholds !== null && canEditThresholds ? (
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
          ) : null}
          {thresholds !== null && !canEditThresholds ? (
            <p className="text-sm text-foreground/80">
              آستانهٔ تأخیر این شعبه: {toPersianDigits(thresholds.overdueMinutes)} دقیقه
              {thresholds.approachingMinutes === null
                ? ""
                : ` · آستانهٔ نزدیک‌شدن: ${toPersianDigits(thresholds.approachingMinutes)} دقیقه`}
              . برای تغییر، از مدیر یا مالک بخواهید.
            </p>
          ) : null}
          {validNumbers ? null : (
            <p role="alert" className="text-sm text-destructive">
              آستانهٔ تأخیر باید بین {toPersianDigits(KITCHEN_ALERT_MIN_MINUTES)} و{" "}
              {toPersianDigits(KITCHEN_ALERT_MAX_MINUTES)} دقیقه باشد و آستانهٔ نزدیک‌شدن
              کمتر از آن.
            </p>
          )}
          {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}
          {saveNotice ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{saveNotice}</p> : null}
        </section>

        <section aria-labelledby="kitchen-settings-print" className="space-y-2 border-t border-border pt-5">
          <h3 id="kitchen-settings-print" className="font-semibold text-foreground">
            چاپ آشپزخانه
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            خطاهای ارسال به چاپگر از سیاست مشترک چاپ پیروی می‌کنند: «همه»، «فقط خطاها» یا
            «خاموش». روشن‌بودن چاپ خودکار و اعلان خطا در تنظیمات چاپ همین شعبه تعیین می‌شود.
          </p>
          <Link
            href="/settings/printers"
            className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            تنظیمات چاپ و اعلان خطا
          </Link>
        </section>
      </div>
    </SectionCard>
  );
}
