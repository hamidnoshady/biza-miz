"use client";

/**
 * Issue #799 §16 on screen — «صورت‌وضعیت و پرداخت»: the periodic claim, both
 * directions of it.
 *
 * §16 asks for two things in one register — a **contractor's payment
 * application** (we did the work, we claim for it) and a **client/employer
 * progress certificate** (we certify what the contractor is owed). They share
 * every field, differ only in who owes whom, and this screen therefore has one
 * form with a `kind` in it rather than two tabs that would drift apart.
 *
 * ## What the screen shows and what it refuses to show
 *
 *   * **§16's arithmetic, in the order the issue lists it.** Gross amount, then
 *     what is withheld from it — advance recovery, retention, other deductions,
 *     tax — and the net that is claimed. The panel computes the same expression
 *     `certificateTotals` and migration 0200's CHECK enforce, so the preview and
 *     the stored row cannot disagree; the net is never typed.
 *   * **Previous certified and current certified, side by side.** §16 names
 *     both, and a running total that is derived on read (from the contract's
 *     earlier certified claims) cannot go stale the way a stored one does.
 *   * **Certified is not collected.** The certificate records what was
 *     *certified*; receipts, payments, A/R and A/P live in Accounting, and the
 *     screen says so rather than subtracting a paid figure it does not have.
 *     That is §16's boundary, and the reason the panel prints "مبلغ تأییدشده"
 *     and never "دریافت‌شده".
 *   * **The measurement lines are the claim.** With lines, they must add up to
 *     the gross amount — the service checks it, migration 0200 checks it again,
 *     and the form shows the running total so the mismatch is visible before the
 *     button is pressed.
 *   * **Frozen means frozen.** Once a claim is submitted its figures stop being
 *     editable; the way to correct it is «بازگشت به پیش‌نویس».
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BanknoteIcon,
  CheckCircle2Icon,
  HistoryIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
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
  overlayPanelClass,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { toPersianDigits } from "@/lib/digits";
import {
  CERTIFICATE_ACTION_LABELS,
  CERTIFICATE_ACTION_TARGET,
  CERTIFICATE_KIND_LABELS,
  CERTIFICATE_KINDS,
  CERTIFICATE_STATUSES,
  CERTIFICATE_STATUS_LABELS,
  canTransitionCertificate,
  certificateTotals,
  type CertificateAction,
  type CertificateKind,
  type CertificateStatus,
} from "@/lib/aec-commercial";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, SelectField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface CertificateEvent {
  id: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

interface CertificateAttachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

interface CertificateLine {
  id: string;
  boqItemId: string | null;
  label: string;
  amountRial: number;
  progressPercent: number | null;
  position: number;
}

interface Certificate {
  id: string;
  projectId: string;
  contractId: string | null;
  contractTitle: string | null;
  certificateNumber: string;
  kind: CertificateKind;
  kindLabel: string;
  periodStart: string;
  periodEnd: string;
  progressPercent: number | null;
  grossRial: number;
  advanceRecoveryRial: number;
  retentionRial: number;
  otherDeductionsRial: number;
  taxRial: number;
  netRial: number;
  approvedAmountRial: number | null;
  status: CertificateStatus;
  statusLabel: string;
  submittedDate: string | null;
  certifiedDate: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  lineCount: number;
  attachmentCount: number;
  approvalId: string | null;
  approvalStatus: string | null;
  contractRevisedValueRial: number | null;
  previousCertifiedRial: number;
  currentCertifiedRial: number;
  contractOutstandingRial: number | null;
  isEditable: boolean;
  isOpen: boolean;
  isCertified: boolean;
}

interface CertificateDetail extends Certificate {
  lines: CertificateLine[];
  events: CertificateEvent[];
  attachments: CertificateAttachment[];
}

const STATUS_TONES: Record<CertificateStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  submitted: "active",
  under_review: "active",
  certified: "positive",
  rejected: "danger",
  cancelled: "neutral",
};

const ACTION_ORDER: readonly CertificateAction[] = [
  "submit",
  "review",
  "certify",
  "reject",
  "cancel",
  "reopen",
];

function actionsFor(status: CertificateStatus): CertificateAction[] {
  return ACTION_ORDER.filter((action) =>
    canTransitionCertificate(status, CERTIFICATE_ACTION_TARGET[action]),
  );
}

/** §24: submitting and reopening a claim are the claimant's own work. */
const APPROVAL_ACTIONS = new Set<CertificateAction>(["review", "certify", "reject", "cancel"]);

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecCertificatesTab({
  projectId,
  canManage,
  canApprove,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  canApprove: boolean;
  lookups: WorkspaceLookups;
}) {
  const [certificates, setCertificates] = useState<Certificate[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CertificateDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Certificate | null>(null);
  const [statusFilter, setStatusFilter] = useState<CertificateStatus | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const money = useMoney();

  const fail = useCallback((code: string | undefined) => setError(workspaceError(code)), []);

  const load = useCallback(
    async (preferId?: string | null) => {
      const { ok, data } = await api<{ certificates: Certificate[] }>(
        `/api/aec/projects/${projectId}/certificates`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setCertificates([]);
        return null;
      }
      setCertificates(data.certificates);
      const next =
        data.certificates.find((row) => row.id === preferId) ?? data.certificates[0] ?? null;
      setSelectedId(next ? next.id : null);
      return next;
    },
    [projectId, fail],
  );

  const loadDetail = useCallback(
    async (certificateId: string) => {
      const { ok, data } = await api<{ certificate: CertificateDetail }>(
        `/api/aec/certificates/${certificateId}`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setDetail(null);
        return;
      }
      setDetail(data.certificate);
    },
    [fail],
  );

  const refresh = useCallback(
    async (preferId?: string | null) => {
      const next = await load(preferId);
      if (next) await loadDetail(next.id);
      else setDetail(null);
    },
    [load, loadDetail],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(
    () => (certificates ?? []).filter((row) => !statusFilter || row.status === statusFilter),
    [certificates, statusFilter],
  );

  const certifiedTotal = useMemo(
    () => (certificates ?? []).reduce((sum, row) => sum + row.currentCertifiedRial, 0),
    [certificates],
  );
  const pending = useMemo(
    () => (certificates ?? []).filter((row) => row.isOpen && row.status !== "draft").length,
    [certificates],
  );
  const retention = useMemo(
    () =>
      (certificates ?? [])
        .filter((row) => row.isCertified)
        .reduce((sum, row) => sum + row.retentionRial, 0),
    [certificates],
  );

  async function act(certificate: Certificate, action: CertificateAction) {
    if (busy) return;
    let approvedAmountRial: string | undefined;
    if (action === "certify") {
      const figure = window.prompt(
        "مبلغ تأییدشدهٔ این صورت‌وضعیت (ریال) — خالی بگذارید تا کل مبلغ خالص تأیید شود:",
        certificate.approvedAmountRial === null ? "" : String(certificate.approvedAmountRial),
      );
      if (figure === null) return;
      approvedAmountRial = figure.trim() || undefined;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ certificate: Certificate }>(
      `/api/aec/certificates/${certificate.id}/status`,
      { method: "POST", body: JSON.stringify({ action, approvedAmountRial }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "certify"
        ? `صورت‌وضعیت ${data.certificate.certificateNumber} تأیید شد. این مبلغ «گواهی‌شده» است؛ وصول آن در حسابداری ثبت می‌شود.`
        : `صورت‌وضعیت ${data.certificate.certificateNumber} — ${CERTIFICATE_ACTION_LABELS[action]}.`,
    );
    await refresh(data.certificate.id);
  }

  async function remove(certificate: Certificate) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/certificates/${certificate.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("صورت‌وضعیت پیش‌نویس حذف شد.");
    await refresh(null);
  }

  if (!certificates) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="صورت‌وضعیت‌ها" value="—" />
          <KpiCard label="در انتظار تأیید" value="—" />
          <KpiCard label="گواهی‌شده" value="—" />
          <KpiCard label="حسن انجام کار" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const n = (value: number | string) => toPersianDigits(String(value));

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      <KpiRow>
        <KpiCard label="صورت‌وضعیت‌ها" value={n(certificates.length)} hint="در این پروژه" />
        <KpiCard
          label="در انتظار تأیید"
          value={n(pending)}
          hint={pending > 0 ? "ارسال‌شده یا در حال بررسی" : "چیزی در انتظار تأیید نیست"}
        />
        <KpiCard
          label="گواهی‌شده"
          value={certifiedTotal ? money.format(certifiedTotal) : "—"}
          hint="مجموع مبالغ تأییدشده"
        />
        <KpiCard
          label="حسن انجام کار"
          value={retention ? money.format(retention) : "—"}
          hint="نگه‌داشته‌شده روی صورت‌وضعیت‌های تأییدشده"
        />
      </KpiRow>

      <SectionCard
        title="صورت‌وضعیت‌ها و گواهی‌های پیشرفت"
        description="مبلغ خالص از کار انجام‌شده منهای کسورات محاسبه می‌شود و در سرور بازمحاسبه می‌گردد. تا پیش‌نویس است قابل اصلاح است؛ پس از ارسال، ارقام ثابت می‌مانند و برای اصلاح باید به پیش‌نویس برگردد."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreating((open) => !open)}>
              <PlusIcon className="size-4" aria-hidden />
              صورت‌وضعیت جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {creating ? (
          <CertificateForm
            projectId={projectId}
            lookups={lookups}
            onClose={() => setCreating(false)}
            onError={fail}
            onSaved={async (certificateId) => {
              setCreating(false);
              setNotice("صورت‌وضعیت ثبت شد؛ با «ارسال برای تأیید» آن را به جریان تأیید بفرستید.");
              await refresh(certificateId);
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <div className="w-full sm:w-48">
            <SelectField
              label="وضعیت"
              value={statusFilter}
              onChange={(next) => setStatusFilter(next as CertificateStatus | "")}
              options={CERTIFICATE_STATUSES}
              labels={CERTIFICATE_STATUS_LABELS}
              includeAll
              allLabel="همه"
            />
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={BanknoteIcon} title="صورت‌وضعیتی ثبت نشده است">
            {certificates.length === 0
              ? "صورت‌وضعیت‌های پیمانکار و گواهی‌های کارفرما/مشاور اینجا ثبت، اندازه‌گیری و تأیید می‌شوند."
              : "با این فیلتر صورت‌وضعیتی پیدا نشد."}
          </EmptyState>
        ) : (
          <DataTable caption={`صورت‌وضعیت‌ها — ${n(rows.length)} مورد`} tableClassName="min-w-[64rem]">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>نوع</Th>
                <Th>دوره</Th>
                <Th>وضعیت</Th>
                <Th>ناخالص</Th>
                <Th>کسورات</Th>
                <Th>خالص</Th>
                <Th>تأییدشده</Th>
                <Th>تأییدشدهٔ قبلی</Th>
                <Th> </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow
                  key={row.id}
                  className={row.id === selectedId ? "bg-muted/50" : undefined}
                >
                  <Td className="whitespace-nowrap font-medium">{row.certificateNumber}</Td>
                  <Td className="whitespace-nowrap text-xs">{row.kindLabel}</Td>
                  <Td className="whitespace-nowrap text-xs">
                    {row.periodStart} — {row.periodEnd}
                  </Td>
                  <Td>
                    <StatusBadge tone={STATUS_TONES[row.status]}>{row.statusLabel}</StatusBadge>
                  </Td>
                  <Td className="whitespace-nowrap">{money.format(row.grossRial)}</Td>
                  <Td className="whitespace-nowrap">
                    {money.format(
                      row.advanceRecoveryRial +
                        row.retentionRial +
                        row.otherDeductionsRial +
                        row.taxRial,
                    )}
                  </Td>
                  <Td className="whitespace-nowrap font-medium">{money.format(row.netRial)}</Td>
                  <Td className="whitespace-nowrap">
                    {row.isCertified
                      ? money.format(row.approvedAmountRial ?? row.netRial)
                      : row.approvedAmountRial === null
                        ? "—"
                        : money.format(row.approvedAmountRial)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {row.previousCertifiedRial ? money.format(row.previousCertifiedRial) : "—"}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <SecondaryButton
                        onClick={() => {
                          setSelectedId(row.id);
                          void loadDetail(row.id);
                        }}
                      >
                        <span className="text-xs">جزئیات</span>
                      </SecondaryButton>
                      {canManage && row.status === "draft" ? (
                        <>
                          <SecondaryButton onClick={() => setEditing(row)}>
                            <PencilIcon className="size-3.5" aria-hidden />
                            <span className="sr-only">ویرایش</span>
                          </SecondaryButton>
                          <SecondaryButton onClick={() => void remove(row)}>
                            <Trash2Icon className="size-3.5" aria-hidden />
                            <span className="sr-only">حذف</span>
                          </SecondaryButton>
                        </>
                      ) : null}
                    </div>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {editing ? (
        <CertificateForm
          projectId={projectId}
          certificate={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async (certificateId) => {
            setEditing(null);
            setNotice("صورت‌وضعیت به‌روزرسانی شد.");
            await refresh(certificateId);
          }}
        />
      ) : null}

      {detail ? (
        <SectionCard
          title={`صورت‌وضعیت ${detail.certificateNumber}`}
          description={`${detail.kindLabel} — دورهٔ ${detail.periodStart} تا ${detail.periodEnd}`}
          actions={
            <div className="flex flex-wrap items-center gap-1">
              {actionsFor(detail.status).map((action) => {
                const needsApproval = APPROVAL_ACTIONS.has(action);
                if (needsApproval ? !canApprove : !canManage) return null;
                return (
                  <SecondaryButton
                    key={action}
                    disabled={busy}
                    onClick={() => void act(detail, action)}
                  >
                    {CERTIFICATE_ACTION_LABELS[action]}
                  </SecondaryButton>
                );
              })}
            </div>
          }
        >
          <div className="flex flex-col gap-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">وضعیت</dt>
                <dd className="mt-0.5">
                  <StatusBadge tone={STATUS_TONES[detail.status]}>{detail.statusLabel}</StatusBadge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">قرارداد</dt>
                <dd className="mt-0.5">{detail.contractTitle || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">پیشرفت فیزیکی</dt>
                <dd className="mt-0.5">
                  {detail.progressPercent === null ? "—" : `${n(detail.progressPercent)}٪`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">مبلغ ناخالص</dt>
                <dd className="mt-0.5">{money.format(detail.grossRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">بازیافت پیش‌پرداخت</dt>
                <dd className="mt-0.5">{money.format(detail.advanceRecoveryRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">حسن انجام کار</dt>
                <dd className="mt-0.5">{money.format(detail.retentionRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">سایر کسورات</dt>
                <dd className="mt-0.5">{money.format(detail.otherDeductionsRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">مالیات</dt>
                <dd className="mt-0.5">{money.format(detail.taxRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">مبلغ خالص (این دوره)</dt>
                <dd className="mt-0.5 font-medium">{money.format(detail.netRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تأییدشدهٔ قبلی</dt>
                <dd className="mt-0.5">{money.format(detail.previousCertifiedRial)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تأییدشدهٔ این دوره</dt>
                <dd className="mt-0.5">
                  {detail.isCertified
                    ? money.format(detail.approvedAmountRial ?? detail.netRial)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">ماندهٔ قرارداد</dt>
                <dd className="mt-0.5">
                  {detail.contractOutstandingRial === null
                    ? "—"
                    : money.format(detail.contractOutstandingRial)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تاریخ ارسال</dt>
                <dd className="mt-0.5">
                  <DateCell date={detail.submittedDate} relative={false} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تاریخ تأیید</dt>
                <dd className="mt-0.5">
                  <DateCell date={detail.certifiedDate} relative={false} />
                </dd>
              </div>
            </dl>

            <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-xs">
              مبلغ تأییدشده یعنی آنچه گواهی شده است، نه آنچه وصول شده. دریافتی‌ها، پرداختی‌ها،
              حساب‌های دریافتنی و پرداختنی در حسابداری ثبت و خوانده می‌شوند و اینجا تکرار نمی‌شوند.
            </p>

            <div>
              <p className="text-xs text-muted-foreground">ردیف‌های اندازه‌گیری</p>
              {detail.lines.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  این صورت‌وضعیت ردیف اندازه‌گیری ندارد؛ مبلغ ناخالص دستی ثبت شده است.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border/80 text-sm">
                  {detail.lines.map((line) => (
                    <li key={line.id} className="flex flex-wrap items-center gap-2 py-1.5">
                      <span className="min-w-0 flex-1">{line.label}</span>
                      {line.progressPercent === null ? null : (
                        <span className="text-xs text-muted-foreground">
                          {n(line.progressPercent)}٪
                        </span>
                      )}
                      <span className="whitespace-nowrap">{money.format(line.amountRial)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs text-muted-foreground">پیوست‌ها</p>
              {detail.attachments.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  پیوستی ندارد؛ برگه‌های اندازه‌گیری از «کتابخانهٔ رسانه» وصل می‌شوند.
                </p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {detail.attachments.map((attachment) => (
                    <li key={attachment.documentId}>
                      <a
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs underline-offset-2 hover:underline"
                        href={mediaFileUrl(attachment.documentId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <PaperclipIcon className="size-3" aria-hidden />
                        {attachment.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <HistoryIcon className="size-3.5" aria-hidden />
                گردش کار (تغییرناپذیر)
              </p>
              {detail.events.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">رویدادی ثبت نشده است.</p>
              ) : (
                <ol className="mt-2 flex flex-col gap-2">
                  {detail.events.map((event) => (
                    <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                      <span className="min-w-0 flex-1">{event.summary}</span>
                      <span className="text-xs text-muted-foreground">{event.actorName}</span>
                      <DateCell date={event.createdAt.slice(0, 10)} className="text-xs" />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Measure / edit
 * ------------------------------------------------------------------------- */

interface DraftLine {
  boqItemId: string;
  label: string;
  amountRial: string;
  progressPercent: string;
}

function CertificateForm({
  projectId,
  certificate,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  certificate?: Certificate;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: (certificateId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const money = useMoney();
  const [kind, setKind] = useState<CertificateKind>(certificate?.kind ?? "application");
  const [contractId, setContractId] = useState(certificate?.contractId ?? "");
  const [periodStart, setPeriodStart] = useState(certificate?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(certificate?.periodEnd ?? "");
  const [progressPercent, setProgressPercent] = useState(
    certificate?.progressPercent === null || certificate?.progressPercent === undefined
      ? ""
      : String(certificate.progressPercent),
  );
  const [grossRial, setGrossRial] = useState(certificate ? String(certificate.grossRial) : "");
  const [advanceRecoveryRial, setAdvanceRecoveryRial] = useState(
    certificate ? String(certificate.advanceRecoveryRial) : "",
  );
  const [retentionRial, setRetentionRial] = useState(
    certificate ? String(certificate.retentionRial) : "",
  );
  const [otherDeductionsRial, setOtherDeductionsRial] = useState(
    certificate ? String(certificate.otherDeductionsRial) : "",
  );
  const [taxRial, setTaxRial] = useState(certificate ? String(certificate.taxRial) : "");
  const [lines, setLines] = useState<DraftLine[]>(
    certificate
      ? []
      : [{ boqItemId: "", label: "", amountRial: "", progressPercent: "" }],
  );
  const [contracts, setContracts] = useState<Array<{ id: string; title: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ contracts: Array<{ id: string; title: string }> }>(
      `/api/workspace/contracts?projectId=${projectId}`,
    ).then(({ ok, data }) => {
      if (ok) setContracts(data.contracts);
    });
  }, [projectId]);

  // §16's arithmetic, previewed with the same pure function the service and
  // migration 0200's CHECK use — the net is never typed, only shown.
  const totals = useMemo(
    () =>
      certificateTotals({
        grossRial: Number(grossRial || 0),
        advanceRecoveryRial: Number(advanceRecoveryRial || 0),
        retentionRial: Number(retentionRial || 0),
        otherDeductionsRial: Number(otherDeductionsRial || 0),
        taxRial: Number(taxRial || 0),
      }),
    [grossRial, advanceRecoveryRial, retentionRial, otherDeductionsRial, taxRial],
  );
  const measured = useMemo(
    () => lines.reduce((sum, line) => sum + Number(line.amountRial || 0), 0),
    [lines],
  );

  async function submit() {
    if (!periodStart || !periodEnd || saving) return;
    setSaving(true);
    const body = {
      kind,
      contractId: contractId || null,
      periodStart,
      periodEnd,
      progressPercent: progressPercent || null,
      grossRial: grossRial || "0",
      advanceRecoveryRial: advanceRecoveryRial || "0",
      retentionRial: retentionRial || "0",
      otherDeductionsRial: otherDeductionsRial || "0",
      taxRial: taxRial || "0",
      lines: lines
        .filter((line) => line.label.trim() && line.amountRial)
        .map((line) => ({
          label: line.label,
          amountRial: line.amountRial,
          boqItemId: line.boqItemId || null,
          progressPercent: line.progressPercent || null,
        })),
    };
    const { ok, data } = certificate
      ? await api<{ certificate: Certificate }>(`/api/aec/certificates/${certificate.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ certificate: Certificate }>(`/api/aec/projects/${projectId}/certificates`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.certificate.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-3xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {certificate
              ? `ویرایش صورت‌وضعیت ${certificate.certificateNumber}`
              : "ثبت صورت‌وضعیت / گواهی پیشرفت"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <SelectField
            label="نوع"
            value={kind}
            onChange={(next) => setKind((next || "application") as CertificateKind)}
            options={CERTIFICATE_KINDS}
            labels={CERTIFICATE_KIND_LABELS}
          />
          <PickerField
            label="قرارداد"
            value={contractId}
            onChange={setContractId}
            options={contracts.map((contract) => ({ id: contract.id, label: contract.title }))}
            hint="«تأییدشدهٔ قبلی» و «ماندهٔ قرارداد» از همین قرارداد خوانده می‌شوند"
          />
          <DateField label="شروع دوره" value={periodStart} onChange={setPeriodStart} />
          <DateField label="پایان دوره" value={periodEnd} onChange={setPeriodEnd} />
          <Field label="پیشرفت فیزیکی (٪)" hint="اختیاری">
            <input
              className={inputClass}
              inputMode="decimal"
              value={progressPercent}
              onChange={(event) => setProgressPercent(event.target.value.replace(/[^\d.]/g, ""))}
            />
          </Field>
          <Field label="مبلغ کار انجام‌شده — ناخالص (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={grossRial}
              onChange={(event) => setGrossRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="بازیافت پیش‌پرداخت (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={advanceRecoveryRial}
              onChange={(event) => setAdvanceRecoveryRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="حسن انجام کار — کسر (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={retentionRial}
              onChange={(event) => setRetentionRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="سایر کسورات (ریال)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={otherDeductionsRial}
              onChange={(event) =>
                setOtherDeductionsRial(event.target.value.replace(/[^\d]/g, ""))
              }
            />
          </Field>
          <Field label="مالیات و عوارض (ریال)" hint="در صورت اعمال">
            <input
              className={inputClass}
              inputMode="numeric"
              value={taxRial}
              onChange={(event) => setTaxRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
        </div>

        <div className="border-t border-border/80 p-4">
          <p className="text-sm font-medium">ردیف‌های اندازه‌گیری (§16)</p>
          <p className="mt-1 text-xs text-muted-foreground">
            اگر ردیف ثبت کنید، جمع آن‌ها باید با مبلغ ناخالص برابر باشد؛ جمع فعلی:{" "}
            {money.format(measured)}
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {lines.map((line, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem_6rem_auto]">
                <input
                  className={inputClass}
                  placeholder="شرح ردیف (مثلاً: آرماتوربندی فونداسیون)"
                  value={line.label}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((row, i) =>
                        i === index ? { ...row, label: event.target.value } : row,
                      ),
                    )
                  }
                />
                <input
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="مبلغ (ریال)"
                  value={line.amountRial}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((row, i) =>
                        i === index
                          ? { ...row, amountRial: event.target.value.replace(/[^\d]/g, "") }
                          : row,
                      ),
                    )
                  }
                />
                <input
                  className={inputClass}
                  inputMode="decimal"
                  placeholder="٪"
                  value={line.progressPercent}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((row, i) =>
                        i === index
                          ? { ...row, progressPercent: event.target.value.replace(/[^\d.]/g, "") }
                          : row,
                      ),
                    )
                  }
                />
                <SecondaryButton
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2Icon className="size-4" aria-hidden />
                  <span className="sr-only">حذف ردیف</span>
                </SecondaryButton>
              </div>
            ))}
            <SecondaryButton
              onClick={() =>
                setLines((current) => [
                  ...current,
                  { boqItemId: "", label: "", amountRial: "", progressPercent: "" },
                ])
              }
            >
              <PlusIcon className="size-4" aria-hidden />
              افزودن ردیف
            </SecondaryButton>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 p-4">
          <p className="text-sm">
            کسورات: {money.format(totals.withheldRial)} — <span className="font-medium">مبلغ خالص: {money.format(totals.netRial)}</span>
          </p>
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
            <PrimaryButton
              disabled={saving || !periodStart || !periodEnd}
              onClick={() => void submit()}
            >
              <CheckCircle2Icon className="size-4" aria-hidden />
              {certificate ? "ذخیره" : "ثبت صورت‌وضعیت"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}
