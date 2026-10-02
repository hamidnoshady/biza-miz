/**
 * Phase G — «میز کار من» (My Workspace): the framework-free half.
 *
 * Same split as `ai-projects-shared.ts`: no `db`, no `next`, no React, so a
 * client component can import the vocabularies and the pure rules directly
 * while the DB-touching half stays in `workspace.ts`. Everything here is a
 * constant, a type or a pure function, which is also what makes the rules
 * below unit-testable without a database.
 */

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

export const APPROVAL_SUBJECTS = ["project", "task", "document", "contract"] as const;
export type WorkspaceApprovalSubject = (typeof APPROVAL_SUBJECTS)[number];

export const APPROVAL_SUBJECT_LABELS: Record<WorkspaceApprovalSubject, string> = {
  project: "پروژه",
  task: "وظیفه",
  document: "سند",
  contract: "قرارداد",
};

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "cancelled",
] as const;
export type WorkspaceApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<WorkspaceApprovalStatus, string> = {
  pending: "در انتظار",
  approved: "تأییدشده",
  rejected: "ردشده",
  changes_requested: "نیازمند اصلاح",
  cancelled: "لغو‌شده",
};

export type WorkspaceApprovalDecision = Exclude<WorkspaceApprovalStatus, "pending">;

/**
 * Pure: may this actor record `decision` on a pending approval?
 *
 * - Cancelling withdraws a request, so it belongs to whoever asked (or an
 *   administrator cleaning up).
 * - Every other decision is the approver's. The requester may never decide
 *   their own request — an approval you can grant yourself is decorative.
 * - A named approver is the ONLY one who may decide, apart from an explicit
 *   business-wide administrator override.
 * - An unassigned request may be decided by a manager of the subject's
 *   project (`canManageSubject`).
 *
 * Returns null when allowed, or the error code to refuse with.
 */
export function approvalDecisionError(input: {
  decision: WorkspaceApprovalDecision;
  actorUserId: string;
  requestedBy: string | null;
  approverUserId: string | null;
  isAdministrator: boolean;
  canManageSubject: boolean;
}): string | null {
  const { decision, actorUserId, requestedBy, approverUserId } = input;
  if (decision === "cancelled") {
    return requestedBy === actorUserId || input.isAdministrator ? null : "not_the_requester";
  }
  if (requestedBy && requestedBy === actorUserId) return "self_approval_forbidden";
  if (approverUserId) {
    return approverUserId === actorUserId || input.isAdministrator ? null : "not_the_approver";
  }
  return input.isAdministrator || input.canManageSubject ? null : "insufficient_project_role";
}

/* ---------------------------------------------------------------------------
 * Business-wide access
 * ------------------------------------------------------------------------- */

/**
 * How far past project membership a member reaches.
 *
 * - `administer`: holds `workspace.admin` — the business's own workspace
 *   administrator, who acts as a manager on every project. Explicit, granted
 *   by preset to manager/admin and revocable per member; never implied by
 *   `workspace.view` or `workspace.manage`.
 * - `read`: holds `ledger.view` — projects are cost centres the books post
 *   against, so the accountant reads every project as a viewer, never writes.
 * - `null`: membership only.
 */
export type WorkspaceOverride = "administer" | "read" | null;

export interface WorkspaceAccessFlags {
  override: WorkspaceOverride;
  /** Ledger-derived spend may be shown. */
  canViewFinancials: boolean;
  /** May see business-level (project-less) contracts. */
  canManageContracts: boolean;
  /** May use the pickers (people, parties, media) a write form needs. */
  canManage: boolean;
  /** Holds `workspace.approve`. */
  canApprove: boolean;
  /** Holds `media.view` — may open a document's file (the media route's own rule). */
  canViewMedia: boolean;
}

/**
 * What the actor may do on one project: the platform permission AND the
 * project role, computed once on the server so the client renders controls
 * from it instead of guessing. The server still re-checks every write.
 */
export interface WorkspaceProjectCapabilities {
  canView: boolean;
  canContribute: boolean;
  canEdit: boolean;
  canManageProject: boolean;
  canAdminister: boolean;
  canManageContracts: boolean;
  canApprove: boolean;
  canViewFinancials: boolean;
}

