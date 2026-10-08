"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import {
  FISCAL_PERIOD_COUNT,
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
  isSupportedFiscalYear,
} from "@/lib/fiscal-periods";
import { formatJalali, todayJalali } from "@/lib/jalali";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { FilterChip } from "@/app/dashboard/filters";
import type { FiscalReadiness } from "@/lib/fiscal-readiness";
import { FiscalReadinessBanner } from "./fiscal-readiness-banner";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

interface FiscalYear {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
}

type PeriodStatus = "open" | "soft_closed" | "locked";

interface FiscalPeriod {
  id: string;
  fiscalYearId: string;
  label: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: PeriodStatus;
}

type PendingAction =
  | { kind: "period"; period: FiscalPeriod; targetStatus: PeriodStatus }
  | { kind: "close-year"; fiscalYear: FiscalYear };

type Mutation = "create-year" | "period" | "close-year" | null;

const STATUS_LABELS: Record<PeriodStatus, string> = {
  open: "باز",
  soft_closed: "بستهٔ موقت",
  locked: "قفل‌شده",
};

const STATUS_TONES: Record<PeriodStatus, "positive" | "active" | "danger"> = {
  open: "positive",
  soft_closed: "active",
  locked: "danger",
};

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    invalid_year: `سال شمسی باید عددی بین ${toPersianDigits(FISCAL_YEAR_MIN)} تا ${toPersianDigits(FISCAL_YEAR_MAX)} باشد.`,
    fiscal_year_exists: "این سال مالی قبلاً تعریف شده است.",
    fiscal_period_overlap: "بازهٔ این سال با یک دورهٔ مالی موجود هم‌پوشانی دارد؛ اطلاعات دوره‌ها را بررسی کنید.",
    fiscal_year_not_found: "سال مالی یافت نشد؛ فهرست را دوباره بارگذاری کنید.",
    period_not_found: "دوره یافت نشد؛ فهرست را دوباره بارگذاری کنید.",
    invalid_transition: "وضعیت این دوره هم‌زمان تغییر کرده است؛ فهرست را بررسی و دوباره تلاش کنید.",
    fiscal_year_closed: "سال مالی بسته شده است و دوره‌های آن دیگر قابل بازگشایی نیستند.",
    fiscal_year_already_closed: "این سال مالی قبلاً بسته شده است.",
    periods_not_ready: "برای بستن سال مالی، ابتدا همهٔ دوره‌ها را به‌صورت موقت ببندید.",
    uncovered_entries_before_close:
      "بستن نهایی این سال ممکن نیست: اسنادی با تاریخ پیش از پایان سال بیرون از همهٔ دوره‌های مالی ثبت شده‌اند. سال مالیِ آن تاریخ‌ها را تعریف کنید؛ اسناد رد یا جابه‌جا نمی‌شوند.",
    periods_incomplete: "فهرست دوره‌های این سال کامل نیست؛ برای بررسی با پشتیبانی تماس بگیرید.",
    period_locked_for_closing: "دورهٔ پایانی سال قفل است؛ ابتدا آن را بازگشایی و دوباره به‌صورت موقت ببندید.",
    ledger_account_missing: "حساب «سود (زیان) انباشته» در سرفصل حساب‌ها یافت نشد.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    request_failed: "ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره رخ داد. دوباره تلاش کنید.";
}

function formatRange(startsOn: string, endsOn: string): string {
  return `${toPersianDigits(formatJalali(startsOn))} تا ${toPersianDigits(formatJalali(endsOn))}`;
}

