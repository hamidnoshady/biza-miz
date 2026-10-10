import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getTaxSettings, saveTaxProfile, saveTaxUnits, type TaxProfileInput, type TaxUnitInput } from "@/lib/tax-invoice-service";
import { readJsonBody, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * The taxpayer profile and the branches' memory ids. Reading never returns a key:
 * the response says only whether one is stored. Writing a key needs
 * `tax.manage_settings`, and the body's `credentials` replaces the stored ones.
 */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxView);
  if (error) return error;
  try {
    return NextResponse.json(await getTaxSettings(session.businessId));
  } catch (err) {
    return taxErrorResponse(err);
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxManageSettings);
  if (error) return error;
  const body = await readJsonBody<{ profile?: TaxProfileInput; units?: TaxUnitInput[] }>(request);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const actor = { businessId: session.businessId, userId: session.sub };
  try {
    if (body.profile) await saveTaxProfile(actor, body.profile);
    if (Array.isArray(body.units)) await saveTaxUnits(actor, body.units);
    return NextResponse.json(await getTaxSettings(session.businessId));
  } catch (err) {
    return taxErrorResponse(err);
  }
});
