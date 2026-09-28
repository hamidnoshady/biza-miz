/**
 * The assistant's management sections, and where they live.
 *
 * The assistant is the dashboard itself: `/dashboard` is the chat home, and
 * the management surfaces that used to be a second application at `/ai/<section>`
 * — custom agents, the coworker's jobs and decision inbox, the automation
 * engine, the autopilot activity feed, the knowledge index and the usage/cost
 * report — open from the chat home in one panel. This module is the single
 * registry of those sections: what they are called, what `?aiPanel=` value
 * opens each, and who may open them.
 *
 * Framework-free by the same rule as `apps.ts` / `app-routes.ts` (no `next`,
 * no `db`, no JSX): the Edge middleware reads the section keys for the
 * `/dashboard/ai/<section>` compatibility redirects, the client panel reads
 * the labels and descriptions, and the unit tests read the whole thing — one
 * source of truth, so a section's name can never drift between the panel, the
 * redirects and the tests.
 *
 * Every section is a management surface, so every one is owner/manager — the
 * same rule the old `/ai` workspace applied. The whole assistant is
 * additionally behind the `ai_assistant` feature lock at the page level; this
 * module answers only "which role may open the panel", not "does the business
 * have AI".
 */

import { PERMISSIONS, type Permission } from "./permissions";

/** The query parameter that opens the assistant's management panel on `/dashboard`. */
export const AI_PANEL_PARAM = "aiPanel";

export const AI_PANEL_SECTION_KEYS = [
  "agents",
  "coworkers",
  "automations",
  "activity",
  "knowledge",
  "usage",
] as const;

export type AiPanelSectionKey = (typeof AI_PANEL_SECTION_KEYS)[number];

export interface AiPanelSection {
  key: AiPanelSectionKey;
  /** The section's name, as the panel and the legacy route both call it. */
  label: string;
  /** One line under the label — the panel's help text. */
  description: string;
  /** lucide-react icon name, resolved to a component by the client panel. */
  icon: AiPanelIconName;
}

/**
 * The icons the panel uses, named rather than imported so this module stays
 * framework-free (a `LucideIcon` import would pull React into a file the Edge
 * route helpers and unit tests read). The client panel maps these back to the
 * real components.
 */
export type AiPanelIconName =
  | "agents"
  | "coworkers"
  | "automations"
  | "activity"
  | "knowledge"
  | "usage";

/** The panel's sections, in menu order. */
export const AI_PANEL_SECTIONS: readonly AiPanelSection[] = [
  {
    key: "agents",
    label: "ایجنت‌ها",
    description: "دستیارهای سفارشی: نقش، ابزارها و اجازهٔ عملیات",
    icon: "agents",
  },
  {
    key: "coworkers",
    label: "همکاران هوشمند",
    description: "کارهای تکرارشونده که سپرده‌اید و صندوق تصمیم‌ها",
    icon: "coworkers",
  },
  {
    key: "automations",
    label: "اتوماسیون‌ها",
    description: "قاعده‌های «هر وقت… اگر… آنگاه…» کسب‌وکار",
    icon: "automations",
  },
  {
    key: "activity",
    label: "فعالیت خودکار",
    description: "آنچه دستیار خودکار انجام داده یا برای تأیید گذاشته",
    icon: "activity",
  },
  {
    key: "knowledge",
    label: "دانش دستیار",
    description: "آنچه دستیار می‌تواند از متن‌های کسب‌وکار به‌خاطر بیاورد",
    icon: "knowledge",
  },
  {
    key: "usage",
    label: "مصرف و هزینه",
    description: "هزینهٔ هوش مصنوعی: چقدر، کجا و با چه مدل خرج شده",
    icon: "usage",
  },
];

/** Look a section up by key. */
export function aiPanelSection(key: AiPanelSectionKey): AiPanelSection {
  const section = AI_PANEL_SECTIONS.find((item) => item.key === key);
  if (!section) throw new Error(`unknown AI panel section: ${key}`);
  return section;
}

/** Guard for values arriving from the URL: a `?aiPanel=` value or a legacy route suffix. */
export function isAiPanelSectionKey(value: unknown): value is AiPanelSectionKey {
  return (
    typeof value === "string" &&
    (AI_PANEL_SECTION_KEYS as readonly string[]).includes(value)
  );
}

/** The canonical, bookmarkable address of a panel section: the chat home with the panel open on it. */
export function aiPanelHref(key: AiPanelSectionKey): string {
  return `/dashboard?${AI_PANEL_PARAM}=${key}`;
}

/**
 * Whether a role may open the management panel. Every section is management
 * work — the same rule the old `/ai` workspace applied (owner or manager
 * only) — so a cashier or accountant never sees it. Kept as a function, not a
 * constant, so a future per-section rule has one place to live.
 */
/**
 * Capability-based management check. The role overload is retained only for
 * older non-request callers; request/page code must pass the membership's
 * effective permission set so custom roles and revocations cannot drift from
 * the API.
 */
export function canManageAi(
  effective: ReadonlySet<Permission> | readonly Permission[] | string,
  _key?: AiPanelSectionKey,
): boolean {
  if (typeof effective !== "string") {
    const permissions = effective instanceof Set ? effective : new Set(effective);
    return permissions.has(PERMISSIONS.aiManage);
  }
  return effective === "owner" || effective === "manager";
}
