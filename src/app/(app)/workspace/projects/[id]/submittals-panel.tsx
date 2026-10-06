"use client";

/**
 * Issue #799 §11 on screen — «ارسال مدارک (Submittal)»: the shop drawings,
 * samples, method statements and technical data a contractor sends for review,
 * and the reviewer's determination on each one.
 *
 * §11's line is the whole screen, so it is drawn as one:
 *
 *   Draft → Submitted → Under Review → Approved / Approved with Comments /
 *   Revise & Resubmit / Rejected → Closed
 *
 * The register lists one row per submittal with its *current revision*; the
 * panel underneath is that submittal's whole revision history, each revision
 * with the determination it received, because §11 asks for "approval history"
 * and this is where it lives.
 *
 * ## What the screen is careful about
 *
 *   * **The reviewer's four outcomes are offered as four buttons.** A binary
 *     approve/reject would lose «اصلاح و ارسال مجدد» and «تأیید با نظر», which
 *     are the two outcomes a contractor actually works from; the approvals queue
 *     can only express two of the four, and it maps onto the pair it can.
 *   * **Reviewing is a different right from drafting.** «ارسال» rides
 *     `workspace.manage` (it is a project write); «شروع بررسی»، the four
 *     determinations and «بستن» ride `workspace.approve` — §24's rule that a
 *     high-risk decision must not inherit ordinary edit rights. The buttons
 *     appear only for a member who holds the key.
 *   * **A submitted revision looks submitted.** Its file, due date and reviewer
 *     stop being editable and the screen stops offering to edit them; the way
 *     forward is a new revision, which is what «اصلاح و ارسال مجدد» already
 *     creates for you.
 *   * **Files come from the Media Library.** Attachments are documents of the
 *     project (`mediaAssetId` + title) and a revision's own file is the same
 *     choice; the register never uploads bytes itself.
 *   * **Dates are Shamsi on screen and Gregorian in the database**: `DateField`
 *     is the shared Jalali picker and the API only ever sees `YYYY-MM-DD`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  FileStackIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
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
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { toPersianDigits } from "@/lib/digits";
import {
  SUBMITTAL_DECISIONS,
  SUBMITTAL_DECISION_LABELS,
  SUBMITTAL_STATUS_LABELS,
  SUBMITTAL_TYPES,
  SUBMITTAL_TYPE_LABELS,
  type SubmittalDecision,
  type SubmittalStatus,
  type SubmittalType,
} from "@/lib/aec-rfi";
import { AEC_SPECIALTIES, AEC_SPECIALTY_LABELS, type AecSpecialty } from "@/lib/aec";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, SelectField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface SubmittalRevision {
  id: string;
  submittalId: string;
  revisionNo: number;
  status: SubmittalStatus;
  statusLabel: string;
  isEditable: boolean;
  approvalId: string | null;
  approvalStatus: string | null;
  workspaceDocumentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  submittedById: string | null;
  submittedByName: string;
  submittedAt: string | null;
  dueDate: string | null;
  reviewerUserId: string | null;
  reviewerName: string;
  response: string;
  decidedByName: string;
  decidedAt: string | null;
  closedAt: string | null;
  notes: string;
  createdAt: string;
  createdByName: string;
  approvalRequestedAt: string | null;
  isOverdue: boolean;
}

interface SubmittalSummary {
  id: string;
  projectId: string;
  submittalNumber: string;
  title: string;
  submissionType: SubmittalType;
  submissionTypeLabel: string;
  specSection: string;
  discipline: string | null;
  disciplineLabel: string;
  documentId: string | null;
  documentNumber: string | null;
  documentTitle: string | null;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  responseRequiredBy: string | null;
  latestRevisionId: string | null;
  latestRevisionNo: number | null;
  latestRevisionStatus: SubmittalStatus | null;
  latestRevisionStatusLabel: string | null;
  latestRevisionDueDate: string | null;
  reviewerName: string;
  revisionCount: number;
  notes: string;
  createdAt: string;
  createdByName: string;
  isWaiting: boolean;
  isOverdue: boolean;
  attachmentCount: number;
}

interface SubmittalDetail extends SubmittalSummary {
  revisions: SubmittalRevision[];
}

interface SubmittalAttachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mediaAssetId: string | null;
}

const STATUS_TONES: Record<SubmittalStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  submitted: "active",
  under_review: "active",
  approved: "positive",
  approved_with_comments: "positive",
  revise_and_resubmit: "danger",
  rejected: "danger",
  closed: "neutral",
};

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecSubmittalsTab({
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
  const [submittals, setSubmittals] = useState<SubmittalSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubmittalDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SubmittalSummary | null>(null);
  const [addingRevision, setAddingRevision] = useState(false);
  const [editingRevision, setEditingRevision] = useState<SubmittalRevision | null>(null);
  const [submitting, setSubmitting] = useState<SubmittalRevision | null>(null);
  const [deciding, setDeciding] = useState<SubmittalRevision | null>(null);
  const [statusFilter, setStatusFilter] = useState<SubmittalStatus | "">("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = (code: string | undefined) => setError(workspaceError(code));

  const load = useCallback(
    async (preferId?: string | null) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const suffix = params.size ? `?${params.toString()}` : "";
      const { ok, data } = await api<{ submittals: SubmittalSummary[] }>(
        `/api/aec/projects/${projectId}/submittals${suffix}`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setSubmittals([]);
        return null;
      }
      setSubmittals(data.submittals);
      const next = data.submittals.find((row) => row.id === preferId) ?? data.submittals[0] ?? null;
      setSelectedId(next ? next.id : null);
      return next;
    },
    [projectId, search, statusFilter],
  );

  const loadDetail = useCallback(async (submittalId: string) => {
    const { ok, data } = await api<{ submittal: SubmittalDetail }>(
      `/api/aec/submittals/${submittalId}`,
    );
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setDetail(null);
      return;
    }
    setDetail(data.submittal);
  }, []);

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

  const waiting = useMemo(() => (submittals ?? []).filter((row) => row.isWaiting).length, [submittals]);
  const overdue = useMemo(() => (submittals ?? []).filter((row) => row.isOverdue).length, [submittals]);
  const revisionCount = useMemo(
    () => (submittals ?? []).reduce((total, row) => total + row.revisionCount, 0),
    [submittals],
  );

  async function reviewAction(
    revision: SubmittalRevision,
    action: "submit" | "start_review" | "close",
    extra: Record<string, unknown> = {},
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ submittal: SubmittalDetail }>(
      `/api/aec/submittal-revisions/${revision.id}/status`,
      { method: "POST", body: JSON.stringify({ action, ...extra }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "submit"
        ? `بازنگری ${revision.revisionNo} ارسال شد و در صف تأیید قرار گرفت.`
        : action === "start_review"
          ? `بررسی بازنگری ${revision.revisionNo} آغاز شد.`
          : `بازنگری ${revision.revisionNo} بسته شد.`,
    );
    await refresh(data.submittal.id);
  }

  async function removeSubmittal(row: SubmittalSummary) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/submittals/${row.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("سابمیتال حذف شد.");
    await refresh(null);
  }

  async function removeRevision(revision: SubmittalRevision) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/submittal-revisions/${revision.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(`بازنگری ${revision.revisionNo} حذف شد.`);
    await refresh(selectedId);
  }

  if (!submittals) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="سابمیتال‌ها" value="—" />
          <KpiCard label="منتظر تأیید" value="—" />
          <KpiCard label="عقب‌افتاده" value="—" />
          <KpiCard label="بازنگری‌ها" value="—" />
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
        <KpiCard label="سابمیتال‌ها" value={n(submittals.length)} hint="در این نما" />
        <KpiCard label="منتظر تأیید" value={n(waiting)} hint="ارسال‌شده یا در حال بررسی" />
        <KpiCard
          label="عقب‌افتاده"
          value={n(overdue)}
          hint={overdue > 0 ? "مهلت بازبین گذشته" : "مهلت بازبین نگذشته"}
        />
        <KpiCard label="بازنگری‌ها" value={n(revisionCount)} hint="مجموع ارسال‌ها" />
      </KpiRow>

      <SectionCard
        title="دفتر سابمیتال‌ها"
        description="هر ردیف یک سابمیتال است و بازنگری جاری آن؛ تاریخچهٔ کامل ارسال‌ها پایین همین صفحه می‌آید."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreating((open) => !open)}>
              <PlusIcon className="size-4" aria-hidden />
              سابمیتال جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {creating ? (
          <SubmittalForm
            projectId={projectId}
            lookups={lookups}
            onClose={() => setCreating(false)}
            onError={fail}
            onSaved={async (submittalId) => {
              setCreating(false);
              setNotice("سابمیتال ثبت شد؛ فایل بازنگری ۱ را بگذارید و بعد آن را ارسال کنید.");
              await refresh(submittalId);
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <div className="w-full sm:w-52">
            <SelectField
              label="وضعیت بازنگری جاری"
              value={statusFilter}
              onChange={(next) => setStatusFilter(next as SubmittalStatus | "")}
              options={Object.keys(SUBMITTAL_STATUS_LABELS) as SubmittalStatus[]}
              labels={SUBMITTAL_STATUS_LABELS}
              includeAll
              allLabel="همه"
            />
          </div>
          <div className="min-w-48 flex-1">
            <Field label="جست‌وجو" hint="در شماره، عنوان و بخش مشخصات">
              <input
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="مثلاً اسکلت"
              />
            </Field>
          </div>
        </div>

        {submittals.length === 0 ? (
          <EmptyState icon={FileStackIcon} title="سابمیتالی با این فیلترها نیست">
            هر مدرکی که برای تأیید ارسال می‌شود یک سابمیتال است: شماره، نوع و بخش مشخصات را ثبت کنید،
            فایل بازنگری اول را بگذارید و آن را ارسال کنید.
          </EmptyState>
        ) : (
          <DataTable caption={`دفتر سابمیتال‌ها — ${n(submittals.length)} مورد`} tableClassName="min-w-[58rem]">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>عنوان</Th>
                <Th>نوع</Th>
                <Th>بخش مشخصات</Th>
                <Th>مسئول</Th>
                <Th>بازنگری</Th>
                <Th>مهلت بازبین</Th>
                <Th> </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {submittals.map((row) => (
                <DataTableRow key={row.id} className={row.id === selectedId ? "bg-muted/40" : undefined}>
                  <Td className="font-medium tabular-nums">{row.submittalNumber}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-right underline-offset-4 hover:underline"
                      onClick={() => {
                        setSelectedId(row.id);
                        void loadDetail(row.id);
                      }}
                    >
                      {row.title}
                    </button>
                    {row.attachmentCount > 0 ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <PaperclipIcon className="size-3" aria-hidden />
                        {n(row.attachmentCount)} پیوست
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-muted-foreground">{row.submissionTypeLabel}</Td>
                  <Td className="tabular-nums text-muted-foreground">{row.specSection || "—"}</Td>
                  <Td className="text-muted-foreground">{row.responsiblePartyName || "—"}</Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">
                        {row.latestRevisionNo === null ? "—" : n(row.latestRevisionNo)}
                      </span>
                      {row.latestRevisionStatus && row.latestRevisionStatusLabel ? (
                        <StatusBadge tone={STATUS_TONES[row.latestRevisionStatus]}>
                          {row.latestRevisionStatusLabel}
                        </StatusBadge>
                      ) : null}
                    </span>
                  </Td>
                  <Td>
                    {row.isOverdue ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
                        <AlertTriangleIcon className="size-3.5" aria-hidden />
                        <DateCell date={row.latestRevisionDueDate} relative={false} className="text-xs" />
                      </span>
                    ) : (
                      <DateCell date={row.latestRevisionDueDate} relative={false} className="text-xs" />
                    )}
                  </Td>
                  <Td>
                    {canManage ? (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                          aria-label="ویرایش سابمیتال"
                          onClick={() => setEditing(row)}
                        >
                          <PencilIcon className="size-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                          aria-label="حذف سابمیتال"
                          onClick={() => void removeSubmittal(row)}
                        >
                          <Trash2Icon className="size-4" aria-hidden />
                        </button>
                      </span>
                    ) : null}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {editing ? (
        <SubmittalForm
          key={editing.id}
          projectId={projectId}
          submittal={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async () => {
            setEditing(null);
            setNotice("سابمیتال ویرایش شد.");
            await refresh(selectedId);
          }}
        />
      ) : null}

      {detail ? (
        <SectionCard
          title={`بازنگری‌های «${detail.submittalNumber} — ${detail.title}»`}
          description="ترتیب از نو به قدیم است. آنچه یک بازبین دیده تغییر نمی‌کند؛ راه اصلاح، بازنگری بعدی است."
          actions={
            canManage ? (
              <SecondaryButton onClick={() => setAddingRevision(true)}>
                <PlusIcon className="size-4" aria-hidden />
                بازنگری جدید
              </SecondaryButton>
            ) : null
          }
        >
          {detail.revisions.length === 0 ? (
            <EmptyState icon={ClipboardCheckIcon} title="هنوز بازنگری‌ای ثبت نشده است">
              بازنگری اول را ثبت کنید و فایلش را از کتابخانهٔ رسانه بگذارید.
            </EmptyState>
          ) : (
            <ol className="divide-y divide-border/80">
              {detail.revisions.map((revision) => (
                <li key={revision.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-20 font-semibold tabular-nums">بازنگری {n(revision.revisionNo)}</span>
                    <StatusBadge tone={STATUS_TONES[revision.status]}>
                      {revision.statusLabel}
                    </StatusBadge>
                    {revision.fileName ? (
                      revision.workspaceDocumentId ? (
                        <a
                          className="inline-flex items-center gap-1 text-xs text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                          href={mediaFileUrl(revision.workspaceDocumentId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <PaperclipIcon className="size-3" aria-hidden />
                          {revision.fileName}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">{revision.fileName}</span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">بدون فایل</span>
                    )}
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {[
                        revision.submittedByName ? `ارسال: ${revision.submittedByName}` : "",
                        revision.submittedAt ? revision.submittedAt.slice(0, 10) : "",
                        revision.reviewerName ? `بازبین: ${revision.reviewerName}` : "",
                        revision.dueDate ? `مهلت: ${revision.dueDate}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {revision.isOverdue ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
                        <AlertTriangleIcon className="size-3.5" aria-hidden />
                        مهلت گذشته
                      </span>
                    ) : null}

                    {canManage ? (
                      <span className="flex items-center gap-1">
                        {revision.isEditable ? (
                          <>
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                              aria-label="ویرایش بازنگری"
                              onClick={() => setEditingRevision(revision)}
                            >
                              <PencilIcon className="size-4" aria-hidden />
                            </button>
                            {revision.revisionNo > 1 ? (
                              <button
                                type="button"
                                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                                aria-label="حذف بازنگری"
                                onClick={() => void removeRevision(revision)}
                              >
                                <Trash2Icon className="size-4" aria-hidden />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-muted dark:text-amber-400"
                              onClick={() => setSubmitting(revision)}
                            >
                              <span className="flex items-center gap-1">
                                <SendIcon className="size-3.5" aria-hidden />
                                ارسال
                              </span>
                            </button>
                          </>
                        ) : null}
                        {canApprove && revision.status === "submitted" ? (
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-muted dark:text-amber-400"
                            onClick={() => void reviewAction(revision, "start_review")}
                          >
                            شروع بررسی
                          </button>
                        ) : null}
                        {canApprove && revision.status === "under_review" ? (
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-muted dark:text-amber-400"
                            onClick={() => setDeciding(revision)}
                          >
                            ثبت نظر
                          </button>
                        ) : null}
                        {canApprove &&
                        (revision.status === "approved" ||
                          revision.status === "approved_with_comments" ||
                          revision.status === "rejected") ? (
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-muted dark:text-emerald-400"
                            onClick={() => void reviewAction(revision, "close")}
                          >
                            بستن
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>

                  {revision.response ? (
                    <p className="flex flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-muted/30 px-3 py-2 text-xs">
                      <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                      <span className="whitespace-pre-wrap">{revision.response}</span>
                      {revision.decidedByName ? (
                        <span className="text-muted-foreground">— {revision.decidedByName}</span>
                      ) : null}
                      {revision.decidedAt ? (
                        <span className="text-muted-foreground">{revision.decidedAt.slice(0, 10)}</span>
                      ) : null}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      ) : null}

      {addingRevision ? (
        <RevisionDialog
          submittal={detail}
          media={lookups.media}
          onClose={() => setAddingRevision(false)}
          onError={fail}
          onSaved={async () => {
            setAddingRevision(false);
            setNotice("بازنگری جدید ساخته شد؛ فایلش را بگذارید و ارسال کنید.");
            await refresh(selectedId);
          }}
        />
      ) : null}

      {editingRevision && detail ? (
        <RevisionDialog
          key={editingRevision.id}
          submittal={detail}
          revision={editingRevision}
          media={lookups.media}
          onClose={() => setEditingRevision(null)}
          onError={fail}
          onSaved={async () => {
            setEditingRevision(null);
            setNotice("بازنگری ویرایش شد.");
            await refresh(selectedId);
          }}
        />
      ) : null}

      {submitting ? (
        <SubmitDialog
          revision={submitting}
          submittal={detail}
          lookups={lookups}
          onClose={() => setSubmitting(null)}
          onError={fail}
          onSaved={async () => {
            setSubmitting(null);
            await refresh(selectedId);
          }}
        />
      ) : null}

      {deciding ? (
        <DecideDialog
          revision={deciding}
          submittalNumber={detail?.submittalNumber ?? ""}
          onClose={() => setDeciding(null)}
          onError={fail}
          onSaved={async () => {
            setDeciding(null);
            await refresh(selectedId);
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Register the submittal
 * ------------------------------------------------------------------------- */

