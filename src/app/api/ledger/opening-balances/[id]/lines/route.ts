import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse, badRequest, readJsonObject } from "@/lib/accounting-http";
import { replaceOpeningBalanceLines, type OpeningLineInputRaw } from "@/lib/opening-balance-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Replaces a draft's lines in one request. Balance is not required here — the
 * set is checked for balance at submit, and again at approval and posting.
 */
export const PUT = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body || !Array.isArray(body.lines)) return badRequest();
  const { id } = await ctx.params;
  try {
    const set = await replaceOpeningBalanceLines(
      session.businessId,
      id,
      body.lines as OpeningLineInputRaw[],
    );
    return NextResponse.json({ set });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
