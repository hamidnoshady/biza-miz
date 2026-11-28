"use client";

/**
 * Explicit in-wizard activation for apps the owner selected but has not
 * activated (GitHub #1580 §A/F).
 *
 * The issue's contract is precise: selecting an import target must never
 * activate an app or move money; a paid app that is not active shows
 * «منتظر فعال‌سازی», and the owner may activate it *explicitly* with the
 * canonical quote in front of them. This component is only that offer:
 *
 *  - it reads the canonical `GET /api/services/app/:key` (binding quote,
 *    wallet cover, commercial availability, wizard state) — never a guessed
 *    price;
 *  - it POSTs the canonical `activate` action with a fresh idempotency
 *    `requestId` only after the owner presses the button;
 *  - it never starts a trial, never charges silently, and never retries.
 *
 * A #1579 complimentary grant appears here exactly like a paid activation: the
 * quote says the setup/rental is waived, the button needs no wallet cover, and
 * the grant is issued inside the same canonical transaction.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheckIcon, CreditCardIcon } from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import type { ActivatableApp } from "@/lib/setup-activation";
import { ErrorBox, InfoBox, PrimaryButton, api, errorMessage } from "../ui";

interface ActivationQuoteView {
  eligible: boolean;
  reason: "ready" | "not_configured" | "insufficient_credit";
  setupRial: number;
  hourlyRial: number;
  firstHourRial: number;
  reserveRial: number;
  walletBalanceRial: number;
  balanceAfterSetupRial: number;
  setupWaivedReason: "plan_included" | "published_free" | "complimentary_grant" | null;
  rentalWaived?: boolean;
}

interface ServiceView {
  activation?: { state?: string } | null;
  quote?: ActivationQuoteView | null;
  commercial?: { purchasable?: boolean; activationState?: string } | null;
  error?: string;
}

const ACTIVATION_STATE_LABELS: Record<string, string> = {
  active: "فعال",
  pending: "در انتظار فعال‌سازی",
  suspended: "متوقف",
  disabled: "غیرفعال",
};

export function SetupActivationPanel({
  apps,
  onActivated,
}: {
  apps: ActivatableApp[];
  onActivated: () => void;
}) {
  if (apps.length === 0) return null;
  return (
    <section
      aria-label="فعال‌سازی برنامه‌های انتخاب‌شده"
      className="rounded-2xl border border-amber-600/30 bg-amber-500/5 p-5"
    >
      <div className="mb-3 flex items-start gap-2">
        <BadgeCheckIcon
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden="true"
        />
        <div>
          <h2 className="font-semibold text-foreground">
            فعال‌سازی برنامه‌های انتخاب‌شده
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            این برنامه‌ها انتخاب شده‌اند اما هنوز فعال نیستند. می‌توانید فایل را
            آماده و پیش‌نمایش کنید؛ برای اجرای ورود اطلاعات، فعال‌سازی صریح لازم
            است. انتخاب یا پیش‌نمایش، هیچ مبلغی کسر نمی‌کند.
          </p>
        </div>
      </div>
      <div className="space-y-3">
        {apps.map((app) => (
          <ActivationRow key={app.appKey} app={app} onActivated={onActivated} />
        ))}
      </div>
    </section>
  );
}

function ActivationRow({
  app,
  onActivated,
}: {
  app: ActivatableApp;
  onActivated: () => void;
}) {
  const money = useMoney();
  const [view, setView] = useState<ServiceView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const result = await api<ServiceView>(`/api/services/app/${app.appKey}`);
    if (!result.ok) {
      setLoadError(errorMessage(result.data?.error, undefined, result.status));
    } else {
      setLoadError("");
      setView(result.data);
    }
    setLoaded(true);
  }, [app.appKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function activate() {
    setBusy(true);
    setError("");
    setStatus("");
    const result = await api<{
      status?: string;
      error?: string;
      message?: string;
      requiredRial?: number;
      balanceRial?: number;
    }>(`/api/services/app/${app.appKey}`, {
      method: "POST",
      body: JSON.stringify({
        action: "activate",
        // Fresh per press: the canonical service treats a retried key as the
        // same attempt, so a double click cannot open a second paid period.
        requestId:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `setup-${app.appKey}-${Date.now()}`,
      }),
    });
    setBusy(false);
    if (!result.ok || result.data.status === "insufficient_credit") {
      if (result.data.error === "wizard_incomplete") {
        setError(
          "پرسش‌های راه‌اندازی این برنامه کامل نشده است. ابتدا آن‌ها را در مرحلهٔ «راه‌اندازی برنامه‌ها» تکمیل کنید.",
        );
        return;
      }
      if (result.data.error === "phone_verification_required") {
        setError(
          "برای فعال‌سازی، شمارهٔ موبایل حساب باید تأیید شده باشد. از «امنیت حساب» تأیید کنید.",
        );
        return;
      }
      if (result.data.status === "insufficient_credit" || result.data.error === "insufficient_credit") {
        const required = Number(result.data.requiredRial ?? 0);
        const balance = Number(result.data.balanceRial ?? 0);
        setError(
          `موجودی کیف پول برای فعال‌سازی کافی نیست: ${money.format(
            Math.max(0, required - balance),
          )} کم است. می‌توانید بعداً از صورت‌حساب فعال کنید؛ فایل آماده‌شده از دست نمی‌رود.`,
        );
        return;
      }
      setError(
        result.data.message ??
          errorMessage(result.data.error, undefined, result.status),
      );
      return;
    }
    setStatus("برنامه فعال شد. اکنون می‌توانید ورود اطلاعات را اجرا کنید.");
    await load();
    onActivated();
  }

  if (!loaded) {
    return (
      <div className="rounded-xl border border-border bg-card p-4" aria-hidden="true">
        <div className="ops-skeleton h-4 w-40 rounded-md bg-muted" />
        <div className="ops-skeleton mt-3 h-3 w-64 rounded-md bg-muted" />
      </div>
    );
  }

  if (loadError) {
    return (
      <InfoBox>
        وضعیت فعال‌سازی «{app.label}» خوانده نشد. {loadError}
      </InfoBox>
    );
  }

  const quote = view?.quote;
  const state = view?.activation?.state ?? null;
  const stateLabel = state
    ? ACTIVATION_STATE_LABELS[view?.commercial?.activationState ?? ""] ??
      ACTIVATION_STATE_LABELS[state] ??
      state
    : "فعال‌نشده";
  const shortfall = quote
    ? Math.max(0, quote.reserveRial - quote.walletBalanceRial)
    : 0;
  const freeGrant =
    quote?.setupWaivedReason === "complimentary_grant" ||
    (quote?.rentalWaived === true && (quote?.reserveRial ?? 0) === 0);
  const purchasable = view?.commercial?.purchasable !== false;
  const canActivate =
    Boolean(quote?.eligible) && purchasable && shortfall === 0 && !busy;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CreditCardIcon className="size-4 text-primary" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground">{app.label}</span>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {stateLabel}
        </span>
      </div>

      {quote ? (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <dt className="text-muted-foreground">هزینهٔ راه‌اندازی</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {freeGrant || quote.setupRial === 0
                ? "رایگان"
                : money.format(quote.setupRial)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <dt className="text-muted-foreground">پیش‌پرداخت نخستین دوره</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {quote.rentalWaived ? "رایگان (دورهٔ هدیه)" : money.format(quote.reserveRial)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <dt className="text-muted-foreground">موجودی کیف پول</dt>
            <dd className="tabular-nums text-foreground">
              {money.format(quote.walletBalanceRial)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <dt className="text-muted-foreground">نرخ ساعتی</dt>
            <dd className="tabular-nums text-foreground">
              {quote.rentalWaived ? "معاف" : money.format(quote.hourlyRial)}
            </dd>
          </div>
        </dl>
      ) : null}

      {freeGrant ? (
        <p className="mt-2 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
          این برنامه با دورهٔ هدیهٔ فعال پوشش داده می‌شود؛ فعال‌سازی مبلغی از کیف
          پول کسر نمی‌کند.
        </p>
      ) : null}

      {quote && !quote.eligible ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {quote.reason === "not_configured"
            ? "تعرفهٔ منتشرشده‌ای برای این برنامه ثبت نشده است؛ فعال‌سازی از این صفحه ممکن نیست."
            : "این برنامه در حال حاضر واجد شرایط فعال‌سازی نیست."}
        </p>
      ) : null}

      {quote && shortfall > 0 ? (
        <p className="mt-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
          {money.format(shortfall)} کم است. فایل آماده می‌ماند و بعد از شارژ کیف
          پول از صورت‌حساب، همین برنامه را فعال و ورود را اجرا کنید.
        </p>
      ) : null}

      <ErrorBox>{error}</ErrorBox>
      {status ? (
        <p className="mt-2 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
          {status}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <PrimaryButton
          type="button"
          onClick={() => void activate()}
          disabled={!canActivate}
        >
          {busy
            ? "در حال فعال‌سازی…"
            : (
              <>
                <BadgeCheckIcon className="me-1 size-4" aria-hidden="true" />
                {freeGrant || quote?.reserveRial === 0
                  ? "فعال‌سازی رایگان"
                  : `فعال‌سازی و پرداخت ${money.format(quote?.reserveRial ?? 0)}`}
              </>
            )}
        </PrimaryButton>
        <Link
          href="/settings/billing"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          صورت‌حساب و کیف پول
        </Link>
        <Link
          href="/setup/app-setup"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          راه‌اندازی برنامه
        </Link>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        فعال‌سازی فقط با همین دکمه و به‌صورت صریح انجام می‌شود؛ انتخاب برنامه یا
        پیش‌نمایش فایل، هیچ پرداخت یا دورهٔ آزمایشی خودکاری آغاز نمی‌کند.
      </p>
    </div>
  );
}
