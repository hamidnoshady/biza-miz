import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { inquireSubmissions } from "@/lib/tax-invoice-service";
import { readJsonBody, stringArray, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * Ask the authority what became of records awaiting a result: the selected ones,
 * or every pending one when no ids are given. Read-only on the authority's side.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxInquiry);
  if (error) return error;
  const body = await readJsonBody<{ ids?: unknown }>(request);
  const ids = body?.ids === undefined ? undefined : stringArray(body.ids, 50) ?? undefined;
  if (body?.ids !== undefined && ids === undefined) return NextResponse.json({ error: "ids_invalid" }, { status: 400 });
  try {
    const result = await inquireSubmissions(session.businessId, { ids, force: true });
    return NextResponse.json(result);
  } catch (err) {
    return taxErrorResponse(err);
  }
});
