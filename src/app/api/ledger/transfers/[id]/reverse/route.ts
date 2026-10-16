import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { branchAccessForSession } from "@/lib/automotive-access";
import { reverseFinancialTransfer } from "@/lib/financial-transfers-service";
import {
  financialErrorResponse,
  idempotencyKeyOf,
  MalformedBodyError,
  readJsonObjectBody,
} from "../../../financial/support";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverse a posted transfer (برگشت سند).
 *
 * Reversal is append-only and mirroring: the service builds the reversing entry
 * from the ORIGINAL entry's own lines — every leg swapped, dimensions and the
 * multicurrency snapshot carried across — rather than re-deriving it from the
 * reversal's fields. That is what stops a reversal from recognising the fee a
 * second time (crediting it back as an expense instead of reversing the expense)
 * or from re-converting a foreign transfer at today's rate, which would rewrite
 * history at a rate the original was never booked at.
 *
 * The reason is mandatory. A reversal is the only way to take a posted transfer
 * off the books, and accounting evidence with no explanation is not evidence.
 * Repeating the idempotency key of the original reversal returns the same
 * reversal; asking again without one is `transfer_already_reversed`.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeTransfersManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "transfer_not_found" }, { status: 404 });

  let body: { reason?: unknown; reversalDate?: unknown; idempotencyKey?: unknown };
  try {
    body = (await readJsonObjectBody(request)) as typeof body;
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw err;
  }
  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "reversal_reason_required" }, { status: 400 });
  }
  if (body.reversalDate !== undefined && body.reversalDate !== null && typeof body.reversalDate !== "string") {
    return NextResponse.json({ error: "invalid_transfer_date" }, { status: 400 });
  }

  try {
    const access = await branchAccessForSession(session);
    const result = await reverseFinancialTransfer({
      businessId: session.businessId,
      transferId: id,
      actorId: session.sub,
      reason: body.reason,
      reversalDate: (body.reversalDate as string | undefined) ?? null,
      idempotencyKey: idempotencyKeyOf(request, body.idempotencyKey),
      allowedLocationIds: access.allowedLocationIds,
    });
    return NextResponse.json(
      { transfer: result.transfer, reversalEntryId: result.reversalEntryId, duplicate: result.duplicate },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    return financialErrorResponse(err);
  }
});
