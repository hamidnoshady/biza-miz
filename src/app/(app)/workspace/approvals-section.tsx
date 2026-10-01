"use client";

/**
 * «تأییدها» — the approval inbox.
 *
 * Requesting and deciding are deliberately different rights: anyone with
 * `workspace.manage` can ask, only `workspace.approve` can answer, a named
 * approver is the only one who may answer their request, and nobody answers
 * their own. Each row carries `requestedByMe`/`assignedToMe` from the server,
 * so the buttons rendered are the ones that will succeed — and the server
 * enforces the same rule again (`approvalDecisionError`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, CheckIcon, StampIcon, XIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { todayIsoDate } from "@/lib/jalali";
import {
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABELS,
  APPROVAL_SUBJECT_LABELS,
  type WorkspaceApprovalStatus,
  type WorkspaceApprovalSubject,
} from "@/lib/workspace-shared";
import { ApprovalStatusBadge, DateCell, workspaceError } from "./workspace-ui";

export interface ApprovalRow {
  id: string;
  subjectType: WorkspaceApprovalSubject;
  subjectId: string;
  subjectTitle: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  status: WorkspaceApprovalStatus;
  requestedByName: string | null;
  approverName: string | null;
  dueDate: string | null;
  approverUserId: string | null;
  decidedAt: string | null;
  note: string;
  createdAt: string;
  requestedByMe: boolean;
  assignedToMe: boolean;
  canDecideUnassigned: boolean;
}

type Decision = "approved" | "rejected" | "changes_requested" | "cancelled";
type Inbox = "all" | "mine" | "requested";

export function ApprovalsSection({
  canApprove,
  projectId,
}: {
  canApprove: boolean;
  projectId?: string;
}) {
  const [approvals, setApprovals] = useState<ApprovalRow[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<WorkspaceApprovalStatus | "all">("pending");
  const [inbox, setInbox] = useState<Inbox>("all");
  const [deciding, setDeciding] = useState<{ row: ApprovalRow; decision: Decision } | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ status });
    if (inbox === "mine") params.set("mine", "true");
    if (inbox === "requested") params.set("requested", "true");
    if (projectId) params.set("projectId", projectId);
    api<{ approvals: ApprovalRow[] }>(`/api/workspace/approvals?${params}`).then(({ ok, data }) => {
      if (ok) setApprovals(data.approvals);
      else setError(workspaceError((data as unknown as { error?: string }).error));
    });
  }, [status, inbox, projectId]);

  useEffect(load, [load]);

  const counts = useMemo(() => {
    const list = approvals ?? [];
    // The business's calendar day (Tehran), never the browser's UTC slice.
    const today = todayIsoDate();
    return {
      total: list.length,
      pending: list.filter((a) => a.status === "pending").length,
      overdue: list.filter(
        (a) => a.status === "pending" && a.dueDate && a.dueDate < today,
      ).length,
      approved: list.filter((a) => a.status === "approved").length,
    };
  }, [approvals]);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard label="در این نما" value={toPersianDigits(String(counts.total))} icon={StampIcon} />
        <KpiCard label="در انتظار" value={toPersianDigits(String(counts.pending))} />
        <KpiCard
          label="مهلت گذشته"
          value={toPersianDigits(String(counts.overdue))}
          hint="در انتظار و از مهلت گذشته"
        />
        <KpiCard label="تأییدشده" value={toPersianDigits(String(counts.approved))} />
      </KpiRow>

      <SectionCard
        title="صف تأیید"
        description={
          canApprove
            ? "درخواست‌های تأیید قرارداد، سند، وظیفه و پروژه. تصمیم شما وضعیت خودِ آن مورد را هم به‌روز می‌کند."
            : "درخواست‌های تأیید. اجازهٔ تصمیم‌گیری «تأیید میز کار» را ندارید، پس این فهرست فقط خواندنی است."
        }
        flush
      >
        <div className="flex flex-col gap-2 border-b border-border/80 p-4">
          <FilterChipRow label="فیلتر وضعیت">
            <FilterChip selected={status === "all"} onClick={() => setStatus("all")}>
              همه
            </FilterChip>
            {APPROVAL_STATUSES.map((value) => (
              <FilterChip
                key={value}
                selected={status === value}
                onClick={() => setStatus(value)}
              >
                {APPROVAL_STATUS_LABELS[value]}
              </FilterChip>
            ))}
          </FilterChipRow>
          <FilterChipRow label="فیلتر مخاطب">
            <FilterChip selected={inbox === "all"} onClick={() => setInbox("all")}>
              همه
            </FilterChip>
            <FilterChip selected={inbox === "mine"} onClick={() => setInbox("mine")}>
              منتظر تصمیم من
            </FilterChip>
            <FilterChip selected={inbox === "requested"} onClick={() => setInbox("requested")}>
              درخواست‌های من
            </FilterChip>
          </FilterChipRow>
        </div>

        {approvals === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری تأییدها" />
        ) : approvals.length === 0 ? (
          <EmptyState icon={CheckCircle2Icon} title="چیزی در انتظار تأیید نیست">
            وقتی کسی برای قرارداد یا سندی درخواست تأیید بفرستد، اینجا دیده می‌شود.
          </EmptyState>
        ) : (
          <DataTable caption="فهرست درخواست‌های تأیید" frame={false}>
            <DataTableHead>
              <tr>
                <Th>موضوع</Th>
                <Th>نوع</Th>
                <Th>پروژه</Th>
                <Th>درخواست‌کننده</Th>
                <Th>مهلت</Th>
                <Th>وضعیت</Th>
                <Th>اقدام</Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {approvals.map((row) => (
                <DataTableRow key={row.id}>
                  <Td>
                    <div className="font-medium">{row.subjectTitle || row.title}</div>
                    {row.note ? (
                      <div className="text-xs text-muted-foreground">{row.note}</div>
                    ) : null}
                  </Td>
                  <Td>{APPROVAL_SUBJECT_LABELS[row.subjectType]}</Td>
                  <Td>{row.projectName ?? "—"}</Td>
                  <Td>{row.requestedByName ?? "—"}</Td>
                  <Td>
                    <DateCell date={row.dueDate} />
                  </Td>
                  <Td>
                    <ApprovalStatusBadge status={row.status} />
                  </Td>
                  <Td>
                    {row.status !== "pending" ? (
                      <span className="text-xs text-muted-foreground">
                        {row.decidedAt ? "تصمیم ثبت شده" : "—"}
                      </span>
                    ) : row.requestedByMe ? (
                      <SecondaryButton onClick={() => setDeciding({ row, decision: "cancelled" })}>
                        لغو درخواست
                      </SecondaryButton>
                    ) : canApprove && (row.assignedToMe || (!row.approverUserId && row.canDecideUnassigned)) ? (
                      <div className="flex flex-wrap gap-1.5">
                        <PrimaryButton
                          type="button"
                          onClick={() => setDeciding({ row, decision: "approved" })}
                        >
                          <CheckIcon className="size-4" aria-hidden />
                          تأیید
                        </PrimaryButton>
                        <SecondaryButton
                          onClick={() => setDeciding({ row, decision: "changes_requested" })}
                        >
                          درخواست اصلاح
                        </SecondaryButton>
                        <SecondaryButton
                          onClick={() => setDeciding({ row, decision: "rejected" })}
                        >
                          رد
                        </SecondaryButton>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {row.approverName ? `در انتظار ${row.approverName}` : "در انتظار تأییدکننده"}
                      </span>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {deciding ? (
        <DecisionDialog
          row={deciding.row}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            load();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

const DECISION_LABELS: Record<Decision, string> = {
  approved: "تأیید",
  rejected: "رد",
  changes_requested: "درخواست اصلاح",
  cancelled: "لغو",
};

const DECISION_EFFECTS: Record<Decision, string> = {
  approved: "با تأیید، وضعیت خودِ این مورد هم به‌روز می‌شود (قرارداد فعال، سند تأییدشده).",
  rejected: "با رد، وضعیت آن مورد «ردشده» ثبت می‌شود و می‌توان دوباره درخواست داد.",
  changes_requested: "مورد به پیش‌نویس برمی‌گردد تا درخواست‌کننده اصلاحش کند و دوباره بفرستد.",
  cancelled: "درخواست پس گرفته می‌شود و وضعیت آن مورد تغییری نمی‌کند.",
};

function DecisionDialog({
  row,
  decision,
  onClose,
  onDone,
  onError,
}: {
  row: ApprovalRow;
  decision: Decision;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const { ok, data } = await api(`/api/workspace/approvals/${row.id}`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    });
    setSaving(false);
    if (ok) onDone();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-lg`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">{DECISION_LABELS[decision]} درخواست</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            {APPROVAL_SUBJECT_LABELS[row.subjectType]}: {row.subjectTitle || row.title}
            {row.projectName ? ` — ${row.projectName}` : ""}
          </p>
          <Field
            label="یادداشت"
            hint={
              decision === "rejected" || decision === "changes_requested"
                ? "دلیل را بنویسید؛ درخواست‌کننده آن را می‌بیند."
                : "اختیاری"
            }
          >
            <textarea
              className={`${inputClass} min-h-24`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </Field>
          <p className="text-xs text-muted-foreground">{DECISION_EFFECTS[decision]}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton type="button" onClick={submit} disabled={saving}>
            {saving ? "در حال ثبت" : `ثبت ${DECISION_LABELS[decision]}`}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
