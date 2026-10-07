"use client";

import {
  EmptyState,
  LoadingSkeleton,
  SectionCardSkeleton,
  StatusBadge,
  cardClass,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { todayIsoDate } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  CalendarDaysIcon,
  CheckIcon,
  FileTextIcon,
  PlusIcon,
  RefreshCwIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import type { InstallmentPlanRow } from "@/lib/installments-service";
import { fmtJalali, OverlayDialog } from "./ledger-ui";
import { FilterChip } from "@/app/dashboard/filters";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { SETTLEMENT_METHOD_LABELS, type SettlementMethod } from "./settlement-form";

/**
 * «کارت اقساط» — the installment schedule card. Functions follow the trade's
 * reference (receivable/payable split, party- or invoice-based plans, slice
 * settlement) but the chrome is the platform's: warm cards, amber selection,
 * teal actions, Persian digits everywhere.
 */

type Direction = "receivable" | "payable";
type StatusFilter = "all" | "open" | "overdue" | "settled";

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "همه",
  open: "جاری",
  overdue: "سررسید گذشته",
  settled: "تسویه شده",
};

export function InstallmentsSection() {
  const money = useMoney();
  const [direction, setDirection] = useState<Direction>("receivable");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");
  const [plans, setPlans] = useState<InstallmentPlanRow[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const params = new URLSearchParams({ direction, status });
    if (q.trim()) params.set("q", q.trim());
    setError("");
    try {
      const { ok, data } = await api<{ plans: InstallmentPlanRow[]; error?: string }>(`/api/ledger/installments?${params}`);
      // A slower response for the previous query/filter must not replace the
      // newest result after rapid typing or tab changes.
      if (sequence !== requestSequence.current) return;
      if (ok) setPlans(data.plans ?? []);
      else {
        setPlans([]);
        setError(errorMessage(data.error));
      }
    } catch {
      if (sequence !== requestSequence.current) return;
      setPlans([]);
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    }
  }, [direction, status, q]);

  useEffect(() => {
    setPlans(null);
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q, refreshKey]);

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کارت اقساط</p>
            <h2 className="mt-1 font-semibold text-foreground dark:text-stone-50">اقساط</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              برنامه پرداخت قسطی بدهی مشتریان یا تعهدات کسب‌وکار؛ هر قسط که تسویه شود، سند دریافت/پرداخت آن هم ثبت می‌شود.
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted sm:flex-none"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              به‌روزرسانی
            </button>
            <Button onClick={() => setCreating(true)} className="min-h-11 flex-1 sm:flex-none">
              <PlusIcon aria-hidden="true" className="size-4" />
              اقساط جدید
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex gap-2" role="group" aria-label="جهت اقساط">
            <FilterChip dense selected={direction === "receivable"} onClick={() => setDirection("receivable")}>
              دریافتنی
            </FilterChip>
            <FilterChip dense selected={direction === "payable"} onClick={() => setDirection("payable")}>
              پرداختنی
            </FilterChip>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:ms-auto lg:w-auto">
            <div className="flex max-w-full gap-1.5 overflow-x-auto pb-1" role="group" aria-label="وضعیت">
              {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((key) => (
                <FilterChip key={key} dense selected={status === key} onClick={() => setStatus(key)}>
                  {STATUS_LABEL[key]}
                </FilterChip>
              ))}
            </div>
            <input
              className={`${inputClass} h-11 w-full sm:ms-auto sm:w-56`}
              type="search"
              aria-label="جست‌وجوی برنامه‌های اقساط"
              placeholder="جست‌وجوی شخص یا فاکتور…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4">
          {!plans ? (
            <SectionCardSkeleton rows={4} />
          ) : plans.length === 0 ? (
            <EmptyState>هنوز برنامه قسطی ثبت نشده است.</EmptyState>
          ) : (
            <>
              <DataTable caption="برنامه‌های قسطی ثبت‌شده" className="hidden lg:block">
                <DataTableHead>
                  <Th>#</Th>
                  <Th>عنوان</Th>
                  <Th>مبلغ اصل</Th>
                  <Th>مانده</Th>
                  <Th>تعداد اقساط</Th>
                  <Th>سررسید بعدی</Th>
                  <Th>وضعیت</Th>
                  <Th>اقدام</Th>
                </DataTableHead>
                <DataTableBody>
                  {plans.map((p, index) => (
                    <DataTableRow key={p.id}>
                      <Td muted>{toPersianDigits(index + 1)}</Td>
                      <Td>
                        <span className="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium">
                          <UserIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                          <span className="truncate">{p.partyName ?? "بدون شخص"}</span>
                        </span>
                        {p.invoiceOrderNumber !== null ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">فاکتور {toPersianDigits(p.invoiceOrderNumber)}</p>
                        ) : null}
                      </Td>
                      <Td nowrap className="font-semibold">{money.format(p.principal)}</Td>
                      <Td nowrap muted className="font-semibold">{money.format(p.remaining)}</Td>
                      <Td nowrap muted>
                        {toPersianDigits(p.paidCount)} / {toPersianDigits(p.installmentCount)}
                      </Td>
                      <Td nowrap muted>{fmtJalali(p.nextDueDate)}</Td>
                      <Td>
                        {p.status === "settled" ? (
                          <StatusBadge tone="positive">تسویه شده</StatusBadge>
                        ) : p.status === "overdue" ? (
                          <StatusBadge tone="danger">سررسید گذشته</StatusBadge>
                        ) : (
                          <StatusBadge tone="active">پرداخت نشده</StatusBadge>
                        )}
                      </Td>
                      <Td>
                        <button
                          type="button"
                          onClick={() => setDetailId(p.id)}
                          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20"
                        >
                          جزئیات و پرداخت
                        </button>
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {plans.map((p) => (
                  <article key={p.id} className="rounded-xl border border-border/80 bg-muted p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold">{p.partyName ?? "بدون شخص"}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {p.invoiceOrderNumber !== null ? `فاکتور ${toPersianDigits(p.invoiceOrderNumber)} · ` : ""}
                          سررسید بعدی {fmtJalali(p.nextDueDate)}
                        </p>
                      </div>
                      {p.status === "settled" ? (
                        <StatusBadge tone="positive">تسویه شده</StatusBadge>
                      ) : p.status === "overdue" ? (
                        <StatusBadge tone="danger">سررسید گذشته</StatusBadge>
                      ) : (
                        <StatusBadge tone="active">پرداخت نشده</StatusBadge>
                      )}
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                      <div><dt className="text-xs text-muted-foreground">مبلغ اصل</dt><dd className="mt-1 font-semibold">{money.format(p.principal)}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">مانده</dt><dd className="mt-1 font-semibold">{money.format(p.remaining)}</dd></div>
                    </dl>
                    <button type="button" onClick={() => setDetailId(p.id)} className="mt-3 w-full rounded-lg bg-amber-100 dark:bg-amber-500/20 px-4 py-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
                      جزئیات و پرداخت
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {creating ? (
        <CreateInstallmentPanel
          direction={direction}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      ) : null}
      {detailId ? (
        <InstallmentDetailPanel planId={detailId} onClose={() => setDetailId(null)} onChanged={() => setRefreshKey((k) => k + 1)} />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------ */

function CreateInstallmentPanel({
  direction: initialDirection,
  onClose,
  onCreated,
}: {
  direction: Direction;
  onClose: () => void;
  onCreated: () => void;
}) {
  const money = useMoney();
  const [direction, setDirection] = useState<Direction>(initialDirection);
  const [source, setSource] = useState<"party" | "invoice">("party");
  const [parties, setParties] = useState<{ id: string; name: string }[]>([]);
  const [invoices, setInvoices] = useState<{ id: string; orderNumber: number; total: number; creditTotal: number; customerName: string | null }[]>([]);
  const [invoicesAvailable, setInvoicesAvailable] = useState(true);
  const [partiesLoading, setPartiesLoading] = useState(true);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [partyId, setPartyId] = useState("");
  const [invoiceOrderId, setInvoiceOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState(4);
  const [intervalMonths, setIntervalMonths] = useState(1);
  const [firstDueDate, setFirstDueDate] = useState(todayIsoDate);
  const [downPayment, setDownPayment] = useState("");
  const [hasDownPayment, setHasDownPayment] = useState(false);
  const [hasInterest, setHasInterest] = useState(false);
  const [interest, setInterest] = useState("");
  const [hasLateFee, setHasLateFee] = useState(false);
  const [lateFee, setLateFee] = useState("");
  const [note, setNote] = useState("");
  const [moreSettings, setMoreSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const role = direction === "receivable" ? "Customer" : "Supplier";
    setParties([]);
    setPartiesLoading(true);
    void api<{ customers?: { id: string; name: string }[] }>(`/api/parties?page=1&pageSize=500&roles=${role}`)
      .then(({ ok, data }) => {
        if (!cancelled && ok) setParties(data.customers ?? []);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setPartiesLoading(false); });

    if (direction === "receivable") {
      setInvoicesAvailable(true);
      setInvoicesLoading(true);
      void api<{ invoices?: { id: string; orderNumber: number; total: number; creditTotal: number; customerName: string | null }[] }>(
        "/api/sales/invoices?pageSize=100&method=credit&installmentEligible=true",
      ).then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setInvoices(data.invoices ?? []);
        else setInvoicesAvailable(false);
      }).catch(() => {
        if (!cancelled) setInvoicesAvailable(false);
      }).finally(() => { if (!cancelled) setInvoicesLoading(false); });
    } else {
      setInvoices([]);
      setInvoicesLoading(false);
    }
    return () => { cancelled = true; };
  }, [direction]);

  const selectedInvoice = useMemo(() => invoices.find((i) => i.id === invoiceOrderId), [invoices, invoiceOrderId]);

  async function submit() {
    setError("");
    if (source === "party" && !partyId) {
      setError(errorMessage("party_required"));
      return;
    }
    if (source === "invoice" && !selectedInvoice) {
      setError(errorMessage("invoice_required"));
      return;
    }

    let principal: number;
    let parsedDownPayment = 0;
    try {
      principal = source === "invoice" ? (selectedInvoice?.creditTotal ?? 0) : money.parse(amount);
      parsedDownPayment = hasDownPayment && downPayment ? money.parse(downPayment) : 0;
    } catch {
      setError(errorMessage("invalid_amount"));
      return;
    }

    setBusy(true);
    try {
      const { ok, data } = await api<{ error?: string; message?: string }>("/api/ledger/installments", {
        method: "POST",
        body: JSON.stringify({
          direction,
          source,
          partyId: source === "party" ? partyId : undefined,
          invoiceOrderId: source === "invoice" ? invoiceOrderId : undefined,
          principal,
          downPayment: parsedDownPayment,
          interestPercent: hasInterest && interest ? Number(interest) : 0,
          lateFeePercent: hasLateFee && lateFee ? Number(lateFee) : 0,
          installmentCount: count,
          intervalMonths,
          firstDueDate,
          note: note.trim() || undefined,
        }),
      });
      if (ok) onCreated();
      else setError(errorMessage(data.error));
    } catch {
      setError("ارتباط با سرور برقرار نشد. اطلاعات شما ثبت نشده است؛ دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OverlayDialog
      headingId="create-installment-heading"
      onClose={onClose}
      dismissible={!busy}
      sheet
      className={`${overlayPanelClass} flex max-h-[100dvh] w-full max-w-2xl flex-col rounded-b-none sm:max-h-[90vh] sm:rounded-b-2xl`}
    >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ایجاد اقساط</p>
            <h3 id="create-installment-heading" className="mt-1 text-lg font-bold">برنامه قسطی جدید</h3>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="بستن" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50">
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
          <ErrorBox>{error}</ErrorBox>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2" role="group" aria-label="جهت قسط">
              <FilterChip dense selected={direction === "receivable"} onClick={() => { setDirection("receivable"); setSource("party"); setPartyId(""); }}>
                دریافتنی
              </FilterChip>
              <FilterChip dense selected={direction === "payable"} onClick={() => { setDirection("payable"); setSource("party"); setPartyId(""); }}>
                پرداختنی
              </FilterChip>
            </div>
            <p className="text-xs text-muted-foreground">تاریخ ثبت: {fmtJalali(todayIsoDate())}</p>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">قسط‌بندی برای:</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={source === "party"}
                onClick={() => setSource("party")}
                className={`flex min-h-14 items-center gap-3 rounded-xl border px-3 text-sm transition-colors ${
            source === "party"
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                <UsersIcon aria-hidden="true" className="size-4 text-amber-800 dark:text-amber-300" />
                {direction === "receivable" ? "دریافت از اشخاص" : "پرداخت به اشخاص"}
                {source === "party" ? <CheckIcon aria-hidden="true" className="ms-auto size-4" /> : null}
              </button>
              <button
                type="button"
                aria-pressed={source === "invoice"}
                disabled={direction !== "receivable" || !invoicesAvailable}
                onClick={() => setSource("invoice")}
                className={`flex min-h-14 items-center gap-3 rounded-xl border px-3 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50 ${
            source === "invoice"
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                <FileTextIcon aria-hidden="true" className="size-4 text-amber-800 dark:text-amber-300" />
                فاکتورهای نسیه
                {source === "invoice" ? <CheckIcon aria-hidden="true" className="ms-auto size-4" /> : null}
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {source === "party" ? (
              <Field label={direction === "receivable" ? "پرداخت‌کننده" : "دریافت‌کننده"}>
                <SearchableSelect
                  value={partyId}
                  onChange={setPartyId}
                  ariaLabel="انتخاب شخص"
                  loading={partiesLoading}
                  disabled={partiesLoading}
                  emptyText="شخصی با این نقش پیدا نشد."
                  options={[{ value: "", label: "انتخاب کنید…" }, ...parties.map((p) => ({ value: p.id, label: p.name }))]}
                />
              </Field>
            ) : (
              <Field label="فاکتور نسیه">
                <SearchableSelect
                  value={invoiceOrderId}
                  onChange={setInvoiceOrderId}
                  ariaLabel="انتخاب فاکتور"
                  loading={invoicesLoading}
                  disabled={invoicesLoading}
                  emptyText="فاکتور نسیهٔ بدون برنامهٔ اقساط پیدا نشد."
                  options={[
                    { value: "", label: "انتخاب کنید…" },
                    ...invoices.map((i) => ({
                      value: i.id,
                      label: `فاکتور ${toPersianDigits(i.orderNumber)} — ${i.customerName ?? "بدون مشتری"}`,
                    })),
                  ]}
                />
              </Field>
            )}
            {source === "party" ? (
              <Field label="مبلغ پرداختنی" hint={money.unitLabel}>
                <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" />
              </Field>
            ) : selectedInvoice ? (
              <div className="rounded-xl border border-border/80 bg-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">ماندهٔ نسیهٔ قابل قسط‌بندی</p>
                <p className="mt-1 text-sm font-bold">{money.format(selectedInvoice.creditTotal)}</p>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="تعداد اقساط">
              <div className="flex items-center gap-2">
                <button type="button" aria-label="کاهش" onClick={() => setCount((c) => Math.max(c - 1, 1))} className="inline-flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted">−</button>
                <span className="min-w-12 text-center text-sm font-bold">{toPersianDigits(count)}</span>
                <button type="button" aria-label="افزایش" onClick={() => setCount((c) => Math.min(c + 1, 120))} className="inline-flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted">+</button>
              </div>
            </Field>
            <Field label="فاصله اقساط">
              <div className="flex items-center gap-2">
                {/* PersianNumberInput already hands back canonical ASCII, so the
                    digit-by-digit translation this used to do by hand is gone. */}
                <PersianNumberInput
                  className={`${inputClass} w-20`}
                  dir="ltr"
                  inputMode="numeric"
                  grouping={false}
                  allowNegative={false}
                  aria-label="فاصله اقساط به ماه"
                  value={String(intervalMonths)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setIntervalMonths(Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 36) : 1);
                  }}
                />
                <span className="text-sm text-muted-foreground">ماه</span>
              </div>
            </Field>
            <Field label="تاریخ اولین بازپرداخت">
              <JalaliDatePicker value={firstDueDate} onChange={setFirstDueDate} className={inputClass} />
            </Field>
          </div>

          <div className="rounded-xl border border-border/80">
            <button type="button" onClick={() => setMoreSettings((v) => !v)} className="flex min-h-12 w-full items-center justify-between px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted">
              سایر تنظیمات
              <CalendarDaysIcon aria-hidden="true" className={`size-4 text-muted-foreground transition-transform ${moreSettings ? "rotate-90" : ""}`} />
            </button>
            {moreSettings ? (
              <div className="space-y-3 border-t border-border px-3 py-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hasDownPayment} onChange={(e) => setHasDownPayment(e.target.checked)} className="size-4 accent-amber-600" />
                  پیش‌پرداختِ قبلاً دریافت/پرداخت‌شده
                </label>
                {hasDownPayment ? (
                  <>
                    <PersianNumberInput className={`${inputClass} max-w-48`} dir="ltr" inputMode="numeric" value={downPayment} onChange={(e) => setDownPayment(e.target.value)} placeholder="۰" />
                    <p className="text-xs leading-5 text-muted-foreground">این مبلغ فقط از ماندهٔ قابل قسط‌بندی کم می‌شود و دریافت/پرداخت تازه‌ای ثبت نمی‌کند.</p>
                  </>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hasInterest} onChange={(e) => setHasInterest(e.target.checked)} className="size-4 accent-amber-600" />
                  محاسبه سود (درصد)
                </label>
                {/* A plain <input> here meant a Persian «۵» arrived as NaN and the
                    plan was created with no interest at all (or, before the service
                    learned to refuse it, failed with an unexplained server error). */}
                {hasInterest ? (
                  <PersianNumberInput
                    className={`${inputClass} max-w-48`}
                    dir="ltr"
                    inputMode="decimal"
                    grouping={false}
                    allowNegative={false}
                    aria-label="درصد سود"
                    value={interest}
                    onChange={(e) => setInterest(e.target.value)}
                    placeholder="۰"
                  />
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hasLateFee} onChange={(e) => setHasLateFee(e.target.checked)} className="size-4 accent-amber-600" />
                  نرخ جریمه دیرکرد (درصد)
                </label>
                {hasLateFee ? (
                  <PersianNumberInput
                    className={`${inputClass} max-w-48`}
                    dir="ltr"
                    inputMode="decimal"
                    grouping={false}
                    allowNegative={false}
                    aria-label="درصد جریمه دیرکرد"
                    value={lateFee}
                    onChange={(e) => setLateFee(e.target.value)}
                    placeholder="۰"
                  />
                ) : null}
                {hasLateFee ? (
                  <p className="text-xs leading-5 text-muted-foreground">این نرخ در کارت ثبت می‌شود؛ مبلغ جریمه خودکار به قسط یا سند حسابداری افزوده نمی‌شود.</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <Field label="توضیحات">
            <textarea className={`${inputClass} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        <footer className="grid grid-cols-2 gap-3 border-t border-border px-4 py-4 sm:px-5">
          <SecondaryButton onClick={onClose} disabled={busy}>انصراف</SecondaryButton>
          <PrimaryButton onClick={() => void submit()} disabled={busy}>
            {busy ? "در حال ثبت…" : "ثبت اقساط"}
          </PrimaryButton>
        </footer>
      </OverlayDialog>
  );
}

/* ------------------------------------------------------------------------ */

function InstallmentDetailPanel({ planId, onClose, onChanged }: { planId: string; onClose: () => void; onChanged: () => void }) {
  const money = useMoney();
  const [plan, setPlan] = useState<InstallmentPlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payingId, setPayingId] = useState<string | null>(null);
  const [method, setMethod] = useState<SettlementMethod>("cash");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await api<{ plan: InstallmentPlanRow; error?: string }>(`/api/ledger/installments/${planId}`);
      if (ok) setPlan(data.plan);
      else {
        setPlan(null);
        setError(errorMessage(data.error));
      }
    } catch {
      setPlan(null);
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, [planId]);
  useEffect(() => { void load(); }, [load]);

  async function pay(itemId: string) {
    setBusy(true);
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/installments/${planId}/pay`, {
        method: "POST",
        body: JSON.stringify({ itemId, method, memo: memo.trim() || undefined }),
      });
      if (ok) {
        setPayingId(null);
        setMemo("");
        void load();
        onChanged();
      } else {
        setError(errorMessage(data.error));
      }
    } catch {
      setError("ارتباط با سرور برقرار نشد. وضعیت قسط را به‌روزرسانی کنید و دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OverlayDialog
      headingId="installment-detail-heading"
      onClose={onClose}
      dismissible={!busy}
      sheet
      className={`${overlayPanelClass} flex max-h-[100dvh] w-full max-w-2xl flex-col rounded-b-none sm:max-h-[90vh] sm:rounded-b-2xl`}
    >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کارت اقساط</p>
            <h3 id="installment-detail-heading" className="mt-1 text-lg font-bold">
              {plan ? (plan.partyName ?? "بدون شخص") : "…"}
            </h3>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="بستن" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50">
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <ErrorBox>{error}</ErrorBox>
          {loading ? (
            <LoadingSkeleton rows={4} />
          ) : !plan ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">اطلاعات برنامه در دسترس نیست.</p>
              <Button variant="outline" className="mt-3" onClick={() => void load()}>تلاش دوباره</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 md:grid-cols-5">
                <div className="rounded-xl border border-border/80 bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">مبلغ اصل</dt>
                  <dd className="mt-1 text-sm font-bold">{money.format(plan.principal)}</dd>
                </div>
                {/* The schedule's own total: principal less the down payment, plus
                    interest. Showing only the principal hid the interest a plan
                    actually charges. */}
                <div className="rounded-xl border border-border/80 bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">جمع اقساط</dt>
                  <dd className="mt-1 text-sm font-bold">{money.format(plan.scheduledTotal)}</dd>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">مانده</dt>
                  <dd className="mt-1 text-sm font-bold">{money.format(plan.remaining)}</dd>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">پیش‌پرداخت</dt>
                  <dd className="mt-1 text-sm font-semibold">{plan.downPayment ? money.format(plan.downPayment) : "—"}</dd>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted px-3 py-2">
                  <dt className="text-xs text-muted-foreground">سررسید بعدی</dt>
                  <dd className="mt-1 text-sm font-semibold">{fmtJalali(plan.nextDueDate)}</dd>
                </div>
              </dl>

              {(plan.invoiceOrderNumber !== null || plan.interestPercent > 0 || plan.lateFeePercent > 0 || plan.note) ? (
                <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-border/80 px-3 py-2 text-xs text-muted-foreground">
                  {plan.invoiceOrderNumber !== null ? <span>فاکتور {toPersianDigits(plan.invoiceOrderNumber)}</span> : null}
                  {plan.interestPercent > 0 ? <span>سود: ٪{toPersianDigits(plan.interestPercent)}</span> : null}
                  {plan.lateFeePercent > 0 ? <span>نرخ دیرکرد: ٪{toPersianDigits(plan.lateFeePercent)}</span> : null}
                  {plan.note ? <span className="basis-full leading-5 text-foreground">{plan.note}</span> : null}
                </div>
              ) : null}

              <DataTable caption="اقساط این برنامه" tableClassName="min-w-[36rem]">
                <DataTableHead>
                  <Th>قسط</Th>
                  <Th>سررسید</Th>
                  <Th>مبلغ</Th>
                  <Th>وضعیت</Th>
                  <Th>اقدام</Th>
                </DataTableHead>
                <DataTableBody>
                  {(plan.items ?? []).map((item) => (
                    <DataTableRow key={item.id}>
                      <Td muted>{toPersianDigits(item.seq)}</Td>
                      <Td nowrap muted>{fmtJalali(item.dueDate)}</Td>
                      <Td nowrap className="font-semibold">{money.format(item.amount)}</Td>
                      <Td>
                        {item.paidAt ? <StatusBadge tone="positive">تسویه شده</StatusBadge> : <StatusBadge tone="active">پرداخت نشده</StatusBadge>}
                      </Td>
                      <Td>
                        {item.paidAt ? (
                          <span className="text-xs text-muted-foreground">
                            {item.paidMethod ? SETTLEMENT_METHOD_LABELS[item.paidMethod] : "ثبت‌شده"}
                          </span>
                        ) : payingId === item.id ? null : (
                          <button type="button" onClick={() => { setPayingId(item.id); setError(""); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20">
                            ثبت پرداخت
                          </button>
                        )}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              {payingId ? (
                <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4">
                  <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">تسویه این قسط</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <FilterChip dense selected={method === "cash"} onClick={() => setMethod("cash")}>نقدی</FilterChip>
                    <FilterChip dense selected={method === "bank"} onClick={() => setMethod("bank")}>بانکی</FilterChip>
                    <FilterChip dense selected={method === "clearing"} onClick={() => setMethod("clearing")}>اسناد در جریان وصول</FilterChip>
                    <input className={`${inputClass} h-11 min-w-40 flex-1`} placeholder="شرح (اختیاری)" value={memo} onChange={(e) => setMemo(e.target.value)} />
                  </div>
                  <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">با ثبت پرداخت، سند دریافت/پرداخت این قسط هم در حسابداری ثبت می‌شود.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <SecondaryButton onClick={() => setPayingId(null)} disabled={busy}>انصراف</SecondaryButton>
                    <PrimaryButton onClick={() => void pay(payingId)} disabled={busy}>{busy ? "در حال ثبت…" : "ثبت پرداخت قسط"}</PrimaryButton>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </OverlayDialog>
  );
}
