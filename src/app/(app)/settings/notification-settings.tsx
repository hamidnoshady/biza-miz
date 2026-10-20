"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_GROUP_LABELS,
  type NotificationChannel,
  type NotificationEventKey,
  type NotificationGroup,
  type NotificationSeverity,
} from "@/lib/notifications";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { currentSubscriptionEndpoint, disablePush, enablePush, pushSupport } from "./push-client";
import { useNative } from "@/components/native/native-provider";
import { registerNativePushNotifications } from "@/lib/native/capabilities-client";

interface EventMeta {
  key: NotificationEventKey;
  group: NotificationGroup;
  label: string;
  description: string;
  defaultSeverity: NotificationSeverity;
  hasAmount: boolean;
}

interface Preference {
  eventKey: NotificationEventKey;
  ruleId: string | null;
  isDefault: boolean;
  enabled: boolean;
  channels: NotificationChannel[];
  minSeverity: NotificationSeverity;
  minAmountRial: number | null;
  quietFromMinutes: number | null;
  quietToMinutes: number | null;
}

interface RulesResponse {
  events: EventMeta[];
  preferences: Preference[];
  locations: { id: string; name: string }[];
  error?: string;
}

interface DeviceRow {
  id: string;
  endpoint: string;
  disabledAt: string | null;
  platform: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  lastError: string | null;
}

