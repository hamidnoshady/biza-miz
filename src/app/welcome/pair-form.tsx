"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  classifyConnectionCode,
  normalizeServerAddress,
} from "@/lib/connection-code";
import { toLatinDigits } from "@/lib/digits";

/** Every failure this flow can produce, in the owner's language. */
const ERROR_MESSAGES: Record<string, string> = {
  code_not_found:
    "این کد در سرور بالا پیدا نشد. مطمئن شوید کد را از همان حساب ابری کپی کرده‌اید.",
  code_expired: "این کد منقضی شده است. در پنل ابری یک کد تازه بسازید.",
  code_already_redeemed:
    "این کد قبلاً استفاده شده است. در پنل ابری کد تازه بسازید.",
  code_revoked: "این کد لغو شده است. در پنل ابری کد تازه بسازید.",
  remote_unreachable:
    "سرور ابری در این آدرس پاسخ نداد. آدرس و اتصال اینترنت را بررسی کنید.",
  not_a_pos_server:
    "این آدرس به سامانهٔ فروش شما نمی‌رسد. آدرسی را وارد کنید که با آن وارد پنل ابری می‌شوید.",
  remote_not_initialized: "این آدرس هنوز کسب‌وکاری روی آن ساخته نشده است.",
  snapshot_invalid: "داده‌های دریافتی معتبر نیستند. با پشتیبانی تماس بگیرید.",
  missing_fields: "آدرس سرور و کد اتصال را وارد کنید.",
  invalid_url: "آدرس سرور معتبر نیست.",
  // The three shapes classifyConnectionCode can report back from the server,
  // for a value that reached it despite the client-side check below.
  code_sync_token: "این مقدار یک «توکن همگام‌سازی» است، نه کد اتصال دسکتاپ.",
  code_api_key: "این مقدار یک کلید API توسعه‌دهنده است، نه کد اتصال دسکتاپ.",
  code_bad_length: "کد اتصال باید ۱۲ نویسه باشد (مثل ABCD-EFGH-JKLM).",
  code_bad_charset: "کد اتصال شامل نویسه‌های نامعتبر است.",
  code_empty: "کد اتصال را وارد کنید.",
};

/**
 * What to say about a pasted value *before* spending the code on a round trip.
 *
 * The `sync_token` case is the whole reason this exists: «ساخت توکن» in the
 * cloud dashboard's sync tab mints a `POS1-…` token for the server-to-server
 * channel, and it was the only generator an owner could find, so it is what
 * they pasted here — and all the app said was that the code was invalid. It
 * now says which credential this is and where the right one lives.
 */
const CODE_HINTS: Record<string, string> = {
  sync_token:
    "این یک «توکن همگام‌سازی سرور» است (POS1-…)، نه کد اتصال دسکتاپ. در پنل ابری به بخش «اتصال‌ها → برنامه دسکتاپ» بروید و «ساخت کد اتصال» را بزنید.",
  api_key: "این یک کلید API توسعه‌دهنده است (posk_live_…)، نه کد اتصال دسکتاپ.",
  bad_length:
    "کد اتصال ۱۲ نویسه است و معمولاً به شکل ABCD-EFGH-JKLM نمایش داده می‌شود.",
  bad_charset:
    "این کد نویسه‌های نامعتبر دارد. آن را دوباره از پنل ابری کپی کنید.",
};

type ProbeState =
  | { kind: "idle" }
  | { kind: "ok"; url: string }
  | { kind: "error"; text: string };

