"use client";

/**
 * Phase G — the small shared pieces every workspace section needs.
 *
 * Deliberately NOT new UI primitives: each thing here is a thin composition of
 * an existing one (`StatusBadge`, `Field`, `inputClass`, `JalaliDatePicker`,
 * `EmptyState`) that would otherwise be spelt out ten times, once per section,
 * with the tenth spelling slightly different. The design language is the
 * Accounting app's and nothing below introduces a colour, a radius or a shadow
 * that is not already in `page-chrome.tsx`.
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, inputClass, errorMessageOrRaw, SecondaryButton } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  CONTRACT_STATUS_LABELS,
  DOCUMENT_STATUS_LABELS,
  APPROVAL_STATUS_LABELS,
  PRIORITY_LABELS,
  PROJECT_STATUS_LABELS,
  TASK_STATUS_LABELS,
  daysUntil,
  deadlineTone,
  type WorkspaceApprovalStatus,
  type WorkspaceContractStatus,
  type WorkspaceDocumentStatus,
  type WorkspacePriority,
  type WorkspaceProjectStatus,
  type WorkspaceTaskStatus,
} from "@/lib/workspace-shared";

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * The service's error codes in Persian. Same shape as
 * `fixed-assets-section.tsx`'s own table — one map per feature area, falling
 * back to `errorMessageOrRaw` so an untranslated code still says something.
 */
const ERROR_TRANSLATIONS: Record<string, string> = {
  project_not_found: "پروژه پیدا نشد.",
  task_not_found: "وظیفه پیدا نشد.",
  contract_not_found: "قرارداد پیدا نشد.",
  document_not_found: "سند پیدا نشد.",
  approval_not_found: "درخواست تأیید پیدا نشد.",
  approval_not_pending: "این درخواست پیش‌تر تعیین‌تکلیف شده است.",
  subject_not_found: "موردی که به آن اشاره شده پیدا نشد یا به آن دسترسی ندارید.",
  insufficient_project_role: "نقش شما در این پروژه اجازهٔ این کار را نمی‌دهد.",
  not_the_approver: "این درخواست به شخص دیگری برای تأیید سپرده شده است.",
  not_the_requester: "فقط درخواست‌کننده می‌تواند این درخواست را لغو کند.",
  self_approval_forbidden: "نمی‌توانید درخواستی را که خودتان داده‌اید تأیید کنید.",
  transfer_ownership_first: "این شخص مالک پروژه است؛ ابتدا مالکیت را به شخص دیگری منتقل کنید.",
  phase_not_found: "فاز پیدا نشد.",
  phase_not_in_project: "این فاز متعلق به پروژهٔ این وظیفه نیست.",
  task_project_mismatch: "وظیفهٔ انتخاب‌شده متعلق به این پروژه نیست.",
  contract_project_mismatch: "قرارداد انتخاب‌شده متعلق به این پروژه نیست.",
  journal_entry_not_found: "سند حسابداری پیدا نشد.",
  journal_entry_project_mismatch: "سند حسابداری برای پروژهٔ دیگری ثبت شده است.",
  approval_project_mismatch: "پروژهٔ درخواست با پروژهٔ موضوع آن یکی نیست.",
  media_not_found: "فایل انتخاب‌شده در کتابخانهٔ رسانه پیدا نشد.",
  invalid_time: "ساعت واردشده معتبر نیست.",
  invalid_contract_transition: "این اقدام در وضعیت فعلی قرارداد ممکن نیست؛ صفحه را تازه کنید.",
  extension_not_later: "تاریخ تمدید باید بعد از پایان فعلی قرارداد باشد.",
  end_date_required: "تاریخ پایان دورهٔ جدید را انتخاب کنید.",
  template_not_found: "قالب پیدا نشد.",
  party_not_found: "طرف حساب انتخاب‌شده معتبر نیست.",
  user_not_found: "کاربر انتخاب‌شده فعال نیست.",
  last_owner_cannot_be_removed: "آخرین مالک پروژه را نمی‌توان حذف کرد.",
  dependency_cycle: "این وابستگی حلقه ایجاد می‌کند.",
  dependency_unresolved: "تا وظایفی که این کار منتظر آن‌هاست انجام نشده‌اند، نمی‌توان آن را انجام‌شده زد.",
  dependency_across_projects: "وابستگی فقط میان وظایف یک پروژه ممکن است.",
  end_before_start: "تاریخ پایان نمی‌تواند پیش از تاریخ شروع باشد.",
  project_name_required: "نام پروژه الزامی است.",
  task_title_required: "عنوان وظیفه الزامی است.",
  contract_title_required: "عنوان قرارداد الزامی است.",
  document_title_required: "عنوان سند الزامی است.",
  event_title_required: "عنوان رویداد الزامی است.",
  event_date_required: "تاریخ رویداد الزامی است.",
  phase_name_required: "نام فاز الزامی است.",
  checklist_title_required: "عنوان مورد الزامی است.",
  comment_required: "متن یادداشت الزامی است.",
  template_name_required: "نام قالب الزامی است.",
  template_needs_phases: "قالب باید دست‌کم یک فاز داشته باشد.",
  subject_required: "موضوع مشخص نشده است.",
  range_required: "بازهٔ تاریخ مشخص نشده است.",
  invalid_decision: "تصمیم نامعتبر است.",
  invalid_date: "تاریخ نامعتبر است.",
  invalid_priority: "اولویت نامعتبر است.",
  invalid_project_status: "وضعیت پروژه نامعتبر است.",
  invalid_task_status: "وضعیت وظیفه نامعتبر است.",
  invalid_phase_status: "وضعیت فاز نامعتبر است.",
  invalid_contract_type: "نوع قرارداد نامعتبر است.",
  invalid_contract_status: "وضعیت قرارداد نامعتبر است.",
  invalid_document_status: "وضعیت سند نامعتبر است.",
  invalid_approval_subject: "موضوع تأیید نامعتبر است.",
  invalid_event_kind: "نوع رویداد نامعتبر است.",
  invalid_workspace_role: "نقش نامعتبر است.",
  invalid_project_budget: "بودجه نامعتبر است.",
  invalid_contract_value: "مبلغ قرارداد نامعتبر است.",
  invalid_reminder_days: "فاصلهٔ یادآوری نامعتبر است.",
  forbidden: "دسترسی لازم را ندارید.",
  unauthorized: "نشست شما منقضی شده است.",
};

