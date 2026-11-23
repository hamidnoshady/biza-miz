"use client";

/**
 * Step «ورود اطلاعات اولیه» (issue #1535 / ESH-218).
 *
 * This screen composes the EXISTING Data Transfer engine — it does not parse,
 * map, validate, reconcile or apply anything itself. The engine's own screens,
 * routes, permissions, provenance and idempotency are reused unchanged; this
 * page only decides what is relevant to this business *at onboarding time* and
 * surrounds it with the wizard's navigation.
 *
 * Three source paths are offered honestly:
 *  - a file import, fully inline (CSV/XLSX/JSON/PDF through `ImportSection`);
 *  - a provider connection, which opens the canonical connection screen
 *    (Holoo transport, Woo/WP, Eshobe CMS) rather than pretending the wizard
 *    can connect a third-party system in a modal;
 *  - manual entry, which points at the owning workspace screen.
 *
 * Nothing here activates an app, debits a wallet, posts a historical financial
 * document or silently merges a duplicate: those remain the engine's and the
 * domain services' decisions, behind their own approval screens.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  FileUpIcon,
  HistoryIcon,
  Link2Icon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  EmptyState,
  SectionCard,
  StatusBadge,
  cardClass,
} from "@/app/dashboard/page-chrome";
import type { CatalogueEntity } from "@/app/(app)/settings/transfer/data-transfer-ui";
import { ImportSection } from "@/app/(app)/settings/transfer/import-section";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { catalogueHrefFor } from "@/lib/wizard-steps";
import {
  SETUP_IMPORT_STATE_LABELS,
  SETUP_IMPORT_STATE_TONE,
  type SetupImportSession,
  type SetupImportsData,
} from "@/lib/setup-imports";
import { api, ErrorBox, InfoBox, SetupDataSkeleton, StepShell } from "../ui";
import { stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

type SourceMode = "file" | "provider" | "manual";

interface ImportsResponse extends SetupImportsData {
  entities: CatalogueEntity[];
  error?: string;
}

const PROVIDER_LINKS = [
  {
    key: "holoo",
    title: "هلو (Holoo)",
    description:
      "انتقال کالا، طرف‌حساب، اسناد و مانده‌ها از هلو با پروفایل بررسی‌شده و مغایرت‌گیری. از تب «انتقال هلو» در ورود و خروج داده انجام می‌شود.",
    href: "/settings/data-transfer",
  },
  {
    key: "woo",
    title: "ووکامرس / وردپرس",
    description:
      "اتصال فروشگاه و همگام‌سازی کاتالوگ، قیمت و سفارش‌ها. اتصال از مدیریت وب‌سایت انجام می‌شود و ورود اولیه پس از آن در همین موتور قابل بازبینی است.",
    href: "/websites/wp",
  },
  {
    key: "eshobe",
    title: "Eshobe CMS",
    description:
      "سایت‌ساز Eshobe و مدیریت محتوا و کاتالوگ سایت. اتصال و انتشار از مدیریت وب‌سایت انجام می‌شود.",
    href: "/websites/cms",
  },
] as const;

function sessionResult(session: SetupImportSession): string {
  if (session.state === "applied" || session.state === "partial") {
    return `${toPersianDigits(session.createdRows)} ساخته‌شده، ${toPersianDigits(
      session.updatedRows,
    )} به‌روزشده، ${toPersianDigits(session.skippedRows)} ردشده، ${toPersianDigits(
      session.failedRows,
    )} ناموفق`;
  }
  if (session.state === "staged" || session.state === "applying") {
    return `${toPersianDigits(session.validRows)} معتبر، ${toPersianDigits(
      session.errorRows,
    )} نامعتبر از ${toPersianDigits(session.totalRows)} سطر`;
  }
  return session.error ?? "بدون نتیجهٔ ثبت‌شده";
}

export default function ImportStepPage() {
  const industry = useSetupIndustry();
  const [data, setData] = useState<ImportsResponse | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<SourceMode>("file");
  const [entityKey, setEntityKey] = useState("");
  const [resumeJobId, setResumeJobId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const engineRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setReloading(true);
    const { ok, data: loaded, status } = await api<ImportsResponse>("/api/setup/imports");
    setReloading(false);
    if (!ok) {
      setError(
        status === 0
          ? "ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید."
          : "بارگذاری وضعیت ورود اطلاعات ممکن نشد.",
      );
      return;
    }
    setError("");
    setData(loaded);
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const steps = useMemo(
    () => stepsFor(industry, data?.selectedApps ?? null),
    [industry, data?.selectedApps],
  );

  const groups = useMemo(() => {
    const map = new Map<string, ImportsResponse["candidates"]>();
    for (const candidate of data?.candidates ?? []) {
      const key = candidate.appLabel ?? "مشترک بین بخش‌ها";
      const list = map.get(key);
      if (list) list.push(candidate);
      else map.set(key, [candidate]);
    }
    return [...map.entries()];
  }, [data?.candidates]);

  const manualLinks = useMemo(() => {
    const catalogue = catalogueHrefFor(industry);
    return [
      {
        href: "/accounting/directory",
        label: "مشتریان و تأمین‌کنندگان",
        hint: "ثبت یکی‌یکی پرونده‌ها در دفتر طرف‌حساب‌ها",
      },
      ...(catalogue
        ? [
            {
              href: catalogue,
              label: "کالاها و موجودی",
              hint: "ثبت دستی اقلام و موجودی اولیه در پنل همین صنف",
            },
          ]
        : []),
      ...(industry === "food_service"
        ? [
            {
              href: "/setup/menu",
              label: "منوی غذا و نوشیدنی",
              hint: "دسته‌ها و آیتم‌های منو در مرحلهٔ منو",
            },
          ]
        : []),
      {
        href: "/settings/data-transfer",
        label: "اسناد و سابقهٔ مالی",
        hint: "ورود فاکتورهای فروش قبلی و تاریخچهٔ مالی",
      },
    ];
  }, [industry]);

  function chooseType(key: string) {
    setMode("file");
    setEntityKey(key);
    setResumeJobId(null);
    window.setTimeout(() => {
      engineRef.current?.scrollIntoView({ block: "start" });
    }, 0);
  }

  function resume(session: SetupImportSession) {
    setMode("file");
    setEntityKey(session.entityKey);
    setResumeJobId(session.id);
    window.setTimeout(() => {
      engineRef.current?.scrollIntoView({ block: "start" });
    }, 0);
  }

  if (!data) {
    return (
      <div>
        <ErrorBox>{error}</ErrorBox>
        <SetupDataSkeleton rows={6} />
      </div>
    );
  }

  const unfinished = data.summary.unfinished;

  return (
    <StepShell
      step="import"
      steps={steps}
      showSkip
      showNext
      description="اگر اطلاعات کسب‌وکارتان (مشتریان، کالاها، موجودی یا سابقهٔ مالی) از قبل در فایل یا نرم‌افزار دیگری است، همین‌جا وارد کنید. این مرحله اختیاری است: هر زمان می‌توانید رد شوید، بعداً ادامه دهید یا از داشبورد برگردید. هیچ ورودی‌ای برنامه‌ای را فعال یا مبلغی از کیف پول کم نمی‌کند."
    >
      <ErrorBox>{error}</ErrorBox>

      <InfoBox>
        ورود اطلاعات در این مرحله از همان موتور «ورود و خروج داده» انجام می‌شود:
        ابتدا فایل خوانده و نگاشت پیشنهاد می‌شود، سپس پیش‌نمایش بدون هیچ نوشتنی
        بررسی و تنها بعد از تأیید صریح شما اجرا می‌شود. رکوردهای تکراری بی‌صدا
        ادغام نمی‌شوند و اسناد مالی گذشته به‌طور خودکار ثبت نمی‌شوند.
      </InfoBox>

      <SectionCard
        title="۱. منبع اطلاعات"
        description="یکی از راه‌های زیر را انتخاب کنید. فقط فایل، ورود کامل داخل همین صفحه دارد؛ اتصال سرویس‌ها و ثبت دستی از صفحهٔ خودشان انجام می‌شود."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {[
            {
              key: "file" as const,
              icon: FileUpIcon,
              title: "فایل Excel، CSV یا JSON",
              description:
                "جدول‌های XLSX، CSV و JSON؛ PDF فقط وقتی جدول آن قابل تشخیص باشد و همیشه با پیش‌نمایش اجباری.",
            },
            {
              key: "provider" as const,
              icon: Link2Icon,
              title: "اتصال نرم‌افزار فعلی",
              description:
                "هلو، ووکامرس/وردپرس و Eshobe CMS؛ از صفحهٔ اتصال خودشان، با همان موتور و همان گزارش مغایرت.",
            },
            {
              key: "manual" as const,
              icon: PencilIcon,
              title: "ثبت دستی",
              description:
                "برای وقتی داده کم است یا فایل آماده نیست؛ فرم‌های خود هر بخش.",
            },
          ].map((source) => {
            const Icon = source.icon;
            const active = mode === source.key;
            return (
              <button
                key={source.key}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(source.key)}
                className={`${cardClass} p-4 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
                  active ? "ring-2 ring-primary" : "hover:bg-muted/40"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="font-semibold text-foreground">{source.title}</span>
                  {active ? (
                    <CheckIcon className="ms-auto size-4 text-primary" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="mt-2 block text-sm leading-6 text-muted-foreground">
                  {source.description}
                </span>
              </button>
            );
          })}
        </div>
      </SectionCard>

      {mode === "file" ? (
        <SectionCard
          title="۲. نوع داده"
          description="فقط داده‌هایی نمایش داده می‌شوند که با برنامه‌های انتخاب‌شده و نوع کسب‌وکار شما سازگارند. موارد غیرفعال با دلیل مشخص شده‌اند."
        >
          {!data.canImport ? (
            <InfoBox>
              برای ورود گروهی اطلاعات، مجوز «ورود داده» لازم است. از مالک کسب‌وکار
              بخواهید این دسترسی را فعال کند؛ رد کردن این مرحله هیچ‌چیز را ناقص
              نمی‌کند.
            </InfoBox>
          ) : null}

          {data.candidates.length === 0 ? (
            <EmptyState icon={FileUpIcon} title="نوع داده‌ای برای ورود ثبت نشده است">
              این نسخه برای نوع کسب‌وکار شما ورود گروهی تعریف‌شده‌ای ندارد. ثبت
              دستی از صفحهٔ هر بخش همیشه در دسترس است.
            </EmptyState>
          ) : (
            <div className="space-y-5">
              {groups.map(([groupLabel, candidates]) => (
                <div key={groupLabel}>
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">
                    {groupLabel}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {candidates.map((candidate) => {
                      const selected = candidate.available && entityKey === candidate.key;
                      return (
                        <button
                          key={candidate.key}
                          type="button"
                          aria-pressed={selected}
                          aria-disabled={!candidate.available}
                          onClick={() => {
                            if (candidate.available) chooseType(candidate.key);
                          }}
                          className={`${cardClass} p-4 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
                            selected
                              ? "ring-2 ring-primary"
                              : candidate.available
                                ? "hover:bg-muted/40"
                                : "opacity-75"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{candidate.label}</span>
                            {selected ? (
                              <CheckIcon className="ms-auto size-4 text-primary" aria-hidden="true" />
                            ) : null}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {candidate.description}
                          </span>
                          {candidate.reasonLabel ? (
                            <span className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                              {candidate.reasonLabel}
                            </span>
                          ) : (
                            <span className="mt-2 block text-xs text-emerald-700 dark:text-emerald-300">
                              آمادهٔ ورود از فایل
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      ) : null}

      {mode === "file" && data.canImport && entityKey ? (
        <div ref={engineRef} id="setup-import-engine" className="scroll-mt-4">
          <SectionCard
            title="۳. فایل، نگاشت، پیش‌نمایش و تأیید"
            description="مرحله‌های خواندن فایل، نگاشت ستون‌ها، بررسی تکراری‌ها و پیش‌نمایش بدون نوشتن؛ سپس تأیید و اجرا. اگر نیمه‌کاره رها کنید، همین جلسه ذخیره می‌ماند و بعداً ادامه می‌دهید."
          >
            <ImportSection
              entities={data.entities}
              initialEntityKey={entityKey}
              resumeJobId={resumeJobId}
              onJobQueued={() => void load(true)}
            />
          </SectionCard>
        </div>
      ) : null}

      {mode === "provider" ? (
        <SectionCard
          title="۲. اتصال نرم‌افزار فعلی"
          description="این اتصال‌ها از صفحهٔ تخصصی خودشان انجام می‌شوند؛ پس از اتصال، ورود اولیه در همان موتور بازبینی و تأیید می‌شود."
        >
          <div className="grid gap-3 md:grid-cols-3">
            {PROVIDER_LINKS.map((provider) => (
              <Link
                key={provider.key}
                href={provider.href}
                className={`${cardClass} block p-4 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{provider.title}</span>
                  <Link2Icon className="size-4 text-primary" aria-hidden="true" />
                </span>
                <span className="mt-2 block text-sm leading-6 text-muted-foreground">
                  {provider.description}
                </span>
                <span className="mt-3 block text-xs font-medium text-primary">
                  رفتن به صفحهٔ اتصال
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            اتصال یک سرویس، خودکار به معنای همگام‌سازی دوطرفه نیست؛ جهت و مالکیت
            هر فیلد در همان صفحهٔ اتصال تعیین می‌شود. ورود اولیه همیشه پیش‌نمایش و
            تأیید دارد.
          </p>
        </SectionCard>
      ) : null}

      {mode === "manual" ? (
        <SectionCard
          title="۲. ثبت دستی"
          description="فرم‌های اصلی هر بخش؛ مناسب وقتی داده کم است یا فایل آماده ندارید."
        >
          <ul className="divide-y divide-border rounded-xl border border-border">
            {manualLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span>
                    <span className="font-medium text-foreground">{link.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {link.hint}
                    </span>
                  </span>
                  <span className="text-xs text-primary">باز کردن</span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title="جلسه‌های ورود اطلاعات"
        description="هر ورودی ذخیره می‌شود: در انتظار تأیید، در حال اجرا، واردشده یا ناموفق. وضعیت‌ها دقیقاً همان چیزی است که رخ داده؛ ورودی نیمه‌کاره «وارد شد» نشان داده نمی‌شود."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={reloading}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            {reloading ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
          </button>
        }
      >
        {data.sessions.length === 0 ? (
          <EmptyState icon={HistoryIcon} title="هنوز چیزی وارد نشده است">
            اولین ورود اطلاعات — از فایل یا پس از اتصال — اینجا با تعداد رکوردها و
            وضعیت واقعی ثبت می‌شود. رد کردن این مرحله هیچ مشکلی ایجاد نمی‌کند.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {data.sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{session.entityLabel}</span>
                    <StatusBadge tone={SETUP_IMPORT_STATE_TONE[session.state]}>
                      {SETUP_IMPORT_STATE_LABELS[session.state]}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {session.fileName || "بدون فایل"} ·{" "}
                    <span className="tabular-nums">
                      {toPersianDigits(formatJalali(session.createdAt))}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sessionResult(session)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {session.state === "staged" ? (
                    <button
                      type="button"
                      onClick={() => resume(session)}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      ادامهٔ بازبینی
                    </button>
                  ) : null}
                  {session.errorRows + session.failedRows > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = `/api/data/imports/${session.id}/errors`;
                      }}
                      className="text-xs text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      گزارش خطا
                    </button>
                  ) : null}
                  <Link
                    href="/settings/data-transfer"
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    صفحهٔ کامل انتقال داده
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}

        {unfinished > 0 ? (
          <p className="mt-4 rounded-lg border border-amber-600/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-foreground">
            {toPersianDigits(unfinished)} جلسه هنوز به تأیید یا بازبینی شما نیاز دارد.
            می‌توانید الان ادامه دهید یا بعد از پایان راه‌اندازی از داشبورد به همین
            مرحله برگردید.
          </p>
        ) : null}
      </SectionCard>

      <p className="mt-6 text-xs leading-5 text-muted-foreground">
        پایان راه‌اندازی به این مرحله وابسته نیست. اگر «مرحلهٔ بعد» را بزنید، هر
        جلسهٔ نیمه‌کاره ذخیره می‌ماند و از داشبورد هم قابل ادامه است.
      </p>
    </StepShell>
  );
}
