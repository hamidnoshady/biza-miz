import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { validateReportConfigForIndustry, type ReportConfig } from "@/lib/reports";
import { runCustomReportQuery } from "@/lib/reports-service";
import { authorizedReportScope, reportScopeDenialResponse } from "@/lib/report-scope-service";

/**
 * Runs an ad-hoc custom report config — the report builder's preview, the
 * dashboard widget's data read, and any other direct run of a `ReportConfig`.
 *
 * ## Authorization (issue #819)
 *
 * - `reports.view` — running a report is a read. This route used to require
 *   `reports.export`, so a member with the read capability (and every preset
 *   that grants it without the download key) could not preview or run a report
 *   at all, while `reports.export`'s own doc described it as the file
 *   download. Export is a separate act and is enforced on the export route.
 * - **An authorized branch, always.** Phase 14's isolation is
 *   application-level (DB row security stops at the business, not the branch),
 *   so the report engine must be handed a location explicitly —
 *   `buildReportQuery` adds a branch predicate only when it is given one, so
 *   "no location" reads every branch. The branch comes from
 *   `resolveActiveLocation()`, which re-reads the member's assignment and the
 *   business's branch list on every request; a client-supplied location is
 *   never read (this route takes no location from the body at all).
 * - **A member with no branch is refused, not widened.** An earlier version
 *   passed `location?.id` and let `undefined` through, which meant a revoked
 *   assignment silently turned a branch report into a business-wide one. The
 *   refusal is `no_accessible_branch` (403) and it comes from the one shared
 *   scope policy (`report-scope.ts`).
 * - Business-wide numbers are **not** reachable from here. A custom report is
 *   a dimension/metric aggregation over one branch's trading, so there is no
 *   consolidated form of it to ask for; the consolidated surface is its own
 *   route behind its own capability (`reports.business_wide`).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ error: "invalid_config", details: ["پیکربندی گزارش نامعتبر است."] }, { status: 400 });
  }
  const config = parsed as ReportConfig;

  const industry = await getBusinessIndustry(session.businessId);
  const errors = validateReportConfigForIndustry(config, industry);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  // A `scope` on the body is refused rather than ignored. It is not part of a
  // `ReportConfig`, and a caller that sends `"business-wide"` is asking for
  // something this route cannot serve — answering with one branch's rows would
  // look like success. `"branch"` is accepted because it restates the default.
  const requestedScope = (config as { scope?: unknown }).scope;
  if (requestedScope === "business-wide") {
    return NextResponse.json(
      { error: "scope_not_supported", message: "گزارش سفارشی فقط برای یک شعبه اجرا می‌شود." },
      { status: 400 },
    );
  }
  if (requestedScope !== undefined && requestedScope !== "branch") {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }

  const resolved = await authorizedReportScope(session, {
    authorizeBusinessWide: async () => {
      const { error: wideError } = await requirePermission(PERMISSIONS.reportsBusinessWide);
      return !wideError;
    },
  });
  if (!resolved.ok) return reportScopeDenialResponse(resolved.reason);

  const rows = await runCustomReportQuery(session.businessId, config, resolved.scope);
  return NextResponse.json({ rows });
});