function actionCopy(action: PendingAction): {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
} {
  if (action.kind === "close-year") {
    return {
      title: `بستن نهایی سال مالی ${toPersianDigits(action.fiscalYear.label)}؟`,
      description:
        "پس از ثبت سند اختتامیه، هر دوازده دوره قفل می‌شوند و در این سال دیگر امکان ثبت یا بازگشایی دوره وجود ندارد.",
      confirmLabel: "بستن نهایی سال مالی",
      destructive: true,
    };
  }

  const periodName = toPersianDigits(action.period.name);
  if (action.targetStatus === "soft_closed") {
    return {
      title: `بستن موقت ${periodName}؟`,
      description:
        "پس از این تغییر، ثبت سند در این بازه فقط برای مالک و حسابدار ممکن است. تا پیش از بستن نهایی سال می‌توانید دوره را بازگشایی کنید.",
      confirmLabel: "بستن موقت دوره",
      destructive: false,
    };
  }
  if (action.targetStatus === "locked") {
    return {
      title: `قفل کردن ${periodName}؟`,
      description:
        "با قفل‌شدن دوره، هیچ کاربری نمی‌تواند در این بازه سند ثبت کند. تا پیش از بستن نهایی سال، بازگشایی دوباره ممکن است.",
      confirmLabel: "قفل کردن دوره",
      destructive: true,
    };
  }
  return {
    title: `بازگشایی ${periodName}؟`,
    description: "با بازگشایی، کاربران دارای دسترسی ثبت سند دوباره می‌توانند در این بازه سند ثبت کنند.",
    confirmLabel: "بازگشایی دوره",
    destructive: false,
  };
}

function PeriodActionButtons({
  period,
  disabled,
  onRequest,
}: {
  period: FiscalPeriod;
  disabled: boolean;
  onRequest: (period: FiscalPeriod, targetStatus: PeriodStatus) => void;
}) {
  if (period.status === "open") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onRequest(period, "soft_closed")}
        className="border-amber-200 text-amber-800 hover:bg-amber-50 hover:text-amber-950 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/15 dark:hover:text-amber-200"
      >
        بستن موقت
      </Button>
    );
  }

  if (period.status === "soft_closed") {
    return (
      <>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={disabled}
          onClick={() => onRequest(period, "locked")}
        >
          قفل کردن
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onRequest(period, "open")}
        >
          بازگشایی
        </Button>
      </>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => onRequest(period, "open")}
    >
      بازگشایی
    </Button>
  );
}

