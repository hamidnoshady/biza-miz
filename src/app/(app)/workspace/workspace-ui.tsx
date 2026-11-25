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

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, inputClass, errorMessageOrRaw, SecondaryButton } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
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
  task_has_reservation_history: "وظیفه سابقهٔ رزرو منابع دارد؛ برای حفظ تاریخچه قابل حذف نیست.",
  task_has_time_history: "وظیفه سابقهٔ کارکرد دارد؛ برای حفظ تاریخچه قابل حذف نیست.",
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
  contract_status_requires_workflow:
    "این وضعیت قرارداد با درخواست تأیید یا چرخهٔ عمر قرارداد تغییر می‌کند، نه با ویرایش فرم.",
  document_status_requires_workflow:
    "این وضعیت سند با فرایند تأیید تغییر می‌کند، نه با ویرایش فرم.",
  approval_already_pending: "برای این مورد از قبل یک درخواست تأیید در انتظار وجود دارد.",
  subject_not_requestable: "این مورد در وضعیت فعلی قابل ارسال برای تأیید نیست.",
  document_already_superseded:
    "برای این نسخهٔ سند از قبل بازنگری ثبت شده است؛ بازنگری تازه را از آخرین نسخه بسازید.",
  invalid_approval_subject: "موضوع تأیید نامعتبر است.",
  invalid_event_kind: "نوع رویداد نامعتبر است.",
  invalid_workspace_role: "نقش نامعتبر است.",
  invalid_project_budget: "بودجه نامعتبر است.",
  invalid_contract_value: "مبلغ قرارداد نامعتبر است.",
  invalid_reminder_days: "فاصلهٔ یادآوری نامعتبر است.",
  invalid_text_field: "مقدار یکی از فیلدهای متنی نامعتبر است.",
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
 * The business's calendar day, kept fresh while the page stays open.
 *
 * Issue #907 F08: a value frozen at mount by `useMemo` is wrong twice over —
 * it read a UTC slice while every service query uses Tehran's day, and a tab
 * left open across midnight kept saying «امروز» for yesterday. One minute is
 * granular enough for a date label and cheap enough to always run.
 */
export function useWorkspaceToday(): string {
  const [today, setToday] = useState(() => todayIsoDate());
  useEffect(() => {
    const tick = () => setToday(todayIsoDate());
    // Recompute on return to the tab: a background tab's timer can be throttled.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const id = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return today;
}

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
  const today = useWorkspaceToday();
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

/**
 * A labelled `<select>` over `{id, label}` rows — people, projects, parties.
 *
 * `searchable` (issue #907 F10) puts a filter above the select. A business can
 * have hundreds of parties, and scrolling a native select to find one is the
 * defect the audit recorded; filtering keeps the native control — and its
 * keyboard behaviour, its RTL rendering and its screen-reader announcement —
 * rather than replacing it with a hand-rolled listbox. The current selection
 * always stays in the list, even when it does not match the filter, so opening
 * a form never silently clears a field.
 */
export function PickerField({
  label,
  value,
  onChange,
  options,
  placeholder = "— انتخاب کنید —",
  hint,
  searchable,
  searchPlaceholder = "جست‌وجو…",
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ id: string; label: string }>;
  placeholder?: string;
  hint?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!searchable || !needle) return options;
    return options.filter(
      (option) => option.id === value || option.label.toLowerCase().includes(needle),
    );
  }, [filter, options, searchable, value]);

  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-1.5">
        {searchable ? (
          <input
            type="search"
            className={inputClass}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={`${searchPlaceholder} ${label}`}
          />
        ) : null}
        <select
          className={inputClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {visible.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {searchable && visible.length === 0 ? (
          <span className="text-xs text-muted-foreground">موردی با این نام پیدا نشد.</span>
        ) : null}
      </div>
    </Field>
  );
}

/* ---------------------------------------------------------------------------
 * Phone-width tables
 * ------------------------------------------------------------------------- */

/**
 * A `DataTable`'s `tableClassName` that turns each row into a card below the
 * `sm` breakpoint (#761 §20 — "do not shrink desktop tables"): the first cell
 * is the card's title, every other cell a «label — value» line whose label is
 * the cell's own `data-label`. Desktop is untouched; the header stays in the
 * accessibility tree. A real matrix (the role-permission grid) keeps scrolling.
 */
export const stackedTableClass = [
  "max-sm:block max-sm:[&_thead]:sr-only max-sm:[&_tbody]:block",
  "max-sm:[&_tr]:block max-sm:[&_tr]:px-4 max-sm:[&_tr]:py-3",
  "max-sm:[&_td]:flex max-sm:[&_td]:items-baseline max-sm:[&_td]:justify-between max-sm:[&_td]:gap-3 max-sm:[&_td]:px-0 max-sm:[&_td]:py-1",
  "max-sm:[&_td]:before:shrink-0 max-sm:[&_td]:before:text-xs max-sm:[&_td]:before:text-muted-foreground max-sm:[&_td]:before:content-[attr(data-label)]",
  "max-sm:[&_td:first-child]:block max-sm:[&_td:first-child]:pb-2 max-sm:[&_td:first-child]:font-semibold max-sm:[&_td:first-child]:before:hidden",
].join(" ");

/* ---------------------------------------------------------------------------
 * Form dialog
 * ------------------------------------------------------------------------- */

const PANEL_WIDTH = { lg: "sm:max-w-lg", xl: "sm:max-w-xl", "2xl": "sm:max-w-2xl" } as const;

/**
 * The one create/edit/decide panel every section uses.
 *
 * Issue #907 F05 and the newer Bizamiz direction: complex create/edit forms
 * open in a right-side offcanvas panel rather than a centred modal. It is the
 * platform's Radix `Sheet` — a labelled dialog that traps focus, closes on
 * Escape and hands focus back to whatever opened it (there is no trigger, so
 * Radix alone would drop focus on <body>). A click outside does NOT close it:
 * a half-filled form must not vanish on a stray tap.
 *
 * The body scrolls as one column; the action footer pins to its bottom through
 * `FormActions`, so «ذخیره» never leaves the viewport and never clips «بستن».
 */
export function WorkspaceFormPanel({
  title,
  width = "2xl",
  onClose,
  children,
}: {
  title: ReactNode;
  width?: keyof typeof PANEL_WIDTH;
  onClose: () => void;
  children: ReactNode;
}) {
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (opener?.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
        className={cn(
          "w-full max-w-none gap-0 p-0 sm:w-[92vw]",
          PANEL_WIDTH[width],
        )}
      >
        <SheetHeader className="shrink-0 border-b border-border/80 p-4 pe-12">
          <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Backwards-compatible name for the same panel. New call sites use
 * `WorkspaceFormPanel`; naming it a dialog in one section and a panel in the
 * next would be the duplication this module exists to prevent.
 */
export const WorkspaceFormDialog = WorkspaceFormPanel;

/**
 * The panel's action row (issue #907 F05).
 *
 * `PrimaryButton` is full width by default, which is right for a form's main
 * action but wrong beside a second button: in RTL the primary grew until the
 * close button sat outside the panel. On a phone the actions stack full width;
 * from `sm` up they shrink to their labels and sit together at the trailing
 * edge. Pinning to the bottom keeps them reachable while the form scrolls.
 */
export function FormActions({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-border/80 bg-card p-4 [&>button]:w-full sm:flex-row sm:justify-end sm:[&>button]:w-auto">
      {children}
    </div>
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
