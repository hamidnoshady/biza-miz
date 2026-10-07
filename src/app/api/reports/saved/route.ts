import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateReportConfig, type ReportConfig } from "@/lib/reports";
import { createSavedReport, ensureStandardSavedReports, listSavedReports } from "@/lib/reports-service";

/** Saved reports (standard + custom), for the "پیام‌های ذخیره‌شده" list and dashboard-widget picker. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  await ensureStandardSavedReports(session.businessId);
  const reports = await listSavedReports(session.businessId);
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

  let body: { name?: string; description?: string; config?: ReportConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!body.config) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const errors = validateReportConfig(body.config);
  if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });

  const description = typeof body.description === "string" ? body.description : null;
  const id = await createSavedReport(session.businessId, session.sub, name, body.config, description);
  return NextResponse.json({ ok: true, id });
});