function SubmittalForm({
  projectId,
  submittal,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  submittal?: SubmittalSummary;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: (submittalId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [submittalNumber, setSubmittalNumber] = useState(submittal?.submittalNumber ?? "");
  const [title, setTitle] = useState(submittal?.title ?? "");
  const [submissionType, setSubmissionType] = useState<SubmittalType>(
    submittal?.submissionType ?? "shop_drawing",
  );
  const [specSection, setSpecSection] = useState(submittal?.specSection ?? "");
  const [discipline, setDiscipline] = useState(submittal?.discipline ?? "");
  const [responsiblePartyId, setResponsiblePartyId] = useState(submittal?.responsiblePartyId ?? "");
  const [responseRequiredBy, setResponseRequiredBy] = useState(submittal?.responseRequiredBy ?? "");
  const [documentId, setDocumentId] = useState(submittal?.documentId ?? "");
  const [notes, setNotes] = useState(submittal?.notes ?? "");
  const [drawings, setDrawings] = useState<Array<{ id: string; label: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ drawings: Array<{ id: string; documentNumber: string; title: string }> }>(
      `/api/aec/projects/${projectId}/documents`,
    ).then(({ ok, data }) => {
      if (ok) {
        setDrawings(
          data.drawings.map((drawing) => ({
            id: drawing.id,
            label: `${drawing.documentNumber} — ${drawing.title}`,
          })),
        );
      }
    });
  }, [projectId]);

  async function submit() {
    if (!submittalNumber.trim() || !title.trim() || saving) return;
    setSaving(true);
    const body = {
      submittalNumber,
      title,
      submissionType,
      specSection,
      discipline: discipline || null,
      responsiblePartyId: responsiblePartyId || null,
      responseRequiredBy: responseRequiredBy || null,
      documentId: documentId || null,
      notes,
    };
    const { ok, data } = submittal
      ? await api<{ submittal: SubmittalSummary }>(`/api/aec/submittals/${submittal.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ submittal: SubmittalSummary }>(`/api/aec/projects/${projectId}/submittals`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.submittal.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {submittal ? "ویرایش سابمیتال" : "ثبت سابمیتال"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="شمارهٔ سابمیتال" hint="مثلاً SUB-014">
            <input
              className={inputClass}
              value={submittalNumber}
              onChange={(event) => setSubmittalNumber(event.target.value)}
              autoFocus
            />
          </Field>
          <SelectField
            label="نوع ارسال"
            value={submissionType}
            onChange={(next) => setSubmissionType((next || "shop_drawing") as SubmittalType)}
            options={SUBMITTAL_TYPES}
            labels={SUBMITTAL_TYPE_LABELS}
          />
          <div className="sm:col-span-2">
            <Field label="عنوان">
              <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
          </div>
          <Field label="بخش مشخصات" hint="مثلاً 05 12 00 — اختیاری">
            <input
              className={inputClass}
              value={specSection}
              onChange={(event) => setSpecSection(event.target.value)}
            />
          </Field>
          <SelectField
            label="رشته"
            value={(discipline || "") as AecSpecialty | ""}
            onChange={(next) => setDiscipline(next)}
            options={AEC_SPECIALTIES}
            labels={AEC_SPECIALTY_LABELS}
            includeAll
            allLabel="— بدون رشته —"
          />
          <PickerField
            label="طرف مسئول"
            value={responsiblePartyId}
            onChange={setResponsiblePartyId}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
            placeholder="— انتخاب نشده —"
          />
          <PickerField
            label="سند مرجع"
            value={documentId}
            onChange={setDocumentId}
            options={drawings}
            placeholder="— بدون سند —"
            hint="مشخصات یا نقشه‌ای که این ارسال پاسخ آن است."
          />
          <DateField
            label="مهلت پاسخ بازبین"
            value={responseRequiredBy}
            onChange={setResponseRequiredBy}
          />
          <div className="sm:col-span-2">
            <Field label="یادداشت">
              <textarea
                className={inputClass}
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            بعد از اینکه بازنگری‌ای ارسال شد، شماره، نوع و بخش مشخصات این سابمیتال قفل می‌شوند — آنچه
            ارزیابی شده نباید بعد از ارزیابی عوض شود.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving || !submittalNumber.trim() || !title.trim()}>
            {saving ? "در حال ذخیره" : "ذخیره"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A revision's file and dates
 * ------------------------------------------------------------------------- */

function RevisionDialog({
  submittal,
  revision,
  media,
  onClose,
  onSaved,
  onError,
}: {
  submittal: SubmittalDetail | null;
  revision?: SubmittalRevision;
  media: Array<{ id: string; fileName: string }>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [mediaAssetId, setMediaAssetId] = useState("");
  const [dueDate, setDueDate] = useState(revision?.dueDate ?? "");
  const [reviewerUserId, setReviewerUserId] = useState(revision?.reviewerUserId ?? "");
  const [reviewerName, setReviewerName] = useState(revision?.reviewerName ?? "");
  const [notes, setNotes] = useState(revision?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<Array<{ id: string; fullName: string }>>([]);

  useEffect(() => {
    api<{ members: Array<{ id: string; fullName: string }> }>("/api/workspace/lookups").then(
      ({ ok, data }) => {
        if (ok) setMembers(data.members);
      },
    );
  }, []);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      dueDate: dueDate || null,
      reviewerUserId: reviewerUserId || null,
      reviewerName,
      notes,
    };
    if (mediaAssetId) body.mediaAssetId = mediaAssetId;
    const { ok, data } = revision
      ? await api<{ submittal: SubmittalDetail }>(`/api/aec/submittal-revisions/${revision.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ submittal: SubmittalDetail }>(`/api/aec/submittals/${submittal?.id}/revisions`, {
          method: "POST",
          body: JSON.stringify(body),
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
      <div className={`${overlayPanelClass} w-full max-w-xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {revision ? `ویرایش بازنگری ${revision.revisionNo}` : "بازنگری جدید"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <PickerField
            label="فایل از کتابخانهٔ رسانه"
            value={mediaAssetId}
            onChange={setMediaAssetId}
            options={media.map((asset) => ({ id: asset.id, label: asset.fileName }))}
            placeholder={revision ? "— بدون تغییر —" : "— بدون فایل —"}
            hint="بارگذاری فایل در بخش «رسانه» انجام می‌شود."
          />
          <DateField label="مهلت بازبین" value={dueDate} onChange={setDueDate} />
          <PickerField
            label="بازبین"
            value={reviewerUserId}
            onChange={setReviewerUserId}
            options={members.map((member) => ({ id: member.id, label: member.fullName }))}
            placeholder="— هنوز مشخص نشده —"
          />
          <Field label="نام بازبین (اگر کاربر سیستم نیست)" hint="اختیاری">
            <input
              className={inputClass}
              value={reviewerName}
              onChange={(event) => setReviewerName(event.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="یادداشت بازنگری">
              <textarea
                className={inputClass}
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            فقط بازنگری پیش‌نویس قابل ویرایش است. بعد از «ارسال»، فایل و مهلت آن قفل می‌شوند و راه اصلاح،
            بازنگری بعدی است.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving}>
            {saving ? "در حال ذخیره" : "ذخیره"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Submit for review
 * ------------------------------------------------------------------------- */

function SubmitDialog({
  revision,
  submittal,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  revision: SubmittalRevision;
  submittal: SubmittalDetail | null;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [approverUserId, setApproverUserId] = useState("");
  const [dueDate, setDueDate] = useState(revision.dueDate ?? submittal?.responseRequiredBy ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const { ok, data } = await api<{ submittal: SubmittalDetail }>(
      `/api/aec/submittal-revisions/${revision.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "submit",
          approverUserId: approverUserId || null,
          dueDate: dueDate || null,
          note,
        }),
      },
    );
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-lg`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            ارسال بازنگری {toPersianDigits(String(revision.revisionNo))} برای بررسی
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
            با ارسال، این بازنگری قفل می‌شود و یک درخواست تأیید در «میز کار من» ثبت می‌شود؛ تصمیم بعدی از
            همان‌جا یا از همین صفحه ثبت می‌شود.
          </p>
          <PickerField
            label="بازبین"
            value={approverUserId}
            onChange={setApproverUserId}
            options={lookups.members.map((member) => ({ id: member.id, label: member.fullName }))}
            placeholder="— بدون بازبین مشخص —"
            hint="خالی بگذارید تا هر صاحب دسترسی تأیید بتواند تصمیم بگیرد."
          />
          <DateField label="مهلت پاسخ بازبین" value={dueDate} onChange={setDueDate} />
          <Field label="یادداشت" hint="اختیاری — همراه درخواست ثبت می‌شود.">
            <textarea
              className={inputClass}
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving}>
            {saving ? "در حال ارسال" : "ارسال برای بررسی"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The determination
 * ------------------------------------------------------------------------- */

function DecideDialog({
  revision,
  submittalNumber,
  onClose,
  onSaved,
  onError,
}: {
  revision: SubmittalRevision;
  submittalNumber: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [decision, setDecision] = useState<SubmittalDecision>("approved_with_comments");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const { ok, data } = await api<{ submittal: SubmittalDetail }>(
      `/api/aec/submittal-revisions/${revision.id}/status`,
      { method: "POST", body: JSON.stringify({ action: "decide", decision, note }) },
    );
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            نظر بازبین — {submittalNumber} (بازنگری {toPersianDigits(String(revision.revisionNo))})
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">نتیجهٔ بررسی</p>
            <div className="flex flex-wrap gap-2">
              {SUBMITTAL_DECISIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={
                    option === decision
                      ? "rounded-full bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
                      : "rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/70"
                  }
                  onClick={() => setDecision(option)}
                >
                  {SUBMITTAL_DECISION_LABELS[option]}
                </button>
              ))}
            </div>
            {decision === "revise_and_resubmit" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                با ثبت این نتیجه، بازنگری بعدی همین حالا به‌صورت پیش‌نویس ساخته می‌شود.
              </p>
            ) : null}
          </div>
          <Field label="شرح نظر" hint="این متن در تاریخچهٔ تأیید ثبت می‌شود.">
            <textarea
              className={inputClass}
              rows={4}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving}>
            {saving ? "در حال ثبت" : "ثبت نظر"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
