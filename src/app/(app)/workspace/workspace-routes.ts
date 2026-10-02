/**
 * Phase G — «میز کار من»: the module's route helpers and its section metadata.
 *
 * Framework-free (no `next`, no React) for the same reason every other
 * `*-routes.ts` is: the Edge middleware, the nav, the pages and the tests all
 * have to agree on one table, and a table that imports React cannot be read by
 * middleware.
 *
 * The href helpers live in `@/lib/app-routes` (they are part of the canonical
 * URL table); this file adds the per-section labels, descriptions, icons and
 * the permission each section needs.
 */
import {
  BriefcaseIcon,
  CalendarDaysIcon,
  CheckSquareIcon,
  ClipboardListIcon,
  FileSignatureIcon,
  FilesIcon,
  LayoutDashboardIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import {
  WORKSPACE_SECTIONS,
  WORKSPACE_SECTION_LABELS,
  isWorkspaceSection,
  type WorkspaceSection,
} from "@/lib/workspace-shared";
import { WORKSPACE_MODULE_HOME, workspaceSectionHref } from "@/lib/app-routes";

export { WORKSPACE_SECTIONS, isWorkspaceSection, type WorkspaceSection };

/**
 * Active-state rule for the contextual Workspace navigation.
 *
 * The root and `/workspace/overview` describe the same overview surface; every
 * other section owns its nested detail routes (for example a project keeps
 * «پروژه‌ها» current at `/workspace/projects/:id`).
 */
export function isWorkspaceSectionPathname(pathname: string, key: WorkspaceSection): boolean {
  if (key === "overview") {
    return pathname === WORKSPACE_MODULE_HOME || pathname === workspaceSectionHref("overview");
  }
  const href = workspaceSectionHref(key);
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface WorkspaceSectionMeta {
  key: WorkspaceSection;
  label: string;
  description: string;
  icon: LucideIcon;
  /** The platform permission that opens it. */
  permission: Permission;
}

/**
 * The ten sections. The `permission` column is what makes the rail honest: a
 * member without `workspace.contracts_manage` does not see a «قراردادها» entry
 * that 403s when clicked — though reading contracts only needs `workspace.view`,
 * so the entry is present for anyone who can open the module and the write
 * buttons inside it are what disappear.
 */
export const WORKSPACE_SECTION_META: Record<WorkspaceSection, WorkspaceSectionMeta> = {
  overview: {
    key: "overview",
    label: WORKSPACE_SECTION_LABELS.overview,
    description: "پروژه‌های فعال، وظایف امروز، تأییدهای در انتظار و مهلت‌های پیش‌رو",
    icon: LayoutDashboardIcon,
    permission: PERMISSIONS.workspaceView,
  },
  projects: {
    key: "projects",
    label: WORKSPACE_SECTION_LABELS.projects,
    description: "پروژه‌ها با مشتری، تیم، فاز، بودجه و زمان‌بندی",
    icon: BriefcaseIcon,
    permission: PERMISSIONS.workspaceView,
  },
  tasks: {
    key: "tasks",
    label: WORKSPACE_SECTION_LABELS.tasks,
    description: "فهرست، تختهٔ کانبان و نمای تقویمی وظایف",
    icon: CheckSquareIcon,
    permission: PERMISSIONS.workspaceView,
  },
  calendar: {
    key: "calendar",
    label: WORKSPACE_SECTION_LABELS.calendar,
    description: "مهلت پروژه‌ها و وظایف، جلسه‌ها، انقضای قرارداد و مهلت تأییدها",
    icon: CalendarDaysIcon,
    permission: PERMISSIONS.workspaceView,
  },
  documents: {
    key: "documents",
    label: WORKSPACE_SECTION_LABELS.documents,
    description: "اسناد پروژه، وظیفه، قرارداد و مشتری با نسخه و وضعیت تأیید",
    icon: FilesIcon,
    permission: PERMISSIONS.workspaceView,
  },
  contracts: {
    key: "contracts",
    label: WORKSPACE_SECTION_LABELS.contracts,
    description: "قراردادهای اجرایی: پیمانکار، تأمین‌کننده، مشاور و پیمانکار جزء",
    icon: FileSignatureIcon,
    permission: PERMISSIONS.workspaceView,
  },
  teams: {
    key: "teams",
    label: WORKSPACE_SECTION_LABELS.teams,
    description: "اعضای هر پروژه و نقش آن‌ها",
    icon: UsersIcon,
    permission: PERMISSIONS.workspaceView,
  },
  approvals: {
    key: "approvals",
    label: WORKSPACE_SECTION_LABELS.approvals,
    description: "درخواست‌های در انتظار تصمیم و تاریخچهٔ تأییدها",
    icon: ShieldCheckIcon,
    permission: PERMISSIONS.workspaceView,
  },
  reports: {
    key: "reports",
    label: WORKSPACE_SECTION_LABELS.reports,
    description: "سلامت و سودآوری پروژه‌ها بر پایهٔ اسناد حسابداری",
    icon: TrendingUpIcon,
    permission: PERMISSIONS.workspaceView,
  },
  templates: {
    key: "templates",
    label: WORKSPACE_SECTION_LABELS.templates,
    description: "قالب فازبندی برای هر نوع کسب‌وکار",
    icon: ClipboardListIcon,
    permission: PERMISSIONS.workspaceManage,
  },
};

/**
 * The contextual menu's groups. Ten flat entries are a wall; these headings
 * follow the Workspace information architecture, and every section appears in
 * exactly one.
 */
export const WORKSPACE_SECTION_GROUPS: ReadonlyArray<{
  label: string;
  keys: readonly WorkspaceSection[];
}> = [
  // #761: the daily loop first — Home, Projects, Tasks, Calendar — and the
  // rest behind «بیشتر», so the menu reads as how people work, not as a list
  // of database tables. On a phone the same two groups become the bottom
  // sheet's primary row and its overflow.
  { label: "کار روزانه", keys: ["overview", "projects", "tasks", "calendar"] },
  { label: "بیشتر", keys: ["documents", "contracts", "teams", "approvals", "reports", "templates"] },
];

/** The sections a member with this permission set may open, in rail order. */
export function visibleWorkspaceSections(
  permissions: ReadonlySet<string> | ReadonlyArray<string>,
): WorkspaceSectionMeta[] {
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  return WORKSPACE_SECTIONS.map((key) => WORKSPACE_SECTION_META[key]).filter((section) =>
    held.has(section.permission),
  );
}

/** May this member open the workspace at all? */
export function canOpenWorkspace(
  permissions: ReadonlySet<string> | ReadonlyArray<string>,
): boolean {
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  return held.has(PERMISSIONS.workspaceView);
}

/**
 * «+ ایجاد» — the contextual create actions (#761 §5), shared by the command
 * bar menu and the Ctrl/Cmd+K palette. Each lands on its section with
 * `?create=1` (the section opens its own create dialog) and, inside a
 * project, `&project=<id>` so the dialog preselects that project. Filtered by
 * the platform permission; the project role is re-checked by the API.
 */
export interface WorkspaceCreateAction {
  key: "project" | "task" | "event" | "document" | "contract" | "member";
  label: string;
  href: string;
}

export function workspaceCreateActions(
  permissions: ReadonlySet<string> | ReadonlyArray<string>,
  projectId?: string,
): WorkspaceCreateAction[] {
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  const href = (section: WorkspaceSection) =>
    `${workspaceSectionHref(section)}?create=1${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`;
  const actions: Array<WorkspaceCreateAction & { permission: string; outsideProjectOnly?: boolean }> = [
    { key: "project", label: "پروژهٔ جدید", href: href("projects"), permission: "workspace.manage", outsideProjectOnly: true },
    { key: "task", label: "وظیفهٔ جدید", href: href("tasks"), permission: "workspace.manage" },
    { key: "event", label: "رویداد جدید", href: href("calendar"), permission: "workspace.manage" },
    { key: "document", label: "افزودن سند", href: href("documents"), permission: "workspace.manage" },
    { key: "contract", label: "قرارداد جدید", href: href("contracts"), permission: "workspace.contracts_manage" },
    { key: "member", label: "افزودن عضو تیم", href: href("teams"), permission: "workspace.manage" },
  ];
  return actions
    .filter((action) => held.has(action.permission) && !(projectId && action.outsideProjectOnly))
    .map(({ key, label, href: target }) => ({ key, label, href: target }));
}
