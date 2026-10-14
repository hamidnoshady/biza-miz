/**
 * Issue #799 §25 — the field flows' catalogue, and the half of «حالت کارگاه»
 * that may travel to a browser.
 *
 * This module has no imports but types: it is the list the phone screen renders
 * (the eleven §25 flows with their capability, their draft safety and the panel
 * that owns the long form), the queue shapes the board fills, and the two
 * Shamsi date helpers the screen formats with. It lives apart from
 * `aec-field.ts` because that module composes the board from the *services* —
 * and a client component that imported a runtime value from it would drag
 * `pg` and the whole server layer into the browser bundle, which is a build
 * failure rather than a slow page (`client-bundle-boundary.test.ts` is the
 * guard).
 *
 * The rules travel with the list on purpose: the screen prints them under
 * «راهنمای این صفحه», and a rule that only lives in a doc comment is a rule
 * nobody reads on a phone.
 */

import type { AecCapabilityKey } from "./aec";
// Type-only, so the compiler erases it: the board carries the register's own
// checklist rows, and describing them must not pull the register into a browser
// bundle (see client-bundle-boundary.test.ts).
import type { SiteChecklistSummary } from "./aec-site-service";

/** How the phone finishes a flow. */
export type AecFieldActionKind = "capture" | "update" | "review";

export interface AecFieldAction {
  key: string;
  label: string;
  /** One line of Persian that says what the button will ask for. */
  hint: string;
  /** Its §25 bullet, kept verbatim so the mapping is auditable. */
  requirement: string;
  kind: AecFieldActionKind;
  /** The capability that must be on; `null` for the project register itself. */
  capability: AecCapabilityKey | null;
  /**
   * Whether leaving it half-sent is harmless. A capture can be kept in the
   * browser and sent later; an approval cannot — "approved" that was never
   * sent is a decision that did not happen.
   */
  draftSafe: boolean;
  /**
   * The project tab that owns the long form, for reviews and corrections — a
   * `ProjectTab` key, so the phone links into the same screen with `?tab=`
   * rather than growing a second editor (§34).
   */
  section: "site" | "inspections" | "rfis" | "submittals" | "files" | "procurement" | "work";
}

/** The nine captures and two reviews §25 lists, in the order the issue lists them. */
export const AEC_FIELD_ACTIONS: readonly AecFieldAction[] = [
  {
    key: "site_log",
    label: "گزارش روزانه",
    hint: "کار انجام‌شده، نیرو، ماشین و حادثهٔ امروز",
    requirement: "create site log",
    kind: "capture",
    capability: "site_operations",
    draftSafe: true,
    section: "site",
  },
  {
    key: "site_photo",
    label: "عکس کارگاه",
    hint: "دوربین را باز می‌کند و عکس را با پیشرفت بارگذاری می‌فرستد",
    requirement: "take/upload site photos",
    kind: "capture",
    capability: "site_operations",
    // A binary is not a draft: a half-uploaded photo cannot be resumed from
    // localStorage, so the phone keeps the bytes in the picker instead.
    draftSafe: false,
    section: "site",
  },
  {
    key: "snag",
    label: "ثبت نقص",
    hint: "عنوان، محل، شدت و عکس — شماره را سیستم می‌دهد",
    requirement: "create snag",
    kind: "capture",
    capability: "snagging",
    draftSafe: true,
    section: "inspections",
  },
  {
    key: "inspection",
    label: "بازرسی",
    hint: "از چک‌لیست استاندارد، با آیتم‌های همان چک‌لیست",
    requirement: "create inspection",
    kind: "capture",
    capability: "qa_qc",
    draftSafe: true,
    section: "inspections",
  },
  {
    key: "rfi",
    label: "پرسش فنی (RFI)",
    hint: "موضوع و متن پرسش؛ مهلت پاسخ را انتخاب کنید",
    requirement: "create RFI",
    kind: "capture",
    capability: null,
    draftSafe: true,
    section: "rfis",
  },
  {
    key: "checklist",
    label: "تکمیل چک‌لیست",
    hint: "آیتم‌های باز بازرسی‌های در جریان را همین‌جا تیک بزنید",
    requirement: "complete checklist",
    kind: "update",
    capability: "qa_qc",
    // The ticks are a draft; leaving it never sends a verdict — closing the
    // inspection is a separate, deliberate action.
    draftSafe: true,
    section: "inspections",
  },
  {
    key: "task",
    label: "به‌روزرسانی وظیفه",
    hint: "وضعیت وظیفه‌های باز، با تاریخ شمسی",
    requirement: "update task",
    kind: "update",
    capability: null,
    draftSafe: false,
    section: "work",
  },
  {
    key: "delivery",
    label: "ثبت تحویل مصالح",
    hint: "کدام تعهد تأمین، چه روزی تحویل شد و چه کسی تحویل گرفت",
    requirement: "record material delivery",
    kind: "capture",
    capability: "procurement",
    draftSafe: true,
    section: "procurement",
  },
  {
    key: "latest_drawing",
    label: "آخرین نقشه",
    hint: "آخرین رویزیون صادرشدهٔ همان رشته، با پیوند فایل",
    requirement: "view latest drawing",
    kind: "review",
    capability: "document_control",
    draftSafe: false,
    section: "files",
  },
  {
    key: "submittal_review",
    label: "بررسی سابمیتال",
    hint: "سابمیتال‌های منتظر تأیید، برای مشاهده و پاسخ",
    requirement: "review submittal",
    kind: "review",
    capability: "document_control",
    draftSafe: false,
    section: "submittals",
  },
  {
    key: "approve_reject",
    label: "تأیید / رد",
    hint: "تصمیم‌های منتظر شما — تصمیم هرگز به‌صورت پیش‌نویس نمی‌ماند",
    requirement: "approve/reject",
    kind: "review",
    capability: "approvals",
    draftSafe: false,
    section: "submittals",
  },
] as const;

