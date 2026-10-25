"use client";

/**
 * «سرویس‌ها» — the customer's own service-activation screen (issue #1041 §E.2).
 *
 * What this screen is allowed to be: a list of the services this business may
 * run (the four apps, the separately-priced My Workspace capabilities and any
 * published background agent), each with its live state, whether setup was
 * already paid, and — when it is off — the exact destruction deadline a
 * Superadmin retention policy set.
 *
 * Two irreversible actions live here, and both show their consequence first:
 *
 *  - **Enable** first asks the service's own short setup questions (§B) — the
 *    answers live in `business_service_wizard_state`, never in the business's
 *    first-run onboarding — and then opens the binding quote before the debit:
 *    the one-time setup fee, the hourly tariff, the first-hour reserve the
 *    wallet must cover, the 24h/30d estimates, and the charges this tariff does
 *    *not* include (AI tokens, SMS, media storage). A repeat enable after a
 *    disable charges no second setup fee, and the dialog says so.
 *  - **Disable** never deletes anything itself. It ends the runtime clock and
 *    starts the retention countdown, so the confirmation states the deadline
 *    and links to the export screen rather than asking "are you sure?".
 *
 * Money is displayed in Toman from the Rial the API returns; every date goes
 * through `formatJalali`. The APIs re-check permission, tariff, availability
 * and wallet cover inside one locked transaction — this component only decides
 * what is worth showing.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PowerIcon, PowerOffIcon, ReceiptTextIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { toPersianDigits } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  WIZARD_ERROR_MESSAGES,
  nextWizardStepKey,
  normalizeWizardProgress,
  validateWizardStep,
  wizardProgress,
  wizardStepsFor,
} from "@/lib/service-activation/wizard";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessageOrRaw, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ServiceIdentity {
  kind: string;
  key: string;
  runtimeInstanceId?: string | null;
}

interface TenantService {
  identity: ServiceIdentity;
  definition: { kind: string; key: string; label: string; description: string } | null;
  state: string;
  stateLabel: string;
  enabled: boolean;
  setupPaid: boolean;
  retentionDeadline: string | null;
  purgeState: string;
  wizardStep: string | null;
  lastSettledAt: string | null;
  activation: {
    setupAmountRial: number | null;
    activatedAt: string | null;
    disabledAt: string | null;
    disabledReason: string | null;
    suspensionReason: string | null;
  } | null;
}

interface Quote {
  eligible: boolean;
  reason: string;
  setupRial: number;
  hourlyRial: number;
  firstHourRial: number;
  reserveRial: number;
  estimated24hRial: number;
  estimated30dRial: number;
  walletBalanceRial: number;
  balanceAfterSetupRial: number;
  additionalCharges: readonly string[];
  tariff: { setupMode: string; setupEquivalentHours: number } | null;
}

interface PurgeDetail {
  quote: Quote | null;
  wizard: {
    step: string;
    progress: Record<string, unknown>;
    version: number;
    completedAt: string | null;
  } | null;
  activation: TenantService["activation"];
  retentionPolicy: {
    autoPurgeEnabled: boolean;
    retentionDays: number | null;
    notificationLeadDays: number;
    exportGraceDays: number;
    source: string;
  } | null;
}

const ENABLED_STATES = new Set(["active", "suspended_insufficient_credit", "platform_unavailable"]);

const DEADLINE_HINT: Record<string, string> = {
  scheduled: "داده‌ها تا این تاریخ نگهداری می‌شوند؛ پیش از آن می‌توانید سرویس را دوباره فعال کنید.",
  blocked: "حذف خودکار متوقف است (نگهداری قانونی/عملیاتی) و داده‌ها پاک نمی‌شوند.",
  partial: "بخشی از داده‌های متعلق به سرویس پاک شده است.",
  completed: "داده‌های متعلق به سرویس پاک شده‌اند.",
};

function identityParam(identity: ServiceIdentity): string {
  return `${identity.kind}/${encodeURIComponent(identity.key)}`;
}

function identityLabel(service: TenantService): string {
  return service.definition?.label ?? service.identity.key;
}

export function ServicesSettings({ canManage }: { canManage: boolean }) {
  const [services, setServices] = useState<TenantService[] | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ mode: "enable" | "disable"; service: TenantService } | null>(
    null,
  );
  const [detail, setDetail] = useState<PurgeDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  /** The service's setup answers, seeded from the saved draft on reopen. */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerError, setAnswerError] = useState<{ field: string; code: string } | null>(null);
  const [savedDraft, setSavedDraft] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ services?: TenantService[]; error?: string }>("/api/services");
    if (res.ok) {
      setServices(res.data.services ?? []);
      setError("");
    } else {
      setError(errorMessageOrRaw(res.data.error ?? "خطا در بارگذاری سرویس‌ها"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDialog = useCallback(
    async (mode: "enable" | "disable", service: TenantService) => {
      setDialog({ mode, service });
      setDetail(null);
      setDetailError("");
      setAnswers({});
      setAnswerError(null);
      setSavedDraft(false);
      setLoadingDetail(true);
      const query = service.identity.runtimeInstanceId
        ? `?runtimeInstanceId=${encodeURIComponent(service.identity.runtimeInstanceId)}`
        : "";
      const res = await api<PurgeDetail & { error?: string }>(
        `/api/services/${identityParam(service.identity)}${query}`,
      );
      setLoadingDetail(false);
      if (res.ok) {
        setDetail(res.data);
        // Resume where the member left off: the API stores each step and bumps
        // a version, so a half-filled wizard comes back on any device.
        const saved = res.data.wizard?.progress ?? {};
        const seeded: Record<string, string> = {};
        for (const [field, value] of Object.entries(saved)) {
          seeded[field] = value == null ? "" : String(value);
        }
        setAnswers(seeded);
      } else {
        setDetailError(errorMessageOrRaw(res.data.error ?? "دریافت اطلاعات سرویس ممکن نشد."));
      }
    },
    [],
  );

  /**
   * The dialog's one action. For an enable it first persists the service's
   * setup answers (§B), because a member must not be charged for a service whose
   * preflight is still unanswered — and a half-filled wizard stays resumable
   * instead of being thrown away when they stop here.
   */
  async function submit() {
    if (!dialog) return;
    const service = dialog.service;
    const key = `${identityParam(service.identity)}:${dialog.mode}`;
    setError("");
    setInfo("");

    if (dialog.mode === "enable") {
      const steps = wizardStepsFor(
        service.identity.kind as Parameters<typeof wizardStepsFor>[0],
        service.identity.key,
      );
      const normalized = normalizeWizardProgress(steps, answers);
      const state = wizardProgress(steps, normalized);
      setPending(`${key}:wizard`);
      const saved = await api<{ error?: string }>(
        `/api/services/${identityParam(service.identity)}/wizard${
          service.identity.runtimeInstanceId
            ? `?runtimeInstanceId=${encodeURIComponent(service.identity.runtimeInstanceId)}`
            : ""
        }`,
        {
          method: "PUT",
          body: JSON.stringify({
            step: nextWizardStepKey(steps, normalized),
            progress: normalized,
            completed: state.complete,
          }),
        },
      );
      setPending(null);
      if (!saved.ok) {
        setError(errorMessageOrRaw(saved.data.error ?? "ذخیرهٔ پیش‌نیازهای راه‌اندازی ممکن نشد."));
        return;
      }
      if (!state.complete && state.nextStep) {
        // Not a charge, and not an error: the first unanswered field is where
        // the member stopped. Saying which one beats a generic refusal.
        const fault = validateWizardStep(state.nextStep, normalized);
        setAnswerError(fault);
        setSavedDraft(true);
        setError(`پیش‌نیازهای راه‌اندازی کامل نشده است؛ «${state.nextStep.title}» را تکمیل کنید.`);
        return;
      }
      setAnswerError(null);
    }

    setPending(key);
    const action = dialog.mode === "enable" ? (service.activation ? "reenable" : "activate") : "disable";
    const res = await api<{
      status?: string;
      retentionDeadline?: string | null;
      chargedSetupRial?: number;
      requiredRial?: number;
      balanceRial?: number;
      reason?: string;
      error?: string;
    }>(`/api/services/${identityParam(service.identity)}`, {
      method: "POST",
      body: JSON.stringify({
        action,
        requestId:
          typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : undefined,
        runtimeInstanceId: service.identity.runtimeInstanceId ?? "",
      }),
    });
    setPending(null);
    if (!res.ok) {
      if (res.data.status === "insufficient_credit") {
        setError(
          `اعتبار کیف پول برای فعال‌سازی کافی نیست: ${formatToman(res.data.requiredRial ?? 0)} لازم است و موجودی ${formatToman(res.data.balanceRial ?? 0)} است.`,
        );
      } else if (res.data.status === "not_configured") {
        setError("برای این سرویس تعرفهٔ منتشرشده‌ای وجود ندارد؛ فعال‌سازی ممکن نیست.");
      } else if (res.data.status === "unavailable") {
        setError("این سرویس در حال حاضر روی پلتفرم در دسترس نیست.");
      } else if (res.data.error === "wizard_incomplete") {
        setError("پیش‌نیازهای راه‌اندازی ذخیره نشده است؛ پاسخ‌ها را کامل کنید و دوباره تلاش کنید.");
      } else if (res.data.status === "conflict") {
        setError(
          res.data.reason === "legal_hold"
            ? "این سرویس تحت نگهداری قانونی است؛ با پشتیبانی تماس بگیرید."
            : "عملیات دیگری روی این سرویس در جریان است؛ دوباره تلاش کنید.",
        );
      } else {
        setError(errorMessageOrRaw(res.data.error ?? "انجام عملیات ممکن نشد."));
      }
      return;
    }

    const status = res.data.status;
    if (action === "disable") {
      setInfo(
        res.data.retentionDeadline
          ? `سرویس غیرفعال شد. مهلت نگهداری داده: ${formatJalali(res.data.retentionDeadline, { withTime: true })}. تا آن تاریخ هر زمان می‌توانید دوباره فعال کنید.`
          : "سرویس غیرفعال شد. برای داده‌های این سرویس مهلت حذف خودکار تعیین نشده است.",
      );
    } else if (status === "reenabled" || status === "already_active") {
      setInfo(
        status === "already_active"
          ? "این سرویس از قبل فعال است."
          : "سرویس دوباره فعال شد؛ هزینهٔ راه‌اندازی دوباره دریافت نشد.",
      );
    } else {
      setInfo("سرویس فعال شد و شمارش هزینهٔ ساعتی آغاز شد.");
    }
    setDialog(null);
    await load();
  }

  const title = "سرویس‌ها و فعال‌سازی";
  if (!services) {
    return (
      <SectionCard title={title} description="فهرست سرویس‌ها، وضعیت فعال بودن و هزینهٔ نگهداری داده">
        {error ? <ErrorBox>{error}</ErrorBox> : <LoadingSkeleton rows={4} />}
      </SectionCard>
    );
  }

  return (
    <div className="space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <SectionCard
        title={title}
        description="برنامه‌ها و سرویس‌های فضای کاری که این کسب‌وکار می‌تواند فعال کند. هزینهٔ راه‌اندازی یک‌بار و هزینهٔ فعال بودن به‌صورت ساعتی از کیف پول کسر می‌شود."
      >
        {services.length === 0 ? (
          <EmptyState title="سرویسی برای این کسب‌وکار تعریف نشده است" />
        ) : (
          <ul className="divide-y divide-border">
            {services.map((service) => {
              const identity = `${service.identity.kind}:${service.identity.key}`;
              const isEnabled = ENABLED_STATES.has(service.state) || service.enabled;
              const suspended = service.state === "suspended_insufficient_credit";
              const busy = pending?.startsWith(identityParam(service.identity)) ?? false;
              return (
                <li key={identity} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-foreground">{identityLabel(service)}</p>
                      <StatusBadge
                        tone={
                          suspended
                            ? "danger"
                            : isEnabled
                              ? "positive"
                              : "neutral"
                        }
                      >
                        {service.stateLabel}
                      </StatusBadge>
                      {service.setupPaid && (
                        <span className="text-xs text-muted-foreground">هزینهٔ راه‌اندازی پرداخت شده</span>
                      )}
                    </div>
                    {service.definition?.description && (
                      <p className="max-w-2xl text-sm text-muted-foreground">{service.definition.description}</p>
                    )}
                    {service.retentionDeadline && !isEnabled && (
                      <p className="text-xs text-muted-foreground">
                        مهلت حذف داده: {formatJalali(service.retentionDeadline, { withTime: true })}
                        {DEADLINE_HINT[service.purgeState] ? ` — ${DEADLINE_HINT[service.purgeState]}` : ""}
                      </p>
                    )}
                    {service.lastSettledAt && (
                      <p className="text-xs text-muted-foreground">
                        آخرین تسویهٔ هزینهٔ ساعتی: {formatJalali(service.lastSettledAt, { withTime: true })}
                      </p>
                    )}
                    {suspended && service.activation?.suspensionReason === "insufficient_credit" && (
                      <p className="text-xs text-warning">
                        سرویس به‌دلیل کمبود اعتبار کیف پول متوقف شده است. با شارژ کیف پول دوباره فعال می‌شود؛
                        این توقف مهلت حذف داده ایجاد نمی‌کند.
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Link
                      href="/settings/billing"
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                      <ReceiptTextIcon className="size-3.5" aria-hidden="true" />
                      صورت‌حساب
                    </Link>
                    {isEnabled ? (
                      <Button
                        variant="outline"
                        disabled={!canManage || busy}
                        onClick={() => void openDialog("disable", service)}
                      >
                        <PowerOffIcon className="size-4" aria-hidden="true" />
                        غیرفعال‌سازی
                      </Button>
                    ) : (
                      <Button
                        disabled={!canManage || busy}
                        onClick={() => void openDialog("enable", service)}
                      >
                        <PowerIcon className="size-4" aria-hidden="true" />
                        {service.activation ? "فعال‌سازی دوباره" : "فعال‌سازی"}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!canManage && (
          <p className="mt-3 text-xs text-muted-foreground">
            فعال و غیرفعال کردن سرویس‌ها به دسترسی «مدیریت صورت‌حساب» نیاز دارد.
          </p>
        )}
      </SectionCard>

      <SectionCard title="هزینه‌های خارج از این تعرفه" description="این اقلام جداگانه و طبق مصرف از کیف پول کسر می‌شوند">
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          <li>مصرف هوش مصنوعی (توکن) در هر سرویس، از جمله گفت‌وگوی هوش مصنوعی در خانهٔ فضای کاری.</li>
          <li>پیامک، فضای رسانه و ترافیک سایت.</li>
          <li>اشتراک پلتفرم، افزودنی‌ها و فاکتورهای قبلی؛ این تعرفه آن‌ها را تغییر نمی‌دهد.</li>
        </ul>
      </SectionCard>

      <Dialog open={dialog !== null} onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
        <DialogContent className="max-w-xl">
          {dialog && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.mode === "enable" ? "فعال‌سازی" : "غیرفعال‌سازی"} {identityLabel(dialog.service)}
                </DialogTitle>
                <DialogDescription>
                  {dialog.mode === "enable"
                    ? "با تأیید، هزینهٔ راه‌اندازی از کیف پول کسر و هزینهٔ ساعتی از همین لحظه آغاز می‌شود."
                    : "با غیرفعال‌سازی، هزینهٔ ساعتی متوقف می‌شود و شمارش مهلت نگهداری داده آغاز می‌شود."}
                </DialogDescription>
              </DialogHeader>

              {loadingDetail ? (
                <LoadingSkeleton rows={3} />
              ) : detailError ? (
                <ErrorBox>{detailError}</ErrorBox>
              ) : dialog.mode === "enable" ? (
                <div className="space-y-4">
                  <WizardFields
                    kind={dialog.service.identity.kind}
                    serviceKey={dialog.service.identity.key}
                    answers={answers}
                    error={answerError}
                    disabled={!canManage}
                    onChange={(field, value) => {
                      setAnswers((prev) => ({ ...prev, [field]: value }));
                      setAnswerError(null);
                      setSavedDraft(false);
                    }}
                  />
                  {savedDraft && (
                    <p className="text-xs text-muted-foreground">
                      پاسخ‌های شما ذخیره شد؛ بعداً از همین صفحه ادامه دهید.
                    </p>
                  )}
                  <EnableBody detail={detail} service={dialog.service} />
                </div>
              ) : (
                <DisableBody detail={detail} service={dialog.service} />
              )}

              <DialogFooter>
                <Button variant="ghost" onClick={() => setDialog(null)}>
                  انصراف
                </Button>
                <Button
                  disabled={loadingDetail || Boolean(detailError) || pending !== null}
                  onClick={() => void submit()}
                >
                  {dialog.mode === "enable" ? "تأیید و فعال‌سازی" : "تأیید غیرفعال‌سازی"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The service's own preflight questions (§B), rendered from the shared
 * definitions so the dialog and the API validate the same fields.
 *
 * Deliberately not a multi-screen wizard: the answers are two short steps, and
 * showing them together means the quote underneath is read in the light of what
 * the service will actually do. Resumability lives on the server — reopening the
 * dialog seeds these inputs from the saved draft — not in a client step index
 * that a refresh would lose.
 */
function WizardFields({
  kind,
  serviceKey,
  answers,
  error,
  disabled,
  onChange,
}: {
  kind: string;
  serviceKey: string;
  answers: Record<string, string>;
  error: { field: string; code: string } | null;
  disabled: boolean;
  onChange: (field: string, value: string) => void;
}) {
  const steps = wizardStepsFor(kind as Parameters<typeof wizardStepsFor>[0], serviceKey);
  if (steps.length === 0) return null;
  return (
    <section aria-labelledby="service-wizard-heading" className="space-y-3">
      <div>
        <h3 id="service-wizard-heading" className="text-sm font-semibold text-foreground">
          پیش‌نیازهای راه‌اندازی
        </h3>
        <p className="text-xs text-muted-foreground">
          این پاسخ‌ها فقط برای همین سرویس ذخیره می‌شوند و با راه‌اندازی اولیهٔ کسب‌وکار ارتباطی ندارند.
        </p>
      </div>
      {steps.map((step, index) => (
        <fieldset key={step.key} className="space-y-2 rounded-lg border border-border px-3 py-2.5">
          <legend className="px-1 text-xs font-medium text-foreground">
            {toPersianDigits(index + 1)}. {step.title}
          </legend>
          <p className="text-xs text-muted-foreground">{step.description}</p>
          {step.fields.map((field) => {
            const invalid = error?.field === field.key;
            return (
              <div key={field.key} className="space-y-1">
                <label
                  htmlFor={`wizard-${step.key}-${field.key}`}
                  className="block text-xs font-medium text-foreground"
                >
                  {field.label}
                </label>
                {field.kind === "select" ? (
                  <select
                    id={`wizard-${step.key}-${field.key}`}
                    className={inputClass}
                    value={answers[field.key] ?? ""}
                    disabled={disabled}
                    aria-invalid={invalid || undefined}
                    onChange={(ev) => onChange(field.key, ev.target.value)}
                  >
                    <option value="">— انتخاب کنید —</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.kind === "number" ? (
                  <PersianNumberInput
                    id={`wizard-${step.key}-${field.key}`}
                    className={inputClass}
                    inputMode="numeric"
                    value={answers[field.key] ?? ""}
                    disabled={disabled}
                    aria-invalid={invalid || undefined}
                    maxLength={field.maxLength}
                    onChange={(ev) => onChange(field.key, ev.target.value)}
                  />
                ) : (
                  <input
                    id={`wizard-${step.key}-${field.key}`}
                    className={inputClass}
                    value={answers[field.key] ?? ""}
                    disabled={disabled}
                    aria-invalid={invalid || undefined}
                    maxLength={field.maxLength}
                    onChange={(ev) => onChange(field.key, ev.target.value)}
                  />
                )}
                {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                {invalid && error && (
                  <p className="text-xs text-destructive" role="alert">
                    {WIZARD_ERROR_MESSAGES[error.code] ?? "مقدار واردشده معتبر نیست."}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
    </section>
  );
}

function EnableBody({ detail, service }: { detail: PurgeDetail | null; service: TenantService }) {
  const quote = detail?.quote;
  if (!quote) return <p className="text-sm text-muted-foreground">دریافت پیش‌فاکتور ممکن نشد.</p>;
  if (!quote.eligible) {
    return (
      <div className="space-y-2 text-sm">
        {quote.reason === "not_configured" ? (
          <p className="text-destructive">
            برای این سرویس تعرفه‌ای منتشر نشده است و فعال‌سازی ممکن نیست. با پشتیبانی تماس بگیرید.
          </p>
        ) : (
          <p className="text-destructive">
            اعتبار کیف پول کافی نیست. برای شروع حداقل {formatToman(quote.reserveRial)} لازم است و موجودی
            فعلی {formatToman(quote.walletBalanceRial)} است.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          صورت‌حساب و شارژ کیف پول در{" "}
          <Link href="/settings/billing" className="underline">
            صفحهٔ صورت‌حساب
          </Link>{" "}
          است.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-2">
        <dt className="text-muted-foreground">هزینهٔ راه‌اندازی (یک‌بار)</dt>
        <dd className="text-foreground">
          {formatToman(quote.setupRial)}
          {quote.tariff?.setupMode === "hour_equivalent" && quote.tariff.setupEquivalentHours > 0 && (
            <span className="text-xs text-muted-foreground">
              {" "}
              (معادل {toPersianDigits(quote.tariff.setupEquivalentHours)} ساعت)
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">نرخ هر ساعت فعال بودن</dt>
        <dd className="text-foreground">{formatToman(quote.hourlyRial)}</dd>
        <dt className="text-muted-foreground">رزرو لازم برای شروع</dt>
        <dd className="text-foreground">
          {formatToman(quote.reserveRial)}{" "}
          <span className="text-xs text-muted-foreground">(راه‌اندازی + یک ساعت اول)</span>
        </dd>
        <dt className="text-muted-foreground">موجودی کیف پول</dt>
        <dd className="text-foreground">{formatToman(quote.walletBalanceRial)}</dd>
        <dt className="text-muted-foreground">موجودی پس از راه‌اندازی</dt>
        <dd className="text-foreground">{formatToman(quote.balanceAfterSetupRial)}</dd>
        <dt className="text-muted-foreground">برآورد ۲۴ ساعت</dt>
        <dd className="text-foreground">{formatToman(quote.estimated24hRial)}</dd>
        <dt className="text-muted-foreground">برآورد ۳۰ روز</dt>
        <dd className="text-foreground">{formatToman(quote.estimated30dRial)}</dd>
      </dl>
      {service.setupPaid && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          هزینهٔ راه‌اندازی این سرویس قبلاً پرداخت شده است؛ فعال‌سازی دوباره آن هزینهٔ راه‌اندازی جدیدی ندارد.
        </p>
      )}
      {quote.additionalCharges.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">جدا از این تعرفه:</p>
          <ul className="list-inside list-disc space-y-0.5">
            {quote.additionalCharges.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DisableBody({ detail, service }: { detail: PurgeDetail | null; service: TenantService }) {
  const policy = detail?.retentionPolicy;
  const deadline = service.retentionDeadline;
  return (
    <div className="space-y-3 text-sm">
      <ul className="list-inside list-disc space-y-1 text-muted-foreground">
        <li>هزینهٔ ساعتی از همان لحظهٔ غیرفعال‌سازی متوقف می‌شود.</li>
        <li>هزینهٔ راه‌اندازی بازگردانده نمی‌شود و فعال‌سازی دوباره آن را دوباره دریافت نمی‌کند.</li>
        <li>دسترسی کاربران به این سرویس قطع می‌شود تا زمانی که دوباره فعال شود.</li>
      </ul>
      {policy?.autoPurgeEnabled && policy.retentionDays != null ? (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          داده‌های این سرویس طبق سیاست نگهداری پلتفرم <span className="font-medium text-foreground">تا {toPersianDigits(policy.retentionDays)} روز</span> نگه‌داشته
          و سپس نابود می‌شوند. اعلان {toPersianDigits(policy.notificationLeadDays)} روز پیش و فرصت خروجی‌گرفتن{" "}
          {toPersianDigits(policy.exportGraceDays)} روز است. تا پیش از پایان این مهلت، فعال‌سازی دوباره صف نابودی را لغو می‌کند.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          برای این سرویس حذف خودکار تعیین نشده است؛ داده‌ها پس از غیرفعال‌سازی نگهداری می‌شوند.
        </div>
      )}
      {deadline && (
        <p className="text-xs text-muted-foreground">
          مهلت فعلی: {formatJalali(deadline, { withTime: true })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        پیش از پایان مهلت می‌توانید از{" "}
        <Link href="/settings/data-transfer" className="underline">
          خروجی داده
        </Link>{" "}
        نسخهٔ پشتیبان بگیرید.
      </p>
    </div>
  );
}
