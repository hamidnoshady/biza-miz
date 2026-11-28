"use client";

/**
 * Step «ورود اطلاعات» (#1535 / ESH-218, unified by #1580).
 *
 * This screen composes the EXISTING Data Transfer engine — it does not parse,
 * map, validate, reconcile or apply anything itself. The engine's own screens,
 * routes, permissions, provenance and idempotency are reused unchanged; this
 * page only decides what is relevant to this business *at onboarding time* and
 * surrounds it with the wizard's navigation.
 *
 * Three source paths are offered honestly, all inside this one step:
 *  - a file import, fully inline (CSV/XLSX/JSON/PDF through `ImportSection`);
 *  - an existing website/software connection, created and tested inline in a
 *    right-side Sheet that composes the canonical provider services;
 *  - manual entry, including the F&B menu editor the old duplicate «ورود منو»
 *    step used to own.
 *
 * Nothing here activates an app, debits a wallet, posts a historical financial
 * document or silently merges a duplicate: those remain the engine's and the
 * domain services' decisions, behind their own approval screens.
 */

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
import { SetupConnectionSheet } from "./connection-sheet";
import { SetupMenuManualEditor } from "./menu-manual-editor";

type SourceMode = "file" | "provider" | "manual";
type Provider = "woocommerce" | "wordpress" | "eshobe";

interface ImportsResponse extends SetupImportsData {
  entities: CatalogueEntity[];
  error?: string;
}