export function PairForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  // Deliberately empty rather than pre-filled with a platform address: since
  // Phase 23 every business is served from its own origin, so there is no
  // address that is right for everyone — and a wrong pre-filled one reads as
  // an instruction. The right value is the one in the owner's address bar
  // when they are signed into the cloud panel, which the panel also shows
  // them next to the code.
  const [remoteUrl, setRemoteUrl] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [pairedOwnerId, setPairedOwnerId] = useState("");
  /** Pairing snapshot committed, but the login-credential plane not fully converged yet. */
  const [identitySyncPending, setIdentitySyncPending] = useState(false);
  const [offlinePin, setOfflinePin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  const codeKind = classifyConnectionCode(code);
  const codeHint = CODE_HINTS[codeKind];
  const addressPreview = normalizeServerAddress(remoteUrl);

  async function testConnection() {
    setProbing(true);
    setError("");
    setProbe({ kind: "idle" });
    try {
      const res = await fetch("/api/setup/pair/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
      };
      if (res.ok && data.ok) setProbe({ kind: "ok", url: data.url ?? "" });
      else
        setProbe({
          kind: "error",
          text: ERROR_MESSAGES[data.error ?? ""] ?? "آزمایش اتصال ناموفق بود.",
        });
    } catch {
      setProbe({ kind: "error", text: ERROR_MESSAGES.remote_unreachable });
    } finally {
      setProbing(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (codeKind !== "pairing_code") {
      setError(codeHint ?? ERROR_MESSAGES.code_empty);
      return;
    }
    setBusy(true);
    setError("");

    const res = await fetch("/api/setup/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl, code }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      ownerUserId?: string;
      requiresOfflineCredential?: boolean;
      identitySyncPending?: boolean;
    };
    if (res.ok) {
      if (data.requiresOfflineCredential && data.ownerUserId) {
        setPairedOwnerId(data.ownerUserId);
        // The pairing request now reconciles the credential/PIN plane itself;
        // this flag is set when that pass did not fully converge (cloud
        // briefly unavailable, or a PIN still missing), so the wizard can say
        // so instead of implying everything is done.
        setIdentitySyncPending(Boolean(data.identitySyncPending));
        setBusy(false);
      } else router.replace("/dashboard");
      return;
    }

    setBusy(false);
    if (data.error === "already_initialized") {
      router.replace("/login");
      return;
    }
    setError(
      ERROR_MESSAGES[data.error ?? ""] ?? "اتصال انجام نشد. دوباره تلاش کنید.",
    );
  }

  if (pairedOwnerId) return (
    <div className={`w-full max-w-md ${cardClass} p-8`}>
      <h1 className="text-2xl font-bold">رمز ورود آفلاین این دستگاه</h1>
      {/* The old copy claimed the cloud password was never copied. Since the
          credential endpoint replicates supported global login material (the
          password hash, TOTP and recovery codes, plus staff PINs), that claim
          is wrong; what this step genuinely adds is a device-local Owner PIN
          that stays valid offline and that a later credential sync never
          overwrites. */}
      <p className="mt-2 text-sm text-muted-foreground">برای ورود هنگام قطع اینترنت، یک رمز عددی مخصوص همین دستگاه بسازید. اطلاعات ورود پشتیبانی‌شدهٔ حساب ابری نیز پس از همگام‌سازی هویت در حالت Hybrid روی این دستگاه قابل استفاده خواهد بود.</p>
      {identitySyncPending ? (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          اطلاعات ورود کارکنان هنوز کامل دریافت نشده است. پس از پایان راه‌اندازی، در «تنظیمات ← اتصال و همگام‌سازی» گزینهٔ «همگام‌سازی دوباره» را بزنید.
        </div>
      ) : null}
      {error ? <div className="mt-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</div> : null}
      <form className="mt-5 space-y-4" onSubmit={async(e)=>{e.preventDefault();if(!/^\d{4,12}$/.test(offlinePin)){setError("رمز عددی باید ۴ تا ۱۲ رقم باشد.");return;}if(offlinePin!==confirmPin){setError("تکرار رمز با رمز اصلی یکسان نیست.");return;}setBusy(true);const response=await fetch(`/api/team/${pairedOwnerId}/credentials`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:offlinePin})});if(response.ok){router.replace("/dashboard");return;}const result=await response.json().catch(()=>({}));setError(ERROR_MESSAGES[result.error]??"ثبت رمز آفلاین ناموفق بود.");setBusy(false);}}>
        <label className="block"><span className="mb-1 block text-sm font-medium">رمز عددی جدید</span><input autoFocus required dir="ltr" inputMode="numeric" maxLength={12} className="w-full rounded-lg border border-input px-3 py-2 text-center text-xl tracking-[.3em]" value={offlinePin} onChange={e=>setOfflinePin(toLatinDigits(e.target.value).replace(/\D/g,""))}/></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">تکرار رمز</span><input required dir="ltr" inputMode="numeric" maxLength={12} className="w-full rounded-lg border border-input px-3 py-2 text-center text-xl tracking-[.3em]" value={confirmPin} onChange={e=>setConfirmPin(toLatinDigits(e.target.value).replace(/\D/g,""))}/></label>
        <button disabled={busy} className="min-h-11 w-full rounded-lg bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">{busy?"در حال ثبت…":"ثبت رمز و ورود"}</button>
      </form>
    </div>
  );

  return (
    <div className={`w-full max-w-md ${cardClass} p-8`}>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex min-h-10 items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        ← بازگشت
      </button>
      <h1 className="mb-1 text-2xl font-bold">اتصال به پلتفرم آنلاین</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        هر دو مقدار زیر را از حساب ابری خودتان بردارید: وارد پنل ابری شوید، به
        «اتصال‌ها → برنامه دسکتاپ» بروید، آدرس نمایش‌داده‌شده را کپی کنید و
        دکمهٔ «ساخت کد اتصال» را بزنید.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            آدرس سرور *
          </span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30"
            dir="ltr"
            value={remoteUrl}
            onChange={(e) => {
              setRemoteUrl(e.target.value);
              setProbe({ kind: "idle" });
            }}
            placeholder="mybusiness.example.com"
            required
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            همان آدرسی که با آن وارد پنل ابری می‌شوید. کپی‌کردن نوار آدرس مرورگر
            هم کافی است.
          </span>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={testConnection}
              disabled={probing || !remoteUrl.trim()}
              className="rounded-lg border border-input px-3 py-1.5 text-xs font-medium hover:border-primary disabled:opacity-50 flex items-center justify-center gap-1.5 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              {probing ? "در حال آزمایش…" : "آزمایش اتصال"}
            </button>
            {probe.kind === "ok" ? (
              <span
                className="text-xs text-emerald-600 dark:text-emerald-400"
                dir="ltr"
              >
                ✓ {probe.url}
              </span>
            ) : null}
            {probe.kind === "error" ? (
              <span className="text-xs text-destructive">{probe.text}</span>
            ) : null}
            {probe.kind === "idle" &&
            addressPreview.ok &&
            addressPreview.url !== remoteUrl.trim() ? (
              <span className="text-xs text-muted-foreground" dir="ltr">
                {addressPreview.url}
              </span>
            ) : null}
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            کد اتصال *
          </span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            required
          />
          {codeHint ? (
            <span className="mt-1 block text-xs text-destructive">
              {codeHint}
            </span>
          ) : null}
        </label>
        <button
          type="submit"
          disabled={busy || codeKind !== "pairing_code"}
          className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-transparent bg-primary px-5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/80 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
        >
          {busy ? "در حال دریافت تنظیمات…" : "اتصال و دریافت تنظیمات"}
        </button>
      </form>
    </div>
  );
}