export function workspaceError(code: string | undefined): string {
  if (!code) return "خطای غیرمنتظره رخ داد.";
  if (ERROR_TRANSLATIONS[code]) return ERROR_TRANSLATIONS[code];
  if (/[\u0600-\u06FF]/.test(code)) return code;
  return errorMessageOrRaw(code);
}

/* ---------------------------------------------------------------------------
 * Badges
 * ------------------------------------------------------------------------- */

/**
 * The tone mapping, in one place. `active` is the amber "this is the live one"
 * token, `positive` the green settled state, `danger` the one that needs
 * attention — the same vocabulary the rest of the product uses, so a workspace
 * screen never invents a fifth colour.
 */
export function ProjectStatusBadge({ status }: { status: WorkspaceProjectStatus }) {
  const tone =
    status === "active" ? "active"
    : status === "completed" ? "positive"
    : status === "cancelled" ? "danger"
    : "neutral";
  return <StatusBadge tone={tone} dot>{PROJECT_STATUS_LABELS[status]}</StatusBadge>;
}

export function TaskStatusBadge({ status }: { status: WorkspaceTaskStatus }) {
  const tone =
    status === "done" ? "positive"
    : status === "blocked" ? "danger"
    : status === "in_progress" ? "active"
    : "neutral";
  return <StatusBadge tone={tone} dot>{TASK_STATUS_LABELS[status]}</StatusBadge>;
}

export function ContractStatusBadge({ status }: { status: WorkspaceContractStatus }) {
  const tone =
    status === "active" ? "active"
    : status === "completed" ? "positive"
    : status === "expired" || status === "terminated" ? "danger"
    : "neutral";
  return <StatusBadge tone={tone} dot>{CONTRACT_STATUS_LABELS[status]}</StatusBadge>;
}

export function DocumentStatusBadge({ status }: { status: WorkspaceDocumentStatus }) {
  const tone =
    status === "approved" ? "positive"
    : status === "rejected" ? "danger"
    : status === "in_review" ? "active"
    : "neutral";
  return <StatusBadge tone={tone} dot>{DOCUMENT_STATUS_LABELS[status]}</StatusBadge>;
}

export function ApprovalStatusBadge({ status }: { status: WorkspaceApprovalStatus }) {
  const tone =
    status === "approved" ? "positive"
    : status === "rejected" ? "danger"
    : status === "pending" ? "active"
    : "neutral";
  return <StatusBadge tone={tone} dot>{APPROVAL_STATUS_LABELS[status]}</StatusBadge>;
}