export function FiscalPeriodsSection() {
  const [years, setYears] = useState<FiscalYear[] | null>(null);
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const [periodsState, setPeriodsState] = useState<{ yearId: string; periods: FiscalPeriod[] } | null>(null);
  const [newYear, setNewYear] = useState(String(todayJalali().jy));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [yearsLoadFailed, setYearsLoadFailed] = useState(false);
  const [periodsLoadFailed, setPeriodsLoadFailed] = useState(false);
  const [mutation, setMutation] = useState<Mutation>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [readiness, setReadiness] = useState<FiscalReadiness | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Advisory only: a failed read hides the warning rather than claiming the
    // books are ready, and never blocks the year list below.
    void api<{ readiness: FiscalReadiness }>("/api/ledger/fiscal-readiness")
      .then(({ ok, data }) => {
        if (!cancelled) setReadiness(ok ? data.readiness : null);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    void api<{ fiscalYears: FiscalYear[] }>("/api/ledger/fiscal-years")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setYearsLoadFailed(true);
          // Keep a previously loaded list usable when a background refresh
          // fails; an empty list is only correct for the very first failure.
          setYears((current) => current ?? []);
          return;
        }
        setYearsLoadFailed(false);
        setYears(data.fiscalYears);
        setSelectedYearId((current) =>
          current && data.fiscalYears.some((year) => year.id === current)
            ? current
            : data.fiscalYears[0]?.id ?? null,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setYearsLoadFailed(true);
        setYears((current) => current ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedYearId) {
      setPeriodsState(null);
      setPeriodsLoadFailed(false);
      return () => {
        cancelled = true;
      };
    }

    // Never leave the prior year's controls on screen while this year's
    // request is in flight: they are real mutating buttons, not just stale
    // decoration.
    setPeriodsState(null);
    setPeriodsLoadFailed(false);
    const yearId = selectedYearId;
    void api<{ periods: FiscalPeriod[] }>(`/api/ledger/fiscal-years/${yearId}/periods`)
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) {
          setPeriodsState({ yearId, periods: data.periods });
          return;
        }
        setPeriodsState({ yearId, periods: [] });
        setPeriodsLoadFailed(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPeriodsState({ yearId, periods: [] });
        setPeriodsLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedYearId, refreshKey]);

  const selectedYear = years?.find((year) => year.id === selectedYearId) ?? null;
  const periods = periodsState?.yearId === selectedYearId ? periodsState.periods : null;
  const softClosedCount = periods?.filter((period) => period.status === "soft_closed").length ?? 0;
  const allPeriodsSoftClosed =
    periods?.length === FISCAL_PERIOD_COUNT && softClosedCount === FISCAL_PERIOD_COUNT;
  const canManagePeriods = Boolean(selectedYear && !selectedYear.closedAt);
  const isMutating = mutation !== null;
  const newYearNumber = Number(newYear);
  const newYearInvalid = newYear.trim().length > 0 && !isSupportedFiscalYear(newYearNumber);

  function refresh() {
    setRefreshKey((key) => key + 1);
  }

  function selectYear(yearId: string) {
    if (yearId === selectedYearId) return;
    setSelectedYearId(yearId);
    setPeriodsState(null);
    setPeriodsLoadFailed(false);
    setError("");
    setNotice("");
  }

  async function createYear() {
    setError("");
    setNotice("");
    if (!isSupportedFiscalYear(newYearNumber)) {
      setError(errorMessage("invalid_year"));
      return;
    }

    setMutation("create-year");
    try {
      const { ok, data } = await api<{ fiscalYear?: FiscalYear; error?: string }>("/api/ledger/fiscal-years", {
        method: "POST",
        body: JSON.stringify({ year: newYearNumber }),
      });
      if (!ok || !data.fiscalYear) {
        setError(errorMessage(data.error));
        return;
      }

      const createdYear = data.fiscalYear;
      setYears((current) =>
        current
          ? [createdYear, ...current.filter((year) => year.id !== createdYear.id)]
          : [createdYear],
      );
      setSelectedYearId(createdYear.id);
      setPeriodsState(null);
      setNotice(`سال مالی ${toPersianDigits(createdYear.label)} با ${toPersianDigits(FISCAL_PERIOD_COUNT)} دورهٔ باز تعریف شد.`);
      setNewYear(newYearNumber < FISCAL_YEAR_MAX ? String(newYearNumber + 1) : "");
      refresh();
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  function requestPeriodStatus(period: FiscalPeriod, targetStatus: PeriodStatus) {
    setError("");
    setNotice("");
    setPendingAction({ kind: "period", period, targetStatus });
  }

  function requestCloseYear() {
    if (!selectedYear || !allPeriodsSoftClosed) return;
    setError("");
    setNotice("");
    setPendingAction({ kind: "close-year", fiscalYear: selectedYear });
  }

  async function confirmAction() {
    if (!pendingAction || isMutating) return;
    const action = pendingAction;
    setMutation(action.kind === "period" ? "period" : "close-year");
    setError("");
    try {
      const response = action.kind === "period"
        ? await api<{ error?: string }>(`/api/ledger/fiscal-periods/${action.period.id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: action.targetStatus }),
          })
        : await api<{ error?: string }>(`/api/ledger/fiscal-years/${action.fiscalYear.id}/close`, {
            method: "POST",
          });
      if (!response.ok) {
        // An error banner behind a modal is invisible. Close the confirmation,
        // then reload the authoritative state in case another accountant made
        // the same transition in a different tab.
        setPendingAction(null);
        setError(errorMessage(response.data.error));
        refresh();
        return;
      }

      setPendingAction(null);
      if (action.kind === "period") {
        const verb: Record<PeriodStatus, string> = {
          open: "بازگشایی شد",
          soft_closed: "به‌صورت موقت بسته شد",
          locked: "قفل شد",
        };
        setNotice(`دورهٔ ${toPersianDigits(action.period.name)} ${verb[action.targetStatus]}.`);
      } else {
        setNotice(`سال مالی ${toPersianDigits(action.fiscalYear.label)} بسته شد و همهٔ دوره‌های آن قفل شدند.`);
      }
      refresh();
    } catch {
      setPendingAction(null);
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  if (!years) return <LoadingSkeleton rows={3} label="در حال بارگذاری سال‌های مالی" />;

  const pendingCopy = pendingAction ? actionCopy(pendingAction) : null;
  const closingHint = !periods
    ? "در حال بررسی دوره‌های این سال…"
    : periods.length !== FISCAL_PERIOD_COUNT
      ? "فهرست دوره‌ها کامل نیست و سال مالی قابل بستن نیست."
      : allPeriodsSoftClosed
        ? "همهٔ دوره‌ها برای بستن نهایی سال آماده‌اند."
        : `${toPersianDigits(softClosedCount)} از ${toPersianDigits(FISCAL_PERIOD_COUNT)} دوره به‌صورت موقت بسته شده‌اند.`;

  return (
    <section className="space-y-4" aria-label="مدیریت سال‌ها و دوره‌های مالی">
      <ErrorBox>{error}</ErrorBox>
      <ErrorBox>{yearsLoadFailed ? "بارگذاری سال‌های مالی ناموفق بود. می‌توانید دوباره تلاش کنید." : ""}</ErrorBox>
      <ErrorBox>{periodsLoadFailed ? "بارگذاری دوره‌های این سال مالی ناموفق بود. می‌توانید دوباره تلاش کنید." : ""}</ErrorBox>
      <FiscalReadinessBanner readiness={readiness} />
      {notice ? (
        <p role="status" className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-foreground">
          {notice}
        </p>
      ) : null}

      <SectionCard
        title="سال‌های مالی"
        description="هر سال مالی از فروردین تا اسفند و شامل دوازده دورهٔ ماهانه است. تعریف سال، هیچ سندی ثبت یا قفل نمی‌کند."
      >
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void createYear();
          }}
        >
          <Field
            label="سال شمسی جدید"
            hint={`فقط عددی بین ${toPersianDigits(FISCAL_YEAR_MIN)} تا ${toPersianDigits(FISCAL_YEAR_MAX)}`}
          >
            <PersianNumberInput
              grouping={false}
              allowNegative={false}
              inputMode="numeric"
              value={newYear}
              onChange={(event) => setNewYear(event.target.value)}
              className={inputClass}
              placeholder="۱۴۰۵"
              aria-invalid={newYearInvalid || undefined}
            />
          </Field>
          <div className="w-full sm:w-[13rem]">
            <PrimaryButton type="submit" disabled={isMutating || newYearInvalid || !newYear.trim()}>
              {mutation === "create-year" ? "در حال تعریف…" : "تعریف سال مالی"}
            </PrimaryButton>
          </div>
        </form>

        {years.length === 0 ? (
          <EmptyState>هنوز سال مالی‌ای تعریف نشده است. سال جاری را وارد و تعریف کنید تا دوازده دورهٔ ماهانه ساخته شود.</EmptyState>
        ) : (
          <div className="mt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-foreground">سال انتخاب‌شده</h3>
              {selectedYear ? (
                <p className="text-xs text-muted-foreground">{formatRange(selectedYear.startsOn, selectedYear.endsOn)}</p>
              ) : null}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" role="group" aria-label="انتخاب سال مالی">
              {years.map((year) => {
                const isSelected = selectedYearId === year.id;
                return (
                  <FilterChip
                    key={year.id}
                    selected={isSelected}
                    onClick={() => selectYear(year.id)}
                    className="min-h-12 px-4"
                  >
                    {toPersianDigits(year.label)}
                    {year.closedAt ? <span className="sr-only">، بسته‌شده</span> : null}
                  </FilterChip>
                );
              })}
            </div>
          </div>
        )}

        {yearsLoadFailed ? (
          <div className="mt-4 max-w-xs">
            <SecondaryButton onClick={refresh} disabled={isMutating}>تلاش دوباره</SecondaryButton>
          </div>
        ) : null}
      </SectionCard>

      {selectedYear ? (
        <SectionCard
          title={`دوره‌های سال مالی ${toPersianDigits(selectedYear.label)}`}
          description={selectedYear.closedAt ? "این سال به‌صورت نهایی بسته شده است؛ همهٔ دوره‌ها قفل و غیرقابل بازگشایی‌اند." : closingHint}
          actions={
            !selectedYear.closedAt ? (
              <Button
                type="button"
                variant="destructive"
                disabled={isMutating || !allPeriodsSoftClosed}
                onClick={requestCloseYear}
              >
                {mutation === "close-year" ? "در حال بستن…" : "بستن نهایی سال"}
              </Button>
            ) : (
              <StatusBadge tone="danger">بسته‌شده</StatusBadge>
            )
          }
        >
          {periods === null ? (
            <LoadingSkeleton rows={FISCAL_PERIOD_COUNT} compact label="در حال بارگذاری دوره‌های سال مالی" />
          ) : periodsLoadFailed ? (
            <div className="space-y-3">
              <EmptyState>دوره‌های این سال در دسترس نیستند.</EmptyState>
              <SecondaryButton onClick={refresh} disabled={isMutating}>تلاش دوباره</SecondaryButton>
            </div>
          ) : periods.length === 0 ? (
            <EmptyState>دوره‌ای برای سال انتخاب‌شده وجود ندارد.</EmptyState>
          ) : (
            <>
              {!canManagePeriods ? null : (
                <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
                  بستن موقت، ثبت سند را به مالک و حسابدار محدود می‌کند. قفل‌کردن ثبت را برای همه می‌بندد؛ پیش از بستن نهایی سال می‌توانید یک دوره را بازگشایی کنید.
                </p>
              )}
              <DataTable caption="دوره‌های مالی و وضعیت هر دوره" className="hidden lg:block">
                <DataTableHead>
                  <Th>دوره</Th>
                  <Th>وضعیت</Th>
                  {canManagePeriods ? <Th>اقدام</Th> : null}
                </DataTableHead>
                <DataTableBody>
                  {periods.map((period) => (
                    <DataTableRow key={period.id}>
                      <Td className="font-medium">
                        {toPersianDigits(period.name)}
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                          {formatRange(period.startsOn, period.endsOn)}
                        </span>
                      </Td>
                      <Td>
                        <StatusBadge tone={STATUS_TONES[period.status]}>{STATUS_LABELS[period.status]}</StatusBadge>
                      </Td>
                      {canManagePeriods ? (
                        <Td>
                          <div className="flex flex-wrap gap-2">
                            <PeriodActionButtons
                              period={period}
                              disabled={isMutating || pendingAction !== null}
                              onRequest={requestPeriodStatus}
                            />
                          </div>
                        </Td>
                      ) : null}
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {periods.map((period) => (
                  <article key={period.id} className="rounded-xl border border-border/80 bg-muted/40 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">{toPersianDigits(period.name)}</h3>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          {formatRange(period.startsOn, period.endsOn)}
                        </p>
                      </div>
                      <StatusBadge tone={STATUS_TONES[period.status]}>{STATUS_LABELS[period.status]}</StatusBadge>
                    </div>
                    {canManagePeriods ? (
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                        <PeriodActionButtons
                          period={period}
                          disabled={isMutating || pendingAction !== null}
                          onRequest={requestPeriodStatus}
                        />
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </>
          )}
        </SectionCard>
      ) : null}

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !isMutating) setPendingAction(null);
        }}
      >
        {pendingAction && pendingCopy ? (
          <DialogContent showCloseButton={!isMutating}>
            <DialogHeader>
              <DialogTitle>{pendingCopy.title}</DialogTitle>
              <DialogDescription>{pendingCopy.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isMutating}
                onClick={() => setPendingAction(null)}
              >
                انصراف
              </Button>
              <Button
                type="button"
                variant={pendingCopy.destructive ? "destructive" : "default"}
                disabled={isMutating}
                onClick={() => void confirmAction()}
              >
                {isMutating ? "در حال ثبت…" : pendingCopy.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}
