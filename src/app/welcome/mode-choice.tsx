"use client";

import {
  ArrowLeftIcon,
  Building2Icon,
  CheckIcon,
  CloudIcon,
  HardDriveIcon,
  HistoryIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WifiOffIcon,
} from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";

const options = [
  {
    mode: "local" as const,
    icon: HardDriveIcon,
    title: "ساخت یک کسب‌وکار جدید",
    eyebrow: "راه‌اندازی روی این دستگاه",
    description:
      "از صفر شروع کنید و اطلاعات کسب‌وکار، حساب‌ها و فروش را قدم‌به‌قدم آماده کنید.",
    points: [
      "بدون نیاز دائمی به اینترنت",
      "اطلاعات روی همین دستگاه",
      "مناسب یک شعبه و شروع سریع",
    ],
    badge: "پیشنهاد برای شروع",
  },
  {
    mode: "connect" as const,
    icon: CloudIcon,
    title: "اتصال کسب‌وکار موجود",
    eyebrow: "همگام‌سازی با پنل آنلاین",
    description:
      "این دستگاه را با کد اتصال به کسب‌وکاری که قبلاً در پنل آنلاین ساخته‌اید وصل کنید.",
    points: [
      "دریافت منو، کاربران و حساب‌ها",
      "ورود کارکنان با پین فعلی",
      "آماده‌سازی در چند دقیقه",
    ],
    badge: "برای کسب‌وکار فعال",
  },
];

/**
 * Shown only when the server says this empty desktop install may restore
 * (GET /api/setup/restore) — the way back after uninstalling and reinstalling.
 */
const restoreOption = {
  mode: "restore" as const,
  icon: HistoryIcon,
  title: "بازگردانی از فایل پشتیبان",
  eyebrow: "بعد از نصب دوباره",
  description:
    "فایل پشتیبانی را که قبل از حذف برنامه ساخته‌اید بارگذاری کنید تا همهٔ داده‌ها و حساب‌های قبلی برگردند.",
  points: [
    "فایل ‎.dump‎ یا ‎.dump.enc‎",
    "ابتدا بررسی، سپس بازگردانی",
    "اتصال ابری بعداً با «ترمیم اتصال»",
  ],
  badge: "برای نصب دوباره",
};

export type SetupMode = "local" | "connect" | "restore";

export function ModeChoice({
  onChoose,
  canRestore = false,
}: {
  onChoose: (mode: SetupMode) => void;
  canRestore?: boolean;
}) {
  const shown = canRestore ? [...options, restoreOption] : options;
  return (
    <div className="w-full max-w-5xl">
      <div className="mb-8 text-center sm:mb-10">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
          <SparklesIcon className="size-7" aria-hidden="true" />
        </div>
        <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
          راه‌اندازی اولیه
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.7rem]">
          به فضای کار خودتان خوش آمدید
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          برای شروع فقط روش راه‌اندازی را انتخاب کنید؛ در مرحله‌های بعد
          می‌توانید همه جزئیات را بررسی و ویرایش کنید.
        </p>
      </div>

      <div className={`grid gap-4 sm:grid-cols-2 ${canRestore ? "lg:grid-cols-3" : ""}`}>
        {shown.map((option) => {
          const Icon = option.icon;
          return (
            <article
              key={option.mode}
              className={`${cardClass} flex min-h-[330px] flex-col p-5 sm:p-6`}
            >
              <div className="mb-5 flex items-start justify-between gap-3">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                  <Icon className="size-6" aria-hidden="true" />
                </div>
                <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {option.badge}
                </span>
              </div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                {option.eyebrow}
              </p>
              <h2 className="mt-1 text-lg font-bold text-foreground">
                {option.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {option.description}
              </p>
              <ul className="mt-5 space-y-2.5 text-sm text-foreground/80">
                {option.points.map((point) => (
                  <li key={point} className="flex items-center gap-2">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:text-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300">
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                    </span>
                    {point}
                  </li>
                ))}
              </ul>
              <Button
                onClick={() => onChoose(option.mode)}
                className="mt-auto w-full justify-between"
              >
                انتخاب و ادامه
                <ArrowLeftIcon className="size-4" aria-hidden="true" />
              </Button>
            </article>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ShieldCheckIcon className="size-4 text-emerald-700 dark:text-emerald-300" />
          اطلاعات شما امن می‌ماند
        </span>
        <span className="flex items-center gap-1.5">
          <Building2Icon className="size-4 text-amber-700 dark:text-amber-300" />
          قابل توسعه برای شعبه‌های بعدی
        </span>
        <span className="flex items-center gap-1.5">
          <WifiOffIcon className="size-4 text-muted-foreground" />
          امکان کار آفلاین در نسخه محلی
        </span>
      </div>
    </div>
  );
}