const PROVIDER_CHOICES: {
  key: Provider;
  title: string;
  description: string;
}[] = [
  {
    key: "woocommerce",
    title: "ووکامرس",
    description:
      "فروشگاه ووکامرس: محصولات، دسته‌ها، مشتریان و سفارش‌ها از همان اتصال.",
  },
  {
    key: "wordpress",
    title: "وردپرس",
    description:
      "سایت وردپرسی: نوشته‌ها و برگه‌ها با افزونهٔ وردپرس و بدون رمز فروشگاه.",
  },
  {
    key: "eshobe",
    title: "Eshobe CMS",
    description: "سایت ساخته‌شده روی Eshobe: محتوا و کاتالوگ سایت.",
  },
];

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
  const [provider, setProvider] = useState<Provider>("woocommerce");
  const [sheetOpen, setSheetOpen] = useState(false);
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

  // The one legacy entry point left: `/setup/menu` redirects here with
  // `?source=manual&section=menu`, and the desktop/help guidance links to the
  // same URL. Reading it from the address bar (rather than `useSearchParams`)
  // keeps this client page out of a Suspense boundary it does not need.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const source = params.get("source");
    if (source === "manual" || source === "provider" || source === "file") {
      setMode(source);
    }
  }, []);

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

  const manualDestinations = useMemo(() => {
    const catalogue = catalogueHrefFor(industry);
    return [
      {
        label: "مشتریان و تأمین‌کنندگان",
        hint: "دفتر طرف‌حساب‌ها؛ پس از پایان راه‌اندازی از همین مسیر باز می‌شود.",
      },
      ...(catalogue
        ? [
            {
              label: "کالاها و موجودی",
              hint: "پنل کالای همین صنف؛ پس از پایان راه‌اندازی از همین مسیر باز می‌شود.",
            },
          ]
        : []),
      {
        label: "اسناد و سابقهٔ مالی",
        hint: "ورود فاکتورهای فروش قبلی؛ پس از پایان راه‌اندازی از «انتقال داده» در تنظیمات.",
      },
    ];
  }, [industry]);

  const selectedCandidate = useMemo(
    () => data?.candidates.find((candidate) => candidate.key === entityKey) ?? null,
    [data?.candidates, entityKey],
  );

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

  async function resumeParked(session: SetupImportSession) {
    setError("");
    const result = await api<{ error?: string; message?: string }>(
      `/api/data/imports/${session.id}`,
      {
        method: "POST",
        body: JSON.stringify({ action: "run" }),
      },
    );
    if (!result.ok) {
      setError(
        typeof result.data?.message === "string"
          ? result.data.message
          : "از سرگیری ورود اطلاعات ممکن نشد؛ وضعیت دسترسی سرویس را بررسی کنید.",
      );
      return;
    }
    await load(true);
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
      description="اگر اطلاعات کسب‌وکارتان (مشتریان، کالاها، موجودی، منو یا سابقهٔ مالی) از قبل در فایل یا نرم‌افزار دیگری است، همین‌جا وارد کنید. این مرحله اختیاری است: هر زمان می‌توانید رد شوید، بعداً ادامه دهید یا از داشبورد برگردید. هیچ ورودی‌ای برنامه‌ای را فعال یا مبلغی از کیف پول کم نمی‌کند."
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
        description="یکی از راه‌های زیر را انتخاب کنید. هر سه راه کامل داخل همین صفحه انجام می‌شوند؛ برای اتصال یا ثبت دستی به صفحهٔ دیگری نمی‌روید."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {[
            {
              key: "file" as const,
              icon: FileUpIcon,
              title: "بارگذاری فایل",
              description:
                "جدول‌های XLSX، CSV و JSON؛ PDF فقط وقتی جدول آن قابل تشخیص باشد و همیشه با پیش‌نمایش اجباری.",
            },
            {
              key: "provider" as const,
              icon: Link2Icon,
              title: "اتصال به سیستم موجود",
              description:
                "ووکامرس، وردپرس و Eshobe CMS؛ ساخت، بررسی و استفاده از اتصال در همان صفحه.",
            },
            {
              key: "manual" as const,
              icon: PencilIcon,
              title: "ورود دستی",
              description:
                "برای وقتی داده کم است یا فایل آماده نیست؛ فرم‌ها و ثبت‌های همین بخش.",
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
                      const usable = candidate.available || candidate.stagingAllowed;
                      const selected = usable && entityKey === candidate.key;
                      return (
                        <button
                          key={candidate.key}
                          type="button"
                          aria-pressed={selected}
                          aria-disabled={!usable}
                          onClick={() => {
                            if (usable) chooseType(candidate.key);
                          }}
                          className={`${cardClass} p-4 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
                            selected
                              ? "ring-2 ring-primary"
                              : usable
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

      {mode === "file" && entityKey && selectedCandidate?.stagingAllowed && !selectedCandidate.available ? (
        <InfoBox>
          {selectedCandidate.reasonLabel} می‌توانید فایل را همین حالا بارگذاری،
          نگاشت و پیش‌نمایش کنید؛ جلسه ذخیره می‌ماند و بعد از فعال‌شدن سرویس، با
          همان بازبینی تأیید و اجرا می‌شود.
        </InfoBox>
      ) : null}

      {mode === "file" && selectedCandidate && (selectedCandidate.available || selectedCandidate.stagingAllowed) ? (
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
          title="۲. اتصال سیستم موجود"
          description="اتصال را همین‌جا بسازید یا اتصال موجود را دوباره بررسی کنید. پس از اتصال، ورود اولیه در همان موتور با نگاشت، پیش‌نمایش و تأیید انجام می‌شود."
        >
          <div className="grid gap-3 md:grid-cols-3">
            {PROVIDER_CHOICES.map((choice) => (
              <button
                key={choice.key}
                type="button"
                onClick={() => {
                  setProvider(choice.key);
                  setSheetOpen(true);
                }}
                className={`${cardClass} p-4 text-start transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{choice.title}</span>
                  <Link2Icon className="size-4 text-primary" aria-hidden="true" />
                </span>
                <span className="mt-2 block text-sm leading-6 text-muted-foreground">
                  {choice.description}
                </span>
                <span className="mt-3 block text-xs font-medium text-primary">
                  ساخت یا بررسی اتصال
                </span>
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            اتصال یک سرویس، خودکار به معنای همگام‌سازی دوطرفه نیست؛ در ساخت اتصال
            از این مرحله هیچ همگام‌سازی زمان‌بندی‌شده یا نوشتن روی سایت روشن
            نمی‌شود. جهت و مالکیت هر فیلد بعداً و صریح تعیین می‌شود.
          </p>
        </SectionCard>
      ) : null}

      {mode === "manual" ? (
        <SectionCard
          title="۲. ثبت دستی"
          description="فرم‌های اصلی هر بخش؛ مناسب وقتی داده کم است یا فایل آماده ندارید."
        >
          {industry === "food_service" ? <SetupMenuManualEditor /> : null}
          <div className="mt-4 rounded-xl border border-border">
            <p className="border-b border-border px-4 py-2 text-xs font-semibold text-muted-foreground">
              بقیهٔ بخش‌ها
            </p>
            <ul className="divide-y divide-border">
              {manualDestinations.map((entry) => (
                <li key={entry.label} className="px-4 py-3 text-sm">
                  <span className="font-medium text-foreground">{entry.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {entry.hint}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            تا پایان راه‌اندازی، صفحه‌های داخلی برنامه باز نمی‌شوند؛ بنابراین ثبت
            دستی سنگین‌تر (کالا، طرف‌حساب، سند مالی) یا از همین فایل انجام می‌شود
            یا بلافاصله بعد از پایان از مسیر نام‌برده در دسترس است. ثبت منو در
            همین صفحه انجام می‌شود.
          </p>
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
                  {session.state === "failed" && session.failedRows === 0 ? (
                    <button
                      type="button"
                      onClick={() => void resumeParked(session)}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      از سرگیری پس از فعال‌سازی
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

      <SetupConnectionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        initialProvider={provider}
        onConnected={() => {
          setSheetOpen(false);
          setMode("file");
          void load(true);
        }}
      />
    </StepShell>
  );
}
