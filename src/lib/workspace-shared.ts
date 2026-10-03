/**
 * Phase G — «میز کار من» (My Workspace): the framework-free half.
 *
 * Same split as `ai-projects-shared.ts`: no `db`, no `next`, no React, so a
 * client component can import the vocabularies and the pure rules directly
 * while the DB-touching half stays in `workspace.ts`. Everything here is a
 * constant, a type or a pure function, which is also what makes the rules
 * below unit-testable without a database.
 */

import type { AecOperatingProfile } from "./aec";
import type { Industry } from "./industries";
import { AEC_BUILTIN_TEMPLATES } from "./workspace-aec-templates";

/* ---------------------------------------------------------------------------
 * Sections
 * ------------------------------------------------------------------------- */

/**
 * The ten sections of the workspace, in navigation order. The ordering is the
 * user's path through the module — where am I (overview), what am I running
 * (projects/tasks/calendar), what is it made of (documents/contracts), who is
 * on it (teams), what needs a decision (approvals), and the two
 * configuration-ish tails (reports/templates).
 */
export const WORKSPACE_SECTIONS = [
  "overview",
  "projects",
  "tasks",
  "calendar",
  "documents",
  "contracts",
  "teams",
  "approvals",
  "reports",
  "templates",
] as const;

export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];

export const WORKSPACE_SECTION_LABELS: Record<WorkspaceSection, string> = {
  overview: "نمای کلی",
  projects: "پروژه‌ها",
  tasks: "وظایف",
  calendar: "تقویم",
  documents: "اسناد",
  contracts: "قراردادها",
  teams: "تیم‌ها",
  approvals: "تأییدها",
  reports: "گزارش‌ها",
  templates: "قالب‌ها",
};

/** Pure: narrows an arbitrary string to a section key. */
export function isWorkspaceSection(value: string): value is WorkspaceSection {
  return (WORKSPACE_SECTIONS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
 * Project vocabulary
 * ------------------------------------------------------------------------- */

/**
 * Status. The first three are Phase 37's original values, kept verbatim —
 * `planning` and `cancelled` were added by migration 0167 and every existing
 * row still reads back as one of the original three.
 */
export const PROJECT_STATUSES = [
  "planning",
  "active",
  "paused",
  "completed",
  "cancelled",
] as const;
export type WorkspaceProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<WorkspaceProjectStatus, string> = {
  planning: "در حال برنامه‌ریزی",
  active: "فعال",
  paused: "متوقف",
  completed: "تکمیل‌شده",
  cancelled: "لغو‌شده",
};

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type WorkspacePriority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<WorkspacePriority, string> = {
  low: "کم",
  normal: "عادی",
  high: "زیاد",
  urgent: "فوری",
};

/** Sort weight so an "urgent first" list is a pure comparison, not a CASE. */
export const PRIORITY_WEIGHT: Record<WorkspacePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done"] as const;
export type WorkspaceTaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<WorkspaceTaskStatus, string> = {
  open: "باز",
  in_progress: "در حال انجام",
  blocked: "مسدود",
  done: "انجام‌شده",
};

/** The Kanban columns, in board order — the same four statuses, left to right. */
export const TASK_BOARD_COLUMNS = TASK_STATUSES;

export const PHASE_STATUSES = ["pending", "active", "done", "skipped"] as const;
export type WorkspacePhaseStatus = (typeof PHASE_STATUSES)[number];

export const PHASE_STATUS_LABELS: Record<WorkspacePhaseStatus, string> = {
  pending: "در انتظار",
  active: "جاری",
  done: "پایان‌یافته",
  skipped: "رد‌شده",
};

/* ---------------------------------------------------------------------------
 * Members
 * ------------------------------------------------------------------------- */

/**
 * The five project roles, ordered most to least capable. This is a role WITHIN
 * a project and is intersected with the platform permission — it never grants
 * anything `permissions.ts` has not already granted.
 */
export const WORKSPACE_ROLES = [
  "owner",
  "manager",
  "editor",
  "contributor",
  "viewer",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "مالک",
  manager: "مدیر",
  editor: "ویرایشگر",
  contributor: "مشارکت‌کننده",
  viewer: "بیننده",
};

export const WORKSPACE_ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "دسترسی کامل، شامل حذف پروژه و تغییر اعضا",
  manager: "مدیریت پروژه، وظایف، قراردادها و اعضا",
  editor: "ایجاد و ویرایش وظایف، اسناد و قراردادها",
  contributor: "کار روی وظایف واگذارشده و افزودن سند",
  viewer: "فقط مشاهده",
};

/** Rank: lower is more capable, so a check is a `<=`. */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 0,
  manager: 1,
  editor: 2,
  contributor: 3,
  viewer: 4,
};

