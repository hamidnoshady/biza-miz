import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { branchAccessForSession } from "@/lib/automotive-access";
import { createFinancialTransfer } from "@/lib/financial-transfers-service";
import { PERMISSIONS } from "@/lib/permissions";
import { parsePspSettlement, pspSettlementProblem } from "@/lib/psp-settlements";
import { listPspSettlements } from "@/lib/psp-settlements-posting";
import { financialErrorResponse, limitFromSearch } from "../financial/support";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const cursor = request.nextUrl.searchParams.get("cursor");
  const limit = limitFromSearch(request.nextUrl.searchParams.get("limit"), 50, 200);
  if (limit === null || (cursor !== null && (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const access = await branchAccessForSession(session);
  return NextResponse.json(await listPspSettlements(session.businessId, access.allowedLocationIds, limit, cursor));
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeTransfersManage);
  if (error) return error;
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const data = body as Record<string, unknown>;
  const settlement = parsePspSettlement(data);
  if (!settlement) return NextResponse.json({ error: pspSettlementProblem(data) }, { status: 400 });
  const { input, ...pspSettlement } = settlement;
  try {
    const access = await branchAccessForSession(session);
    const result = await createFinancialTransfer({
      businessId: session.businessId,
      actorId: session.sub,
      locationId: access.activeLocationId,
      allowedLocationIds: access.allowedLocationIds,
      input,
    }, { pspSettlement });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    return financialErrorResponse(err);
  }
});
