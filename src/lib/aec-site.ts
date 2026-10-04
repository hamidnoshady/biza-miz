/**
 * Issue #799 §13 and §14 — site execution, as a pure catalogue.
 *
 * §13 asks for a daily site log with a fixed set of things a day contains —
 * who was on site, what plant ran, what was delivered, what went wrong, who
 * visited — and §14 asks for one *issue register* that carries inspections,
 * NCRs, corrective actions, punch items, HSE observations and the handover
 * checklist. Both are modelled here rather than inside the service, for the
 * reason every other AEC module gives: the screen, the API and the database
 * trigger must agree about what a status means, and the only way to be sure they
 * do is for one file to own the vocabulary.
 *
 * ## One register, seven kinds — and why that is not a compromise
 *
 * §14 lists nine artifacts and then states the fields **once**: "Each issue
 * should support: project/location, category, severity, responsible party,
 * raised by, assigned to, due date, photos, evidence, status, closeout
 * verification, approval, activity history". Nine tables with that same column
 * list would be nine migrations of duplication and nine places for "closed" to
 * mean something slightly different. So an inspection, an NCR and a snag are one
 * row with a `kind`, and the three things that genuinely differ are modelled
 * explicitly:
 *
 *   * an **inspection** or a **handover** carries a `result` (pass / pass with
 *     comments / fail) — `issueNeedsResult` says so, and the service and the
 *     trigger both require one before the issue can be resolved;
 *   * an **inspection** or a **handover** carries a checklist — the item lines
 *     snapshot the firm's checklist so editing the template later cannot rewrite
 *     what was actually checked (`issueSupportsChecks`);
 *   * a **snag** and an **HSE observation** are the two kinds whose switch is
 *     their own capability (`snagging`, `hse`), which is how §14's "HSE
 *     observations/incidents where enabled" is honoured without a second
 *     register.
 *
 * The lifecycle is one chain for all seven — open → in progress → resolved →
 * closed, with cancelled available until somebody has started — because that is
 * what actually happens to each of them: a snag is raised, somebody fixes it,
 * and a second person verifies the fix. `resolved → in progress` is the
 * deliberate loop: a verification that fails sends the issue back to work rather
 * than closing it, which is the difference between a snag list and a wish list.
 */

import type { AecCapabilityKey } from "./aec";

/* ===========================================================================
 * §13 — the daily site log
 * ======================================================================== */

export const SITE_LOG_STATUSES = ["draft", "submitted"] as const;
export type SiteLogStatus = (typeof SITE_LOG_STATUSES)[number];

export const SITE_LOG_STATUS_LABELS: Record<SiteLogStatus, string> = {
  draft: "پیش‌نویس",
  submitted: "ثبت‌شده",
};

export function isSiteLogStatus(value: string): value is SiteLogStatus {
  return (SITE_LOG_STATUSES as readonly string[]).includes(value);
}

/**
 * A day's log is a draft until its author signs it off, and it may be reopened
 * while the site is still working that week — unlike a drawing or a variant,
 * §33 does not ask for a site log to be immutable, and pretending a typo in
 * yesterday's weather is a permanent record would only teach people to keep the
 * real log in a notebook.
 */
export const SITE_LOG_TRANSITIONS: Record<SiteLogStatus, readonly SiteLogStatus[]> = {
  draft: ["submitted"],
  submitted: ["draft"],
};

export function canTransitionSiteLog(from: string, to: string): boolean {
  return (SITE_LOG_TRANSITIONS[from as SiteLogStatus] ?? []).includes(to as SiteLogStatus);
}

/**
 * Content is editable only while the log is a draft. Submission freezes the day
 * (migration 0199's trigger enforces it, lines included) — so the screen and the
 * API say no before the database has to.
 */
export function isEditableSiteLog(status: string): boolean {
  return status === "draft";
}

/**
 * The seven lines a day can carry, in §13's own order: attendance, equipment,
 * materials delivered, delays, incidents, instructions, visitors.
 */
export const SITE_LOG_LINE_KINDS = [
  "attendance",
  "equipment",
  "material",
  "delay",
  "incident",
  "instruction",
  "visitor",
] as const;
export type SiteLogLineKind = (typeof SITE_LOG_LINE_KINDS)[number];

