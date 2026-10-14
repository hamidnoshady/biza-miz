"use client";

/**
 * Issue #799 §18 on screen — «تأمین و خرید»: the procurement tab.
 *
 * §18's flow is one chain, so the tab is one page with three registers in the
 * order the chain runs:
 *
 *   1. **درخواست کالا** — what the site says it needs, with its priority, the
 *      date it is needed by and its lines;
 *   2. **استعلام بها (RFQ)** — the tenders raised from those requests, the
 *      suppliers invited, the offers that came back, and the comparison sheet
 *      that ranks them (cheapest first, because that is the number a buyer
 *      looks for — the note beside it says the cheapest offer is not
 *      automatically the award);
 *   3. **تعهد — سفارش خرید و پیمان جزء** — the awards, their values, the
 *      expected delivery, the deliveries that arrived and the delay warning.
 *
 * ## What the screen is careful about
 *
 *   * **§18's chains are the buttons.** Each status offers exactly the moves the
 *     pure catalogue allows (`canTransition*` + the action target), so no
 *     dropdown can pick an illegal move and then fail in the service.
 *   * **Two people, two keys.** Preparing a request, a tender, an offer or a
 *     draft award is `workspace.manage`; granting the request, obliging the
 *     business to an award and withdrawing an approved one are
 *     `workspace.approve` (§24). The panel simply does not render the second set
 *     of buttons without the key.
 *   * **A late award says so.** The delay warning is the same predicate the
 *     service, the assistant tool and the §29 reminder use
 *     (`isCommitmentDelayed`), so the badge, the chat answer and the nudge
 *     cannot disagree.
 *   * **Nothing here is an invoice.** A commitment is money *promised*; the
 *     screen says so wherever a figure could be read as posted cost, because
 *     §18 keeps Accounting as the source of truth for what was actually spent.
 *   * **Dates are Shamsi on screen and Gregorian in the database** — `DateField`
 *     and `DateCell` are the shared Jalali pair, like every other tab.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2Icon,
  ClipboardListIcon,
  HistoryIcon,
  PlusIcon,
  Trash2Icon,
  TruckIcon,
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
import { toPersianDigits } from "@/lib/digits";
import {
  COMMITMENT_ACTIONS,
  COMMITMENT_ACTION_LABELS,
  COMMITMENT_ACTION_TARGET,
  COMMITMENT_KINDS,
  COMMITMENT_KIND_LABELS,
  COMMITMENT_STATUSES,
  COMMITMENT_STATUS_LABELS,
  MATERIAL_REQUEST_ACTIONS,
  MATERIAL_REQUEST_ACTION_LABELS,
  MATERIAL_REQUEST_ACTION_TARGET,
  MATERIAL_REQUEST_PRIORITIES,
  MATERIAL_REQUEST_PRIORITY_LABELS,
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_REQUEST_STATUS_LABELS,
  QUOTATION_ACTIONS,
  QUOTATION_ACTION_LABELS,
  QUOTATION_ACTION_TARGET,
  QUOTATION_STATUS_LABELS,
  RFQ_ACTIONS,
  RFQ_ACTION_LABELS,
  RFQ_ACTION_TARGET,
  RFQ_STATUSES,
  RFQ_STATUS_LABELS,
  canTransitionCommitment,
  canTransitionMaterialRequest,
  canTransitionQuotation,
  canTransitionRfq,
  commitmentActionNeedsApproval,
  materialRequestActionNeedsApproval,
  type CommitmentAction,
  type CommitmentKind,
  type CommitmentStatus,
  type MaterialRequestAction,
  type MaterialRequestPriority,
  type MaterialRequestStatus,
  type QuotationAction,
  type QuotationStatus,
  type RfqAction,
  type RfqStatus,
} from "@/lib/aec-procurement";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import {
  DateCell,
  DateField,
  PickerField,
  SelectField,
  workspaceError,
} from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface ProcurementEvent {
  id: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

interface RequestLine {
  id: string;
  boqItemId: string | null;
  boqItemLabel: string | null;
  description: string;
  unit: string;
  quantity: number;
  position: number;
}

interface MaterialRequest {
  id: string;
  requestNumber: string;
  title: string;
  workPackage: string;
  description: string;
  priority: MaterialRequestPriority;
  priorityLabel: string;
  requiredBy: string | null;
  status: MaterialRequestStatus;
  statusLabel: string;
  lineCount: number;
  rfqCount: number;
  daysToRequiredBy: number | null;
  createdByName: string;
  isEditable: boolean;
  isOpen: boolean;
}

interface MaterialRequestDetail extends MaterialRequest {
  lines: RequestLine[];
  events: ProcurementEvent[];
}

interface Quotation {
  id: string;
  rfqId: string;
  partyId: string;
  supplierName: string;
  amountRial: number;
  leadDays: number | null;
  validityDate: string | null;
  note: string;
  status: QuotationStatus;
  statusLabel: string;
  receivedDate: string;
  createdByName: string;
}

interface RfqSupplier {
  partyId: string;
  name: string;
  note: string;
  quoted: boolean;
}

interface Rfq {
  id: string;
  requestId: string | null;
  requestNumber: string | null;
  rfqNumber: string;
  title: string;
  scope: string;
  status: RfqStatus;
  statusLabel: string;
  dueDate: string | null;
  responseDue: string | null;
  supplierCount: number;
  quotationCount: number;
  lowestAmountRial: number | null;
  bestLeadDays: number | null;
  commitmentCount: number;
  isEditable: boolean;
  isOpen: boolean;
}

interface RfqDetail extends Rfq {
  suppliers: RfqSupplier[];
  quotations: Quotation[];
  events: ProcurementEvent[];
}

interface Delivery {
  id: string;
  deliveredOn: string;
  note: string;
  receivedByName: string;
  createdAt: string;
}

interface Commitment {
  id: string;
  kind: CommitmentKind;
  kindLabel: string;
  commitmentNumber: string;
  supplierPartyId: string;
  supplierName: string;
  requestId: string | null;
  requestNumber: string | null;
  rfqId: string | null;
  rfqNumber: string | null;
  quotationId: string | null;
  contractId: string | null;
  contractTitle: string | null;
  title: string;
  workPackage: string;
  valueRial: number;
  expectedDeliveryDate: string | null;
  delayDays: number | null;
  isDelayed: boolean;
  status: CommitmentStatus;
  statusLabel: string;
  deliveryCount: number;
  createdByName: string;
  isCommitted: boolean;
  isEditable: boolean;
  isOpen: boolean;
}

interface CommitmentDetail extends Commitment {
  deliveries: Delivery[];
  events: ProcurementEvent[];
}

interface ProcurementSummary {
  openRequestCount: number;
  pendingRequestCount: number;
  issuedRfqCount: number;
  quotationCount: number;
  committedRial: number;
  deliveredRial: number;
  delayedCount: number;
  delayedRial: number;
  openCommitmentCount: number;
}

interface ProcurementPayload {
  summary: ProcurementSummary;
  requests: MaterialRequest[];
  rfqs: Rfq[];
  commitments: Commitment[];
  delays: Array<{ id: string; delayDays: number }>;
  pending: MaterialRequest[];
}

const REQUEST_TONES: Record<MaterialRequestStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  submitted: "active",
  approved: "positive",
  rejected: "danger",
  closed: "neutral",
  cancelled: "neutral",
};

const RFQ_TONES: Record<RfqStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  issued: "active",
  closed: "positive",
  cancelled: "neutral",
};

const QUOTATION_TONES: Record<QuotationStatus, "neutral" | "active" | "positive" | "danger"> = {
  received: "active",
  shortlisted: "active",
  selected: "positive",
  declined: "neutral",
};

const COMMITMENT_TONES: Record<CommitmentStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  submitted: "active",
  approved: "positive",
  rejected: "danger",
  delivered: "positive",
  closed: "neutral",
  cancelled: "neutral",
};

/** The moves a status offers, derived from the catalogue rather than hand-listed. */
function requestActionsFor(status: MaterialRequestStatus): MaterialRequestAction[] {
  return MATERIAL_REQUEST_ACTIONS.filter((action) =>
    canTransitionMaterialRequest(status, MATERIAL_REQUEST_ACTION_TARGET[action]),
  );
}

