"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { isValidPin } from "@/lib/pin-policy";
import type { AppKey } from "@/lib/apps";
import type { SetupAppCatalogData } from "@/lib/setup-apps";
import {
  SETUP_IMPORT_STATE_LABELS,
  SETUP_IMPORT_STATE_TONE,
  type SetupImportsData,
} from "@/lib/setup-imports";
import { api, ErrorBox, errorMessage, InfoBox, inputClass, PrimaryButton, SetupDataSkeleton } from "../ui";
import { catalogueHrefFor } from "@/lib/wizard-steps";
import { stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

interface StateResponse {
  business?: { name: string; industry?: string } | null;
  location?: { name: string; address: string | null; phone: string | null } | null;
  logo?: { dataUrl: string } | null;
  selectedApps?: AppKey[] | null;
  progress?: { steps: Record<string, string>; completedAt: string | null };
  counts?: { accounts: number; users: number; categories: number; items: number; printers: number };
  missingForCompletion?: string[];
  siteInstall?: boolean;
  error?: string;
}

/**
 * Step 4 (issue #1239 / ESH-90): review, then hand off to the dashboard.
 *
 * Finish is intentionally cheap: it requires the business profile and every
 * *selected* app's essential answers, and nothing else. Imports, menu/catalogue
 * population, staff, printers, backups and opening balances never block it.
 * No money moves here; unpaid selected apps are shown as “setup ready, awaiting
 * payment”, never as active.
 */
export default function FinishPage() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const money = useMoney();
  const [state, setState] = useState<StateResponse | null>(null);
  const [apps, setApps] = useState<SetupAppCatalogData | null>(null);
  const [imports, setImports] = useState<SetupImportsData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  /** The owner's quick-login PIN — asked once, at the end, as the product flow requires. */
  const [owner, setOwner] = useState<{ id: string; hasPin: boolean } | null>(null);
  const [ownerPin, setOwnerPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState("");
  const [pinSaved, setPinSaved] = useState(false);

  const load = useCallback(() => {
    void Promise.all([
      api<StateResponse>("/api/setup/state"),
      api<SetupAppCatalogData>("/api/setup/apps"),
      api<{ users?: { id: string; role: string; has_pin: boolean }[] }>("/api/setup/users"),
      // Optional import sessions are summarised here as *information*, never as
      // a Finish requirement (issue #1535 / ESH-218).
      api<SetupImportsData>("/api/setup/imports"),
    ]).then(([stateResult, appsResult, usersResult, importsResult]) => {
      if (stateResult.ok) {
        setState(stateResult.data);
        setCompleted(Boolean(stateResult.data.progress?.completedAt));
      } else {
        setError("بارگذاری وضعیت راه‌اندازی ممکن نشد.");
      }
      if (appsResult.ok) setApps(appsResult.data);
      if (importsResult.ok) setImports(importsResult.data);
      const ownerRow = usersResult.ok
        ? usersResult.data.users?.find((row) => row.role === "owner")
        : undefined;
      if (ownerRow) setOwner({ id: ownerRow.id, hasPin: ownerRow.has_pin });
    });
  }, []);
  useEffect(load, [load]);

  async function complete() {
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string; messages?: string[] }>(
        "/api/setup/complete",
        { method: "POST" },
      );
      if (!ok) {
        // `incomplete` (409) means readiness regressed between this page's
        // read and the press — the reload below refreshes the checklist and
        // the reason list. A transport failure (status 0) reads as a
        // connection problem without pretending anything about the data.
        setError(errorMessage(data?.error, data?.messages, status));
        load();
        return;
      }
      setCompleted(true);
      router.replace("/dashboard");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Save the owner's first PIN.
   *
   * A PIN has nothing to prove against the first time, so this is the same
   * "set, don't rotate" path the profile screen uses — and on a paired install
   * the write is pushed to the cloud by the credential sync, which is what
   * keeps the PIN the owner chose here equal to the one the cloud knows.
   */
  async function saveOwnerPin(e: React.FormEvent) {
    e.preventDefault();
    if (!owner) return;
    if (!isValidPin(ownerPin)) {
      setPinError("رمز عددی باید ۴ تا ۱۲ رقم باشد.");
      return;
    }
    setPinBusy(true);
    setPinError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>(
        `/api/team/${owner.id}/credentials`,
        { method: "PUT", body: JSON.stringify({ pin: ownerPin }) },
      );
      if (!ok) {
        setPinError(errorMessage(data.error, undefined, status));
        return;
      }
      setPinSaved(true);
      setOwnerPin("");
      setOwner({ ...owner, hasPin: true });
    } finally {
      setPinBusy(false);
    }
  }

  if (state === null) {
    return (
      <div>
        <ErrorBox>{error}</ErrorBox>
        <SetupDataSkeleton rows={5} />
      </div>
    );
  }

  // `null` is the legacy "never saved a choice" state and must keep the full
  // sequence; `[]` is an explicit zero-app choice and drops Accounting's steps.
  const selectedApps = state.selectedApps;
  const steps = stepsFor(industry, selectedApps).filter(
    (s) => s.id !== "backup" || state.siteInstall,
  );
  const selectedCards = (apps?.cards ?? []).filter((card) => card.selected);
  const appSetupRequired = (selectedApps?.length ?? 0) > 0;
  const incompleteApps = selectedCards.filter((card) => !card.setupComplete);
  const unpricedApps = selectedCards.filter((card) => !card.pricing);
  const missing = [
    ...(state.selectedApps === null ? ["انتخاب برنامه‌ها ذخیره نشده است."] : []),
    ...(state.missingForCompletion ?? []),
    ...incompleteApps.map((card) => `راه‌اندازی برنامهٔ ${card.label} کامل نشده است.`),
    ...unpricedApps.map((card) => `تعرفهٔ منتشرشدهٔ برنامهٔ ${card.label} موجود نیست.`),
  ];
  // Non-F&B trades have no menu step: their catalogue lives in the products
  // workspace / their trade's own items page, and this points at it.
  const catalogueHref = catalogueHrefFor(industry);
  const catalogueLabel =
    industry === "jewelry" || industry === "watch" ? "صفحهٔ کالاهای همین صنف" : "پنل محصولات";

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-bold">پایان راه‌اندازی</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مرور اطلاعات کسب‌وکار و برنامه‌های انتخاب‌شده، سپس ورود به داشبورد.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>

      {completed ? (
        <div className={`${cardClass} p-6 text-center`}>
          <p className="mb-2 text-2xl">🎉</p>
          <p className="mb-1 font-bold text-foreground">راه‌اندازی اولیه کامل شد!</p>
          <p className="mb-4 text-sm text-muted-foreground">
            حالا به داشبورد می‌روید. برنامه‌های انتخاب‌شده تا زمانی که فعال‌سازی
            و پرداخت را تأیید نکرده‌اید، هزینه‌ای از کیف پول کم نمی‌کنند.
          </p>
          <Link
            href="/dashboard"
            className="inline-block rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            رفتن به داشبورد
          </Link>
        </div>
      ) : (
        <>
          <section className={`${cardClass} mb-6 p-5`} aria-label="مرور کسب‌وکار">
            <div className="flex flex-wrap items-center gap-4">
              {state.logo?.dataUrl ? (
                <img
                  src={state.logo.dataUrl}
                  alt="لوگوی کسب‌وکار"
                  className="h-14 w-auto max-w-32 rounded-lg border border-border bg-card p-1"
                />
              ) : null}
              <div className="min-w-0">
                <p className="font-semibold text-foreground">{state.business?.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {state.location?.name ?? "شعبهٔ مرکزی"}
                  {state.location?.address ? ` — ${state.location.address}` : ""}
                  {state.location?.phone ? ` — ${state.location.phone}` : ""}
                </p>
              </div>
              <Link href="/setup/business" className="ms-auto text-xs text-primary hover:underline">
                ویرایش اطلاعات
              </Link>
            </div>
          </section>

          <section className={`${cardClass} mb-6 p-5`} aria-label="برنامه‌های انتخاب‌شده">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-foreground">برنامه‌های انتخاب‌شده</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedCards.length === 0
                    ? "هیچ برنامه‌ای انتخاب نشده است. می‌توانید بدون برنامه هم راه‌اندازی را تمام کنید."
                    : "وضعیت واقعی هر برنامه؛ برنامهٔ انتخاب‌شده تا پرداخت و تأیید فعال‌سازی، فعال نیست."}
                </p>
              </div>
              <Link href="/setup/apps" className="text-xs text-primary hover:underline">
                تغییر انتخاب برنامه‌ها
              </Link>
            </div>

            {selectedCards.length > 0 ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {selectedCards.map((card) => (
                  <li key={card.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        className={`size-2 rounded-full ${
                          card.setupComplete
                            ? "bg-emerald-600 dark:bg-emerald-400"
                            : "bg-amber-500 dark:bg-amber-400"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-foreground">{card.label}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {card.activation?.active
                        ? "فعال"
                        : card.setupComplete
                          ? "راه‌اندازی آماده — در انتظار پرداخت و فعال‌سازی"
                          : "نیاز به تکمیل راه‌اندازی"}
                    </span>
                    {!card.setupComplete ? (
                      <Link href="/setup/app-setup" className="text-xs text-primary hover:underline">
                        تکمیل راه‌اندازی
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {selectedCards.length > 0 ? (
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-muted/50 p-3">
                  <dt className="text-xs text-muted-foreground">جمع هزینهٔ راه‌اندازی</dt>
                  <dd className="mt-1 font-semibold tabular-nums text-foreground">
                    {money.format(apps?.totals.setupRial ?? 0)}
                  </dd>
                </div>
                <div className="rounded-xl bg-muted/50 p-3">
                  <dt className="text-xs text-muted-foreground">جمع برآورد روزانه</dt>
                  <dd className="mt-1 font-semibold tabular-nums text-foreground">
                    {money.format(apps?.totals.estimated24hRial ?? 0)}
                  </dd>
                </div>
              </dl>
            ) : null}

            {selectedCards.length > 0 ? (
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                شروع هزینه فقط بعد از فعال‌سازی تأییدشده و با موجودی کافی کیف پول
                است. مبلغ راه‌اندازی یک‌بار برای هر برنامه کسر می‌شود و هفت روز
                استفادهٔ رایگان ایجاد نمی‌کند.
              </p>
            ) : null}
          </section>

          <section className={`${cardClass} mb-6 p-5`} aria-label="ورود اطلاعات اولیه">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-foreground">
                  ورود اطلاعات اولیه <span className="text-xs font-normal text-muted-foreground">(اختیاری)</span>
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {imports && imports.summary.total > 0
                    ? "وضعیت واقعی جلسه‌های ورود اطلاعات؛ هیچ‌کدام برای پایان راه‌اندازی الزامی نیستند."
                    : "هنوز اطلاعاتی وارد نشده است. ورود اطلاعات اختیاری است و هر زمان می‌توانید ادامه دهید."}
                </p>
              </div>
              <Link href="/setup/import" className="text-xs text-primary hover:underline">
                {imports && imports.summary.total > 0
                  ? "ادامه یا بازبینی ورود اطلاعات"
                  : "ورود اطلاعات"}
              </Link>
            </div>

            {imports && imports.sessions.length > 0 ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {imports.sessions.slice(0, 5).map((session) => (
                  <li
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{session.entityLabel}</span>
                      <StatusBadge tone={SETUP_IMPORT_STATE_TONE[session.state]}>
                        {SETUP_IMPORT_STATE_LABELS[session.state]}
                      </StatusBadge>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {toPersianDigits(session.createdRows)} ساخته‌شده،{" "}
                      {toPersianDigits(session.updatedRows)} به‌روزشده،{" "}
                      {toPersianDigits(session.failedRows)} ناموفق
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {imports && imports.summary.unfinished > 0 ? (
              <p className="mt-3 rounded-lg border border-amber-600/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-foreground">
                {toPersianDigits(imports.summary.unfinished)} جلسه هنوز به تأیید یا
                بازبینی نیاز دارد؛ ثبت آن‌ها در پایان راه‌اندازی دخالتی ندارد و از
                داشبورد هم قابل ادامه است.
              </p>
            ) : null}
          </section>

          <InfoBox>
            {selectedCards.length === 0
              ? "بدون برنامهٔ انتخاب‌شده، هشدار شارژ کیف پول نمایش داده نمی‌شود. هر زمان خواستید از داشبورد برنامه اضافه کنید."
              : "با تکمیل راه‌اندازی، هیچ مبلغی از کیف پول کسر نمی‌شود. پرداخت و فعال‌سازی را بعداً با مشاهدهٔ صورت‌حساب نهایی تأیید می‌کنید."}
          </InfoBox>

          <ul className="mb-6 divide-y divide-border rounded-xl border border-border">
            {steps.map((s) => {
              const done = Boolean(state?.progress?.steps[s.id]);
              return (
                <li key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="flex items-center gap-2">
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                        done ? "bg-emerald-700 dark:bg-emerald-300 text-white" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {done ? "✓" : "•"}
                    </span>
                    {s.title}
                    {s.optional && !(s.id === "app_setup" && appSetupRequired) ? (
                      <span className="text-xs text-muted-foreground">(اختیاری)</span>
                    ) : null}
                  </span>
                  <Link href={s.path} className="text-xs text-primary hover:underline">
                    {done ? "ویرایش" : "تکمیل"}
                  </Link>
                </li>
              );
            })}
          </ul>

          {state?.counts ? (
            <p className="mb-6 text-sm text-muted-foreground">
              {toPersianDigits(state.counts.accounts)} حساب، {toPersianDigits(state.counts.users)} کاربر
              {industry === "food_service" ? (
                <>
                  ، {toPersianDigits(state.counts.categories)} دستهٔ منو، {toPersianDigits(state.counts.items)} آیتم
                </>
              ) : null}
              ، {toPersianDigits(state.counts.printers)} چاپگر ثبت شده است.
            </p>
          ) : null}

          {missing.length > 0 ? (
            <div className="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm text-primary">
              <p className="mb-1 font-semibold">برای تکمیل، این موارد باقی مانده‌اند:</p>
              {missing.map((m, i) => (
                <p key={i}>• {m}</p>
              ))}
            </div>
          ) : null}

          {catalogueHref ? (
            <div className="mb-6 rounded-lg border border-border bg-muted/40 p-4 text-sm">
              <p className="mb-1 font-semibold">ثبت کالاها و موجودی</p>
              <p className="text-muted-foreground">
                کالاهای قابل فروش این کسب‌وکار از{" "}
                <Link href={catalogueHref} className="text-primary hover:underline">
                  {catalogueLabel}
                </Link>{" "}
                ثبت می‌شوند؛ ورود آن‌ها برای پایان راه‌اندازی الزامی نیست و بعداً هم
                از همان مسیر ادامه می‌دهید.
              </p>
            </div>
          ) : null}

          {owner && !owner.hasPin && !pinSaved ? (
            <section className={`${cardClass} mb-6 p-5`} aria-label="رمز عددی ورود سریع">
              <p className="font-semibold text-foreground">رمز عددی ورود سریع خود را بسازید</p>
              <p className="mt-1 text-sm text-muted-foreground">
                بعد از پایان راه‌اندازی، روی این دستگاه با انتخاب نام و همین رمز وارد
                می‌شوید — بدون ایمیل و رمز عبور. هر وقت خواستید از تنظیمات پروفایل
                عوضش کنید.
              </p>
              <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={saveOwnerPin}>
                <div>
                  <label htmlFor="owner-pin" className="mb-1 block text-xs text-muted-foreground">
                    رمز عددی (۴ تا ۱۲ رقم)
                  </label>
                  <input
                    id="owner-pin"
                    className={`${inputClass} w-40 text-center tracking-[0.25em]`}
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={12}
                    value={ownerPin}
                    onChange={(e) => setOwnerPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
                  />
                </div>
                <PrimaryButton disabled={pinBusy || !isValidPin(ownerPin)}>ثبت رمز عددی</PrimaryButton>
                {pinError ? <p className="text-sm text-destructive">{pinError}</p> : null}
              </form>
            </section>
          ) : pinSaved ? (
            <p className="mb-6 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-4 py-3 text-sm text-foreground">
              رمز عددی ثبت شد؛ از این پس با انتخاب نام خود وارد می‌شوید.
            </p>
          ) : null}

          <PrimaryButton type="button" onClick={complete} disabled={busy || missing.length > 0}>
            تکمیل راه‌اندازی و ورود به داشبورد
          </PrimaryButton>
        </>
      )}
    </div>
  );
}
