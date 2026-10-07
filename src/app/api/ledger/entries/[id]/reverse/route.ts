import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ManualJournalError, MANUAL_MEMO_MAX, reverseEntry } from "@/lib/manual-journal-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a posted manual entry: a new entry with every line's debit and
 * credit swapped, dated today (or a given date) rather than backdated into
 * the original's period. Same trust level as approving a draft —
 * `ledger.approve` — since this is an equally ledger-altering action. The
 * screen gates the button on the same permission, so a manager no longer
 * clicks a live-looking destructive control and collects a 403.
 *
 * No `resolveActiveLocation` here any more, deliberately. Both the reversing
 * journal and its sync event are routed by the **original document's** branch
 * (`manual-journal-service.ts` explains why at length): the approver's active
 * location is where they are standing, not where the document lives, and
 * using it queued the reversal for the wrong branch in hybrid deployments.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  const { id } = await ctx.params;
  // `WHERE id = $1` against a uuid column raises a cast error rather than
  // answering "no such row", which surfaced as a 500 and «خطای غیرمنتظره».
  if (!isUuid(id)) return NextResponse.json({ error: "entry_not_found" }, { status: 404 });

  let body: { memo?: string; entryDate?: string } = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine; memo/entryDate are optional
  }

  // The reversal memo is free text a person types into the confirmation
  // dialog, so it gets the same bound the draft memo has — `memo` is `text`
  // in Postgres and an accidental paste would otherwise be stored in full.
  if (typeof body.memo === "string" && body.memo.trim().length > MANUAL_MEMO_MAX) {
    return NextResponse.json({ error: "memo_too_long" }, { status: 400 });
  }

  try {
    const result = await reverseEntry({
      businessId: session.businessId,
      locationId: null,
      entryId: id,
      actorId: session.sub,
      memo: body.memo,
      entryDate: body.entryDate,
      sync: { actorRole: session.role },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
