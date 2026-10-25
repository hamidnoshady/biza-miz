"use client";

/**
 * ساخت سایت — the four-step wizard, in the order an owner actually works in.
 *
 *   ۱ دامنه    — buy one through the platform's registrar, or point one they own.
 *   ۲ CDN      — ArvanCloud in front of the site, or a recorded «بدون CDN».
 *   ۳ نوع سایت — معرفی کسب‌وکار / نمونه‌کار / فروشگاه, plus the plan it runs on.
 *   ۴ ساخت     — the site is created on the CMS and connected to this account.
 *
 * Every answer is saved as it is given (`PATCH /api/cms/website/setup`), so
 * the wizard can be abandoned on a phone and finished on a desk. Which step
 * is "current" is never stored twice: the server derives it from the answers
 * (`src/lib/website/setup.ts`) and this screen renders what it is told.
 *
 * The money is deliberately visible here rather than at the end: a domain is
 * priced before it is ordered, the wallet balance sits next to the price, and
 * the plan's monthly fee is shown on the step that picks it. A business
 * should never meet a charge it did not agree to on the screen before.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CircleCheckIcon,
  GlobeIcon,
  PlugZapIcon,
  SearchIcon,
  ShieldCheckIcon,
  WandSparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  buildReadiness,
  CDN_PROVIDER_LABELS,
  completedStepCount,
  currentStep,
  DOMAIN_MODE_LABELS,
  isStepComplete,
  isValidDomain,
  normalizeDomain,
  SITE_TYPE_HINTS,
  SITE_TYPE_LABELS,
  SITE_TYPES,
  WEBSITE_SETUP_STEPS,
  type CdnProvider,
  type DomainMode,
  type SiteType,
  type WebsiteSetupState,
  type WebsiteSetupStepKey,
} from "@/lib/website/setup";
import type { WebsitePlan } from "@/lib/website/billing";
import { plansForSiteType } from "@/lib/website/billing";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { cmsSectionHref } from "../../website-routes";

interface DomainQuote {
  domain: string;
  operation: "register" | "transfer" | "renew";
  period: number;
  priceRial: number | null;
  price: number;
  currency: string;
  availability: string;
  availabilityMessage: string;
  resellerEnabled: boolean;
  balanceRial: number;
}

export function WebsiteSetupWizard() {
  const [setup, setSetup] = useState<WebsiteSetupState | null>(null);
  const [plans, setPlans] = useState<WebsitePlan[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openStep, setOpenStep] = useState<WebsiteSetupStepKey | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<{ setup: WebsiteSetupState; plans: WebsitePlan[] }>("/api/cms/website/setup"),
      api<{ connected: boolean }>("/api/cms/website/state"),
    ]).then(([setupRes, stateRes]) => {
      setLoading(false);
      if (setupRes.ok) {
        setError("");
        setSetup(setupRes.data.setup);
        setPlans(setupRes.data.plans);
      } else {
        setError(errorMessageOrRaw((setupRes.data as { error?: string }).error));
      }
      if (stateRes.ok) {
        setConnected(stateRes.data.connected);
      } else if (setupRes.ok) {
        // Do not silently render a completed wizard as disconnected when the
        // second request failed. Keeping the previous value is safer than
        // replacing it with false during a transient network error.
        setError((stateRes.data as { error?: string }).error ?? "وضعیت اتصال سایت خوانده نشد.");
      }
    });
  }, []);

  useEffect(reload, [reload]);

  const save = useCallback(
    async (patch: Record<string, unknown>): Promise<boolean> => {
      const { ok, data } = await api<{ setup: WebsiteSetupState; error?: string }>("/api/cms/website/setup", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!ok) {
        toast.error(errorMessageOrRaw(data.error));
        return false;
      }
      setSetup(data.setup);
      return true;
    },
    [],
  );

  if (loading) return <SectionCardSkeleton rows={5} />;
  if (!setup) return <ErrorBox>{error || "وضعیت ساخت سایت خوانده نشد."}</ErrorBox>;

  if (connected || setup.stage === "built") {
    return (
      <SectionCard title="سایت ساخته شده است" description="ساخت سایت کامل شده و این حساب به آن وصل است.">
        <div className="flex flex-wrap gap-2">
          <Button asChild className="px-4">
            <Link href={cmsSectionHref("overview")}>
              <GlobeIcon className="size-4" />
              رفتن به میز کار سایت
            </Link>
          </Button>
          <Button asChild variant="outline" className="px-4">
            <Link href={cmsSectionHref("billing")}>اشتراک و صورت‌حساب</Link>
          </Button>
        </div>
      </SectionCard>
    );
  }

  const active = openStep ?? currentStep(setup);
  const done = completedStepCount(setup);

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="گام‌های ساخت سایت"
        description={`${toPersianDigits(done)} گام از ${toPersianDigits(WEBSITE_SETUP_STEPS.length)} گام انجام شده است.`}
      >
        <ol className="space-y-2">
          {WEBSITE_SETUP_STEPS.map((step, index) => {
            const complete = isStepComplete(setup, step.key);
            return (
              <li key={step.key}>
                <button
                  type="button"
                  onClick={() => setOpenStep(step.key)}
                  aria-current={active === step.key ? "step" : undefined}
                  className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-start transition-colors ${
                    active === step.key
                      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
                      : "border-border bg-card hover:bg-muted"
                  }`}
                >
                  {complete ? (
                    <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold">
                      {toPersianDigits(index + 1)}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{step.title}</span>
                    <span className="mt-0.5 block text-xs leading-5 opacity-80">{step.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </SectionCard>

      {active === "domain" ? <DomainStep setup={setup} save={save} onOrdered={reload} /> : null}
      {active === "cdn" ? <CdnStep setup={setup} save={save} /> : null}
      {active === "type" ? <TypeStep setup={setup} plans={plans} save={save} /> : null}
      {active === "build" ? <BuildStep setup={setup} plans={plans} onBuilt={reload} /> : null}

      <SectionCard
        title="سایت از قبل دارید؟"
        description="اگر سایتی روی سایت‌ساز بیزامیز ساخته‌اید، به‌جای ساخت دوباره آن را در «اتصال‌های فنی» وصل کنید؛ همین‌که وصل شد، همین‌جا دیده می‌شود."
      >
        <Button asChild variant="outline" className="px-4">
          <Link href="/settings/connections?tab=website">اتصال سایت موجود</Link>
        </Button>
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ۱ — دامنه                                                            */
/* ------------------------------------------------------------------ */

