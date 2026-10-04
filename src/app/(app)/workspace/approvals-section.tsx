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
import { CheckCircle2Icon, CheckIcon, StampIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
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
import {
  ApprovalStatusBadge,
  DateCell,
  LoadMoreFooter,
  workspaceError,
  WorkspaceFormDialog,
  stackedTableClass,
} from "./workspace-ui";
import { usePagedList } from "./use-paged-list";
import {
  WorkspaceEntityDrawer,
  type WorkspaceEntityKind,
  type WorkspaceEntityRef,
} from "./workspace-entity-drawer";

/**
 * The approval subjects the shared entity drawer can open. §7's estimate
 * revision and §11's submittal revision are decided through this same queue —
 * one approval engine, as the issue requires — but they are not entities of
 * `/api/workspace/**`, so the queue shows them as text and their own register
 * (`متره و برآورد`, `ارسال مدارک`) is where they are read.
 */
function openableSubject(type: WorkspaceApprovalSubject): type is WorkspaceEntityKind {
  return type === "project" || type === "task" || type === "document" || type === "contract";
}

/**
 * The subject cell: a link into the shared entity drawer for the four subjects
 * that drawer can open, and plain text for the two it cannot.
 *
 * Issue #799 — §7's estimate revision and §11's submittal revision are decided
 * through this same queue (one approval engine, as the issue requires) but are
 * not entities of `/api/workspace/**`; their own registers — «متره و برآورد»
 * and «ارسال مدارک» — are where they are read, so the queue names the subject
 * rather than offering a link that would 404.
 */
function SubjectLabel({
  row,
  onOpen,
}: {
  row: ApprovalRow;
  onOpen: (ref: WorkspaceEntityRef) => void;
}) {
  const label = row.subjectTitle || row.title;
  const kind = row.subjectType;
  // An explicit button, not a row click: this row also holds the decision
  // buttons, and one press must do one thing (#761 §23).
  if (!openableSubject(kind)) return <span className="font-medium">{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen({ kind, id: row.subjectId })}
      className="text-start font-medium underline-offset-4 hover:underline"
    >
      {label}
    </button>
  );
}

interface ApprovalSummary {
  total: number;
  pending: number;
  approved: number;
  overdue: number;
}

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
  initialInbox = "all",
}: {
  /** `?mine=true` — the command bar's bell lands on «منتظر تصمیم من». */
  initialInbox?: Inbox;
  canApprove: boolean;
  projectId?: string;
}) {
  const [error, setError] = useState("");
  const [status, setStatus] = useState<WorkspaceApprovalStatus | "all">("pending");
  const [inbox, setInbox] = useState<Inbox>(initialInbox);
  const [deciding, setDeciding] = useState<{ row: ApprovalRow; decision: Decision } | null>(null);
  // What is being approved, opened in the shared drawer (#761 §14).
  const [viewing, setViewing] = useState<WorkspaceEntityRef | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ status });
    if (inbox === "mine") params.set("mine", "true");
    if (inbox === "requested") params.set("requested", "true");
    if (projectId) params.set("projectId", projectId);
    return `/api/workspace/approvals?${params}`;
  }, [status, inbox, projectId]);
  const list = usePagedList<ApprovalRow, ApprovalSummary>(query, "approvals");
  const approvals = list.rows;
  const load = list.reload;
  useEffect(() => {
    if (list.error) setError(list.error);
  }, [list.error]);

  // Server totals over the whole filtered set — not the loaded page.
  const counts = {
    total: list.summary?.total ?? 0,
    pending: list.summary?.pending ?? 0,
    overdue: list.summary?.overdue ?? 0,
    approved: list.summary?.approved ?? 0,
  };

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
          <DataTable caption="فهرست درخواست‌های تأیید" frame={false} tableClassName={stackedTableClass}>
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
                  <Td data-label="موضوع">
                    {/* An explicit button, not a row click: this row also holds the
                        decision buttons, and one press must do one thing (#761 §23). */}
                    <SubjectLabel row={row} onOpen={setViewing} />
                    {row.note ? (
                      <div className="text-xs text-muted-foreground">{row.note}</div>
                    ) : null}
                  </Td>
                  <Td data-label="نوع">{APPROVAL_SUBJECT_LABELS[row.subjectType]}</Td>
                  <Td data-label="پروژه">{row.projectName ?? "—"}</Td>
                  <Td data-label="درخواست‌کننده">{row.requestedByName ?? "—"}</Td>
                  <Td data-label="مهلت">
                    <DateCell date={row.dueDate} />
                  </Td>
                  <Td data-label="وضعیت">
                    <ApprovalStatusBadge status={row.status} />
                  </Td>
                  <Td data-label="اقدام">
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
        <LoadMoreFooter
          loaded={approvals?.length ?? 0}
          page={list.page}
          loading={list.loadingMore}
          onLoadMore={list.loadMore}
        />
      </SectionCard>

      <WorkspaceEntityDrawer entity={viewing} onClose={() => setViewing(null)} onChanged={load} />

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
    <WorkspaceFormDialog title={<>{DECISION_LABELS[decision]} درخواست</>} width="lg" onClose={onClose}>
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
          {saving ? "در حال ثبت…" : `ثبت ${DECISION_LABELS[decision]}`}
        </PrimaryButton>
      </div>
    </WorkspaceFormDialog>
  );
}