/**
 * Pure: does `role` meet `required`? `roleAtLeast("editor", "contributor")` is
 * true; the reverse is false.
 */
export function roleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[role] <= ROLE_RANK[required];
}

/**
 * The capability matrix, expressed once. Each capability names the least
 * capable project role that holds it; the API layer intersects the answer with
 * the caller's platform permission, so this can never widen access on its own.
 */
export const WORKSPACE_CAPABILITY_MIN_ROLE = {
  /** See the project at all. */
  view: "viewer",
  /** Comment, and tick a checklist item on a task assigned to you. */
  contribute: "contributor",
  /** Create/edit tasks, documents and contracts inside the project. */
  edit: "editor",
  /** Edit the project record, its phases and its membership. */
  manage: "manager",
  /** Delete/archive the project. */
  administer: "owner",
} as const satisfies Record<string, WorkspaceRole>;

export type WorkspaceCapability = keyof typeof WORKSPACE_CAPABILITY_MIN_ROLE;

/** Pure: whether a project role holds a capability. */
export function roleCan(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return roleAtLeast(role, WORKSPACE_CAPABILITY_MIN_ROLE[capability]);
}

/* ---------------------------------------------------------------------------
 * Contracts
 * ------------------------------------------------------------------------- */

/**
 * EXECUTION contract types only. The relationship contracts — sales, service,
 * partnership — deliberately live in the CRM against the customer, because the
 * question they answer is "what did we agree with this customer", not "how does
 * this project get delivered". See `docs/app-boundaries.md`.
 */
export const CONTRACT_TYPES = [
  "contractor",
  "supplier",
  "consultant",
  "subcontractor",
  "vendor",
  "developer",
  "service",
  "other",
] as const;
export type WorkspaceContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABELS: Record<WorkspaceContractType, string> = {
  contractor: "پیمانکار",
  supplier: "تأمین‌کننده",
  consultant: "مشاور",
  subcontractor: "پیمانکار جزء",
  vendor: "فروشنده",
  developer: "توسعه‌دهنده",
  service: "خدمات",
  other: "سایر",
};

export const CONTRACT_STATUSES = [
  "draft",
  "pending_approval",
  "active",
  "expired",
  "terminated",
  "completed",
] as const;
export type WorkspaceContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABELS: Record<WorkspaceContractStatus, string> = {
  draft: "پیش‌نویس",
  pending_approval: "در انتظار تأیید",
  active: "جاری",
  expired: "منقضی",
  terminated: "فسخ‌شده",
  completed: "خاتمه‌یافته",
};

/** Default reminder lead time, in days, offered when a contract gets an expiry. */
export const CONTRACT_DEFAULT_REMINDER_DAYS = 30;

/* ---------------------------------------------------------------------------
 * Documents
 * ------------------------------------------------------------------------- */

export const DOCUMENT_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "rejected",
  "archived",
] as const;
export type WorkspaceDocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_STATUS_LABELS: Record<WorkspaceDocumentStatus, string> = {
  draft: "پیش‌نویس",
  in_review: "در حال بررسی",
  approved: "تأییدشده",
  rejected: "ردشده",
  archived: "بایگانی",
};

