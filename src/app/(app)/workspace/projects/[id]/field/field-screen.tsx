"use client";

/**
 * «حالت کارگاه» (issue #799 §25) — the phone screen a site user opens.
 *
 * The design rules the issue states, and where each one lives:
 *
 *   * **RTL / responsive / touch friendly** — one column on a phone, two on a
 *     wider screen, every control `min-h-12` and up; nothing depends on hover.
 *   * **no desktop-only large tables for critical work** — the queues are cards,
 *     capped at five rows each (`AEC_FIELD_QUEUE_LIMIT`), with the full register
 *     one tap away in the project tab that owns it.
 *   * **fast file/photo capture, clear upload progress** — the photo control is
 *     a `<input capture="environment">` and the upload is an XHR with a real
 *     percentage bar, because `fetch` cannot report upload progress.
 *   * **drafts where safe** — a capture form keeps its half-typed state in
 *     `localStorage` under the project and action; the two decisions
 *     (approve/reject and a task status) never do, and the action catalogue says
 *     so in code (`AEC_FIELD_ACTIONS[].draftSafe`).
 *   * **Shamsi dates** — every date on screen comes from the API already
 *     formatted (`dateJalali`), and the composer sends the Gregorian date the
 *     database stores.
 *
 * §34 applies too: the phone is a **queue plus contextual actions**, not a
 * second copy of the registers — every review action links into the project's
 * own tab (`?tab=`), and the mapping is printed at the bottom of the screen so
 * the coverage is auditable rather than implied.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  CameraIcon,
  CheckIcon,
  CloudOffIcon,
  FileSignatureIcon,
  HardHatIcon,
  ListChecksIcon,
  PaperclipIcon,
  RulerIcon,
  SendIcon,
  TruckIcon,
  XIcon,
} from "lucide-react";
import { SectionCardSkeleton, overlayPanelClass } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
// The catalogue lives in its own module because it is *data*, and this screen is
// a client component: importing it from `aec-field.ts` (which composes the board
// from the services) would pull `pg` and the server layer into the browser
// bundle. `client-bundle-boundary.test.ts` guards the rule.
import {
  AEC_FIELD_ACTIONS,
  AEC_FIELD_RULES,
  type AecFieldAction,
  type FieldBoard,
  type FieldDrawingRow,
  type FieldQueueRow,
} from "@/lib/aec-field-catalogue";
import { SITE_ISSUE_SEVERITIES, SITE_ISSUE_SEVERITY_LABELS } from "@/lib/aec-site";
import { TASK_STATUSES, TASK_STATUS_LABELS, type WorkspaceTaskStatus } from "@/lib/workspace-shared";

const SEVERITIES = SITE_ISSUE_SEVERITIES;

interface Draft {
  [field: string]: string;
}

function draftKey(projectId: string, action: string): string {
  return `aec-field-draft:${projectId}:${action}`;
}

function readDraft(projectId: string, action: string): Draft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(draftKey(projectId, action));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft;
    return Object.values(parsed).some((value) => String(value).trim().length > 0) ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(projectId: string, action: string, draft: Draft): void {
  if (typeof window === "undefined") return;
  const meaningful = Object.fromEntries(
    Object.entries(draft).filter(([, value]) => String(value ?? "").trim().length > 0),
  );
  if (Object.keys(meaningful).length === 0) {
    window.localStorage.removeItem(draftKey(projectId, action));
    return;
  }
  window.localStorage.setItem(draftKey(projectId, action), JSON.stringify(meaningful));
}

function clearDraft(projectId: string, action: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(draftKey(projectId, action));
}

/** Every capture sheet's action, in the order the issue lists them. */
type SheetKey =
  | "site_log"
  | "site_photo"
  | "snag"
  | "inspection"
  | "rfi"
  | "checklist"
  | "task"
  | "delivery";

const CAPTURE_SHEETS: SheetKey[] = ["site_log", "site_photo", "snag", "inspection", "rfi", "checklist", "task", "delivery"];

