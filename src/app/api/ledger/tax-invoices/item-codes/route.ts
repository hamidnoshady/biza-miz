import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listProductsWithoutCodes, saveTaxItemCodes, type TaxItemCodeInput } from "@/lib/tax-invoice-service";
import { readJsonBody, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * Products that have been sold and have no «شناسه کالا/خدمت». A sale containing
 * one cannot be prepared, so this is the list that unblocks the batch.
 */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    return NextResponse.json({ products: await listProductsWithoutCodes(session.businessId) });
  } catch (err) {
    return taxErrorResponse(err);
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxManageSettings);
  if (error) return error;
  const body = await readJsonBody<{ codes?: TaxItemCodeInput[] }>(request);
  if (!Array.isArray(body?.codes)) return NextResponse.json({ error: "codes_required" }, { status: 400 });
  try {
    await saveTaxItemCodes({ businessId: session.businessId, userId: session.sub }, body.codes);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
