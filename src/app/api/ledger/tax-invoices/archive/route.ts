import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { archiveTaxInvoices, getTaxArchivePolicy, readTaxArchive, saveTaxArchivePolicy } from "@/lib/tax-invoice-archive";
import { readJsonBody, registerFiltersFromSearch, taxErrorResponse } from "@/lib/tax-invoice-http";

export const GET = withTenantScope(async (request: NextRequest) => {
  const download = request.nextUrl.searchParams.get("submissionId");
  const { session, error } = await requirePermission(download ? PERMISSIONS.taxExport : PERMISSIONS.taxView);
  if (error) return error;
  try {
    if (!download) return NextResponse.json(await getTaxArchivePolicy(session.businessId));
    // Reuse the strict UUID query parser rather than letting a database cast 500.
    registerFiltersFromSearch(new URLSearchParams({ customerId: download }));
    const archive = await readTaxArchive(session.businessId, download);
    if (!archive) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(archive, { headers: { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="tax-archive.json"' } });
  } catch (error) { return taxErrorResponse(error); }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxManageSettings);
  if (error) return error;
  try {
    const body = await readJsonBody<{ archiveAfterDays: unknown }>(request);
    await saveTaxArchivePolicy({ businessId: session.businessId, userId: session.sub }, body?.archiveAfterDays);
    return NextResponse.json(await getTaxArchivePolicy(session.businessId));
  } catch (error) { return taxErrorResponse(error); }
});

export const POST = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxManageSettings);
  if (error) return error;
  try { return NextResponse.json({ archived: await archiveTaxInvoices(session.businessId) }); }
  catch (error) { return taxErrorResponse(error); }
});
