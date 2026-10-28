"use client";

/**
 * Issue #1128 §D on screen — an agency project's billing documents.
 *
 * The card sits in the «مالی» tab beside the finance card and the contracts
 * register, and it is mounted only when the workspace lookups say the tenant is
 * an advertising agency (`lookups.agencyCommercial`). That flag is the reason a
 * café's project page never calls `/api/agency/**` and never renders an
 * `industry_mismatch` banner for a request it had to make.
 *
 * ## What this card is careful about
 *
 *   * **§D's two halves of the P&L are two labelled groups, not one row of
 *     figures.** The booked half comes from the schedule and says what the
 *     project is *expected* to bill; the posted half comes from the ledger and
 *     says what it *has*. Gross margin is computed from the posted half only —
 *     a margin derived from a schedule is a forecast, and printing it in the
 *     same type as a ledger fact is how a forecast becomes a claim. When either
 *     posted figure is missing the margin reads «—», never zero.
 *   * **The signed value and the revised value are both shown.** An approved
 *     change request moves the revised value, which is what the next percentage
 *     milestone is taken of. Nothing here rewrites what the client signed, and
 *     the card says so where the figure appears.
 *   * **A percentage is never written down as an amount.** The row keeps its
 *     percentage; «قابل صورتحساب» is what that percentage means against today's
 *     revised value, and once a milestone is invoiced the card shows the
 *     invoice's own figure instead — because a percentage resolved now is not
 *     what was billed then.
 *   * **Which acts appear is the register's decision, not the screen's.** Each
 *     row carries the acts its own chain offers from where it is, and the screen
 *     filters them by what the caller may do: the author's own acts on
 *     `workspace.manage`, the determinations on `workspace.approve`. Approving a
 *     milestone does not bill it — billing is its own act, and the server gates
 *     it on the invoice screen's permissions as well.
 */