/* ---------------------------------------------------------------------------
 * Approvals
 * ------------------------------------------------------------------------- */

export const APPROVAL_SUBJECTS = [
  "project",
  "task",
  "document",
  "contract",
  "estimate_version",
  // Issue #799 §11 — a submittal revision is reviewed through the same engine
  // under the same `workspace.approve` key. A sixth subject rather than a second
  // approval store, for the reason given below for the fifth: the queue, the
  // dashboard counters and the reminder job learn about submittals for free.
  "submittal_revision",
] as const;
export type WorkspaceApprovalSubject = (typeof APPROVAL_SUBJECTS)[number];

export const APPROVAL_SUBJECT_LABELS: Record<WorkspaceApprovalSubject, string> = {
  project: "پروژه",
  task: "وظیفه",
  document: "سند",
  contract: "قرارداد",
  // Issue #799 §7 — a BOQ revision is approved through the same engine as a
  // contract, under the same `workspace.approve` key. It is a fifth subject
  // rather than a second approval table, which is why a submission appears in
  // the approvals queue, the dashboard counters and the widgets for free.
  estimate_version: "نسخهٔ برآورد",
  submittal_revision: "بازنگری سابمیتال",
};

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type WorkspaceApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<WorkspaceApprovalStatus, string> = {
  pending: "در انتظار",
  approved: "تأییدشده",
  rejected: "ردشده",
  cancelled: "لغو‌شده",
};

/* ---------------------------------------------------------------------------
 * Calendar
 * ------------------------------------------------------------------------- */

export const EVENT_KINDS = ["meeting", "milestone", "reminder", "site_visit", "other"] as const;
export type WorkspaceEventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_LABELS: Record<WorkspaceEventKind, string> = {
  meeting: "جلسه",
  milestone: "نقطهٔ عطف",
  reminder: "یادآوری",
  site_visit: "بازدید",
  other: "سایر",
};

/**
 * The calendar's sources. Four of the five are DERIVED from dates that already
 * exist on other rows (a project's end, a task's due date, a contract's expiry,
 * an approval's deadline) and only `event` is a stored calendar row — copying
 * the other four into an events table would give every date two owners and the
 * first reschedule would desynchronise them.
 */
export const CALENDAR_SOURCES = [
  "event",
  "project_deadline",
  "task_due",
  "contract_expiry",
  "approval_due",
] as const;
export type WorkspaceCalendarSource = (typeof CALENDAR_SOURCES)[number];

export const CALENDAR_SOURCE_LABELS: Record<WorkspaceCalendarSource, string> = {
  event: "رویداد",
  project_deadline: "مهلت پروژه",
  task_due: "مهلت وظیفه",
  contract_expiry: "انقضای قرارداد",
  approval_due: "مهلت تأیید",
};

/* ---------------------------------------------------------------------------
 * Limits
 * ------------------------------------------------------------------------- */

export const WORKSPACE_LIMITS = {
  projectNameMax: 120,
  projectDescriptionMax: 2000,
  taskTitleMax: 200,
  taskDescriptionMax: 4000,
  contractTitleMax: 200,
  documentTitleMax: 200,
  commentMax: 2000,
  checklistTitleMax: 200,
  tagsMax: 12,
  tagMax: 32,
  eventTitleMax: 160,
  templatePhasesMax: 20,
} as const;

/* ---------------------------------------------------------------------------
 * Built-in project templates
 * ------------------------------------------------------------------------- */

export interface WorkspaceTemplatePhase {
  name: string;
  /** Offset in days from the project start, used to seed the phase's dates. */
  offsetDays?: number;
  durationDays?: number;
}

export interface WorkspaceTemplate {
  key: string;
  name: string;
  description: string;
  projectType: string;
  phases: WorkspaceTemplatePhase[];
  defaultTasks: string[];
  /**
   * The industry this blueprint belongs to, or nothing for the generic
   * catalogue every trade sees. (#799 §4's six AEC templates are the first
   * industry-scoped ones: a café must not be offered «پیمانکاری عمومی».)
   */
  industry?: Industry | null;
  /**
   * AEC operating profiles this template is *recommended* for. Ordering and a
   * badge only — never a gate: a contractor renovating an office still gets
   * the fit-out template, it is simply not the one marked «پیشنهادی».
   */
  recommendedProfiles?: readonly AecOperatingProfile[];
}

