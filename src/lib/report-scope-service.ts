/**
 * The database-touching half of the reporting scope decision (issue #819).
 *
 * `report-scope.ts` states the rule in the abstract; this resolves the two
 * facts it needs and hands every caller the same answer. Framework-free logic
 * lives there, the lookup lives here — the repo's usual split.
 *
 * The branch is resolved through `resolveActiveLocation`, which re-reads the
 * member's branch assignment and the business's branch list on every request
 * rather than trusting the session token: `user_locations` can change between
 * login and this request, and a report is exactly the kind of read where an
 * hour-old assignment must not still be in force.
 */
import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth-edge";
import { resolveActiveLocation, resolveActiveLocationForUser, type LocationRow } from "./setup-state";
import {
  decideReportScope,
  REPORT_SCOPE_DENIAL_MESSAGES,
  type ReportScopeDenial,
  type ReportScopeRequest,
} from "./report-scope";

/**
 * What a caller passes into the report engine after the scope is settled.
 *
 * A discriminated union rather than `{ mode; locationId?: string }` so that the
 * branch arm *has* a branch: `reportScopeLocationId` and every consumer narrow
 * on `mode`, and a settled scope cannot be constructed with a missing branch.
 * `undefined` only ever appears on the business-wide arm, which is reachable
 * only by asking for it and holding `reports.business_wide`.
 */
export type AuthorizedReportScope =
  | { mode: "branch"; locationId: string; location: LocationRow }
  | { mode: "business-wide"; locationId: undefined; location: null };

export type AuthorizedReportScopeResult =
  | { ok: true; scope: AuthorizedReportScope }
  | { ok: false; reason: ReportScopeDenial };

export type AuthorizedBranchReportScope = Extract<AuthorizedReportScope, { mode: "branch" }>;
export type AuthorizedBranchReportScopeResult =
  | { ok: true; scope: AuthorizedBranchReportScope }
  | { ok: false; reason: ReportScopeDenial };

/**
 * Resolves the ordinary branch-only scope used by reports with no consolidated
 * form (shift orders, cost drift, and custom report queries). One helper keeps
 * a no-location response identical across those routes.
 */
export async function authorizedReportBranchScope(
  session: SessionPayload,
): Promise<AuthorizedBranchReportScopeResult> {
  const result = await authorizedReportScope(session, {
    requested: "branch",
    authorizeBusinessWide: async () => false,
  });
  if (!result.ok) return result;
  if (result.scope.mode !== "branch") throw new Error("unexpected_business_wide_report_scope");
  return { ok: true, scope: result.scope };
}

/**
 * Resolves the scope a request may read, or refuses it.
 *
 * `authorizeBusinessWide` is called only when business-wide was actually asked
 * for, and it is the route's own `requirePermission(PERMISSIONS.reportsBusinessWide)`
 * — the same guard every other route uses, so the capability stays the single
 * authority rather than being restated as a role list here.
 */
export async function authorizedReportScope(
  session: SessionPayload,
  options: {
    requested?: ReportScopeRequest;
    authorizeBusinessWide: () => Promise<boolean>;
  },
): Promise<AuthorizedReportScopeResult> {
  const explicitlyBusinessWide = options.requested === "business-wide";
  // The elevated path does not depend on a branch assignment: an owner can
  // request the consolidated report even when there is no active branch. An
  // ordinary read, by contrast, must resolve a live assignment every time.
  const location = explicitlyBusinessWide ? null : await resolveActiveLocation(session);
  const hasBusinessWide = explicitlyBusinessWide ? await options.authorizeBusinessWide() : false;

  const decision = decideReportScope({
    requested: options.requested,
    hasBusinessWide,
    hasAccessibleBranch: location !== null,
  });
  if (!decision.ok) return decision;

  return {
    ok: true,
    scope:
      decision.mode === "business-wide"
        ? { mode: "business-wide", locationId: undefined, location: null }
        : { mode: "branch", locationId: location!.id, location: location! },
  };
}

/**
 * The same decision for a caller that has a member id rather than a session —
 * the AI's read tools, which receive `businessId` and the acting user and
 * nothing else.
 *
 * There is no "no actor" branch on purpose: without a member there is no branch
 * assignment to resolve, so the caller must refuse rather than fall through to
 * a business-wide read. `runReadTool` already refuses its reporting tools in
 * that case; this returns the refusal rather than throwing so the tool can say
 * so in a sentence.
 */
export async function authorizedReportScopeForUser(
  businessId: string,
  userId: string | undefined,
  options: {
    requested?: ReportScopeRequest;
    hasBusinessWide: boolean;
    /** MCP connections are bound to the branch the owner approved when issuing the token. */
    pinnedLocationId?: string;
  },
): Promise<AuthorizedReportScopeResult> {
  if (!userId) return { ok: false, reason: "no_accessible_branch" };

  const explicitlyBusinessWide = options.requested === "business-wide";
  const location = explicitlyBusinessWide
    ? null
    : await resolveActiveLocationForUser(businessId, userId, options.pinnedLocationId ?? null);
  // resolveActiveLocationForUser normally falls back to the member's default
  // accessible branch when a requested location is stale. That's right for a
  // live session, whose current branch may have changed, but not for a durable
  // MCP credential pinned to the branch its issuer approved: do not make that
  // token silently start reading a different branch if its assignment changes.
  const pinnedBranchIsAccessible =
    !options.pinnedLocationId || location?.id === options.pinnedLocationId;
  const decision = decideReportScope({
    requested: options.requested,
    hasBusinessWide: explicitlyBusinessWide && options.hasBusinessWide,
    hasAccessibleBranch: location !== null && pinnedBranchIsAccessible,
  });
  if (!decision.ok) return decision;

  return {
    ok: true,
    scope:
      decision.mode === "business-wide"
        ? { mode: "business-wide", locationId: undefined, location: null }
        : { mode: "branch", locationId: location!.id, location: location! },
  };
}

/**
 * The same refusal as a sentence, for callers that answer in prose rather than
 * in JSON — the assistant's tools, which must tell the member what happened
 * instead of returning an empty report.
 */
export function reportScopeDenialReasonText(reason: ReportScopeDenial): string {
  return REPORT_SCOPE_DENIAL_MESSAGES[reason];
}

/**
 * One refusal shape for every route — a 403 carrying both the machine-readable
 * reason and the Persian sentence the screen prints.
 *
 * 403 rather than 404/400: both reasons mean "you may not read that", and a
 * member told their branch assignment is gone needs to know that the request
 * was understood and refused rather than mistyped.
 */
export function reportScopeDenialResponse(reason: ReportScopeDenial): NextResponse {
  return NextResponse.json(
    { error: reason, message: REPORT_SCOPE_DENIAL_MESSAGES[reason] },
    { status: 403 },
  );
}