import { useCallback, useEffect, useState } from "react";
import { ReceiptIcon, FileSignatureIcon } from "lucide-react";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type {
  AgencyBillingBase,
  AgencyChangeRequestStatus,
  AgencyCommercialAction,
  AgencyMilestoneKind,
  AgencyMilestoneStatus,
} from "@/lib/agency-commercial";
import type {
  AgencyChangeRequestRecord,
  AgencyCommercialSummary,
  AgencyMilestoneRecord,
} from "@/lib/agency-commercial-service";
import { DateCell, DateField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/agency/projects/[id]/commercial`
 * ------------------------------------------------------------------------- */

interface CommercialLookups {
  bases: Array<{ base: AgencyBillingBase; label: string; description: string }>;
  kinds: Array<{ kind: AgencyMilestoneKind; label: string }>;
  revenueAccounts: Array<{ code: string; label: string }>;
}

interface CommercialPayload {
  commercial: AgencyCommercialSummary;
  lookups: CommercialLookups;
}

const MILESTONE_TONES: Record<AgencyMilestoneStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  submitted: "active",
  approved: "positive",
  invoiced: "positive",
  rejected: "danger",
  cancelled: "neutral",
};

const CHANGE_REQUEST_TONES: Record<
  AgencyChangeRequestStatus,
  "neutral" | "active" | "positive" | "danger"
> = {
  draft: "neutral",
  priced: "active",
  submitted: "active",
  approved: "positive",
  rejected: "danger",
  implemented: "positive",
  withdrawn: "neutral",
};

/** One figure in the P&L, with the sentence that says who owns it. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
      {hint ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function AgencyBillingCard({
  projectId,
  canManage,
  canApprove,
}: {
  projectId: string;
  canManage: boolean;
  canApprove: boolean;
}) {
  const [payload, setPayload] = useState<CommercialPayload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // The schedule form.
  const [layingOut, setLayingOut] = useState(false);
  const [base, setBase] = useState<AgencyBillingBase>("fixed_price");
  const [depositPercent, setDepositPercent] = useState("30");
  const [periods, setPeriods] = useState("12");
  const [deliverables, setDeliverables] = useState("3");

  // The single-milestone form.
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneKind, setMilestoneKind] = useState<AgencyMilestoneKind>("deliverable");
  const [milestonePercent, setMilestonePercent] = useState("");
  const [milestoneAmount, setMilestoneAmount] = useState("");
  const [milestoneRevenue, setMilestoneRevenue] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");

  // The change-request form.
  const [addingChange, setAddingChange] = useState(false);
  const [changeTitle, setChangeTitle] = useState("");
  const [changeDescription, setChangeDescription] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [changeAmount, setChangeAmount] = useState("");
  const [changeImpact, setChangeImpact] = useState("");

  const money = useMoney();
  const fail = useCallback((code: string | undefined) => setError(workspaceError(code)), []);

  const load = useCallback(async () => {
    const { ok, data } = await api<CommercialPayload>(`/api/agency/projects/${projectId}/commercial`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setPayload(null);
      return;
    }
    setPayload(data);
  }, [projectId, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !payload) return <ErrorBox>{error}</ErrorBox>;
  if (!payload) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="ارزش قرارداد" value="—" />
          <KpiCard label="تغییرات تأییدشده" value="—" />
          <KpiCard label="ارزش اصلاح‌شده" value="—" />
          <KpiCard label="صورتحساب‌شده" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const { commercial, lookups } = payload;
  const { engagement, milestones, changeRequests, schedule, report } = commercial;
  const n = (value: number | string) => toPersianDigits(String(value));
  const dash = (value: number | null) => (value === null ? "—" : money.format(value));
  const rial = (value: number) => money.format(value);
  const revenueLabel = (code: string) =>
    lookups.revenueAccounts.find((account) => account.code === code)?.label ?? code;
  const kindLabel = (kind: AgencyMilestoneKind) =>
    lookups.kinds.find((entry) => entry.kind === kind)?.label ?? kind;

  /**
   * The acts a row offers, narrowed to what this caller may do.
   *
   * The register decides which acts exist from where the row is; the screen only
   * removes the ones this person cannot take. An author's own act (sending a
   * request, taking it back, pricing it) needs `workspace.manage`; a
   * determination on somebody else's figure needs `workspace.approve`.
   */
  const actsFor = (actions: readonly AgencyCommercialAction[]): AgencyCommercialAction[] =>
    actions.filter((act) => (act.determination ? canApprove : canManage));

  async function layOutSchedule() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = { base };
    if (base === "fixed_price" || base === "milestone") {
      if (depositPercent.trim()) body.depositPercent = Number(depositPercent.trim());
    }
    if (base === "milestone" && deliverables.trim()) body.deliverables = Number(deliverables.trim());
    if (base === "retainer" && periods.trim()) body.periods = Number(periods.trim());
    const { ok, data } = await api<{ commercial: AgencyCommercialSummary }>(
      `/api/agency/projects/${projectId}/commercial`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setLayingOut(false);
    setNotice(
      `برنامهٔ صورتحساب با ${n(data.commercial.milestones.length)} مرحله ایجاد شد. مرحله‌ها پیش‌نویس‌اند؛ هر کدام را پیش از ارسال بازبینی کنید.`,
    );
    await load();
  }

  async function createMilestone() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ milestone: AgencyMilestoneRecord }>(
      `/api/agency/projects/${projectId}/milestones`,
      {
        method: "POST",
        body: JSON.stringify({
          title: milestoneTitle.trim(),
          kind: milestoneKind,
          percent: milestonePercent.trim() ? Number(milestonePercent.trim()) : undefined,
          amountRial: milestoneAmount.trim() ? Number(milestoneAmount.trim()) : undefined,
          revenueCode: milestoneRevenue.trim() || undefined,
          dueDate: milestoneDue || undefined,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setAddingMilestone(false);
    setMilestoneTitle("");
    setMilestonePercent("");
    setMilestoneAmount("");
    setNotice(`مرحلهٔ ${data.milestone.milestoneNumber} به برنامه افزوده شد.`);
    await load();
  }

  async function createChangeRequest() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ changeRequest: AgencyChangeRequestRecord }>(
      `/api/agency/projects/${projectId}/change-requests`,
      {
        method: "POST",
        body: JSON.stringify({
          title: changeTitle.trim(),
          description: changeDescription.trim(),
          reason: changeReason.trim(),
          amountRial: changeAmount.trim() ? Number(changeAmount.trim()) : undefined,
          scheduleImpactDays: changeImpact.trim() ? Number(changeImpact.trim()) : undefined,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setAddingChange(false);
    setChangeTitle("");
    setChangeDescription("");
    setChangeReason("");
    setChangeAmount("");
    setChangeImpact("");
    setNotice(
      `درخواست تغییر ${data.changeRequest.changeRequestNumber} ثبت شد. تا وقتی کارفرما آن را نپذیرفته، ارزش قرارداد تغییری نمی‌کند.`,
    );
    await load();
  }

  async function milestoneAct(milestone: AgencyMilestoneRecord, action: string) {
    if (busy) return;
    // Issuing an invoice is a money movement, not a status change: say what it
    // will do before doing it. The screen asks; the server still decides whether
    // this caller may take a payment at all.
    if (action === "invoice") {
      const amount = milestone.billableAmountRial;
      const agreed = window.confirm(
        amount === null
          ? `صورتحساب مرحلهٔ ${milestone.milestoneNumber} صادر شود؟`
          : `صورتحساب مرحلهٔ ${milestone.milestoneNumber} به مبلغ ${rial(amount)} صادر شود؟ این فاکتور در دفتر کل ثبت و به حساب کارفرما منظور می‌شود.`,
      );
      if (!agreed) return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ milestone: AgencyMilestoneRecord }>(
      `/api/agency/milestones/${milestone.id}/status`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "invoice"
        ? `فاکتور ${data.milestone.invoiceNumber === null ? "" : `شمارهٔ ${n(data.milestone.invoiceNumber)}`} برای مرحلهٔ ${data.milestone.milestoneNumber} صادر شد. مبلغ اصلی قرارداد تغییر نمی‌کند.`
        : `مرحلهٔ ${data.milestone.milestoneNumber} — ${data.milestone.statusLabel}.`,
    );
    await load();
  }

  async function changeAct(changeRequest: AgencyChangeRequestRecord, action: string) {
    if (busy) return;
    // Agreeing a different figure than the one asked for is the commercial story
    // of a change request, so the screen asks and keeps both.
    let approvedAmountRial: string | undefined;
    if (action === "approve") {
      const figure = window.prompt(
        "مبلغ توافق‌شده با کارفرما (ریال) — می‌تواند با مبلغ درخواستی متفاوت باشد:",
        String(changeRequest.approvedAmountRial ?? changeRequest.amountRial ?? ""),
      );
      if (figure === null) return;
      if (!figure.trim()) {
        fail("change_request_amount_required");
        return;
      }
      approvedAmountRial = figure.trim();
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ changeRequest: AgencyChangeRequestRecord }>(
      `/api/agency/change-requests/${changeRequest.id}/status`,
      { method: "POST", body: JSON.stringify({ action, approvedAmountRial }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "approve"
        ? `درخواست تغییر ${data.changeRequest.changeRequestNumber} تأیید شد؛ ارزش اصلاح‌شدهٔ قرارداد با این مبلغ به‌روز می‌شود. مبلغی که کارفرما امضا کرده است تغییر نمی‌کند.`
        : `درخواست تغییر ${data.changeRequest.changeRequestNumber} — ${data.changeRequest.statusLabel}.`,
    );
    await load();
  }

  async function removeMilestone(milestone: AgencyMilestoneRecord) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/agency/milestones/${milestone.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(`مرحلهٔ ${milestone.milestoneNumber} حذف شد.`);
    await load();
  }

  async function removeChangeRequest(changeRequest: AgencyChangeRequestRecord) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/agency/change-requests/${changeRequest.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(`درخواست تغییر ${changeRequest.changeRequestNumber} حذف شد.`);
    await load();
  }

  const live = milestones.filter(
    (milestone) => milestone.status !== "cancelled" && milestone.status !== "rejected",
  );
  const baseDescription = lookups.bases.find((entry) => entry.base === base)?.description;

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}
      {error && payload ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard
          label="ارزش قرارداد"
          value={report.booked.contractedRial === null ? "—" : rial(report.booked.contractedRial)}
          hint="آنچه کارفرما امضا کرده است؛ با درخواست تغییر بازنویسی نمی‌شود"
        />
        <KpiCard
          label="تغییرات تأییدشده"
          value={report.booked.approvedChangeRial ? rial(report.booked.approvedChangeRial) : "—"}
          hint={`${n(changeRequests.length)} درخواست تغییر ثبت‌شده`}
        />
        <KpiCard
          label="ارزش اصلاح‌شده"
          value={report.booked.revisedContractRial === null ? "—" : rial(report.booked.revisedContractRial)}
          hint="مبنای درصد مرحله‌های بعدی"
        />
        <KpiCard
          label="صورتحساب‌شده"
          value={report.booked.invoicedRial ? rial(report.booked.invoicedRial) : "—"}
          hint="خالص فاکتورهای صادرشدهٔ این پروژه"
        />
      </KpiRow>

      {/* §D's project P&L, with its two halves kept apart on screen because they
          are two different kinds of fact: one is a plan, the other is the ledger. */}
      <SectionCard
        title="سود و زیان پروژه"
        description={
          engagement.customerName
            ? `کارفرما: ${engagement.customerName}${engagement.title ? ` — ${engagement.title}` : ""}`
            : "هنوز قراردادی به این پروژه نسبت داده نشده است."
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border/70 p-3">
            <p className="text-xs font-semibold">پیش‌بینی — از برنامهٔ صورتحساب</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              آنچه انتظار می‌رود صورتحساب شود. این ارقام سند حسابداری نیستند.
            </p>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <Figure label="ارزش اصلاح‌شدهٔ قرارداد" value={dash(report.booked.revisedContractRial)} />
              <Figure
                label="برنامه‌ریزی‌شده"
                value={rial(report.booked.scheduledRial)}
                hint={`${n(schedule.count)} مرحلهٔ فعال`}
              />
              <Figure label="صورتحساب‌شده" value={rial(report.booked.invoicedRial)} />
              <Figure
                label="برنامه‌ریزی‌نشده"
                value={dash(report.booked.unscheduledRial)}
                hint="بخشی از ارزش قرارداد که هنوز مرحله‌ای برایش ساخته نشده"
              />
            </dl>
          </div>

          <div className="rounded-xl border border-border/70 p-3">
            <p className="text-xs font-semibold">قطعی — از دفتر کل</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              آنچه ثبت شده است. درآمد و هزینه از اسناد حسابداری خوانده می‌شود و اینجا نگهداری نمی‌شود.
            </p>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <Figure label="درآمد ثبت‌شده" value={dash(report.posted.revenueRial)} />
              <Figure
                label="دریافت‌شده"
                value={dash(report.posted.collectedRial)}
                hint="آنچه در لحظهٔ صدور فاکتور تسویه شده است"
              />
              <Figure
                label="دریافتنی از کارفرما"
                value={dash(report.posted.receivableRial)}
                hint="فاکتورهای نسیهٔ این پروژه"
              />
              <Figure
                label="هزینهٔ واقعی"
                value={dash(report.posted.actualCostRial)}
                hint="از اسناد هزینه‌ای که با بُعد این پروژه ثبت شده‌اند"
              />
            </dl>
            <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
              <Figure
                label="حاشیهٔ ناویژه"
                value={
                  report.grossMarginRial === null
                    ? "—"
                    : `${rial(report.grossMarginRial)}${
                        report.grossMarginPercent === null
                          ? ""
                          : ` (${n(report.grossMarginPercent)}٪)`
                      }`
                }
                hint="تنها از ارقام ثبت‌شده در دفتر کل؛ از برنامهٔ صورتحساب محاسبه نمی‌شود"
              />
              {report.grossMarginRial === null ? (
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  تا وقتی درآمد و هزینهٔ ثبت‌شده هر دو در دفتر کل نباشند، حاشیه «—» می‌ماند؛ صفر
                  گزارش نمی‌شود، چون صفر خودش یک ادعاست.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* The schedule. */}
      <SectionCard
        title="برنامهٔ صورتحساب"
        description={
          live.length === 0
            ? "مرحله‌های صورتحساب این پروژه — پیش‌پرداخت، تحویل‌شدنی‌ها، دورهٔ رتینر یا تسویهٔ پایانی."
            : `درصد تخصیص‌یافته: ${n(100 - schedule.unallocatedPercent)}٪ — باقی‌ماندهٔ بی‌مرحله: ${n(schedule.unallocatedPercent)}٪`
        }
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              {milestones.length === 0 ? (
                <SecondaryButton onClick={() => setLayingOut((open) => !open)}>
                  <FileSignatureIcon className="size-3.5" aria-hidden />
                  چیدن برنامه از نوع قرارداد
                </SecondaryButton>
              ) : null}
              <SecondaryButton onClick={() => setAddingMilestone((open) => !open)}>
                <ReceiptIcon className="size-3.5" aria-hidden />
                افزودن مرحله
              </SecondaryButton>
            </div>
          ) : null
        }
      >
        {layingOut ? (
          <div className="mb-4 rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="نوع قرارداد" hint={baseDescription} as="div">
                <div className="flex flex-col gap-1" role="radiogroup" aria-label="نوع قرارداد">
                  {lookups.bases.map((entry) => (
                    <label key={entry.base} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="agency-billing-base"
                        value={entry.base}
                        checked={base === entry.base}
                        onChange={() => setBase(entry.base)}
                      />
                      {entry.label}
                    </label>
                  ))}
                </div>
              </Field>
              {base === "fixed_price" || base === "milestone" ? (
                <Field label="پیش‌پرداخت (درصد)" hint="خالی یعنی بدون پیش‌پرداخت">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={depositPercent}
                    onChange={(event) => setDepositPercent(event.target.value)}
                  />
                </Field>
              ) : null}
              {base === "milestone" ? (
                <Field label="تعداد تحویل‌شدنی‌ها">
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={deliverables}
                    onChange={(event) => setDeliverables(event.target.value)}
                  />
                </Field>
              ) : null}
              {base === "retainer" ? (
                <Field label="تعداد دوره‌ها" hint="هر دوره یک مرحلهٔ پیش‌نویس">
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={periods}
                    onChange={(event) => setPeriods(event.target.value)}
                  />
                </Field>
              ) : null}
            </div>
            {base === "hourly" ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                برای کار ساعتی برنامه‌ای چیده نمی‌شود: هر دوره وقتی صورتحساب می‌شود که ساعات و هزینهٔ
                همان دوره معلوم باشد. مرحله‌های آن دوره را با «افزودن مرحله» ثبت کنید.
              </p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <PrimaryButton disabled={busy} onClick={() => void layOutSchedule()}>
                چیدن برنامه
              </PrimaryButton>
              <SecondaryButton onClick={() => setLayingOut(false)}>انصراف</SecondaryButton>
            </div>
          </div>
        ) : null}

        {addingMilestone ? (
          <div className="mb-4 rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="عنوان مرحله">
                <input
                  className={inputClass}
                  value={milestoneTitle}
                  onChange={(event) => setMilestoneTitle(event.target.value)}
                />
              </Field>
              <Field label="نوع" as="div">
                <select
                  className={inputClass}
                  value={milestoneKind}
                  onChange={(event) => setMilestoneKind(event.target.value as AgencyMilestoneKind)}
                >
                  {lookups.kinds.map((entry) => (
                    <option key={entry.kind} value={entry.kind}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="حساب درآمد" as="div">
                <select
                  className={inputClass}
                  value={milestoneRevenue}
                  onChange={(event) => setMilestoneRevenue(event.target.value)}
                >
                  <option value="">پیش‌فرض ({revenueLabel(lookups.revenueAccounts[0]?.code ?? "")})</option>
                  {lookups.revenueAccounts.map((account) => (
                    <option key={account.code} value={account.code}>
                      {n(account.code)} — {account.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="درصد"
                hint={
                  engagement.revisedRial === null
                    ? "بدون ارزش قرارداد، درصد مبنایی ندارد"
                    : `از ارزش اصلاح‌شده: ${rial(engagement.revisedRial)}`
                }
              >
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={milestonePercent}
                  onChange={(event) => setMilestonePercent(event.target.value)}
                />
              </Field>
              <Field label="مبلغ ثابت (ریال)" hint="درصد یا مبلغ — نه هر دو">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={milestoneAmount}
                  onChange={(event) => setMilestoneAmount(event.target.value)}
                />
              </Field>
              <DateField label="سررسید" value={milestoneDue} onChange={setMilestoneDue} />
            </div>
            <div className="mt-3 flex gap-2">
              <PrimaryButton
                disabled={busy || !milestoneTitle.trim()}
                onClick={() => void createMilestone()}
              >
                افزودن مرحله
              </PrimaryButton>
              <SecondaryButton onClick={() => setAddingMilestone(false)}>انصراف</SecondaryButton>
            </div>
          </div>
        ) : null}

        {milestones.length === 0 && !layingOut ? (
          <EmptyState
            icon={ReceiptIcon}
            title="برنامهٔ صورتحسابی چیده نشده است"
            action={
              canManage ? (
                <SecondaryButton onClick={() => setLayingOut(true)}>
                  چیدن برنامه از نوع قرارداد
                </SecondaryButton>
              ) : undefined
            }
          >
            مرحله‌ها از نوع قرارداد چیده می‌شوند یا یکی‌یکی افزوده می‌شوند. هر مرحله پیش‌نویس است و
            تا ارسال و تأیید نشده، فاکتوری صادر نمی‌شود.
          </EmptyState>
        ) : null}

        {milestones.length > 0 ? (
          <DataTable caption={`مرحله‌های صورتحساب — ${n(milestones.length)} مورد`} tableClassName="min-w-[64rem]">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>عنوان</Th>
                <Th>نوع</Th>
                <Th>درصد / مبلغ</Th>
                <Th>قابل صورتحساب</Th>
                <Th>صورتحساب‌شده</Th>
                <Th>حساب درآمد</Th>
                <Th>سررسید</Th>
                <Th>وضعیت</Th>
                <Th>کارها</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {milestones.map((milestone) => (
                <DataTableRow key={milestone.id}>
                  <Td className="whitespace-nowrap tabular-nums">{n(milestone.milestoneNumber)}</Td>
                  <Td>
                    {milestone.title}
                    {milestone.periodStartDate && milestone.periodEndDate ? (
                      <span className="block text-[11px] text-muted-foreground">
                        دوره: {milestone.periodStartDate} تا {milestone.periodEndDate}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{kindLabel(milestone.kind)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {milestone.percent === null
                      ? milestone.amountRial === null
                        ? "—"
                        : rial(milestone.amountRial)
                      : `${n(milestone.percent)}٪`}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">{dash(milestone.billableAmountRial)}</Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {milestone.billedAmountRial === null ? "—" : rial(milestone.billedAmountRial)}
                    {milestone.invoiceNumber === null ? null : (
                      <span className="block text-[11px] text-muted-foreground">
                        فاکتور {n(milestone.invoiceNumber)}
                      </span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{milestone.revenueLabel}</Td>
                  <Td className="whitespace-nowrap">
                    <DateCell date={milestone.dueDate} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <StatusBadge tone={MILESTONE_TONES[milestone.status]}>
                      {milestone.statusLabel}
                    </StatusBadge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {actsFor(milestone.actions).map((act) => (
                        <SecondaryButton
                          key={act.action}
                          disabled={busy}
                          onClick={() => void milestoneAct(milestone, act.action)}
                        >
                          {act.label}
                        </SecondaryButton>
                      ))}
                      {milestone.status === "draft" && canManage ? (
                        <SecondaryButton disabled={busy} onClick={() => void removeMilestone(milestone)}>
                          حذف
                        </SecondaryButton>
                      ) : null}
                    </div>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        ) : null}

        {schedule.unallocatedPercent > 0 && live.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {n(schedule.unallocatedPercent)}٪ از ارزش قرارداد هنوز مرحله‌ای ندارد.
          </p>
        ) : null}
      </SectionCard>

      {/* Change requests. */}
      <SectionCard
        title="درخواست‌های تغییر"
        description="آنچه پس از توافق اولیه عوض شده است. تنها درخواستی که کارفرما پذیرفته باشد ارزش اصلاح‌شدهٔ قرارداد را جابه‌جا می‌کند؛ مبلغی که امضا شده است هرگز بازنویسی نمی‌شود."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setAddingChange((open) => !open)}>
              <FileSignatureIcon className="size-3.5" aria-hidden />
              ثبت درخواست تغییر
            </SecondaryButton>
          ) : null
        }
      >
        {addingChange ? (
          <div className="mb-4 rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="عنوان">
                <input
                  className={inputClass}
                  value={changeTitle}
                  onChange={(event) => setChangeTitle(event.target.value)}
                />
              </Field>
              <Field
                label="مبلغ (ریال)"
                hint="کاهش دامنه را منفی ثبت کنید؛ مبلغ صفر پذیرفته نمی‌شود"
              >
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={changeAmount}
                  onChange={(event) => setChangeAmount(event.target.value)}
                />
              </Field>
              <Field label="شرح تغییر" hint="پیش از ارسال به کارفرما لازم است">
                <textarea
                  className={inputClass}
                  rows={2}
                  value={changeDescription}
                  onChange={(event) => setChangeDescription(event.target.value)}
                />
              </Field>
              <Field label="دلیل تغییر">
                <textarea
                  className={inputClass}
                  rows={2}
                  value={changeReason}
                  onChange={(event) => setChangeReason(event.target.value)}
                />
              </Field>
              <Field label="اثر زمانی (روز)" hint="پیش از ارسال به کارفرما لازم است">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={changeImpact}
                  onChange={(event) => setChangeImpact(event.target.value)}
                />
              </Field>
            </div>
            <div className="mt-3 flex gap-2">
              <PrimaryButton
                disabled={busy || !changeTitle.trim()}
                onClick={() => void createChangeRequest()}
              >
                ثبت درخواست
              </PrimaryButton>
              <SecondaryButton onClick={() => setAddingChange(false)}>انصراف</SecondaryButton>
            </div>
          </div>
        ) : null}

        {changeRequests.length === 0 ? (
          <EmptyState icon={FileSignatureIcon} title="درخواست تغییری ثبت نشده است">
            وقتی دامنهٔ کار عوض می‌شود، درخواست تغییر ثبت کنید تا اثر مالی و زمانی آن پیش از انجام
            کار روشن باشد.
          </EmptyState>
        ) : (
          <DataTable caption={`درخواست‌های تغییر — ${n(changeRequests.length)} مورد`} tableClassName="min-w-[56rem]">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>عنوان</Th>
                <Th>مبلغ درخواستی</Th>
                <Th>مبلغ توافق‌شده</Th>
                <Th>اثر زمانی</Th>
                <Th>وضعیت</Th>
                <Th>کارها</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {changeRequests.map((changeRequest) => (
                <DataTableRow key={changeRequest.id}>
                  <Td className="whitespace-nowrap tabular-nums">
                    {n(changeRequest.changeRequestNumber)}
                  </Td>
                  <Td>
                    {changeRequest.title}
                    {changeRequest.countedInValue ? (
                      <span className="block text-[11px] text-muted-foreground">
                        در ارزش اصلاح‌شدهٔ قرارداد منظور شده است
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {dash(changeRequest.amountRial)}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {dash(changeRequest.approvedAmountRial)}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {changeRequest.scheduleImpactDays === null
                      ? "—"
                      : `${n(changeRequest.scheduleImpactDays)} روز`}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <StatusBadge tone={CHANGE_REQUEST_TONES[changeRequest.status]}>
                      {changeRequest.statusLabel}
                    </StatusBadge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {actsFor(changeRequest.actions).map((act) => (
                        <SecondaryButton
                          key={act.action}
                          disabled={busy}
                          onClick={() => void changeAct(changeRequest, act.action)}
                        >
                          {act.label}
                        </SecondaryButton>
                      ))}
                      {changeRequest.status === "draft" && canManage ? (
                        <SecondaryButton
                          disabled={busy}
                          onClick={() => void removeChangeRequest(changeRequest)}
                        >
                          حذف
                        </SecondaryButton>
                      ) : null}
                    </div>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
