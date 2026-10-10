import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateReportConfigForIndustry, type ReportConfig } from "@/lib/reports";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { isUuid } from "@/lib/uuid";
import { deleteSavedReport, getSavedReport, updateSavedReport } from "@/lib/reports-service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const existing = await getSavedReport(session.businessId, id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (existing.is_standard) return NextResponse.json({ error: "cannot_edit_standard" }, { status: 400 });

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(parsed)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const body = parsed;
  const patch: { name?: string; description?: string | null; config?: ReportConfig } = {};

  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    patch.name = body.name.trim();
  }
  if (Object.hasOwn(body, "description")) {
    if (body.description !== null && typeof body.description !== "string") {
      return NextResponse.json({ error: "invalid_description" }, { status: 400 });
    }
    patch.description = typeof body.description === "string" ? body.description : null;
  }
  if (Object.hasOwn(body, "config")) {
    if (!isRecord(body.config)) {
      return NextResponse.json({ error: "invalid_config", details: ["پیکربندی گزارش نامعتبر است."] }, { status: 400 });
    }
    patch.config = body.config as unknown as ReportConfig;
    const industry = await getBusinessIndustry(session.businessId);
    const errors = validateReportConfigForIndustry(patch.config, industry);
    if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  const ok = await updateSavedReport(session.businessId, id, patch);
  if (!ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ ok: true });
});

/** Deleting a saved report — `reports.manage`, like the other mutations (issue #819). */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsManage);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const existing = await getSavedReport(session.businessId, id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (existing.is_standard) return NextResponse.json({ error: "cannot_delete_standard" }, { status: 400 });

  await deleteSavedReport(session.businessId, id);
  return NextResponse.json({ ok: true });
});
