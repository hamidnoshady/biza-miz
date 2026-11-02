"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CloudOff, HardDriveDownload, KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { api, Button, Card, ErrorBox, Field, fmtDate, InfoBox, inputClass, SkeletonRows, useCan } from "../../ui";

interface ServiceView {
  managedCloud: boolean;
  hybridEnabled: boolean;
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  accessKeyHint: string;
  hasSecretKey: boolean;
  defaultIntervalHours: number;
  defaultRetentionDays: number;
  maxRetentionDays: number;
  cloudKeepCount: number;
  maxArtifactBytes: number;
  uploadChunkBytes: number;
  maxParallelUploads: number;
  protectedRecoveryCopies: number;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastErrorCode: string | null;
  kekAvailable: boolean;
}

type Draft = Partial<Record<keyof ServiceView, string>> & {
  managedCloud?: string;
  hybridEnabled?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

const CHECK_LABELS: Record<string, string> = {
  ok: "مقصد در دسترس است",
  storage_destination_incomplete: "مقصد کامل نیست (نقطه پایانی، سطل یا کلید ناقص است)",
  storage_access_denied: "دسترسی به سطل رد شد",
  storage_unreachable: "مقصد از این سرور در دسترس نیست",
};

/**
 * The managed-backup service form.
 *
 * Booleans are sent as real booleans and numbers as numbers — the update service
 * validates both, and refuses to enable managed cloud without a complete
 * destination *and* a key-encryption key to seal its credential. The page shows
 * that refusal verbatim: an "enabled but unusable" service is the failure mode
 * this screen exists to prevent.
 */
export function TenantBackupServicePanel() {
  const can = useCan();
  const canWrite = can("tenant_backup.policy");
  const [service, setService] = useState<ServiceView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const result = await api<{ service?: ServiceView; error?: string }>("/api/platform/backup/service");
    if (!result.ok || !result.data.service) {
      setError(result.data.error ?? "خواندن تنظیمات سرویس ناموفق بود");
      return;
    }
    setService(result.data.service);
    setDraft({});
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = (key: keyof ServiceView): string => {
    const edited = draft[key];
    if (edited !== undefined) return edited;
    if (!service) return "";
    const current = service[key];
    return current === null || current === undefined ? "" : String(current);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    const body: Record<string, unknown> = {};
    for (const key of [
      "endpoint",
      "region",
      "bucket",
      "keyPrefix",
      "accessKeyHint",
      "defaultIntervalHours",
      "defaultRetentionDays",
      "maxRetentionDays",
      "cloudKeepCount",
      "maxArtifactBytes",
      "uploadChunkBytes",
      "maxParallelUploads",
      "protectedRecoveryCopies",
    ] as const) {
      const entered = draft[key];
      if (entered !== undefined && entered !== "") {
        body[key] =
          key === "endpoint" || key === "region" || key === "bucket" || key === "keyPrefix" || key === "accessKeyHint"
            ? entered
            : Number(entered);
      }
    }
    if (draft.accessKeyId) body.accessKeyId = draft.accessKeyId;
    if (draft.secretAccessKey) body.secretAccessKey = draft.secretAccessKey;
    if (draft.managedCloud !== undefined) body.managedCloud = draft.managedCloud === "on";
    if (draft.hybridEnabled !== undefined) body.hybridEnabled = draft.hybridEnabled === "on";

    const result = await api<{ service?: ServiceView; error?: string }>("/api/platform/backup/service", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!result.ok || !result.data.service) {
      setError(result.data.error ?? "ذخیره تنظیمات ناموفق بود");
      return;
    }
    setService(result.data.service);
    setDraft({});
    setNotice("تنظیمات ذخیره شد.");
  };

  const check = async () => {
    setChecking(true);
    setError(null);
    setNotice(null);
    const result = await api<{ code?: string; service?: ServiceView; error?: string }>(
      "/api/platform/backup/service/check",
      { method: "POST", body: JSON.stringify({}) },
    );
    setChecking(false);
    if (!result.ok) {
      setError(result.data.error ?? "بررسی مقصد ناموفق بود");
      return;
    }
    if (result.data.service) setService(result.data.service);
    setNotice(CHECK_LABELS[result.data.code ?? ""] ?? "نتیجه بررسی نامشخص است");
  };

  if (!service) {
    return (
      <div className="space-y-4 p-6">
        {error ? <ErrorBox>{error}</ErrorBox> : <SkeletonRows rows={4} />}
      </div>
    );
  }

  const unavailable = !service.configured;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">سرویس پشتیبان‌گیری مدیریت‌شده</h1>
        <p className="text-sm text-muted-foreground">
          مقصد مشترک پشتیبان‌ها، کلید نگهداری و سیاست پیش‌فرض همه کسب‌وکارها. پشتیبان هر کسب‌وکار فقط در صفحه
          همان کسب‌وکار دیده می‌شود.
        </p>
      </header>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card>
        <div className="flex items-center gap-2">
          {service.configured ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <CloudOff className="h-4 w-4 text-amber-600" />
          )}
          <h2 className="text-sm font-semibold">وضعیت مقصد</h2>
        </div>
        <p className="mt-2 text-sm">
          {service.configured
            ? "مقصد کامل و قابل استفاده است."
            : "مقصد کامل نیست؛ پشتیبان مدیریت‌شده تا تکمیل آن نوشته نمی‌شود."}
        </p>
        {service.lastCheckedAt ? (
          <p className="mt-1 text-xs text-muted-foreground">
            آخرین بررسی: {fmtDate(service.lastCheckedAt)}
            {service.lastCheckOk === false && service.lastErrorCode
              ? ` — ${CHECK_LABELS[service.lastErrorCode] ?? service.lastErrorCode}`
              : ""}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">این مقصد هنوز بررسی نشده است.</p>
        )}
        <div className="mt-3 flex gap-2">
          <Button onClick={check} disabled={checking || !canWrite} variant="ghost">
            <RefreshCw className={checking ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            بررسی مقصد
          </Button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          <h2 className="text-sm font-semibold">نگهداری کلید</h2>
        </div>
        {service.kekAvailable ? (
          <p className="mt-2 text-sm">
            کلید اصلی سکو در دسترس است؛ کلید مقصد مهروموم می‌شود و نسل کلید هر پشتیبان ثبت می‌گردد.
          </p>
        ) : (
          <div className="mt-2 flex items-start gap-2 text-sm text-amber-700">
            <ShieldAlert className="mt-0.5 h-4 w-4" />
            <p>
              کلید اصلی سکو تنظیم نشده است. تا وقتی کلید در دسترس نباشد، سرویس مدیریت‌شده قابل فعال‌سازی نیست
              (پشتیبان محلی همچنان کار می‌کند).
            </p>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-2">
          <HardDriveDownload className="h-4 w-4" />
          <h2 className="text-sm font-semibold">مقصد ذخیره‌سازی</h2>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="نقطه پایانی (endpoint)">
            <input className={inputClass} value={value("endpoint")} onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="منطقه (region)">
            <input className={inputClass} value={value("region")} onChange={(e) => setDraft({ ...draft, region: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="سطل (bucket)">
            <input className={inputClass} value={value("bucket")} onChange={(e) => setDraft({ ...draft, bucket: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="پیشوند کلیدها">
            <input className={inputClass} value={value("keyPrefix")} onChange={(e) => setDraft({ ...draft, keyPrefix: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label={`شناسه کلید دسترسی${service.accessKeyHint ? ` (فعلی: ${service.accessKeyHint})` : ""}`}>
            <input
              className={inputClass}
              placeholder={service.accessKeyHint || "تغییر نمی‌کند اگر خالی بماند"}
              onChange={(e) => setDraft({ ...draft, accessKeyId: e.target.value })}
              disabled={!canWrite}
            />
          </Field>
          <Field label={`کلید دسترسی${service.hasSecretKey ? " (ذخیره شده)" : ""}`}>
            <input
              className={inputClass}
              type="password"
              placeholder={service.hasSecretKey ? "ذخیره شده — برای تغییر بنویسید" : "الزامی برای فعال‌سازی"}
              onChange={(e) => setDraft({ ...draft, secretAccessKey: e.target.value })}
              disabled={!canWrite}
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.managedCloud === undefined ? service.managedCloud : draft.managedCloud === "on"}
              onChange={(e) => setDraft({ ...draft, managedCloud: e.target.checked ? "on" : "off" })}
              disabled={!canWrite}
            />
            فعال‌سازی مقصد مدیریت‌شده
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.hybridEnabled === undefined ? service.hybridEnabled : draft.hybridEnabled === "on"}
              onChange={(e) => setDraft({ ...draft, hybridEnabled: e.target.checked ? "on" : "off" })}
              disabled={!canWrite}
            />
            اجازه حالت ترکیبی (نسخه محلی + نسخه ابری)
          </label>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">سیاست پیش‌فرض</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="فاصله پیش‌فرض (ساعت)">
            <input className={inputClass} inputMode="numeric" value={value("defaultIntervalHours")} onChange={(e) => setDraft({ ...draft, defaultIntervalHours: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="نگهداری پیش‌فرض (روز)">
            <input className={inputClass} inputMode="numeric" value={value("defaultRetentionDays")} onChange={(e) => setDraft({ ...draft, defaultRetentionDays: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="سقف نگهداری (روز)">
            <input className={inputClass} inputMode="numeric" value={value("maxRetentionDays")} onChange={(e) => setDraft({ ...draft, maxRetentionDays: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="تعداد نسخه ابری">
            <input className={inputClass} inputMode="numeric" value={value("cloudKeepCount")} onChange={(e) => setDraft({ ...draft, cloudKeepCount: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="سقف حجم هر نسخه (بایت)">
            <input className={inputClass} inputMode="numeric" value={value("maxArtifactBytes")} onChange={(e) => setDraft({ ...draft, maxArtifactBytes: e.target.value })} disabled={!canWrite} />
          </Field>
          <Field label="اندازه هر قطعه بارگذاری (بایت)">
            <input className={inputClass} inputMode="numeric" value={value("uploadChunkBytes")} onChange={(e) => setDraft({ ...draft, uploadChunkBytes: e.target.value })} disabled={!canWrite} />
          </Field>
        </div>
      </Card>

      {canWrite ? (
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
            ذخیره
          </Button>
        </div>
      ) : (
        <InfoBox>برای تغییر این تنظیمات دسترسی «سیاست پشتیبان کسب‌وکارها» لازم است.</InfoBox>
      )}

      {unavailable && canWrite ? (
        <InfoBox>
          تا زمانی که مقصد کامل نشود، پشتیبان‌گیری مدیریت‌شده نوشته نمی‌شود و نسخه محلی همچنان مرجع است.
        </InfoBox>
      ) : null}
    </div>
  );
}
