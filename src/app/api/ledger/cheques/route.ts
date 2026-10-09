import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listCheques, recordCheque } from "@/lib/cheques-service";
import { CHEQUE_DIRECTIONS, type ChequeDirection } from "@/lib/cheques";
import { chequeErrorResponse } from "./errors";
import { MalformedBodyError, readJsonObjectBody } from "./body";
import { idempotencyKeyOf } from "./idempotency";

/** The cheque register. Same access as the rest of the ledger's subledgers. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const raw = search.get("direction");
  if (raw && !CHEQUE_DIRECTIONS.includes(raw as ChequeDirection)) {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }

  const limit = Number(search.get("limit") ?? 50);
  const offset = Number(search.get("offset") ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 1 || offset < 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    // Searching, filtering, sorting, paging and the summary totals all happen
    // in Postgres: a large tenant's register is not a download.
    const page = await listCheques(session.businessId, {
      direction: (raw as ChequeDirection) || undefined,
      // A multi-branch register has to be able to ask "which cheques are this
      // branch's?" — the answer is the cheque's own location, the same one
      // every entry of its life posts to.
      locationId: search.get("locationId"),
      status: search.get("status"),
      bankName: search.get("bank"),
      // A treasurer's commonest question is "what falls due between these two
      // dates" — validated in the service, in storage (ISO) form; the screen
      // picks them on the Jalali calendar.
      dueFrom: search.get("dueFrom"),
      dueTo: search.get("dueTo"),
      q: search.get("q"),
      sort: search.get("sort"),
      limit,
      offset,
    });
    return NextResponse.json(page);
  } catch (err) {
    return chequeErrorResponse(err);
  }
});

interface ChequeBody {
  direction?: string;
  serialNumber?: string;
  sayadId?: string;
  bankName?: string;
  accountNumber?: string;
  amount?: number;
  issueDate?: string;
  dueDate?: string;
  counterpartyName?: string;
  customerId?: string;
  supplierId?: string;
  memo?: string;
  /** Opt-in to the unattributed-capture exception (issue #828 (10)). */
  allowUnattributed?: boolean;
  /** The returned cheque this one replaces. */
  replacesChequeId?: string;
  idempotencyKey?: string;
}

function isChequeBody(value: unknown): value is ChequeBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Records a cheque taken from a customer or written to a supplier, and posts
 * the entry that puts it on the books.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeChequesManage);
  if (error) return error;

  let body: ChequeBody;
  try {
    const parsed = await readJsonObjectBody(request);
    if (!isChequeBody(parsed)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = parsed;
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw err;
  }

  const direction = body.direction as ChequeDirection;
  if (!CHEQUE_DIRECTIONS.includes(direction)) {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  /*
   * The branch a cheque is captured into is the operator's active one, and it
   * is part of the request's identity — the service fingerprints it, because
   * the same cheque booked at two branches is two different postings.
   *
   * The consequence is deliberate and worth stating: if someone switches
   * branch between an attempt whose answer was lost and its retry, the retry
   * is refused as `idempotency_key_conflict` rather than quietly posting the
   * instrument into the branch they are standing in now. A refusal they can
   * read is the safe end of that ambiguity; a silent second branch is not.
   *
   * Everything else in this payload comes from the client, so it is stable
   * across a retry by construction. The only other value the server used to
   * resolve for itself was an omitted issue date, which is now resolved
   * *after* the replay lookup instead of being fingerprinted — see
   * `recordCheque`.
   */
  const location = await resolveActiveLocation(session);

  try {
    const cheque = await recordCheque({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      direction,
      serialNumber: body.serialNumber ?? "",
      sayadId: body.sayadId ?? null,
      bankName: body.bankName ?? "",
      accountNumber: body.accountNumber ?? null,
      amount,
      issueDate: body.issueDate ?? null,
      dueDate: body.dueDate ?? "",
      counterpartyName: body.counterpartyName ?? "",
      customerId: body.customerId ?? null,
      supplierId: body.supplierId ?? null,
      memo: body.memo ?? null,
      allowUnattributed: body.allowUnattributed === true,
      replacesChequeId: body.replacesChequeId ?? null,
      idempotencyKey: idempotencyKeyOf(request, body.idempotencyKey),
      createdBy: session.sub,
    });
    return NextResponse.json({ cheque }, { status: 201 });
  } catch (err) {
    return chequeErrorResponse(err);
  }
});