function rfqActionsFor(status: RfqStatus): RfqAction[] {
  return RFQ_ACTIONS.filter((action) => canTransitionRfq(status, RFQ_ACTION_TARGET[action]));
}

function quotationActionsFor(status: QuotationStatus): QuotationAction[] {
  return QUOTATION_ACTIONS.filter((action) =>
    canTransitionQuotation(status, QUOTATION_ACTION_TARGET[action]),
  );
}

function commitmentActionsFor(status: CommitmentStatus): CommitmentAction[] {
  return COMMITMENT_ACTIONS.filter((action) =>
    canTransitionCommitment(status, COMMITMENT_ACTION_TARGET[action]),
  );
}

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecProcurementTab({
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
  const [data, setData] = useState<ProcurementPayload | null>(null);
  const [requestDetail, setRequestDetail] = useState<MaterialRequestDetail | null>(null);
  const [rfqDetail, setRfqDetail] = useState<RfqDetail | null>(null);
  const [commitmentDetail, setCommitmentDetail] = useState<CommitmentDetail | null>(null);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingRfq, setCreatingRfq] = useState(false);
  const [quotationFor, setQuotationFor] = useState<Rfq | null>(null);
  const [awardingFrom, setAwardingFrom] = useState<{ rfq: Rfq; quotation: Quotation } | null>(null);
  const [creatingCommitment, setCreatingCommitment] = useState(false);
  const [delivering, setDelivering] = useState<Commitment | null>(null);
  const [requestFilter, setRequestFilter] = useState<MaterialRequestStatus | "">("");
  const [commitmentFilter, setCommitmentFilter] = useState<CommitmentStatus | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const money = useMoney();

  const fail = useCallback((code: string | undefined) => setError(workspaceError(code)), []);

  const load = useCallback(async () => {
    const { ok, data: payload } = await api<ProcurementPayload>(
      `/api/aec/projects/${projectId}/procurement`,
    );
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      setData(null);
      return;
    }
    setData(payload);
  }, [projectId, fail]);

  const loadRequest = useCallback(
    async (requestId: string) => {
      const { ok, data: payload } = await api<{ materialRequest: MaterialRequestDetail }>(
        `/api/aec/requests/${requestId}`,
      );
      setRequestDetail(ok ? payload.materialRequest : null);
    },
    [],
  );

  const loadRfq = useCallback(async (rfqId: string) => {
    const { ok, data: payload } = await api<{ rfq: RfqDetail }>(`/api/aec/rfqs/${rfqId}`);
    setRfqDetail(ok ? payload.rfq : null);
  }, []);

  const loadCommitment = useCallback(async (commitmentId: string) => {
    const { ok, data: payload } = await api<{ commitment: CommitmentDetail }>(
      `/api/aec/commitments/${commitmentId}`,
    );
    setCommitmentDetail(ok ? payload.commitment : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const requests = useMemo(
    () => (data?.requests ?? []).filter((row) => !requestFilter || row.status === requestFilter),
    [data, requestFilter],
  );
  const commitments = useMemo(
    () =>
      (data?.commitments ?? []).filter((row) => !commitmentFilter || row.status === commitmentFilter),
    [data, commitmentFilter],
  );

  async function act(kind: "request" | "rfq" | "commitment", id: string, action: string, body = {}) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const base =
      kind === "request"
        ? `/api/aec/requests/${id}/status`
        : kind === "rfq"
          ? `/api/aec/rfqs/${id}/status`
          : `/api/aec/commitments/${id}/status`;
    const { ok, data: payload } = await api<Record<string, never>>(base, {
      method: "POST",
      body: JSON.stringify({ action, ...body }),
    });
    setBusy(false);
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      return;
    }
    setNotice("انجام شد.");
    await load();
    if (kind === "request" && requestDetail?.id === id) await loadRequest(id);
    if (kind === "rfq" && rfqDetail?.id === id) await loadRfq(id);
    if (kind === "commitment" && commitmentDetail?.id === id) await loadCommitment(id);
  }

  async function quotationAct(quotation: Quotation, action: QuotationAction) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data: payload } = await api(`/api/aec/quotations/${quotation.id}/status`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      return;
    }
    if (rfqDetail) await loadRfq(rfqDetail.id);
    await load();
  }

  async function removeDelivery(delivery: Delivery) {
    if (busy || !commitmentDetail) return;
    setBusy(true);
    setError("");
    const { ok, data: payload } = await api(`/api/aec/deliveries/${delivery.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      return;
    }
    setNotice("ردیف تحویل حذف شد.");
    await loadCommitment(commitmentDetail.id);
    await load();
  }

  async function removeRequest(row: MaterialRequest) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data: payload } = await api(`/api/aec/requests/${row.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      return;
    }
    setNotice("درخواست پیش‌نویس حذف شد.");
    setRequestDetail(null);
    await load();
  }

  async function removeRfq(row: Rfq) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data: payload } = await api(`/api/aec/rfqs/${row.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      return;
    }
    setNotice("استعلام پیش‌نویس حذف شد.");
    setRfqDetail(null);
    await load();
  }

  async function removeCommitment(row: Commitment) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data: payload } = await api(`/api/aec/commitments/${row.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!ok) {
      fail((payload as unknown as { error?: string }).error);
      return;
    }
    setNotice("تعهد پیش‌نویس حذف شد.");
    setCommitmentDetail(null);
    await load();
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="درخواست‌های باز" value="—" />
          <KpiCard label="استعلام در جریان" value="—" />
          <KpiCard label="تعهدشده" value="—" />
          <KpiCard label="تأخیر تحویل" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const n = (value: number | string) => toPersianDigits(String(value));
  const { summary } = data;

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      <KpiRow>
        <KpiCard
          label="درخواست‌های باز"
          value={n(summary.openRequestCount)}
          hint={
            summary.pendingRequestCount > 0
              ? `${n(summary.pendingRequestCount)} در انتظار تأیید`
              : "چیزی در انتظار تأیید نیست"
          }
        />
        <KpiCard
          label="استعلام در جریان"
          value={n(summary.issuedRfqCount)}
          hint={`${n(summary.quotationCount)} پیشنهاد ثبت‌شده`}
        />
        <KpiCard
          label="تعهدشده"
          value={summary.committedRial ? money.format(summary.committedRial) : "—"}
          hint="سفارش خرید و پیمان جزء تأییدشده — نه هزینهٔ ثبت‌شده در حسابداری"
        />
        <KpiCard
          label="تأخیر تحویل"
          value={summary.delayedCount ? n(summary.delayedCount) : "—"}
          hint={
            summary.delayedCount
              ? `مجموع مبلغ ${money.format(summary.delayedRial)}`
              : "هیچ تحویلی از موعد نگذشته است"
          }
        />
      </KpiRow>

      {/* ------------------------------------------------ material requests */}
      <SectionCard
        title="درخواست کالا"
        description="آنچه کارگاه نیاز دارد. تا وقتی پیش‌نویس است قابل ویرایش است؛ با «ارسال» برای تأیید می‌رود و از آن لحظه محتوایش ثابت می‌ماند."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreatingRequest(true)}>
              <PlusIcon className="size-4" aria-hidden />
              درخواست جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <SelectField<MaterialRequestStatus>
            label="وضعیت"
            value={requestFilter}
            onChange={(next) => setRequestFilter(next)}
            options={MATERIAL_REQUEST_STATUSES}
            labels={MATERIAL_REQUEST_STATUS_LABELS}
            includeAll
          />
        </div>
        {requests.length === 0 ? (
          <EmptyState icon={ClipboardListIcon} title="درخواستی ثبت نشده است">
            هر خرید با یک درخواست شروع می‌شود: چه کالایی، برای چه کاری، تا چه تاریخی.
          </EmptyState>
        ) : (
          <DataTable caption="درخواست‌های کالا">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>عنوان</Th>
                <Th>اولویت</Th>
                <Th>مورد نیاز تا</Th>
                <Th>وضعیت</Th>
                <Th>اقدام</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {requests.map((row) => (
                <DataTableRow key={row.id}>
                  <Td>
                    <button
                      type="button"
                      className="text-sm underline-offset-4 hover:underline"
                      onClick={() => void loadRequest(row.id)}
                    >
                      {row.requestNumber}
                    </button>
                  </Td>
                  <Td>
                    <span className="text-sm">{row.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {n(row.lineCount)} ردیف
                      {row.rfqCount ? ` — ${n(row.rfqCount)} استعلام` : ""}
                    </span>
                  </Td>
                  <Td>{row.priorityLabel}</Td>
                  <Td>
                    {row.requiredBy ? <DateCell date={row.requiredBy} /> : "—"}
                    {row.daysToRequiredBy !== null && row.daysToRequiredBy < 0 ? (
                      <span className="block text-xs text-destructive">
                        {n(Math.abs(row.daysToRequiredBy))} روز گذشته
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge tone={REQUEST_TONES[row.status]}>{row.statusLabel}</StatusBadge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {requestActionsFor(row.status).map((action) => {
                        const needsApproval = materialRequestActionNeedsApproval(action);
                        if (needsApproval ? !canApprove : !canManage) return null;
                        return (
                          <SecondaryButton
                            key={action}
                            disabled={busy}
                            onClick={() => void act("request", row.id, action)}
                          >
                            {MATERIAL_REQUEST_ACTION_LABELS[action]}
                          </SecondaryButton>
                        );
                      })}
                      {canManage && row.isEditable ? (
                        <>
                          <SecondaryButton
                            disabled={busy}
                            onClick={() => {
                              setEditingId(row.id);
                              void loadRequest(row.id);
                            }}
                          >
                            ویرایش
                          </SecondaryButton>
                          <SecondaryButton disabled={busy} onClick={() => void removeRequest(row)}>
                            <Trash2Icon className="size-4" aria-hidden />
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

      {/* ------------------------------------------------------------- RFQs */}
      <SectionCard
        title="استعلام بها (RFQ)"
        description="از چند تأمین‌کننده قیمت خواسته می‌شود. تا پیش‌نویس است قابل ویرایش است؛ با «ارسال» فهرست دعوت‌شدگان و متن استعلام ثابت می‌شود، چون تأمین‌کنندگان دارند همان را قیمت می‌زنند."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreatingRfq(true)}>
              <PlusIcon className="size-4" aria-hidden />
              استعلام جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {data.rfqs.length === 0 ? (
          <EmptyState icon={ClipboardListIcon} title="استعلامی ثبت نشده است">
            استعلام می‌تواند به یک درخواست کالا وصل باشد یا مستقل باشد — هر دو در همین دفتر می‌آیند.
          </EmptyState>
        ) : (
          <DataTable caption="استعلام‌های بها">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>عنوان</Th>
                <Th>تأمین‌کنندگان</Th>
                <Th>کمترین پیشنهاد</Th>
                <Th>وضعیت</Th>
                <Th>اقدام</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {data.rfqs.map((row) => (
                <DataTableRow key={row.id}>
                  <Td>
                    <button
                      type="button"
                      className="text-sm underline-offset-4 hover:underline"
                      onClick={() => void loadRfq(row.id)}
                    >
                      {row.rfqNumber}
                    </button>
                  </Td>
                  <Td>
                    <span className="text-sm">{row.title}</span>
                    {row.requestNumber ? (
                      <span className="block text-xs text-muted-foreground">
                        از درخواست {row.requestNumber}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {n(row.supplierCount)} دعوت‌شده
                    <span className="block text-xs text-muted-foreground">
                      {n(row.quotationCount)} پیشنهاد
                    </span>
                  </Td>
                  <Td>
                    {row.lowestAmountRial === null ? "—" : money.format(row.lowestAmountRial)}
                    {row.bestLeadDays !== null ? (
                      <span className="block text-xs text-muted-foreground">
                        کمترین زمان تحویل: {n(row.bestLeadDays)} روز
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge tone={RFQ_TONES[row.status]}>{row.statusLabel}</StatusBadge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {rfqActionsFor(row.status).map((action) => (
                        <SecondaryButton
                          key={action}
                          disabled={busy || !canManage}
                          onClick={() => void act("rfq", row.id, action)}
                        >
                          {RFQ_ACTION_LABELS[action]}
                        </SecondaryButton>
                      ))}
                      {canManage && row.isOpen ? (
                        <SecondaryButton
                          disabled={busy}
                          onClick={() => setQuotationFor(row)}
                        >
                          ثبت پیشنهاد
                        </SecondaryButton>
                      ) : null}
                      {canManage && row.isEditable ? (
                        <SecondaryButton disabled={busy} onClick={() => void removeRfq(row)}>
                          <Trash2Icon className="size-4" aria-hidden />
                          <span className="sr-only">حذف</span>
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

      {/* ------------------------------------------------------ commitments */}
      <SectionCard
        title="تعهد — سفارش خرید و پیمان جزء"
        description="تعهد یعنی مبلغی که به تأمین‌کننده یا پیمان جزء وعده داده شده است. تا پیش‌نویس قابل ویرایش است؛ با ارسال برای تأیید می‌رود و پس از تأیید در «هزینهٔ تعهدشده» پروژه شمرده می‌شود. فاکتور و پرداخت در حسابداری ثبت می‌شوند."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreatingCommitment(true)}>
              <PlusIcon className="size-4" aria-hidden />
              تعهد جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <SelectField<CommitmentStatus>
            label="وضعیت"
            value={commitmentFilter}
            onChange={(next) => setCommitmentFilter(next)}
            options={COMMITMENT_STATUSES}
            labels={COMMITMENT_STATUS_LABELS}
            includeAll
          />
        </div>
        {commitments.length === 0 ? (
          <EmptyState icon={ClipboardListIcon} title="تعهدی ثبت نشده است">
            سفارش خرید یا پیمان جزء را ثبت کنید تا مبلغ آن در هزینهٔ تعهدشدهٔ پروژه دیده شود.
          </EmptyState>
        ) : (
          <DataTable caption="سفارش‌های خرید و پیمان‌های جزء">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>عنوان</Th>
                <Th>تأمین‌کننده</Th>
                <Th>مبلغ</Th>
                <Th>تحویل مورد انتظار</Th>
                <Th>وضعیت</Th>
                <Th>اقدام</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {commitments.map((row) => (
                <DataTableRow key={row.id}>
                  <Td>
                    <button
                      type="button"
                      className="text-sm underline-offset-4 hover:underline"
                      onClick={() => void loadCommitment(row.id)}
                    >
                      {row.commitmentNumber}
                    </button>
                  </Td>
                  <Td>
                    <span className="text-sm">{row.title}</span>
                    <span className="block text-xs text-muted-foreground">{row.kindLabel}</span>
                  </Td>
                  <Td>{row.supplierName}</Td>
                  <Td>{money.format(row.valueRial)}</Td>
                  <Td>
                    {row.expectedDeliveryDate ? (
                      <DateCell date={row.expectedDeliveryDate} />
                    ) : (
                      "—"
                    )}
                    {row.isDelayed && row.delayDays ? (
                      <span className="block text-xs text-destructive">
                        {n(row.delayDays)} روز تأخیر
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge tone={COMMITMENT_TONES[row.status]}>
                      {row.statusLabel}
                    </StatusBadge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {commitmentActionsFor(row.status).map((action) => {
                        const needsApproval = commitmentActionNeedsApproval(action);
                        if (needsApproval ? !canApprove : !canManage) return null;
                        return (
                          <SecondaryButton
                            key={action}
                            disabled={busy}
                            onClick={() => void act("commitment", row.id, action)}
                          >
                            {COMMITMENT_ACTION_LABELS[action]}
                          </SecondaryButton>
                        );
                      })}
                      {canManage && (row.status === "approved" || row.status === "delivered") ? (
                        <SecondaryButton disabled={busy} onClick={() => setDelivering(row)}>
                          <TruckIcon className="size-4" aria-hidden />
                          ثبت تحویل
                        </SecondaryButton>
                      ) : null}
                      {canManage && row.isEditable ? (
                        <SecondaryButton disabled={busy} onClick={() => void removeCommitment(row)}>
                          <Trash2Icon className="size-4" aria-hidden />
                          <span className="sr-only">حذف</span>
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

      {/* ------------------------------------------------------------ modals */}
      {creatingRequest || (editingId && requestDetail?.id === editingId) ? (
        <RequestForm
          projectId={projectId}
          request={editingId && requestDetail?.id === editingId ? requestDetail : undefined}
          lookups={lookups}
          onClose={() => {
            setCreatingRequest(false);
            setEditingId(null);
          }}
          onSaved={async (id) => {
            setCreatingRequest(false);
            setEditingId(null);
            setNotice("درخواست کالا ذخیره شد.");
            await load();
            await loadRequest(id);
          }}
          onError={fail}
        />
      ) : null}

      {creatingRfq ? (
        <RfqForm
          projectId={projectId}
          requests={data.requests.filter((row) => row.isOpen)}
          suppliers={lookups.parties}
          onClose={() => setCreatingRfq(false)}
          onSaved={async (id) => {
            setCreatingRfq(false);
            setNotice("استعلام ثبت شد.");
            await load();
            await loadRfq(id);
          }}
          onError={fail}
        />
      ) : null}

      {quotationFor ? (
        <QuotationForm
          rfq={quotationFor}
          suppliers={lookups.parties}
          onClose={() => setQuotationFor(null)}
          onSaved={async () => {
            setQuotationFor(null);
            setNotice("پیشنهاد تأمین‌کننده ثبت شد.");
            await load();
            if (rfqDetail) await loadRfq(rfqDetail.id);
          }}
          onError={fail}
        />
      ) : null}

      {creatingCommitment || awardingFrom ? (
        <CommitmentForm
          projectId={projectId}
          commitment={undefined}
          suppliers={lookups.parties}
          requests={data.requests}
          rfqs={data.rfqs}
          prefill={
            awardingFrom
              ? {
                  rfqId: awardingFrom.rfq.id,
                  quotationId: awardingFrom.quotation.id,
                  supplierPartyId: awardingFrom.quotation.partyId,
                  valueRial: String(awardingFrom.quotation.amountRial),
                  title: `${awardingFrom.rfq.title} — ${awardingFrom.quotation.supplierName}`,
                  requestId: awardingFrom.rfq.requestId ?? "",
                }
              : undefined
          }
          onClose={() => {
            setCreatingCommitment(false);
            setAwardingFrom(null);
          }}
          onSaved={async (id) => {
            setCreatingCommitment(false);
            setAwardingFrom(null);
            setNotice("تعهد ثبت شد. با «ارسال برای تأیید» به صف تأیید می‌رود.");
            await load();
            if (rfqDetail) await loadRfq(rfqDetail.id);
            await loadCommitment(id);
          }}
          onError={fail}
        />
      ) : null}

      {delivering ? (
        <DeliveryForm
          commitment={delivering}
          onClose={() => setDelivering(null)}
          onSaved={async (id) => {
            setDelivering(null);
            setNotice("تحویل ثبت شد.");
            await load();
            await loadCommitment(id);
          }}
          onError={fail}
        />
      ) : null}

      {requestDetail ? (
        <RequestDetailPanel
          request={requestDetail}
          onClose={() => setRequestDetail(null)}
          onEdit={() => setEditingId(requestDetail.id)}
        />
      ) : null}

      {rfqDetail ? (
        <RfqDetailPanel
          rfq={rfqDetail}
          canManage={canManage}
          money={money}
          busy={busy}
          onClose={() => setRfqDetail(null)}
          onQuotationAction={quotationAct}
          onAward={(quotation) => {
            setRfqDetail(null);
            setAwardingFrom({ rfq: rfqDetail, quotation });
          }}
        />
      ) : null}

      {commitmentDetail ? (
        <CommitmentDetailPanel
          commitment={commitmentDetail}
          money={money}
          busy={busy}
          canManage={canManage}
          onClose={() => setCommitmentDetail(null)}
          onRemoveDelivery={removeDelivery}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Detail overlays
 * ------------------------------------------------------------------------- */

function RequestDetailPanel({
  request,
  onClose,
  onEdit,
}: {
  request: MaterialRequestDetail;
  onClose: () => void;
  onEdit: () => void;
}) {
  return (
    <Overlay title={`درخواست ${request.requestNumber}`} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={REQUEST_TONES[request.status]}>{request.statusLabel}</StatusBadge>
          <span>{request.priorityLabel}</span>
          {request.workPackage ? (
            <span className="text-xs text-muted-foreground">{request.workPackage}</span>
          ) : null}
          {request.requiredBy ? (
            <span className="text-xs text-muted-foreground">
              مورد نیاز تا <DateCell date={request.requiredBy} />
            </span>
          ) : null}
        </div>
        <p>{request.description || request.title}</p>
        <div className="rounded-xl border border-border/80">
          <p className="border-b border-border/80 p-2 text-xs font-medium">ردیف‌ها</p>
          {request.lines.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">ردیفی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border/80">
              {request.lines.map((line) => (
                <li key={line.id} className="flex flex-wrap items-baseline gap-2 p-2 text-xs">
                  <span className="min-w-0 flex-1">{line.description}</span>
                  <span className="text-muted-foreground">
                    {toPersianDigits(String(line.quantity))} {line.unit}
                  </span>
                  {line.boqItemLabel ? (
                    <span className="text-muted-foreground">متره: {line.boqItemLabel}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <EventTrail events={request.events} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/80 p-4">
        <SecondaryButton onClick={onEdit}>ویرایش</SecondaryButton>
        <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
      </div>
    </Overlay>
  );
}

function RfqDetailPanel({
  rfq,
  canManage,
  busy,
  money,
  onClose,
  onQuotationAction,
  onAward,
}: {
  rfq: RfqDetail;
  canManage: boolean;
  busy: boolean;
  money: ReturnType<typeof useMoney>;
  onClose: () => void;
  onQuotationAction: (quotation: Quotation, action: QuotationAction) => void | Promise<void>;
  onAward: (quotation: Quotation) => void;
}) {
  const best = rfq.quotations.length
    ? Math.min(...rfq.quotations.map((row) => row.amountRial))
    : null;
  return (
    <Overlay title={`استعلام ${rfq.rfqNumber}`} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={RFQ_TONES[rfq.status]}>{rfq.statusLabel}</StatusBadge>
          {rfq.requestNumber ? (
            <span className="text-xs text-muted-foreground">از درخواست {rfq.requestNumber}</span>
          ) : null}
          {rfq.responseDue ? (
            <span className="text-xs text-muted-foreground">
              مهلت پاسخ <DateCell date={rfq.responseDue} />
            </span>
          ) : null}
        </div>
        <p>{rfq.scope || rfq.title}</p>

        <div className="rounded-xl border border-border/80">
          <p className="border-b border-border/80 p-2 text-xs font-medium">
            دعوت‌شدگان ({toPersianDigits(String(rfq.suppliers.length))})
          </p>
          {rfq.suppliers.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              کسی دعوت نشده است؛ استعلام بدون تأمین‌کننده ارسال نمی‌شود.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2 p-2 text-xs">
              {rfq.suppliers.map((supplier) => (
                <li
                  key={supplier.partyId}
                  className="rounded-lg border border-border/80 px-2 py-1"
                >
                  {supplier.name}
                  {supplier.quoted ? (
                    <span className="ms-1 text-muted-foreground">— پاسخ داد</span>
                  ) : (
                    <span className="ms-1 text-muted-foreground">— بی‌پاسخ</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-border/80">
          <p className="border-b border-border/80 p-2 text-xs font-medium">
            مقایسهٔ پیشنهادها — کمترین پیشنهاد اول
          </p>
          {rfq.quotations.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">پیشنهادی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border/80">
              {rfq.quotations.map((quotation) => (
                <li key={quotation.id} className="flex flex-col gap-2 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{quotation.supplierName}</span>
                    <span>{money.format(quotation.amountRial)}</span>
                    {best !== null && quotation.amountRial === best ? (
                      <StatusBadge tone="active">کمترین پیشنهاد</StatusBadge>
                    ) : null}
                    <StatusBadge tone={QUOTATION_TONES[quotation.status]}>
                      {QUOTATION_STATUS_LABELS[quotation.status]}
                    </StatusBadge>
                    {quotation.leadDays !== null ? (
                      <span className="text-muted-foreground">
                        تحویل {toPersianDigits(String(quotation.leadDays))} روز
                      </span>
                    ) : null}
                    {quotation.validityDate ? (
                      <span className="text-muted-foreground">
                        اعتبار تا <DateCell date={quotation.validityDate} />
                      </span>
                    ) : null}
                  </div>
                  {quotation.note ? <p className="text-muted-foreground">{quotation.note}</p> : null}
                  <div className="flex flex-wrap gap-1">
                    {quotationActionsFor(quotation.status).map((action) => (
                      <SecondaryButton
                        key={action}
                        disabled={busy || !canManage}
                        onClick={() => void onQuotationAction(quotation, action)}
                      >
                        {QUOTATION_ACTION_LABELS[action]}
                      </SecondaryButton>
                    ))}
                    {canManage && quotation.status !== "declined" && quotation.status !== "selected" ? (
                      <PrimaryButton disabled={busy} onClick={() => onAward(quotation)}>
                        ثبت تعهد از این پیشنهاد
                      </PrimaryButton>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border/80 p-2 text-xs text-muted-foreground">
            کمترین قیمت یعنی کمترین قیمت؛ انتخاب تأمین‌کننده با ثبت تعهد و تأیید آن انجام می‌شود.
          </p>
        </div>

        <EventTrail events={rfq.events} />
      </div>
      <div className="flex items-center justify-end border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
      </div>
    </Overlay>
  );
}

function CommitmentDetailPanel({
  commitment,
  money,
  busy,
  canManage,
  onClose,
  onRemoveDelivery,
}: {
  commitment: CommitmentDetail;
  money: ReturnType<typeof useMoney>;
  busy: boolean;
  canManage: boolean;
  onClose: () => void;
  onRemoveDelivery: (delivery: Delivery) => void | Promise<void>;
}) {
  return (
    <Overlay title={`${commitment.kindLabel} ${commitment.commitmentNumber}`} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={COMMITMENT_TONES[commitment.status]}>
            {commitment.statusLabel}
          </StatusBadge>
          {commitment.isDelayed && commitment.delayDays ? (
            <StatusBadge tone="danger">
              {toPersianDigits(String(commitment.delayDays))} روز تأخیر تحویل
            </StatusBadge>
          ) : null}
          <span>{commitment.supplierName}</span>
          <span className="text-muted-foreground">{money.format(commitment.valueRial)}</span>
        </div>
        <p>{commitment.title}</p>
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          {commitment.requestNumber ? (
            <div>
              <dt className="text-muted-foreground">درخواست</dt>
              <dd>{commitment.requestNumber}</dd>
            </div>
          ) : null}
          {commitment.rfqNumber ? (
            <div>
              <dt className="text-muted-foreground">استعلام</dt>
              <dd>{commitment.rfqNumber}</dd>
            </div>
          ) : null}
          {commitment.contractTitle ? (
            <div>
              <dt className="text-muted-foreground">قرارداد مرتبط</dt>
              <dd>{commitment.contractTitle}</dd>
            </div>
          ) : null}
          {commitment.expectedDeliveryDate ? (
            <div>
              <dt className="text-muted-foreground">تحویل مورد انتظار</dt>
              <dd>
                <DateCell date={commitment.expectedDeliveryDate} />
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="rounded-xl border border-border/80">
          <p className="border-b border-border/80 p-2 text-xs font-medium">
            تحویل‌ها ({toPersianDigits(String(commitment.deliveries.length))})
          </p>
          {commitment.deliveries.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              هنوز تحویلی ثبت نشده است؛ تحویل فقط برای تعهد تأییدشده ثبت می‌شود.
            </p>
          ) : (
            <ul className="divide-y divide-border/80">
              {commitment.deliveries.map((delivery) => (
                <li key={delivery.id} className="flex flex-wrap items-baseline gap-2 p-2 text-xs">
                  <DateCell date={delivery.deliveredOn} />
                  <span className="min-w-0 flex-1">{delivery.note}</span>
                  <span className="text-muted-foreground">{delivery.receivedByName}</span>
                  {canManage ? (
                    <SecondaryButton
                      disabled={busy}
                      onClick={() => void onRemoveDelivery(delivery)}
                    >
                      <Trash2Icon className="size-3" aria-hidden />
                      <span className="sr-only">حذف تحویل</span>
                    </SecondaryButton>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <EventTrail events={commitment.events} />
      </div>
      <div className="flex items-center justify-end border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
      </div>
    </Overlay>
  );
}

function EventTrail({ events }: { events: ProcurementEvent[] }) {
  return (
    <div className="rounded-xl border border-border/80">
      <p className="flex items-center gap-2 border-b border-border/80 p-2 text-xs font-medium">
        <HistoryIcon className="size-3.5" aria-hidden />
        رویدادها
      </p>
      {events.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">رویدادی ثبت نشده است.</p>
      ) : (
        <ul className="divide-y divide-border/80">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-2 p-2 text-xs">
              <span className="min-w-0 flex-1">{event.summary}</span>
              <span className="text-muted-foreground">{event.actorName}</span>
              <DateCell date={event.createdAt.slice(0, 10)} className="text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-3xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Forms
 * ------------------------------------------------------------------------- */

function RequestForm({
  projectId,
  request,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  request?: MaterialRequestDetail;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: (requestId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [title, setTitle] = useState(request?.title ?? "");
  const [workPackage, setWorkPackage] = useState(request?.workPackage ?? "");
  const [description, setDescription] = useState(request?.description ?? "");
  const [priority, setPriority] = useState<MaterialRequestPriority>(
    request?.priority ?? "normal",
  );
  const [requiredBy, setRequiredBy] = useState(request?.requiredBy ?? "");
  const [lines, setLines] = useState<Array<{ description: string; unit: string; quantity: string }>>(
    request?.lines?.length
      ? request.lines.map((line) => ({
          description: line.description,
          unit: line.unit,
          quantity: String(line.quantity),
        }))
      : [{ description: "", unit: "", quantity: "" }],
  );
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    const body = {
      title,
      workPackage,
      description,
      priority,
      requiredBy: requiredBy || null,
      lines: lines
        .filter((line) => line.description.trim())
        .map((line) => ({
          description: line.description,
          unit: line.unit,
          quantity: line.quantity || "1",
        })),
    };
    const { ok, data } = request
      ? await api<{ materialRequest: { id: string } }>(`/api/aec/requests/${request.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ materialRequest: { id: string } }>(
          `/api/aec/projects/${projectId}/requests`,
          { method: "POST", body: JSON.stringify(body) },
        );
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.materialRequest.id);
  }

  return (
    <Overlay
      title={request ? `ویرایش درخواست ${request.requestNumber}` : "درخواست کالا"}
      onClose={onClose}
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="عنوان" hint="مثلاً «ورق گالوانیزه برای سقف بلوک B»">
            <input
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
        </div>
        <Field label="بستهٔ کاری" hint="اختیاری — کدام بخش پروژه">
          <input
            className={inputClass}
            value={workPackage}
            onChange={(event) => setWorkPackage(event.target.value)}
          />
        </Field>
        <SelectField<MaterialRequestPriority>
          label="اولویت"
          value={priority}
          onChange={(next) => setPriority(next || "normal")}
          options={MATERIAL_REQUEST_PRIORITIES}
          labels={MATERIAL_REQUEST_PRIORITY_LABELS}
        />
        <DateField label="مورد نیاز تا" value={requiredBy} onChange={setRequiredBy} />
        <div className="sm:col-span-2">
          <Field label="توضیحات" hint="اختیاری">
            <textarea
              className={inputClass}
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <p className="mb-1 text-xs font-medium">ردیف‌ها</p>
          <div className="flex flex-col gap-2">
            {lines.map((line, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_120px]">
                <input
                  className={inputClass}
                  placeholder="شرح کالا یا کار"
                  value={line.description}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((row, i) =>
                        i === index ? { ...row, description: event.target.value } : row,
                      ),
                    )
                  }
                />
                <input
                  className={inputClass}
                  placeholder="واحد"
                  value={line.unit}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((row, i) =>
                        i === index ? { ...row, unit: event.target.value } : row,
                      ),
                    )
                  }
                />
                <input
                  className={inputClass}
                  inputMode="decimal"
                  placeholder="مقدار"
                  value={line.quantity}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((row, i) =>
                        i === index
                          ? { ...row, quantity: event.target.value.replace(/[^\d.]/g, "") }
                          : row,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <SecondaryButton
            onClick={() => setLines((current) => [...current, { description: "", unit: "", quantity: "" }])}
          >
            <PlusIcon className="size-4" aria-hidden />
            ردیف
          </SecondaryButton>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton disabled={saving || !title.trim()} onClick={() => void submit()}>
          <CheckCircle2Icon className="size-4" aria-hidden />
          {request ? "ذخیره" : "ثبت درخواست"}
        </PrimaryButton>
      </div>
    </Overlay>
  );
}

function RfqForm({
  projectId,
  requests,
  suppliers,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  requests: MaterialRequest[];
  suppliers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (rfqId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [requestId, setRequestId] = useState("");
  const [responseDue, setResponseDue] = useState("");
  const [invited, setInvited] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    const { ok, data } = await api<{ rfq: { id: string } }>(`/api/aec/projects/${projectId}/rfqs`, {
      method: "POST",
      body: JSON.stringify({
        title,
        scope,
        requestId: requestId || null,
        responseDue: responseDue || null,
        suppliers: invited.map((partyId) => ({ partyId })),
      }),
    });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.rfq.id);
  }

  return (
    <Overlay title="استعلام بها (RFQ)" onClose={onClose}>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="عنوان">
            <input
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="دامنهٔ استعلام" hint="چه چیزی و با چه مشخصاتی خواسته می‌شود">
            <textarea
              className={inputClass}
              rows={2}
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            />
          </Field>
        </div>
        <PickerField
          label="درخواست کالا"
          value={requestId}
          onChange={setRequestId}
          options={requests.map((row) => ({
            id: row.id,
            label: `${row.requestNumber} — ${row.title}`,
          }))}
          hint="اختیاری"
        />
        <DateField label="مهلت پاسخ تأمین‌کنندگان" value={responseDue} onChange={setResponseDue} />
        <div className="sm:col-span-2">
          <p className="mb-1 text-xs font-medium">تأمین‌کنندگان دعوت‌شده</p>
          {suppliers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              طرفی در فهرست نیست؛ ابتدا تأمین‌کننده را از «طرف‌ها» ثبت کنید.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {suppliers.map((supplier) => {
                const on = invited.includes(supplier.id);
                return (
                  <li key={supplier.id}>
                    <button
                      type="button"
                      className={`rounded-lg border px-2 py-1 text-xs ${
                        on ? "border-primary/60 bg-muted/60" : "border-border/80"
                      }`}
                      onClick={() =>
                        setInvited((current) =>
                          on
                            ? current.filter((id) => id !== supplier.id)
                            : [...current, supplier.id],
                        )
                      }
                    >
                      {supplier.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton disabled={saving || !title.trim()} onClick={() => void submit()}>
          <CheckCircle2Icon className="size-4" aria-hidden />
          ثبت استعلام
        </PrimaryButton>
      </div>
    </Overlay>
  );
}

function QuotationForm({
  rfq,
  suppliers,
  onClose,
  onSaved,
  onError,
}: {
  rfq: Rfq;
  suppliers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [partyId, setPartyId] = useState("");
  const [amountRial, setAmountRial] = useState("");
  const [leadDays, setLeadDays] = useState("");
  const [validityDate, setValidityDate] = useState("");
  const [note, setNote] = useState("");
  const [receivedDate, setReceivedDate] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!partyId || !amountRial || saving) return;
    setSaving(true);
    const { ok, data } = await api(`/api/aec/rfqs/${rfq.id}/quotations`, {
      method: "POST",
      body: JSON.stringify({
        partyId,
        amountRial,
        leadDays: leadDays === "" ? null : leadDays,
        validityDate: validityDate || null,
        note,
        receivedDate: receivedDate || null,
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
    <Overlay title={`پیشنهاد تأمین‌کننده — استعلام ${rfq.rfqNumber}`} onClose={onClose}>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <PickerField
          label="تأمین‌کننده"
          value={partyId}
          onChange={setPartyId}
          options={suppliers.map((supplier) => ({ id: supplier.id, label: supplier.name }))}
          hint="هر تأمین‌کننده یک پیشنهاد؛ برای قیمت جدید، استعلام تازه ثبت کنید"
        />
        <Field label="مبلغ پیشنهادی (ریال)">
          <input
            className={inputClass}
            inputMode="numeric"
            value={amountRial}
            onChange={(event) => setAmountRial(event.target.value.replace(/[^\d]/g, ""))}
          />
        </Field>
        <Field label="زمان تحویل (روز)" hint="اختیاری">
          <input
            className={inputClass}
            inputMode="numeric"
            value={leadDays}
            onChange={(event) => setLeadDays(event.target.value.replace(/[^\d]/g, ""))}
          />
        </Field>
        <DateField label="اعتبار پیشنهاد تا" value={validityDate} onChange={setValidityDate} />
        <DateField label="تاریخ دریافت" value={receivedDate} onChange={setReceivedDate} />
        <div className="sm:col-span-2">
          <Field label="یادداشت" hint="اختیاری — شرایط پرداخت، تخفیف، استثناها">
            <textarea
              className={inputClass}
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton
          disabled={saving || !partyId || !amountRial}
          onClick={() => void submit()}
        >
          <CheckCircle2Icon className="size-4" aria-hidden />
          ثبت پیشنهاد
        </PrimaryButton>
      </div>
    </Overlay>
  );
}

function CommitmentForm({
  projectId,
  suppliers,
  requests,
  rfqs,
  prefill,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  commitment?: Commitment;
  suppliers: Array<{ id: string; name: string }>;
  requests: MaterialRequest[];
  rfqs: Rfq[];
  prefill?: {
    rfqId: string;
    quotationId: string;
    supplierPartyId: string;
    valueRial: string;
    title: string;
    requestId: string;
  };
  onClose: () => void;
  onSaved: (commitmentId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [kind, setKind] = useState<CommitmentKind>("purchase");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [supplierPartyId, setSupplierPartyId] = useState(prefill?.supplierPartyId ?? "");
  const [valueRial, setValueRial] = useState(prefill?.valueRial ?? "");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [workPackage, setWorkPackage] = useState("");
  const [requestId, setRequestId] = useState(prefill?.requestId ?? "");
  const [rfqId, setRfqId] = useState(prefill?.rfqId ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim() || !supplierPartyId || saving) return;
    setSaving(true);
    const { ok, data } = await api<{ commitment: { id: string } }>(
      `/api/aec/projects/${projectId}/commitments`,
      {
        method: "POST",
        body: JSON.stringify({
          kind,
          title,
          supplierPartyId,
          valueRial: valueRial || null,
          expectedDeliveryDate: expectedDeliveryDate || null,
          workPackage,
          requestId: requestId || null,
          rfqId: rfqId || null,
          quotationId: prefill?.quotationId ?? null,
        }),
      },
    );
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.commitment.id);
  }

  return (
    <Overlay title={prefill ? "ثبت تعهد از پیشنهاد" : "تعهد جدید — سفارش خرید یا پیمان جزء"} onClose={onClose}>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <SelectField<CommitmentKind>
          label="نوع"
          value={kind}
          onChange={(next) => setKind(next || "purchase")}
          options={COMMITMENT_KINDS}
          labels={COMMITMENT_KIND_LABELS}
        />
        <PickerField
          label="تأمین‌کننده"
          value={supplierPartyId}
          onChange={setSupplierPartyId}
          options={suppliers.map((supplier) => ({ id: supplier.id, label: supplier.name }))}
          hint="تأمین‌کننده یک «طرف» است، نه یک کاربر"
        />
        <div className="sm:col-span-2">
          <Field label="عنوان">
            <input
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
        </div>
        <Field label="مبلغ تعهد (ریال)" hint="برای ارسال به تأیید الزامی است">
          <input
            className={inputClass}
            inputMode="numeric"
            value={valueRial}
            onChange={(event) => setValueRial(event.target.value.replace(/[^\d]/g, ""))}
          />
        </Field>
        <DateField
          label="تحویل مورد انتظار"
          value={expectedDeliveryDate}
          onChange={setExpectedDeliveryDate}
        />
        <Field label="بستهٔ کاری" hint="اختیاری">
          <input
            className={inputClass}
            value={workPackage}
            onChange={(event) => setWorkPackage(event.target.value)}
          />
        </Field>
        <PickerField
          label="درخواست کالا"
          value={requestId}
          onChange={setRequestId}
          options={requests.map((row) => ({
            id: row.id,
            label: `${row.requestNumber} — ${row.title}`,
          }))}
          hint="اختیاری"
        />
        <PickerField
          label="استعلام"
          value={rfqId}
          onChange={setRfqId}
          options={rfqs.map((row) => ({ id: row.id, label: `${row.rfqNumber} — ${row.title}` }))}
          hint="اختیاری — بستن تعهد، استعلام را می‌بندد"
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton
          disabled={saving || !title.trim() || !supplierPartyId}
          onClick={() => void submit()}
        >
          <CheckCircle2Icon className="size-4" aria-hidden />
          ثبت تعهد
        </PrimaryButton>
      </div>
    </Overlay>
  );
}

function DeliveryForm({
  commitment,
  onClose,
  onSaved,
  onError,
}: {
  commitment: Commitment;
  onClose: () => void;
  onSaved: (commitmentId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [deliveredOn, setDeliveredOn] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const { ok, data } = await api(`/api/aec/commitments/${commitment.id}/deliveries`, {
      method: "POST",
      body: JSON.stringify({ deliveredOn: deliveredOn || null, note }),
    });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(commitment.id);
  }

  return (
    <Overlay title={`ثبت تحویل — ${commitment.commitmentNumber}`} onClose={onClose}>
      <div className="grid gap-3 p-4">
        <DateField label="تاریخ تحویل" value={deliveredOn} onChange={setDeliveredOn} />
        <Field label="یادداشت" hint="چه چیزی رسید، چه کسی تحویل گرفت، چه چیزی ناقص است">
          <textarea
            className={inputClass}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton disabled={saving} onClick={() => void submit()}>
          <CheckCircle2Icon className="size-4" aria-hidden />
          ثبت تحویل
        </PrimaryButton>
      </div>
    </Overlay>
  );
}