export const SITE_LOG_LINE_LABELS: Record<SiteLogLineKind, string> = {
  attendance: "عوامل و اکیپ‌ها",
  equipment: "ماشین‌آلات و تجهیزات",
  material: "مصالح رسیده",
  delay: "تأخیر و توقف",
  incident: "رخداد و ایمنی",
  instruction: "دستورکار",
  visitor: "بازدیدکننده",
};

export function isSiteLogLineKind(value: string): value is SiteLogLineKind {
  return (SITE_LOG_LINE_KINDS as readonly string[]).includes(value);
}

/**
 * Which inputs a line of each kind actually has. The service and the panel both
 * read this, so a material line cannot be saved without a quantity and an
 * attendance line cannot be saved without a headcount — the migration's CHECK is
 * the same shape, written once in SQL.
 */
export interface SiteLogLineShape {
  quantity: boolean;
  unit: boolean;
  headcount: boolean;
  hours: boolean;
  party: boolean;
}

export const SITE_LOG_LINE_SHAPES: Record<SiteLogLineKind, SiteLogLineShape> = {
  attendance: { quantity: false, unit: false, headcount: true, hours: true, party: true },
  equipment: { quantity: true, unit: true, headcount: false, hours: true, party: true },
  material: { quantity: true, unit: true, headcount: false, hours: false, party: true },
  delay: { quantity: false, unit: false, headcount: false, hours: true, party: true },
  incident: { quantity: false, unit: false, headcount: false, hours: false, party: true },
  instruction: { quantity: false, unit: false, headcount: false, hours: false, party: true },
  visitor: { quantity: false, unit: false, headcount: false, hours: false, party: false },
};

/* ===========================================================================
 * §14 — the issue register
 * ======================================================================== */

export const SITE_ISSUE_KINDS = [
  "inspection_request",
  "inspection",
  "ncr",
  "corrective_action",
  "snag",
  "hse_observation",
  "handover",
] as const;
export type SiteIssueKind = (typeof SITE_ISSUE_KINDS)[number];

export const SITE_ISSUE_KIND_LABELS: Record<SiteIssueKind, string> = {
  inspection_request: "درخواست بازرسی",
  inspection: "بازرسی کیفیت",
  ncr: "عدم انطباق (NCR)",
  corrective_action: "اقدام اصلاحی",
  snag: "نقص (پانچ)",
  hse_observation: "مشاهدهٔ ایمنی (HSE)",
  handover: "تحویل و تحویل‌گیری",
};

export function isSiteIssueKind(value: string): value is SiteIssueKind {
  return (SITE_ISSUE_KINDS as readonly string[]).includes(value);
}

/**
 * The capability a kind needs on top of `qa_qc`. §14 gates all seven behind the
 * quality register, and two of them behind a switch of their own: «where
 * enabled» is why `hse` exists, and a punch list is a deliverable a firm
 * legitimately does not keep (a small designer hands over without one).
 */
export function siteIssueKindCapability(kind: SiteIssueKind): AecCapabilityKey {
  if (kind === "snag") return "snagging";
  if (kind === "hse_observation") return "hse";
  return "qa_qc";
}

/**
 * The prefix of a generated issue number: «SNG-004». Per kind, because a punch
 * list and an NCR queue are referred to separately on site — and unique per
 * project, which the service generates under a project-scoped advisory lock.
 */
export const SITE_ISSUE_NUMBER_PREFIXES: Record<SiteIssueKind, string> = {
  inspection_request: "IR",
  inspection: "INS",
  ncr: "NCR",
  corrective_action: "CA",
  snag: "SNG",
  hse_observation: "HSE",
  handover: "HO",
};

export function siteIssueNumberPrefix(kind: SiteIssueKind): string {
  return SITE_ISSUE_NUMBER_PREFIXES[kind];
}

/** The kinds whose lifecycle ends in a *result* rather than only a fix. */
export function issueNeedsResult(kind: string): boolean {
  return kind === "inspection" || kind === "handover";
}

/** The kinds a checklist belongs to — §14's inspection and handover checklists. */
export function issueSupportsChecks(kind: string): boolean {
  return kind === "inspection" || kind === "handover";
}

export const SITE_ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type SiteIssueSeverity = (typeof SITE_ISSUE_SEVERITIES)[number];