/** Only `urgent` and `high` render — badging every «عادی» would be noise. */
export function PriorityBadge({ priority }: { priority: WorkspacePriority }) {
  if (priority === "normal" || priority === "low") {
    return <span className="text-xs text-muted-foreground">{PRIORITY_LABELS[priority]}</span>;
  }
  return (
    <StatusBadge tone={priority === "urgent" ? "danger" : "active"}>
      {PRIORITY_LABELS[priority]}
    </StatusBadge>
  );
}

/* ---------------------------------------------------------------------------
 * Dates
 * ------------------------------------------------------------------------- */

/**
 * A Shamsi date with an urgency colour and a relative hint («۳ روز مانده»,
 * «۲ روز گذشته»). Stored and passed as ISO/Gregorian throughout; `formatJalali`
 * is the only thing that converts, at the point of display, which is the rule
 * that keeps a date from shifting when a user changes calendar preference.
 */
export function DateCell({
  date,
  relative = true,
  className,
}: {
  date: string | null | undefined;
  relative?: boolean;
  className?: string;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  if (!date) return <span className="text-muted-foreground">—</span>;

  const tone = deadlineTone(date, today);
  const days = daysUntil(date, today);
  const toneClass =
    tone === "overdue" ? "text-rose-700 dark:text-rose-300"
    : tone === "today" ? "text-amber-800 dark:text-amber-200"
    : tone === "soon" ? "text-amber-700 dark:text-amber-300"
    : "text-foreground";

  const hint =
    !relative || tone === "later" || tone === "none" ? null
    : tone === "today" ? "امروز"
    : tone === "overdue" ? `${toPersianDigits(String(Math.abs(days)))} روز گذشته`
    : `${toPersianDigits(String(days))} روز مانده`;

  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-1.5", toneClass, className)}>
      <span className="tabular-nums">{formatJalali(date)}</span>
      {hint ? <span className="text-xs opacity-80">({hint})</span> : null}
    </span>
  );
}

/**
 * A labelled Shamsi date input. `Field` with `as="div"` because
 * `JalaliDatePicker` is several controls and a `<label>` wrapping more than one
 * of them makes the association ambiguous — the rule `ui.tsx` documents.
 */
export function DateField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint} as="div">
      <JalaliDatePicker value={value} onChange={onChange} />
    </Field>
  );
}

/* ---------------------------------------------------------------------------
 * Selects
 * ------------------------------------------------------------------------- */

/** A labelled `<select>` over a label map — the pattern every filter repeats. */
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  labels,
  includeAll,
  allLabel = "همه",
  hint,
}: {
  label: string;
  value: T | "";
  onChange: (next: T | "") => void;
  options: ReadonlyArray<T>;
  labels: Record<T, string>;
  includeAll?: boolean;
  allLabel?: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value as T | "")}
      >
        {includeAll ? <option value="">{allLabel}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A labelled `<select>` over `{id, label}` rows — people, projects, parties. */
export function PickerField({
  label,
  value,
  onChange,
  options,
  placeholder = "— انتخاب کنید —",
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ id: string; label: string }>;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/* ---------------------------------------------------------------------------
 * Misc
 * ------------------------------------------------------------------------- */

/** A thin progress bar for a project's completion. */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-amber-500 dark:bg-amber-400"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {toPersianDigits(String(clamped))}٪
      </span>
    </div>
  );
}

/** A tag chip row. Read-only — tags are edited in the record's own form. */
export function TagList({ tags }: { tags: readonly string[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-md border border-border/80 bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

/**
 * The footer of a paginated list: how many of the server's filter-aware total
 * are on screen, and the button that loads the next page. Renders nothing once
 * everything is loaded.
 */
export function LoadMoreFooter({
  loaded,
  page,
  loading,
  onLoadMore,
}: {
  loaded: number;
  page: { total: number; hasMore: boolean } | null;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (!page?.hasMore) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/80 px-4 py-3 text-sm text-muted-foreground">
      <span>
        {toPersianDigits(String(loaded))} از {toPersianDigits(String(page.total))}
      </span>
      <SecondaryButton onClick={onLoadMore} disabled={loading}>
        {loading ? "در حال بارگذاری…" : "نمایش بیشتر"}
      </SecondaryButton>
    </div>
  );
}
