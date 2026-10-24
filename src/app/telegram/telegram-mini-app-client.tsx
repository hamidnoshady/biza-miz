"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorBox, InfoBox } from "@/app/dashboard/ui";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { MfaStep, type MfaMethod } from "@/components/auth/mfa-step";

interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  openLink(url: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

interface TelegramSessionResponse {
  error?: string;
  canonicalUrl?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethod?: MfaMethod | null;
  availableMethods?: MfaMethod[];
}

function errorMessage(error: string | undefined): string {
  switch (error) {
    case "account_unlinked_or_membership_unavailable":
      return "این حساب تلگرام هنوز برای این کسب‌وکار به هویت Biza Miz پیوند نشده است. در مرورگر وارد حساب فعلی شوید، از «تنظیمات ← اتصال‌های فنی ← تلگرام» پیوند را انجام دهید و سپس از ربات دوباره مینی‌اپ را باز کنید.";
    case "business_host_required":
    case "canonical_host_required":
      return "این نشانی فضای کاری معتبر نیست. مینی‌اپ را از دکمهٔ کسب‌وکار در ربات رسمی باز کنید.";
    case "business_unavailable":
      return "این کسب‌وکار فعال نیست یا دیگر به حساب شما تعلق ندارد.";
    case "feature_disabled":
    case "cloud_only":
    case "deployment_unsupported":
      return "مینی‌اپ تلگرام فقط برای کسب‌وکار ابریِ مجاز در دسترس است؛ دسترسی محلی یا ترکیبی از این مسیر فعال نمی‌شود.";
    case "telegram_disabled":
    case "telegram_not_configured":
      return "ربات رسمی تلگرام در این استقرار فعال یا پیکربندی نشده است.";
    case "telegram_init_data_replayed":
      return "این درخواست ورود قبلاً استفاده شده است. مینی‌اپ را ببندید و از ربات رسمی دوباره باز کنید تا درخواست تازه‌ای ساخته شود.";
    case "expired_init_data":
      return "درخواست تلگرام منقضی شده است. مینی‌اپ را ببندید و دوباره از ربات رسمی باز کنید.";
    case "private_chat_required":
      return "مینی‌اپ برای استفادهٔ شخصی در گفت‌وگوی خصوصی ربات باز می‌شود؛ از دکمهٔ ربات رسمی استفاده کنید.";
    case "account_locked":
      return "ورود این حساب موقتاً محدود شده است. کمی بعد دوباره تلاش کنید.";
    case "invalid_init_data":
    case "future_init_data":
      return "امضای تلگرام معتبر نیست. مینی‌اپ را فقط از ربات رسمی Biza Miz باز کنید.";
    default:
      return "ورود امن ممکن نشد. اتصال را بررسی کنید و دوباره تلاش کنید.";
  }
}

export function TelegramMiniAppClient({ botHref }: { botHref: string | null }) {
  const started = useRef(false);
  const [state, setState] = useState<"loading" | "mfa" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{
    token: string;
    method: MfaMethod | null;
    availableMethods: MfaMethod[];
  } | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let timer: number | null = null;
    let stopped = false;
    let attempts = 0;

    const attempt = async () => {
      if (stopped) return;
      const webApp = window.Telegram?.WebApp;
      if (!webApp) {
        attempts += 1;
        if (attempts < 40) {
          timer = window.setTimeout(() => void attempt(), 125);
          return;
        }
        setErrorCode("telegram_context_missing");
        setError("برای ورود، این صفحه را در مینی‌اپ رسمی تلگرام باز کنید؛ نشانی مرورگر به‌تنهایی هویت تلگرام را ثابت نمی‌کند.");
        setState("error");
        return;
      }

      webApp.ready();
      webApp.expand();
      if (!webApp.initData) {
        setErrorCode("invalid_init_data");
        setError("درخواست امضاشدهٔ تلگرام پیدا نشد. از گفت‌وگوی خصوصی ربات رسمی مینی‌اپ را باز کنید.");
        setState("error");
        return;
      }

      try {
        const response = await fetch("/api/telegram/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: webApp.initData }),
          cache: "no-store",
          credentials: "same-origin",
        });
        const data = (await response.json().catch(() => ({}))) as TelegramSessionResponse;
        if (response.status === 409 && data.error === "canonical_host_required" && data.canonicalUrl) {
          window.location.replace(data.canonicalUrl);
          return;
        }
        if (!response.ok) {
          setErrorCode(data.error ?? null);
          setError(errorMessage(data.error));
          setState("error");
          return;
        }
        if (data.mfaRequired && data.mfaToken) {
          setMfa({
            token: data.mfaToken,
            method: data.mfaMethod ?? null,
            availableMethods: data.availableMethods ?? [],
          });
          setState("mfa");
          return;
        }
        window.location.replace("/dashboard");
      } catch {
        setErrorCode("network_error");
        setError("ارتباط امن با Biza Miz برقرار نشد. دوباره تلاش کنید.");
        setState("error");
      }
    };

    void attempt();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="space-y-3" aria-live="polite">
        <p className="text-sm text-muted-foreground">در حال بررسی امضای رسمی تلگرام و عضویت کسب‌وکار…</p>
        <LoadingSkeleton rows={2} label="در حال ورود امن از مینی‌اپ تلگرام" />
      </div>
    );
  }

  if (state === "mfa" && mfa) {
    return (
      <MfaStep
        mfaToken={mfa.token}
        mfaMethod={mfa.method}
        availableMethods={mfa.availableMethods}
        primaryAuth="telegram"
        offerTrustDevice={false}
        onVerified={() => window.location.replace("/dashboard")}
        onCancel={() => window.Telegram?.WebApp?.close()}
      />
    );
  }

  const unlinked = errorCode === "account_unlinked_or_membership_unavailable";
  return (
    <div className="space-y-4">
      <ErrorBox>{error ?? "ورود ممکن نشد."}</ErrorBox>
      {unlinked ? (
        <Button
          type="button"
          onClick={() => {
            const webApp = window.Telegram?.WebApp;
            if (webApp) webApp.openLink(`${window.location.origin}/admin`);
            else if (typeof window !== "undefined") window.location.assign("/admin");
          }}
        >
          ورود به حساب فعلی در مرورگر
        </Button>
      ) : null}
      {botHref ? (
        <Button asChild variant="outline">
          <a href={botHref} target="_blank" rel="noopener noreferrer">بازکردن ربات رسمی</a>
        </Button>
      ) : null}
      <InfoBox>Telegram فقط یک درگاه ورود به همان حساب موجود است؛ عضویت، شاخه و دسترسی‌ها هر بار از سرور بررسی می‌شوند.</InfoBox>
    </div>
  );
}