export function projectCapabilities(
  role: WorkspaceRole | null,
  flags: WorkspaceAccessFlags,
): WorkspaceProjectCapabilities {
  const can = (capability: WorkspaceCapability) => role !== null && roleCan(role, capability);
  // Every write also needs `workspace.manage`; a viewer-preset member who is
  // an editor on a project still cannot write.
  const writes = flags.canManage;
  return {
    canView: can("view"),
    canContribute: writes && can("contribute"),
    canEdit: writes && can("edit"),
    canManageProject: writes && can("manage"),
    canAdminister: writes && can("administer"),
    canManageContracts: flags.canManageContracts && can("edit"),
    canApprove: flags.canApprove && can("view"),
    canViewFinancials: flags.canViewFinancials && can("view"),
  };
}

/** Pure: the access flags a set of effective permissions confers. */
export function workspaceAccessFlags(permissions: ReadonlySet<string>): WorkspaceAccessFlags {
  return {
    override: permissions.has("workspace.admin")
      ? "administer"
      : permissions.has("ledger.view")
        ? "read"
        : null,
    canViewFinancials: permissions.has("ledger.view"),
    canManageContracts: permissions.has("workspace.contracts_manage"),
    canManage: permissions.has("workspace.manage"),
    canApprove: permissions.has("workspace.approve"),
    canViewMedia: permissions.has("media.view"),
  };
}

/** Pure: the role an override confers on a project the member is not on. */
export function overrideRole(override: WorkspaceOverride): WorkspaceRole | null {
  if (override === "administer") return "manager";
  if (override === "read") return "viewer";
  return null;
}

/** Pure: the stronger of a member role and an override role. */
export function effectiveProjectRole(
  memberRole: WorkspaceRole | null,
  override: WorkspaceOverride,
): WorkspaceRole | null {
  const fromOverride = overrideRole(override);
  if (!memberRole) return fromOverride;
  if (!fromOverride) return memberRole;
  return roleAtLeast(memberRole, fromOverride) ? memberRole : fromOverride;
}

/** Pure: a date/time interval is ordered (either end may be absent). */
export function intervalOrdered(start: string | null, end: string | null): boolean {
  return !start || !end || end >= start;
}

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
];

/** Pure: looks a built-in template up by key. */
export function builtinTemplate(key: string): WorkspaceTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.key === key) ?? null;
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

/* ---------------------------------------------------------------------------
 * Project health (#761 §7, §8, §15)
 * ------------------------------------------------------------------------- */

export type ProjectHealth = "on_track" | "at_risk" | "off_track";

export const PROJECT_HEALTH_LABELS: Record<ProjectHealth, string> = {
  on_track: "طبق برنامه",
  at_risk: "در معرض خطر",
  off_track: "عقب از برنامه",
};

export type ProjectHealthReason =
  | "overdue_tasks"
  | "behind_schedule"
  | "past_deadline"
  | "over_budget"
  | "budget_nearly_spent"
  | "pending_approvals"
  | "contracts_expiring";

export const PROJECT_HEALTH_REASON_LABELS: Record<ProjectHealthReason, string> = {
  overdue_tasks: "وظیفهٔ عقب‌افتاده",
  behind_schedule: "پیشرفت کمتر از زمان سپری‌شده",
  past_deadline: "مهلت پروژه گذشته است",
  over_budget: "هزینه از بودجه گذشته است",
  budget_nearly_spent: "بیش از ۹۰٪ بودجه مصرف شده",
  pending_approvals: "تأیید در انتظار",
  contracts_expiring: "قرارداد رو به انقضا",
};

export interface ProjectHealthInput {
  today: string;
  startDate: string | null;
  endDate: string | null;
  completed: boolean;
  taskCount: number;
  doneTaskCount: number;
  overdueTaskCount: number;
  budgetRial: number | null;
  /** Null when the actor may not read the ledger — budget is then not judged. */
  spentRial: number | null;
  pendingApprovals: number;
  expiringContracts: number;
}

/**
 * Pure: how a project is doing, and why — the same answer on the portfolio,
 * the project page and the reports, from facts the server already has.
 *
 * - **off_track**: the deadline has passed with work open, spend is over
 *   budget, or progress trails elapsed time by 25 points or more.
 * - **at_risk**: overdue tasks, progress trailing time by 10+ points, ≥90%
 *   of budget spent, approvals waiting, or contracts expiring within 30 days.
 * - **on_track** otherwise. A completed project is always on track.
 *
 * "Behind schedule" compares the share of the project's duration that has
 * elapsed with the share of its tasks that are done; it needs both dates and
 * at least one task, and is not judged before the start date.
 */
