import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listCheques, recordCheque } from "@/lib/cheques-service";
import { CHEQUE_DIRECTIONS, type ChequeDirection } from "@/lib/cheques";
import { chequeErrorResponse } from "./errors";
import { MalformedBodyError, readJsonObjectBody } from "./body";

/** The cheque register. Same access as the rest of the ledger's subledgers. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const raw = search.get("direction");
  if (raw && !CHEQUE_DIRECTIONS.includes(raw as ChequeDirection)) {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }
  // A multi-branch register has to be able to ask "which cheques are this
  // branch's?" — the answer is the cheque's own location, the same one every
  // entry of its life posts to.
  const locationId = search.get("locationId");

  try {
    const cheques = await listCheques(
      session.businessId,
      (raw as ChequeDirection) || undefined,
      locationId || undefined,
    );
    return NextResponse.json({ cheques });
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
      createdBy: session.sub,
    });
    return NextResponse.json({ cheque }, { status: 201 });
  } catch (err) {
    return chequeErrorResponse(err);
  }
});
