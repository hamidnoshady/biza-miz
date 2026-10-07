import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateReportConfig, type ReportConfig } from "@/lib/reports";
import { deleteSavedReport, getSavedReport, updateSavedReport } from "@/lib/reports-service";

/**
 * Renames or edits a custom saved report's config. Standard (seeded) reports
 * can't be edited — copy them into a new custom report instead.
 *
 * `reports.manage` (issue #819): renaming or re-configuring a saved report is
 * authoring, the same act as creating one. `reports.export` gates the file
 * download, not the record.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsManage);
  if (error) return error;
  const { id } = await context.params;

  const existing = await getSavedReport(session.businessId, id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (existing.is_standard) return NextResponse.json({ error: "cannot_edit_standard" }, { status: 400 });

  let body: { name?: string; config?: ReportConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.config) {
    const errors = validateReportConfig(body.config);
    if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  const ok = await updateSavedReport(session.businessId, id, {
    name: body.name?.trim(),
    config: body.config,
  });
  if (!ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ ok: true });
});

/** Deleting a saved report — `reports.manage`, like the other mutations (issue #819). */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsManage);
  if (error) return error;
  const { id } = await context.params;

  const existing = await getSavedReport(session.businessId, id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (existing.is_standard) return NextResponse.json({ error: "cannot_delete_standard" }, { status: 400 });

  await deleteSavedReport(session.businessId, id);
  return NextResponse.json({ ok: true });
});