export const SITE_ISSUE_SEVERITY_LABELS: Record<SiteIssueSeverity, string> = {
  low: "کم",
  medium: "متوسط",
  high: "زیاد",
  critical: "بحرانی",
};

export function isSiteIssueSeverity(value: string): value is SiteIssueSeverity {
  return (SITE_ISSUE_SEVERITIES as readonly string[]).includes(value);
}

/**
 * §14's "category". A catalogued list rather than free text, for the same
 * reason the drawing register catalogues its document types: the value is read
 * by a filter, a KPI row and the assistant, and three spellings of «تأسیسات»
 * would be three categories. `other` is the honest escape hatch.
 */
export const SITE_ISSUE_CATEGORIES = [
  "structural",
  "architectural",
  "mep",
  "finishing",
  "civil_site",
  "safety",
  "documentation",
  "other",
] as const;
export type SiteIssueCategory = (typeof SITE_ISSUE_CATEGORIES)[number];

export const SITE_ISSUE_CATEGORY_LABELS: Record<SiteIssueCategory, string> = {
  structural: "سازه",
  architectural: "معماری",
  mep: "تأسیسات مکانیکی و برقی",
  finishing: "نازک‌کاری و نما",
  civil_site: "محوطه و عملیات عمرانی",
  safety: "ایمنی و بهداشت",
  documentation: "مدارک و نقشه",
  other: "سایر",
};

export function isSiteIssueCategory(value: string): value is SiteIssueCategory {
  return (SITE_ISSUE_CATEGORIES as readonly string[]).includes(value);
}

export const SITE_ISSUE_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type SiteIssueStatus = (typeof SITE_ISSUE_STATUSES)[number];

export const SITE_ISSUE_STATUS_LABELS: Record<SiteIssueStatus, string> = {
  open: "باز",
  in_progress: "در دست اقدام",
  resolved: "اصلاح‌شده (در انتظار تأیید)",
  closed: "بسته",
  cancelled: "لغو‌شده",
};

export function isSiteIssueStatus(value: string): value is SiteIssueStatus {
  return (SITE_ISSUE_STATUSES as readonly string[]).includes(value);
}

/**
 * `resolved → in_progress` is the loop a failed verification takes: the issue
 * is not closed, and the next attempt is the same record — not a new NCR, which
 * is what makes the closeout history readable.
 */
export const SITE_ISSUE_TRANSITIONS: Record<SiteIssueStatus, readonly SiteIssueStatus[]> = {
  open: ["in_progress", "resolved", "cancelled"],
  in_progress: ["resolved", "cancelled"],
  resolved: ["closed", "in_progress"],
  closed: [],
  cancelled: [],
};

export function canTransitionSiteIssue(from: string, to: string): boolean {
  return (SITE_ISSUE_TRANSITIONS[from as SiteIssueStatus] ?? []).includes(to as SiteIssueStatus);
}

/** Any move of §14's register is an act on a live issue, never on a closed one. */
export function isEditableSiteIssue(status: string): boolean {
  return status !== "closed" && status !== "cancelled";
}

/** What the queue reads: everything nobody has finished yet. */
export function isOpenSiteIssue(status: string): boolean {
  return status === "open" || status === "in_progress" || status === "resolved";
}

/**
 * Late means "not finished and past its date" — `resolved` counts, because an
 * issue awaiting verification is exactly the one a manager wants chased. Closed
 * and cancelled do not, which is the whole point of closing them.
 */
export function isSiteIssueOverdue(
  issue: { status: string; dueDate?: string | null },
  today: string,
): boolean {
  if (!issue.dueDate) return false;
  if (!isOpenSiteIssue(issue.status)) return false;
  return issue.dueDate < today;
}

export const SITE_ISSUE_RESULTS = ["pass", "pass_with_comments", "fail"] as const;
export type SiteIssueResult = (typeof SITE_ISSUE_RESULTS)[number];

export const SITE_ISSUE_RESULT_LABELS: Record<SiteIssueResult, string> = {
  pass: "قبول",
  pass_with_comments: "قبول با تذکر",
  fail: "رد",
};

export function isSiteIssueResult(value: string): value is SiteIssueResult {
  return (SITE_ISSUE_RESULTS as readonly string[]).includes(value);
}

