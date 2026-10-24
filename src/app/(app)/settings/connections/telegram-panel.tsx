"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";

interface TelegramConnectionStatus {
  available?: boolean;
  error?: string;
  identityAvailable?: boolean;
  linked?: boolean;
  linkedAt?: string | null;
  challenge?: "pending" | "linked" | "expired" | null;
}

interface TelegramChallenge {
  challengeId: string;
  deepLink: string;
  expiresAt: string;
}

function telegramErrorMessage(error: string | undefined): string {
  switch (error) {
    case "capability_unavailable":
    case "cloud_only":
    case "deployment_unsupported":
      return "اتصال تلگرام فقط برای کسب‌وکار ابری و روی سرور مرکزی در دسترس است؛ حالت محلی یا ترکیبی به آن دسترسی نمی‌گیرد.";
    case "feature_disabled":
      return "قابلیت «اتصال‌های فنی» برای این کسب‌وکار فعال نیست.";
    case "telegram_not_configured":
      return "ربات رسمی تلگرام هنوز توسط مدیر پلتفرم پیکربندی نشده است.";
    case "telegram_disabled":
      return "اتصال تلگرام در این استقرار فعال نیست.";
    case "global_identity_required":
      return "برای پیوند تلگرام ابتدا با حساب اصلی Biza Miz وارد شوید؛ ورود سریع با رمز کارکنان هویت جهانی ندارد.";
    case "browser_identity_required":
      return "پیوند را از نشست مرورگرِ حساب اصلی Biza Miz آغاز کنید؛ نشست تلگرام یا نشست کارکنان برای پیوند هویت پذیرفته نیست.";
    case "recent_auth_required":
      return "برای این تغییر امنیتی دوباره وارد حساب Biza Miz شوید و سپس تلاش کنید.";
    default:
      return "درخواست تلگرام انجام نشد. اتصال را بررسی کنید و دوباره تلاش کنید.";
  }
}

function formatJalaliDate(value: string | null | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function TelegramPanel() {
  const locked = useFeatureLocked();
  const [status, setStatus] = useState<TelegramConnectionStatus | null>(null);
  const [challenge, setChallenge] = useState<TelegramChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async (challengeId?: string) => {
    const url = challengeId
      ? `/api/connections/telegram?challengeId=${encodeURIComponent(challengeId)}`
      : "/api/connections/telegram";
    const { ok, data } = await api<TelegramConnectionStatus>(url);
    if (ok) {
      setStatus(data);
      if (data.challenge === "linked") {
        setChallenge(null);
        setMessage({ kind: "ok", text: "حساب تلگرام شما به هویت Biza Miz پیوند خورد." });
      } else if (data.challenge === "expired") {
        setChallenge(null);
        setMessage({ kind: "error", text: "مهلت پیوند تمام شد. پیوند تازه‌ای بسازید." });
      }
    } else {
      setStatus({ available: false, error: data.error });
    }
  }, []);

  useEffect(() => {
    if (locked) {
      setLoading(false);
      return;
    }
    let active = true;
    void load().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [load, locked]);

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => void load(challenge.challengeId), 2_000);
    return () => window.clearInterval(timer);
  }, [challenge, load]);

  async function createChallenge() {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await api<TelegramChallenge & { error?: string }>(
      "/api/connections/telegram",
      { method: "POST", body: "{}" },
    );
    setBusy(false);
    if (!ok || !data.challengeId || !data.deepLink) {
      setMessage({ kind: "error", text: telegramErrorMessage(data.error) });
      return;
    }
    setChallenge({ challengeId: data.challengeId, deepLink: data.deepLink, expiresAt: data.expiresAt });
    setMessage({ kind: "ok", text: "پیوند فقط پنج دقیقه معتبر است. ربات رسمی را باز کنید و دکمهٔ آغاز را بزنید." });
  }

  async function unlink() {
    if (!window.confirm("پیوند تلگرام لغو شود؟ نشست‌های تلگرامی شما در همهٔ کسب‌وکارها فوراً بسته می‌شوند.")) return;
    setBusy(true);
    setMessage(null);
    const { ok, data } = await api<{ error?: string }>("/api/connections/telegram", {
      method: "DELETE",
    });
    setBusy(false);
    if (!ok) {
      setMessage({ kind: "error", text: telegramErrorMessage(data.error) });
      return;
    }
    setChallenge(null);
    setMessage({ kind: "ok", text: "پیوند لغو شد و نشست‌های تلگرامی بسته شدند." });
    await load();
  }

  if (loading) return <LoadingSkeleton className="h-48" />;
  if (locked) {
    return (
      <SectionCard title="ربات رسمی و مینی‌اپ تلگرام">
        <p className="text-sm leading-6 text-muted-foreground">برای استفاده، قابلیت اتصال‌های فنی باید برای این کسب‌وکار فعال باشد.</p>
      </SectionCard>
    );
  }

  if (status?.available === false) {
    return (
      <SectionCard title="ربات رسمی و مینی‌اپ تلگرام">
        <p className="text-sm leading-6 text-muted-foreground">{telegramErrorMessage(status.error)}</p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      {message?.kind === "ok" ? <InfoBox>{message.text}</InfoBox> : null}
      {message?.kind === "error" ? <ErrorBox>{message.text}</ErrorBox> : null}

      <SectionCard title="ربات رسمی و مینی‌اپ تلگرام" description="فقط حساب شخصی خودتان را به هویت موجود Biza Miz پیوند دهید.">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={status?.linked ? "positive" : "neutral"}>
              {status?.linked ? "پیوند برقرار است" : "پیوند برقرار نیست"}
            </StatusBadge>
            {status?.linkedAt ? (
              <span className="text-xs text-muted-foreground">از {formatJalaliDate(status.linkedAt)}</span>
            ) : null}
          </div>

          <p className="text-sm leading-6 text-muted-foreground">
            این اتصال حساب تازه‌ای نمی‌سازد و دسترسی یا نقش تازه‌ای نمی‌دهد. مینی‌اپ از نشست، عضویت، دسترسی شاخه و سیاست دومرحله‌ای همین حساب استفاده می‌کند.
          </p>

          {!status?.identityAvailable ? (
            <ErrorBox>{telegramErrorMessage("global_identity_required")}</ErrorBox>
          ) : null}

          {challenge ? (
            <div className="space-y-3 rounded-xl border border-stone-200/80 bg-stone-50/60 p-4 dark:border-stone-700 dark:bg-stone-900/30">
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">درخواست پیوند آماده است</p>
              <p className="text-sm text-muted-foreground">ربات را باز کنید و «آغاز» را بزنید. پیوند تا {formatJalaliDate(challenge.expiresAt)} معتبر است.</p>
              <Button asChild variant="outline">
                <a href={challenge.deepLink} target="_blank" rel="noopener noreferrer">
                  بازکردن ربات رسمی تلگرام
                </a>
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void createChallenge()}
              disabled={busy || loading || !status?.identityAvailable || Boolean(status?.linked)}
            >
              {busy ? "در حال ساخت پیوند…" : "پیوند حساب تلگرام"}
            </Button>
            {status?.linked ? (
              <Button type="button" variant="destructive" onClick={() => void unlink()} disabled={busy}>
                لغو پیوند و بستن نشست‌ها
              </Button>
            ) : null}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
