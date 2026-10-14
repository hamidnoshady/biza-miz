"use client";

/**
 * Issue #799 §13 on screen — «کارگاه و گزارش روزانه»: the day the site had, and
 * the chronological record of the days and of what was found on them.
 *
 * The tab answers three questions in the order a site manager asks them:
 *
 *   1. what happened today (and what happened on each day before it) — the log
 *      register, newest first, with the workforce, the deliveries and the
 *      incidents counted from the day's own lines rather than typed twice;
 *   2. what is in the record — one day's narrative, its attendance, plant,
 *      deliveries, delays, incidents, instructions and visitors, and its photos;
 *   3. what the project's operational history looks like — «روزنگار», the days
 *      and the quality register merged on one timeline, which is §13's "site
 *      diary / activity feed" composed from the two registers rather than stored
 *      a third time.
 *
 * ## What the screen is careful about
 *
 *   * **A signed day looks signed.** Submitting freezes the day *and its lines*
 *     (migration 0199), so once it is «ثبتشده» the form is gone, the numbers are
 *     text, and the only control left is «باز کردن برای ویرایش» — a control that
 *     only ever fails is worse than no control.
 *   * **A line is shaped by its kind.** Attendance has a headcount, a delivery
 *     has a quantity and a unit, plant has hours: the inputs come from
 *     `SITE_LOG_LINE_SHAPES`, which is the same table the database's CHECK
 *     enforces, so the form cannot ask for something the schema refuses.
 *   * **The diary shows the register too, when there is one.** The quality half
 *     is fetched only for a business whose profile has `qa_qc` — for anyone else
 *     the endpoint would (correctly) refuse, so the tab does not ask.
 *   * **One day per project per date.** The date field says so and the service
 *     refuses a second one, because a site that reports twice on the same day is
 *     not keeping a log.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDaysIcon,
  HardHatIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  UndoIcon,
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
  SITE_LOG_LINE_KINDS,
  SITE_LOG_LINE_LABELS,
  SITE_LOG_LINE_SHAPES,
  SITE_LOG_STATUSES,
  SITE_LOG_STATUS_LABELS,
  type SiteLogLineKind,
  type SiteLogStatus,
} from "@/lib/aec-site";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, SelectField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface SiteLogLine {
  id: string;
  kind: SiteLogLineKind;
  kindLabel: string;
  title: string;
  partyId: string | null;
  partyName: string | null;
  quantity: number | null;
  unit: string | null;
  headcount: number | null;
  hours: number | null;
  note: string;
  position: number;
}

interface SiteAttachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

interface SiteLogSummary {
  id: string;
  projectId: string;
  logDate: string;
  status: SiteLogStatus;
  statusLabel: string;
  authorUserId: string | null;
  authorName: string;
  workPerformed: string;
  weather: string;
  safetyNote: string;
  notes: string;
  submittedByName: string;
  submittedAt: string | null;
  createdAt: string;
  createdByName: string;
  lineCount: number;
  workforce: number;
  incidentCount: number;
  deliveryCount: number;
  attachmentCount: number;
  isEditable: boolean;
}

interface SiteLogDetail extends SiteLogSummary {
  lines: SiteLogLine[];
  attachments: SiteAttachment[];
}

/** The quality half of the diary: only what the timeline needs to render a row. */
interface DiaryIssue {
  id: string;
  issueNumber: string;
  kind: string;
  kindLabel: string;
  title: string;
  location: string;
  severityLabel: string;
  severity: string;
  statusLabel: string;
  status: string;
  raisedDate: string;
  dueDate: string | null;
  isOverdue: boolean;
}

const STATUS_TONES: Record<SiteLogStatus, "neutral" | "positive"> = {
  draft: "neutral",
  submitted: "positive",
};

const SEVERITY_TONES: Record<string, "neutral" | "active" | "danger"> = {
  low: "neutral",
  medium: "active",
  high: "danger",
  critical: "danger",
};

/** One editable line in the form — the wire shape minus the server's ids. */
interface LineDraft {
  kind: SiteLogLineKind;
  title: string;
  partyId: string;
  quantity: string;
  unit: string;
  headcount: string;
  hours: string;
  note: string;
}