/** A template plus the answer to "should this business see it first". */
export interface WorkspaceTemplateChoice extends WorkspaceTemplate {
  recommended: boolean;
}

/**
 * The built-in catalogue. It is CODE, not seeded rows, for three reasons: a
 * brand-new tenant has the full catalogue on its first request with no seeding
 * migration, an improvement to a template reaches every business at once, and
 * there is no per-tenant copy to drift. A business that needs its own blueprint
 * writes a row in `workspace_project_templates`, which the service layer
 * concatenates onto this list.
 *
 * The families are deliberately generic — construction, architecture,
 * software, marketing, event, consulting, and a bare generic — because the
 * brief's requirement is a workspace that fits ANY business, and a
 * restaurant-shaped phase list would have made it fit exactly one.
 *
 * Industry-scoped templates (`industry` set) are appended from their own
 * module — `workspace-aec-templates.ts` holds issue #799 §4's six AEC
 * blueprints — and are only offered to that industry. Keeping them out of this
 * literal is what stops the generic catalogue from growing a trade-specific
 * branch every time an industry is added.
 */
export const BUILTIN_TEMPLATES: WorkspaceTemplate[] = [
  {
    key: "generic",
    name: "پروژهٔ عمومی",
    description: "چهار مرحلهٔ ساده برای هر نوع کار",
    projectType: "general",
    phases: [
      { name: "برنامه‌ریزی" },
      { name: "اجرا" },
      { name: "بازبینی" },
      { name: "تحویل" },
    ],
    defaultTasks: ["تعیین محدودهٔ کار", "تعیین زمان‌بندی"],
  },
  {
    key: "construction",
    name: "ساخت‌وساز",
    description: "از مطالعات اولیه تا تحویل موقت و قطعی",
    projectType: "construction",
    phases: [
      { name: "مطالعات و برنامه‌ریزی" },
      { name: "طراحی" },
      { name: "اخذ مجوز" },
      { name: "تأمین مصالح" },
      { name: "اجرا" },
      { name: "نظارت و بازرسی" },
      { name: "تحویل" },
    ],
    defaultTasks: ["تهیهٔ برآورد اولیه", "انتخاب پیمانکار", "تنظیم قرارداد پیمانکاری"],
  },
  {
    key: "architecture",
    name: "معماری",
    description: "فازهای مطالعاتی، فاز یک و فاز دو تا نظارت کارگاهی",
    projectType: "architecture",
    phases: [
      { name: "برنامه‌دهی و مطالعات" },
      { name: "طراحی مفهومی" },
      { name: "فاز یک" },
      { name: "فاز دو" },
      { name: "نظارت" },
    ],
    defaultTasks: ["جلسهٔ شناخت با کارفرما", "تهیهٔ نقشهٔ وضع موجود"],
  },
  {
    key: "software",
    name: "توسعهٔ نرم‌افزار",
    description: "از تحلیل نیازمندی تا استقرار و پشتیبانی",
    projectType: "software",
    phases: [
      { name: "تحلیل نیازمندی" },
      { name: "طراحی" },
      { name: "پیاده‌سازی" },
      { name: "آزمون" },
      { name: "استقرار" },
      { name: "پشتیبانی" },
    ],
    defaultTasks: ["تدوین سند نیازمندی", "تعیین معماری", "تنظیم محیط توسعه"],
  },
  {
    key: "marketing",
    name: "کمپین بازاریابی",
    description: "از تدوین استراتژی تا سنجش نتیجه",
    projectType: "marketing",
    phases: [
      { name: "استراتژی" },
      { name: "تولید محتوا" },
      { name: "اجرا" },
      { name: "سنجش" },
    ],
    defaultTasks: ["تعیین مخاطب هدف", "تعیین بودجه", "تقویم محتوا"],
  },
  {
    key: "event",
    name: "برگزاری رویداد",
    description: "برنامه‌ریزی، هماهنگی، اجرا و جمع‌بندی",
    projectType: "event",
    phases: [
      { name: "برنامه‌ریزی" },
      { name: "هماهنگی و تأمین" },
      { name: "اجرا" },
      { name: "جمع‌بندی" },
    ],
    defaultTasks: ["رزرو مکان", "فهرست مهمانان", "هماهنگی تأمین‌کنندگان"],
  },
  {
    key: "consulting",
    name: "پروژهٔ مشاوره",
    description: "شناخت، تحلیل، ارائهٔ راهکار و پیاده‌سازی",
    projectType: "consulting",
    phases: [
      { name: "شناخت" },
      { name: "تحلیل" },
      { name: "ارائهٔ راهکار" },
      { name: "پیاده‌سازی" },
    ],
    defaultTasks: ["جلسهٔ آغازین", "جمع‌آوری داده"],
  },
  ...AEC_BUILTIN_TEMPLATES,
];