export function projectHealth(input: ProjectHealthInput): {
  health: ProjectHealth;
  reasons: ProjectHealthReason[];
  elapsedPercent: number | null;
  progressPercent: number;
} {
  const progressPercent = completionPercent(input.doneTaskCount, input.taskCount);
  let elapsedPercent: number | null = null;
  if (input.startDate && input.endDate && input.endDate > input.startDate) {
    const total = daysUntil(input.endDate, input.startDate);
    const gone = daysUntil(input.today, input.startDate);
    elapsedPercent = Math.max(0, Math.min(100, Math.round((gone / total) * 100)));
  }
  if (input.completed) return { health: "on_track", reasons: [], elapsedPercent, progressPercent };

  const severe: ProjectHealthReason[] = [];
  const warn: ProjectHealthReason[] = [];
  const open = input.taskCount - input.doneTaskCount;

  if (input.endDate && input.endDate < input.today && open > 0) severe.push("past_deadline");
  if (input.budgetRial !== null && input.spentRial !== null && input.budgetRial > 0) {
    if (input.spentRial > input.budgetRial) severe.push("over_budget");
    else if (input.spentRial >= input.budgetRial * 0.9) warn.push("budget_nearly_spent");
  }
  if (elapsedPercent !== null && input.taskCount > 0 && elapsedPercent > 0) {
    const gap = elapsedPercent - progressPercent;
    if (gap >= 25) severe.push("behind_schedule");
    else if (gap >= 10) warn.push("behind_schedule");
  }
  if (input.overdueTaskCount > 0) warn.push("overdue_tasks");
  if (input.pendingApprovals > 0) warn.push("pending_approvals");
  if (input.expiringContracts > 0) warn.push("contracts_expiring");

  const reasons = [...severe, ...warn];
  return {
    health: severe.length ? "off_track" : warn.length ? "at_risk" : "on_track",
    reasons,
    elapsedPercent,
    progressPercent,
  };
}

/**
 * The dependency rule, explicit (#761 §9): a task may not be marked DONE
 * while any task it waits on is unfinished. Moving it to in-progress or
 * blocked is allowed — the board shows the open blockers as a warning.
 */
export function dependencyBlocksStatus(
  nextStatus: WorkspaceTaskStatus,
  unfinishedBlockers: number,
): boolean {
  return nextStatus === "done" && unfinishedBlockers > 0;
}

/**
 * Pure: the Saturday that starts the week `date` falls in — the Persian week,
 * which the timeline lanes and the calendar both use.
 */
export function weekStartSaturday(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // Sun=0 … Sat=6
  return addDays(date, -((day + 1) % 7));
}

/* ---------------------------------------------------------------------------
 * Contract lifecycle (#761 §12)
 * ------------------------------------------------------------------------- */

export const CONTRACT_LIFECYCLE_ACTIONS = ["complete", "terminate", "extend", "renew"] as const;
export type ContractLifecycleAction = (typeof CONTRACT_LIFECYCLE_ACTIONS)[number];

export const CONTRACT_LIFECYCLE_LABELS: Record<ContractLifecycleAction, string> = {
  complete: "اتمام",
  terminate: "فسخ",
  extend: "تمدید مدت",
  renew: "تجدید",
};

const LIFECYCLE_FROM: Record<ContractLifecycleAction, readonly WorkspaceContractStatus[]> = {
  // Work delivered: a live (or lapsed-but-unclosed) contract is closed out.
  complete: ["active", "expired"],
  // Ended early, by either side, at any point before it was closed out.
  terminate: ["draft", "pending_approval", "active", "expired"],
  // Same agreement, later end date.
  extend: ["active", "expired"],
  // A new term of an agreement that ran its course.
  renew: ["expired", "completed"],
};

/** Pure: which lifecycle actions a contract in this status can take. */
export function allowedContractActions(status: WorkspaceContractStatus): ContractLifecycleAction[] {
  return CONTRACT_LIFECYCLE_ACTIONS.filter((action) => LIFECYCLE_FROM[action].includes(status));
}

/**
 * Pure: what a lifecycle action does to a contract, or why it cannot.
 *
 * - complete → `completed`; terminate → `terminated` (end date = today when
 *   it was later, so the record says when it actually stopped).
 * - extend → stays/returns `active` with a later end date.
 * - renew → `active` for a new term starting the day after the old end (or
 *   today, whichever is later) and ending on the given date.
 */
