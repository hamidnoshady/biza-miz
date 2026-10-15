import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { branchAccessForSession } from "@/lib/automotive-access";
import { TRANSFER_STATUSES, type TransferStatus } from "@/lib/financial-transfers";
import { createFinancialTransfer, listFinancialTransfers } from "@/lib/financial-transfers-service";
import {
  financialErrorResponse,
  idempotencyKeyOf,
  limitFromSearch,
  MalformedBodyError,
  readJsonObjectBody,
} from "../financial/support";

/**
 * The transfer register (issue #862).
 *
 * Reading is the app's own door — a transfer is two ledger lines, and anyone who
 * may read the ledger may read them. Writing needs `finance.transfers_manage`,
 * because a transfer moves money now.
 *
 * Paging is a cursor, never an `offset`: an offset into a register that grows at
 * the top answers a stale client with the wrong rows and no way to notice.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const status = search.get("status");
  if (status && !TRANSFER_STATUSES.includes(status as TransferStatus)) {
    return NextResponse.json({ error: "invalid_transfer_status" }, { status: 400 });
  }
  if (search.has("offset")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const limit = limitFromSearch(search.get("limit"), 50, 200);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  try {
    const access = await branchAccessForSession(session);
    const result = await listFinancialTransfers(session.businessId, {
      from: search.get("from"),
      to: search.get("to"),
      sourceAccountId: search.get("sourceAccountId"),
      destinationAccountId: search.get("destinationAccountId"),
      accountId: search.get("accountId"),
      kind: search.get("kind"),
      locationId: search.get("locationId"),
      projectId: search.get("projectId"),
      status: status ? (status as TransferStatus) : null,
      q: search.get("q"),
      restrictToLocationIds: access.allowedLocationIds,
      limit,
      offset: Number(search.get("cursor") ?? 0) || 0,
    });
    return NextResponse.json(result);
  } catch (err) {
    return financialErrorResponse(err);
  }
});

/**
 * Create and post one transfer.
 *
 * The retry contract is the same one the cheque endpoints use: the caller repeats
 * an `Idempotency-Key` header (or a body `idempotencyKey`) and gets the first
 * result back instead of a second document. A key reused with a *different*
 * payload is refused as `idempotency_conflict` rather than answered with the
 * first entry — silently posting the wrong amount is worse than a refusal.
 *
 * The branch is the operator's active one and is part of the request's identity,
 * for the same reason it is on a cheque: the same transfer booked at two
 * branches is two different postings.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeTransfersManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonObjectBody(request);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = parsed;
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw err;
  }

  try {
    const access = await branchAccessForSession(session);
    const result = await createFinancialTransfer({
      businessId: session.businessId,
      actorId: session.sub,
      locationId: access.activeLocationId,
      input: body,
      allowedLocationIds: access.allowedLocationIds,
      headerIdempotencyKey: idempotencyKeyOf(request, body.idempotencyKey),
    });
    // A replay answers 200, not 201: nothing was created this time. The client
    // treats both as "the document exists and here it is".
    return NextResponse.json({ transfer: result.transfer, duplicate: result.duplicate }, {
      status: result.duplicate ? 200 : 201,
    });
  } catch (err) {
    return financialErrorResponse(err);
  }
});