/** Minutes past midnight ⇄ the `HH:MM` an `<input type="time">` speaks. */
function minutesToTime(minutes: number | null): string {
  if (minutes === null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number | null {
  const [hour, minute] = toLatinDigits(value).split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

/** Rial in the database, Toman in the box — the storage convention, both ways. */
function rialToTomanInput(rial: number | null): string {
  return rial === null ? "" : String(Math.round(rial / 10));
}

function tomanInputToRial(value: string): { ok: true; rial: number | null } | { ok: false } {
  const trimmed = toLatinDigits(value)
    .replace(/[,٬\s]/g, "")
    .trim();
  if (trimmed === "") return { ok: true, rial: null };
  const toman = Number(trimmed);
  if (!Number.isFinite(toman) || toman < 0 || !Number.isSafeInteger(toman * 10))
    return { ok: false };
  return { ok: true, rial: toman * 10 };
}

/**
 * «اعلان‌ها» — the settings tab where a member decides what reaches their own
 * phone.
 *
 * Two halves that are genuinely different things, which is why they are two
 * cards rather than one list: **devices** are per browser (this iPhone, that
 * till PC) and **rules** are per person (whatever I am reading this on). A
 * member who turns an event off has turned it off everywhere; a member who
 * removes a device has only stopped that one screen.
 *
 * Every row starts from the catalogue default rather than from "off", and says
 * so with a «پیش‌فرض» badge — so the screen is honest about the fact that
 * notifications already work, rather than presenting an empty form that implies
 * nothing is happening.
 */
export function NotificationSettings() {
  const [events, setEvents] = useState<EventMeta[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [stats, setStats] = useState<{ status: string; count: number; throttled: number }[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [support, setSupport] = useState<ReturnType<typeof pushSupport> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, string>>({});
  const saves = useRef(new Map<string, Promise<void>>());
  const versions = useRef(new Map<string, number>());
  const scopeGeneration = useRef(0);
  const [scope, setScope] = useState("");
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [delivery, setDelivery] = useState({ mode: "digest", timezone: "", digest_minutes: 5 });
  const native = useNative();
  const isAndroidTwa = native.kind === "android-twa";

  async function enableAndroidNativePush() {
    if (native.kind !== "android-twa" || native.connection !== "connected" || !native.app) {
      setError("ارتباط با لایهٔ بومی اندروید برقرار نیست.");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const [identity, res] = await Promise.all([
        native.request("device.identity"),
        registerNativePushNotifications(native.request),
      ]);
      if (res.permission !== "granted" || !res.fcmToken) {
        setBusy(false);
        setError(
          res.permission === "denied"
            ? "مجوز ارسال اعلان در تنظیمات اندروید رد شده است."
            : "ثبت اعلان بومی اندروید انجام نشد.",
        );
        return;
      }
      await api("/api/native-devices", {
        method: "POST",
        body: JSON.stringify({
          installationId: identity.installationId,
          environment: native.app.environment,
          appVersionName: native.app.appVersionName,
          appVersionCode: native.app.appVersionCode,
          bridgeVersion: native.app.bridgeVersion,
          pushToken: res.fcmToken,
          pushProvider: res.pushProvider,
          pushChannels: res.channels,
        }),
      });
      setBusy(false);
      setInfo("اعلان‌های بومی اندروید (FCM) برای این دستگاه فعال شد.");
    } catch {
      setBusy(false);
      setError("ثبت اعلان بومی اندروید انجام نشد.");
    }
  }

  const load = useCallback(async () => {
    const [rules, deviceList] = await Promise.all([
      api<RulesResponse>(`/api/notifications/rules${scope ? `?locationId=${scope}` : ""}`),
      api<{
        devices: DeviceRow[];
        stats: { status: string; count: number; throttled: number }[];
        error?: string;
      }>("/api/notifications/devices"),
    ]);
    if (rules.ok) {
      setLocations(rules.data.locations);
      setEvents(rules.data.events);
      setPreferences(rules.data.preferences);
    } else {
      setError(errorMessage(rules.data.error));
    }
    if (deviceList.ok) {
      setDevices(deviceList.data.devices);
      setStats(deviceList.data.stats ?? []);
    }
    setLoading(false);
  }, [scope]);

  useEffect(() => {
    setSupport(pushSupport());
    void currentSubscriptionEndpoint()
      .then(setThisEndpoint)
      .catch(() => setError("بررسی وضعیت دستگاه ناموفق بود."));
    void load().catch(() => {
      setError("دریافت تنظیمات ناموفق بود.");
      setLoading(false);
    });
    void api<typeof delivery>("/api/notifications/preferences").then((res) => {
      if (res.ok) setDelivery({ ...res.data, timezone: res.data.timezone || "" });
    });
  }, [load]);

  function savePreference(next: Preference) {
    const generation = scopeGeneration.current;
    const key = next.eventKey;
    const version = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, version);
    const isLatest = () =>
      generation === scopeGeneration.current && versions.current.get(key) === version;
    setError("");
    setInfo("");
    setSaveStates((current) => ({ ...current, [key]: "در حال ذخیره…" }));
    setPreferences((current) => current.map((item) => (item.eventKey === key ? next : item)));
    const work = (saves.current.get(key) ?? Promise.resolve())
      .then(async () => {
        const result = await api<{ rule?: { id: string }; messages?: string[]; error?: string }>(
          "/api/notifications/rules",
          {
            method: "POST",
            body: JSON.stringify({ ...next, locationId: scope || null }),
          },
        );
        if (!result.ok)
          throw new Error(result.data.messages?.[0] ?? errorMessage(result.data.error));
        if (!isLatest()) return;
        setPreferences((current) =>
          current.map((item) =>
            item.eventKey === key
              ? { ...next, ruleId: result.data.rule?.id ?? null, isDefault: false }
              : item,
          ),
        );
        setSaveStates((current) => ({ ...current, [key]: "ذخیره شد" }));
      })
      .catch((err: unknown) => {
        if (!isLatest()) return;
        setError(err instanceof Error ? err.message : "ذخیره ناموفق بود؛ دوباره تلاش کنید.");
        setSaveStates((current) => ({ ...current, [key]: "ذخیره نشد — دوباره تلاش کنید" }));
        // Keep drafts (especially the amount) on failure. Reconcile just this
        // rule, never reload over another event's optimistic changes.
        void api<RulesResponse>(
          `/api/notifications/rules${scope ? `?locationId=${scope}` : ""}`,
        ).then((res) => {
          if (res.ok && isLatest())
            setPreferences((current) =>
              current.map((item) =>
                item.eventKey === key
                  ? (res.data.preferences.find((p) => p.eventKey === key) ?? item)
                  : item,
              ),
            );
        });
      })
      .finally(() => {
        if (isLatest()) saves.current.delete(key);
      });
    saves.current.set(key, work);
    return work;
  }

  async function saveDelivery() {
    setBusy(true);
    setError("");
    try {
      const result = await api<typeof delivery>("/api/notifications/preferences", {
        method: "POST",
        body: JSON.stringify({ ...delivery, timezone: delivery.timezone || null }),
      });
      if (!result.ok) throw new Error("ذخیره تنظیمات ارسال ناموفق بود؛ منطقه زمانی را بررسی کنید.");
      setDelivery({ ...result.data, timezone: result.data.timezone || "" });
      setInfo("تنظیمات ارسال ذخیره شد.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ذخیره ناموفق بود.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPreference(preference: Preference) {
    if (!preference.ruleId) return;
    setBusy(true);
    try {
      setError("");
      const { ok, data } = await api<{ error?: string }>(
        `/api/notifications/rules/${preference.ruleId}`,
        { method: "DELETE" },
      );
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setInfo("این اعلان به حالت پیش‌فرض برگشت.");
      await load();
    } catch {
      setError("بازگشت به پیش‌فرض ناموفق بود.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleThisDevice() {
    setBusy(true);
    try {
      setBusy(true);
      setError("");
      setInfo("");
      if (thisEndpoint && devices.some((d) => d.endpoint === thisEndpoint && !d.disabledAt)) {
        await disablePush();
        setThisEndpoint(null);
        setInfo("این دستگاه دیگر اعلان دریافت نمی‌کند.");
      } else {
        const result = await enablePush();
        if (!result.ok) setError(result.message);
        else {
          setThisEndpoint(await currentSubscriptionEndpoint());
          setInfo("این دستگاه برای دریافت اعلان ثبت شد.");
        }
      }
      await load();
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "عملیات دستگاه ناموفق بود؛ دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(id: string) {
    setBusy(true);
    try {
      setError("");
      const { ok, data } = await api<{ error?: string }>(`/api/notifications/devices/${id}`, {
        method: "DELETE",
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      // Also unsubscribe this browser when its own row is removed. Deleting only
      // the server row would leave the browser subscribed and the toggle lying.
      if (devices.find((device) => device.id === id)?.endpoint === thisEndpoint) {
        await disablePush();
      }
      setThisEndpoint(await currentSubscriptionEndpoint());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "عملیات دستگاه ناموفق بود؛ دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    try {
      setBusy(true);
      setError("");
      setInfo("");
      const { ok, data } = await api<{ message?: string; sent?: number; error?: string }>(
        "/api/notifications/test",
        { method: "POST" },
      );
      setBusy(false);
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      if (data.sent && data.sent > 0) setInfo(data.message ?? "");
      else setError(data.message ?? "ارسال اعلان آزمایشی موفق نبود.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ارسال آزمایشی ناموفق بود.");
    } finally {
      setBusy(false);
    }
  }

  const activeHere =
    !!thisEndpoint && devices.some((d) => d.endpoint === thisEndpoint && !d.disabledAt);

  if (loading) return <LoadingSkeleton rows={3} />;

  const grouped = new Map<NotificationGroup, EventMeta[]>();
  for (const event of events) {
    grouped.set(event.group, [...(grouped.get(event.group) ?? []), event]);
  }
  const preferenceFor = (key: NotificationEventKey) =>
    preferences.find((item) => item.eventKey === key);

  return (
    <div className="space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              سخت‌افزار و مرورگر
            </p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">
              دستگاه‌های دریافت اعلان
            </h2>
          </div>
        }
        description="اعلان‌ها روی گوشی و رایانه — حتی وقتی برنامه بسته است — به هر دستگاهی می‌رسد که اینجا ثبت شده باشد."
        actions={
          <div className="flex flex-wrap gap-2">
            {isAndroidTwa ? (
              <Button
                type="button"
                variant="default"
                onClick={() => void enableAndroidNativePush()}
                disabled={busy}
              >
                فعال‌سازی اعلان بومی اندروید
              </Button>
            ) : null}
            <Button
              type="button"
              variant={activeHere ? "outline" : "default"}
              onClick={() => void toggleThisDevice()}
              disabled={busy || (support !== null && !support.supported)}
            >
              {activeHere ? "غیرفعال کردن روی این دستگاه" : "فعال کردن روی این دستگاه"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void sendTest()}
              disabled={busy || devices.length === 0}
            >
              ارسال اعلان آزمایشی
            </Button>
          </div>
        }
      >
        {support && !support.supported ? (
          // The iOS case is the one that matters: Safari does not expose
          // PushManager outside an installed PWA and gives no error, so without
          // this the button would simply do nothing forever.
          <InfoBox>{support.message}</InfoBox>
        ) : null}

        <p className="text-xs text-muted-foreground" role="status">
          صف:{" "}
          {toPersianDigits(
            stats.filter((s) => s.status === "queued").reduce((a, s) => a + s.count, 0),
          )}{" "}
          · پذیرفته‌شده توسط سرویس:{" "}
          {toPersianDigits(
            stats.filter((s) => s.status === "sent").reduce((a, s) => a + s.count, 0),
          )}{" "}
          · ناموفق:{" "}
          {toPersianDigits(
            stats.filter((s) => s.status === "failed").reduce((a, s) => a + s.count, 0),
          )}{" "}
          · محدودشده در صف: {toPersianDigits(stats.reduce((a, s) => a + s.throttled, 0))}
        </p>
        {devices.length === 0 ? (
          <EmptyState>
            هنوز هیچ دستگاهی ثبت نشده است. روی همین دستگاه «فعال کردن» را بزنید، و همین کار را روی
            گوشی خودتان هم انجام دهید.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    {device.label || "دستگاه"}
                    {device.disabledAt ? (
                      <StatusBadge tone="danger">
                        غیرفعال — برای بازیابی روی همین دستگاه «فعال کردن» را بزنید
                      </StatusBadge>
                    ) : device.failureCount > 0 ? (
                      <StatusBadge tone="danger">
                        {toPersianDigits(device.failureCount)} بار ناموفق
                      </StatusBadge>
                    ) : device.lastSuccessAt ? (
                      <StatusBadge tone="positive">فعال</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">هنوز اعلانی نفرستاده‌ایم</StatusBadge>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    آخرین پذیرش سرویس:{" "}
                    {device.lastSuccessAt
                      ? new Date(device.lastSuccessAt).toLocaleString("fa-IR")
                      : "هنوز ارسال نشده"}{" "}
                    · آخرین خطا:{" "}
                    {device.lastFailureAt
                      ? new Date(device.lastFailureAt).toLocaleString("fa-IR")
                      : "ندارد"}
                  </p>
                  {device.lastError ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {device.lastError}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void removeDevice(device.id)}
                >
                  حذف {device.label || "دستگاه"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="کاهش تعداد اعلان‌ها"
        description="جزئیات همهٔ اعلان‌های مجاز در صندوق اعلان می‌ماند؛ ارسال به سرویس Push به معنی اثبات نمایش در مرورگر نیست."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="روش ارسال">
            <select
              className={inputClass}
              value={delivery.mode}
              onChange={(e) => setDelivery({ ...delivery, mode: e.target.value })}
            >
              <option value="immediate">فوری (با محدودیت تعداد)</option>
              <option value="digest">خلاصهٔ هوشمند</option>
              <option value="inapp">فقط داخل برنامه</option>
            </select>
          </Field>
          <Field label="فاصلهٔ خلاصه (دقیقه)">
            <select
              className={inputClass}
              value={delivery.digest_minutes}
              onChange={(e) => setDelivery({ ...delivery, digest_minutes: Number(e.target.value) })}
            >
              {Array.from({ length: 60 }, (_, index) => index + 1).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {toPersianDigits(minutes)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="منطقه زمانی شما (IANA؛ خالی = شعبه)">
            <input
              className={inputClass}
              dir="ltr"
              placeholder="Asia/Tehran"
              value={delivery.timezone}
              onChange={(e) => setDelivery({ ...delivery, timezone: e.target.value })}
            />
          </Field>
          <Button disabled={busy} onClick={() => void saveDelivery()}>
            ذخیرهٔ روش ارسال
          </Button>
        </div>
      </SectionCard>
      <details className="rounded-xl border p-3">
        <summary>پیشرفته — محدودهٔ شعبه</summary>
        <p className="text-sm text-muted-foreground">
          قاعدهٔ شعبه بر همهٔ شعب اولویت دارد؛ بدون قاعده از همهٔ شعب، سپس پیش‌فرض نقش ارث می‌برد.
          بازگشت به پیش‌فرض، قاعدهٔ همین محدوده را حذف می‌کند.
        </p>
        <select
          aria-label="محدودهٔ قاعده"
          className={inputClass}
          value={scope}
          disabled={Object.values(saveStates).includes("در حال ذخیره…")}
          onChange={(e) => {
            scopeGeneration.current++;
            setLoading(true);
            setScope(e.target.value);
            setAmountDrafts({});
            setSaveStates({});
          }}
        >
          <option value="">همهٔ شعب</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </details>
      {[...grouped.entries()].map(([group, groupEvents]) => (
        <SectionCard
          key={group}
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                دسته‌بندی اعلان
              </p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">
                {NOTIFICATION_GROUP_LABELS[group]}
              </h2>
            </div>
          }
        >
          <ul className="space-y-4">
            {groupEvents.map((event) => {
              const preference = preferenceFor(event.key);
              if (!preference) return null;
              return (
                <li key={event.key} className="rounded-xl border border-border/80 p-3 sm:p-4">
                  <fieldset disabled={busy} className="min-w-0">
                    <p role="status" className="text-xs text-muted-foreground">
                      {saveStates[event.key]}
                    </p>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <label className="flex min-w-0 cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0 accent-amber-600 dark:accent-amber-400"
                          checked={preference.enabled}
                          onChange={(e) =>
                            void savePreference({ ...preference, enabled: e.target.checked })
                          }
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                            {event.label}
                            {preference.isDefault ? <StatusBadge>پیش‌فرض</StatusBadge> : null}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {event.description}
                          </span>
                        </span>
                      </label>
                      {preference.ruleId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={Object.values(saveStates).includes("در حال ذخیره…")}
                          onClick={() => void resetPreference(preference)}
                        >
                          بازگشت به پیش‌فرض
                        </Button>
                      ) : null}
                    </div>

                    {preference.enabled ? (
                      <div className="mt-3 grid gap-3 border-t border-border/80 pt-3 sm:grid-cols-2">
                        <div className="flex flex-wrap gap-4 sm:col-span-2">
                          {(["push", "inapp"] as NotificationChannel[]).map((channel) => (
                            <label
                              key={channel}
                              className="flex cursor-pointer items-center gap-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                className="size-4 accent-amber-600 dark:accent-amber-400"
                                checked={preference.channels.includes(channel)}
                                onChange={(e) => {
                                  const channels = e.target.checked
                                    ? [...preference.channels, channel]
                                    : preference.channels.filter((item) => item !== channel);
                                  // An enabled event with no channel is "on but
                                  // silent", which nobody wants and the API
                                  // refuses — so the last one cannot be cleared.
                                  if (channels.length === 0) return;
                                  void savePreference({ ...preference, channels });
                                }}
                              />
                              {NOTIFICATION_CHANNEL_LABELS[channel]}
                            </label>
                          ))}
                        </div>

                        {event.hasAmount ? (
                          <Field label="فقط اگر مبلغ از این بیشتر بود (تومان)">
                            <PersianNumberInput
                              className={inputClass}
                              inputMode="numeric"
                              value={
                                amountDrafts[event.key] ??
                                rialToTomanInput(preference.minAmountRial)
                              }
                              onChange={(e) =>
                                setAmountDrafts((current) => ({
                                  ...current,
                                  [event.key]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                              }}
                              placeholder="خالی = هر مبلغی"
                              onBlur={(e) => {
                                const parsed = tomanInputToRial(e.target.value);
                                if (!parsed.ok) {
                                  setError("حداقل مبلغ باید عددی صحیح و مثبت باشد.");
                                  return;
                                }
                                if (parsed.rial === preference.minAmountRial) return;
                                void savePreference({ ...preference, minAmountRial: parsed.rial });
                              }}
                            />
                          </Field>
                        ) : null}

                        <details className="sm:col-span-2">
                          <summary>پیشرفته — حداقل اهمیت</summary>
                          <select
                            aria-label={`حداقل اهمیت ${event.label}`}
                            className={inputClass}
                            value={preference.minSeverity}
                            onChange={(e) =>
                              void savePreference({
                                ...preference,
                                minSeverity: e.target.value as NotificationSeverity,
                              })
                            }
                          >
                            <option value="info">اطلاعاتی و بالاتر</option>
                            <option value="important">مهم و بالاتر</option>
                            <option value="critical">فقط بحرانی</option>
                          </select>
                        </details>
                        <div className="grid grid-cols-2 gap-3 sm:col-span-2 sm:max-w-md">
                          <Field label="ساکت از ساعت">
                            <input
                              type="time"
                              className={inputClass}
                              value={minutesToTime(preference.quietFromMinutes)}
                              onChange={(e) => {
                                const from = timeToMinutes(e.target.value);
                                void savePreference({
                                  ...preference,
                                  quietFromMinutes: from,
                                  // Both ends or neither: half a window is a rule
                                  // whose behaviour nobody could predict, and the
                                  // API refuses it.
                                  quietToMinutes:
                                    from === null ? null : (preference.quietToMinutes ?? 7 * 60),
                                });
                              }}
                            />
                          </Field>
                          <Field label="تا ساعت">
                            <input
                              type="time"
                              className={inputClass}
                              value={minutesToTime(preference.quietToMinutes)}
                              onChange={(e) => {
                                const to = timeToMinutes(e.target.value);
                                void savePreference({
                                  ...preference,
                                  quietToMinutes: to,
                                  quietFromMinutes:
                                    to === null ? null : (preference.quietFromMinutes ?? 22 * 60),
                                });
                              }}
                            />
                          </Field>
                        </div>
                      </div>
                    ) : null}
                  </fieldset>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ))}

      <p className="text-xs leading-6 text-muted-foreground">
        در ساعت‌های سکوت، اعلان روی گوشی فرستاده نمی‌شود ولی همان پیام در زنگولهٔ داخل برنامه ثبت
        می‌شود — «بیدارم نکن» یعنی همین، نه «به من نگو». تنها استثنا اعلان‌های بحرانی است (مثل
        ناموفق‌بودن پشتیبان‌گیری) که ساعت سکوت را نادیده می‌گیرند.
      </p>
    </div>
  );
}
