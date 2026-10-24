"use client";

/**
 * درگاه‌های پرداخت و قوانین صورت‌حساب — the payment-gateway configuration
 * plus the billing rules that govern it. Only the two gateways that really
 * exist are offered (زرین‌پال + کارت به کارت); the merchant id is masked on
 * read and never leaves the server in full. The rules card states the
 * invariants the billing domain enforces (canonical money, sequential invoice
 * numbers, server-authoritative verification, no cross-gateway retries) so the
 * operator knows what the system will and will not do.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2Icon, SaveIcon, ShieldCheckIcon } from "lucide-react";
import { toLatinDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  useCan,
} from "../../ui";

interface GatewayConfig {
  gateway: "manual" | "zarinpal";
  merchantIdSet: boolean;
  merchantIdHint: string;
  sandbox: boolean;
  callbackUrl: string;
  currency: "IRR" | "IRT";
}

export function BillingGatewaysTab() {
  const can = useCan();
  const canManage = can("gateways.manage") || can("billing.manage");
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [gateway, setGateway] = useState<"manual" | "zarinpal">("manual");
  const [merchantId, setMerchantId] = useState("");
  const [sandbox, setSandbox] = useState(true);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [currency, setCurrency] = useState<"IRR" | "IRT">("IRR");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ config: GatewayConfig; error?: string }>(
      "/api/platform/billing/config",
    );
    if (ok) {
      setConfig(data.config);
      setGateway(data.config.gateway);
      setMerchantId("");
      setSandbox(data.config.sandbox);
      setCallbackUrl(data.config.callbackUrl);
      setCurrency(data.config.currency);
    } else {
      setError(data.error ?? "بارگذاری تنظیمات درگاه ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    const { ok, data } = await api<{ config: GatewayConfig; error?: string }>(
      "/api/platform/billing/config",
      {
        method: "PUT",
        body: JSON.stringify({
          gateway,
          // Empty string clears; a value replaces. The field starts empty and
          // shows the stored hint, so a no-op save keeps the stored id.
          merchantId: merchantId.trim() === "" ? undefined : merchantId.trim(),
          sandbox,
          callbackUrl,
          currency,
        }),
      },
    );
    setBusy(false);
    if (ok) {
      setConfig(data.config);
      setGateway(data.config.gateway);
      setMerchantId("");
      setSandbox(data.config.sandbox);
      setCallbackUrl(data.config.callbackUrl);
      setCurrency(data.config.currency);
      setInfo("تنظیمات درگاه ذخیره شد و در تاریخچه تغییرات ثبت گردید.");
    } else {
      setError(data.error === "bad_request" ? "مقادیر ارسالی معتبر نیستند." : data.error ?? "ذخیره انجام نشد.");
    }
  }

  if (!config) {
    return (
      <Card title="درگاه‌های پرداخت">
        {error ? <ErrorBox>{error}</ErrorBox> : <SkeletonRows rows={5} />}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <Card title="درگاه پرداخت فعال">
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="درگاه" hint="فقط درگاه‌های واقعاً پشتیبانی‌شده؛ درگاه ساختگی وجود ندارد.">
              <select
                className={inputClass}
                value={gateway}
                onChange={(e) => setGateway(e.target.value === "zarinpal" ? "zarinpal" : "manual")}
                disabled={!canManage}
              >
                <option value="zarinpal">زرین‌پال (پرداخت آنلاین)</option>
                <option value="manual">کارت به کارت (تأیید دستی مدیر)</option>
              </select>
            </Field>
            <Field
              label={`شناسهٔ پذیرنده${config.merchantIdSet ? ` (فعلی: ${config.merchantIdHint})` : ""}`}
              hint={
                config.merchantIdSet
                  ? "برای تغییر مقدار جدید را وارد کنید؛ خالی بماند یعنی بدون تغییر."
                  : "برای درگاه زرین‌پال الزامی است."
              }
            >
              <input
                className={inputClass}
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
                disabled={!canManage || gateway === "manual"}
                placeholder={config.merchantIdSet ? "••••••••" : "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"}
                autoComplete="off"
                dir="ltr"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="آدرس بازگشت (Callback)" hint="نشانی کانُنیکال بازگشت درگاه — باید HTTPS باشد و به /api/billing/payments/callback ختم شود (پشتیبانی شده). نشانی قبلی /api/billing/payments/callback تحت فضای tenant پشتیبانی نمی‌شود.">
              <input
                className={inputClass}
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                disabled={!canManage || gateway === "manual"}
                dir="ltr"
                placeholder="https://app.example.com/api/billing/payments/callback"
              />
              {callbackUrl && !callbackUrl.includes("/api/billing/payments/callback") ? <p className="mt-1 text-xs text-amber-600">نشانی بازگشت باید به <code>/api/billing/payments/callback</code> اشاره کند — مسیر tenant پشتیبانی نمی‌شود.</p> : null}
            </Field>
            <Field label="واحد پول درگاه" hint="نظام داخلی همیشه ریال است؛ انتخاب تومان صرفاً نمایش است و مبلغ ارسالی به درگاه همیشه ریال محاسبه می‌شود (۱۰× اختلاف بدون تبدیل ممنوع).">
              <select
                className={inputClass}
                value={currency}
                onChange={(e) => setCurrency(e.target.value === "IRT" ? "IRT" : "IRR")}
                disabled={!canManage}
              >
                <option value="IRR">ریال (IRR) — توصیه‌شده</option>
                <option value="IRT">تومان (IRT) — فقط نمایش، ارسال همیشه ریال</option>
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={sandbox}
              onChange={(e) => setSandbox(e.target.checked)}
              disabled={!canManage}
              className="size-4"
            />
            حالت آزمایشی (Sandbox)
            <span className="text-xs text-muted-foreground">
              — در حالت آزمایشی، تراکنش‌های زرین‌پال در محیط آزمون ایجاد می‌شوند و پول واقعی جابه‌جا نمی‌شود.
            </span>
          </label>
          {canManage && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
                ذخیرهٔ تنظیمات درگاه
              </Button>
              {config.merchantIdSet && (
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    const { ok, data } = await api<{ config: GatewayConfig; error?: string }>(
                      "/api/platform/billing/config",
                      { method: "PUT", body: JSON.stringify({ merchantId: "" }) },
                    );
                    setBusy(false);
                    if (ok) {
                      setConfig(data.config);
                      setGateway(data.config.gateway);
                      setSandbox(data.config.sandbox);
                      setCallbackUrl(data.config.callbackUrl);
                      setCurrency(data.config.currency);
                      setMerchantId("");
                      setInfo("شناسهٔ پذیرنده حذف شد.");
                    } else {
                      setError(data.error ?? "حذف شناسه انجام نشد.");
                    }
                  }}
                >
                  حذف شناسهٔ پذیرنده
                </Button>
              )}
            </div>
          )}
        </form>
      </Card>

      <Card title="قوانین و تنظیمات صورت‌حساب">
        <ul className="space-y-3 text-sm text-foreground">
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>واحد پول مبنا، ریال است.</strong> همهٔ مبالغ به‌صورت عدد صحیح ریال ذخیره می‌شوند
              (۱ تومان = {toLatinDigits("10")} ریال) و هیچ‌جا از عدد اعشاری استفاده نمی‌شود؛ رابط کاربری مبالغ را به
              تومان نمایش می‌دهد.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>شماره‌گذاری فاکتورها ترتیبی است.</strong> هر فاکتور هنگام صدور شمارهٔ
              <span className="mx-1 font-mono" dir="ltr">INV-YYYYMM-####</span>
              می‌گیرد (دنباله از ابتدای هر ماه) و هرگز تغییر نمی‌کند؛ ردیف‌های فاکتور در لحظهٔ صدور ثبت (snapshot)
              می‌شوند و با تغییر تعرفه‌ها دوباره قیمت نمی‌خورند.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>تأیید پرداخت فقط سمت سرور.</strong> اعتبار هر پرداخت را فقط پاسخ معتبر درگاه (واسط پرداخت) یا
              بازبینی مدیر تعیین می‌کند؛ دنباله‌کردن وبکوک‌ها idempotent است و تأیید تکراری هیچ اعتبار اضافه‌ای
              ثبت نمی‌کند.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>پرداخت دستی همان مسیر فعال‌سازی را طی می‌کند.</strong> تأیید کارت‌به‌کارت در صف بازبینی
              (تب «پرداخت‌ها») دقیقاً همان settle و فعال‌سازیِ پرداخت درگاهی را اجرا می‌کند — مسیر پول جدا و
              موازی وجود ندارد.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>تلاش مجدد روی درگاه دیگر ممنوع.</strong> اگر پرداختی شکست بخورد، سیستم خودش همان پرداخت را
              روی درگاه دیگری retry نمی‌کند (خطر کسر دوباره)؛ کسب‌وکار پرداخت جدیدی آغاز می‌کند.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>بازپرداخت پشتیبانی نمی‌شود.</strong> تا زمانی که بازگشت وجه به‌صورت سرتاسری پیاده نشود،
              ابزاری برای آن وجود ندارد؛ تنظیم دستی کیف پول (با ثبت دلیل و در تاریخچه) جایگزین است.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>دفتر کیف پول تغییرناپذیر است.</strong> هر تراکنش فقط یک ردیف اضافه می‌کند؛ ردیف‌ها ویرایش یا
              حذف نمی‌شوند و مانده همیشه مجموع تراکنش‌هاست.
            </span>
          </li>
          <li className="flex gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <strong>پلن‌های تاریخی حذف نمی‌شوند.</strong> پلن استفاده‌شده فقط بازنشسته (retired) می‌شود تا
              فاکتورها و اشتراک‌های گذشته قابل فهم بمانند؛ حذف کامل فقط برای پیش‌نویسِ استفاده‌نشده مجاز است.
            </span>
          </li>
        </ul>
      </Card>
    </div>
  );
}
