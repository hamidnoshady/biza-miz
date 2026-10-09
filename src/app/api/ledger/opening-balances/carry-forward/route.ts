import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import {
  generateCarryForwardProposal,
  priorCloseComparison,
} from "@/lib/opening-balance-service";

/**
 * The prior-close vs next-open comparison for one fiscal year: whether the
 * prior year is closed, and the carry-forward proposal for this year if one
 * has been generated.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const fiscalYearId = request.nextUrl.searchParams.get("fiscalYearId") ?? "";
  try {
    return NextResponse.json(await priorCloseComparison(session.businessId, fiscalYearId));
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});

/**
 * Generates the next year's opening proposal from a closed prior year. Idempotent:
 * a repeat returns the existing proposal (200), not a second one (201).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body || typeof body.fiscalYearId !== "string") return badRequest();
  try {
    const { set, created } = await generateCarryForwardProposal(session.businessId, session.sub, body.fiscalYearId);
    return NextResponse.json({ set }, { status: created ? 201 : 200 });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
