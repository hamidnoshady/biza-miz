"use client";

/** Small shared UI pieces for the wizard steps. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { nextPath, prevPath, stepIndex, stepsFor, STEPS } from "./steps";
import type { WizardStep } from "@/lib/wizard-steps";
import { useSetupIndustry } from "./industry-context";
import { isNotableApiFailure, recordApiFailure } from "@/lib/error-report";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

/**
 * How long a wizard request may stay unanswered before it is treated as a
 * transport failure. Generous on purpose: the slowest legitimate step (a big
 * CSV/Excel menu import, a chart of accounts, an inventory count) is well
 * inside it, while a request that would otherwise hang for ever — a desktop
 * install whose backend died, a hybrid link to an unreachable server — is
 * turned into the same recoverable `status: 0` result as a dropped connection.
 */
export const SETUP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The wizard's one fetch wrapper.
 *
 * A rejected `fetch()` — dropped connection, desktop offline, hybrid link
 * down, or the request timing out — is normalised to status `0` instead of
 * throwing out of a form handler (issue #808 §5). The error-report layer
 * already knows that shape ("HTTP (no response)", see error-report.ts), the
 * busy state below is always released with `finally`, and callers keep testing
 * `ok` exactly as before. Without this, a transport failure escaped the
 * handler and left the form stuck on "busy" forever with nothing written to the
 * exportable log.
 */
export async function api<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const method = init?.method ?? "GET";
  // The bounded timeout is added only when the caller brought no signal of its
  // own, so an explicit cancellation (none does today, but the contract stays
  // honest) is never overridden by ours.
  const controller = init?.signal ? null : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(), SETUP_REQUEST_TIMEOUT_MS)
    : null;
  let res: Response;
  try {
    res = await fetch(url, {
      headers:
        init?.body instanceof FormData
          ? undefined
          : { "Content-Type": "application/json" },
      ...init,
      signal: init?.signal ?? controller?.signal,
    });
  } catch {
    recordApiFailure({ method, url, status: 0, code: "network_error" });
    return { ok: false, status: 0, data: { error: "network_error" } as unknown as T };
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  // Section 12 follow-up (see error-report.ts): a wizard step that fails
  // with a 5xx is worth the same exportable log entry a render error gets —
  // logged only, the on-screen message this returns is unchanged.
  if (!res.ok && isNotableApiFailure(res.status)) {
    recordApiFailure({
      method,
      url,
      status: res.status,
      code: typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : undefined,
    });
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Persian messages for the API's error codes. `status` is optional for callers
 * that have it; status `0` is the transport-failure shape `api()` produces and
 * takes precedence over any code, because "the request never arrived" is never
 * a validation problem the owner can fix in the form.
 */
export function errorMessage(
  code: string | undefined,
  messages?: string[],
  status?: number,
): string {
  if (status === 0 || code === "network_error") {
    return "ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید.";
  }
  if (messages?.length) return messages.join(" ");
  const map: Record<string, string> = {
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی فقط برای مالک و مدیر است.",
    bad_request: "درخواست نامعتبر بود.",
    missing_fields: "فیلدهای الزامی را پر کنید.",
    invalid_email: "ایمیل معتبر نیست.",
    weak_password: "گذرواژه باید حداقل ۸ کاراکتر باشد.",
    email_taken: "این ایمیل قبلاً ثبت شده است.",
    invalid_pin: "پین باید ۴ تا ۱۲ رقم باشد.",
    pin_taken: "این پین در این شعبه استفاده شده است. پین دیگری انتخاب کنید.",
    already_initialized: "این سیستم قبلاً راه‌اندازی شده است.",
    costing_locked: "روش قیمت‌گذاری قفل شده و از این‌جا قابل تغییر نیست.",
    costing_not_set: "اول روش قیمت‌گذاری را در مرحلهٔ «قیمت‌گذاری» انتخاب کنید.",
    step_not_in_industry: "این مرحله برای نوع کسب‌وکار شما وجود ندارد.",
    accounts_in_use: "حساب‌ها دارای سند هستند و قابل جایگزینی نیستند.",
    invalid_rate: "نرخ مالیات باید بین ۰ و ۱۰۰ باشد.",
    category_exists: "دسته‌ای با این نام وجود دارد.",
    category_not_found: "دسته پیدا نشد.",
    unsupported_format: "فرمت فایل پشتیبانی نمی‌شود (CSV یا Excel .xlsx).",
    parse_failed: "خواندن فایل ممکن نشد.",
    file_too_large: "حجم فایل بیش از حد مجاز است.",
    nothing_to_import: "هیچ سطر معتبری در فایل نبود.",
    printer_not_found: "چاپگر پیدا نشد.",
    no_items: "حداقل یک قلم لازم است.",
    network_error: "ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید.",
    invalid_item: "مقدار یا بهای یکی از اقلام معتبر نیست.",
    not_balanced: "سند تراز نیست: جمع بدهکار و بستانکار برابر نیستند.",
    unknown_account: "حساب ناشناخته در سطرها وجود دارد.",
    offset_account_missing: "حساب «تراز افتتاحیه» (کد ۳۹۰۰) در سرفصل‌ها نیست.",
    incomplete: "هنوز مراحل الزامی کامل نشده‌اند.",
    no_location: "شعبه‌ای ثبت نشده است.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <Alert
      variant="destructive"
      className="mb-4 border-destructive/30 bg-destructive/5"
    >
      <CircleAlertIcon />
      <AlertDescription className="text-destructive">
        {children}
      </AlertDescription>
    </Alert>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="mb-4 border-primary/30 bg-primary/5">
      <InfoIcon className="text-primary" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/** shadcn <Input>-equivalent classes for raw <input>/<select>/<textarea> elements. */
export const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

export function PrimaryButton({
  children,
  disabled,
  onClick,
  type = "submit",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "submit" | "button";
}) {
  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="px-5 font-semibold"
    >
      {children}
    </Button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      className="px-4"
    >
      {children}
    </Button>
  );
}

/** Data-shaped fallback for client-loaded wizard steps. */
export function SetupDataSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="در حال بارگذاری اطلاعات مرحله"
    >
      <div aria-hidden="true" className="space-y-6">
        <header className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-[28rem] max-w-full" />
        </header>
        <div className="space-y-4">
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t border-border/80 pt-4">
          <Skeleton className="h-10 w-24 rounded-lg" />
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/**
 * Common frame for a wizard step: title, description, content, and the
 * back / skip navigation row. "Next" is each form's own submit button.
 */
export function StepShell({
  step,
  description,
  children,
  showSkip,
  showNext,
}: {
  step: WizardStep;
  description: React.ReactNode;
  children: React.ReactNode;
  showSkip?: boolean;
  /** steps whose forms don't auto-advance (menu, users, …) get a plain next button */
  showNext?: boolean;
}) {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = stepsFor(industry);
  const meta = STEPS[stepIndex(step)];
  const back = prevPath(step, steps);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState("");

  /**
   * Skipping the step is itself a persisted decision: it writes the step's
   * marker before moving on. Issue #808 §6 — that write used to be fired and
   * forgotten, so a dropped connection moved the owner forward while the
   * stored state stayed behind (and `/setup` later sent them straight back).
   * Now a failure keeps them here with a retry, and the busy flag is released
   * in `finally` whatever the transport does.
   */
  async function skip() {
    setSkipping(true);
    setSkipError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>(
        "/api/setup/progress",
        { method: "POST", body: JSON.stringify({ step }) },
      );
      if (!ok) {
        setSkipError(errorMessage(data?.error, undefined, status));
        return;
      }
      router.push(nextPath(step, steps));
    } finally {
      setSkipping(false);
    }
  }

  const currentIndex = steps.findIndex((item) => item.id === step);
  const progress = Math.round(((currentIndex + 1) / steps.length) * 100);

  return (
    <div>
      <header className="mb-7 border-b border-border pb-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            مرحلهٔ {toPersianDigits(currentIndex + 1)} از{" "}
            {toPersianDigits(steps.length)}
          </p>
          <span className="text-xs text-muted-foreground">
            {toPersianDigits(progress)}٪ پیشرفت
          </span>
        </div>
        <div
          className="mb-5 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-amber-500 dark:bg-amber-400 transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {meta.title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </header>

      {children}

      {skipError ? <ErrorBox>{skipError}</ErrorBox> : null}

      <div className="mt-8 flex items-center justify-between border-t pt-4">
        <div>
          {back ? (
            <SecondaryButton onClick={() => router.push(back)}>
              مرحلهٔ قبل
            </SecondaryButton>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          {showSkip ? (
            <button
              type="button"
              onClick={skip}
              disabled={skipping}
              className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              فعلاً رد شدن از این مرحله
            </button>
          ) : null}
          {showNext ? (
            <PrimaryButton
              type="button"
              onClick={() => router.push(nextPath(step, steps))}
            >
              مرحلهٔ بعد
            </PrimaryButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
