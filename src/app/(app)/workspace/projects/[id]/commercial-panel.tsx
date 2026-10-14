"use client";

/**
 * Issue #799 §17 and §20 on screen — «مالی پروژه» and the contract's AEC block.
 *
 * The card sits in the «مالی» tab beside the finance card and the contracts
 * register, and it is §20's cockpit: one place that adds up what the workspace
 * knows about the money on a project.
 *
 * ## What this card is careful about
 *
 *   * **Every figure says who owns it.** The contract value, the approved
 *     variations, the revised value, the certified total, the retention, the
 *     advance and the remaining commitment are the workspace's own rows. Actual
 *     cost is Accounting's (`projectReport`), and it reads «—» rather than zero
 *     for an actor without `ledger.view` — a zero would be a claim, and a wrong
 *     one.
 *   * **The figures the books own are named, not copied.** Receipts, payments,
 *     A/R and A/P are listed as «در حسابداری» with a pointer, so the card never
 *     keeps a balance that can drift from the ledger (§16's boundary).
 *   * **The figures nobody owns yet are named too.** Committed cost, cost to
 *     complete, forecast final cost and the forecast margin need the procurement
 *     wave; the card says so instead of printing zeros, because a zero margin is
 *     a statement about money.
 *   * **§15's rule is visible where it matters.** An approved variation moves
 *     the *revised* value; the original stays what was signed. The card shows
 *     both, and the §17 form never offers the original or the revised figure as
 *     an editable field.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, FileSignatureIcon, PencilIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  overlayPanelClass,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { DateCell, DateField, PickerField, workspaceError } from "../../workspace-ui";
import type { WorkspaceLookups } from "../../use-workspace-lookups";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/projects/[id]/commercial`
 * ------------------------------------------------------------------------- */

interface ContractCommercial {
  contractId: string;
  contractTitle: string;
  contractType: string;
  contractStatus: string;
  projectId: string | null;
  projectName: string | null;
  partyName: string | null;
  originalValueRial: number | null;
  contractNumber: string;
  scope: string;
  revisedValueRial: number | null;
  advancePercent: number | null;
  advanceAmountRial: number | null;
  retentionPercent: number | null;
  paymentTerms: string;
  defectsLiabilityMonths: number | null;
  guaranteeType: string;
  guaranteeReference: string;
  guaranteeAmountRial: number | null;
  guaranteeExpiry: string | null;
  insuranceReference: string;
  insuranceExpiry: string | null;
  responsibleUserId: string | null;
  responsibleName: string;
  approvedVariationsRial: number;
  certifiedRial: number;
  remainingCommitmentRial: number | null;
  daysToGuaranteeExpiry: number | null;
  daysToInsuranceExpiry: number | null;
}

interface CommercialSummary {
  projectId: string;
  projectName: string;
  budgetRial: number | null;
  approvedEstimateRial: number | null;
  originalContractRial: number;
  approvedVariationsRial: number;
  revisedContractRial: number;
  variationCount: number;
  openVariationCount: number;
  certifiedRial: number;
  certificateCount: number;
  pendingCertificateCount: number;
  retentionReceivableRial: number;
  retentionPayableRial: number;
  advanceRial: number;
  advanceRecoveredRial: number;
  outstandingAdvanceRial: number;
  remainingCommitmentRial: number;
  actualCostRial: number | null;
  budgetVarianceRial: number | null;
  /** §18's commitments (Wave 9) — promised money, not posted cost. */
  committedRial: number;
  deliveredRial: number;
  delayedCommitmentCount: number;
  delayedCommitmentRial: number;
  /** §20's forecast, `null` when the ledger or the estimate is missing. */
  costToCompleteRial: number | null;
  forecastFinalCostRial: number | null;
  forecastMarginRial: number | null;
  forecastBasis: string;
  readInAccounting: string[];
  awaitingWaves: Array<{ label: string; reason: string }>;
}

interface Security {
  contractId: string;
  projectId: string | null;
  contractTitle: string;
  kind: "guarantee" | "insurance";
  reference: string;
  guaranteeExpiry: string;
  guaranteeAmountRial: number | null;
  daysRemaining: number;
}

interface CommercialPayload {
  summary: CommercialSummary;
  contracts: ContractCommercial[];
  securities: Security[];
}

