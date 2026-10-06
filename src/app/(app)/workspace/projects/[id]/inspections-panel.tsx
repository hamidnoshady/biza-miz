"use client";

/**
 * Issue #799 §14 on screen — «بازرسی و کنترل کیفیت»: inspections, NCRs,
 * corrective actions, snags, HSE observations and handover items, plus the
 * checklists they are carried out against.
 *
 * One register, seven kinds. §14 lists "inspection requests, checklists, quality
 * inspections, NCRs, corrective actions, punch/snags, handover checklist, HSE
 * observations" as separate things; they are separate *acts* but they are one
 * *record* — a finding, who owns it, when it is due, and who verified the fix.
 * Modelling them as seven tables would mean seven ways to be overdue and seven
 * places for the reminder scan to miss one, so the register keeps the kind in a
 * column and this tab keeps the workflow in one place.
 *
 * ## The four moves
 *
 * `start` → «در دست اقدام», `resolve` → «اصلاحشده» (with what was done, and a
 * pass / fail result for an inspection or a handover), `close` → «بستهشده»
 * (the closeout verification §14 asks for), `cancel`. Close is the only move
 * that needs `workspace.approve` rather than `workspace.manage`, and the service
 * refuses it when the verifier is the assignee — the four-eyes rule. The buttons
 * therefore appear per permission *and* per state, and the tab explains the
 * refusal rather than showing a button that always errors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheckIcon,
  ClipboardListIcon,
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
import { mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { toPersianDigits } from "@/lib/digits";
import {
  SITE_CHECK_RESULTS,
  SITE_CHECK_RESULT_LABELS,
  SITE_ISSUE_CATEGORIES,
  SITE_ISSUE_CATEGORY_LABELS,
  SITE_ISSUE_KINDS,
  SITE_ISSUE_KIND_LABELS,
  SITE_ISSUE_RESULTS,
  SITE_ISSUE_RESULT_LABELS,
  SITE_ISSUE_SEVERITIES,
  SITE_ISSUE_SEVERITY_LABELS,
  SITE_ISSUE_STATUSES,
  SITE_ISSUE_STATUS_LABELS,
  issueNeedsResult,
  issueSupportsChecks,
  type SiteCheckResult,
  type SiteIssueAction,
  type SiteIssueCategory,
  type SiteIssueKind,
  type SiteIssueResult,
  type SiteIssueSeverity,
  type SiteIssueStatus,
} from "@/lib/aec-site";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, SelectField, workspaceError } from "../../workspace-ui";
import { AecChecklistsSection } from "./checklists-panel";

/* ---------------------------------------------------------------------------
 * Wire shapes
 * ------------------------------------------------------------------------- */

interface CheckRow {
  id: string;
  checklistItemId: string | null;
  label: string;
  guidance: string;
  result: string;
  resultLabel: string;
  note: string;
  position: number;
  checkedByName: string;
  checkedAt: string | null;
}

interface Attachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

interface IssueSummary {
  id: string;
  projectId: string;
  issueNumber: string;
  kind: SiteIssueKind;
  kindLabel: string;
  title: string;
  description: string;
  location: string;
  category: string | null;
  categoryLabel: string;
  severity: string;
  severityLabel: string;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  raisedByName: string;
  raisedDate: string;
  assignedToId: string | null;
  assignedToName: string;
  dueDate: string | null;
  status: SiteIssueStatus;
  statusLabel: string;
  result: string | null;
  resultLabel: string;
  resolutionNote: string;
  resolvedByName: string;
  resolvedAt: string | null;
  verifiedByName: string;
  verifiedAt: string | null;
  closeoutNote: string;
  siteLogId: string | null;
  checklistId: string | null;
  checklistName: string | null;
  isOverdue: boolean;
  isEditable: boolean;
  checkCount: number;
  pendingCheckCount: number;
  attachmentCount: number;
}

interface IssueDetail extends IssueSummary {
  checks: CheckRow[];
  attachments: Attachment[];
}

const SEVERITY_TONES: Record<string, "neutral" | "active" | "danger"> = {
  low: "neutral",
  medium: "active",
  high: "danger",
  critical: "danger",
};