/** Pure: looks a built-in template up by key. */
export function builtinTemplate(key: string): WorkspaceTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * Pure: the templates a business of `industry` may choose, with the ones
 * recommended for its operating profile first and flagged.
 *
 * `industry: null` means the caller could not resolve one (an unprovisioned or
 * missing row) and keeps only the generic catalogue — an unknown tenant must
 * never be *offered* a trade it may not be. Sorting is stable, so the built-in
 * order (generic families, then the industry's own set) survives inside each
 * group and the catalogue stays authored rather than incidental.
 */
export function templatesForIndustry(
  templates: WorkspaceTemplate[],
  industry: Industry | null,
  profile: AecOperatingProfile | null = null,
): WorkspaceTemplateChoice[] {
  const eligible = templates
    .filter((template) => !template.industry || template.industry === industry)
    .map((template) => ({
      ...template,
      recommended: Boolean(profile && template.recommendedProfiles?.includes(profile)),
    }));
  return [
    ...eligible.filter((template) => template.recommended),
    ...eligible.filter((template) => !template.recommended),
  ];
}

/* ---------------------------------------------------------------------------
 * Pure rules
 * ------------------------------------------------------------------------- */

/** Pure: normalises a tag list — trimmed, de-duplicated, capped, no blanks. */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, WORKSPACE_LIMITS.tagMax);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= WORKSPACE_LIMITS.tagsMax) break;
  }
  return out;
}

/**
 * Pure: how many days from `today` until `date`. Negative = overdue.
 * Both are ISO `YYYY-MM-DD` calendar days, compared at UTC midnight so the
 * result is a whole number of days and never shifts with the viewer's clock.
 */
export function daysUntil(date: string, today: string): number {
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

/**
 * Pure: the urgency bucket a dated thing falls into. The dashboard's
 * «مهلت‌های پیش‌رو» strip and the task list share it so a task that is red in
 * one place is never amber in the other.
 */
export type DeadlineTone = "overdue" | "today" | "soon" | "later" | "none";

export function deadlineTone(
  date: string | null | undefined,
  today: string,
  soonDays = 7,
): DeadlineTone {
  if (!date) return "none";
  const days = daysUntil(date, today);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= soonDays) return "soon";
  return "later";
}

/**
 * Pure: is a contract close enough to expiry to be surfaced? `reminder_days`
 * is the business's own lead time; with none set we fall back to the default,
 * because a contract with an expiry and no reminder is still worth a warning.
 */
export function contractNeedsReminder(
  contract: { endDate: string | null; reminderDays: number | null; status: string },
  today: string,
): boolean {
  if (!contract.endDate) return false;
  if (contract.status === "terminated" || contract.status === "completed") return false;
  const lead = contract.reminderDays ?? CONTRACT_DEFAULT_REMINDER_DAYS;
  const days = daysUntil(contract.endDate, today);
  return days <= lead;
}

