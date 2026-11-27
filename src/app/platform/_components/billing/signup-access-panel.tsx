"use client";

/**
 * Superadmin → Billing → Services → Signup App Access (GitHub #1579).
 *
 * The one place a signup offer is configured. It writes policy *revisions*:
 * saving appends a version and retires the previous one, so an already-issued
 * grant keeps the terms it was made under. Nothing here activates, charges or
 * grants anything to a business — the panel records the offer that future
 * eligible activations are quoted under.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { platformFetch } from "@/lib/platform-client";
import { Button, Card, ErrorBox, Field, InfoBox, inputClass, useCan } from "../../ui";

interface PolicyRow {
  id: string;
  serviceKind: string;
  serviceKey: string;
  version: number;
  scope: "global" | "business_type" | "business";
  businessType: string | null;
  businessId: string | null;
  mode: "standard" | "free_days" | "free_indefinite" | "not_selectable";
  freeDays: number | null;
  waiveSetup: boolean;
  waiveRental: boolean;
  status: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  reason: string;
}

interface AppRow {
  kind: string;
  key: string;
  label: string;
  globalOffer: PolicyRow | null;
  previewOffer: PolicyRow | null;
}

interface Payload {
  apps: AppRow[];
  policies: PolicyRow[];
  businessTypes: string[];
  previewBusinessType: string | null;
  error?: string;
}

const MODE_LABELS: Record<PolicyRow["mode"], string> = {
  standard: "پرداخت استاندارد",
  free_days: "رایگان برای N روز",
  free_indefinite: "رایگان دائمی",
  not_selectable: "در ثبت‌نام قابل انتخاب نیست",
};

const SCOPE_LABELS: Record<PolicyRow["scope"], string> = {
  global: "همهٔ کسب‌وکارهای جدید",
  business_type: "یک نوع کسب‌وکار",
  business: "یک کسب‌وکار مشخص",
};

const REASON_TEXT: Record<string, string> = {
  invalid_free_days: "تعداد روز باید عددی صحیح بین ۱ تا ۳۶۵۰ باشد.",
  business_type_required: "برای این دامنه، انتخاب نوع کسب‌وکار الزامی است.",
  business_required: "برای این دامنه، شناسهٔ کسب‌وکار الزامی است.",
  scope_target_mismatch: "دامنه و مقصد انتخاب‌شده با هم سازگار نیستند.",
  unwaivable_mode: "حالت رایگان باید حداقل یکی از دو هزینه را معاف کند.",
  unknown_service: "این سرویس در فهرست کانونی وجود ندارد.",
};

function offerText(row: PolicyRow | null): string {
  if (!row) return "پرداخت استاندارد (بدون سیاست)";
  if (row.mode === "free_days") return `${toPersianDigits(row.freeDays ?? 0)} روز رایگان`;
  if (row.mode === "free_indefinite") return "رایگان دائمی";
  if (row.mode === "not_selectable") return "قابل انتخاب نیست";
  return "پرداخت استاندارد";
}

export function BillingSignupAccessTab() {
  const canManage = useCan()("billing.manage");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewType, setPreviewType] = useState("");

  const [service, setService] = useState("");
  const [scope, setScope] = useState<PolicyRow["scope"]>("global");
  const [businessType, setBusinessType] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [mode, setMode] = useState<PolicyRow["mode"]>("standard");
  const [freeDays, setFreeDays] = useState("30");
  const [waiveSetup, setWaiveSetup] = useState(true);
  const [waiveRental, setWaiveRental] = useState(true);
  const [reason, setReason] = useState("");

  const load = useCallback(async (type?: string) => {
    const query = type ? `?businessType=${encodeURIComponent(type)}` : "";
    const res = await platformFetch<Payload>(
      `/api/platform/services/signup-access${query}`,
    );
    if (res.ok && res.data) {
      setData(res.data);
      setService((current) => current || (res.data.apps[0] ? `${res.data.apps[0].kind}:${res.data.apps[0].key}` : ""));
    } else {
      setError("بارگذاری سیاست‌های دسترسی برنامه ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setError("");
    setInfo("");
    if (!service) {
      setError("یک برنامه را انتخاب کنید.");
      return;
    }
    const [kind, key] = service.split(":");
    setBusy(true);
    const res = await platformFetch<{ policy?: PolicyRow; error?: string }>(
      "/api/platform/services/signup-access",
      {
        method: "PUT",
        body: {
          kind,
          key,
          scope,
          businessType: scope === "business_type" ? businessType : null,
          businessId: scope === "business" ? businessId.trim() : null,
          mode,
          freeDays: mode === "free_days" ? Number(freeDays) : null,
          waiveSetup,
          waiveRental,
          reason,
        },
      },
    );
    setBusy(false);
    if (res.ok) {
      setInfo("سیاست ثبت و نسخهٔ جدید منتشر شد.");
      setReason("");
      await load(previewType || undefined);
    } else {
      setError(REASON_TEXT[res.code] ?? "ذخیرهٔ سیاست انجام نشد.");
    }
  }

  const apps = data?.apps ?? [];
  const history = (data?.policies ?? []).filter((row) => row.status !== "retired").slice(0, 24);

  return (
    <div className="space-y-4">
      <Card title="سیاست دسترسی برنامه در ثبت‌نام">
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          تعیین می‌کند هر برنامهٔ کانونی در ثبت‌نام چگونه ارائه شود: پرداخت استاندارد،
          رایگان برای N روز، رایگان دائمی یا غیرقابل انتخاب. اولویت به‌ترتیب: استثنای
          یک کسب‌وکار ← سیاست نوع کسب‌وکار ← پیش‌فرض سراسری ← تعرفهٔ تجاری معمول.
          دسترس‌پذیری فنی (صنف، استقرار، پلتفرم) همیشه بر هر تخفیف تجاری مقدم است و
          مصرف هوش مصنوعی، پیامک و ارائه‌دهنده جداگانه محاسبه می‌شود.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {info && <InfoBox>{info}</InfoBox>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="برنامه">
            <select
              className={inputClass}
              value={service}
              onChange={(e) => setService(e.target.value)}
            >
              {apps.map((app) => (
                <option key={`${app.kind}:${app.key}`} value={`${app.kind}:${app.key}`}>
                  {app.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="دامنه">
            <select
              className={inputClass}
              value={scope}
              onChange={(e) => setScope(e.target.value as PolicyRow["scope"])}
            >
              {(Object.keys(SCOPE_LABELS) as PolicyRow["scope"][]).map((value) => (
                <option key={value} value={value}>
                  {SCOPE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          {scope === "business_type" && (
            <Field label="نوع کسب‌وکار (کلید کانونی)">
              <select
                className={inputClass}
                dir="ltr"
                value={businessType}
                onChange={(e) => setBusinessType(e.target.value)}
              >
                <option value="">— انتخاب —</option>
                {(data?.businessTypes ?? []).map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {scope === "business" && (
            <Field label="شناسهٔ کسب‌وکار (UUID)">
              <input
                className={`${inputClass} font-mono text-xs`}
                dir="ltr"
                value={businessId}
                onChange={(e) => setBusinessId(e.target.value)}
              />
            </Field>
          )}
          <Field label="حالت تجاری">
            <select
              className={inputClass}
              value={mode}
              onChange={(e) => setMode(e.target.value as PolicyRow["mode"])}
            >
              {(Object.keys(MODE_LABELS) as PolicyRow["mode"][]).map((value) => (
                <option key={value} value={value}>
                  {MODE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          {mode === "free_days" && (
            <Field label="مدت رایگان (روز)">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={freeDays}
                onChange={(e) => setFreeDays(e.target.value)}
              />
            </Field>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={waiveSetup}
              onChange={(e) => setWaiveSetup(e.target.checked)}
            />
            معافیت هزینهٔ راه‌اندازی یک‌باره
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={waiveRental}
              onChange={(e) => setWaiveRental(e.target.checked)}
            />
            معافیت هزینهٔ فعال بودن (اجارهٔ زمانی)
          </label>
        </div>

        <Field label="دلیل تغییر (برای تاریخچهٔ حسابرسی)">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: کمپین راه‌اندازی آذرماه"
          />
        </Field>

        <div className="mt-3 flex items-center gap-3">
          <Button type="button" onClick={() => void save()} disabled={busy || !canManage}>
            {busy ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <SaveIcon className="size-4" aria-hidden="true" />
            )}
            ثبت نسخهٔ سیاست
          </Button>
          {!canManage && (
            <span className="text-xs text-muted-foreground">
              برای تغییر سیاست، دسترسی مدیریت صورت‌حساب لازم است.
            </span>
          )}
        </div>
      </Card>

      <Card title="وضعیت فعلی برنامه‌ها">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="پیش‌نمایش برای نوع کسب‌وکار">
            <select
              className={inputClass}
              dir="ltr"
              value={previewType}
              onChange={(e) => {
                setPreviewType(e.target.value);
                void load(e.target.value || undefined);
              }}
            >
              <option value="">— بدون پیش‌نمایش —</option>
              {(data?.businessTypes ?? []).map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-muted-foreground">
            پیش‌نمایش با همان موتور اولویت سمت سرور محاسبه می‌شود.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-2 text-right font-medium">برنامه</th>
                <th className="py-2 text-right font-medium">سیاست سراسری</th>
                {previewType && <th className="py-2 text-right font-medium">پیش‌نمایش</th>}
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={`${app.kind}:${app.key}`} className="border-t border-border">
                  <td className="py-2 text-foreground">{app.label}</td>
                  <td className="py-2 text-muted-foreground">{offerText(app.globalOffer)}</td>
                  {previewType && (
                    <td className="py-2 text-foreground">{offerText(app.previewOffer)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="نسخه‌های فعال سیاست">
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز سیاستی ثبت نشده است؛ همه‌چیز پرداخت استاندارد است.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-2 text-right font-medium">برنامه</th>
                  <th className="py-2 text-right font-medium">نسخه</th>
                  <th className="py-2 text-right font-medium">دامنه</th>
                  <th className="py-2 text-right font-medium">عرضه</th>
                  <th className="py-2 text-right font-medium">معافیت‌ها</th>
                  <th className="py-2 text-right font-medium">از تاریخ</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2 font-mono text-xs text-muted-foreground" dir="ltr">
                      {row.serviceKey}
                    </td>
                    <td className="py-2 tabular-nums text-foreground">
                      {toPersianDigits(row.version)}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {SCOPE_LABELS[row.scope]}
                      {row.businessType ? ` — ${row.businessType}` : ""}
                    </td>
                    <td className="py-2 text-foreground">{offerText(row)}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {[
                        row.waiveSetup ? "راه‌اندازی" : null,
                        row.waiveRental ? "اجاره" : null,
                      ]
                        .filter(Boolean)
                        .join("، ") || "—"}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {formatJalali(row.effectiveFrom, { withMonthName: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