const STATUS_TONES: Record<SiteIssueStatus, "neutral" | "positive" | "active" | "danger"> = {
  open: "active",
  in_progress: "active",
  resolved: "neutral",
  closed: "positive",
  cancelled: "neutral",
};

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecInspectionsTab({
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
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<IssueDetail | null>(null);
  const [kind, setKind] = useState<SiteIssueKind | "">("");
  const [status, setStatus] = useState<SiteIssueStatus | "">("");
  const [severity, setSeverity] = useState<SiteIssueSeverity | "">("");
  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = (code: string | undefined) => setError(workspaceError(code));

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (status) params.set("status", status);
    if (severity) params.set("severity", severity);
    if (search.trim()) params.set("search", search.trim());
    if (openOnly) params.set("openOnly", "1");
    if (overdueOnly) params.set("overdueOnly", "1");
    const suffix = params.size ? `?${params.toString()}` : "";
    const { ok, data } = await api<{ issues: IssueSummary[] }>(
      `/api/aec/projects/${projectId}/site-issues${suffix}`,
    );
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setIssues([]);
      return;
    }
    setIssues(data.issues);
    setSelectedId((current) =>
      current && data.issues.some((issue) => issue.id === current) ? current : null,
    );
  }, [kind, openOnly, overdueOnly, projectId, search, severity, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(issue: IssueSummary, action: SiteIssueAction, input: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ issue: IssueDetail }>(
      `/api/aec/site-issues/${issue.id}/status`,
      { method: "POST", body: JSON.stringify({ action, ...input }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    const labels: Record<SiteIssueAction, string> = {
      start: "در دست اقدام شد",
      resolve: "اصلاح ثبت شد و منتظر تأیید بستن است",
      close: "با تأیید بسته شد",
      cancel: "لغو شد",
    };
    setNotice(`${data.issue.issueNumber} ${labels[action]}.`);
    setSelectedId(data.issue.id);
    await load();
  }

  async function remove(issue: IssueSummary) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/site-issues/${issue.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(`${issue.issueNumber} حذف شد.`);
    setSelectedId(null);
    await load();
  }

  const totals = useMemo(() => {
    const list = issues ?? [];
    return {
      open: list.filter((issue) => issue.status === "open" || issue.status === "in_progress").length,
      overdue: list.filter((issue) => issue.isOverdue).length,
      awaiting: list.filter((issue) => issue.status === "resolved").length,
      ncr: list.filter((issue) => issue.kind === "ncr").length,
    };
  }, [issues]);

  if (!issues) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="موارد باز" value="—" />
          <KpiCard label="عقب‌افتاده" value="—" />
          <KpiCard label="منتظر تأیید" value="—" />
          <KpiCard label="عدم انطباق" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const n = (value: number | string) => toPersianDigits(String(value));
  const hasFilters = Boolean(kind || status || severity || search.trim() || openOnly || overdueOnly);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      <KpiRow>
        <KpiCard
          label="موارد باز"
          value={n(totals.open)}
          hint={totals.open > 0 ? "در انتظار اقدام پیمانکار" : "چیزی باز نیست"}
        />
        <KpiCard
          label="عقب‌افتاده"
          value={n(totals.overdue)}
          hint={totals.overdue > 0 ? "از مهلت گذشته" : "در مهلت"}
        />
        <KpiCard label="منتظر تأیید بستن" value={n(totals.awaiting)} hint="اصلاح‌شده، تأییدنشده" />
        <KpiCard label="عدم انطباق (NCR)" value={n(totals.ncr)} hint="در این نما" />
      </KpiRow>

      <SectionCard
        title="بازرسی و کنترل کیفیت"
        description="درخواست بازرسی، بازرسی کیفیت، عدم انطباق، اقدام اصلاحی، نقص (پانچ)، مشاهدهٔ ایمنی و تحویل — همه در یک دفتر، با مسئول، مهلت، نتیجه و تأیید بستن."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreating((open) => !open)}>
              <PlusIcon className="size-4" aria-hidden />
              مورد جدید
            </SecondaryButton>
          ) : null
        }
        actionsClassName="max-sm:w-full"
        flush
      >
        {creating ? (
          <IssueForm
            projectId={projectId}
            lookups={lookups}
            onClose={() => setCreating(false)}
            onError={fail}
            onSaved={async (issueId) => {
              setCreating(false);
              setNotice("مورد کارگاه ثبت شد.");
              setSelectedId(issueId);
              await load();
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <div className="w-full sm:w-44">
            <SelectField
              label="نوع"
              value={kind}
              onChange={(next) => setKind(next as SiteIssueKind | "")}
              options={SITE_ISSUE_KINDS}
              labels={SITE_ISSUE_KIND_LABELS}
              includeAll
            />
          </div>
          <div className="w-full sm:w-40">
            <SelectField
              label="وضعیت"
              value={status}
              onChange={(next) => setStatus(next as SiteIssueStatus | "")}
              options={SITE_ISSUE_STATUSES}
              labels={SITE_ISSUE_STATUS_LABELS}
              includeAll
            />
          </div>
          <div className="w-full sm:w-32">
            <SelectField
              label="شدت"
              value={severity}
              onChange={(next) => setSeverity(next as SiteIssueSeverity | "")}
              options={SITE_ISSUE_SEVERITIES}
              labels={SITE_ISSUE_SEVERITY_LABELS}
              includeAll
            />
          </div>
          <div className="w-full sm:max-w-64">
            <Field label="جست‌وجو">
              <input
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="شماره، عنوان یا محل"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={openOnly}
              onChange={(event) => setOpenOnly(event.target.checked)}
            />
            فقط باز
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={overdueOnly}
              onChange={(event) => setOverdueOnly(event.target.checked)}
            />
            فقط عقب‌افتاده
          </label>
        </div>

        {issues.length === 0 ? (
          <EmptyState
            icon={ClipboardCheckIcon}
            title={hasFilters ? "موردی با این فیلترها نیست" : "دفتر بازرسی خالی است"}
          >
            {hasFilters
              ? "فیلترها را باز کنید یا جست‌وجو را پاک کنید."
              : "با «مورد جدید» یک درخواست بازرسی، عدم انطباق یا نقص ثبت کنید — یا اگر الگوی همیشگی دارید، اول یک چک‌لیست در پایین همین صفحه بسازید تا ردیف‌هایش روی مورد سوار شود."}
          </EmptyState>
        ) : (
          <DataTable caption={`دفتر بازرسی و کیفیت — ${n(issues.length)} مورد`}>
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>موضوع</Th>
                <Th>نوع</Th>
                <Th>محل</Th>
                <Th>شدت</Th>
                <Th>مسئول</Th>
                <Th>مهلت</Th>
                <Th>وضعیت</Th>
                <Th className="w-16" />
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {issues.map((issue) => (
                <DataTableRow
                  key={issue.id}
                  className={issue.id === selectedId ? "bg-muted/40" : undefined}
                >
                  <Td className="whitespace-nowrap font-medium">{issue.issueNumber}</Td>
                  <Td className="min-w-48">
                    <button
                      type="button"
                      className="text-start hover:underline"
                      onClick={() => setSelectedId(issue.id === selectedId ? null : issue.id)}
                    >
                      {issue.title}
                    </button>
                  </Td>
                  <Td className="whitespace-nowrap">{issue.kindLabel}</Td>
                  <Td>{issue.location || "—"}</Td>
                  <Td>
                    <StatusBadge tone={SEVERITY_TONES[issue.severity] ?? "neutral"}>
                      {issue.severityLabel}
                    </StatusBadge>
                  </Td>
                  <Td>{issue.responsiblePartyName ?? "—"}</Td>
                  <Td className="whitespace-nowrap">
                    <DateCell date={issue.dueDate} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge tone={STATUS_TONES[issue.status]}>{issue.statusLabel}</StatusBadge>
                      {issue.isOverdue ? <StatusBadge tone="danger">عقب‌افتاده</StatusBadge> : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      {canManage && issue.isEditable ? (
                        <button
                          type="button"
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                          title="ویرایش"
                          onClick={async () => {
                            const { ok, data } = await api<{ issue: IssueDetail }>(
                              `/api/aec/site-issues/${issue.id}`,
                            );
                            if (!ok) {
                              fail((data as unknown as { error?: string }).error);
                              return;
                            }
                            setEditing(data.issue);
                          }}
                        >
                          <ClipboardListIcon className="size-4" aria-hidden />
                        </button>
                      ) : null}
                      {canManage && issue.status === "open" ? (
                        <button
                          type="button"
                          className="rounded-lg p-1.5 text-destructive hover:bg-destructive/10"
                          title="حذف"
                          onClick={() => void remove(issue)}
                        >
                          <Trash2Icon className="size-4" aria-hidden />
                        </button>
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
        <IssueForm
          projectId={projectId}
          lookups={lookups}
          issue={editing}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async (issueId) => {
            setEditing(null);
            setNotice("مورد کارگاه ویرایش شد.");
            setSelectedId(issueId);
            await load();
          }}
        />
      ) : null}

      {selectedId ? (
        <IssueCard
          issueId={selectedId}
          canManage={canManage}
          canApprove={canApprove}
          busy={busy}
          onAct={act}
          onError={fail}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <AecChecklistsSection projectId={projectId} canManage={canManage} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * One finding, with §14's four moves
 * ------------------------------------------------------------------------- */

function IssueCard({
  issueId,
  canManage,
  canApprove,
  busy,
  onAct,
  onError,
  onClose,
}: {
  issueId: string;
  canManage: boolean;
  canApprove: boolean;
  busy: boolean;
  onAct: (issue: IssueSummary, action: SiteIssueAction, input: Record<string, unknown>) => void;
  onError: (code: string | undefined) => void;
  onClose: () => void;
}) {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [dialog, setDialog] = useState<SiteIssueAction | null>(null);
  // The parent recreates `onError` every render; keeping it in a ref stops the
  // fetch from repeating whenever the tab above re-renders.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [resolutionNote, setResolutionNote] = useState("");
  const [result, setResult] = useState("");
  const [closeoutNote, setCloseoutNote] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ issue: IssueDetail }>(`/api/aec/site-issues/${issueId}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) {
        onErrorRef.current((data as unknown as { error?: string }).error);
        return;
      }
      setIssue(data.issue);
      setResolutionNote(data.issue.resolutionNote);
      setResult(data.issue.result ?? "");
      setCloseoutNote(data.issue.closeoutNote);
    });
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  if (loading || !issue) {
    return <SectionCardSkeleton rows={3} />;
  }

  const start = () => onAct(issue, "start", {});
  const submitDialog = () => {
    if (!dialog) return;
    if (dialog === "resolve") {
      onAct(issue, "resolve", { resolutionNote, result: result || undefined });
    } else if (dialog === "close") {
      onAct(issue, "close", { closeoutNote });
    } else {
      onAct(issue, dialog, {});
    }
    setDialog(null);
  };

  // Who may do what: `close` is the one act that is a verification rather than
  // site work, so it needs the approval permission (and is refused by the
  // service when the verifier is the assignee — said here rather than discovered
  // by clicking).
  const actions: Array<{ action: SiteIssueAction; label: string }> = [];
  if (issue.status === "open" && canManage) actions.push({ action: "start", label: "شروع اقدام" });
  if (issue.status === "in_progress" && canManage) actions.push({ action: "resolve", label: "ثبت اصلاح" });
  if (issue.status === "resolved" && canApprove) actions.push({ action: "close", label: "تأیید و بستن" });
  if ((issue.status === "open" || issue.status === "in_progress") && canManage) {
    actions.push({ action: "cancel", label: "لغو" });
  }
  // A verification that failed goes back to work — `resolved → in_progress` is
  // the one backward move the register has (`SITE_ISSUE_TRANSITIONS`), and it is
  // the `start` act, not a second `resolve` on an already-resolved record.
  if (issue.status === "resolved" && canManage) {
    actions.push({ action: "start", label: "بازگشت به اقدام" });
  }

  return (
    <SectionCard
      title={`${issue.issueNumber} — ${issue.title}`}
      description={`${issue.kindLabel}${issue.location ? ` • ${issue.location}` : ""}${issue.checklistName ? ` • چک‌لیست: ${issue.checklistName}` : ""}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((item) => (
            <SecondaryButton
              key={item.action}
              disabled={busy}
              onClick={() =>
                item.action === "resolve" || item.action === "close"
                  ? setDialog(item.action)
                  : item.action === "start"
                    ? start()
                    : void onAct(issue, item.action, {})
              }
            >
              {item.label}
            </SecondaryButton>
          ))}
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
            onClick={onClose}
            aria-label="بستن"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        </div>
      }
      actionsClassName="max-sm:w-full"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={STATUS_TONES[issue.status]}>{issue.statusLabel}</StatusBadge>
          <StatusBadge tone={SEVERITY_TONES[issue.severity] ?? "neutral"}>
            شدت: {issue.severityLabel}
          </StatusBadge>
          {issue.categoryLabel ? (
            <StatusBadge tone="neutral">{issue.categoryLabel}</StatusBadge>
          ) : null}
          {issue.isOverdue ? <StatusBadge tone="danger">عقب‌افتاده</StatusBadge> : null}
          {issue.resultLabel ? (
            <StatusBadge tone={issue.result === "fail" ? "danger" : "positive"}>
              نتیجه: {issue.resultLabel}
            </StatusBadge>
          ) : null}
        </div>

        <dl className="grid gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">مطرح‌کننده</dt>
            <dd className="text-sm">{issue.raisedByName || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">تاریخ طرح</dt>
            <dd className="text-sm">
              <DateCell date={issue.raisedDate} relative={false} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">مسئول رفع</dt>
            <dd className="text-sm">{issue.responsiblePartyName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">مهلت</dt>
            <dd className="text-sm">
              <DateCell date={issue.dueDate} />
            </dd>
          </div>
        </dl>

        {issue.description ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{issue.description}</p>
        ) : null}

        {issue.checks.length > 0 ? (
          <div>
            <h4 className="mb-2 text-sm font-medium">
              ردیف‌های کنترل — {toPersianDigits(String(issue.checks.length))} ردیف
            </h4>
            <ul className="flex flex-col gap-2">
              {issue.checks.map((check) => (
                <li
                  key={check.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 p-2 text-sm"
                >
                  <span className="font-medium">{check.label}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge
                      tone={
                        check.result === "fail"
                          ? "danger"
                          : check.result === "na"
                            ? "neutral"
                            : check.result === "pass"
                              ? "positive"
                              : "active"
                      }
                    >
                      {SITE_CHECK_RESULT_LABELS[check.result as never] ?? check.result}
                    </StatusBadge>
                    {check.checkedByName ? <span>{check.checkedByName}</span> : null}
                  </span>
                  {check.note ? (
                    <span className="w-full text-xs text-muted-foreground">{check.note}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {issue.resolutionNote ? (
          <div>
            <h4 className="mb-1 text-sm font-medium">اقدام انجام‌شده</h4>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{issue.resolutionNote}</p>
            {issue.resolvedByName ? (
              <p className="text-xs text-muted-foreground">
                اصلاح توسط {issue.resolvedByName} — {issue.resolvedAt ? <DateCell date={issue.resolvedAt.slice(0, 10)} relative={false} /> : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {issue.status === "resolved" && canApprove ? (
          <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-xs text-muted-foreground">
            تأیید بستن کار شخص دیگری است: مسئول رفع نمی‌تواند خودش مورد را ببندد. اگر اصلاح کامل نیست،
            «اصلاح دوباره» را بزنید تا کار به جریان برگردد.
          </p>
        ) : null}

        {issue.closeoutNote ? (
          <div className="rounded-xl border border-emerald-300/60 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
            <h4 className="mb-1 text-sm font-medium">تأیید بستن</h4>
            <p className="whitespace-pre-wrap text-sm">{issue.closeoutNote}</p>
            <p className="text-xs text-muted-foreground">
              تأییدکننده {issue.verifiedByName || "—"}
            </p>
          </div>
        ) : null}

        <div>
          <h4 className="mb-2 text-sm font-medium">شواهد و پیوست‌ها</h4>
          {issue.attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">پیوستی ندارد.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {issue.attachments.map((attachment) => (
                <li key={attachment.documentId}>
                  <a
                    className="text-primary hover:underline"
                    href={mediaFileUrl(attachment.documentId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {attachment.title || attachment.fileName || "پیوست"}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {dialog ? (
        <div className={overlayPanelClass}>
          <h3 className="text-sm font-semibold">
            {dialog === "resolve" ? "ثبت اصلاح" : "تأیید و بستن مورد"}
          </h3>
          {dialog === "resolve" ? (
            <>
              <Field label="چه کاری انجام شد؟">
                <textarea
                  className={inputClass}
                  rows={3}
                  value={resolutionNote}
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder="اصلاح انجام‌شده و شواهد آن"
                />
              </Field>
              {issueNeedsResult(issue.kind) ? (
                <SelectField
                  label="نتیجهٔ بازرسی"
                  value={result as SiteIssueResult | ""}
                  onChange={(next) => setResult(next)}
                  options={SITE_ISSUE_RESULTS}
                  labels={SITE_ISSUE_RESULT_LABELS}
                />
              ) : null}
            </>
          ) : (
            <Field label="یادداشت تأیید" hint="چه چیزی را بررسی کردید و کجا را دیدید؟">
              <textarea
                className={inputClass}
                rows={3}
                value={closeoutNote}
                onChange={(event) => setCloseoutNote(event.target.value)}
              />
            </Field>
          )}
          <div className="flex items-center justify-end gap-2">
            <SecondaryButton onClick={() => setDialog(null)}>انصراف</SecondaryButton>
            <PrimaryButton disabled={busy} onClick={submitDialog}>
              {dialog === "resolve" ? "ثبت اصلاح" : "بستن مورد"}
            </PrimaryButton>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------------
 * The form
 * ------------------------------------------------------------------------- */

interface CheckDraft {
  label: string;
  guidance: string;
  result: string;
  note: string;
  checklistItemId: string | null;
}

function IssueForm({
  projectId,
  lookups,
  issue,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  lookups: WorkspaceLookups;
  issue?: IssueDetail;
  onClose: () => void;
  onSaved: (issueId: string) => Promise<void> | void;
  onError: (code: string | undefined) => void;
}) {
  const [kind, setKind] = useState<SiteIssueKind>(issue?.kind ?? "inspection_request");
  const [title, setTitle] = useState(issue?.title ?? "");
  const [description, setDescription] = useState(issue?.description ?? "");
  const [location, setLocation] = useState(issue?.location ?? "");
  const [category, setCategory] = useState(issue?.category ?? "");
  const [severity, setSeverity] = useState<SiteIssueSeverity>(
    (issue?.severity as SiteIssueSeverity) ?? "medium",
  );
  const [responsiblePartyId, setResponsiblePartyId] = useState(issue?.responsiblePartyId ?? "");
  const [assignedToId, setAssignedToId] = useState(issue?.assignedToId ?? "");
  const [raisedDate, setRaisedDate] = useState(issue?.raisedDate ?? "");
  const [dueDate, setDueDate] = useState(issue?.dueDate ?? "");
  const [checklistId, setChecklistId] = useState(issue?.checklistId ?? "");
  const [checklists, setChecklists] = useState<Array<{ id: string; name: string }>>([]);
  const [checks, setChecks] = useState<CheckDraft[]>(
    issue?.checks.map((check) => ({
      label: check.label,
      guidance: check.guidance,
      result: check.result,
      note: check.note,
      checklistItemId: check.checklistItemId,
    })) ?? [],
  );
  // The server re-snapshots the checklist whenever the link changes, so the
  // client only sends `checks` after a hand edit — otherwise the two writes
  // would race and the snapshot would win.
  const [checksEdited, setChecksEdited] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ mediaAssetId: string; title: string }>>(
    issue?.attachments
      .filter((attachment) => attachment.mediaAssetId)
      .map((attachment) => ({ mediaAssetId: attachment.mediaAssetId as string, title: attachment.title })) ?? [],
  );
  const [picking, setPicking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const supportsChecks = issueSupportsChecks(kind);

  useEffect(() => {
    if (!supportsChecks) return;
    let cancelled = false;
    api<{ checklists: Array<{ id: string; name: string }> }>(
      `/api/aec/checklists?projectId=${projectId}`,
    ).then(({ ok, data }) => {
      if (!cancelled && ok) setChecklists(data.checklists);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, supportsChecks]);

  const patchCheck = (index: number, patch: Partial<CheckDraft>) => {
    setChecksEdited(true);
    setChecks((current) => current.map((check, i) => (i === index ? { ...check, ...patch } : check)));
  };

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    const payload: Record<string, unknown> = {
      kind,
      title,
      description,
      location,
      category: category || null,
      severity,
      responsiblePartyId: responsiblePartyId || null,
      assignedToId: assignedToId || null,
      raisedDate: raisedDate || undefined,
      dueDate: dueDate || null,
      checklistId: supportsChecks ? checklistId || null : null,
      attachments: attachments.map((attachment) => ({
        mediaAssetId: attachment.mediaAssetId,
        title: attachment.title,
      })),
    };
    if (checksEdited || (supportsChecks && !checklistId && checks.length > 0)) {
      payload.checks = checks
        .filter((check) => check.label.trim())
        .map((check) => ({
          label: check.label.trim(),
          guidance: check.guidance,
          result: check.result || "pending",
          note: check.note,
          checklistItemId: check.checklistItemId,
        }));
    }
    const { ok, data } = issue
      ? await api<{ issue: IssueDetail }>(`/api/aec/site-issues/${issue.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await api<{ issue: IssueDetail }>(`/api/aec/projects/${projectId}/site-issues`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
    setBusy(false);
    if (!ok) {
      const code = (data as unknown as { error?: string }).error;
      setError(workspaceError(code));
      onError(code);
      return;
    }
    await onSaved(data.issue.id);
  }

  return (
    <div className={overlayPanelClass}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {issue ? `ویرایش ${issue.issueNumber}` : "مورد جدید کارگاه"}
        </h3>
        <button
          type="button"
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
          onClick={onClose}
          aria-label="بستن"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {issue ? (
          // Not a disabled select: the kind is what the number and the checks
          // were built from, so the service refuses to change it and the form
          // says so instead of offering a control that only ever fails.
          <Field label="نوع مورد" hint="نوع پس از ثبت تغییر نمی‌کند.">
            <p className="text-sm font-medium">{SITE_ISSUE_KIND_LABELS[kind]}</p>
          </Field>
        ) : (
          <SelectField
            label="نوع مورد"
            value={kind}
            onChange={(next) => setKind((next || "inspection_request") as SiteIssueKind)}
            options={SITE_ISSUE_KINDS}
            labels={SITE_ISSUE_KIND_LABELS}
          />
        )}
        <SelectField
          label="شدت"
          value={severity}
          onChange={(next) => setSeverity((next || "medium") as SiteIssueSeverity)}
          options={SITE_ISSUE_SEVERITIES}
          labels={SITE_ISSUE_SEVERITY_LABELS}
        />
        <div className="sm:col-span-2">
          <Field label="عنوان">
            <input
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="مثلاً: ترک مویی در دیوار حائل محور B"
            />
          </Field>
        </div>
        <Field label="محل">
          <input
            className={inputClass}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="بلوک، طبقه، محور"
          />
        </Field>
        <SelectField
          label="دسته"
          value={category as SiteIssueCategory | ""}
          onChange={(next) => setCategory(next)}
          options={SITE_ISSUE_CATEGORIES}
          labels={SITE_ISSUE_CATEGORY_LABELS}
          includeAll
          allLabel="—"
        />
        <PickerField
          label="مسئول رفع (طرف)"
          value={responsiblePartyId}
          onChange={setResponsiblePartyId}
          options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
        />
        <PickerField
          label="ارجاع به"
          value={assignedToId}
          onChange={setAssignedToId}
          options={lookups.members.map((member) => ({ id: member.id, label: member.fullName }))}
          hint="بستن مورد را نمی‌تواند خودِ همین نفر تأیید کند."
        />
        <DateField label="تاریخ طرح" value={raisedDate} onChange={setRaisedDate} />
        <DateField label="مهلت رفع" value={dueDate} onChange={setDueDate} />
        {supportsChecks ? (
          <div className="sm:col-span-2">
            <PickerField
              label="چک‌لیست"
              value={checklistId}
              onChange={(next) => {
                setChecklistId(next);
                // The server copies the checklist's items onto the issue when the
                // link changes, so the local rows are cleared rather than sent.
                setChecks([]);
                setChecksEdited(false);
              }}
              options={checklists.map((checklist) => ({ id: checklist.id, label: checklist.name }))}
              hint={
                checklistId
                  ? "ردیف‌های الگو روی همین مورد کپی می‌شوند؛ نتیجهٔ هر ردیف را پایین ثبت کنید."
                  : "اختیاری — می‌توانید ردیف‌های کنترل را دستی هم اضافه کنید."
              }
            />
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <Field label="شرح">
            <textarea
              className={inputClass}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="آنچه دیده شد، اندازه‌ها، ارجاع به نقشه یا مشخصات"
            />
          </Field>
        </div>
      </div>

      {supportsChecks ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">ردیف‌های کنترل</h4>
            <SecondaryButton
              onClick={() => {
                setChecksEdited(true);
                setChecks((current) => [
                  ...current,
                  { label: "", guidance: "", result: "pending", note: "", checklistItemId: null },
                ]);
              }}
            >
              <PlusIcon className="size-4" aria-hidden />
              افزودن ردیف
            </SecondaryButton>
          </div>
          {checks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              ردیفی نیست. یک چک‌لیست انتخاب کنید یا ردیف دستی اضافه کنید.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {checks.map((check, index) => (
                <li key={index} className="flex flex-col gap-2 rounded-xl border border-border/80 p-3">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field label="بند کنترل">
                        <input
                          className={inputClass}
                          value={check.label}
                          onChange={(event) => patchCheck(index, { label: event.target.value })}
                        />
                      </Field>
                    </div>
                    <div className="w-36">
                      <SelectField
                        label="نتیجه"
                        value={check.result as SiteCheckResult | ""}
                        onChange={(next) => patchCheck(index, { result: next || "pending" })}
                        options={SITE_CHECK_RESULTS}
                        labels={SITE_CHECK_RESULT_LABELS}
                      />
                    </div>
                    <button
                      type="button"
                      className="mb-1 rounded-lg p-1.5 text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        setChecksEdited(true);
                        setChecks((current) => current.filter((_, i) => i !== index));
                      }}
                      aria-label="حذف ردیف"
                    >
                      <Trash2Icon className="size-4" aria-hidden />
                    </button>
                  </div>
                  <Field label="یادداشت ردیف">
                    <input
                      className={inputClass}
                      value={check.note}
                      onChange={(event) => patchCheck(index, { note: event.target.value })}
                    />
                  </Field>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">شواهد و پیوست‌ها</h4>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:max-w-72">
            <PickerField
              label="افزودن از کتابخانهٔ رسانه"
              value={picking}
              onChange={setPicking}
              options={lookups.media.map((asset) => ({ id: asset.id, label: asset.fileName }))}
            />
          </div>
          <SecondaryButton
            disabled={!picking}
            onClick={() => {
              const asset = lookups.media.find((item) => item.id === picking);
              if (!asset) return;
              setAttachments((current) => [
                ...current,
                { mediaAssetId: asset.id, title: asset.fileName },
              ]);
              setPicking("");
            }}
          >
            افزودن
          </SecondaryButton>
        </div>
        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">پیوستی انتخاب نشده است.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {attachments.map((attachment, index) => (
              <li key={attachment.mediaAssetId} className="flex items-center justify-between gap-2">
                <span>{attachment.title}</span>
                <button
                  type="button"
                  className="rounded-lg p-1 text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    setAttachments((current) => current.filter((_, i) => i !== index))
                  }
                  aria-label="حذف پیوست"
                >
                  <XIcon className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton disabled={busy || !title.trim()} onClick={() => void save()}>
          {issue ? "ذخیرهٔ تغییرات" : "ثبت مورد"}
        </PrimaryButton>
      </div>
    </div>
  );
}