/** The seven moves the register's API offers, grouped by the act they are. */
export const SITE_ISSUE_ACTIONS = ["start", "resolve", "close", "cancel"] as const;
export type SiteIssueAction = (typeof SITE_ISSUE_ACTIONS)[number];

export function isSiteIssueAction(value: string): value is SiteIssueAction {
  return (SITE_ISSUE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Closing is the one act that is a *decision* rather than site work: it accepts
 * somebody else's fix and §14 calls it "closeout verification". It therefore
 * runs on `workspace.approve`, like issuing a transmittal and deciding a
 * submittal, while raising, starting, resolving and cancelling are the project
 * work `workspace.manage` already covers.
 */
export function siteIssueActionNeedsApproval(action: SiteIssueAction): boolean {
  return action === "close";
}

/* ===========================================================================
 * Checklists (§14) and their results
 * ======================================================================== */

export const SITE_CHECKLIST_KINDS = ["inspection", "handover"] as const;
export type SiteChecklistKind = (typeof SITE_CHECKLIST_KINDS)[number];

export const SITE_CHECKLIST_KIND_LABELS: Record<SiteChecklistKind, string> = {
  inspection: "چک‌لیست بازرسی",
  handover: "چک‌لیست تحویل",
};

export function isSiteChecklistKind(value: string): value is SiteChecklistKind {
  return (SITE_CHECKLIST_KINDS as readonly string[]).includes(value);
}

export const SITE_CHECK_RESULTS = ["pending", "pass", "fail", "na"] as const;
export type SiteCheckResult = (typeof SITE_CHECK_RESULTS)[number];

export const SITE_CHECK_RESULT_LABELS: Record<SiteCheckResult, string> = {
  pending: "بررسی‌نشده",
  pass: "قبول",
  fail: "مردود",
  na: "نامرتبط",
};

export function isSiteCheckResult(value: string): value is SiteCheckResult {
  return (SITE_CHECK_RESULTS as readonly string[]).includes(value);
}

export interface SiteCheckSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  notApplicable: number;
  /** True when nothing is left un-answered — the checklist can be signed. */
  complete: boolean;
}

/**
 * What a checklist currently says. The panel's badge, the service's refusal to
 * resolve an inspection with items outstanding, and the assistant all read this
 * one function, so "the checklist is complete" cannot mean three things.
 */
export function summariseSiteChecks(
  checks: ReadonlyArray<{ result: string }>,
): SiteCheckSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let notApplicable = 0;
  for (const check of checks) {
    if (check.result === "pass") passed += 1;
    else if (check.result === "fail") failed += 1;
    else if (check.result === "na") notApplicable += 1;
    else pending += 1;
  }
  return {
    total: checks.length,
    passed,
    failed,
    pending,
    notApplicable,
    complete: checks.length > 0 && pending === 0,
  };
}

/* ===========================================================================
 * The daily-log roll-up the KPI row and the diary show
 * ======================================================================== */

export interface SiteLogSummary {
  workforce: number;
  crews: number;
  equipment: number;
  deliveries: number;
  delays: number;
  incidents: number;
  instructions: number;
  visitors: number;
}

/**
 * A day's numbers, counted from its lines rather than typed on the header —
 * which is why the header carries no totals of its own: a workforce count that
 * disagrees with the attendance lines is worse than no count.
 */
export function summariseSiteLogLines(
  lines: ReadonlyArray<{ kind: string; headcount?: number | null }>,
): SiteLogSummary {
  const summary: SiteLogSummary = {
    workforce: 0,
    crews: 0,
    equipment: 0,
    deliveries: 0,
    delays: 0,
    incidents: 0,
    instructions: 0,
    visitors: 0,
  };
  for (const line of lines) {
    if (line.kind === "attendance") {
      summary.crews += 1;
      summary.workforce += Math.max(0, Number(line.headcount) || 0);
    } else if (line.kind === "equipment") summary.equipment += 1;
    else if (line.kind === "material") summary.deliveries += 1;
    else if (line.kind === "delay") summary.delays += 1;
    else if (line.kind === "incident") summary.incidents += 1;
    else if (line.kind === "instruction") summary.instructions += 1;
    else if (line.kind === "visitor") summary.visitors += 1;
  }
  return summary;
}
