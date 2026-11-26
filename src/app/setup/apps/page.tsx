"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CircleAlertIcon, SparklesIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type { AppKey } from "@/lib/apps";
import { SERVICE_ADDITIONAL_CHARGES } from "@/lib/service-activation/catalog";
import type { SetupAppCard, SetupAppCatalogData } from "@/lib/setup-apps";
import {
  api,
  ErrorBox,
  InfoBox,
  PrimaryButton,
  SetupDataSkeleton,
  StepShell,
} from "../ui";
import { nextPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

const REASON_LABEL: Record<NonNullable<SetupAppCard["unavailableReason"]>, string> = {
  industry: "نوع کسب‌وکار شما با این برنامه سازگار نیست.",
  deployment: "در حالت نصب محلی/آفلاین این برنامه ارائه نمی‌شود.",
  availability: "این برنامه در حال حاضر برای کسب‌وکار شما در دسترس نیست.",
  tariff: "تعرفهٔ منتشرشده‌ای برای این برنامه وجود ندارد؛ فعلاً قابل انتخاب نیست.",
  not_selectable: "این برنامه در فروشگاه ثبت‌نام ارائه نمی‌شود.",
};

/**
 * Step 2 (issue #1239 / ESH-90): the priced app gallery.
 *
 * “Selecting” here writes a draft intent only. It never activates the app and
 * never touches the wallet; the binding quote and the explicit paid activation
 * happen after Finish, from the wallet surface. That separation is the point of
 * this screen, so the copy says it plainly.
 */
export default function AppsStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const money = useMoney();
  const steps = useMemo(() => stepsFor(industry), [industry]);
  const [data, setData] = useState<SetupAppCatalogData | null>(null);
  const [selected, setSelected] = useState<Set<AppKey>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<SetupAppCatalogData>("/api/setup/apps")
      .then(({ ok, data: loaded }) => {
        if (!ok) {
          setError("بارگذاری برنامه‌ها ممکن نشد.");
          return;
        }
        setData(loaded);
        setSelected(new Set(loaded.selected));
      })
      .catch(() => setError("بارگذاری برنامه‌ها ممکن نشد."));
  }, []);

  function toggle(card: SetupAppCard) {
    setSelected((current) => {
      // An app that was selected earlier may have lost its published tariff or
      // availability. It must still be removable, or the owner would be stuck
      // with a selection the server now refuses.
      if (!card.selectable && !current.has(card.key)) return current;
      const next = new Set(current);
      if (next.has(card.key)) {
        // Keep the app's saved setup answers; only the selection is undone.
        if (
          card.hasSetupProgress &&
          !window.confirm(
            "برای این برنامه پاسخ‌های راه‌اندازی ذخیره شده است. با برداشتن انتخاب، آن پاسخ‌ها حذف نمی‌شوند و اگر دوباره انتخاب کنید ادامه می‌دهید. ادامه می‌دهید؟",
          )
        ) {
          return current;
        }
        next.delete(card.key);
      } else {
        next.add(card.key);
      }
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const { ok, data: saved } = await api<SetupAppCatalogData & { error?: string }>(
        "/api/setup/apps",
        { method: "PUT", body: JSON.stringify({ apps: [...selected] }) },
      );
      if (!ok) {
        setError(
          saved.error === "invalid_app"
            ? "یکی از برنامه‌های انتخاب‌شدهٔ قابل انتخاب نیست؛ فهرست را تازه کنید."
            : "ذخیرهٔ انتخاب برنامه‌ها ممکن نشد.",
        );
        return;
      }
      setData(saved);
      router.push(nextPath("apps", steps));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div>
        <ErrorBox>{error}</ErrorBox>
        <SetupDataSkeleton rows={5} />
      </div>
    );
  }

  // Waived charges contribute nothing: the owner's expected total must agree
  // with the authoritative quote the activation will use.
  const waived = (card: SetupAppCard, charge: "setup" | "rental") =>
    card.offer.mode !== "standard" &&
    (charge === "setup" ? card.offer.waiveSetup : card.offer.waiveRental);
  const totals = data.cards
    .filter((card) => selected.has(card.key) && card.pricing)
    .reduce(
      (sum, card) => ({
        setupRial: sum.setupRial + (waived(card, "setup") ? 0 : card.pricing?.setupRial ?? 0),
        estimated24hRial:
          sum.estimated24hRial +
          (waived(card, "rental") ? 0 : card.pricing?.estimated24hRial ?? 0),
      }),
      { setupRial: 0, estimated24hRial: 0 },
    );
  const selectedCards = data.cards.filter((card) => selected.has(card.key));

  return (
    <StepShell
      step="apps"
      description="برنامه‌هایی را که این کسب‌وکار لازم دارد انتخاب کنید. قیمت‌ها از تعرفهٔ منتشرشدهٔ مدیر سامانه خوانده می‌شوند و انتخاب شما فعلاً هیچ مبلغی از کیف پول کسر نمی‌کند."
    >
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>
        «انتخاب» فقط برنامه را برای راه‌اندازی علامت می‌زند. فعال‌سازی و پرداخت
        بعد از پایان راه‌اندازی، با نمایش صورت‌حساب نهایی و تأیید خودتان انجام
        می‌شود.
      </InfoBox>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.cards.map((card) => {
          const isSelected = selected.has(card.key);
          const disabled = !card.selectable;
          return (
            <article
              key={card.key}
              className={`${cardClass} flex flex-col p-5 ${
                isSelected ? "ring-2 ring-primary" : ""
              } ${disabled ? "opacity-75" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                    <SparklesIcon className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">{card.label}</p>
                    {card.activation?.active ? (
                      <span className="text-xs text-emerald-700 dark:text-emerald-300">فعال</span>
                    ) : null}
                    {card.offerLabel ? (
                      <span
                        className={
                          card.offer.mode === "free_days" || card.offer.mode === "free_indefinite"
                            ? "mt-1 inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                            : "mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        }
                      >
                        {card.offerLabel}
                      </span>
                    ) : null}
                  </div>
                </div>
                {isSelected ? (
                  <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                    <CheckIcon className="size-3.5" aria-hidden="true" />
                    {card.activation?.active
                      ? "فعال"
                      : "انتخاب‌شده — در انتظار پرداخت"}
                  </span>
                ) : null}
              </div>

              <p className="mt-3 text-sm leading-6 text-muted-foreground">{card.description}</p>

              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {card.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              {card.pricing ? (
                <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-muted/50 p-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">هزینهٔ راه‌اندازی یک‌باره</dt>
                    <dd className="mt-1 font-semibold tabular-nums text-foreground">
                      {waived(card, "setup")
                        ? "معاف — رایگان"
                        : money.format(card.pricing.setupRial)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">برآورد روزانه (۲۴ ساعت)</dt>
                    <dd className="mt-1 font-semibold tabular-nums text-foreground">
                      {waived(card, "rental")
                        ? "معاف — رایگان"
                        : money.format(card.pricing.estimated24hRial)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {REASON_LABEL[card.unavailableReason ?? "tariff"]}
                </p>
              )}

                              {card.pricing ? (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {waived(card, "rental")
                    ? "در دورهٔ رایگان، هزینهٔ فعال بودن برنامه معاف است و پس از پایان آن به‌طور خودکار به اشتراک پرداختی تبدیل نمی‌شود."
                    : `نرخ ساعتی ${money.format(card.pricing.hourlyRial)} است.`}{" "}
                  مصرف هوش مصنوعی، پیامک، فضای رسانه و ترافیک سایت جداگانه محاسبه می‌شود.
                </p>
              ) : null}

              {!card.selectable && card.pricing ? (
                <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {REASON_LABEL[card.unavailableReason ?? "availability"]}
                </p>
              ) : null}

              <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
                <span className="text-xs text-muted-foreground">
                  {disabled ? "غیرقابل انتخاب" : "بدون کسر از کیف پول"}
                </span>
                <PrimaryButton
                  type="button"
                  onClick={() => toggle(card)}
                  disabled={disabled && !isSelected}
                  ariaPressed={isSelected}
                >
                  {isSelected ? "برداشتن انتخاب" : "انتخاب برای راه‌اندازی"}
                </PrimaryButton>
              </div>
            </article>
          );
        })}
      </div>

      <section className={`${cardClass} mt-6 p-5`} aria-label="جمع انتخاب‌ها">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-foreground">
              {selectedCards.length === 0
                ? "هیچ برنامه‌ای انتخاب نشده است"
                : `${toPersianDigits(selectedCards.length)} برنامه انتخاب شده است`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {selectedCards.length === 0
                ? "می‌توانید بدون انتخاب برنامه ادامه دهید و بعداً از داشبورد برنامه اضافه کنید."
                : "جمع مبلغ راه‌اندازی و برآورد روزانهٔ برنامه‌های انتخاب‌شده:"}
            </p>
          </div>
          <div className="text-sm">
            <p className="text-muted-foreground">موجودی کیف پول (بدون تغییر)</p>
            <p className="font-semibold tabular-nums text-foreground">
              {money.format(data.walletBalanceRial)}
            </p>
          </div>
        </div>

        {selectedCards.length > 0 ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-muted/50 p-3">
              <dt className="text-xs text-muted-foreground">جمع هزینهٔ راه‌اندازی</dt>
              <dd className="mt-1 font-semibold tabular-nums text-foreground">
                {money.format(totals.setupRial)}
              </dd>
            </div>
            <div className="rounded-xl bg-muted/50 p-3">
              <dt className="text-xs text-muted-foreground">جمع برآورد روزانه</dt>
              <dd className="mt-1 font-semibold tabular-nums text-foreground">
                {money.format(totals.estimated24hRial)}
              </dd>
            </div>
          </dl>
        ) : null}

        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {SERVICE_ADDITIONAL_CHARGES.app.join(" ")} این مبالغ تضمینی برای مصرف
          آینده نیستند و هزینهٔ راه‌اندازی، هفت روز استفادهٔ رایگان ایجاد نمی‌کند.
        </p>

        <div className="mt-5 flex items-center justify-between gap-3">
          <PrimaryButton type="button" onClick={() => void save()} disabled={busy}>
            ذخیره و ادامه
          </PrimaryButton>
          <span className="text-xs text-muted-foreground">
            انتخاب‌ها تا پایان راه‌اندازی قابل تغییرند.
          </span>
        </div>
      </section>
    </StepShell>
  );
}
