"use client";

/**
 * Issue #799 §9 and §12 on screen — «نقشه‌ها و اسناد»: the drawing register and
 * the transmittals that issue revisions.
 *
 * The tab answers three questions in the order a document controller asks them,
 * and one click apart:
 *
 *   1. what is on this project — the register, one row per document with its
 *      current revision;
 *   2. what happened to that document — its whole revision history, including
 *      which transmittal each revision went out on;
 *   3. what was sent, and did it arrive — the transmittals, their lines, their
 *      recipients and their receipts.
 *
 * ## What the screen is careful about
 *
 *   * **An issued revision is read-only, and says so.** The lock is migration
 *     0197's, and the screen simply stops offering the buttons — no control that
 *     looks pressable and then fails.
 *   * **Issuing asks for the right permission.** Drafting rides
 *     `workspace.manage`; the issue button exists only for a member with
 *     `workspace.documents_issue`, because issuing is the act that freezes the
 *     record (issue #24's rule: an irreversible act is not ordinary task-edit
 *     access).
 *   * **Files come from the Media Library.** A revision either links a document
 *     that already exists or creates one from an uploaded asset; the register
 *     never uploads bytes itself.
 *   * **Dates are Shamsi on screen and Gregorian in the database**, like every
 *     other date in the product: `DateField` is the shared Jalali picker and the
 *     API only ever sees `YYYY-MM-DD`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileStackIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  PencilIcon,
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
import { formatJalali } from "@/lib/jalali";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  ISSUE_PURPOSES,
  ISSUE_PURPOSE_LABELS,
  type DocumentType,
  type IssuePurpose,
  type RevisionStatus,
  type TransmittalStatus,
} from "@/lib/aec-docs";
import { AEC_SPECIALTIES, AEC_SPECIALTY_LABELS, type AecSpecialty } from "@/lib/aec";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateField, DateCell, PickerField, SelectField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface RevisionTransmittalRef {
  id: string;
  transmittalNumber: string;
  status: TransmittalStatus;
  statusLabel: string;
  issueDate: string | null;
  purpose: IssuePurpose;
  purposeLabel: string;
}

interface DrawingRevision {
  id: string;
  documentId: string;
  revisionNo: number;
  revisionCode: string;
  revisionDate: string | null;
  issuePurpose: IssuePurpose;
  issuePurposeLabel: string;
  status: RevisionStatus;
  statusLabel: string;
  isEditable: boolean;
  preparedByName: string;
  checkedByName: string;
  approvedByName: string;
  notes: string;
  workspaceDocumentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  issuedAt: string | null;
  issuedByName: string;
  createdAt: string;
  createdByName: string;
  transmittals: RevisionTransmittalRef[];
}

interface DrawingSummary {
  id: string;
  projectId: string;
  documentNumber: string;
  drawingNumber: string;
  title: string;
  documentType: DocumentType;
  documentTypeLabel: string;
  discipline: string | null;
  disciplineLabel: string;
  notes: string;
  latestRevisionId: string | null;
  latestRevisionNo: number | null;
  latestRevisionCode: string;
  latestRevisionStatus: RevisionStatus | null;
  latestRevisionStatusLabel: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
}

interface DrawingDetail extends DrawingSummary {
  revisions: DrawingRevision[];
}

interface TransmittalItem {
  id: string;
  revisionId: string;
  documentId: string;
  documentNumber: string;
  documentTitle: string;
  revisionCode: string;
  issuePurpose: IssuePurpose;
  issuePurposeLabel: string;
  note: string;
  revisionStatus: RevisionStatus;
  revisionStatusLabel: string;
}

interface TransmittalRecipient {
  id: string;
  partyId: string;
  partyName: string;
  requiresAcknowledgement: boolean;
  acknowledgedAt: string | null;
  acknowledgedByName: string;
  note: string;
}

interface TransmittalSummary {
  id: string;
  projectId: string;
  transmittalNumber: string;
  subject: string;
  senderPartyId: string | null;
  senderPartyName: string | null;
  issueDate: string | null;
  purpose: IssuePurpose;
  purposeLabel: string;
  status: TransmittalStatus;
  statusLabel: string;
  itemCount: number;
  recipientCount: number;
  pendingAcknowledgements: number;
  issuedAt: string | null;
  issuedByName: string;
  acknowledgedAt: string | null;
  createdAt: string;
  createdByName: string;
}

interface TransmittalDetail extends TransmittalSummary {
  comments: string;
  items: TransmittalItem[];
  recipients: TransmittalRecipient[];
}

const REVISION_TONES: Record<RevisionStatus, "positive" | "active" | "neutral"> = {
  draft: "neutral",
  issued: "positive",
  superseded: "neutral",
};

const TRANSMITTAL_TONES: Record<TransmittalStatus, "positive" | "active" | "neutral"> = {
  draft: "neutral",
  issued: "active",
  acknowledged: "positive",
};

const DISCIPLINE_OPTIONS = AEC_SPECIALTIES.map((key) => ({
  key: key as string,
  label: AEC_SPECIALTY_LABELS[key as AecSpecialty],
}));

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecDocumentsTab({
  projectId,
  canManage,
  canIssueDocuments,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  canIssueDocuments: boolean;
  lookups: WorkspaceLookups;
}) {
  const [drawings, setDrawings] = useState<DrawingSummary[] | null>(null);
  const [transmittals, setTransmittals] = useState<TransmittalSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DrawingDetail | null>(null);
  const [openTransmittal, setOpenTransmittal] = useState<TransmittalDetail | null>(null);
  const [creatingDrawing, setCreatingDrawing] = useState(false);
  const [editingDrawing, setEditingDrawing] = useState<DrawingSummary | null>(null);
  const [revisionFor, setRevisionFor] = useState<{ drawing: DrawingSummary; revision: DrawingRevision | null } | null>(
    null,
  );
  const [transmittalForm, setTransmittalForm] = useState<{ detail: TransmittalDetail | null } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = (code: string | undefined) => setError(workspaceError(code));

  const loadRegister = useCallback(
    async (preferId?: string | null) => {
      const { ok, data } = await api<{ drawings: DrawingSummary[]; transmittals: TransmittalSummary[] }>(
        `/api/aec/projects/${projectId}/documents`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setDrawings([]);
        return null;
      }
      setDrawings(data.drawings);
      setTransmittals(data.transmittals);
      const next =
        data.drawings.find((drawing) => drawing.id === preferId) ?? data.drawings[0] ?? null;
      setSelectedId(next ? next.id : null);
      return next;
    },
    [projectId],
  );

  const loadDetail = useCallback(async (drawingId: string) => {
    const { ok, data } = await api<{ drawing: DrawingDetail }>(`/api/aec/documents/${drawingId}`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setDetail(null);
      return;
    }
    setDetail(data.drawing);
  }, []);

  const refresh = useCallback(
    async (preferId?: string | null) => {
      const next = await loadRegister(preferId);
      if (next) await loadDetail(next.id);
      else setDetail(null);
    },
    [loadRegister, loadDetail],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingDrafts = useMemo(
    () => (detail?.revisions ?? []).filter((revision) => revision.status === "draft").length,
    [detail],
  );
  const awaitingAcknowledgement = useMemo(
    () =>
      transmittals
        .filter((row) => row.status === "issued" && row.pendingAcknowledgements > 0)
        .reduce((total, row) => total + row.pendingAcknowledgements, 0),
    [transmittals],
  );

  async function openTransmittalDetail(id: string) {
    setError("");
    const { ok, data } = await api<{ transmittal: TransmittalDetail }>(`/api/aec/transmittals/${id}`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setOpenTransmittal(data.transmittal);
  }

  async function issueTransmittal(detail: TransmittalDetail) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ transmittal: TransmittalDetail }>(
      `/api/aec/transmittals/${detail.id}/status`,
      { method: "POST", body: JSON.stringify({ action: "issue" }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setOpenTransmittal(data.transmittal);
    setNotice(
      `برگهٔ ارسال ${data.transmittal.transmittalNumber} صادر شد و بازنگری‌های آن قفل شدند.`,
    );
    await refresh(selectedId);
  }

  async function acknowledge(detail: TransmittalDetail, recipientId: string, name: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ transmittal: TransmittalDetail }>(
      `/api/aec/transmittals/${detail.id}/status`,
      { method: "POST", body: JSON.stringify({ action: "acknowledge", recipientId, acknowledgedByName: name }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setOpenTransmittal(data.transmittal);
    setNotice(
      data.transmittal.status === "acknowledged"
        ? "همهٔ رسیدهای لازم ثبت شد؛ برگهٔ ارسال «رسید تأییدشده» شد."
        : "رسید ثبت شد.",
    );
    await refresh(selectedId);
  }

  async function removeDrawing(drawing: DrawingSummary) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/documents/${drawing.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("سند از دفتر نقشه‌ها حذف شد.");
    await refresh(null);
  }

  async function removeRevision(revision: DrawingRevision) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/revisions/${revision.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("بازنگری پیش‌نویس حذف شد.");
    await refresh(selectedId);
  }

  if (!drawings) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="اسناد ثبت‌شده" value="—" />
          <KpiCard label="بازنگری پیش‌نویس" value="—" />
          <KpiCard label="برگهٔ ارسال" value="—" />
          <KpiCard label="منتظر رسید" value="—" />
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
        <KpiCard label="اسناد ثبت‌شده" value={n(drawings.length)} />
        <KpiCard
          label="بازنگری پیش‌نویس"
          value={n(pendingDrafts)}
          hint={detail ? `سند ${detail.documentNumber}` : "سند انتخاب‌شده"}
        />
        <KpiCard label="برگهٔ ارسال" value={n(transmittals.length)} />
        <KpiCard
          label="منتظر رسید"
          value={n(awaitingAcknowledgement)}
          hint="گیرندگان تأییدنشده"
        />
      </KpiRow>

      <SectionCard
        title="دفتر نقشه‌ها و اسناد"
        description="هر سند یک شماره دارد و بازنگری‌های آن به ترتیب ثبت می‌شوند؛ آخرین بازنگری همان است که در ستون «آخرین بازنگری» می‌بینید."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreatingDrawing((open) => !open)}>
              <PlusIcon className="size-4" aria-hidden />
              سند جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {creatingDrawing ? (
          <DrawingForm
            onClose={() => setCreatingDrawing(false)}
            onError={fail}
            onSaved={async (drawingId) => {
              setCreatingDrawing(false);
              setNotice("سند در دفتر ثبت شد. حالا بازنگری اول را ثبت کنید.");
              await refresh(drawingId);
            }}
            projectId={projectId}
          />
        ) : null}

        {drawings.length === 0 ? (
          <EmptyState icon={FileStackIcon} title="هنوز سندی ثبت نشده است">
            با «سند جدید» یک شماره در دفتر رزرو کنید، سپس بازنگری‌ها و برگه‌های ارسال را ثبت کنید.
          </EmptyState>
        ) : (
          <DataTable
            caption={`دفتر نقشه‌ها و اسناد — ${n(drawings.length)} سند`}
            tableClassName="min-w-[54rem]"
          >
            <DataTableHead>
              <DataTableRow>
                <Th>شمارهٔ سند</Th>
                <Th>عنوان</Th>
                <Th>نوع</Th>
                <Th>رشته</Th>
                <Th>آخرین بازنگری</Th>
                <Th>تاریخ</Th>
                <Th>بازنگری‌ها</Th>
                <Th> </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {drawings.map((drawing) => (
                <DataTableRow
                  key={drawing.id}
                  className={drawing.id === selectedId ? "bg-muted/40" : undefined}
                >
                  <Td className="font-medium tabular-nums">{drawing.documentNumber}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-right underline-offset-4 hover:underline"
                      onClick={() => {
                        setSelectedId(drawing.id);
                        void loadDetail(drawing.id);
                      }}
                    >
                      {drawing.title}
                    </button>
                    {drawing.drawingNumber ? (
                      <span className="block text-xs text-muted-foreground">
                        نقشه: {drawing.drawingNumber}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-muted-foreground">{drawing.documentTypeLabel}</Td>
                  <Td className="text-muted-foreground">{drawing.disciplineLabel}</Td>
                  <Td>
                    {drawing.latestRevisionCode ? (
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{drawing.latestRevisionCode}</span>
                        {drawing.latestRevisionStatus && drawing.latestRevisionStatusLabel ? (
                          <StatusBadge tone={REVISION_TONES[drawing.latestRevisionStatus]}>
                            {drawing.latestRevisionStatusLabel}
                          </StatusBadge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">بدون بازنگری</span>
                    )}
                  </Td>
                  <Td>
                    <DateCell date={drawing.updatedAt.slice(0, 10)} className="text-xs" />
                  </Td>
                  <Td className="tabular-nums">{n(drawing.revisionCount)}</Td>
                  <Td>
                    {canManage ? (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                          aria-label="ویرایش سند"
                          onClick={() => setEditingDrawing(drawing)}
                        >
                          <PencilIcon className="size-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                          aria-label="حذف سند"
                          onClick={() => void removeDrawing(drawing)}
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

      {editingDrawing ? (
        <DrawingForm
          drawing={editingDrawing}
          onClose={() => setEditingDrawing(null)}
          onError={fail}
          onSaved={async () => {
            setEditingDrawing(null);
            setNotice("سند ویرایش شد.");
            await refresh(selectedId);
          }}
          projectId={projectId}
        />
      ) : null}

      {detail ? (
        <SectionCard
          title={`بازنگری‌های «${detail.documentNumber} — ${detail.title}»`}
          description="ترتیب از نو به قدیم است؛ آخرین بازنگری، بازنگری جاری این سند است."
          actions={
            canManage ? (
              <SecondaryButton onClick={() => setRevisionFor({ drawing: detail, revision: null })}>
                <PlusIcon className="size-4" aria-hidden />
                بازنگری جدید
              </SecondaryButton>
            ) : null
          }
        >
          {detail.revisions.length === 0 ? (
            <EmptyState icon={PaperclipIcon} title="هنوز بازنگری‌ای ثبت نشده است">
              بازنگری اول را با شماره و کد آن ثبت کنید؛ فایل می‌تواند از کتابخانهٔ رسانه بیاید.
            </EmptyState>
          ) : (
            <ol className="divide-y divide-border/80">
              {detail.revisions.map((revision) => (
                <li key={revision.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                  <span className="w-16 font-semibold tabular-nums">{revision.revisionCode}</span>
                  <span className="w-24 text-xs text-muted-foreground">
                    <DateCell date={revision.revisionDate} relative={false} className="text-xs" />
                  </span>
                  <span className="min-w-24 text-xs text-muted-foreground">
                    {revision.issuePurposeLabel}
                  </span>
                  <StatusBadge tone={REVISION_TONES[revision.status]}>
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
                      revision.preparedByName ? `تهیه: ${revision.preparedByName}` : "",
                      revision.checkedByName ? `بررسی: ${revision.checkedByName}` : "",
                      revision.approvedByName ? `تأیید: ${revision.approvedByName}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {revision.transmittals.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <SendIcon className="size-3" aria-hidden />
                      {revision.transmittals.map((ref) => (
                        <button
                          key={ref.id}
                          type="button"
                          className="rounded-full bg-muted px-2 py-0.5 underline-offset-2 hover:underline"
                          onClick={() => void openTransmittalDetail(ref.id)}
                        >
                          {ref.transmittalNumber}
                        </button>
                      ))}
                    </span>
                  ) : null}
                  {canManage && revision.isEditable ? (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                        aria-label="ویرایش بازنگری"
                        onClick={() => setRevisionFor({ drawing: detail, revision })}
                      >
                        <PencilIcon className="size-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                        aria-label="حذف بازنگری"
                        onClick={() => void removeRevision(revision)}
                      >
                        <Trash2Icon className="size-4" aria-hidden />
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      ) : null}

      {revisionFor ? (
        <RevisionDialog
          key={revisionFor.revision?.id ?? "new"}
          drawing={revisionFor.drawing}
          revision={revisionFor.revision}
          media={lookups.media}
          onClose={() => setRevisionFor(null)}
          onError={fail}
          onSaved={async () => {
            setRevisionFor(null);
            setNotice("بازنگری ثبت شد.");
            await refresh(selectedId);
          }}
        />
      ) : null}

      <SectionCard
        title="برگه‌های ارسال"
        description="هر برگهٔ ارسال می‌گوید چه سندی، در کدام بازنگری، برای چه کسی و در چه تاریخی فرستاده شده است."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setTransmittalForm({ detail: null })}>
              <PlusIcon className="size-4" aria-hidden />
              برگهٔ ارسال جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {transmittals.length === 0 ? (
          <EmptyState icon={SendIcon} title="هنوز برگهٔ ارسالی ثبت نشده است">
            با ثبت یک برگهٔ ارسال، بازنگری‌های انتخاب‌شده «صادرشده» می‌شوند و دیگر تغییر نمی‌کنند.
          </EmptyState>
        ) : (
          <DataTable
            caption={`برگه‌های ارسال — ${n(transmittals.length)} برگه`}
            tableClassName="min-w-[52rem]"
          >
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>موضوع</Th>
                <Th>فرستنده</Th>
                <Th>تاریخ صدور</Th>
                <Th>وضعیت</Th>
                <Th>اسناد</Th>
                <Th>گیرندگان</Th>
                <Th> </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {transmittals.map((row) => (
                <DataTableRow key={row.id}>
                  <Td className="font-medium tabular-nums">{row.transmittalNumber}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-right underline-offset-4 hover:underline"
                      onClick={() => void openTransmittalDetail(row.id)}
                    >
                      {row.subject || "—"}
                    </button>
                    <span className="block text-xs text-muted-foreground">{row.purposeLabel}</span>
                  </Td>
                  <Td className="text-muted-foreground">{row.senderPartyName ?? "خود ما"}</Td>
                  <Td className="text-xs">
                    <DateCell date={row.issueDate} relative={false} className="text-xs" />
                  </Td>
                  <Td>
                    <StatusBadge tone={TRANSMITTAL_TONES[row.status]}>{row.statusLabel}</StatusBadge>
                  </Td>
                  <Td className="tabular-nums">{n(row.itemCount)}</Td>
                  <Td>
                    <span className="tabular-nums">{n(row.recipientCount)}</span>
                    {row.status === "issued" && row.pendingAcknowledgements > 0 ? (
                      <span className="block text-xs text-amber-700 dark:text-amber-300">
                        {n(row.pendingAcknowledgements)} بدون رسید
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {canIssueDocuments && row.status === "draft" ? (
                      <PrimaryButton
                        onClick={() => void openTransmittalDetail(row.id)}
                        disabled={busy}
                      >
                        بازبینی و صدور
                      </PrimaryButton>
                    ) : (
                      <SecondaryButton onClick={() => void openTransmittalDetail(row.id)}>
                        مشاهده
                      </SecondaryButton>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {transmittalForm ? (
        <TransmittalDialog
          detail={transmittalForm.detail}
          drawings={drawings}
          lookups={lookups}
          projectId={projectId}
          onClose={() => setTransmittalForm(null)}
          onError={fail}
          onSaved={async (transmittal) => {
            setTransmittalForm(null);
            setNotice("برگهٔ ارسال ذخیره شد.");
            await refresh(selectedId);
            setOpenTransmittal(transmittal);
          }}
        />
      ) : null}

      {openTransmittal ? (
        <TransmittalDrawer
          busy={busy}
          canIssueDocuments={canIssueDocuments}
          canManage={canManage}
          detail={openTransmittal}
          onAcknowledge={acknowledge}
          onClose={() => setOpenTransmittal(null)}
          onEdit={() => setTransmittalForm({ detail: openTransmittal })}
          onIssue={issueTransmittal}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The register entry form
 * ------------------------------------------------------------------------- */

