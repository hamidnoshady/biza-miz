/**
 * The reporting *scope* contract (issue #819) — one place that decides which
 * rows a report is allowed to read, and the only place that answers "may this
 * request read every branch?".
 *
 * ## What this file governs, and what it deliberately does not
 *
 * Two families of reads exist in this codebase and they have different natural
 * scopes:
 *
 *  - **Reporting** (`reports.*`, the routes under `/api/reports/*`, the
 *    assistant's report tools, dashboard widgets) reads *one branch's trading*:
 *    orders, shifts, item sales, and the branch's slice of the ledger. Every
 *    function in this file exists for those.
 *  - **Accounting** (`ledger.*`: the journal, the chart of accounts, fiscal
 *    periods, the trial balance, the account statement) reads the business's
 *    *books*, which are business-level in this product — one chart of accounts
 *    per business, one journal, no per-branch ledgers. The trial balance is
 *    documented and presented as «دفتر تجمیعی همهٔ شعب» and is gated by
 *    `ledger.view`, an accounting authority rather than a reporting one.
 *
 * So a branch-scoped manager is refused the consolidated *report* (this file)
 * while an accountant holding `ledger.view` still reads the business ledger —
 * that is the intended line, not a gap. What the audit fixed is the reporting
 * side pretending to be accounting: consolidated standard reports were served
 * business-wide through `reports.view` without a separate scope grant.
 *
 * ## Why this file exists
 *
 * Phase 14 makes branch isolation an application concern: row-level security
 * stops at the business, so a report is only branch-correct because the caller
 * passed a branch into the engine. `buildReportQuery` and
 * `runStandardReportRows` both express that as `if (locationId)` — they add a
 * predicate *when they are given one*. That is the right shape for a service
 * (a pure query builder must not invent authorization), but it means the
 * absence of a branch silently widens the query to every branch in the
 * business. Every caller therefore had its own idea of when that absence was
 * acceptable:
 *
 *   - `/api/reports/standard/[key]` skipped the branch on purpose for its
 *     consolidated standard reports, through a local `LEDGER_WIDE_REPORTS` list.
 *   - `/api/reports/export` resolved a branch for the chart and shift kinds and
 *     passed nothing for P&L, the balance sheet and the cash flow.
 *   - The AI's `run_report` tool passed no branch at all, for any report.
 *   - The API-key route (`/api/v1/reports/standard/[key]`) scoped those same
 *     reports to the key's branch — so two front doors into one report
 *     disagreed about whose numbers they were.
 *
 * A missing branch is not a statement about authorization; it is a missing
 * decision. So the decision is made here, once:
 *
 *   - **branch** — the ordinary scope. Every report read is one branch's
 *     trading, and the branch is resolved from the member's own assignment
 *     (`resolveActiveLocation`), never from the request.
 *   - **business-wide** — every branch at once, for explicitly consolidated
 *     standard reports. It exists as its own scope because the product genuinely has
 *     one (the branch-comparison screen), and it requires its own capability:
 *     `reports.business_wide`. It is never what you get by *forgetting* to ask
 *     for a branch.
 *
 * Framework-free and pure — unit-tested in `report-scope.test.ts` — so the
 * routes, the services and the assistant's tools all read one answer. The
 * database-touching half lives in `report-scope-service.ts`, per the repo
 * convention that framework-free decision logic and its data lookup are
 * separate files.
 */
import { PERMISSIONS, type Permission } from "./permissions";

/** Which rows a report read covers. */
export type ReportScopeMode = "branch" | "business-wide";

/**
 * The scope as the report engine takes it — a *value*, not an optional
 * `locationId`.
 *
 * This is the shape that removes the bypass at the type level: the engine's
 * entry points (`buildReportQuery`, `runCustomReportQuery`,
 * `runStandardReportRows`, `runStandardReport`) require one of these, so
 * "I forgot to resolve a branch" stops being a silent widening to every branch
 * and becomes a compile error. `business-wide` has to be written down, which
 * means it also has to have been authorized by whoever held the capability.
 */
export type ReportScope =
  | { mode: "branch"; locationId: string }
  | { mode: "business-wide" };

/** A branch scope, for callers that already hold a verified branch id. */
export function branchScope(locationId: string): ReportScope {
  return { mode: "branch", locationId };
}

/** The consolidated scope. Only ever constructed after `reports.business_wide` passed. */
export const BUSINESS_WIDE_SCOPE: ReportScope = { mode: "business-wide" };

/**
 * The branch id the engine should filter on, or `undefined` for the
 * consolidated scope — the one place a missing branch id is a *decision*
 * rather than an omission.
 *
 * Also the runtime backstop: a caller that reaches the engine with no scope at
 * all (a route that read one off the wire, a `as never` cast, JavaScript) gets
 * a loud failure instead of the old silent widening to every branch. This used
 * to be the *whole* bug — `if (locationId)` compiled and ran perfectly happily
 * when nobody had resolved one.
 */