export function contractLifecycleChange(
  action: ContractLifecycleAction,
  current: { status: WorkspaceContractStatus; startDate: string | null; endDate: string | null },
  input: { endDate?: string | null; today: string },
):
  | { ok: true; status: WorkspaceContractStatus; startDate: string | null; endDate: string | null }
  | { ok: false; error: string } {
  if (!LIFECYCLE_FROM[action].includes(current.status)) return { ok: false, error: "invalid_contract_transition" };
  const today = input.today;
  if (action === "complete") {
    return { ok: true, status: "completed", startDate: current.startDate, endDate: current.endDate };
  }
  if (action === "terminate") {
    const endDate = current.endDate && current.endDate < today ? current.endDate : today;
    return { ok: true, status: "terminated", startDate: current.startDate, endDate };
  }
  const newEnd = input.endDate ?? null;
  if (!newEnd) return { ok: false, error: "end_date_required" };
  if (action === "extend") {
    const floor = current.endDate ?? today;
    if (newEnd <= floor) return { ok: false, error: "extension_not_later" };
    return { ok: true, status: "active", startDate: current.startDate, endDate: newEnd };
  }
  // renew
  const dayAfterEnd = current.endDate ? addDays(current.endDate, 1) : today;
  const start = dayAfterEnd > today ? dayAfterEnd : today;
  if (newEnd <= start) return { ok: false, error: "end_before_start" };
  return { ok: true, status: "active", startDate: start, endDate: newEnd };
}

/* ---------------------------------------------------------------------------
 * Template application plan (#761 §16)
 * ------------------------------------------------------------------------- */

export const TEMPLATE_APPLY_MODES = ["merge", "replace"] as const;
export type TemplateApplyMode = (typeof TEMPLATE_APPLY_MODES)[number];

export interface TemplatePlan {
  addPhases: Array<{ name: string; displayOrder: number; startDate: string | null; endDate: string | null }>;
  addTasks: string[];
  /** Existing phases a `replace` removes — only empty ones, never a phase holding tasks. */
  removePhases: Array<{ id: string; name: string }>;
  /** Phases the template names that the project already has (left as they are). */
  keptPhases: string[];
}

/**
 * Pure: exactly what applying a template would do — the preview IS the plan
 * that runs, so what the member saw is what happens.
 *
 * - **merge** (default): add the template's phases and starter tasks the
 *   project does not already have (matched by name, case-insensitively).
 *   Applying the same template twice changes nothing.
 * - **replace**: merge, and also remove existing phases the template does not
 *   name — but only phases with no tasks. Tasks are never deleted, so a
 *   phase that holds work stays and is reported as kept.
 */
export function planTemplateApplication(input: {
  existingPhases: Array<{ id: string; name: string; displayOrder: number; taskCount: number }>;
  existingTaskTitles: string[];
  templatePhases: Array<{ name: string; displayOrder: number; startDate: string | null; endDate: string | null }>;
  defaultTasks: string[];
  mode: TemplateApplyMode;
}): TemplatePlan {
  const key = (text: string) => text.trim().toLowerCase();
  const templateNames = new Set(input.templatePhases.map((phase) => key(phase.name)));
  const removePhases =
    input.mode === "replace"
      ? input.existingPhases
          .filter((phase) => !templateNames.has(key(phase.name)) && phase.taskCount === 0)
          .map((phase) => ({ id: phase.id, name: phase.name }))
      : [];
  const removed = new Set(removePhases.map((phase) => phase.id));
  const remaining = input.existingPhases.filter((phase) => !removed.has(phase.id));
  const have = new Set(remaining.map((phase) => key(phase.name)));
  const offset = remaining.reduce((max, phase) => Math.max(max, phase.displayOrder + 1), 0);

  const addPhases: TemplatePlan["addPhases"] = [];
  const keptPhases: string[] = [];
  for (const phase of input.templatePhases) {
    if (have.has(key(phase.name))) {
      keptPhases.push(phase.name);
      continue;
    }
    have.add(key(phase.name));
    addPhases.push({ ...phase, displayOrder: offset + phase.displayOrder });
  }
  const haveTasks = new Set(input.existingTaskTitles.map(key));
  const addTasks: string[] = [];
  for (const raw of input.defaultTasks) {
    const title = raw.slice(0, WORKSPACE_LIMITS.taskTitleMax);
    if (!title.trim() || haveTasks.has(key(title))) continue;
    haveTasks.add(key(title));
    addTasks.push(title);
  }
  return { addPhases, addTasks, removePhases, keptPhases };
}
