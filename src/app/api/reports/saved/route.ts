import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  reportViewsFor,
  standardReportsFor,
  validateReportConfigForIndustry,
  type ReportConfig,
} from "@/lib/reports";
import { getBusinessIndustry } from "@/lib/industry-guard";
import {
  createSavedReport,
  ensureStandardSavedReports,
  listSavedReports,
  savedReportApplicability,
} from "@/lib/reports-service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Saved reports (standard + custom), for the "پیام‌های ذخیره‌شده" list and dashboard-widget picker. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  await ensureStandardSavedReports(session.businessId);
  const [industry, stored] = await Promise.all([
    getBusinessIndustry(session.businessId),
    listSavedReports(session.businessId),
  ]);
  const offeredStandardKeys = new Set(standardReportsFor(industry).map((report) => report.key));
  const offeredViewKeys = new Set(reportViewsFor(industry).map(({ key }) => key));
  // Historical standard rows stay in storage for layouts that reference them,
  // but a trade must not be offered another industry's seeded report. Custom
  // records remain visible and carry applicability metadata so an obsolete
  // config can be repaired/deleted without silently discarding it.
  const reports = stored
    .filter((report) => !report.is_standard || !report.standard_key || offeredStandardKeys.has(report.standard_key))
    .map((report) => ({
      ...report,
      ...savedReportApplicability(report, offeredStandardKeys, offeredViewKeys),
    }));
  return NextResponse.json({ reports });
});

/**
 * Saves a custom report built in the report builder.
 *
 * `reports.manage` — saving a report is an authoring act, not a download and
 * not a read (issue #819). It used to require `reports.export`, which meant the
 * only way to let somebody build reports was to also let them walk out with
 * every file the product can produce.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsManage);
  if (error) return error;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(parsed)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const body = parsed as { name?: unknown; description?: unknown; config?: unknown };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!isRecord(body.config)) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const config = body.config as unknown as ReportConfig;

  const industry = await getBusinessIndustry(session.businessId);
  const errors = validateReportConfigForIndustry(config, industry);
  if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });

  const description = typeof body.description === "string" ? body.description : null;
  const id = await createSavedReport(session.businessId, session.sub, name, config, description);
  return NextResponse.json({ ok: true, id });
});
