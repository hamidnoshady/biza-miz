"use client";

/**
 * «سایت‌ساز ← اتصال» — the address and the credential.
 *
 * One page for the whole relationship: where the CMS is, which platform key
 * administers it, whether that pair has ever been proven to work, and the two
 * background switches (the mirror and log shipping).
 *
 * The key field renders empty and always will. The credential is never returned by
 * anything — the stored value is AES-256-GCM ciphertext and the read is masked to
 * the last four characters — so an empty submission means **unchanged**, not
 * "delete". «حذف کلید» is the explicit door, and the page says so rather than
 * implying a mask that does not exist.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Link2, ShieldAlert, Trash2 } from "lucide-react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";

import { formatPersianNumber } from "@/lib/digits";
import type { MaskedCmsControlConfig } from "@/lib/cms/platform-control";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  fmtDate,
  InfoBox,
  inputClass,
  SkeletonRows,
  useCan,
} from "../../ui";
import { cmsErrorText, cmsVerifyText } from "../text";

interface ConfigResponse {
  config?: MaskedCmsControlConfig;
  error?: string;
  errors?: string[];
  result?: { ok: boolean; reason: null | string; sites: null | number };
}

export default function CmsConnectionPage() {
  const can = useCan();
  const manage = can("cms.manage");
  const [config, setConfig] = useState<MaskedCmsControlConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | string>(null);
  const [notice, setNotice] = useState<null | string>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [mirrorEnabled, setMirrorEnabled] = useState(false);
  const [interval, setIntervalMinutes] = useState(30);
  const [logShippingEnabled, setLogShippingEnabled] = useState(false);
  const [billingKeyId, setBillingKeyId] = useState("");
  const [billingSecret, setBillingSecret] = useState("");

  const hydrate = useCallback((next: MaskedCmsControlConfig) => {
    setConfig(next);
    setBaseUrl(next.baseUrl);
    setLabel(next.label);
    setAllowInsecure(next.allowInsecure);
    setMirrorEnabled(next.mirrorEnabled);
    setIntervalMinutes(next.mirrorIntervalMinutes);
    setLogShippingEnabled(next.logShippingEnabled);
    setBillingKeyId(next.billingEntitlementKeyId ?? "");
    // Never re-populated from the server: there is nothing to re-populate it with.
    setApiKey("");
  }, []);

  const load = useCallback(async () => {
    const { ok, data } = await api<ConfigResponse>("/api/platform/cms/config");
    if (!ok) setError(cmsErrorText(data.error));
    else if (data.config) hydrate(data.config);
    setLoading(false);
  }, [hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<ConfigResponse>("/api/platform/cms/config", {
      body: JSON.stringify({
        allowInsecure,
        baseUrl,
        label,
        logShippingEnabled,
        mirrorEnabled,
        mirrorIntervalMinutes: interval,
        // Sent only when the operator typed one; an empty field is not a change.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(billingKeyId.trim() ? { billingEntitlementKeyId: billingKeyId.trim() } : {}),
        ...(billingSecret.trim() ? { billingEntitlementSecret: billingSecret.trim() } : {}),
        ...extra,
      }),
      method: "PUT",
    });
    if (!ok) setError(cmsErrorText(data.error));
    else if (data.config) {
      hydrate(data.config);
      setNotice("تنظیمات ذخیره شد.");
    }
    setBusy(false);
  }

  async function verify() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<ConfigResponse>("/api/platform/cms/config", { method: "POST" });
    if (!ok) setError(cmsErrorText(data.error));
    else {
      if (data.config) hydrate(data.config);
      const text = cmsVerifyText(data.result?.reason ?? null, data.result?.ok === true);
      if (data.result?.ok) {
        setNotice(
          data.result.sites === null
            ? text
            : `${text} ${formatPersianNumber(data.result.sites)} سایت روی این سکو است.`,
        );
      } else setError(text);
    }
    setBusy(false);
  }

  if (loading) return <SkeletonRows label="در حال خواندن تنظیمات اتصال" rows={5} />;

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card title="نشانی و کلید">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field hint="نشانی کنترل‌پلین سایت‌ساز، بدون اسلش پایانی." label="نشانی پایه">
            <input
              className={inputClass}
              dir="ltr"
              disabled={!manage}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://cms.eshobe.com"
              value={baseUrl}
            />
          </Field>
          <Field hint="برای تشخیص چند سکو از هم." label="برچسب">
            <input
              className={inputClass}
              disabled={!manage}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="سایت‌ساز اصلی"
              value={label}
            />
          </Field>
          <Field
            hint={
              config?.configured
                ? `کلیدی ذخیره شده است (${config.apiKeyHint}). خالی گذاشتن این کادر آن را تغییر نمی‌دهد.`
                : "کلید نقش «platform» را از سایت‌ساز صادر کنید و این‌جا بگذارید."
            }
            label="کلید پلتفرم"
          >
            <input
              autoComplete="off"
              className={inputClass}
              dir="ltr"
              disabled={!manage}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={config?.configured ? "بدون تغییر" : "eshobe_live_…"}
              value={apiKey}
            />
          </Field>
          <Field label="اتصال بدون TLS">
            <label className="flex h-10 items-center gap-2 text-sm text-foreground">
              <input
                checked={allowInsecure}
                className="size-4"
                disabled={!manage}
                onChange={(event) => setAllowInsecure(event.target.checked)}
                type="checkbox"
              />
              اجازهٔ http برای شبکهٔ داخلی
            </label>
          </Field>
        </div>

        {/* There is no password input for this field, and pretending otherwise
            would imply a protection that does not exist: the value is protected at
            rest and on read, not while it is being typed. */}
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          کلید هنگام تایپ پوشانده نمی‌شود؛ محافظت آن در ذخیره‌سازی (AES-256-GCM) و در خواندن است —
          هیچ مسیری، از جمله همین صفحه، کلید ذخیره‌شده را برنمی‌گرداند. جای امنی برای تایپ انتخاب
          کنید.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {manage ? (
            <Button disabled={busy} onClick={() => void save()}>
              <Link2 className="size-4" />
              {busy ? "در حال ذخیره…" : "ذخیرهٔ اتصال"}
            </Button>
          ) : null}
          <Button disabled={busy || !config?.usable} onClick={verify} variant="ghost">
            <CheckCircle2 className="size-4" />
            آزمودن اتصال
          </Button>
          {manage && config?.configured ? (
            <Button
              disabled={busy}
              onClick={() => void save({ clearApiKey: true })}
              variant="ghost"
            >
              <Trash2 className="size-4" />
              حذف کلید
            </Button>
          ) : null}
        </div>
      </Card>

      <Card title="وضعیت">
        <dl className="space-y-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">کلید ذخیره‌شده</dt>
            <dd className="flex items-center gap-2 font-medium">
              {config?.configured ? (
                <>
                  <KeyRound className="size-4 text-emerald-600 dark:text-emerald-400" />
                  {config.apiKeyHint || "ذخیره شده"}
                </>
              ) : (
                <>
                  <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
                  ندارد
                </>
              )}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">آخرین تأیید موفق</dt>
            <dd className="font-medium">
              {config?.verifiedAt ? fmtDate(config.verifiedAt) : "هرگز"}
            </dd>
          </div>
          {config?.verifyError ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">آخرین خطای تأیید</dt>
              <dd className="font-medium text-red-700 dark:text-red-300">{config.verifyError}</dd>
            </div>
          ) : null}
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">آخرین آینه‌برداری</dt>
            <dd className="font-medium">
              {config?.lastMirrorAt ? fmtDate(config.lastMirrorAt) : "هرگز"}
              {config?.lastMirrorError ? (
                <span className="ms-2 text-red-700 dark:text-red-300">{cmsErrorText(config.lastMirrorError)}</span>
              ) : null}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">رویدادهای ارسال‌شده به پایش</dt>
            <dd className="font-medium tabular-nums">
              {formatPersianNumber(config?.eventsShipped ?? 0)}
              {config?.lastEventsAt ? (
                <span className="ms-2 text-xs text-muted-foreground">{fmtDate(config.lastEventsAt)}</span>
              ) : null}
              {config?.lastEventsError ? (
                <span className="ms-2 text-red-700 dark:text-red-300">{cmsErrorText(config.lastEventsError)}</span>
              ) : null}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="اعتبارنامهٔ entitlement (صورتحساب)">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="شناسهٔ کلید امضا">
            <input
              className={inputClass}
              dir="ltr"
              disabled={!manage}
              onChange={(event) => setBillingKeyId(event.target.value)}
              placeholder={config?.billingEntitlementKeyId || "billing-key-id"}
              value={billingKeyId}
            />
          </Field>
          <Field
            hint={
              config?.billingEntitlementSecretHint
                ? `راز ذخیره شده (${config.billingEntitlementSecretHint}). خالی = بدون تغییر.`
                : "راز HMAC برای push entitlement"
            }
            label="راز امضا"
          >
            <input
              autoComplete="off"
              className={inputClass}
              dir="ltr"
              disabled={!manage}
              onChange={(event) => setBillingSecret(event.target.value)}
              type="password"
              value={billingSecret}
            />
          </Field>
        </div>
        {manage ? (
          <Button className="mt-3" disabled={busy} onClick={() => void save()} variant="ghost">
            ذخیرهٔ entitlement
          </Button>
        ) : null}
      </Card>

      <Card title="آزمون‌های زیرساخت سایت‌ساز">
        <p className="text-xs text-muted-foreground">
          درگاه پرداخت و ذخیرهٔ اشیا — همان endpointهایی که اپراتور سایت‌ساز استفاده می‌کند.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={busy || !config?.usable}
            onClick={() =>
              void api<{ error?: string; result?: unknown }>("/api/platform/cms/self-tests", {
                body: JSON.stringify({ kind: "payments", payload: {} }),
                method: "POST",
              }).then((res) =>
                res.ok ? setNotice("آزمون درگاه اجرا شد.") : setError(cmsErrorText(res.data.error)),
              )
            }
            variant="ghost"
          >
            آزمون درگاه‌ها
          </Button>
          <Button
            disabled={busy || !config?.usable}
            onClick={() =>
              void api<{ error?: string }>("/api/platform/cms/self-tests", {
                body: JSON.stringify({ kind: "storage", payload: {} }),
                method: "POST",
              }).then((res) =>
                res.ok ? setNotice("آزمون ذخیره اجرا شد.") : setError(cmsErrorText(res.data.error)),
              )
            }
            variant="ghost"
          >
            آزمون ذخیرهٔ اشیا
          </Button>
        </div>
      </Card>

      <Card title="کارهای پس‌زمینه">
        <div className="space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              checked={mirrorEnabled}
              className="mt-1 size-4"
              disabled={!manage}
              onChange={(event) => setMirrorEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>
              <span className="font-medium">آینه‌برداری دوره‌ای از سایت‌ها</span>
              <span className="mt-1 block text-xs leading-6 text-muted-foreground">
                فهرست و شمارش سایت‌ها را در این سرور نگه می‌دارد تا گزارش‌ها با یک پرس‌وجوی محلی
                پاسخ داده شوند و وقتی سایت‌ساز در دسترس نیست هم پاسخ بدهند.
              </span>
            </span>
          </label>

          <div className="max-w-xs">
            <Field label="بازهٔ آینه‌برداری (دقیقه)">
              <PersianNumberInput
                className={inputClass}
                disabled={!manage || !mirrorEnabled}
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                value={interval}
              />
            </Field>
          </div>

          <label className="flex items-start gap-3 text-sm">
            <input
              checked={logShippingEnabled}
              className="mt-1 size-4"
              disabled={!manage}
              onChange={(event) => setLogShippingEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>
              <span className="font-medium">ارسال رویدادهای سایت‌ساز به پایش</span>
              <span className="mt-1 block text-xs leading-6 text-muted-foreground">
                خوراک رویدادهای سایت‌ساز — تغییر وضعیت سایت، سفارش‌ها، خودآزمایی ناموفق درگاه‌ها و
                صدور کلید — را از روی نشانگر می‌خواند و در جریان لاگ همین سکو می‌نشاند. اگر
                جمع‌کنندهٔ لاگ تنظیم نشده باشد، هیچ درخواستی فرستاده نمی‌شود.
              </span>
            </span>
          </label>

          {manage ? (
            <Button disabled={busy} onClick={() => void save()} variant="ghost">
              ذخیرهٔ کارهای پس‌زمینه
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