export function reportScopeLocationId(scope: ReportScope): string | undefined {
  if (!scope || (scope.mode !== "branch" && scope.mode !== "business-wide")) {
    throw new Error("missing_report_scope");
  }
  if (scope.mode === "branch") {
    // TypeScript callers cannot omit the id, but runtime callers, old compiled
    // clients and `as never` casts still can. A malformed branch is not a
    // business-wide request: refuse before an `if (locationId)` can erase it.
    if (typeof scope.locationId !== "string" || scope.locationId.trim() === "") {
      throw new Error("missing_report_scope");
    }
    return scope.locationId;
  }
  return undefined;
}

/** The scope a request asked for. Absent means `"branch"` — the safe default. */
export type ReportScopeRequest = ReportScopeMode | undefined;

/** The capability that turns a business-wide *request* into an authorized one. */
export const BUSINESS_WIDE_PERMISSION: Permission = PERMISSIONS.reportsBusinessWide;

/** Why a scope could not be granted. Both answer 403: the member may not read that. */
export type ReportScopeDenial =
  /**
   * The member has no branch they may report on — an assignment was revoked, the
   * only branch they were scoped to was deactivated, or the business has no
   * active branch at all. Refused rather than widened: "no branch" must never
   * mean "every branch".
   */
  | "no_accessible_branch"
  /** `business-wide` was asked for and `reports.business_wide` is not held. */
  | "business_wide_forbidden";

export type ReportScopeDecision =
  | { ok: true; mode: ReportScopeMode }
  | { ok: false; reason: ReportScopeDenial };

/**
 * The decision itself, as a function of facts already looked up.
 *
 * Kept apart from the lookup so the rule can be stated and tested without a
 * database: a business-wide request needs the capability; a branch request
 * needs a branch. Nothing else grants anything, and no combination of missing
 * inputs produces business-wide.
 */
export function decideReportScope(input: {
  requested: ReportScopeRequest;
  /** Whether the caller holds `reports.business_wide`. */
  hasBusinessWide: boolean;
  /** Whether a branch could be resolved for this member. */
  hasAccessibleBranch: boolean;
}): ReportScopeDecision {
  if (input.requested === "business-wide") {
    return input.hasBusinessWide ? { ok: true, mode: "business-wide" } : { ok: false, reason: "business_wide_forbidden" };
  }
  return input.hasAccessibleBranch ? { ok: true, mode: "branch" } : { ok: false, reason: "no_accessible_branch" };
}
/**
 * The narrow set of standard reports with a meaningful consolidated form:
 * three business-ledger statements and food-cost variance, which aggregates
 * item-level theoretical costs with business-wide COGS and waste totals.
 *
 * A business-wide *row dump* is the exact leak the audit found: every branch's
 * orders, one row each. Reports whose rows *are* one branch's trading (a shop's
 * daily sales, a cashier's shifts, a trade report) stay branch-only even for a
 * member holding the capability: "all branches" for those means running the
 * report once per branch, which the branch-comparison screen already does
 * deliberately. This list is not authorization; callers still require
 * `reports.business_wide` when the scope is requested.
 */
export const CONSOLIDATED_STANDARD_REPORTS: readonly string[] = [
  "profit_and_loss",
  "balance_sheet",
  "cash_flow",
  "food_cost_variance",
];

export function isConsolidatedStandardReport(key: string): boolean {
  return CONSOLIDATED_STANDARD_REPORTS.includes(key);
}

/**
 * The scope parameter, as a request carries it.
 *
 * `?scope=business-wide` on the standard/export routes and the assistant's own
 * `scope` argument are the same word on purpose, so an integration switching
 * from one front door to the other keeps meaning the same thing.
 *
 * Returns `null` when a value was supplied that is not a scope this API serves
 * — the caller answers 400 rather than quietly treating `?scope=everything` as
 * the default, which is how a typo would otherwise become a silent downgrade
 * (safe, but a lie about what was asked for).
 */
export function parseReportScope(value: string | null | undefined): ReportScopeRequest | null {
  if (value === null || value === undefined || value === "") return undefined;
  if (value === "branch") return "branch";
  if (value === "business-wide") return "business-wide";
  return null;
}

/**
 * The message a refusal shows. Persian, because every caller that reaches this
 * is a screen; the machine-readable `reason` travels beside it in the body.
 */
export const REPORT_SCOPE_DENIAL_MESSAGES: Record<ReportScopeDenial, string> = {
  no_accessible_branch:
    "به شما هیچ شعبه‌ای برای گزارش‌گیری تخصیص داده نشده است. برای دیدن گزارش‌ها، از مدیر کسب‌وکار بخواهید شعبهٔ خود را به شما اختصاص دهد.",
  business_wide_forbidden: "دسترسی به گزارش‌های تجمیعی همهٔ شعب برای شما فعال نیست.",
};
