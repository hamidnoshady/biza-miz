"use client";

/**
 * The messaging console — the TECHNICAL half only (migration 0176's ownership
 * split): providers, credentials, sender lines and the master send switch.
 * The commercial half — per-segment/per-send rates, credit packages and the
 * top-up review queue — is read-only here and managed from the Billing
 * Control Center (`/platform/billing?tab=usage` and `?tab=payments`), the one
 * writable path. Credentials never travel back to the browser.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { formatPersianNumber } from "@/lib/digits";
import { tomanLabel } from "@/lib/platform-money";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, PlatformPageSkeleton, useCan } from "../ui";
import { ManagedSmsAccountsCard } from "./managed-accounts-card";

interface PublicConfig {
  enabled: boolean;
  smsProvider: "kavenegar" | "noop";
  emailProvider: "smtp" | "noop";
  kavenegarConfigured: boolean;
  smtpConfigured: boolean;
  kavenegarSender: string;
  kavenegarKeyHint: string | null;
  smtpHost: string;
  smtpFrom: string;
  rate: { smsRialPerSegment: number; emailRialPerSend: number };
  configured: boolean;
}
interface CreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
}
interface TopUpRequest {
  id: string;
  businessId: string;
  businessName: string | null;
  packageName: string;
  creditAmountRial: number;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}
interface MessagingData { config: PublicConfig; packages: CreditPackage[]; requests: TopUpRequest[]; error?: string }

const date = (value: string) => new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export default function PlatformMessagingPage() {
  const canManage = useCan()("messaging.manage");
  const [data, setData] = useState<MessagingData | null>(null);
  const [draft, setDraft] = useState<PublicConfig | null>(null);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const result = await api<MessagingData>("/api/platform/messaging");
    if (!result.ok) {
      setError(result.data.error ?? "دریافت تنظیمات پیام ممکن نشد.");
      return;
    }
    setData(result.data);
    setDraft(result.data.config);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy("config"); setError(""); setNotice("");
    const result = await api<{ error?: string }>("/api/platform/messaging", {
      method: "POST",
      body: JSON.stringify({
        action: "config", enabled: draft.enabled, smsProvider: draft.smsProvider, emailProvider: draft.emailProvider,
        kavenegarSender: draft.kavenegarSender, kavenegarApiKey: key || undefined,
        smtpHost: draft.smtpHost, smtpFrom: draft.smtpFrom, smtpPassword: password || undefined,
      }),
    });
    setBusy("");
    if (!result.ok) { setError(result.data.error ?? "ذخیرهٔ تنظیمات ممکن نشد."); return; }
    setKey(""); setPassword("");
    setNotice("تنظیمات فنی ذخیره شد.");
    await load();
  }

  if (!data || !draft) return <PlatformPageSkeleton />;

  const pendingRequests = data.requests.filter((r) => r.status === "pending");

  return <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
    <header>
      <h1 className="text-xl font-bold">پیام‌رسانی</h1>
      <p className="mt-1 text-sm text-muted-foreground">اتصال فنی پیامک و ایمیل: کلیدهای پلتفرم و خطوط ارسال. کلیدها هرگز دوباره نمایش داده نمی‌شوند.</p>
    </header>
    <ErrorBox>{error}</ErrorBox>{notice ? <InfoBox>{notice}</InfoBox> : null}

    {/* Issue #902: one row per business, with the provider's account state and
        an internal funding journal. Tenant screens never see any of it. */}
    <ManagedSmsAccountsCard canManage={canManage} />

    <Card title="وضعیت سرویس">
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <p>ارسال: <b>{draft.enabled ? "روشن" : "خاموش"}</b></p>
        <p>پیامک: <b>{draft.kavenegarConfigured ? "کلید تنظیم شده" : "بدون کلید"}</b></p>
        <p>ایمیل: <b>{draft.smtpConfigured ? "SMTP تنظیم شده" : "بدون SMTP"}</b></p>
      </div>
    </Card>

    <Card title="ارائه‌دهنده و اتصال">
      <form onSubmit={saveConfig} className="grid gap-3 sm:grid-cols-2">
        <Field label="فعال بودن ارسال"><select className={inputClass} value={draft.enabled ? "yes" : "no"} disabled={!canManage} onChange={(e) => setDraft({ ...draft, enabled: e.target.value === "yes" })}><option value="no">خاموش</option><option value="yes">روشن</option></select></Field>
        <Field label="خط پیامک کاوه‌نگار"><input className={inputClass} value={draft.kavenegarSender} disabled={!canManage} onChange={(e) => setDraft({ ...draft, kavenegarSender: e.target.value })} /></Field>
        <Field label={`کلید کاوه‌نگار ${draft.kavenegarKeyHint ?? ""}`} hint="خالی بگذارید تا کلید قبلی حفظ شود."><input className={inputClass} type="password" autoComplete="new-password" value={key} disabled={!canManage} onChange={(e) => setKey(e.target.value)} /></Field>
        <Field label="میزبان SMTP"><input className={inputClass} dir="ltr" value={draft.smtpHost} disabled={!canManage} onChange={(e) => setDraft({ ...draft, smtpHost: e.target.value })} /></Field>
        <Field label="فرستندهٔ ایمیل"><input className={inputClass} dir="ltr" value={draft.smtpFrom} disabled={!canManage} onChange={(e) => setDraft({ ...draft, smtpFrom: e.target.value })} /></Field>
        <Field label="گذرواژه SMTP" hint="خالی بگذارید تا گذرواژهٔ قبلی حفظ شود."><input className={inputClass} type="password" autoComplete="new-password" value={password} disabled={!canManage} onChange={(e) => setPassword(e.target.value)} /></Field>
        {canManage ? <div className="sm:col-span-2"><Button type="submit" disabled={busy === "config"}>{busy === "config" ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />} ذخیرهٔ تنظیمات فنی</Button></div> : null}
      </form>
    </Card>

    <Card title="تعرفهٔ پیام (فقط نمایش)">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <p>هزینهٔ هر قطعه پیامک: <b>{tomanLabel(draft.rate.smsRialPerSegment)}</b></p>
        <p>هزینهٔ هر ایمیل: <b>{tomanLabel(draft.rate.emailRialPerSend)}</b></p>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        تعرفه‌ها فقط از <Link href="/platform/billing?tab=usage" className="underline">مرکز صورت‌حساب ← تعرفه مصرف و اعتبار</Link> تغییر می‌کنند تا یک منبع واحد برای قیمت‌ها وجود داشته باشد.
        سیاست قیمت‌گذاری خدمات مدیریت‌شده (حاشیهٔ سود، سربار، پله‌های حجمی، استثنای کسب‌وکار، مالیات و سهمیهٔ رایگان) نیز در همان صفحه و به‌صورت نسخه‌دار منتشر می‌شود.
      </p>
    </Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="بسته‌های اعتبار (فقط نمایش)">
        <div className="space-y-2">{data.packages.length ? data.packages.map((pkg) => <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm" key={pkg.id}><span>{pkg.name}{!pkg.isActive ? " • غیرفعال" : ""}</span><span className="tabular-nums">{tomanLabel(pkg.creditAmountRial)} اعتبار • {tomanLabel(pkg.priceRial)}</span></div>) : <p className="text-sm text-muted-foreground">هنوز بسته‌ای ساخته نشده است.</p>}</div>
        <p className="mt-3 text-xs text-muted-foreground">
          تعریف و فعال/غیرفعال‌کردن بسته‌ها در <Link href="/platform/billing?tab=usage" className="underline">مرکز صورت‌حساب</Link> انجام می‌شود.
        </p>
      </Card>
      <Card title={`درخواست‌های شارژ${pendingRequests.length ? ` (${formatPersianNumber(pendingRequests.length)} در انتظار)` : ""}`}>
        <div className="space-y-2">{data.requests.length ? data.requests.slice(0, 8).map((request) => <div key={request.id} className="rounded-lg border border-border px-3 py-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>{request.businessName ?? request.businessId} • {request.packageName}</span><b>{request.status === "pending" ? "در انتظار" : request.status === "approved" ? "تأیید شد" : "رد شد"}</b></div><p className="mt-1 text-xs text-muted-foreground">{tomanLabel(request.creditAmountRial)} • {date(request.createdAt)}</p></div>) : <p className="text-sm text-muted-foreground">درخواستی وجود ندارد.</p>}</div>
        {pendingRequests.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            بازبینی و تأیید درخواست‌ها در <Link href="/platform/billing?tab=payments" className="underline">مرکز صورت‌حساب ← پرداخت‌ها</Link> انجام می‌شود؛ تأیید همان مسیر فعال‌سازی پرداخت را طی می‌کند.
          </p>
        )}
      </Card>
    </div>
  </div>;
}
