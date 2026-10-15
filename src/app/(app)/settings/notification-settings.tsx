"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
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
import {
  currentSubscriptionEndpoint,
  disablePush,
  enablePush,
  pushSupport,
} from "./push-client";
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
  error?: string;
}

interface DeviceRow {
  id: string;
  endpoint: string;
  platform: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
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
  const trimmed = toLatinDigits(value).replace(/[,٬\s]/g, "").trim();
  if (trimmed === "") return { ok: true, rial: null };
  const toman = Number(trimmed);
  if (!Number.isFinite(toman) || toman < 0 || !Number.isInteger(toman)) return { ok: false };
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
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [support, setSupport] = useState<ReturnType<typeof pushSupport> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
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
      api<RulesResponse>("/api/notifications/rules"),
      api<{ devices: DeviceRow[]; error?: string }>("/api/notifications/devices"),
    ]);
    if (rules.ok) {
      setEvents(rules.data.events);
      setPreferences(rules.data.preferences);
    } else {
      setError(errorMessage(rules.data.error));
    }
    if (deviceList.ok) setDevices(deviceList.data.devices);
    setLoading(false);
  }, []);

  useEffect(() => {
    setSupport(pushSupport());
    void currentSubscriptionEndpoint().then(setThisEndpoint);
    void load();
  }, [load]);

  async function savePreference(next: Preference) {
    setError("");
    setInfo("");
    // Optimistic: the row flips immediately and reverts on failure. A checkbox
    // that waits on a round trip before moving reads as broken on a phone.
    setPreferences((current) =>
      current.map((item) => (item.eventKey === next.eventKey ? next : item)),
    );
    const { ok, data } = await api<{ rule?: { id: string }; messages?: string[]; error?: string }>(
      "/api/notifications/rules",
      {
        method: "POST",
        body: JSON.stringify({
          eventKey: next.eventKey,
          locationId: null,
          enabled: next.enabled,
          channels: next.channels,
          minSeverity: next.minSeverity,
          minAmountRial: next.minAmountRial,
          quietFromMinutes: next.quietFromMinutes,
          quietToMinutes: next.quietToMinutes,
        }),
      },
    );
    if (!ok) {
      setError(data.messages?.[0] ?? errorMessage(data.error));
      await load();
      return;
    }
    setPreferences((current) =>
      current.map((item) =>
        item.eventKey === next.eventKey
          ? { ...next, ruleId: data.rule?.id ?? item.ruleId, isDefault: false }
          : item,
      ),
    );
  }

  async function resetPreference(preference: Preference) {
    if (!preference.ruleId) return;
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
  }

  async function toggleThisDevice() {
    setBusy(true);
    setError("");
    setInfo("");
    if (thisEndpoint) {
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
  }

  async function removeDevice(id: string) {
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
  }

  async function sendTest() {
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
  }

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
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سخت‌افزار و مرورگر</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">دستگاه‌های دریافت اعلان</h2>
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
              variant={thisEndpoint ? "outline" : "default"}
              onClick={() => void toggleThisDevice()}
              disabled={busy || (support !== null && !support.supported)}
            >
              {thisEndpoint ? "غیرفعال کردن روی این دستگاه" : "فعال کردن روی این دستگاه"}
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

        {devices.length === 0 ? (
          <EmptyState>
            هنوز هیچ دستگاهی ثبت نشده است. روی همین دستگاه «فعال کردن» را بزنید، و همین کار را روی گوشی خودتان هم
            انجام دهید.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    {device.label || "دستگاه"}
                    {device.failureCount > 0 ? (
                      <StatusBadge tone="danger">
                        {toPersianDigits(device.failureCount)} بار ناموفق
                      </StatusBadge>
                    ) : device.lastSuccessAt ? (
                      <StatusBadge tone="positive">فعال</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">هنوز اعلانی نفرستاده‌ایم</StatusBadge>
                    )}
                  </p>
                  {device.lastError ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{device.lastError}</p>
                  ) : null}
                </div>
                <Button type="button" variant="outline" onClick={() => void removeDevice(device.id)}>
                  حذف {device.label || "دستگاه"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {[...grouped.entries()].map(([group, groupEvents]) => (
        <SectionCard
          key={group}
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دسته‌بندی اعلان</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">{NOTIFICATION_GROUP_LABELS[group]}</h2>
            </div>
          }
        >
          <ul className="space-y-4">
            {groupEvents.map((event) => {
              const preference = preferenceFor(event.key);
              if (!preference) return null;
              return (
                <li key={event.key} className="rounded-xl border border-border/80 p-3 sm:p-4">
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
                          <label key={channel} className="flex cursor-pointer items-center gap-2 text-sm">
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
                            value={rialToTomanInput(preference.minAmountRial)}
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
                                quietToMinutes: from === null ? null : (preference.quietToMinutes ?? 7 * 60),
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
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ))}

      <p className="text-xs leading-6 text-muted-foreground">
        در ساعت‌های سکوت، اعلان روی گوشی فرستاده نمی‌شود ولی همان پیام در زنگولهٔ داخل برنامه ثبت می‌شود — «بیدارم
        نکن» یعنی همین، نه «به من نگو». تنها استثنا اعلان‌های بحرانی است (مثل ناموفق‌بودن پشتیبان‌گیری) که ساعت سکوت را
        نادیده می‌گیرند.
      </p>
    </div>
  );
}
