import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { financialReportAccess } from "@/lib/financial-report-access";
import { PERMISSIONS } from "@/lib/permissions";
import { readBoundedJson } from "@/lib/product-attributes";
import { previewStatementMatches, ReconciliationError } from "@/lib/reconciliation-service";
import { MAX_STATEMENT_IMPORT_BYTES, parseStatementImport } from "@/lib/reconciliation-statement-import";

/** Manual CSV preview. Confirmation goes through the regular line-clearance endpoint. */
export const POST = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  const body = await readBoundedJson(request, MAX_STATEMENT_IMPORT_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.error === "payload_too_large" ? 413 : 400 });
  }
  const csv = (body.value as { csv?: unknown } | null)?.csv;
  if (typeof csv !== "string") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const parsed = parseStatementImport(csv);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, rowNumber: parsed.rowNumber }, { status: 400 });
  }
  const { id } = await ctx.params;
  try {
    const lines = await previewStatementMatches(session.businessId, id, parsed.lines, await financialReportAccess(session));
    return NextResponse.json({ lines }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
