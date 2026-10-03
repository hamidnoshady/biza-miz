"use client";

/**
 * Issue #799 §10 on screen — «استعلام‌ها (RFI)»: the questions a project team
 * asks its client, its consultant and its own discipline leads, and the answers
 * that come back.
 *
 * The tab answers three questions in the order a project manager asks them:
 *
 *   1. what is still unanswered — the register, waiting first, with the overdue
 *      ones marked, because §10 says the system must surface them clearly;
 *   2. what was actually asked — the question, the related drawing, the party
 *      who owes the answer and the two impacts (cost and time) §10 lists;
 *   3. what was answered — the response and the date it came, which §33 freezes
 *      once the RFI is closed.
 *
 * ## What the screen is careful about
 *
 *   * **One control per move.** §10's chain is Draft → Open → Answered → Closed
 *     (with Cancelled before an answer), and the buttons are exactly those moves
 *     — no status dropdown that can pick an illegal one and then fail in the
 *     service.
 *   * **A frozen thing looks frozen.** Once the RFI is open, the number and the
 *     question stop being editable and the screen stops offering the fields: the
 *     lock is migration 0198's, and a control that only fails is worse than no
 *     control.
 *   * **Every question needs its answer to be a sentence.** «پاسخ» requires text;
 *     the service refuses an empty one, so the button stays disabled until there
 *     is something to record.
 *   * **Dates are Shamsi on screen and Gregorian in the database**, like the rest
 *     of the product: `DateField` is the shared Jalali picker and the API only
 *     ever sees `YYYY-MM-DD`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  HelpCircleIcon,
  MessageSquareReplyIcon,
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
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { toPersianDigits } from "@/lib/digits";
import { RFI_STATUSES, RFI_STATUS_LABELS, type RfiStatus } from "@/lib/aec-rfi";
import { AEC_SPECIALTIES, AEC_SPECIALTY_LABELS, type AecSpecialty } from "@/lib/aec";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, SelectField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface RfiAttachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

interface RfiDetail {
  id: string;
  projectId: string;
  rfiNumber: string;
  subject: string;
  question: string;
  discipline: string | null;
  disciplineLabel: string;
  raisedById: string | null;
  raisedByName: string;
  assignedToId: string | null;
  assignedToName: string;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  documentId: string | null;
  documentNumber: string | null;
  documentTitle: string | null;
  raisedDate: string;
  dueDate: string | null;
  response: string;
  respondedByName: string;
  responseDate: string | null;
  status: RfiStatus;
  statusLabel: string;
  costImpactRial: number | null;
  scheduleImpactDays: number | null;
  closedAt: string | null;
  createdAt: string;
  createdByName: string;
  isOverdue: boolean;
  isWaiting: boolean;
  isEditable: boolean;
  attachmentCount: number;
}

interface RfiWithAttachments extends RfiDetail {
  attachments: RfiAttachment[];
}

/** The register row's shape is the detail minus the attachment list. */
type RfiSummary = RfiDetail;

const STATUS_TONES: Record<RfiStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  open: "active",
  answered: "positive",
  closed: "neutral",
  cancelled: "neutral",
};