export function AecCommercialCard({
  projectId,
  canManage,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  lookups: WorkspaceLookups;
}) {
  const [payload, setPayload] = useState<CommercialPayload | null>(null);
  const [editing, setEditing] = useState<ContractCommercial | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const money = useMoney();

  const fail = useCallback((code: string | undefined) => setError(workspaceError(code)), []);

  const load = useCallback(async () => {
    const { ok, data } = await api<CommercialPayload>(
      `/api/aec/projects/${projectId}/commercial`,
    );
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

  if (error && !payload) {
    // `financials` off is a switch, not a failure: the card says so quietly and
    // the tab keeps whatever else it has.
    return <ErrorBox>{error}</ErrorBox>;
  }
  if (!payload) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="ارزش قرارداد" value="—" />
          <KpiCard label="تغییرات تأییدشده" value="—" />
          <KpiCard label="ارزش اصلاح‌شده" value="—" />
          <KpiCard label="گواهی‌شده" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const { summary, contracts, securities } = payload;
  const n = (value: number | string) => toPersianDigits(String(value));
  const dash = (value: number | null) => (value === null ? "—" : money.format(value));

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      <KpiRow>
        <KpiCard
          label="مبلغ اصلی قرارداد"
          value={summary.originalContractRial ? money.format(summary.originalContractRial) : "—"}
          hint="آنچه امضا شده است؛ با تغییر بازنویسی نمی‌شود"
        />
        <KpiCard
          label="تغییرات تأییدشده"
          value={
            summary.approvedVariationsRial ? money.format(summary.approvedVariationsRial) : "—"
          }
          hint={`${n(summary.variationCount)} تغییر ثبت‌شده، ${n(summary.openVariationCount)} در جریان`}
        />
        <KpiCard
          label="ارزش اصلاح‌شدهٔ قرارداد"
          value={summary.revisedContractRial ? money.format(summary.revisedContractRial) : "—"}
          hint="مبلغ اصلی به‌علاوهٔ تغییرات تأییدشده"
        />
        <KpiCard
          label="صورت‌وضعیت گواهی‌شده"
          value={summary.certifiedRial ? money.format(summary.certifiedRial) : "—"}
          hint={`${n(summary.certificateCount)} صورت‌وضعیت، ${n(summary.pendingCertificateCount)} در انتظار`}
        />
      </KpiRow>

      <SectionCard
        title="چشم‌انداز تجاری پروژه"
        description="ارقام میز کار از قراردادها، تغییرات و صورت‌وضعیت‌ها می‌آید؛ ارقام حسابداری از اسناد خوانده می‌شود و اینجا تکرار نمی‌شود."
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="بودجهٔ پروژه" value={dash(summary.budgetRial)} />
          <Figure label="برآورد تأییدشده" value={dash(summary.approvedEstimateRial)} />
          <Figure
            label="ماندهٔ قرارداد"
            value={summary.remainingCommitmentRial ? money.format(summary.remainingCommitmentRial) : "—"}
            hint="ارزش اصلاح‌شده منهای گواهی‌شده"
          />
          <Figure
            label="هزینهٔ واقعی (حسابداری)"
            value={dash(summary.actualCostRial)}
            hint="از اسناد حسابداری؛ بدون دسترسی به دفتر کل «—»"
          />
          <Figure
            label="مغایرت بودجه"
            value={dash(summary.budgetVarianceRial)}
            hint="بودجه منهای هزینهٔ واقعی"
          />
          <Figure
            label="حسن انجام کار — دریافتنی"
            value={
              summary.retentionReceivableRial
                ? money.format(summary.retentionReceivableRial)
                : "—"
            }
          />
          <Figure
            label="حسن انجام کار — پرداختنی"
            value={
              summary.retentionPayableRial ? money.format(summary.retentionPayableRial) : "—"
            }
          />
          <Figure
            label="پیش‌پرداخت / بازیافت‌شده"
            value={
              summary.advanceRial
                ? `${money.format(summary.advanceRial)} / ${money.format(summary.advanceRecoveredRial)}`
                : "—"
            }
            hint={summary.outstandingAdvanceRial ? `مانده: ${money.format(summary.outstandingAdvanceRial)}` : undefined}
          />
        </dl>

        <div className="mt-4 rounded-xl border border-border/80 bg-muted/30 p-3">
          <p className="text-xs font-medium">پیش‌بینی هزینه و حاشیه (§۲۰)</p>
          <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <Figure
              label="تعهدشده (خرید و پیمان جزء)"
              value={summary.committedRial ? money.format(summary.committedRial) : "—"}
              hint={
                summary.delayedCommitmentCount > 0
                  ? `${n(summary.delayedCommitmentCount)} تعهد با تأخیر تحویل — ${money.format(summary.delayedCommitmentRial)}`
                  : "مبلغ تعهدشده، نه هزینهٔ ثبت‌شده"
              }
            />
            <Figure label="تحویل‌شده" value={summary.deliveredRial ? money.format(summary.deliveredRial) : "—"} />
            <Figure label="هزینه تا تکمیل" value={dash(summary.costToCompleteRial)} />
            <Figure label="هزینهٔ نهایی پیش‌بینی‌شده" value={dash(summary.forecastFinalCostRial)} />
            <Figure
              label="حاشیهٔ برآوردی"
              value={dash(summary.forecastMarginRial)}
              hint="ارزش اصلاح‌شده منهای هزینهٔ نهایی پیش‌بینی‌شده"
            />
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{summary.forecastBasis}</p>
          {summary.costToCompleteRial === null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              تا وقتی هزینهٔ ثبت‌شده در حسابداری و برآورد مصوب هر دو موجود نباشند، پیش‌بینی «—»
              می‌ماند؛ صفر گزارش نمی‌شود.
            </p>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border/80 bg-muted/30 p-3">
            <p className="text-xs font-medium">این ارقام در حسابداری است</p>
            <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
              {summary.readInAccounting.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </div>
          {summary.awaitingWaves.length > 0 ? (
            <div className="rounded-xl border border-border/80 bg-muted/30 p-3">
              <p className="text-xs font-medium">هنوز محاسبه نمی‌شود</p>
              <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                {summary.awaitingWaves.map((entry) => (
                  <li key={entry.label}>
                    <span className="text-foreground">{entry.label}:</span> {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="قراردادها و تعهدات (§17)"
        description="اطلاعات تجاری قراردادهای اجرایی: شماره و دامنه، پیش‌پرداخت و حسن انجام کار، شرایط پرداخت، دورهٔ تضمین، ضمانت‌نامه و بیمه‌نامه، و مدیر مسئول."
        flush
      >
        {contracts.length === 0 ? (
          <EmptyState icon={FileSignatureIcon} title="قراردادی به این پروژه وصل نیست">
            قراردادهای اجرایی از «مالی ← قراردادها» ثبت می‌شوند و اطلاعات تجاری آن‌ها اینجا تکمیل
            می‌گردد.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {contracts.map((contract) => (
              <li key={contract.contractId} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{contract.contractTitle}</span>
                  {contract.contractNumber ? (
                    <span className="text-xs text-muted-foreground">{contract.contractNumber}</span>
                  ) : null}
                  <StatusBadge tone={contract.contractStatus === "active" ? "positive" : "neutral"}>
                    {contract.contractStatus}
                  </StatusBadge>
                  {contract.partyName ? (
                    <span className="text-xs text-muted-foreground">{contract.partyName}</span>
                  ) : null}
                  {canManage ? (
                    <span className="ms-auto">
                      <SecondaryButton onClick={() => setEditing(contract)}>
                        <PencilIcon className="size-3.5" aria-hidden />
                        <span className="text-xs">اطلاعات تجاری</span>
                      </SecondaryButton>
                    </span>
                  ) : null}
                </div>
                <dl className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
                  <Figure label="مبلغ اصلی" value={dash(contract.originalValueRial)} />
                  <Figure label="ارزش اصلاح‌شده" value={dash(contract.revisedValueRial)} />
                  <Figure
                    label="تغییرات تأییدشده"
                    value={contract.approvedVariationsRial ? money.format(contract.approvedVariationsRial) : "—"}
                  />
                  <Figure
                    label="گواهی‌شده"
                    value={contract.certifiedRial ? money.format(contract.certifiedRial) : "—"}
                  />
                  <Figure
                    label="پیش‌پرداخت"
                    value={
                      contract.advancePercent === null && contract.advanceAmountRial === null
                        ? "—"
                        : `${contract.advancePercent === null ? "" : `${n(contract.advancePercent)}٪`}${
                            contract.advanceAmountRial === null
                              ? ""
                              : ` ${money.format(contract.advanceAmountRial)}`
                          }`.trim()
                    }
                  />
                  <Figure
                    label="حسن انجام کار"
                    value={contract.retentionPercent === null ? "—" : `${n(contract.retentionPercent)}٪`}
                  />
                  <Figure
                    label="دورهٔ تضمین"
                    value={
                      contract.defectsLiabilityMonths === null
                        ? "—"
                        : `${n(contract.defectsLiabilityMonths)} ماه`
                    }
                  />
                  <Figure label="مدیر مسئول" value={contract.responsibleName || "—"} />
                  <Figure
                    label="ضمانت‌نامه"
                    value={
                      contract.guaranteeExpiry ? (
                        <span>
                          {contract.guaranteeType || "—"}
                          {contract.guaranteeReference ? ` — ${contract.guaranteeReference}` : ""} —{" "}
                          <DateCell date={contract.guaranteeExpiry} relative={false} />
                        </span>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <Figure
                    label="بیمه‌نامه"
                    value={
                      contract.insuranceExpiry ? (
                        <span>
                          {contract.insuranceReference || "—"} —{" "}
                          <DateCell date={contract.insuranceExpiry} relative={false} />
                        </span>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <Figure label="شرایط پرداخت" value={contract.paymentTerms || "—"} />
                  <Figure label="ماندهٔ قرارداد" value={dash(contract.remainingCommitmentRial)} />
                </dl>
                {contract.scope ? (
                  <p className="text-xs text-muted-foreground">{contract.scope}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {securities.length > 0 ? (
        <SectionCard
          title="ضمانت‌نامه‌ها و بیمه‌نامه‌های نزدیک به انقضا"
          description="تا ۹۰ روز آینده — همین موارد در §29 به‌صورت یادآور هم فرستاده می‌شوند."
          flush
        >
          <ul className="divide-y divide-border/80">
            {securities.map((security, index) => (
              <li
                key={`${security.contractId}-${security.kind}-${index}`}
                className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm"
              >
                <ShieldAlertIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
                <span className="min-w-0 flex-1">
                  {security.kind === "insurance" ? "بیمه‌نامه" : "ضمانت‌نامه"} —{" "}
                  {security.contractTitle}
                  {security.reference ? ` (${security.reference})` : ""}
                </span>
                {security.guaranteeAmountRial ? (
                  <span className="text-xs">{money.format(security.guaranteeAmountRial)}</span>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  <DateCell date={security.guaranteeExpiry} relative={false} /> —{" "}
                  {security.daysRemaining < 0
                    ? `${n(Math.abs(security.daysRemaining))} روز گذشته`
                    : `${n(security.daysRemaining)} روز مانده`}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {editing ? (
        <ContractCommercialForm
          contract={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async () => {
            setEditing(null);
            setNotice("اطلاعات تجاری قرارداد ذخیره شد.");
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * §17 — the contract's commercial block
 * ------------------------------------------------------------------------- */

function ContractCommercialForm({
  contract,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  contract: ContractCommercial;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [contractNumber, setContractNumber] = useState(contract.contractNumber);
  const [scope, setScope] = useState(contract.scope);
  const [advancePercent, setAdvancePercent] = useState(
    contract.advancePercent === null ? "" : String(contract.advancePercent),
  );
  const [advanceAmountRial, setAdvanceAmountRial] = useState(
    contract.advanceAmountRial === null ? "" : String(contract.advanceAmountRial),
  );
  const [retentionPercent, setRetentionPercent] = useState(
    contract.retentionPercent === null ? "" : String(contract.retentionPercent),
  );
  const [paymentTerms, setPaymentTerms] = useState(contract.paymentTerms);
  const [defectsLiabilityMonths, setDefectsLiabilityMonths] = useState(
    contract.defectsLiabilityMonths === null ? "" : String(contract.defectsLiabilityMonths),
  );
  const [guaranteeType, setGuaranteeType] = useState(contract.guaranteeType);
  const [guaranteeReference, setGuaranteeReference] = useState(contract.guaranteeReference);
  const [guaranteeAmountRial, setGuaranteeAmountRial] = useState(
    contract.guaranteeAmountRial === null ? "" : String(contract.guaranteeAmountRial),
  );
  const [guaranteeExpiry, setGuaranteeExpiry] = useState(contract.guaranteeExpiry ?? "");
  const [insuranceReference, setInsuranceReference] = useState(contract.insuranceReference);
  const [insuranceExpiry, setInsuranceExpiry] = useState(contract.insuranceExpiry ?? "");
  const [responsibleUserId, setResponsibleUserId] = useState(contract.responsibleUserId ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const { ok, data } = await api(`/api/aec/contracts/${contract.contractId}/commercial`, {
      method: "PUT",
      body: JSON.stringify({
        contractNumber,
        scope,
        advancePercent: advancePercent || null,
        advanceAmountRial: advanceAmountRial || null,
        retentionPercent: retentionPercent || null,
        paymentTerms,
        defectsLiabilityMonths: defectsLiabilityMonths || null,
        guaranteeType,
        guaranteeReference,
        guaranteeAmountRial: guaranteeAmountRial || null,
        guaranteeExpiry: guaranteeExpiry || null,
        insuranceReference,
        insuranceExpiry: insuranceExpiry || null,
        responsibleUserId: responsibleUserId || null,
      }),
    });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">اطلاعات تجاری «{contract.contractTitle}»</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="شمارهٔ قرارداد">
            <input
              className={inputClass}
              value={contractNumber}
              onChange={(event) => setContractNumber(event.target.value)}
            />
          </Field>
          <PickerField
            label="مدیر مسئول قرارداد"
            value={responsibleUserId}
            onChange={setResponsibleUserId}
            options={lookups.members.map((member) => ({ id: member.id, label: member.fullName }))}
            hint="برای نمایش؛ نقش سازمانی دسترسی ایجاد نمی‌کند"
          />
          <div className="sm:col-span-2">
            <Field label="دامنهٔ کار" hint="اختیاری">
              <textarea
                className={inputClass}
                rows={2}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              />
            </Field>
          </div>
          <Field label="درصد پیش‌پرداخت">
            <input
              className={inputClass}
              inputMode="decimal"
              value={advancePercent}
              onChange={(event) => setAdvancePercent(event.target.value.replace(/[^\d.]/g, ""))}
            />
          </Field>
          <Field label="مبلغ پیش‌پرداخت (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={advanceAmountRial}
              onChange={(event) => setAdvanceAmountRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="درصد حسن انجام کار">
            <input
              className={inputClass}
              inputMode="decimal"
              value={retentionPercent}
              onChange={(event) => setRetentionPercent(event.target.value.replace(/[^\d.]/g, ""))}
            />
          </Field>
          <Field label="دورهٔ تضمین (ماه)" hint="پس از تحویل">
            <input
              className={inputClass}
              inputMode="numeric"
              value={defectsLiabilityMonths}
              onChange={(event) =>
                setDefectsLiabilityMonths(event.target.value.replace(/[^\d]/g, ""))
              }
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="شرایط پرداخت" hint="مثلاً: صورت‌وضعیت ماهانه، پرداخت ۳۰ روز پس از تأیید">
              <textarea
                className={inputClass}
                rows={2}
                value={paymentTerms}
                onChange={(event) => setPaymentTerms(event.target.value)}
              />
            </Field>
          </div>
          <Field label="نوع ضمانت‌نامه">
            <input
              className={inputClass}
              value={guaranteeType}
              onChange={(event) => setGuaranteeType(event.target.value)}
            />
          </Field>
          <Field label="شمارهٔ ضمانت‌نامه">
            <input
              className={inputClass}
              value={guaranteeReference}
              onChange={(event) => setGuaranteeReference(event.target.value)}
            />
          </Field>
          <Field label="مبلغ ضمانت‌نامه (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={guaranteeAmountRial}
              onChange={(event) => setGuaranteeAmountRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <DateField label="انقضای ضمانت‌نامه" value={guaranteeExpiry} onChange={setGuaranteeExpiry} />
          <Field label="مرجع بیمه‌نامه">
            <input
              className={inputClass}
              value={insuranceReference}
              onChange={(event) => setInsuranceReference(event.target.value)}
            />
          </Field>
          <DateField label="انقضای بیمه‌نامه" value={insuranceExpiry} onChange={setInsuranceExpiry} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/80 p-4">
          <p className="text-xs text-muted-foreground">
            ارزش اصلاح‌شدهٔ قرارداد اینجا قابل ویرایش نیست؛ از مبلغ اصلی به‌علاوهٔ تغییرات تأییدشده
            محاسبه می‌شود.
          </p>
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
            <PrimaryButton disabled={saving} onClick={() => void submit()}>
              <CheckCircle2Icon className="size-4" aria-hidden />
              ذخیره
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}
