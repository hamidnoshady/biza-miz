"use client";

/**
 * Issue #1388 — «ثبت‌نام و ورود» in the Superadmin console.
 *
 * Four operational answers on one page:
 *
 *  1. **Is public registration open, and why?** The stored control, the
 *     effective gate (runtime or the deployment's environment fallback), and
 *     the maintenance pause with its message.
 *  2. **Can an authentication SMS leave right now?** Template, readiness,
 *     provider attention alerts and the last 24 hours of failures — never a
 *     key, a key hint or a raw provider code. This is separate from tenant
 *     messaging and Growth billing.
 *  3. **What does the funnel look like?** Stable event counts and the common
 *     failure categories for the last 30 days.
 *  4. **One account, safely.** Search by account id, masked by default; the
 *     unmasked contact details need `signup.inspect` and are audited.
 *
 * Persian RTL, the console's own primitives, skeletons while loading, and
 * explicit empty/error/unavailable states.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  StatCard,
  errorMessage,
  fmtDate,
  useCan,
} from "../ui";

interface SignupControls {
  publicSignupEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
}

interface SignupGate {
  enabled: boolean;
  reason: "enabled" | "administratively_disabled" | "maintenance" | "environment_disabled";
  source: "runtime" | "environment";
}

interface Funnel {
  windowDays: number;
  totals: Array<{ event: string; label: string; count: number }>;
  failures: Array<{ category: string; label: string; count: number }>;
  hasData: boolean;
}

interface SmsHealth {
  status: "ready" | "degraded" | "not_configured" | "unknown";
  configured: boolean;
  otpTemplate: string;
  fromEnvironment: boolean;
  updatedAt: string | null;
  lastSentAt: string | null;
  failures24h: number;
  failureBreakdown: Array<{ category: string; label: string; count: number }>;
  openAlerts: { critical: number; warning: number; info: number; total: number };
  alerts: Array<{ kind: string; severity: string; title: string; action: string }>;
}

interface SignupData {
  controls: SignupControls | null;
  readable: boolean;
  gate: SignupGate;
  environmentGateEnabled: boolean;
  funnel: Funnel;
  sms: SmsHealth;
}

interface AccountSummary {
  accountId: string;
  fullName: string;
  maskedPhone: string | null;
  maskedEmail: string | null;
  isActive: boolean;
  phoneVerified: boolean;
  emailVerified: boolean;
  createdAt: string;
  onboarding: { started: boolean; submitted: boolean; provisionedBusinessId: string | null };
  memberships: Array<{ businessId: string; businessName: string; isActive: boolean }>;
}

interface AccountContact {
  accountId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
}

const GATE_LABELS: Record<SignupGate["reason"], { label: string; tone: string }> = {
  enabled: { label: "باز", tone: "text-emerald-700 dark:text-emerald-300" },
  maintenance: { label: "توقف تعمیرات", tone: "text-amber-700 dark:text-amber-300" },
  administratively_disabled: { label: "بسته توسط مدیر", tone: "text-red-700 dark:text-red-300" },
  environment_disabled: { label: "بستهٔ استقرار", tone: "text-muted-foreground" },
};

const SMS_LABELS: Record<SmsHealth["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  ready: { label: "آمادهٔ ارسال", tone: "ok" },
  degraded: { label: "نیازمند بررسی", tone: "warn" },
  not_configured: { label: "تنظیم نشده", tone: "bad" },
  unknown: { label: "وضعیت نامشخص", tone: "neutral" },
};

const pct = (value: number, total: number): string => {
  if (total <= 0) return "—";
  return `${toPersianDigits(String(Math.round((value / total) * 100)))}٪`;
};

function errorText(code: string | undefined): string {
  switch (code) {
    case "invalid_account_id":
      return "شناسهٔ حساب معتبر نیست. شناسهٔ کامل حساب را وارد کنید.";
    case "account_not_found":
      return "حسابی با این شناسه پیدا نشد.";
    case "invalid_maintenance_message":
      return "متن پیام تعمیرات باید حداکثر ۵۰۰ نویسه باشد.";
    case "rate_limited":
      return "تعداد جست‌وجوهای شما زیاد بوده است. کمی بعد دوباره تلاش کنید.";
    default:
      return errorMessage(code);
  }
}

export default function PlatformSignupPage() {
  const can = useCan();
  const canManage = can("signup.manage");
  const canInspect = can("signup.inspect");

  const [data, setData] = useState<SignupData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [message, setMessage] = useState("");

  const [accountId, setAccountId] = useState("");
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState<AccountContact | null>(null);

  const load = useCallback(async () => {
    const result = await api<SignupData & { error?: string }>("/api/platform/signup");
    if (!result.ok) {
      setLoadError(errorText(result.data.error));
      return;
    }
    setLoadError(null);
    setData(result.data);
    setEnabled(result.data.controls?.publicSignupEnabled ?? result.data.gate.enabled);
    setMaintenance(result.data.controls?.maintenanceMode ?? false);
    setMessage(result.data.controls?.maintenanceMessage ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await api<{ controls?: SignupControls; gate?: SignupGate; error?: string }>(
      "/api/platform/signup",
      {
        method: "PUT",
        body: JSON.stringify({
          publicSignupEnabled: enabled,
          maintenanceMode: maintenance,
          maintenanceMessage: message.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setError(errorText(result.data.error));
      return;
    }
    setNotice("تنظیمات ثبت‌نام ذخیره و در تاریخچهٔ رویدادها ثبت شد.");
    await load();
  }

  async function searchAccount(event: FormEvent) {
    event.preventDefault();
    setAccountBusy(true);
    setError(null);
    setContact(null);
    setAccount(null);
    const result = await api<{ account?: AccountSummary; error?: string }>(
      `/api/platform/signup/accounts?accountId=${encodeURIComponent(accountId.trim())}`,
    );
    setAccountBusy(false);
    if (!result.ok) {
      setError(errorText(result.data.error));
      return;
    }
    setAccount(result.data.account ?? null);
  }

  async function reveal() {
    if (!account) return;
    setRevealBusy(true);
    setError(null);
    const result = await api<{ contact?: AccountContact; error?: string }>(
      "/api/platform/signup/accounts",
      {
        method: "POST",
        body: JSON.stringify({ accountId: account.accountId, reason: reason.trim() || null }),
      },
    );
    setRevealBusy(false);
    if (!result.ok) {
      setError(errorText(result.data.error));
      return;
    }
    setContact(result.data.contact ?? null);
    setNotice("جزئیات تماس نمایش داده شد و این دسترسی در تاریخچهٔ رویدادها ثبت شد.");
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-lg font-bold text-foreground">ثبت‌نام و ورود</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            کنترل ثبت‌نام عمومی، آمادگی پیامک ورود و قیف ثبت‌نام.
          </p>
        </header>
        <ErrorBox>{loadError}</ErrorBox>
        <Card title="وضعیت ثبت‌نام">
          <SkeletonRows rows={2} />
        </Card>
        <Card title="سرویس پیامک ورود">
          <SkeletonRows rows={2} />
        </Card>
      </div>
    );
  }

  const gateLabel = GATE_LABELS[data.gate.reason];
  const smsLabel = SMS_LABELS[data.sms.status];
  const totals = data.funnel.totals;
  const countOf = (event: string) => totals.find((row) => row.event === event)?.count ?? 0;
  const requested = countOf("otp_requested");
  const sent = countOf("otp_sent");
  const verified = countOf("otp_verified");
  const created = countOf("account_created");
  const started = countOf("onboarding_started");
  const provisioned = countOf("business_provisioned");

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">ثبت‌نام و ورود</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            باز یا بسته‌بودن ثبت‌نام عمومی، توقف تعمیرات، آمادگی پیامک ورود و قیف ثبت‌نام تا ساخت کسب‌وکار.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
          <p className="text-xs text-muted-foreground">وضعیت مؤثر</p>
          <p className={`mt-1 font-bold ${gateLabel.tone}`}>{gateLabel.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            منبع: {data.gate.source === "runtime" ? "تنظیم کنسول" : "درگاه استقرار"}
          </p>
        </div>
      </header>

      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>
      {!data.readable ? (
        <InfoBox>
          تنظیم ثبت‌نام در پایگاه داده خوانده نشد؛ تا رفع مشکل، درگاه استقرار
          {data.environmentGateEnabled ? " (باز)" : " (بسته)"} تعیین‌کننده است.
        </InfoBox>
      ) : null}

      <Card title="کنترل ثبت‌نام عمومی">
        <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="ثبت‌نام عمومی"
              hint="اعمال روی همهٔ درهای ثبت‌نام، در سمت سرور. پنهان‌کردن دکمه کافی نیست."
            >
              <select
                className={inputClass}
                value={enabled ? "yes" : "no"}
                disabled={!canManage || busy}
                onChange={(event) => setEnabled(event.target.value === "yes")}
              >
                <option value="no">بسته</option>
                <option value="yes">باز</option>
              </select>
            </Field>
            <Field
              label="حالت تعمیرات"
              hint="در حالت تعمیرات، ثبت‌نام تازه متوقف می‌شود اما ورود حساب‌های موجود باز می‌ماند."
            >
              <select
                className={inputClass}
                value={maintenance ? "yes" : "no"}
                disabled={!canManage || busy}
                onChange={(event) => setMaintenance(event.target.value === "yes")}
              >
                <option value="no">خاموش</option>
                <option value="yes">روشن</option>
              </select>
            </Field>
          </div>
          <Field
            label="پیام تعمیرات (اختیاری)"
            hint="برای کاربران نمایش داده می‌شود؛ حداکثر ۵۰۰ نویسه و بدون جزئیات فنی یا امنیتی."
          >
            <input
              className={inputClass}
              value={message}
              maxLength={500}
              disabled={!canManage || busy}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="ثبت‌نام موقتاً برای تعمیرات متوقف شده است."
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-6 text-muted-foreground">
              {data.controls?.updatedAt
                ? `آخرین تغییر: ${fmtDate(data.controls.updatedAt)}${
                    data.controls.updatedByName ? ` — ${data.controls.updatedByName}` : ""
                  }`
                : "هنوز از کنسول ذخیره نشده است؛ درگاه استقرار تعیین‌کننده است."}
            </p>
            {canManage ? (
              <Button type="submit" disabled={busy}>
                {busy ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">برای تغییر، دسترسی مدیریت ثبت‌نام لازم است.</p>
            )}
          </div>
        </form>
      </Card>

      <Card title="سرویس پیامک ورود">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              smsLabel.tone === "ok"
                ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : smsLabel.tone === "warn"
                  ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : smsLabel.tone === "bad"
                    ? "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300"
                    : "border-border bg-muted/40 text-muted-foreground"
            }`}>
              {smsLabel.label}
            </span>
            <span className="text-sm text-muted-foreground">
              {data.sms.configured
                ? data.sms.fromEnvironment
                  ? "کلید از متغیر محیطی استقرار خوانده می‌شود."
                  : "کلید در پایگاه داده و رمزنگاری‌شده است."
                : "هیچ کلید پیامکی تنظیم نشده است؛ کد ورود ارسال نمی‌شود."}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            الگوی کد: <span dir="ltr">{data.sms.otpTemplate || "—"}</span>
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatCard label="ارسال ۲۴ ساعت گذشته" value={toPersianDigits(String(sent))} tone="neutral" />
          <StatCard
            label="خطای ۲۴ ساعت گذشته"
            value={toPersianDigits(String(data.sms.failures24h))}
            tone={data.sms.failures24h > 0 ? "warn" : "ok"}
          />
          <StatCard
            label="هشدارهای باز سرویس"
            value={toPersianDigits(String(data.sms.openAlerts.total))}
            tone={data.sms.openAlerts.critical > 0 ? "bad" : data.sms.openAlerts.total > 0 ? "warn" : "ok"}
          />
        </div>

        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          پیامک ورود از حساب پیامک پلتفرم ارسال می‌شود و به کیف‌پول رشد هیچ کسب‌وکاری بدهکار نمی‌شود.
          {data.sms.lastSentAt ? ` آخرین ارسال موفق: ${fmtDate(data.sms.lastSentAt)}.` : ""}
          {data.sms.updatedAt ? ` آخرین تغییر تنظیمات: ${fmtDate(data.sms.updatedAt)}.` : ""}
        </p>

        {data.sms.failureBreakdown.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {data.sms.failureBreakdown.map((row) => (
              <span key={row.category} className="rounded-lg border border-border px-2.5 py-1 text-muted-foreground">
                {row.label}: {toPersianDigits(String(row.count))}
              </span>
            ))}
          </div>
        ) : null}

        {data.sms.alerts.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {data.sms.alerts.map((alert) => (
              <li key={`${alert.kind}:${alert.title}`} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <p className="font-medium text-foreground">{alert.title}</p>
                <p className="mt-1 text-xs leading-6 text-muted-foreground">{alert.action}</p>
              </li>
            ))}
          </ul>
        ) : null}

        {data.sms.status === "not_configured" ? (
          <p className="mt-3 text-xs leading-6 text-destructive">
            تا تنظیم کلید و الگو در «پیام‌رسانی»، هیچ کد ثبت‌نام یا ورودی ارسال نمی‌شود. کاربران پیام
            «ارسال پیامک انجام نشد» می‌بینند.
          </p>
        ) : null}
      </Card>

      <Card title={`قیف ثبت‌نام (${toPersianDigits(String(data.funnel.windowDays))} روز)`}>
        {!data.funnel.hasData ? (
          <EmptyState
            title="هنوز رویدادی ثبت نشده است."
            hint="با نخستین درخواست کد، شمارنده‌ها اینجا پر می‌شوند."
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="درخواست کد" value={toPersianDigits(String(requested))} hint={`ارسال موفق: ${toPersianDigits(String(sent))}`} />
              <StatCard label="کد تأییدشده" value={toPersianDigits(String(verified))} hint={`نرخ تأیید: ${pct(verified, requested)}`} />
              <StatCard label="حساب ساخته‌شده" value={toPersianDigits(String(created))} hint={`از درخواست: ${pct(created, requested)}`} />
              <StatCard label="کسب‌وکار ساخته‌شده" value={toPersianDigits(String(provisioned))} hint={`شروع راه‌اندازی: ${toPersianDigits(String(started))}`} />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">رویدادها</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[20rem] text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        <th className="py-2 text-start font-medium">رویداد</th>
                        <th className="py-2 text-start font-medium">تعداد</th>
                      </tr>
                    </thead>
                    <tbody>
                      {totals.map((row) => (
                        <tr key={row.event} className="border-t border-border">
                          <td className="py-2 pe-3">{row.label}</td>
                          <td className="py-2 tabular-nums">{toPersianDigits(String(row.count))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">دسته‌های خطا</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[20rem] text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        <th className="py-2 text-start font-medium">دسته</th>
                        <th className="py-2 text-start font-medium">تعداد</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.funnel.failures.map((row) => (
                        <tr key={row.category} className="border-t border-border">
                          <td className="py-2 pe-3">{row.label}</td>
                          <td className="py-2 tabular-nums">{toPersianDigits(String(row.count))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card title="جست‌وجوی حساب">
        <form onSubmit={searchAccount} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field
            label="شناسهٔ حساب (platform_users.id)"
            hint="جست‌وجو فقط با شناسهٔ کامل حساب انجام می‌شود؛ جزئیات تماس به‌صورت پیش‌فرض پوشیده است."
          >
            <input
              dir="ltr"
              className={inputClass}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              autoComplete="off"
            />
          </Field>
          <Button type="submit" disabled={accountBusy || !accountId.trim()}>
            {accountBusy ? "در حال جست‌وجو…" : "جست‌وجو"}
          </Button>
        </form>

        {account ? (
          <div className="mt-4 rounded-xl border border-border p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-foreground">{account.fullName}</p>
                <p dir="ltr" className="text-xs text-muted-foreground">{account.accountId}</p>
              </div>
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
                {account.isActive ? "فعال" : "غیرفعال"}
              </span>
            </div>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">موبایل</dt>
                <dd dir="ltr" className="mt-0.5">{account.maskedPhone ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">ایمیل</dt>
                <dd dir="ltr" className="mt-0.5">{account.maskedEmail ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تأییدها</dt>
                <dd className="mt-0.5">
                  موبایل: {account.phoneVerified ? "تأییدشده" : "تأییدنشده"} • ایمیل:{" "}
                  {account.emailVerified ? "تأییدشده" : "تأییدنشده"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تاریخ ساخت</dt>
                <dd className="mt-0.5">{fmtDate(account.createdAt)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              راه‌اندازی: {account.onboarding.started ? "شروع‌شده" : "شروع‌نشده"} •{" "}
              {account.onboarding.submitted ? "ارسال‌شده" : "ارسال‌نشده"} • کسب‌وکار:{" "}
              {account.onboarding.provisionedBusinessId ? "ساخته‌شده" : "ساخته‌نشده"}
              {account.memberships.length > 0
                ? ` • عضویت‌ها: ${account.memberships.map((m) => m.businessName).join("، ")}`
                : ""}
            </p>

            {canInspect ? (
              <div className="mt-4 border-t border-border pt-3">
                {contact ? (
                  <div className="grid gap-3 text-sm sm:grid-cols-2">
                    <p>
                      موبایل کامل: <span dir="ltr" className="font-medium">{contact.phone ?? "—"}</span>
                    </p>
                    <p>
                      ایمیل کامل: <span dir="ltr" className="font-medium">{contact.email ?? "—"}</span>
                    </p>
                    <p className="text-xs leading-6 text-muted-foreground sm:col-span-2">
                      این دسترسی در تاریخچهٔ رویدادهای پلتفرم ثبت شد.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <Field label="دلیل بررسی (اختیاری)" hint="در تاریخچه ثبت می‌شود.">
                      <input
                        className={inputClass}
                        value={reason}
                        maxLength={200}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="مثلاً: پیگیری تیکت پشتیبانی"
                      />
                    </Field>
                    <Button variant="ghost" onClick={reveal} disabled={revealBusy}>
                      {revealBusy ? "در حال نمایش…" : "نمایش جزئیات تماس"}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                نمایش جزئیات تماس به دسترسی ویژه و ثبت در تاریخچه نیاز دارد.
              </p>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
