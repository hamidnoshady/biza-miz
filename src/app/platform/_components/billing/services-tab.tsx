"use client";

/**
 * Issue #1041 — «سرویس‌ها» and «نگهداری داده» tabs of the Billing Control Center.
 *
 * These are the two Superadmin decisions the service-activation epic adds:
 *
 *  - a per-service tariff: the one-time **setup fee** (a fixed Rial amount, or
 *    N hours at this service's hourly rate — the 72-hour / 3-day equivalent the
 *    issue asks for, never prepaid runtime) plus the **per-enabled-hour** rate.
 *    A published 0 is the explicit "free" choice; a service with no published
 *    tariff stays ineligible, because an unpriced service must never activate
 *    on an assumed default;
 *  - a per-service **retention window**: 7/30/90/365 days (or indefinite), the
 *    warning lead time and the export grace, applied when a customer disables
 *    the service. It is deliberately not a "delete now" button: the destruction
 *    worker re-checks holds, the deadline and re-enable inside the transaction,
 *    and every write here is audited with before/after.
 *
 * Both tabs read through `billing.view` and write through `billing.manage`
 * (`retention.manage` for the destruction window); the UI honours the same
 * capabilities but the API is the enforcement point.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { tomanLabel } from "@/lib/platform-money";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  api,
  inputClass,
  selectClass,
  useCan,
} from "../../ui";

interface PriceVersion {
  id: string;
  serviceKind: string;
  serviceKey: string;
  version: number;
  setupMode: "fixed" | "hour_equivalent";
  setupFixedRial: number;
  setupEquivalentHours: number;
  hourlyRateRial: number;
  published: boolean;
  effectiveFrom: string;
  effectiveUntil: string | null;
  note: string | null;
}

interface RetentionRow {
  kind: string;
  key: string;
  autoPurgeEnabled: boolean;
  retentionDays: number | null;
  notificationLeadDays: number;
  exportGraceDays: number;
  policyVersion: number;
  source?: string;
  updatedAt: string | null;
}

interface ServiceRow {
  kind: string;
  key: string;
  label: string;
  description: string;
  tariff: PriceVersion | null;
  setupRial: number;
  retention: RetentionRow | null;
  eligible: boolean;
}

interface ServicesPayload {
  services: ServiceRow[];
  priceVersions: PriceVersion[];
  error?: string;
}

function identityOf(service: Pick<ServiceRow, "kind" | "key">): string {
  return `${service.kind}:${service.key}`;
}

const SETUP_MODE_LABELS: Record<PriceVersion["setupMode"], string> = {
  fixed: "مبلغ ثابت (تومان)",
  hour_equivalent: "معادل N ساعت با نرخ ساعتی",
};

// ---------------------------------------------------------------------------
// Pricing tab
// ---------------------------------------------------------------------------

export function BillingServicesTab() {
  const canManage = useCan()("billing.manage");
  const [data, setData] = useState<ServicesPayload | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<PriceVersion["setupMode"]>("fixed");
  const [fixedToman, setFixedToman] = useState("");
  const [hours, setHours] = useState("72");
  const [hourlyToman, setHourlyToman] = useState("");
  const [note, setNote] = useState("");
  const [published, setPublished] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<ServicesPayload>("/api/platform/services");
    if (res.ok) setData(res.data);
    else setError(res.data.error ?? "بارگذاری تعرفهٔ سرویس‌ها ممکن نشد.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const services = data?.services ?? [];
  const current = services.find((service) => identityOf(service) === selected) ?? null;
  const hourlyRialPreview = Math.max(0, Math.floor(Number(hourlyToman.replace(/[^\d]/g, "") || "0"))) * 10;
  const equivalentHoursPreview = Number(hours.replace(/[^\d.]/g, "") || "0");

  useEffect(() => {
    if (!current) return;
    const tariff = current.tariff;
    setMode(tariff?.setupMode ?? "fixed");
    setFixedToman(tariff ? String(Math.floor(tariff.setupFixedRial / 10)) : "");
    setHours(tariff ? String(tariff.setupEquivalentHours || 72) : "72");
    setHourlyToman(tariff ? String(Math.floor(tariff.hourlyRateRial / 10)) : "");
    setNote(tariff?.note ?? "");
    setPublished(tariff?.published ?? true);
  }, [current]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!current) return;
    setError("");
    setInfo("");
    const fixedRial = Math.max(0, Math.floor(Number(fixedToman.replace(/[^\d]/g, "") || "0"))) * 10;
    const equivalentHours = Number(hours.replace(/[^\d.]/g, "") || "0");
    const hourlyRial = Math.max(0, Math.floor(Number(hourlyToman.replace(/[^\d]/g, "") || "0"))) * 10;
    if (!Number.isFinite(equivalentHours) || equivalentHours < 0) {
      setError("مقدار ساعت معادل معتبر نیست.");
      return;
    }
    setBusy(true);
    const res = await api<{ error?: string }>("/api/platform/services/pricing", {
      method: "POST",
      body: JSON.stringify({
        kind: current.kind,
        key: current.key,
        setupMode: mode,
        setupFixedRial: mode === "fixed" ? fixedRial : 0,
        setupEquivalentHours: mode === "hour_equivalent" ? equivalentHours : 0,
        hourlyRateRial: hourlyRial,
        published,
        note: note.trim() || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.data.error === "invalid_amount"
          ? "مقادیر واردشده معتبر نیستند."
          : res.data.error === "unknown_service"
            ? "این سرویس ثبت نشده است."
            : res.data.error ?? "ذخیره انجام نشد.",
      );
      return;
    }
    setInfo("نسخهٔ جدید تعرفه منتشر شد؛ نسخه‌های قبلی برای دورهٔ خودشان معتبر می‌مانند.");
    await load();
  }

  if (!data) {
    return (
      <Card title="راه‌اندازی سرویس و نرخ ساعتی">
        {error ? <ErrorBox>{error}</ErrorBox> : <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <Card title="تعرفهٔ راه‌اندازی و اجارهٔ ساعتی هر سرویس">
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          هزینهٔ راه‌اندازی برای هر کسب‌وکار فقط <span className="font-medium text-foreground">یک‌بار</span> و به‌ازای هویت پایدار سرویس
          کسر می‌شود؛ به‌روزرسانی نسخه، تمدید اشتراک، فعال/غیرفعال کردن دوباره و ویرایش فرم‌ها هزینهٔ دوباره ندارند. نرخ ساعتی فقط در
          بازه‌های فعال سرویس و به‌صورت ثانیه‌ای محاسبه می‌شود. سرویسی که تعرفهٔ منتشرشده ندارد قابل فعال‌سازی نیست.
        </p>
        {services.length === 0 ? (
          <EmptyState title="سرویسی ثبت نشده است" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-2 text-right font-medium">سرویس</th>
                  <th className="py-2 text-right font-medium">هزینهٔ راه‌اندازی</th>
                  <th className="py-2 text-right font-medium">اجارهٔ هر ساعت</th>
                  <th className="py-2 text-right font-medium">وضعیت</th>
                  <th className="py-2 text-right font-medium">آخرین نسخه</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr
                    key={identityOf(service)}
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                    onClick={() => setSelected(identityOf(service))}
                  >
                    <td className="py-2">
                      <p className="text-foreground">{service.label}</p>
                      <p className="font-mono text-xs text-muted-foreground" dir="ltr">
                        {identityOf(service)}
                      </p>
                    </td>
                    <td className="py-2 tabular-nums text-foreground">
                      {service.tariff
                        ? service.tariff.setupMode === "hour_equivalent"
                          ? `${tomanLabel(service.setupRial)} (${toPersianDigits(service.tariff.setupEquivalentHours)} ساعت)`
                          : tomanLabel(service.setupRial)
                        : "—"}
                    </td>
                    <td className="py-2 tabular-nums text-foreground">
                      {service.tariff ? `${tomanLabel(service.tariff.hourlyRateRial)} / ساعت` : "—"}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {service.eligible ? "قابل فعال‌سازی" : "بدون تعرفه (قفل)"}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {service.tariff
                        ? `نسخهٔ ${toPersianDigits(service.tariff.version)} · ${formatJalali(service.tariff.effectiveFrom)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="انتشار نسخهٔ جدید تعرفه">
        <form onSubmit={save} className="space-y-3">
          <Field label="سرویس">
            <select
              className={selectClass}
              value={selected}
              onChange={(ev) => setSelected(ev.target.value)}
              disabled={!canManage}
            >
              <option value="">— انتخاب سرویس —</option>
              {services.map((service) => (
                <option key={identityOf(service)} value={identityOf(service)}>
                  {service.label} ({identityOf(service)})
                </option>
              ))}
            </select>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="روش محاسبهٔ هزینهٔ راه‌اندازی">
              <select
                className={selectClass}
                value={mode}
                onChange={(ev) => setMode(ev.target.value as PriceVersion["setupMode"])}
                disabled={!canManage || !current}
              >
                {(Object.keys(SETUP_MODE_LABELS) as PriceVersion["setupMode"][]).map((key) => (
                  <option key={key} value={key}>
                    {SETUP_MODE_LABELS[key]}
                  </option>
                ))}
              </select>
            </Field>
            {mode === "fixed" ? (
              <Field label="مبلغ ثابت راه‌اندازی (تومان)">
                <PersianNumberInput
                  className={inputClass}
                  inputMode="numeric"
                  value={fixedToman}
                  onChange={(ev) => setFixedToman(ev.target.value)}
                  disabled={!canManage || !current}
                  placeholder="۰ یعنی راه‌اندازی رایگان"
                />
              </Field>
            ) : (
              <Field
                label="ساعت معادل"
                hint="مثلاً ۷۲ ساعت = سه روز نرخ ساعتی؛ یک‌بار برای همیشه، نه پیش‌پرداخت سه روز."
              >
                <PersianNumberInput
                  className={inputClass}
                  inputMode="decimal"
                  value={hours}
                  onChange={(ev) => setHours(ev.target.value)}
                  disabled={!canManage || !current}
                />
              </Field>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="نرخ هر ساعت فعال بودن (تومان)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={hourlyToman}
                onChange={(ev) => setHourlyToman(ev.target.value)}
                disabled={!canManage || !current}
                placeholder="۰ یعنی سرویس رایگان"
              />
            </Field>
            <Field label="یادداشت نسخه (اختیاری)">
              <input
                className={inputClass}
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                disabled={!canManage || !current}
                maxLength={200}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={published}
              onChange={(ev) => setPublished(ev.target.checked)}
              disabled={!canManage || !current}
              className="size-4"
            />
            این نسخه منتشر شود (خاموش = تعلیق آگاهانه؛ سرویس قابل فعال‌سازی نمی‌ماند)
          </label>

          {mode === "hour_equivalent" && current && (
            <p className="text-xs text-muted-foreground">
              معادل: {toPersianDigits(Number(hours.replace(/[^\d.]/g, "") || "0"))} ساعت ×{" "}
              {tomanLabel(hourlyRialPreview)} ={" "}
              {tomanLabel(Math.ceil(equivalentHoursPreview * hourlyRialPreview))}
            </p>
          )}

          {canManage && (
            <Button type="submit" disabled={busy || !current}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
              انتشار نسخهٔ جدید
            </Button>
          )}
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retention tab
// ---------------------------------------------------------------------------

const RETENTION_SOURCE_LABELS: Record<string, string> = {
  platform: "سیاست پلتفرم",
  business: "تنظیم اختصاصی کسب‌وکار",
  none: "بدون سیاست (نگهداری دائمی)",
};

export function BillingRetentionTab() {
  const canManage = useCan()("retention.manage");
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [selected, setSelected] = useState("");
  const [autoPurge, setAutoPurge] = useState(false);
  const [days, setDays] = useState("30");
  const [lead, setLead] = useState("7");
  const [grace, setGrace] = useState("7");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<ServicesPayload>("/api/platform/services");
    if (res.ok) {
      setServices(res.data.services ?? []);
      setError("");
    } else {
      setError(res.data.error ?? "بارگذاری سیاست‌های نگهداری ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = services.find((service) => identityOf(service) === selected) ?? null;

  useEffect(() => {
    const policy = current?.retention;
    setAutoPurge(policy?.autoPurgeEnabled ?? false);
    setDays(policy?.retentionDays ? String(policy.retentionDays) : "30");
    setLead(String(policy?.notificationLeadDays ?? 7));
    setGrace(String(policy?.exportGraceDays ?? 7));
    setNote("");
  }, [selected, current?.retention]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!current) return;
    setError("");
    setInfo("");
    const retentionDays = autoPurge ? Number(days.replace(/[^\d]/g, "") || "0") : null;
    const leadDays = Number(lead.replace(/[^\d]/g, "") || "0");
    const graceDays = Number(grace.replace(/[^\d]/g, "") || "0");
    if (autoPurge && (!retentionDays || retentionDays < 1 || retentionDays > 3650)) {
      setError("بازهٔ نگهداری باید بین ۱ تا ۳۶۵۰ روز باشد.");
      return;
    }
    setBusy(true);
    const res = await api<{ error?: string }>("/api/platform/services/retention", {
      method: "PUT",
      body: JSON.stringify({
        kind: current.kind,
        key: current.key,
        autoPurgeEnabled: autoPurge,
        retentionDays,
        notificationLeadDays: leadDays,
        exportGraceDays: graceDays,
        note: note.trim() || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.data.error === "invalid_retention_days"
          ? "بازهٔ نگهداری معتبر نیست."
          : res.data.error === "indefinite_requires_disabled_purge"
            ? "برای حذف خودکار باید یک بازهٔ مشخص انتخاب شود."
            : res.data.error ?? "ذخیره انجام نشد.",
      );
      return;
    }
    setInfo("سیاست نگهداری به‌روزرسانی شد؛ بازهٔ جدید از این پس روی غیرفعال‌سازی‌های تازه اعمال می‌شود.");
    await load();
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <Card title="نگهداری و نابودی خودکار دادهٔ هر سرویس">
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          این بازه فقط وقتی شمارش معکوس را شروع می‌کند که <span className="font-medium text-foreground">خود کسب‌وکار</span> سرویس را
          غیرفعال کند؛ قطع سرویس به‌دلیل کمبود اعتبار یا خرابی پلتفرم هرگز مهلت حذف نمی‌سازد. پیش از حذف، اعلان و فرصت خروجی‌گرفتن داده
          اعمال می‌شود و فعال‌سازی مجدد پیش از مهلت، صف نابودی را لغو می‌کند.
        </p>
        {services.length === 0 ? (
          <EmptyState title="سرویسی ثبت نشده است" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-2 text-right font-medium">سرویس</th>
                  <th className="py-2 text-right font-medium">بازهٔ نگهداری</th>
                  <th className="py-2 text-right font-medium">اعلان پیش از حذف</th>
                  <th className="py-2 text-right font-medium">فرصت خروجی</th>
                  <th className="py-2 text-right font-medium">نسخهٔ سیاست</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr
                    key={identityOf(service)}
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                    onClick={() => setSelected(identityOf(service))}
                  >
                    <td className="py-2">
                      <p className="text-foreground">{service.label}</p>
                      <p className="font-mono text-xs text-muted-foreground" dir="ltr">
                        {identityOf(service)}
                      </p>
                    </td>
                    <td className="py-2 text-foreground">
                      {service.retention?.autoPurgeEnabled
                        ? `${toPersianDigits(service.retention.retentionDays ?? 0)} روز`
                        : "نگهداری دائمی"}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {service.retention
                        ? `${toPersianDigits(service.retention.notificationLeadDays)} روز`
                        : "—"}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {service.retention ? `${toPersianDigits(service.retention.exportGraceDays)} روز` : "—"}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {service.retention
                        ? `نسخهٔ ${toPersianDigits(service.retention.policyVersion)} · ${
                            RETENTION_SOURCE_LABELS[service.retention.source ?? "platform"] ?? ""
                          }`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="ویرایش سیاست نگهداری">
        <form onSubmit={save} className="space-y-3">
          <Field label="سرویس">
            <select
              className={selectClass}
              value={selected}
              onChange={(ev) => setSelected(ev.target.value)}
              disabled={!canManage}
            >
              <option value="">— انتخاب سرویس —</option>
              {services.map((service) => (
                <option key={identityOf(service)} value={identityOf(service)}>
                  {service.label} ({identityOf(service)})
                </option>
              ))}
            </select>
          </Field>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={autoPurge}
              onChange={(ev) => setAutoPurge(ev.target.checked)}
              disabled={!canManage || !current}
              className="size-4"
            />
            پس از غیرفعال‌سازی، دادهٔ این سرویس خودکار نابود شود
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="بازهٔ نگهداری">
              <select
                className={selectClass}
                value={days}
                onChange={(ev) => setDays(ev.target.value)}
                disabled={!canManage || !autoPurge || !current}
              >
                {[7, 30, 90, 365].map((preset) => (
                  <option key={preset} value={String(preset)}>
                    {toPersianDigits(preset)} روز
                  </option>
                ))}
                {![7, 30, 90, 365].includes(Number(days)) && (
                  <option value={days}>{toPersianDigits(Number(days) || 0)} روز</option>
                )}
              </select>
            </Field>
            <Field label="اعلان پیش از حذف (روز)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={lead}
                onChange={(ev) => setLead(ev.target.value)}
                disabled={!canManage || !current}
              />
            </Field>
            <Field label="فرصت خروجی‌گرفتن (روز)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={grace}
                onChange={(ev) => setGrace(ev.target.value)}
                disabled={!canManage || !current}
              />
            </Field>
          </div>

          <Field label="یادداشت سیاست (اختیاری)">
            <input
              className={inputClass}
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              disabled={!canManage || !current}
              maxLength={200}
            />
          </Field>

          {!canManage && (
            <p className="text-xs text-muted-foreground">
              ویرایش این سیاست فقط با دسترسی مالک پلتفرم («نگهداری داده») ممکن است.
            </p>
          )}

          {canManage && (
            <Button type="submit" disabled={busy || !current}>
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
              ذخیرهٔ سیاست نگهداری
            </Button>
          )}
        </form>
      </Card>
    </div>
  );
}