const DISCIPLINE_OPTIONS = AEC_SPECIALTIES;

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecRfisTab({
  projectId,
  canManage,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  lookups: WorkspaceLookups;
}) {
  const [rfis, setRfis] = useState<RfiSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RfiWithAttachments | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RfiSummary | null>(null);
  const [answering, setAnswering] = useState<RfiSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<RfiStatus | "">("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const money = useMoney();

  const fail = (code: string | undefined) => setError(workspaceError(code));

  const load = useCallback(
    async (preferId?: string | null) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const suffix = params.size ? `?${params.toString()}` : "";
      const { ok, data } = await api<{ rfis: RfiSummary[] }>(
        `/api/aec/projects/${projectId}/rfis${suffix}`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setRfis([]);
        return null;
      }
      setRfis(data.rfis);
      const next = data.rfis.find((rfi) => rfi.id === preferId) ?? data.rfis[0] ?? null;
      setSelectedId(next ? next.id : null);
      return next;
    },
    [projectId, search, statusFilter],
  );

  const loadDetail = useCallback(async (rfiId: string) => {
    const { ok, data } = await api<{ rfi: RfiWithAttachments }>(`/api/aec/rfis/${rfiId}`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setDetail(null);
      return;
    }
    setDetail(data.rfi);
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

  const waiting = useMemo(() => (rfis ?? []).filter((rfi) => rfi.isWaiting).length, [rfis]);
  const overdue = useMemo(() => (rfis ?? []).filter((rfi) => rfi.isOverdue).length, [rfis]);
  const costImpact = useMemo(
    () => (rfis ?? []).reduce((total, rfi) => total + (rfi.costImpactRial ?? 0), 0),
    [rfis],
  );

  async function act(rfi: RfiSummary, action: "open" | "close" | "cancel") {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ rfi: RfiDetail }>(`/api/aec/rfis/${rfi.id}/status`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "open"
        ? `استعلام ${data.rfi.rfiNumber} باز شد و برای پاسخ‌دهنده ثبت شد.`
        : action === "cancel"
          ? `استعلام ${data.rfi.rfiNumber} لغو شد.`
          : `استعلام ${data.rfi.rfiNumber} بسته شد.`,
    );
    await refresh(data.rfi.id);
  }

  async function remove(rfi: RfiSummary) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/rfis/${rfi.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("استعلام پیش‌نویس حذف شد.");
    await refresh(null);
  }

  if (!rfis) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="استعلام‌ها" value="—" />
          <KpiCard label="بی‌پاسخ" value="—" />
          <KpiCard label="عقب‌افتاده" value="—" />
          <KpiCard label="اثر هزینه‌ای" value="—" />
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
        <KpiCard label="استعلام‌ها" value={n(rfis.length)} hint="در این نما" />
        <KpiCard label="بی‌پاسخ" value={n(waiting)} hint="باز و در انتظار پاسخ" />
        <KpiCard
          label="عقب‌افتاده"
          value={n(overdue)}
          hint={overdue > 0 ? "مهلت گذشته — نیازمند پیگیری" : "مهلت گذشته ندارد"}
        />
        <KpiCard
          label="اثر هزینه‌ای"
          value={costImpact ? money.format(costImpact) : "—"}
          hint="مجموع برآوردی استعلام‌ها"
        />
      </KpiRow>

      <SectionCard
        title="دفتر استعلام‌ها (RFI)"
        description="هر استعلام یک شماره دارد؛ تا وقتی پیش‌نویس است می‌توان ویرایشش کرد، و بعد از «باز کردن» پرسش و شماره ثابت می‌مانند."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreating((open) => !open)}>
              <PlusIcon className="size-4" aria-hidden />
              استعلام جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {creating ? (
          <RfiForm
            projectId={projectId}
            lookups={lookups}
            onClose={() => setCreating(false)}
            onError={fail}
            onSaved={async (rfiId) => {
              setCreating(false);
              setNotice("استعلام ثبت شد. حالا با «باز کردن» آن را برای پاسخ‌دهنده بفرستید.");
              await refresh(rfiId);
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <div className="w-full sm:w-48">
            <SelectField
              label="وضعیت"
              value={statusFilter}
              onChange={(next) => setStatusFilter(next as RfiStatus | "")}
              options={RFI_STATUSES}
              labels={RFI_STATUS_LABELS}
              includeAll
              allLabel="همه"
            />
          </div>
          <div className="min-w-48 flex-1">
            <Field label="جست‌وجو" hint="در شماره، موضوع و پرسش">
              <input
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="مثلاً دریچه"
              />
            </Field>
          </div>
        </div>

        {rfis.length === 0 ? (
          <EmptyState icon={HelpCircleIcon} title="استعلامی با این فیلترها نیست">
            هر پرسشی که از کارفرما، مشاور یا پیمانکار می‌پرسید یک RFI است: شماره، موضوع و متن پرسش را
            ثبت کنید و بعد آن را باز کنید تا مهلت پاسخ مشخص شود.
          </EmptyState>
        ) : (
          <DataTable caption={`دفتر استعلام‌ها — ${n(rfis.length)} مورد`} tableClassName="min-w-[56rem]">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>موضوع</Th>
                <Th>رشته</Th>
                <Th>مسئول پاسخ</Th>
                <Th>مهلت</Th>
                <Th>وضعیت</Th>
                <Th>اثر</Th>
                <Th> </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {rfis.map((rfi) => (
                <DataTableRow key={rfi.id} className={rfi.id === selectedId ? "bg-muted/40" : undefined}>
                  <Td className="font-medium tabular-nums">{rfi.rfiNumber}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-right underline-offset-4 hover:underline"
                      onClick={() => {
                        setSelectedId(rfi.id);
                        void loadDetail(rfi.id);
                      }}
                    >
                      {rfi.subject}
                    </button>
                    {rfi.attachmentCount > 0 ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <PaperclipIcon className="size-3" aria-hidden />
                        {n(rfi.attachmentCount)} پیوست
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-muted-foreground">{rfi.disciplineLabel}</Td>
                  <Td className="text-muted-foreground">
                    {rfi.responsiblePartyName || rfi.assignedToName || "—"}
                  </Td>
                  <Td>
                    {rfi.isOverdue ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
                        <AlertTriangleIcon className="size-3.5" aria-hidden />
                        <DateCell date={rfi.dueDate} relative={false} className="text-xs" />
                      </span>
                    ) : (
                      <DateCell date={rfi.dueDate} relative={false} className="text-xs" />
                    )}
                  </Td>
                  <Td>
                    <StatusBadge tone={STATUS_TONES[rfi.status]}>{rfi.statusLabel}</StatusBadge>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {[
                      rfi.costImpactRial ? money.format(rfi.costImpactRial) : "",
                      rfi.scheduleImpactDays ? `${n(rfi.scheduleImpactDays)} روز` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </Td>
                  <Td>
                    {canManage ? (
                      <span className="flex items-center gap-1">
                        {rfi.isEditable ? (
                          <>
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                              aria-label="ویرایش استعلام"
                              onClick={() => setEditing(rfi)}
                            >
                              <PencilIcon className="size-4" aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                              aria-label="حذف استعلام"
                              onClick={() => void remove(rfi)}
                            >
                              <Trash2Icon className="size-4" aria-hidden />
                            </button>
                          </>
                        ) : null}
                        {rfi.status === "draft" ? (
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-muted dark:text-amber-400"
                            onClick={() => void act(rfi, "open")}
                          >
                            باز کردن
                          </button>
                        ) : null}
                        {rfi.status === "open" ? (
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 hover:bg-muted dark:text-amber-400"
                            onClick={() => setAnswering(rfi)}
                          >
                            ثبت پاسخ
                          </button>
                        ) : null}
                        {rfi.status === "answered" ? (
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-muted dark:text-emerald-400"
                            onClick={() => void act(rfi, "close")}
                          >
                            بستن
                          </button>
                        ) : null}
                        {rfi.status === "draft" || rfi.status === "open" ? (
                          <button
                            type="button"
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                            aria-label="لغو استعلام"
                            onClick={() => void act(rfi, "cancel")}
                          >
                            <XIcon className="size-4" aria-hidden />
                          </button>
                        ) : null}
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
        <RfiForm
          key={editing.id}
          projectId={projectId}
          rfi={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async () => {
            setEditing(null);
            setNotice("استعلام ویرایش شد.");
            await refresh(selectedId);
          }}
        />
      ) : null}

      {answering ? (
        <AnswerDialog
          rfi={answering}
          onClose={() => setAnswering(null)}
          onError={fail}
          onSaved={async (rfiId) => {
            setAnswering(null);
            setNotice("پاسخ ثبت شد؛ حالا می‌توانید استعلام را ببندید.");
            await refresh(rfiId);
          }}
        />
      ) : null}

      {detail ? (
        <SectionCard
          title={`${detail.rfiNumber} — ${detail.subject}`}
          description={`ثبت‌شده در ${detail.raisedDate} توسط ${detail.createdByName || detail.raisedByName}`}
        >
          <div className="flex flex-col gap-4 p-4">
            <div>
              <p className="text-xs text-muted-foreground">پرسش</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{detail.question}</p>
            </div>
            {detail.response ? (
              <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/60 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                <p className="flex items-center gap-1 text-xs text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2Icon className="size-3.5" aria-hidden />
                  پاسخ
                  {detail.responseDate ? ` — ${detail.responseDate}` : ""}
                  {detail.respondedByName ? ` — ${detail.respondedByName}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{detail.response}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {detail.isWaiting ? "هنوز پاسخی ثبت نشده است." : "این استعلام بدون پاسخ بسته شده است."}
              </p>
            )}

            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">مهلت پاسخ</dt>
                <dd className="mt-0.5">
                  <DateCell date={detail.dueDate} relative={false} />
                  {detail.isOverdue ? (
                    <span className="mr-2 text-xs text-red-700 dark:text-red-400">عقب‌افتاده</span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">طرف مسئول</dt>
                <dd className="mt-0.5">{detail.responsiblePartyName || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">سند مرتبط</dt>
                <dd className="mt-0.5">
                  {detail.documentNumber
                    ? `${detail.documentNumber}${detail.documentTitle ? ` — ${detail.documentTitle}` : ""}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">اثر</dt>
                <dd className="mt-0.5">
                  {[
                    detail.costImpactRial ? money.format(detail.costImpactRial) : "",
                    detail.scheduleImpactDays ? `${n(detail.scheduleImpactDays)} روز` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </dd>
              </div>
            </dl>

            <div>
              <p className="text-xs text-muted-foreground">پیوست‌ها</p>
              {detail.attachments.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  پیوستی ندارد؛ فایل‌ها از «کتابخانهٔ رسانه» به استعلام وصل می‌شوند.
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
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Raise / edit
 * ------------------------------------------------------------------------- */

function RfiForm({
  projectId,
  rfi,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  rfi?: RfiSummary;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: (rfiId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [rfiNumber, setRfiNumber] = useState(rfi?.rfiNumber ?? "");
  const [subject, setSubject] = useState(rfi?.subject ?? "");
  const [question, setQuestion] = useState(rfi?.question ?? "");
  const [discipline, setDiscipline] = useState(rfi?.discipline ?? "");
  const [responsiblePartyId, setResponsiblePartyId] = useState(rfi?.responsiblePartyId ?? "");
  const [assignedToId, setAssignedToId] = useState(rfi?.assignedToId ?? "");
  const [raisedDate, setRaisedDate] = useState(rfi?.raisedDate ?? "");
  const [dueDate, setDueDate] = useState(rfi?.dueDate ?? "");
  const [costImpactRial, setCostImpactRial] = useState(
    rfi?.costImpactRial ? String(rfi.costImpactRial) : "",
  );
  const [scheduleImpactDays, setScheduleImpactDays] = useState(
    rfi?.scheduleImpactDays ? String(rfi.scheduleImpactDays) : "",
  );
  const [revisions, setRevisions] = useState<Array<{ id: string; label: string }>>([]);
  const [documentId, setDocumentId] = useState(rfi?.documentId ?? "");
  const [saving, setSaving] = useState(false);

  // The related drawing of §10 is a document of this project's register.
  useEffect(() => {
    api<{ drawings: Array<{ id: string; documentNumber: string; title: string }> }>(
      `/api/aec/projects/${projectId}/documents`,
    ).then(({ ok, data }) => {
      if (ok) {
        setRevisions(
          data.drawings.map((drawing) => ({
            id: drawing.id,
            label: `${drawing.documentNumber} — ${drawing.title}`,
          })),
        );
      }
    });
  }, [projectId]);

  async function submit() {
    if (!rfiNumber.trim() || !subject.trim() || !question.trim() || saving) return;
    setSaving(true);
    const body = {
      rfiNumber,
      subject,
      question,
      discipline: discipline || null,
      responsiblePartyId: responsiblePartyId || null,
      assignedToId: assignedToId || null,
      raisedDate: raisedDate || null,
      dueDate: dueDate || null,
      costImpactRial: costImpactRial || null,
      scheduleImpactDays: scheduleImpactDays || null,
      documentId: documentId || null,
    };
    const { ok, data } = rfi
      ? await api<{ rfi: RfiSummary }>(`/api/aec/rfis/${rfi.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ rfi: RfiSummary }>(`/api/aec/projects/${projectId}/rfis`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.rfi.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">{rfi ? "ویرایش استعلام" : "ثبت استعلام (RFI)"}</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="شمارهٔ استعلام" hint="مثلاً RFI-012">
            <input
              className={inputClass}
              value={rfiNumber}
              onChange={(event) => setRfiNumber(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="موضوع">
            <input className={inputClass} value={subject} onChange={(event) => setSubject(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="متن پرسش" hint="دقیقاً چه چیزی پرسیده می‌شود؟">
              <textarea
                className={inputClass}
                rows={4}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </Field>
          </div>
          <SelectField
            label="رشته"
            value={(discipline || "") as AecSpecialty | ""}
            onChange={(next) => setDiscipline(next)}
            options={DISCIPLINE_OPTIONS}
            labels={AEC_SPECIALTY_LABELS}
            includeAll
            allLabel="— بدون رشته —"
          />
          <PickerField
            label="طرف مسئول پاسخ"
            value={responsiblePartyId}
            onChange={setResponsiblePartyId}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
            placeholder="— انتخاب نشده —"
            hint="کارفرما، مشاور یا پیمانکاری که باید پاسخ دهد."
          />
          <PickerField
            label="مسئول پیگیری داخلی"
            value={assignedToId}
            onChange={setAssignedToId}
            options={lookups.members.map((member) => ({ id: member.id, label: member.fullName }))}
            placeholder="— انتخاب نشده —"
          />
          <PickerField
            label="سند مرتبط"
            value={documentId}
            onChange={setDocumentId}
            options={revisions}
            placeholder="— بدون سند —"
            hint="نقشه یا سندی که پرسش دربارهٔ آن است."
          />
          <DateField label="تاریخ طرح" value={raisedDate} onChange={setRaisedDate} />
          <DateField label="مهلت پاسخ" value={dueDate} onChange={setDueDate} />
          <Field label="اثر هزینه‌ای (ریال)" hint="برآوردی — اختیاری">
            <input
              className={inputClass}
              inputMode="numeric"
              value={costImpactRial}
              onChange={(event) => setCostImpactRial(event.target.value)}
            />
          </Field>
          <Field label="اثر زمانی (روز)" hint="برآوردی — اختیاری">
            <input
              className={inputClass}
              inputMode="numeric"
              value={scheduleImpactDays}
              onChange={(event) => setScheduleImpactDays(event.target.value)}
            />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            پس از «باز کردن»، شماره و متن پرسش دیگر تغییر نمی‌کنند؛ پاسخ هم بعد از ثبت قابل بازنویسی
            نیست. این دو قاعده در پایگاه‌داده اعمال می‌شوند، نه فقط در این فرم.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton
            onClick={submit}
            disabled={saving || !rfiNumber.trim() || !subject.trim() || !question.trim()}
          >
            {saving ? "در حال ذخیره" : "ذخیره"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The answer
 * ------------------------------------------------------------------------- */

function AnswerDialog({
  rfi,
  onClose,
  onSaved,
  onError,
}: {
  rfi: RfiSummary;
  onClose: () => void;
  onSaved: (rfiId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [response, setResponse] = useState("");
  const [respondedByName, setRespondedByName] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!response.trim() || saving) return;
    setSaving(true);
    const { ok, data } = await api<{ rfi: RfiDetail }>(`/api/aec/rfis/${rfi.id}/status`, {
      method: "POST",
      body: JSON.stringify({ action: "answer", response, respondedByName }),
    });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.rfi.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <MessageSquareReplyIcon className="size-4" aria-hidden />
            پاسخ به {rfi.rfiNumber}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="rounded-xl bg-muted/40 p-3 text-sm whitespace-pre-wrap">{rfi.question}</p>
          <Field label="متن پاسخ" hint="این متن پس از ثبت دیگر بازنویسی نمی‌شود.">
            <textarea
              className={inputClass}
              rows={5}
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="پاسخ‌دهنده" hint="اختیاری — پیش‌فرض نام شماست.">
            <input
              className={inputClass}
              value={respondedByName}
              onChange={(event) => setRespondedByName(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving || !response.trim()}>
            {saving ? "در حال ثبت" : "ثبت پاسخ"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