function emptyLine(): LineDraft {
  return {
    kind: "attendance",
    title: "",
    partyId: "",
    quantity: "",
    unit: "",
    headcount: "",
    hours: "",
    note: "",
  };
}

interface AttachmentDraft {
  mediaAssetId: string;
  title: string;
}

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecSiteTab({
  projectId,
  canManage,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  lookups: WorkspaceLookups;
}) {
  const [logs, setLogs] = useState<SiteLogSummary[] | null>(null);
  const [issues, setIssues] = useState<DiaryIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SiteLogDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SiteLogDetail | null>(null);
  const [view, setView] = useState<"logs" | "diary">("logs");
  const [statusFilter, setStatusFilter] = useState<SiteLogStatus | "">("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const hasQuality = lookups.aecCapabilities?.includes("qa_qc") ?? false;
  const fail = (code: string | undefined) => setError(workspaceError(code));

  const load = useCallback(
    async (preferId?: string | null) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const suffix = params.size ? `?${params.toString()}` : "";
      const { ok, data } = await api<{ logs: SiteLogSummary[] }>(
        `/api/aec/projects/${projectId}/site-logs${suffix}`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setLogs([]);
        return null;
      }
      setLogs(data.logs);
      const next = data.logs.find((log) => log.id === preferId) ?? data.logs[0] ?? null;
      setSelectedId(next ? next.id : null);
      return next;
    },
    [projectId, search, statusFilter],
  );

  const loadDetail = useCallback(async (logId: string) => {
    const { ok, data } = await api<{ log: SiteLogDetail }>(`/api/aec/site-logs/${logId}`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setDetail(null);
      return;
    }
    setDetail(data.log);
  }, []);

  const loadIssues = useCallback(async () => {
    if (!hasQuality) {
      setIssues([]);
      return;
    }
    const { ok, data } = await api<{ issues: DiaryIssue[] }>(
      `/api/aec/projects/${projectId}/site-issues`,
    );
    // A business whose profile has no quality register is not an error here:
    // the diary simply carries the days, which is what §13 asks of it.
    setIssues(ok ? data.issues : []);
  }, [hasQuality, projectId]);

  const refresh = useCallback(
    async (preferId?: string | null) => {
      const next = await load(preferId);
      if (next) await loadDetail(next.id);
      else setDetail(null);
      await loadIssues();
    },
    [load, loadDetail, loadIssues],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = useMemo(() => {
    const list = logs ?? [];
    const workforce = list.reduce((total, log) => total + log.workforce, 0);
    const deliveries = list.reduce((total, log) => total + log.deliveryCount, 0);
    const incidents = list.reduce((total, log) => total + log.incidentCount, 0);
    return { workforce, deliveries, incidents };
  }, [logs]);

  async function act(log: SiteLogSummary, action: "submit" | "reopen") {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ log: SiteLogDetail }>(`/api/aec/site-logs/${log.id}/status`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "submit"
        ? `گزارش روزانهٔ ${data.log.logDate} ثبت نهایی شد و تا باز کردن دوباره تغییر نمی‌کند.`
        : `گزارش روزانهٔ ${data.log.logDate} برای ویرایش باز شد.`,
    );
    await refresh(data.log.id);
  }

  async function remove(log: SiteLogSummary) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/site-logs/${log.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("گزارش روزانهٔ پیش‌نویس حذف شد.");
    await refresh(null);
  }

  if (!logs) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="گزارش‌های روزانه" value="—" />
          <KpiCard label="نیروی کار" value="—" />
          <KpiCard label="مصالح رسیده" value="—" />
          <KpiCard label="رخدادها" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const n = (value: number | string) => toPersianDigits(String(value));
  const diary = buildDiary(logs, issues);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      <KpiRow>
        <KpiCard label="گزارش‌های روزانه" value={n(logs.length)} hint="در این نما" />
        <KpiCard label="نیروی کار" value={n(totals.workforce)} hint="مجموع نفرات ثبت‌شده" />
        <KpiCard label="مصالح رسیده" value={n(totals.deliveries)} hint="تعداد تحویل‌ها" />
        <KpiCard
          label="رخدادها"
          value={n(totals.incidents)}
          hint={totals.incidents > 0 ? "نیازمند بررسی ایمنی" : "رخدادی ثبت نشده است"}
        />
      </KpiRow>

      <SectionCard
        title="کارگاه و گزارش روزانه"
        description="هر روز یک گزارش دارد: شرح کار، نیرو، ماشین‌آلات، مصالح رسیده، تأخیر، رخداد، دستورکار و بازدیدکننده. تا وقتی پیش‌نویس است ویرایش می‌شود؛ بعد از ثبت، فقط با «باز کردن» تغییر می‌کند."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={() => setView(view === "logs" ? "diary" : "logs")}>
              <CalendarDaysIcon className="size-4" aria-hidden />
              {view === "logs" ? "روزنگار کارگاه" : "فهرست گزارش‌ها"}
            </SecondaryButton>
            {canManage ? (
              <SecondaryButton onClick={() => setCreating((open) => !open)}>
                <PlusIcon className="size-4" aria-hidden />
                گزارش جدید
              </SecondaryButton>
            ) : null}
          </div>
        }
        actionsClassName="max-sm:w-full"
        flush
      >
        {creating ? (
          <SiteLogForm
            projectId={projectId}
            lookups={lookups}
            onClose={() => setCreating(false)}
            onError={fail}
            onSaved={async (logId) => {
              setCreating(false);
              setNotice("گزارش روزانه ثبت شد. حالا ردیف‌ها را کامل کنید و «ثبت نهایی» را بزنید.");
              await refresh(logId);
            }}
          />
        ) : null}

        {view === "logs" ? (
          <>
            <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
              <div className="w-full sm:w-40">
                <SelectField
                  label="وضعیت"
                  value={statusFilter}
                  onChange={(next) => setStatusFilter(next as SiteLogStatus | "")}
                  options={SITE_LOG_STATUSES}
                  labels={SITE_LOG_STATUS_LABELS}
                  includeAll
                  allLabel="همه"
                />
              </div>
              <div className="w-full sm:max-w-72">
                <Field label="جست‌وجو">
                  <input
                    className={inputClass}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="شرح کار، آب‌وهوا، ایمنی یا نویسنده"
                  />
                </Field>
              </div>
            </div>

            {logs.length === 0 ? (
              <EmptyState
                icon={HardHatIcon}
                title="هنوز گزارش روزانه‌ای ثبت نشده است"
              >
                با «گزارش جدید» روز کاری را ثبت کنید: شرح کار، نیرو، ماشین‌آلات و مصالح رسیده. گزارش
                هر روز یکتاست.
              </EmptyState>
            ) : (
              <DataTable caption="گزارش‌های روزانهٔ کارگاه">
                <DataTableHead>
                  <DataTableRow>
                    <Th>تاریخ</Th>
                    <Th>نویسنده</Th>
                    <Th>نیرو</Th>
                    <Th>مصالح</Th>
                    <Th>رخداد</Th>
                    <Th>پیوست</Th>
                    <Th>وضعیت</Th>
                    <Th className="w-24" />
                  </DataTableRow>
                </DataTableHead>
                <DataTableBody>
                  {logs.map((log) => (
                    <DataTableRow
                      key={log.id}
                      className={log.id === selectedId ? "bg-muted/40" : undefined}
                    >
                      <Td>
                        <button
                          type="button"
                          className="font-medium hover:underline"
                          onClick={() => {
                            setSelectedId(log.id);
                            void loadDetail(log.id);
                          }}
                        >
                          <DateCell date={log.logDate} />
                        </button>
                      </Td>
                      <Td>{log.authorName || "—"}</Td>
                      <Td>{n(log.workforce)}</Td>
                      <Td>{n(log.deliveryCount)}</Td>
                      <Td>{log.incidentCount > 0 ? n(log.incidentCount) : "—"}</Td>
                      <Td>{log.attachmentCount > 0 ? n(log.attachmentCount) : "—"}</Td>
                      <Td>
                        <StatusBadge tone={STATUS_TONES[log.status]}>{log.statusLabel}</StatusBadge>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1">
                          {canManage && log.isEditable ? (
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                              title="ویرایش"
                              onClick={async () => {
                                const { ok, data } = await api<{ log: SiteLogDetail }>(
                                  `/api/aec/site-logs/${log.id}`,
                                );
                                if (!ok) {
                                  fail((data as unknown as { error?: string }).error);
                                  return;
                                }
                                setEditing(data.log);
                              }}
                            >
                              <PencilIcon className="size-4" aria-hidden />
                            </button>
                          ) : null}
                          {canManage && log.status === "draft" ? (
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-destructive hover:bg-destructive/10"
                              title="حذف پیش‌نویس"
                              onClick={() => void remove(log)}
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
          </>
        ) : (
          <DiaryFeed entries={diary} issuesShown={hasQuality} />
        )}
      </SectionCard>

      {editing ? (
        <SiteLogForm
          projectId={projectId}
          lookups={lookups}
          log={editing}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async (logId) => {
            setEditing(null);
            setNotice("گزارش روزانه ویرایش شد.");
            await refresh(logId);
          }}
        />
      ) : null}

      {detail ? (
        <SiteLogCard
          log={detail}
          canManage={canManage}
          busy={busy}
          onAction={(action) => void act(detail, action)}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * One day's card
 * ------------------------------------------------------------------------- */

function SiteLogCard({
  log,
  canManage,
  busy,
  onAction,
}: {
  log: SiteLogDetail;
  canManage: boolean;
  busy: boolean;
  onAction: (action: "submit" | "reopen") => void;
}) {
  const grouped = SITE_LOG_LINE_KINDS.map((kind) => ({
    kind,
    lines: log.lines.filter((line) => line.kind === kind),
  })).filter((group) => group.lines.length > 0);

  return (
    <SectionCard
      title={`گزارش روزانهٔ ${log.logDate}`}
      description={
        log.status === "submitted"
          ? `${log.statusLabel}${log.submittedByName ? ` توسط ${log.submittedByName}` : ""} — برای تغییر، ابتدا آن را باز کنید.`
          : "پیش‌نویس — هنوز ثبت نهایی نشده است."
      }
      actions={
        canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {log.status === "draft" ? (
              <PrimaryButton disabled={busy} onClick={() => onAction("submit")}>
                <SendIcon className="size-4" aria-hidden />
                ثبت نهایی روز
              </PrimaryButton>
            ) : (
              <SecondaryButton disabled={busy} onClick={() => onAction("reopen")}>
                <UndoIcon className="size-4" aria-hidden />
                باز کردن برای ویرایش
              </SecondaryButton>
            )}
          </div>
        ) : null
      }
      actionsClassName="max-sm:w-full"
    >
      <div className="flex flex-col gap-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">نویسنده</dt>
            <dd className="text-sm font-medium">{log.authorName || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">آب‌وهوا</dt>
            <dd className="text-sm">{log.weather || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">مجموع نیرو</dt>
            <dd className="text-sm font-medium">
              {toPersianDigits(String(log.lines.reduce((total, line) => total + (line.headcount ?? 0), 0)))}
            </dd>
          </div>
        </dl>

        <div>
          <h4 className="mb-1 text-sm font-medium">شرح کارهای انجام‌شده</h4>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {log.workPerformed || "—"}
          </p>
        </div>

        {log.safetyNote ? (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
            <h4 className="mb-1 text-sm font-medium">ایمنی و رخدادها</h4>
            <p className="whitespace-pre-wrap text-sm">{log.safetyNote}</p>
          </div>
        ) : null}

        {grouped.length === 0 ? (
          <p className="text-sm text-muted-foreground">ردیفی برای این روز ثبت نشده است.</p>
        ) : (
          grouped.map((group) => (
            <div key={group.kind}>
              <h4 className="mb-2 text-sm font-medium">{SITE_LOG_LINE_LABELS[group.kind]}</h4>
              <ul className="flex flex-col gap-2">
                {group.lines.map((line) => (
                  <li
                    key={line.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 p-2 text-sm"
                  >
                    <span className="font-medium">{line.title}</span>
                    <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {line.partyName ? <span>{line.partyName}</span> : null}
                      {line.headcount !== null ? (
                        <span>{toPersianDigits(String(line.headcount))} نفر</span>
                      ) : null}
                      {line.quantity !== null ? (
                        <span>
                          {toPersianDigits(String(line.quantity))} {line.unit ?? ""}
                        </span>
                      ) : null}
                      {line.hours !== null ? (
                        <span>{toPersianDigits(String(line.hours))} ساعت</span>
                      ) : null}
                    </span>
                    {line.note ? (
                      <span className="w-full text-xs text-muted-foreground">{line.note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}

        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <PaperclipIcon className="size-4" aria-hidden />
            عکس‌ها و پیوست‌ها
          </h4>
          {log.attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">پیوستی ندارد.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {log.attachments.map((attachment) => (
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

        {log.notes ? (
          <div>
            <h4 className="mb-1 text-sm font-medium">یادداشت</h4>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{log.notes}</p>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------------
 * The diary — §13's chronological operational record
 * ------------------------------------------------------------------------- */

interface DiaryEntry {
  key: string;
  date: string;
  kind: "log" | "issue";
  title: string;
  detail: string;
  badge: string;
  tone: "neutral" | "positive" | "active" | "danger";
}

/**
 * The days and the quality register on one timeline.
 *
 * Composed here rather than stored: a third table of "things that happened"
 * would be a second copy of two registers that already say when they happened,
 * and the copies would drift the first time a log was reopened.
 */
function buildDiary(logs: SiteLogSummary[], issues: DiaryIssue[]): DiaryEntry[] {
  const entries: DiaryEntry[] = [];
  for (const log of logs) {
    const parts = [
      log.workforce > 0 ? `${toPersianDigits(String(log.workforce))} نفر` : "",
      log.deliveryCount > 0 ? `${toPersianDigits(String(log.deliveryCount))} تحویل مصالح` : "",
      log.incidentCount > 0 ? `${toPersianDigits(String(log.incidentCount))} رخداد` : "",
    ].filter(Boolean);
    entries.push({
      key: `log-${log.id}`,
      date: log.logDate,
      kind: "log",
      title: log.workPerformed.split("\n")[0]?.slice(0, 120) || "گزارش روزانه",
      detail: parts.join(" • "),
      badge: log.statusLabel,
      tone: log.status === "submitted" ? "positive" : "neutral",
    });
  }
  for (const issue of issues) {
    entries.push({
      key: `issue-${issue.id}`,
      date: issue.raisedDate,
      kind: "issue",
      title: `${issue.issueNumber} — ${issue.title}`,
      detail: [
        issue.kindLabel,
        issue.location,
        `شدت ${issue.severityLabel}`,
        issue.isOverdue ? "عقب‌افتاده" : "",
      ]
        .filter(Boolean)
        .join(" • "),
      badge: issue.statusLabel,
      tone: issue.isOverdue
        ? "danger"
        : issue.status === "closed"
          ? "positive"
          : SEVERITY_TONES[issue.severity] ?? "active",
    });
  }
  return entries.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

function DiaryFeed({ entries, issuesShown }: { entries: DiaryEntry[]; issuesShown: boolean }) {
  if (entries.length === 0) {
    return (
      <EmptyState icon={CalendarDaysIcon} title="روزنگار خالی است">
        با ثبت گزارش روزانه یا رفع یک مورد کیفیت، روزنگار کارگاه ساخته می‌شود.
      </EmptyState>
    );
  }
  return (
    <div className="p-4">
      <p className="mb-3 text-xs text-muted-foreground">
        {issuesShown
          ? "گزارش‌های روزانه و موارد کیفیت، به ترتیب تاریخ. موارد کارگاه از دفتر «بازرسی و کنترل کیفیت» خوانده می‌شوند."
          : "گزارش‌های روزانه، به ترتیب تاریخ. دفتر بازرسی و کنترل کیفیت برای این کسب‌وکار روشن نیست."}
      </p>
      <ol className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={entry.key}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 p-3"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-xs text-muted-foreground">
                <DateCell date={entry.date} />
                {entry.kind === "issue" ? " • مورد کارگاه" : " • گزارش روزانه"}
              </span>
              <span className="truncate text-sm font-medium">{entry.title}</span>
              {entry.detail ? (
                <span className="text-xs text-muted-foreground">{entry.detail}</span>
              ) : null}
            </div>
            <StatusBadge tone={entry.tone}>{entry.badge}</StatusBadge>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The form
 * ------------------------------------------------------------------------- */

function SiteLogForm({
  projectId,
  lookups,
  log,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  lookups: WorkspaceLookups;
  log?: SiteLogDetail;
  onClose: () => void;
  onSaved: (logId: string) => Promise<void> | void;
  onError: (code: string | undefined) => void;
}) {
  const [logDate, setLogDate] = useState(log?.logDate ?? "");
  const [authorUserId, setAuthorUserId] = useState(log?.authorUserId ?? "");
  const [workPerformed, setWorkPerformed] = useState(log?.workPerformed ?? "");
  const [weather, setWeather] = useState(log?.weather ?? "");
  const [safetyNote, setSafetyNote] = useState(log?.safetyNote ?? "");
  const [notes, setNotes] = useState(log?.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    log?.lines.map((line) => ({
      kind: line.kind,
      title: line.title,
      partyId: line.partyId ?? "",
      quantity: line.quantity === null ? "" : String(line.quantity),
      unit: line.unit ?? "",
      headcount: line.headcount === null ? "" : String(line.headcount),
      hours: line.hours === null ? "" : String(line.hours),
      note: line.note,
    })) ?? [],
  );
  const [attachments, setAttachments] = useState<AttachmentDraft[]>(
    log?.attachments
      .filter((attachment) => attachment.mediaAssetId)
      .map((attachment) => ({
        mediaAssetId: attachment.mediaAssetId as string,
        title: attachment.title,
      })) ?? [],
  );
  const [picking, setPicking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const patchLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    const payload = {
      logDate: logDate || undefined,
      authorUserId: authorUserId || undefined,
      workPerformed,
      weather,
      safetyNote,
      notes,
      lines: lines
        .filter((line) => line.title.trim())
        .map((line) => ({
          kind: line.kind,
          title: line.title.trim(),
          partyId: line.partyId || null,
          quantity: line.quantity === "" ? null : Number(line.quantity),
          unit: line.unit || null,
          headcount: line.headcount === "" ? null : Number(line.headcount),
          hours: line.hours === "" ? null : Number(line.hours),
          note: line.note,
        })),
      // `undefined` leaves the attachments alone; the form always sends the list
      // it is showing, which is what "wholesale replacement" means.
      attachments: attachments.map((attachment) => ({
        mediaAssetId: attachment.mediaAssetId,
        title: attachment.title,
      })),
    };
    const { ok, data } = log
      ? await api<{ log: SiteLogDetail }>(`/api/aec/site-logs/${log.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await api<{ log: SiteLogDetail }>(`/api/aec/projects/${projectId}/site-logs`, {
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
    await onSaved(data.log.id);
  }

  return (
    <div className={overlayPanelClass}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {log ? `ویرایش گزارش روزانهٔ ${log.logDate}` : "گزارش روزانهٔ کارگاه"}
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
        <DateField label="تاریخ روز" value={logDate} onChange={setLogDate} />
        <PickerField
          label="نویسندهٔ گزارش"
          value={authorUserId}
          onChange={setAuthorUserId}
          options={lookups.members.map((member) => ({ id: member.id, label: member.fullName }))}
          placeholder={log ? log.authorName : "خودم"}
          hint="خالی بگذارید تا نام شما ثبت شود."
        />
        <div className="sm:col-span-2">
          <Field label="شرح کارهای انجام‌شده">
            <textarea
              className={inputClass}
              rows={3}
              value={workPerformed}
              onChange={(event) => setWorkPerformed(event.target.value)}
              placeholder="امروز چه کاری روی سایت انجام شد؟"
            />
          </Field>
        </div>
        <Field label="آب‌وهوا">
          <input
            className={inputClass}
            value={weather}
            onChange={(event) => setWeather(event.target.value)}
            placeholder="آفتابی، ۲۸ درجه"
          />
        </Field>
        <Field label="ایمنی و رخدادها">
          <input
            className={inputClass}
            value={safetyNote}
            onChange={(event) => setSafetyNote(event.target.value)}
            placeholder="حادثه‌ای رخ نداده / توضیح کوتاه"
          />
        </Field>
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
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">ردیف‌های روز</h4>
          <SecondaryButton onClick={() => setLines((current) => [...current, emptyLine()])}>
            <PlusIcon className="size-4" aria-hidden />
            افزودن ردیف
          </SecondaryButton>
        </div>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            ردیفی اضافه نشده است. نیرو، ماشین‌آلات، مصالح، تأخیر، رخداد، دستورکار و بازدیدکننده را
            می‌توانید اینجا ثبت کنید.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {lines.map((line, index) => {
              const shape = SITE_LOG_LINE_SHAPES[line.kind];
              return (
                <li
                  key={index}
                  className="flex flex-col gap-2 rounded-xl border border-border/80 p-3"
                >
                  <div className="flex items-end gap-2">
                    <div className="w-40">
                      <SelectField
                        label="نوع"
                        value={line.kind}
                        onChange={(next) =>
                          patchLine(index, { kind: (next || "attendance") as SiteLogLineKind })
                        }
                        options={SITE_LOG_LINE_KINDS}
                        labels={SITE_LOG_LINE_LABELS}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Field label={line.kind === "material" ? "مصالح" : "عنوان"}>
                        <input
                          className={inputClass}
                          value={line.title}
                          onChange={(event) => patchLine(index, { title: event.target.value })}
                          placeholder={
                            line.kind === "attendance"
                              ? "اکیپ بتن‌ریزی"
                              : line.kind === "material"
                                ? "سیمان تیپ ۲"
                                : line.kind === "equipment"
                                  ? "پمپ بتن"
                                  : "موضوع"
                          }
                        />
                      </Field>
                    </div>
                    <button
                      type="button"
                      className="mb-1 rounded-lg p-1.5 text-destructive hover:bg-destructive/10"
                      onClick={() =>
                        setLines((current) => current.filter((_, i) => i !== index))
                      }
                      aria-label="حذف ردیف"
                    >
                      <Trash2Icon className="size-4" aria-hidden />
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-4">
                    {shape.party ? (
                      <PickerField
                        label="طرف/پیمانکار"
                        value={line.partyId}
                        onChange={(next) => patchLine(index, { partyId: next })}
                        options={lookups.parties.map((party) => ({
                          id: party.id,
                          label: party.name,
                        }))}
                      />
                    ) : null}
                    {shape.headcount ? (
                      <Field label="تعداد نفر">
                        <input
                          className={inputClass}
                          inputMode="numeric"
                          value={line.headcount}
                          onChange={(event) => patchLine(index, { headcount: event.target.value })}
                        />
                      </Field>
                    ) : null}
                    {shape.quantity ? (
                      <Field label="مقدار">
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => patchLine(index, { quantity: event.target.value })}
                        />
                      </Field>
                    ) : null}
                    {shape.unit ? (
                      <Field label="واحد">
                        <input
                          className={inputClass}
                          value={line.unit}
                          onChange={(event) => patchLine(index, { unit: event.target.value })}
                          placeholder="تن / عدد / مترمکعب"
                        />
                      </Field>
                    ) : null}
                    {shape.hours ? (
                      <Field label="ساعت">
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={line.hours}
                          onChange={(event) => patchLine(index, { hours: event.target.value })}
                        />
                      </Field>
                    ) : null}
                    <Field label="توضیح">
                      <input
                        className={inputClass}
                        value={line.note}
                        onChange={(event) => patchLine(index, { note: event.target.value })}
                      />
                    </Field>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <PaperclipIcon className="size-4" aria-hidden />
          عکس‌ها و پیوست‌ها
        </h4>
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
        <PrimaryButton disabled={busy} onClick={() => void save()}>
          {log ? "ذخیرهٔ تغییرات" : "ثبت گزارش"}
        </PrimaryButton>
      </div>
    </div>
  );
}
