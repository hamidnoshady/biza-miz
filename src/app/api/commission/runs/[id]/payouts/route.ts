import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actorOf, commissionErrorResponse } from "@/lib/commission-settlement-http";
import { badRequest, readJsonObject } from "@/lib/payroll-http";
import { parseIdempotencyKey, parsePayoutBody } from "@/lib/commission-settlement-input";
import { recordCommissionPayout } from "@/lib/commission-settlement-service";
import { CommissionSettlementError } from "@/lib/commission-settlement-errors";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Pay members of a payable run: `allocations` (`[{ employeeId, amount }]`, integer Rial,
 * never more than each member is still owed in this run), a payment account (`paymentAccountId`,
 * or `method` `cash`/`bank`), an optional `paidDate` (never in the future) and `memo`.
 *
 * Posts Dr 2300 / Cr the chosen account, once. An `Idempotency-Key` is required: the same key with
 * the same request returns the payout it made (`200`, `replayed: true`); a different request under a
 * used key is `409 idempotency_key_conflict`. Gated on `commission.payout`.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.commissionPayout);
  if (error) return error;

  const { id } = await ctx.params;
  const body = await readJsonObject(request);
  if (!body) return badRequest();

  try {
    const input = parsePayoutBody(body);
    const key = parseIdempotencyKey(request.headers.get("idempotency-key"), body.idempotencyKey);
    if (key === null) throw new CommissionSettlementError("idempotency_key_required", 400);
    const result = await recordCommissionPayout(session.businessId, actorOf(session, membership), id, input, key);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
