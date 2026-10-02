"use client";

/**
 * Growth → «تنظیمات رشد و بازاریابی» — the Growth app's own settings.
 *
 * Issue #764: this page used to be a second dashboard (counts of programs,
 * campaigns, templates and commission rules) with links back to the screens
 * that own them. It now owns real Growth-wide configuration — the attribution
 * window and the 30-day discount budget (src/lib/growth-settings.ts), each
 * read by a report or the dashboard — and otherwise only points to the one
 * screen that edits each engine. Figures stay on the Growth dashboard; the
 * only state shown here is what would stop the app from working (no default
 * loyalty program, messaging not set up by the platform).
 */

import { useCallback, useEffect, useState } from "react";
import { HandCoinsIcon, HeartIcon, MegaphoneIcon, MessageCircleIcon, SlidersHorizontalIcon } from "lucide-react";
import { AppSettingsPanel, type AppSettingsGroup } from "@/components/app-settings/app-settings-panel";
import { AppSettingsShortcut } from "@/components/app-settings/app-settings-shortcut";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { Button } from "@/components/ui/button";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";
import { crmSectionHref } from "@/app/(app)/crm/crm-routes";
import { SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { ATTRIBUTION_WINDOW_LIMITS, parseGrowthSettingsInput, type GrowthSettings } from "@/lib/growth-settings";
import { growthSectionHref } from "./growth-routes";

interface SettingsResponse {
  settings: GrowthSettings;
  readiness: { hasDefaultLoyaltyProgram: boolean; messagingReady: boolean };
}

/** The Growth-wide form. Empty fields mean «no limit», which is what `null` stores. */
function GrowthWideSettingsForm({
  settings,
  onSaved,
}: {
  settings: GrowthSettings;
  onSaved: (next: GrowthSettings) => void;
}) {
  const money = useMoney();
  const [windowDays, setWindowDays] = useState(settings.attributionWindowDays?.toString() ?? "");
  const [budget, setBudget] = useState(
    settings.discountBudgetRial === null ? "" : String(money.toInput(settings.discountBudgetRial)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaved(false);
    let discountBudgetRial: number | null = null;
    if (budget.trim()) {
      try {
        discountBudgetRial = money.parse(budget);
      } catch {
        setError(`سقف تخفیف را به ${money.unitLabel} و به‌صورت عدد وارد کنید.`);
        return;
      }
    }
    const body = {
      attributionWindowDays: windowDays.trim() ? Number(windowDays) : null,
      discountBudgetRial,
    };
    // The same rules the server applies, so a mistake is named before a round trip.
    const parsed = parseGrowthSettingsInput(body);
    if (!parsed.ok) {
      setError(parsed.errors.join(" "));
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ settings?: GrowthSettings; message?: string; error?: string }>("/api/growth/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok || !data.settings) {
      setError(data.message ?? errorMessageOrRaw(data.error) ?? "ذخیرهٔ تنظیمات ناموفق بود.");
      return;
    }
    setSaved(true);
    onSaved(data.settings);
  }

  return (
    <form className="space-y-4" onSubmit={save} noValidate>
      <div aria-live="polite">
        <ErrorBox>{error}</ErrorBox>
        {saved ? <InfoBox>تنظیمات رشد ذخیره شد.</InfoBox> : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="بازهٔ انتساب کمپین پیام (روز)"
          hint={`فروشی که پروموشن اختصاصی کمپین را تا این تعداد روز پس از شروع ارسال اعمال کند، به بازده آن کمپین نسبت داده می‌شود. خالی یعنی بدون محدودیت (${ATTRIBUTION_WINDOW_LIMITS.min} تا ${ATTRIBUTION_WINDOW_LIMITS.max} روز).`}
        >
          <PersianNumberInput
            inputMode="numeric"
            allowDecimal={false}
            allowNegative={false}
            className={inputClass}
            dir="ltr"
            value={windowDays}
            placeholder="بدون محدودیت"
            onChange={(event) => setWindowDays(event.target.value)}
          />
        </Field>
        <Field
          label={`سقف تخفیف کمپین‌ها در ۳۰ روز (${money.unitLabel})`}
          hint="آستانهٔ هشدار در میز کار رشد؛ فروش هرگز به‌خاطر آن رد نمی‌شود. خالی یعنی بدون سقف."
        >
          <PersianNumberInput
            inputMode="numeric"
            allowDecimal={false}
            allowNegative={false}
            className={inputClass}
            dir="ltr"
            value={budget}
            placeholder="بدون سقف"
            onChange={(event) => setBudget(event.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" disabled={busy} className="min-h-11 w-full sm:w-auto">
        {busy ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات رشد"}
      </Button>
    </form>
  );
}

export function GrowthSettingsSection() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    void api<SettingsResponse & { error?: string }>("/api/growth/settings").then(({ ok, data: body }) => {
      if (ok) setData({ settings: body.settings, readiness: body.readiness });
      else setError(body.error ? errorMessageOrRaw(body.error) : "بارگذاری تنظیمات رشد و بازاریابی ناموفق بود.");
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) {
    return (
      <div className="space-y-3">
        <ErrorBox>{error}</ErrorBox>
        <div className="max-w-xs">
          <SecondaryButton onClick={load}>تلاش دوباره</SecondaryButton>
        </div>
      </div>
    );
  }

  if (!data) {
    return <SectionCardSkeleton rows={4} label="در حال بارگذاری تنظیمات رشد و بازاریابی" />;
  }

  const { settings, readiness } = data;
  const groups: AppSettingsGroup[] = [
    {
      key: "growth",
      label: "تنظیمات سراسری رشد",
      description: "قواعدی که همهٔ بخش‌های رشد و بازاریابی از آن‌ها پیروی می‌کنند.",
      icon: SlidersHorizontalIcon,
      body: (
        <GrowthWideSettingsForm
          settings={settings}
          onSaved={(next) => setData((current) => (current ? { ...current, settings: next } : current))}
        />
      ),
    },
    {
      key: "loyalty",
      label: "قواعد وفاداری",
      description: "طرح پیش‌فرض، نرخ امتیازدهی و انقضای امتیازها.",
      icon: HeartIcon,
      body: (
        <div className="space-y-3">
          {!readiness.hasDefaultLoyaltyProgram ? (
            <p className="rounded-xl border border-dashed border-amber-300/70 bg-amber-50/60 px-3 py-3 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              هنوز طرح وفاداری فعال و پیش‌فرضی ندارید؛ تا قبل از تعیین آن، خریدها امتیاز نمی‌گیرند.
            </p>
          ) : null}
          <AppSettingsShortcut
            href={growthSectionHref("loyalty")}
            label="مدیریت برنامهٔ وفاداری"
            description="افزودن و تغییر طرح‌ها، نرخ امتیاز و انقضا در صفحهٔ «وفاداری و اعتبار» انجام می‌شود."
          />
        </div>
      ),
    },
    {
      key: "campaigns",
      label: "کمپین‌ها و تخفیف‌ها",
      description: "قانون تخفیف، کالاهای مشمول، زمان‌بندی و ترکیب‌پذیری.",
      icon: MegaphoneIcon,
      body: (
        <AppSettingsShortcut
          href={growthSectionHref("campaigns")}
          label="مدیریت کمپین‌ها"
          description="هر کمپین قواعد خودش را دارد و در صفحهٔ «کمپین‌ها» تنظیم می‌شود."
        />
      ),
    },
    {
      key: "messaging",
      label: "پیام‌رسانی",
      description: "الگوهای پیام، رضایت ارتباط و آمادگی سرویس ارسال.",
      icon: MessageCircleIcon,
      body: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">سرویس ارسال پلتفرم:</span>
            <StatusBadge tone={readiness.messagingReady ? "positive" : "danger"}>
              {readiness.messagingReady ? "آمادهٔ ارسال" : "نیازمند تنظیم پلتفرم"}
            </StatusBadge>
          </div>
          <AppSettingsShortcut
            href={growthSectionHref("messaging")}
            label="مدیریت الگو و کمپین پیام"
            description="ساخت الگو، پیش‌نمایش مخاطب و صف ارسال در بخش «پیام‌رسانی» است."
          />
          <AppSettingsShortcut
            href={crmSectionHref("consent")}
            label="مدیریت رضایت ارتباط (CRM)"
            description="رضایت پیامک و ایمیل در برنامهٔ «ارتباط با مشتری» نگهداری می‌شود؛ این پیوند آن برنامه را باز می‌کند."
          />
        </div>
      ),
    },
    {
      key: "commission",
      label: "قواعد پورسانت",
      description: "درصد یا مبلغ ثابت، مبنای فروش یا سود و اولویت هر قاعده.",
      icon: HandCoinsIcon,
      body: (
        <AppSettingsShortcut
          href={growthSectionHref("commission")}
          label="مدیریت قواعد پورسانت"
          description="قاعده‌ها در صفحهٔ «پورسانت فروشندگان» تعریف می‌شوند."
        />
      ),
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      platformNote="اعتبار پیام و اشتراک، و همچنین اتصال فنیِ سرویس پیامک و ایمیل، متعلق به پلتفرم است — نه برنامهٔ رشد و بازاریابی."
      platformLinks={[
        {
          label: "اعتبار و صورت‌حساب پلتفرم",
          description: "شارژ اعتبار پیامک و ایمیل و تاریخچهٔ پرداخت‌ها در تنظیمات پلتفرم.",
          href: PLATFORM_BILLING_HREF,
        },
        {
          label: "اشتراک پلتفرم",
          description: "پلن فعلی کسب‌وکار و دسترسی‌های آن در تنظیمات پلتفرم.",
          href: PLATFORM_SUBSCRIPTION_HREF,
        },
      ]}
    />
  );
}