function DomainStep({
  setup,
  save,
  onOrdered,
}: {
  setup: WebsiteSetupState;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  onOrdered: () => void;
}) {
  const [domain, setDomain] = useState(setup.domain ?? "");
  const [mode, setMode] = useState<DomainMode>(setup.domainMode);
  const [years, setYears] = useState(setup.domainYears);
  const [quote, setQuote] = useState<DomainQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A domain's price and the wallet balance are money: they follow the
  // business's chosen display unit, like every other amount on the platform.
  const money = useMoney();

  const valid = isValidDomain(domain);

  const priceDomain = async () => {
    setBusy(true);
    setError("");
    setQuote(null);
    const { ok, data } = await api<{ quote: DomainQuote; error?: string }>(
      `/api/cms/website/domain/quote?domain=${encodeURIComponent(normalizeDomain(domain))}&operation=register&period=${years}`,
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    setQuote(data.quote);
  };

  const order = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; order?: { unpaid: boolean } }>(
      "/api/cms/website/domain/order",
      {
        method: "POST",
        body: JSON.stringify({ domain: normalizeDomain(domain), operation: "register", period: years }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success(
      data.order?.unpaid
        ? "سفارش دامنه ثبت شد؛ هزینهٔ آن پرداخت‌نشده مانده است."
        : "سفارش دامنه ثبت شد.",
    );
    onOrdered();
  };

  return (
    <SectionCard
      title="۱ — دامنه"
      description="آدرس سایت. دامنه‌ای که دارید را وصل کنید، یا از همین‌جا بخرید — هزینهٔ خرید از اعتبار پلتفرم کم می‌شود."
      actions={
        setup.domainStatus !== "pending" ? (
          <StatusBadge
            tone={
              setup.domainStatus === "registered"
                ? "positive"
                : setup.domainStatus === "failed"
                  ? "danger"
                  : "active"
            }
          >
            {setup.domainStatus === "registered"
              ? "ثبت‌شده"
              : setup.domainStatus === "ordered"
                ? "در حال ثبت"
                : "ناموفق"}
          </StatusBadge>
        ) : null
      }
    >
      <ErrorBox>{error}</ErrorBox>

      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(DOMAIN_MODE_LABELS) as DomainMode[]).map((value) => (
          <Button
            key={value}
            type="button"
            variant={mode === value ? "default" : "outline"}
            onClick={() => {
              setMode(value);
              // A quote is specific to the purchase flow. Keeping it while
              // switching to an owned domain (then back) can show a stale
              // price for a different domain or registration period.
              setQuote(null);
              setError("");
              void save({ domainMode: value });
            }}
          >
            {value === "own" ? <PlugZapIcon className="size-4" /> : <GlobeIcon className="size-4" />}
            {DOMAIN_MODE_LABELS[value]}
          </Button>
        ))}
      </div>

      <Field label="دامنه" hint="فقط میزبان — مثل acme.ir">
        <input
          className={inputClass}
          dir="ltr"
          placeholder="acme.ir"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
        />
      </Field>

      {mode === "buy" ? (
        <Field label="مدت ثبت (سال)">
          <select
            className={inputClass}
            value={years}
            onChange={(event) => {
              const next = Number(toLatinDigits(event.target.value));
              setYears(next);
              setQuote(null);
              void save({ domainYears: next });
            }}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {toPersianDigits(value)} سال
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!valid || busy}
          onClick={async () => {
            const saved = await save({ domain: normalizeDomain(domain), domainMode: mode });
            if (saved) toast.success("دامنه ذخیره شد.");
          }}
        >
          ذخیرهٔ دامنه
        </Button>
        {mode === "buy" ? (
          <Button type="button" variant="outline" className="px-4" disabled={!valid || busy} onClick={priceDomain}>
            <SearchIcon className="size-4" />
            {busy ? "در حال استعلام…" : "استعلام قیمت"}
          </Button>
        ) : null}
      </div>

      {mode === "own" ? (
        <InfoBox>
          دامنه را نگه دارید؛ در گام بعد تنظیم DNS و CDN را می‌گیرید و بعد از ساخت سایت، رکوردها را در پنل
          ثبت‌کنندهٔ دامنه‌تان می‌گذارید.
        </InfoBox>
      ) : null}

      {quote ? (
        <div className="mt-4 rounded-xl border border-border bg-muted p-3">
          <p className="text-sm leading-6 text-foreground">
            {quote.priceRial === null ? (
              <>قیمت این دامنه به ارز «{quote.currency}» اعلام شده و فعلاً از این‌جا قابل خرید نیست.</>
            ) : (
              <>
                قیمت ثبت{" "}
                <span dir="ltr" className="font-medium">
                  {quote.domain}
                </span>{" "}
                برای {toPersianDigits(quote.period)} سال:{" "}
                <span className="font-bold">{money.format(quote.priceRial)}</span>
              </>
            )}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            اعتبار فعلی شما: {money.format(quote.balanceRial)} · {quote.availabilityMessage}
          </p>
          {quote.priceRial !== null ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={busy || !quote.resellerEnabled || quote.balanceRial < quote.priceRial}
                onClick={order}
              >
                {busy ? "در حال ثبت سفارش…" : "خرید و ثبت دامنه"}
              </Button>
              {quote.balanceRial < quote.priceRial ? (
                <Button asChild variant="outline" className="px-4">
                  <Link href="/settings/billing">افزایش اعتبار</Link>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* ۲ — CDN                                                              */
/* ------------------------------------------------------------------ */

function CdnStep({
  setup,
  save,
}: {
  setup: WebsiteSetupState;
  save: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState<CdnProvider>(setup.cdnProvider);

  return (
    <SectionCard
      title="۲ — CDN و DNS"
      description="قرار دادن سایت پشت ابر آروان: سرعت بیشتر، گواهی SSL و محافظت. ساخت زون را تیم پلتفرم انجام می‌دهد؛ شما فقط انتخاب می‌کنید."
      actions={
        <StatusBadge
          tone={
            setup.cdnStatus === "active"
              ? "positive"
              : setup.cdnStatus === "failed"
                ? "danger"
                : setup.cdnStatus === "skipped"
                  ? "neutral"
                  : "active"
          }
        >
          {setup.cdnStatus === "active"
            ? "فعال"
            : setup.cdnStatus === "requested"
              ? "در انتظار فعال‌سازی"
              : setup.cdnStatus === "failed"
                ? "ناموفق"
                : setup.cdnStatus === "skipped"
                  ? "بدون CDN"
                  : "انتخاب نشده"}
        </StatusBadge>
      }
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(CDN_PROVIDER_LABELS) as CdnProvider[]).map((value) => (
          <Button
            key={value}
            type="button"
            variant={provider === value ? "default" : "outline"}
            onClick={() => {
              setProvider(value);
              void save({ cdnProvider: value });
            }}
          >
            <ShieldCheckIcon className="size-4" />
            {CDN_PROVIDER_LABELS[value]}
          </Button>
        ))}
      </div>

      {provider === "none" ? (
        <InfoBox>
          سایت مستقیم از سرور پلتفرم سرو می‌شود. بعداً هم می‌توانید CDN را از همین بخش فعال کنید.
        </InfoBox>
      ) : (
        <>
          <InfoBox>
            پس از ساخت سایت، زون {CDN_PROVIDER_LABELS[provider]} برای دامنهٔ شما ساخته می‌شود و نام‌سرورها یا
            رکوردهای لازم در بخش «میز کار سایت» نمایش داده می‌شود. تا آن زمان می‌توانید ادامه دهید.
          </InfoBox>
          <div className="mt-3">
            <Button
              type="button"
              onClick={async () => {
                if (await save({ cdnProvider: provider, cdnStatus: "requested" })) {
                  toast.success("درخواست فعال‌سازی CDN ثبت شد.");
                }
              }}
            >
              درخواست فعال‌سازی CDN
            </Button>
          </div>
        </>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* ۳ — نوع سایت و طرح                                                   */
/* ------------------------------------------------------------------ */

function TypeStep({
  setup,
  plans,
  save,
}: {
  setup: WebsiteSetupState;
  plans: WebsitePlan[];
  save: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [type, setType] = useState<SiteType>(setup.siteType);
  const [name, setName] = useState(setup.siteName ?? "");
  const [planKey, setPlanKey] = useState(setup.planKey ?? "");
  const available = plansForSiteType(plans, type);
  const money = useMoney();

  return (
    <SectionCard
      title="۳ — نوع سایت"
      description="بلوک‌ها و محتوای اولیهٔ سایت از این انتخاب می‌آید. بعداً هم می‌توانید محتوا را تغییر دهید."
    >
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {SITE_TYPES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setType(value);
              setPlanKey("");
              void save({ siteType: value });
            }}
            className={`rounded-xl border p-3 text-start transition-colors ${
              type === value ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200" : "border-border bg-card hover:bg-muted"
            }`}
          >
            <span className="block text-sm font-medium">{SITE_TYPE_LABELS[value]}</span>
            <span className="mt-0.5 block text-xs leading-5 opacity-80">{SITE_TYPE_HINTS[value]}</span>
          </button>
        ))}
      </div>

      <Field label="نام سایت" hint="همان چیزی که در عنوان صفحه‌ها و بالای سایت دیده می‌شود.">
        <input
          className={inputClass}
          placeholder="کافه اصفهان"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label="طرح اشتراک سایت" hint="هزینهٔ ماهانهٔ سایت از اعتبار پلتفرم کم می‌شود.">
        {available.length === 0 ? (
          <EmptyState>برای این نوع سایت هنوز طرحی تعریف نشده است؛ می‌توانید بدون طرح ادامه دهید.</EmptyState>
        ) : (
          <select className={inputClass} value={planKey} onChange={(event) => setPlanKey(event.target.value)}>
            <option value="">بدون طرح (بعداً انتخاب می‌کنم)</option>
            {available.map((plan) => (
              <option key={plan.key} value={plan.key}>
                {plan.name} — ماهانه {money.format(plan.monthlyPriceRial)}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Button
        type="button"
        disabled={!name.trim()}
        onClick={async () => {
          if (await save({ siteType: type, siteName: name.trim(), planKey: planKey || null })) {
            toast.success("نوع سایت ذخیره شد.");
          }
        }}
      >
        ذخیره و ادامه
      </Button>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* ۴ — ساخت                                                             */
/* ------------------------------------------------------------------ */

function BuildStep({
  setup,
  plans,
  onBuilt,
}: {
  setup: WebsiteSetupState;
  plans: WebsitePlan[];
  onBuilt: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const readiness = buildReadiness(setup);
  const plan = plans.find((row) => row.key === setup.planKey) ?? null;
  const money = useMoney();

  return (
    <SectionCard
      title="۴ — ساخت سایت"
      description="سایت روی سایت‌ساز ساخته می‌شود، کلید دسترسی آن صادر و رمزنگاری‌شده ذخیره می‌شود، و اشتراک طرح انتخابی شروع می‌شود."
    >
      <ErrorBox>{error}</ErrorBox>
      <dl className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">دامنه</dt>
          <dd dir="ltr" className="mt-0.5 truncate text-sm font-medium text-foreground">
            {setup.domain ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">CDN</dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground">{CDN_PROVIDER_LABELS[setup.cdnProvider]}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">نوع سایت</dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground">{SITE_TYPE_LABELS[setup.siteType]}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">طرح</dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground">
            {plan ? `${plan.name} — ماهانه ${money.format(plan.monthlyPriceRial)}` : "بدون طرح"}
          </dd>
        </div>
      </dl>

      {!readiness.ok ? <InfoBox>{readiness.reason}</InfoBox> : null}

      <Button
        type="button"
        disabled={!readiness.ok || busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          const { ok, data } = await api<{ error?: string }>("/api/cms/website/setup/build", { method: "POST" });
          setBusy(false);
          if (!ok) {
            setError(errorMessageOrRaw(data.error));
            return;
          }
          toast.success("سایت ساخته شد.");
          onBuilt();
        }}
      >
        <WandSparklesIcon className="size-4" />
        {busy ? "در حال ساخت سایت…" : "ساخت سایت"}
      </Button>

      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        پس از ساخت، از «میز کار سایت» می‌توانید DNS را بررسی کنید، پیش‌نمایش زنده را ببینید و صفحه‌ها،
        منو، فرم‌ها و «پنل کامل سایت» را همین‌جا مدیریت کنید.
      </p>
    </SectionCard>
  );
}
