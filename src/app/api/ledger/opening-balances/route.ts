import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import { createOpeningBalanceSet, listOpeningBalanceSets } from "@/lib/opening-balance-service";

/**
 * Opening-balance sets, newest year first. Any ledger reader may see them.
 * `?fiscalYearId=` narrows to one year.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const fiscalYearId = request.nextUrl.searchParams.get("fiscalYearId");
  try {
    const sets = await listOpeningBalanceSets(session.businessId, { fiscalYearId });
    return NextResponse.json({ sets });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});

/**
 * Starts a draft opening set for a fiscal year. Proposing is `ledger.propose`;
 * the draft changes nothing in the books until it is approved and posted.
 * An `idempotencyKey` makes a retry return the set it already made (200), not a
 * second draft (201).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  if (typeof body.fiscalYearId !== "string" || typeof body.effectiveDate !== "string") {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  try {
    const { set, created } = await createOpeningBalanceSet(session.businessId, session.sub, {
      fiscalYearId: body.fiscalYearId,
      effectiveDate: body.effectiveDate,
      memo: typeof body.memo === "string" ? body.memo : null,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
    });
    return NextResponse.json({ set }, { status: created ? 201 : 200 });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
