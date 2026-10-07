import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { validateReportConfig, type ReportConfig } from "@/lib/reports";
import { runCustomReportQuery } from "@/lib/reports-service";

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
 * - **The caller's active branch** — Phase 14's isolation is application-level
 *   (DB row security stops at the business, not the branch), so the report
 *   engine must be handed the location explicitly. `resolveActiveLocation()`
 *   re-reads the member's branch assignment and the business's branch list on
 *   every request and answers with the branch they may actually act in: the
 *   session's active branch when it is still theirs, otherwise their default.
 *   A client-supplied location is never trusted — this route takes no location
 *   from the body at all.
 * - Business-wide (all-branches) numbers are not reachable from here: this
 *   route always scopes to one branch. The consolidated view is its own route
 *   behind its own capability (`reports.business_wide`).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  let config: ReportConfig;
  try {
    config = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const errors = validateReportConfig(config);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  const rows = await runCustomReportQuery(session.businessId, config, location?.id);
  return NextResponse.json({ rows });
});