function DrawingForm({
  projectId,
  drawing,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  drawing?: DrawingSummary;
  onClose: () => void;
  onSaved: (drawingId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [documentNumber, setDocumentNumber] = useState(drawing?.documentNumber ?? "");
  const [drawingNumber, setDrawingNumber] = useState(drawing?.drawingNumber ?? "");
  const [title, setTitle] = useState(drawing?.title ?? "");
  const [documentType, setDocumentType] = useState<DocumentType>(drawing?.documentType ?? "drawing");
  const [discipline, setDiscipline] = useState(drawing?.discipline ?? "");
  const [notes, setNotes] = useState(drawing?.notes ?? "");
  const [saving, setSaving] = useState(false);

  // The phases of this project are the register's optional "related phase"; the
  // lookup endpoint already carries them for the project the tab is on.
  const [phases, setPhases] = useState<Array<{ id: string; label: string }>>([]);
  const [phaseId, setPhaseId] = useState("");

  useEffect(() => {
    api<{ phases: Array<{ id: string; name: string }> }>(`/api/workspace/projects/${projectId}`).then(
      ({ ok, data }) => {
        if (ok) setPhases(data.phases.map((phase) => ({ id: phase.id, label: phase.name })));
      },
    );
  }, [projectId]);

  async function submit() {
    if (!documentNumber.trim() || !title.trim() || saving) return;
    setSaving(true);
    const body = {
      documentNumber,
      drawingNumber,
      title,
      documentType,
      discipline,
      notes,
      phaseId: phaseId || null,
    };
    const { ok, data } = drawing
      ? await api<{ drawing: DrawingSummary }>(`/api/aec/documents/${drawing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ drawing: DrawingSummary }>(`/api/aec/projects/${projectId}/documents`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.drawing.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">{drawing ? "ویرایش سند" : "ثبت سند در دفتر"}</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="شمارهٔ سند" hint="مثلاً A-103">
            <input
              className={inputClass}
              value={documentNumber}
              onChange={(event) => setDocumentNumber(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="شمارهٔ نقشه" hint="اختیاری — سند بدون نقشه هم داریم">
            <input
              className={inputClass}
              value={drawingNumber}
              onChange={(event) => setDrawingNumber(event.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="عنوان">
              <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
          </div>
          <SelectField
            label="نوع سند"
            value={documentType}
            onChange={(next) => setDocumentType((next || "drawing") as DocumentType)}
            options={DOCUMENT_TYPES}
            labels={DOCUMENT_TYPE_LABELS}
          />
          <SelectField
            label="رشته"
            value={(discipline || "") as AecSpecialty | ""}
            onChange={(next) => setDiscipline(next)}
            options={DISCIPLINE_OPTIONS.map((option) => option.key as AecSpecialty)}
            labels={AEC_SPECIALTY_LABELS}
            includeAll
            allLabel="— بدون رشته —"
          />
          <PickerField
            label="فاز پروژه"
            value={phaseId}
            onChange={setPhaseId}
            options={phases}
            hint="اختیاری — سند به کدام فاز مربوط است."
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
            فایل هر بازنگری از «کتابخانهٔ رسانه» انتخاب می‌شود؛ خود سند فقط شناسنامهٔ آن است.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving || !documentNumber.trim() || !title.trim()}>
            {saving ? "در حال ذخیره" : "ذخیره"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A revision
 * ------------------------------------------------------------------------- */

function RevisionDialog({
  drawing,
  revision,
  media,
  onClose,
  onSaved,
  onError,
}: {
  drawing: DrawingSummary;
  revision: DrawingRevision | null;
  media: Array<{ id: string; fileName: string }>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [revisionCode, setRevisionCode] = useState(revision?.revisionCode ?? "");
  const [revisionDate, setRevisionDate] = useState(revision?.revisionDate ?? "");
  const [issuePurpose, setIssuePurpose] = useState<IssuePurpose>(revision?.issuePurpose ?? "wip");
  const [preparedByName, setPreparedByName] = useState(revision?.preparedByName ?? "");
  const [checkedByName, setCheckedByName] = useState(revision?.checkedByName ?? "");
  const [approvedByName, setApprovedByName] = useState(revision?.approvedByName ?? "");
  const [notes, setNotes] = useState(revision?.notes ?? "");
  const [mediaAssetId, setMediaAssetId] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (saving) return;
    setSaving(true);
    const body = {
      revisionCode: revisionCode.trim() || undefined,
      revisionDate: revisionDate || null,
      issuePurpose,
      preparedByName,
      checkedByName,
      approvedByName,
      notes,
      mediaAssetId: revision ? undefined : mediaAssetId || null,
    };
    const { ok, data } = revision
      ? await api(`/api/aec/revisions/${revision.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await api(`/api/aec/documents/${drawing.id}/revisions`, {
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
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {revision ? `ویرایش بازنگری ${revision.revisionCode}` : `بازنگری جدید — ${drawing.documentNumber}`}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="کد بازنگری" hint={revision ? undefined : "خالی بگذارید تا خودش A، B، C… بگذارد"}>
            <input
              className={inputClass}
              value={revisionCode}
              onChange={(event) => setRevisionCode(event.target.value)}
              placeholder="A"
              autoFocus
            />
          </Field>
          <DateField label="تاریخ بازنگری" value={revisionDate} onChange={setRevisionDate} />
          <SelectField
            label="جهت صدور"
            value={issuePurpose}
            onChange={(next) => setIssuePurpose((next || "wip") as IssuePurpose)}
            options={ISSUE_PURPOSES}
            labels={ISSUE_PURPOSE_LABELS}
          />
          {revision ? null : (
            <PickerField
              label="فایل از کتابخانهٔ رسانه"
              value={mediaAssetId}
              onChange={setMediaAssetId}
              options={media.map((asset) => ({ id: asset.id, label: asset.fileName }))}
              placeholder="— بدون فایل —"
              hint="بارگذاری فایل در بخش «رسانه» انجام می‌شود."
            />
          )}
          <Field label="تهیه‌کننده">
            <input
              className={inputClass}
              value={preparedByName}
              onChange={(event) => setPreparedByName(event.target.value)}
            />
          </Field>
          <Field label="بررسی‌کننده">
            <input
              className={inputClass}
              value={checkedByName}
              onChange={(event) => setCheckedByName(event.target.value)}
            />
          </Field>
          <Field label="تأییدکننده">
            <input
              className={inputClass}
              value={approvedByName}
              onChange={(event) => setApprovedByName(event.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="شرح تغییرات">
              <textarea
                className={inputClass}
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="مثلاً اعمال نظرات کارفرما روی پلان طبقهٔ سوم"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            بازنگری تا زمانی که صادر نشده قابل ویرایش است. با صدور برگهٔ ارسال، این بازنگری قفل می‌شود و
            بازنگری قبلی «منسوخ» می‌شود.
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
 * A transmittal
 * ------------------------------------------------------------------------- */

interface PickedLine {
  revisionId: string;
  label: string;
}

interface PickedRecipient {
  partyId: string;
  requiresAcknowledgement: boolean;
}

function TransmittalDialog({
  projectId,
  detail,
  drawings,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  detail: TransmittalDetail | null;
  drawings: DrawingSummary[];
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: (transmittal: TransmittalDetail) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [transmittalNumber, setTransmittalNumber] = useState(detail?.transmittalNumber ?? "");
  const [subject, setSubject] = useState(detail?.subject ?? "");
  const [senderPartyId, setSenderPartyId] = useState(detail?.senderPartyId ?? "");
  const [issueDate, setIssueDate] = useState(detail?.issueDate ?? "");
  const [purpose, setPurpose] = useState<IssuePurpose>(detail?.purpose ?? "for_review");
  const [comments, setComments] = useState(detail?.comments ?? "");
  const [lines, setLines] = useState<PickedLine[]>(
    detail?.items.map((item) => ({
      revisionId: item.revisionId,
      label: `${item.documentNumber} — ${item.documentTitle} (${item.revisionCode})`,
    })) ?? [],
  );
  const [recipients, setRecipients] = useState<PickedRecipient[]>(
    detail?.recipients.map((recipient) => ({
      partyId: recipient.partyId,
      requiresAcknowledgement: recipient.requiresAcknowledgement,
    })) ?? [],
  );
  const [pickDrawingId, setPickDrawingId] = useState("");
  const [pickRevisionId, setPickRevisionId] = useState("");
  const [revisions, setRevisions] = useState<DrawingRevision[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!pickDrawingId) {
      setRevisions([]);
      setPickRevisionId("");
      return;
    }
    api<{ drawing: DrawingDetail }>(`/api/aec/documents/${pickDrawingId}`).then(({ ok, data }) => {
      if (ok) setRevisions(data.drawing.revisions);
    });
  }, [pickDrawingId]);

  function addLine() {
    const revision = revisions.find((row) => row.id === pickRevisionId);
    const drawing = drawings.find((row) => row.id === pickDrawingId);
    if (!revision || !drawing) return;
    if (lines.some((line) => line.revisionId === revision.id)) return;
    setLines((current) => [
      ...current,
      {
        revisionId: revision.id,
        label: `${drawing.documentNumber} — ${drawing.title} (${revision.revisionCode})`,
      },
    ]);
    setPickRevisionId("");
  }

  function toggleRecipient(partyId: string) {
    setRecipients((current) =>
      current.some((recipient) => recipient.partyId === partyId)
        ? current.filter((recipient) => recipient.partyId !== partyId)
        : [...current, { partyId, requiresAcknowledgement: true }],
    );
  }

  async function submit() {
    if (!transmittalNumber.trim() || saving) return;
    setSaving(true);
    const body = {
      transmittalNumber,
      subject,
      senderPartyId: senderPartyId || null,
      issueDate: issueDate || null,
      purpose,
      comments,
      items: lines.map((line) => ({ revisionId: line.revisionId })),
      recipients: recipients.map((recipient) => ({
        partyId: recipient.partyId,
        requiresAcknowledgement: recipient.requiresAcknowledgement,
      })),
    };
    const { ok, data } = detail
      ? await api<{ transmittal: TransmittalDetail }>(`/api/aec/transmittals/${detail.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ transmittal: TransmittalDetail }>(`/api/aec/projects/${projectId}/transmittals`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.transmittal);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-3xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {detail ? `ویرایش برگهٔ ارسال ${detail.transmittalNumber}` : "برگهٔ ارسال جدید"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="شمارهٔ برگهٔ ارسال">
            <input
              className={inputClass}
              value={transmittalNumber}
              onChange={(event) => setTransmittalNumber(event.target.value)}
              placeholder="TR-014"
              autoFocus
            />
          </Field>
          <DateField label="تاریخ صدور" value={issueDate} onChange={setIssueDate} hint="خالی بماند، روز صدور ثبت می‌شود." />
          <div className="sm:col-span-2">
            <Field label="موضوع">
              <input className={inputClass} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </Field>
          </div>
          <PickerField
            label="فرستنده"
            value={senderPartyId}
            onChange={setSenderPartyId}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
            placeholder="— خود ما —"
          />
          <SelectField
            label="جهت صدور"
            value={purpose}
            onChange={(next) => setPurpose((next || "for_review") as IssuePurpose)}
            options={ISSUE_PURPOSES}
            labels={ISSUE_PURPOSE_LABELS}
          />

          <div className="sm:col-span-2 rounded-xl border border-border/80 p-3">
            <p className="mb-2 text-sm font-medium">اسناد این برگه</p>
            {lines.length === 0 ? (
              <p className="text-xs text-muted-foreground">هنوز سندی اضافه نشده است.</p>
            ) : (
              <ul className="mb-3 flex flex-wrap gap-2">
                {lines.map((line) => (
                  <li
                    key={line.revisionId}
                    className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs"
                  >
                    {line.label}
                    <button
                      type="button"
                      aria-label="حذف از برگه"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setLines((current) => current.filter((row) => row.revisionId !== line.revisionId))
                      }
                    >
                      <XIcon className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <PickerField
                label="سند"
                value={pickDrawingId}
                onChange={setPickDrawingId}
                options={drawings.map((drawing) => ({
                  id: drawing.id,
                  label: `${drawing.documentNumber} — ${drawing.title}`,
                }))}
              />
              <PickerField
                label="بازنگری"
                value={pickRevisionId}
                onChange={setPickRevisionId}
                options={revisions.map((revision) => ({
                  id: revision.id,
                  label: `${revision.revisionCode} — ${revision.statusLabel}${
                    revision.isEditable ? "" : " (صادرشده)"
                  }`,
                }))}
              />
              <SecondaryButton onClick={addLine} disabled={!pickRevisionId}>
                <PlusIcon className="size-4" aria-hidden />
                افزودن
              </SecondaryButton>
            </div>
          </div>

          <div className="sm:col-span-2 rounded-xl border border-border/80 p-3">
            <p className="mb-2 text-sm font-medium">گیرندگان</p>
            {lookups.parties.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                طرفی در فهرست «اشخاص» ثبت نشده است؛ گیرنده باید یکی از طرف‌های همین کسب‌وکار باشد.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {lookups.parties.map((party) => {
                  const picked = recipients.find((recipient) => recipient.partyId === party.id);
                  return (
                    <li key={party.id} className="flex flex-wrap items-center gap-3 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(picked)}
                          onChange={() => toggleRecipient(party.id)}
                        />
                        {party.name}
                      </label>
                      {picked ? (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={picked.requiresAcknowledgement}
                            onChange={(event) =>
                              setRecipients((current) =>
                                current.map((recipient) =>
                                  recipient.partyId === party.id
                                    ? { ...recipient, requiresAcknowledgement: event.target.checked }
                                    : recipient,
                                ),
                              )
                            }
                          />
                          رسید لازم است
                        </label>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="sm:col-span-2">
            <Field label="توضیحات">
              <textarea
                className={inputClass}
                rows={2}
                value={comments}
                onChange={(event) => setComments(event.target.value)}
              />
            </Field>
          </div>
          {lines.length === 0 || recipients.length === 0 ? (
            <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300 sm:col-span-2">
              <AlertTriangleIcon className="size-3.5" aria-hidden />
              برای صدور، هم سند لازم است و هم گیرنده.
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/80 p-4">
          <span className="text-xs text-muted-foreground">
            پیش‌نویس هر زمان قابل تغییر است؛ پس از صدور، سابقه قفل می‌شود.
          </span>
          <span className="flex gap-2">
            <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
            <PrimaryButton onClick={submit} disabled={saving || !transmittalNumber.trim()}>
              {saving ? "در حال ذخیره" : "ذخیرهٔ پیش‌نویس"}
            </PrimaryButton>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A transmittal, read (and issued)
 * ------------------------------------------------------------------------- */

function TransmittalDrawer({
  detail,
  canManage,
  canIssueDocuments,
  busy,
  onIssue,
  onAcknowledge,
  onEdit,
  onClose,
}: {
  detail: TransmittalDetail;
  canManage: boolean;
  canIssueDocuments: boolean;
  busy: boolean;
  onIssue: (detail: TransmittalDetail) => void | Promise<void>;
  onAcknowledge: (detail: TransmittalDetail, recipientId: string, name: string) => void | Promise<void>;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [signingId, setSigningId] = useState<string | null>(null);
  const [signatureName, setSignatureName] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-3xl`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            برگهٔ ارسال {detail.transmittalNumber}
            <StatusBadge tone={TRANSMITTAL_TONES[detail.status]}>{detail.statusLabel}</StatusBadge>
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>

        <dl className="grid gap-3 p-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">موضوع</dt>
            <dd className="mt-0.5">{detail.subject || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">فرستنده</dt>
            <dd className="mt-0.5">{detail.senderPartyName ?? "خود ما"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">تاریخ صدور</dt>
            <dd className="mt-0.5">
              {detail.issueDate ? formatJalali(detail.issueDate) : "—"}
              {detail.issuedByName ? (
                <span className="block text-xs text-muted-foreground">صدور: {detail.issuedByName}</span>
              ) : null}
            </dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-xs text-muted-foreground">جهت صدور</dt>
            <dd className="mt-0.5">{detail.purposeLabel}</dd>
          </div>
          {detail.comments ? (
            <div className="sm:col-span-3">
              <dt className="text-xs text-muted-foreground">توضیحات</dt>
              <dd className="mt-0.5 whitespace-pre-line">{detail.comments}</dd>
            </div>
          ) : null}
        </dl>

        <div className="border-t border-border/80 p-4">
          <p className="mb-2 text-sm font-medium">اسناد ({toPersianDigits(String(detail.items.length))})</p>
          {detail.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">سندی ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {detail.items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="w-24 font-medium tabular-nums">{item.documentNumber}</span>
                  <span className="min-w-0 flex-1">{item.documentTitle}</span>
                  <span className="tabular-nums">{item.revisionCode}</span>
                  <span className="text-xs text-muted-foreground">{item.issuePurposeLabel}</span>
                  <StatusBadge tone={REVISION_TONES[item.revisionStatus]}>
                    {item.revisionStatusLabel}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border/80 p-4">
          <p className="mb-2 text-sm font-medium">
            گیرندگان ({toPersianDigits(String(detail.recipients.length))})
          </p>
          {detail.recipients.length === 0 ? (
            <p className="text-xs text-muted-foreground">گیرنده‌ای ثبت نشده است.</p>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {detail.recipients.map((recipient) => (
                <li key={recipient.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">{recipient.partyName}</span>
                  {recipient.requiresAcknowledgement ? (
                    recipient.acknowledgedAt ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2Icon className="size-3.5" aria-hidden />
                        رسید: {recipient.acknowledgedByName || "—"} — {formatJalali(recipient.acknowledgedAt)}
                      </span>
                    ) : (
                      <>
                        <span className="text-xs text-amber-700 dark:text-amber-300">بدون رسید</span>
                        {canManage && detail.status === "issued" ? (
                          signingId === recipient.id ? (
                            <span className="flex items-center gap-1">
                              <input
                                className={`${inputClass} h-8 w-40`}
                                placeholder="نام تحویل‌گیرنده"
                                value={signatureName}
                                onChange={(event) => setSignatureName(event.target.value)}
                              />
                              <PrimaryButton
                                disabled={busy}
                                onClick={() => {
                                  void onAcknowledge(detail, recipient.id, signatureName);
                                  setSigningId(null);
                                  setSignatureName("");
                                }}
                              >
                                ثبت رسید
                              </PrimaryButton>
                            </span>
                          ) : (
                            <SecondaryButton onClick={() => setSigningId(recipient.id)}>
                              ثبت رسید
                            </SecondaryButton>
                          )
                        ) : null}
                      </>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">رونوشت — رسید لازم نیست</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 p-4">
          <span className="text-xs text-muted-foreground">
            {detail.status === "draft"
              ? "پس از صدور، شماره، گیرندگان و اسناد این برگه قابل تغییر نیستند."
              : detail.acknowledgedAt
                ? `رسید کامل — ${formatJalali(detail.acknowledgedAt)}`
                : "در انتظار رسید گیرندگان دارای الزام."}
          </span>
          <span className="flex gap-2">
            {canManage && detail.status === "draft" ? (
              <SecondaryButton onClick={onEdit}>
                <PencilIcon className="size-4" aria-hidden />
                ویرایش پیش‌نویس
              </SecondaryButton>
            ) : null}
            {canIssueDocuments && detail.status === "draft" ? (
              <PrimaryButton onClick={() => void onIssue(detail)} disabled={busy}>
                <SendIcon className="size-4" aria-hidden />
                صدور برگهٔ ارسال
              </PrimaryButton>
            ) : null}
            {detail.status === "draft" && !canIssueDocuments ? (
              <span className="text-xs text-muted-foreground">
                صدور نیازمند دسترسی «صدور نقشه و سند» است.
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