export function FieldScreen({ projectId }: { projectId: string }) {
  const [board, setBoard] = useState<FieldBoard | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [sheet, setSheet] = useState<SheetKey | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const load = useCallback(() => {
    api<{ board: FieldBoard }>(`/api/aec/projects/${projectId}/field`).then(({ ok, data }) => {
      setLoaded(true);
      if (ok) setBoard(data.board);
      else setError("این صفحه برای کسب‌وکارهای مهندسی و ساختمانی و اعضای همین پروژه است.");
    });
  }, [projectId]);

  useEffect(load, [load]);

  // Which drafts exist — read once on mount and refreshed when a sheet closes.
  const refreshDrafts = useCallback(() => {
    const found: Record<string, Draft> = {};
    for (const action of AEC_FIELD_ACTIONS) {
      if (!action.draftSafe) continue;
      const draft = readDraft(projectId, action.key);
      if (draft) found[action.key] = draft;
    }
    setDrafts(found);
  }, [projectId]);

  useEffect(refreshDrafts, [refreshDrafts]);

  const open = (key: SheetKey, id: string | null = null) => {
    setFocusId(id);
    setSheet(key);
  };

  const close = () => {
    setSheet(null);
    setFocusId(null);
    refreshDrafts();
  };

  const after = () => {
    close();
    load();
  };

  if (!loaded) {
    // The first read reserves the board's shape rather than writing «در حال
    // خواندن…» on an empty page (docs/design-system.md §Charts and loading).
    return (
      <div className="space-y-4">
        <SectionCardSkeleton rows={2} label="وضعیت کارگاه" />
        <SectionCardSkeleton rows={4} label="کارهای کارگاه" />
        <SectionCardSkeleton rows={3} label="نواقص باز" />
      </div>
    );
  }

  if (error || !board) return <ErrorBox>{error || "وضعیت کارگاه خوانده نشد."}</ErrorBox>;

  const can = (action: AecFieldAction) =>
    action.capability === null || board.capabilities.includes(action.capability);

  const draftCount = Object.keys(drafts).length;

  return (
    <div className="space-y-5 pb-24">
      <header className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">امروز در کارگاه</p>
            <p className="text-lg font-semibold tabular-nums">{board.todayJalali}</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs ${
              board.queues.siteLog.todayLogged
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
            }`}
          >
            {board.queues.siteLog.todayLogged ? "گزارش امروز ثبت شده است" : "گزارش امروز ثبت نشده"}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {board.project.name} — {board.project.statusLabel}. هر کاری که در کارگاه انجام می‌دهید از همین صفحه، بدون
          جدول‌های بزرگ.
        </p>
      </header>

      {draftCount > 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          <CloudOffIcon className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {toPersianDigits(draftCount)} پیش‌نویس ذخیره‌شده روی همین دستگاه دارید؛ با باز کردن هر کار می‌توانید بفرستید یا
            پاک کنید.
          </span>
        </div>
      ) : null}

      <section aria-labelledby="field-actions">
        <h2 id="field-actions" className="mb-2 text-sm font-semibold">
          کارهای کارگاه
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AEC_FIELD_ACTIONS.map((action) => {
            const enabled = can(action);
            const draft = drafts[action.key];
            const inner = (
              <>
                <span className="flex items-center gap-2 font-medium">
                  <ActionIcon action={action} />
                  {action.label}
                </span>
                <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{action.hint}</span>
                {draft ? (
                  <span className="mt-1 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                    پیش‌نویس
                  </span>
                ) : null}
                {!enabled ? (
                  <span className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    در این کسب‌وکار روشن نیست
                  </span>
                ) : null}
              </>
            );

            const sheetKey = CAPTURE_SHEETS.find((key) => key === action.key);
            if (sheetKey && board.capabilities.length > 0) {
              return (
                <button
                  key={action.key}
                  type="button"
                  disabled={!enabled}
                  onClick={() => open(sheetKey)}
                  className="min-h-20 rounded-2xl border border-border bg-card p-3 text-right text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  {inner}
                </button>
              );
            }
            return (
              <Link
                key={action.key}
                href={`/workspace/projects/${projectId}?tab=${action.section}`}
                aria-disabled={!enabled}
                className={`min-h-20 rounded-2xl border border-border bg-card p-3 text-right text-sm transition-colors hover:bg-muted/50 ${
                  enabled ? "" : "pointer-events-none opacity-50"
                }`}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      </section>

      <QueueCard
        title="نواقص باز"
        count={board.queues.snags.openCount}
        empty="نقص بازی ثبت نشده است."
        rows={board.queues.snags.rows}
        onOpen={() => open("snag")}
        onRow={() => open("snag")}
      />

      <QueueCard
        title="بازرسی‌های در جریان"
        count={board.queues.inspections.openCount}
        empty="بازرسی در جریانی نیست."
        rows={board.queues.inspections.rows}
        onOpen={() => open("inspection")}
        onRow={(row) => open("checklist", row.id)}
      />

      <QueueCard
        title="پرسش‌های فنی بی‌پاسخ"
        count={board.queues.rfis.openCount}
        empty="پرسش فنی بی‌پاسخی نیست."
        rows={board.queues.rfis.rows}
        onOpen={() => open("rfi")}
        onRow={() => undefined}
      />

      <QueueCard
        title="وظیفه‌های زمان‌دار"
        count={board.queues.tasks.openCount}
        empty="وظیفهٔ زمان‌داری باز نیست."
        rows={board.queues.tasks.rows}
        onOpen={() => undefined}
        onRow={(row) => open("task", row.id)}
      />

      <QueueCard
        title="تحویل‌های در انتظار"
        count={board.queues.deliveries.pendingCount}
        empty="تعهد تأمین تأییدشده‌ای در انتظار تحویل نیست."
        rows={board.queues.deliveries.rows}
        onOpen={() => open("delivery")}
        onRow={() => undefined}
      />

      <DrawingsCard projectId={projectId} rows={board.queues.drawings.rows} />

      <QueueCard
        title="سابمیتال‌های منتظر بررسی"
        count={board.queues.submittals.waitingCount}
        empty="سابمیتالی منتظر بررسی نیست."
        rows={board.queues.submittals.rows}
        onOpen={() => undefined}
        onRow={() => undefined}
        footer={
          <Link
            href={`/workspace/projects/${projectId}?tab=submittals`}
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            باز کردن تب سابمیتال‌ها برای تصمیم
          </Link>
        }
      />

      <details className="rounded-2xl border border-border bg-card p-3 text-xs">
        <summary className="cursor-pointer font-medium">این صفحه چه کارهایی را پوشش می‌دهد؟ (§۲۵)</summary>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {AEC_FIELD_ACTIONS.map((action) => (
            <li key={action.key} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{action.label}</span>
              <span dir="ltr" className="tabular-nums">
                {action.requirement}
              </span>
              <span>{action.draftSafe ? "— پیش‌نویس مجاز" : "— بدون پیش‌نویس"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          قواعد: <span dir="ltr">{AEC_FIELD_RULES.join(" · ")}</span>
        </p>
      </details>

      {sheet === "site_log" ? <SiteLogSheet board={board} projectId={projectId} onClose={close} onDone={after} /> : null}
      {sheet === "site_photo" ? (
        <PhotoSheet board={board} projectId={projectId} onClose={close} onDone={after} />
      ) : null}
      {sheet === "snag" ? <SnagSheet projectId={projectId} onClose={close} onDone={after} /> : null}
      {sheet === "inspection" ? (
        <InspectionSheet board={board} projectId={projectId} onClose={close} onDone={after} />
      ) : null}
      {sheet === "rfi" ? <RfiSheet board={board} projectId={projectId} onClose={close} onDone={after} /> : null}
      {sheet === "checklist" ? <ChecklistSheet issueId={focusId} onClose={close} onDone={after} /> : null}
      {sheet === "task" ? <TaskSheet taskId={focusId} onClose={close} onDone={after} /> : null}
      {sheet === "delivery" ? (
        <DeliverySheet board={board} commitmentId={focusId} onClose={close} onDone={after} />
      ) : null}
    </div>
  );
}

function ActionIcon({ action }: { action: AecFieldAction }) {
  const Icon =
    action.key === "site_log"
      ? HardHatIcon
      : action.key === "site_photo"
        ? CameraIcon
        : action.key === "snag"
          ? AlertTriangleIcon
          : action.key === "inspection"
            ? ListChecksIcon
            : action.key === "rfi"
              ? FileSignatureIcon
              : action.key === "checklist"
                ? CheckIcon
                : action.key === "task"
                  ? ListChecksIcon
                  : action.key === "delivery"
                    ? TruckIcon
                    : action.key === "latest_drawing"
                      ? RulerIcon
                      : SendIcon;
  return <Icon className="size-4 shrink-0" aria-hidden="true" />;
}

/* ===========================================================================
 * The sheet shell
 * ======================================================================== */

function Sheet({
  title,
  hint,
  children,
  onClose,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className={`${overlayPanelClass} max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl sm:rounded-2xl`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-3 space-y-3">{children}</div>
      </div>
    </div>
  );
}

/** The shared footer: a primary submit, the draft state and the server's refusal. */
function SheetFooter({
  busy,
  label,
  error,
  draft,
  onDraftClear,
  onCancel,
  onSubmit,
  secondary,
}: {
  busy: boolean;
  label: string;
  error: string;
  draft?: Draft | null;
  onDraftClear?: () => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** A second, deliberate exit — «ذخیره به‌صورت پیش‌نویس» on the RFI sheet. */
  secondary?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={onSubmit} disabled={busy}>
          {busy ? "در حال فرستادن…" : label}
        </PrimaryButton>
        {secondary}
        <SecondaryButton onClick={onCancel} disabled={busy}>
          انصراف
        </SecondaryButton>
        {draft && onDraftClear ? (
          <button type="button" onClick={onDraftClear} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            پاک کردن پیش‌نویس
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ===========================================================================
 * The photo control (fast capture, real upload progress)
 * ======================================================================== */

interface UploadedPhoto {
  assetId: string;
  fileName: string;
  previewUrl: string;
}

function PhotoCapture({
  projectId,
  onUploaded,
  onError,
}: {
  projectId: string;
  onUploaded: (photo: UploadedPhoto) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploaded, setUploaded] = useState<UploadedPhoto[]>([]);

  const upload = (file: File) => {
    setProgress(0);
    const form = new FormData();
    form.append("file", file);
    // `fetch` cannot report upload progress, so this one call is an XHR — the
    // §25 requirement is a *clear* progress bar, not a spinner.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/aec/projects/${projectId}/field/photo`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      setProgress(null);
      try {
        const data = JSON.parse(xhr.responseText || "{}") as {
          asset?: { id: string; file_name?: string; fileName?: string };
          message?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300 && data.asset?.id) {
          const photo: UploadedPhoto = {
            assetId: data.asset.id,
            fileName: data.asset.fileName ?? data.asset.file_name ?? file.name,
            previewUrl: URL.createObjectURL(file),
          };
          setUploaded((current) => [...current, photo]);
          onUploaded(photo);
        } else {
          onError(data.message ?? "بارگذاری عکس ناموفق بود.");
        }
      } catch {
        onError("بارگذاری عکس ناموفق بود.");
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      onError("ارتباط برای بارگذاری عکس برقرار نشد.");
    };
    xhr.send(form);
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) upload(file);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-sm hover:bg-muted/50"
      >
        <CameraIcon className="size-4" aria-hidden="true" />
        گرفتن عکس با دوربین
      </button>
      {progress !== null ? (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-[11px] tabular-nums text-muted-foreground">بارگذاری: {toPersianDigits(progress)}٪</p>
        </div>
      ) : null}
      {uploaded.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {uploaded.map((photo) => (
            <li key={photo.assetId} className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px]">
              <PaperclipIcon className="size-3" aria-hidden="true" />
              {photo.fileName}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ===========================================================================
 * The capture sheets
 * ======================================================================== */

function SiteLogSheet({
  board,
  projectId,
  onClose,
  onDone,
}: {
  board: FieldBoard;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const exists = board.queues.siteLog.todayLogId;
  const [work, setWork] = useState("");
  const [weather, setWeather] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(projectId, "site_log"));

  useEffect(() => {
    const next = { workPerformed: work, weather, headcount };
    if (!busy) writeDraft(projectId, "site_log", next);
  }, [busy, headcount, projectId, weather, work]);

  const submit = async () => {
    setBusy(true);
    setError("");
    const lines = Number(headcount) > 0 ? [{ kind: "attendance", title: "عوامل و اکیپ‌ها", headcount: Number(headcount) }] : [];
    // An update must not wipe what the office wrote: the day's existing
    // attachments are read back and carried through, and the *lines* are left
    // alone — attendance is the site panel's table, and silently replacing it
    // from a phone would lose rows a foreman typed on the desktop.
    let attachments: Array<{ mediaAssetId?: string; workspaceDocumentId?: string; title?: string }> = photos.map(
      (photo) => ({ mediaAssetId: photo.assetId, title: photo.fileName }),
    );
    if (exists) {
      const current = await api<{ log: { attachments: Array<{ documentId: string }> } }>(`/api/aec/site-logs/${exists}`);
      const kept = current.ok ? current.data.log.attachments.map((item) => ({ workspaceDocumentId: item.documentId })) : [];
      attachments = [...kept, ...attachments];
    }
    const { ok, data } = exists
      ? await api(`/api/aec/site-logs/${exists}`, {
          method: "PATCH",
          body: JSON.stringify({ workPerformed: work, weather, attachments }),
        })
      : await api(`/api/aec/projects/${projectId}/site-logs`, {
          method: "POST",
          body: JSON.stringify({
            logDate: board.today,
            workPerformed: work,
            weather,
            lines,
            attachments,
          }),
        });
    setBusy(false);
    if (ok) {
      clearDraft(projectId, "site_log");
      onDone();
    } else {
      setError(
        (data as unknown as { message?: string }).message ??
          ((data as unknown as { error?: string }).error === "site_log_exists"
            ? "برای امروز گزارش ثبت شده است."
            : "ثبت گزارش ناموفق بود."),
      );
    }
  };

  return (
    <Sheet
      title={exists ? "تکمیل گزارش امروز" : "گزارش روزانهٔ کارگاه"}
      hint="تاریخ گزارش، امروزِ کسب‌وکار است و به‌صورت شمسی نشان داده می‌شود."
      onClose={onClose}
    >
      {draft ? (
        <button
          type="button"
          onClick={() => {
            setWork(draft.workPerformed ?? "");
            setWeather(draft.weather ?? "");
            setHeadcount(draft.headcount ?? "");
            setDraft(null);
          }}
          className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-right text-xs"
        >
          پیش‌نویس ذخیره‌شده روی این دستگاه پیدا شد — برای بازیابی بزنید.
        </button>
      ) : null}
      <Field label="کار انجام‌شدهٔ امروز">
        <textarea
          className={`${inputClass} min-h-24`}
          value={work}
          onChange={(event) => setWork(event.target.value)}
          placeholder="مثلاً: قالب‌بندی محور ۵ تا تراز ۱٫۲"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="آب‌وهوا">
          <input className={inputClass} value={weather} onChange={(event) => setWeather(event.target.value)} placeholder="آفتابی" />
        </Field>
        <Field label="تعداد نیرو">
          <input
            className={`${inputClass} tabular-nums`}
            inputMode="numeric"
            value={headcount}
            onChange={(event) => setHeadcount(event.target.value)}
            placeholder="۱۲"
          />
        </Field>
      </div>
      <Field label="عکس‌های امروز">
        <PhotoCapture
          projectId={projectId}
          onUploaded={(photo) => setPhotos((current) => [...current, photo])}
          onError={setError}
        />
      </Field>
      <SheetFooter
        busy={busy}
        label={exists ? "ذخیرهٔ تکمیل گزارش" : "ثبت گزارش امروز"}
        error={error}
        draft={draft}
        onDraftClear={() => {
          clearDraft(projectId, "site_log");
          setDraft(null);
        }}
        onCancel={onClose}
        onSubmit={submit}
      />
    </Sheet>
  );
}

function PhotoSheet({
  board,
  projectId,
  onClose,
  onDone,
}: {
  board: FieldBoard;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    const fresh = photos.map((photo) => ({ mediaAssetId: photo.assetId, title: photo.fileName }));
    // Today's log already exists (the common case at 4pm): append the photos to
    // it, carrying the attachments it already has so nothing is detached.
    const existing = board.queues.siteLog.todayLogId;
    let { ok } = { ok: false };
    if (existing) {
      const current = await api<{ log: { attachments: Array<{ documentId: string }>; workPerformed: string } }>(
        `/api/aec/site-logs/${existing}`,
      );
      const kept = current.ok ? current.data.log.attachments.map((item) => ({ workspaceDocumentId: item.documentId })) : [];
      ({ ok } = await api(`/api/aec/site-logs/${existing}`, {
        method: "PATCH",
        body: JSON.stringify({
          workPerformed: caption || (current.ok ? current.data.log.workPerformed : ""),
          attachments: [...kept, ...fresh],
        }),
      }));
    } else {
      ({ ok } = await api(`/api/aec/projects/${projectId}/site-logs`, {
        method: "POST",
        body: JSON.stringify({ logDate: board.today, workPerformed: caption, lines: [], attachments: fresh }),
      }));
    }
    setBusy(false);
    if (ok) onDone();
    else setError("ثبت عکس در گزارش امروز ناموفق بود.");
  };

  return (
    <Sheet title="عکس کارگاه" hint="عکس در دفتر روزانهٔ امروز ثبت می‌شود." onClose={onClose}>
      <PhotoCapture projectId={projectId} onUploaded={(photo) => setPhotos((current) => [...current, photo])} onError={setError} />
      <Field label="توضیح کوتاه">
        <input className={inputClass} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="مثلاً: آرماتوربندی فونداسیون بلوک B" />
      </Field>
      <SheetFooter
        busy={busy}
        label="ثبت عکس در گزارش امروز"
        error={error}
        onCancel={onClose}
        onSubmit={submit}
      />
    </Sheet>
  );
}

function SnagSheet({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(projectId, "snag"));

  useEffect(() => {
    if (!busy) writeDraft(projectId, "snag", { title, location, severity, description });
  }, [busy, description, location, projectId, severity, title]);

  const submit = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/projects/${projectId}/site-issues`, {
      method: "POST",
      body: JSON.stringify({
        kind: "snag",
        title,
        location,
        severity,
        description,
        attachments: photos.map((photo) => ({ mediaAssetId: photo.assetId, title: photo.fileName })),
      }),
    });
    setBusy(false);
    if (ok) {
      clearDraft(projectId, "snag");
      onDone();
    } else {
      setError((data as unknown as { message?: string }).message ?? "ثبت نقص ناموفق بود.");
    }
  };

  return (
    <Sheet title="ثبت نقص" hint="شمارهٔ نقص را سیستم می‌دهد." onClose={onClose}>
      {draft ? (
        <button
          type="button"
          onClick={() => {
            setTitle(draft.title ?? "");
            setLocation(draft.location ?? "");
            setSeverity(draft.severity ?? "medium");
            setDescription(draft.description ?? "");
            setDraft(null);
          }}
          className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-right text-xs"
        >
          پیش‌نویس ذخیره‌شده پیدا شد — برای بازیابی بزنید.
        </button>
      ) : null}
      <Field label="عنوان نقص">
        <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="درزگیری ناقص درز اجرایی" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="محل">
          <input className={inputClass} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="طبقهٔ ۳ — محور D" />
        </Field>
        <Field label="شدت">
          <select className={inputClass} value={severity} onChange={(event) => setSeverity(event.target.value)}>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SITE_ISSUE_SEVERITY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="توضیح">
        <textarea className={`${inputClass} min-h-20`} value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label="عکس">
        <PhotoCapture projectId={projectId} onUploaded={(photo) => setPhotos((current) => [...current, photo])} onError={setError} />
      </Field>
      <SheetFooter
        busy={busy}
        label="ثبت نقص"
        error={error}
        draft={draft}
        onDraftClear={() => {
          clearDraft(projectId, "snag");
          setDraft(null);
        }}
        onCancel={onClose}
        onSubmit={submit}
      />
    </Sheet>
  );
}

function InspectionSheet({
  board,
  projectId,
  onClose,
  onDone,
}: {
  board: FieldBoard;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [checklistId, setChecklistId] = useState(board.checklists[0]?.id ?? "");
  const [title, setTitle] = useState(board.checklists[0]?.name ?? "");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/projects/${projectId}/site-issues`, {
      method: "POST",
      body: JSON.stringify({ kind: "inspection", title, location, checklistId: checklistId || undefined }),
    });
    setBusy(false);
    if (ok) onDone();
    else setError((data as unknown as { message?: string }).message ?? "ثبت بازرسی ناموفق بود.");
  };

  return (
    <Sheet title="بازرسی" hint="آیتم‌های چک‌لیست به بازرسی کپی می‌شوند و همان‌جا تیک می‌خورند." onClose={onClose}>
      {board.checklists.length === 0 ? (
        <p className="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          چک‌لیستی تعریف نشده است؛ بازرسی بدون چک‌لیست ثبت می‌شود و می‌توانید بعداً آیتم‌ها را از تب «بازرسی‌ها» بیفزایید.
        </p>
      ) : (
        <Field label="چک‌لیست">
          <select
            className={inputClass}
            value={checklistId}
            onChange={(event) => {
              setChecklistId(event.target.value);
              const chosen = board.checklists.find((item) => item.id === event.target.value);
              setTitle(chosen?.name ?? "");
            }}
          >
            {board.checklists.map((checklist) => (
              <option key={checklist.id} value={checklist.id}>
                {checklist.name} ({toPersianDigits(checklist.itemCount)} آیتم)
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="عنوان">
        <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="بازرسی آرماتوربندی" />
      </Field>
      <Field label="محل">
        <input className={inputClass} value={location} onChange={(event) => setLocation(event.target.value)} />
      </Field>
      <SheetFooter busy={busy} label="ثبت بازرسی" error={error} onCancel={onClose} onSubmit={submit} />
    </Sheet>
  );
}

function RfiSheet({
  board,
  projectId,
  onClose,
  onDone,
}: {
  board: FieldBoard;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  // §10: the number is the team's, and the register refuses a duplicate — so the
  // phone prefills the next free one and leaves it editable rather than taking
  // numbering away from the desk.
  const [rfiNumber, setRfiNumber] = useState(board.suggestions.rfiNumber);
  const [subject, setSubject] = useState("");
  const [question, setQuestion] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(projectId, "rfi"));

  useEffect(() => {
    if (!busy) writeDraft(projectId, "rfi", { rfiNumber, subject, question, dueDate });
  }, [busy, dueDate, projectId, question, rfiNumber, subject]);

  /** `open` sends it in the same tap (§10's two steps); `draft` keeps it local. */
  const submit = async (mode: "draft" | "open") => {
    setBusy(true);
    setError("");
    const created = await api<{ rfi: { id: string } }>(`/api/aec/projects/${projectId}/rfis`, {
      method: "POST",
      body: JSON.stringify({ rfiNumber, subject, question, dueDate: dueDate || undefined }),
    });
    if (!created.ok) {
      setBusy(false);
      setError((created.data as unknown as { message?: string }).message ?? "ثبت پرسش ناموفق بود.");
      return;
    }
    if (mode === "open") {
      const sent = await api(`/api/aec/rfis/${created.data.rfi.id}/status`, {
        method: "POST",
        body: JSON.stringify({ action: "open" }),
      });
      if (!sent.ok) {
        setBusy(false);
        // The draft exists either way; saying so is better than pretending the
        // question was sent.
        setError("پیش‌نویس ثبت شد اما ارسال آن ناموفق بود؛ از تب استعلام‌ها بفرستید.");
        return;
      }
    }
    setBusy(false);
    clearDraft(projectId, "rfi");
    onDone();
  };

  return (
    <Sheet title="پرسش فنی (RFI)" hint="تاریخ مهلت به میلادی ذخیره و شمسی نمایش داده می‌شود." onClose={onClose}>
      {draft ? (
        <button
          type="button"
          onClick={() => {
            setRfiNumber(draft.rfiNumber || board.suggestions.rfiNumber);
            setSubject(draft.subject ?? "");
            setQuestion(draft.question ?? "");
            setDueDate(draft.dueDate ?? "");
            setDraft(null);
          }}
          className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-right text-xs"
        >
          پیش‌نویس ذخیره‌شده پیدا شد — برای بازیابی بزنید.
        </button>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="شمارهٔ استعلام" hint="پیشنهاد سیستم؛ قابل ویرایش">
          <input className={`${inputClass} tabular-nums`} dir="ltr" value={rfiNumber} onChange={(event) => setRfiNumber(event.target.value)} />
        </Field>
        <Field label="موضوع">
          <input className={inputClass} value={subject} onChange={(event) => setSubject(event.target.value)} />
        </Field>
      </div>
      <Field label="متن پرسش">
        <textarea className={`${inputClass} min-h-24`} value={question} onChange={(event) => setQuestion(event.target.value)} />
      </Field>
      <Field label="مهلت پاسخ (میلادی)">
        <input type="date" className={`${inputClass} tabular-nums`} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
      </Field>
      <SheetFooter
        busy={busy}
        label="ثبت و ارسال پرسش"
        error={error}
        draft={draft}
        onDraftClear={() => {
          clearDraft(projectId, "rfi");
          setDraft(null);
        }}
        onCancel={onClose}
        onSubmit={() => submit("open")}
        secondary={
          <SecondaryButton onClick={() => submit("draft")} disabled={busy}>
            ذخیره به‌صورت پیش‌نویس
          </SecondaryButton>
        }
      />
    </Sheet>
  );
}

/* ===========================================================================
 * The two inline updates
 * ======================================================================== */

interface IssueCheck {
  id: string;
  checklistItemId: string | null;
  label: string;
  guidance: string;
  result: string;
  note: string;
  position: number;
}

function ChecklistSheet({
  issueId,
  onClose,
  onDone,
}: {
  issueId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [checks, setChecks] = useState<IssueCheck[] | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!issueId) return;
    api<{ issue: { title: string; checks: IssueCheck[] } }>(`/api/aec/site-issues/${issueId}`).then(({ ok, data }) => {
      if (ok) {
        setTitle(data.issue.title);
        setChecks(data.issue.checks);
      } else {
        setError("بازرسی خوانده نشد.");
      }
    });
  }, [issueId]);

  const setResult = (id: string, result: string) => {
    setChecks((current) => current?.map((check) => (check.id === id ? { ...check, result } : check)) ?? current);
  };

  const setNote = (id: string, note: string) => {
    setChecks((current) => current?.map((check) => (check.id === id ? { ...check, note } : check)) ?? current);
  };

  const submit = async () => {
    if (!issueId || !checks) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/site-issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify({
        checks: checks.map((check) => ({
          checklistItemId: check.checklistItemId,
          label: check.label,
          guidance: check.guidance,
          result: check.result,
          note: check.note,
          position: check.position,
        })),
      }),
    });
    setBusy(false);
    if (ok) onDone();
    else setError((data as unknown as { message?: string }).message ?? "ذخیرهٔ آیتم‌ها ناموفق بود.");
  };

  return (
    <Sheet title={title ? `چک‌لیست: ${title}` : "چک‌لیست بازرسی"} hint="نتیجهٔ هر آیتم را همین‌جا ثبت کنید." onClose={onClose}>
      {!checks ? (
        <SectionCardSkeleton rows={3} label="آیتم‌های چک‌لیست" />
      ) : checks.length === 0 ? (
        <p className="text-sm text-muted-foreground">این بازرسی آیتم چک‌لیستی ندارد.</p>
      ) : (
        <ul className="space-y-2">
          {checks.map((check) => (
            <li key={check.id} className="rounded-xl border border-border p-3">
              <p className="text-sm font-medium">{check.label}</p>
              {check.guidance ? <p className="mt-1 text-xs text-muted-foreground">{check.guidance}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {(["pass", "fail", "na"] as const).map((result) => (
                  <button
                    key={result}
                    type="button"
                    onClick={() => setResult(check.id, result)}
                    className={`min-h-10 rounded-lg border px-3 text-xs ${
                      check.result === result ? "border-primary bg-primary/10 text-primary" : "border-border"
                    }`}
                  >
                    {result === "pass" ? "قبول" : result === "fail" ? "مردود" : "نامرتبط"}
                  </button>
                ))}
              </div>
              {check.result === "fail" ? (
                <input
                  className={`${inputClass} mt-2`}
                  value={check.note}
                  onChange={(event) => setNote(check.id, event.target.value)}
                  placeholder="توضیح نقص"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <SheetFooter busy={busy} label="ذخیرهٔ آیتم‌ها" error={error} onCancel={onClose} onSubmit={submit} />
    </Sheet>
  );
}

function TaskSheet({
  taskId,
  onClose,
  onDone,
}: {
  taskId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<WorkspaceTaskStatus>("open");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!taskId) return;
    api<{ task: { title: string; status: WorkspaceTaskStatus } }>(`/api/workspace/tasks/${taskId}`).then(({ ok, data }) => {
      if (ok) {
        setTitle(data.task.title);
        setStatus(data.task.status);
      } else {
        setError("وظیفه خوانده نشد.");
      }
    });
  }, [taskId]);

  const submit = async () => {
    if (!taskId) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/workspace/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    if (ok) onDone();
    else setError((data as unknown as { message?: string }).message ?? "به‌روزرسانی وظیفه ناموفق بود.");
  };

  return (
    <Sheet title={title ? `وظیفه: ${title}` : "به‌روزرسانی وظیفه"} onClose={onClose}>
      <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
        وضعیت وظیفه بی‌درنگ ذخیره می‌شود؛ پیش‌نویس محلی ندارد.
      </p>
      <Field label="وضعیت">
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as WorkspaceTaskStatus)}>
          {TASK_STATUSES.map((value) => (
            <option key={value} value={value}>
              {TASK_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      <SheetFooter busy={busy} label="ذخیرهٔ وضعیت" error={error} onCancel={onClose} onSubmit={submit} />
    </Sheet>
  );
}

function DeliverySheet({
  board,
  commitmentId,
  onClose,
  onDone,
}: {
  board: FieldBoard;
  commitmentId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const pending = board.queues.deliveries.rows;
  const [chosen, setChosen] = useState(commitmentId ?? pending[0]?.id ?? "");
  const [deliveredOn, setDeliveredOn] = useState(board.today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/commitments/${chosen}/deliveries`, {
      method: "POST",
      body: JSON.stringify({ deliveredOn, note }),
    });
    setBusy(false);
    if (ok) onDone();
    else setError((data as unknown as { message?: string }).message ?? "ثبت تحویل ناموفق بود.");
  };

  return (
    <Sheet title="ثبت تحویل مصالح" hint="تحویل روی تعهد تأمین تأییدشده ثبت می‌شود." onClose={onClose}>
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">تعهد تأمین تأییدشده‌ای برای تحویل نیست.</p>
      ) : (
        <>
          <Field label="تعهد تأمین">
            <select className={inputClass} value={chosen} onChange={(event) => setChosen(event.target.value)}>
              {pending.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.number ? `${row.number} — ` : ""}
                  {row.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="تاریخ تحویل (میلادی)">
            <input
              type="date"
              className={`${inputClass} tabular-nums`}
              value={deliveredOn}
              onChange={(event) => setDeliveredOn(event.target.value)}
            />
          </Field>
          <Field label="توضیح">
            <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} placeholder="مثلاً: ۲۰۰ کیسه سیمان، سالم" />
          </Field>
        </>
      )}
      <SheetFooter busy={busy} label="ثبت تحویل" error={error} onCancel={onClose} onSubmit={submit} />
    </Sheet>
  );
}

/* ===========================================================================
 * The queue cards
 * ======================================================================== */

function QueueCard({
  title,
  count,
  empty,
  rows,
  onOpen,
  onRow,
  footer,
}: {
  title: string;
  count: number;
  empty: string;
  rows: FieldQueueRow[];
  onOpen: () => void;
  onRow: (row: FieldQueueRow) => void;
  footer?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {title}{" "}
          {count > 0 ? (
            <span className="ms-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] tabular-nums text-primary">
              {toPersianDigits(count)}
            </span>
          ) : null}
        </h2>
        {onOpen ? (
          <button type="button" onClick={onOpen} className="text-xs text-primary underline-offset-4 hover:underline">
            ثبت مورد جدید
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onRow(row)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-right text-sm hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block truncate">
                    {row.number ? <span className="me-1 tabular-nums text-muted-foreground">{row.number}</span> : null}
                    {row.title}
                  </span>
                  {row.dateJalali ? <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">{row.dateJalali}</span> : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {row.chip ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{row.chip}</span> : null}
                  {row.daysRemaining !== null && row.daysRemaining < 0 ? (
                    <span className="text-[11px] text-destructive tabular-nums">
                      {toPersianDigits(Math.abs(row.daysRemaining))} روز تأخیر
                    </span>
                  ) : null}
                  {row.action === "check" ? <CheckIcon className="size-4 text-primary" aria-hidden="true" /> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </section>
  );
}

function DrawingsCard({ projectId, rows }: { projectId: string; rows: FieldDrawingRow[] }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">آخرین نقشه‌ها</h2>
        <Link href={`/workspace/projects/${projectId}?tab=files`} className="text-xs text-primary underline-offset-4 hover:underline">
          دفتر نقشه‌ها
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">نقشه‌ای در دفتر ثبت نشده است.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/workspace/projects/${projectId}?tab=files`}
                className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block truncate">
                    <span className="me-1 tabular-nums text-muted-foreground">{row.documentNumber}</span>
                    {row.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{row.statusLabel ?? ""}</span>
                </span>
                <span className="shrink-0 rounded-lg bg-muted px-2 py-1 text-[11px] tabular-nums">
                  {row.revisionCode ? `رویزیون ${row.revisionCode}` : "بدون رویزیون"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Exported for the smoke test: the eleven flows are on screen, not only in lib. */
export const FIELD_SCREEN_ACTION_KEYS = AEC_FIELD_ACTIONS.map((action) => action.key);