/**
 * Pure: a project's completion percentage from its task counts. Rounded to a
 * whole percent; a project with no tasks is 0, not NaN.
 */
export function completionPercent(doneCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.round((doneCount / totalCount) * 100);
}

/**
 * Pure: would adding `task → dependsOn` close a cycle? Walks the existing edge
 * list forward from `dependsOn`; if it can reach `task`, the new edge would
 * complete a loop and the write must be refused. The DB CHECK only catches a
 * self-edge, so this is where A→B→C→A is stopped.
 */
export function wouldCreateDependencyCycle(
  edges: ReadonlyArray<{ taskId: string; dependsOnId: string }>,
  taskId: string,
  dependsOnId: string,
): boolean {
  if (taskId === dependsOnId) return true;
  const forward = new Map<string, string[]>();
  for (const edge of edges) {
    const list = forward.get(edge.taskId);
    if (list) list.push(edge.dependsOnId);
    else forward.set(edge.taskId, [edge.dependsOnId]);
  }
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of forward.get(current) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Pure: is a task startable, i.e. is every task it depends on done? A blocked
 * task is not an error — the board shows it in its own column — so this is a
 * question the UI asks, not a constraint the writer enforces.
 */
export function dependenciesSatisfied(
  dependsOnStatuses: ReadonlyArray<string>,
): boolean {
  return dependsOnStatuses.every((status) => status === "done");
}

/**
 * Pure: sorts tasks the way every workspace list shows them — urgent first,
 * then by due date with undated last, then by title so the order is stable.
 */
export function compareTasksForList(
  a: { priority: WorkspacePriority; dueDate: string | null; title: string },
  b: { priority: WorkspacePriority; dueDate: string | null; title: string },
): number {
  const byPriority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.title.localeCompare(b.title, "fa");
}

/**
 * Pure: expands a template into concrete phase rows for a project starting on
 * `startDate` (ISO). Without a start date the phases are created undated —
 * a template must still be applicable to a project whose dates are unknown.
 */
export function phasesFromTemplate(
  template: WorkspaceTemplate,
  startDate: string | null,
): Array<{ name: string; displayOrder: number; startDate: string | null; endDate: string | null }> {
  let cursor = 0;
  return template.phases.slice(0, WORKSPACE_LIMITS.templatePhasesMax).map((phase, index) => {
    const offset = phase.offsetDays ?? cursor;
    const duration = phase.durationDays ?? 0;
    cursor = offset + duration;
    return {
      name: phase.name,
      displayOrder: index,
      startDate: startDate && duration > 0 ? addDays(startDate, offset) : null,
      endDate: startDate && duration > 0 ? addDays(startDate, offset + duration) : null,
    };
  });
}

/** Pure: ISO day + n days, as an ISO day. */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/* ===========================================================================
 * AI tool identity
 * ======================================================================== */

/**
 * The four AI tool names, in one place so every registration site agrees.
 *
 * These live in the PURE module, not next to the executor in
 * `ai-workspace-tools.ts`, and that is load-bearing: the agent builder's tool
 * picker is a client component, and importing the names from the executor
 * pulled `workspace.ts` → `db.ts` → `pg` into the browser bundle, which fails
 * the build on `Can't resolve 'tls'`. A name and a label are data; only the
 * executor needs a database.
 */
export const WORKSPACE_TOOL_NAMES = [
  "get_workspace_project_status",
  "list_workspace_tasks",
  "list_expiring_contracts",
  "list_workspace_approvals",
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Persian labels for the agent builder's tool picker. */
export const WORKSPACE_TOOL_LABELS: Record<WorkspaceToolName, string> = {
  get_workspace_project_status: "وضعیت یک پروژه",
  list_workspace_tasks: "وظایف میز کار",
  list_expiring_contracts: "قراردادهای رو به انقضا",
  list_workspace_approvals: "تأییدهای در انتظار",
};
