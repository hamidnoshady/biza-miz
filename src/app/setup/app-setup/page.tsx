"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppKey } from "@/lib/apps";
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  WIZARD_ERROR_MESSAGES,
  validateWizardStep,
  wizardProgress,
  wizardStepsFor,
} from "@/lib/service-activation/wizard";
import type { SetupAppCatalogData } from "@/lib/setup-apps";
import {
  api,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  SetupDataSkeleton,
} from "../ui";

interface WizardResponse {
  wizard: {
    step: string;
    progress: Record<string, unknown>;
    version: number;
    completedAt: string | null;
  } | null;
  error?: string;
}

/**
 * Step 3 (issue #1239 / ESH-90): only the selected apps' own setup, one app at
 * a time.
 *
 * The questions come from the existing service-activation wizard
 * (`business_service_wizard_state`) and are saved through its canonical route.
 * This page never activates an app: completing it makes the app "setup ready,
 * pending payment", not active.
 */
export default function AppSetupStep() {
  const router = useRouter();
  const [data, setData] = useState<SetupAppCatalogData | null>(null);
  const [activeKey, setActiveKey] = useState<AppKey | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [wizardLoaded, setWizardLoaded] = useState(false);
  const [error, setError] = useState("");
  const [fieldFault, setFieldFault] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const finishing = useRef(false);

  const selected = useMemo(
    () => (data?.cards ?? []).filter((card) => card.selected),
    [data],
  );
  const activeIndex = selected.findIndex((card) => card.key === activeKey);
  const activeCard = activeIndex >= 0 ? selected[activeIndex] : null;
  const steps = useMemo(() => (activeKey ? wizardStepsFor("app", activeKey) : []), [activeKey]);
  const progress = useMemo(() => wizardProgress(steps, answers), [steps, answers]);

  useEffect(() => {
    void api<SetupAppCatalogData>("/api/setup/apps")
      .then(({ ok, data: loaded }) => {
        if (!ok) {
          setError("بارگذاری برنامه‌های انتخاب‌شده ممکن نشد.");
          return;
        }
        setData(loaded);
        setActiveKey(loaded.selected[0] ?? null);
      })
      .catch(() => setError("بارگذاری برنامه‌های انتخاب‌شده ممکن نشد."));
  }, []);

  useEffect(() => {
    if (!activeKey) return;
    let cancelled = false;
    setWizardLoaded(false);
    setAnswers({});
    setFieldFault(null);
    void api<WizardResponse>(`/api/services/app/${activeKey}/wizard`)
      .then(({ ok, data: loaded }) => {
        if (cancelled) return;
        if (!ok) {
          setError("بارگذاری پاسخ‌های این برنامه ممکن نشد؛ می‌توانید پاسخ‌ها را دوباره وارد کنید.");
          setWizardLoaded(true);
          return;
        }
        setAnswers((loaded.wizard?.progress ?? {}) as Record<string, string>);
        setWizardLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setError("بارگذاری پاسخ‌های این برنامه ممکن نشد؛ می‌توانید پاسخ‌ها را دوباره وارد کنید.");
        setWizardLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeKey]);

  // Zero selected apps is a legitimate choice: record the step and move on.
  useEffect(() => {
    if (!data || data.selected.length > 0 || finishing.current) return;
    void finishAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function finishAll() {
    if (finishing.current) return;
    finishing.current = true;
    setBusy(true);
    setError("");
    try {
      const { ok, data: result, status } = await api<{ error?: string }>(
        "/api/setup/progress",
        { method: "POST", body: JSON.stringify({ step: "app_setup" }) },
      );
      if (!ok) {
        setError(
          result.error === "invalid_step"
            ? "ثبت مرحلهٔ راه‌اندازی برنامه‌ها ممکن نشد. صفحه را دوباره باز کنید."
            : "ادامه به پایان راه‌اندازی ممکن نشد.",
        );
        if (status === 0) return;
        return;
      }
      router.push("/setup/finish");
    } finally {
      setBusy(false);
      finishing.current = false;
    }
  }

  function setAnswer(key: string, value: string) {
    setAnswers((current) => ({ ...current, [key]: value }));
    if (fieldFault?.field === key) setFieldFault(null);
  }

  async function saveStep() {
    if (!activeKey || !progress.nextStep) return;
    const fault = validateWizardStep(progress.nextStep, answers);
    if (fault) {
      setFieldFault({
        field: fault.field,
        message: WIZARD_ERROR_MESSAGES[fault.code] ?? "مقدار واردشده معتبر نیست.",
      });
      return;
    }
    setBusy(true);
    setError("");
    setFieldFault(null);
    try {
      // The last unanswered step is this one; ask the server to stamp the
      // service wizard complete in the same write.
      const completing = progress.completedSteps.length === steps.length - 1;
      const { ok, data: saved, status } = await api<
        WizardResponse & { error?: string; reason?: string }
      >(
        `/api/services/app/${activeKey}/wizard`,
        {
          method: "PUT",
          body: JSON.stringify({
            step: progress.nextStep.key,
            progress: answers,
            completed: completing,
          }),
        },
      );
      if (!ok) {
        if (saved.error === "wizard_incomplete" && saved.reason) {
          setError(WIZARD_ERROR_MESSAGES[saved.reason] ?? "پاسخ‌های الزامی کامل نیستند.");
        } else {
          setError(
            saved.error === "invalid_wizard_step"
              ? "مرحلهٔ راه‌اندازی معتبر نیست؛ صفحه را دوباره باز کنید."
              : status === 0
                ? "ارتباط با سرور برقرار نشد."
                : "ذخیرهٔ پاسخ‌های این برنامه ممکن نشد.",
          );
        }
        return;
      }
      setAnswers((saved.wizard?.progress ?? {}) as Record<string, string>);
    } finally {
      setBusy(false);
    }
  }

  function nextApp() {
    if (activeIndex >= 0 && activeIndex < selected.length - 1) {
      setActiveKey(selected[activeIndex + 1].key);
    } else {
      void finishAll();
    }
  }

  if (!data) {
    return (
      <div>
        <ErrorBox>{error}</ErrorBox>
        <SetupDataSkeleton rows={6} />
      </div>
    );
  }

  if (selected.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          راه‌اندازی برنامه‌های انتخاب‌شده
        </h1>
        <ErrorBox>{error}</ErrorBox>
        <InfoBox>
          هیچ برنامه‌ای انتخاب نشده است؛ بنابراین راه‌اندازی برنامه‌ای هم لازم
          نیست. می‌توانید به پایان راه‌اندازی بروید و بعداً از داشبورد برنامه
          اضافه کنید.
        </InfoBox>
        <PrimaryButton type="button" onClick={() => void finishAll()} disabled={busy}>
          ادامه به پایان راه‌اندازی
        </PrimaryButton>
      </div>
    );
  }

  if (!wizardLoaded || !activeCard) return <SetupDataSkeleton rows={4} />;

  const complete = progress.complete;
  const currentStep = progress.nextStep;
  const stepNumber = Math.max(1, progress.completedSteps.length + 1);
  const appPosition = activeIndex + 1;
  const lastApp = activeIndex === selected.length - 1;

  return (
    <div>
      <header className="mb-7 border-b border-border pb-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            برنامهٔ {activeCard.label} — برنامهٔ {appPosition} از {selected.length}
          </p>
          <span className="text-xs text-muted-foreground">
            {stepNumber} از {steps.length} پرسش
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {complete ? `${activeCard.label} آمادهٔ راه‌اندازی است` : currentStep?.title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {complete
            ? "پاسخ‌های الزامی این برنامه ذخیره شد. این برنامه هنوز فعال یا پرداخت‌شده نیست؛ فعال‌سازی بعد از پایان راه‌اندازی و با تأیید کیف پول انجام می‌شود."
            : currentStep?.description}
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>

      {!complete ? (
        <>
          <InfoBox>
            این پاسخ‌ها در پیش‌نویس راه‌اندازی همین برنامه ذخیره می‌شوند؛ ورود
            داده از فایل یا اتصال سرویس‌های اضافی در این مرحله الزامی نیست.
          </InfoBox>
          <div className="max-w-xl">
            {currentStep?.fields.map((field) => (
              <Field
                key={field.key}
                label={`${field.label}${field.required ? " *" : ""}`}
                hint={field.hint}
              >
                {field.kind === "select" ? (
                  <select
                    className={inputClass}
                    value={answers[field.key] ?? ""}
                    onChange={(e) => setAnswer(field.key, e.target.value)}
                  >
                    <option value="">انتخاب کنید…</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={inputClass}
                    value={answers[field.key] ?? ""}
                    onChange={(e) => setAnswer(field.key, e.target.value)}
                    maxLength={field.maxLength}
                    inputMode={field.kind === "number" ? "numeric" : undefined}
                  />
                )}
                {fieldFault?.field === field.key ? (
                  <span className="mt-1 block text-xs text-destructive">{fieldFault.message}</span>
                ) : null}
              </Field>
            ))}
          </div>
          <PrimaryButton type="button" onClick={() => void saveStep()} disabled={busy}>
            ذخیره و ادامه
          </PrimaryButton>
        </>
      ) : (
        <section className={`${cardClass} p-5`}>
          <p className="text-sm leading-6 text-muted-foreground">
            همهٔ پرسش‌های الزامی این برنامه کامل است. تنظیمات تفصیلی و اتصال
            سرویس‌های جانبی بعد از فعال‌سازی از بخش تنظیمات همان برنامه در دسترس
            است.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <PrimaryButton type="button" onClick={nextApp} disabled={busy}>
              {lastApp ? "ادامه به پایان راه‌اندازی" : "برنامهٔ بعد"}
            </PrimaryButton>
            <SecondaryButton onClick={() => router.push("/setup/apps")}>
              تغییر انتخاب برنامه‌ها
            </SecondaryButton>
          </div>
        </section>
      )}

      <div className="mt-8 flex items-center justify-between border-t border-border pt-4">
        <SecondaryButton onClick={() => router.push("/setup/apps")}>
          مرحلهٔ انتخاب برنامه‌ها
        </SecondaryButton>
        {!complete ? (
          <span className="text-xs text-muted-foreground">
            {activeIndex + 1} از {selected.length} برنامه
          </span>
        ) : null}
      </div>
    </div>
  );
}