export const AEC_FIELD_ACTION_KEYS = AEC_FIELD_ACTIONS.map((action) => action.key);

export function aecFieldAction(key: string): AecFieldAction | null {
  return AEC_FIELD_ACTIONS.find((action) => action.key === key) ?? null;
}

/** The §25 rules, quoted on the screen so the list stays auditable. */
export const AEC_FIELD_RULES = [
  "RTL",
  "responsive",
  "touch friendly",
  "no desktop-only large tables for critical work",
  "fast file/photo capture",
  "clear upload progress",
  "drafts where safe",
  "Shamsi dates",
] as const;

/* ===========================================================================
 * The board
 * ======================================================================== */

export interface FieldQueueRow {
  id: string;
  title: string;
  /** The register's own number, when it has one. */
  number: string | null;
  status: string;
  /** Shamsi, ready to render — the board never formats a date itself. */
  dateJalali: string | null;
  /** Days until the due date measured from the business's today; negative = late. */
  daysRemaining: number | null;
  /** Severity/urgency chip, already Persian. */
  chip: string | null;
  /** What the phone may do with the row: open it, or check it off. */
  action: "open" | "check" | "status";
}

export interface FieldBoard {
  today: string;
  todayJalali: string;
  /** The project's name and status, so the phone's header needs no second read. */
  project: { id: string; name: string; status: string; statusLabel: string };
  capabilities: string[];
  /** The checklists an inspection may be started from, when `qa_qc` is on. */
  checklists: SiteChecklistSummary[];
  /**
   * Numbers the phone can prefill so a capture is two taps, not a typing test.
   * They are *suggestions* and the register's own uniqueness still decides: an
   * RFI number is the team's, not the server's (§10) — the field screen only
   * spares a foreman the arithmetic.
   */
  suggestions: { rfiNumber: string };
  queues: {
    /** `todayLogId` lets the phone edit today's day instead of failing on a second one. */
    siteLog: { todayLogged: boolean; todayLogId: string | null };
    snags: { openCount: number; rows: FieldQueueRow[] };
    inspections: { openCount: number; rows: FieldQueueRow[] };
    rfis: { openCount: number; rows: FieldQueueRow[] };
    tasks: { openCount: number; rows: FieldQueueRow[] };
    deliveries: { pendingCount: number; rows: FieldQueueRow[] };
    drawings: { rows: FieldDrawingRow[] };
    submittals: { waitingCount: number; rows: FieldQueueRow[] };
  };
}

/** The latest revision of one drawing, as the phone links to it. */
export interface FieldDrawingRow {
  id: string;
  documentNumber: string;
  title: string;
  revisionCode: string | null;
  revisionId: string | null;
  statusLabel: string | null;
}

/** The board is a queue, not a table (§34): every register is capped. */
export const AEC_FIELD_QUEUE_LIMIT = 5;

const JALALI = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** Shamsi for a `YYYY-MM-DD` string, in UTC so a timezone cannot shift the day. */
export function fieldDateJalali(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return JALALI.format(date);
}

/** Whole days from one `YYYY-MM-DD` to another; negative means the second is past. */
export function fieldDaysBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
}
