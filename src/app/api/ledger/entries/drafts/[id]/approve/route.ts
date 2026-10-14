import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { approveDraft, ManualJournalError } from "@/lib/manual-journal-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Approves a draft, posting it as a real journal entry. Gated on
 * ledger.approve — the "approval permission distinct from posting" the
 * phase scoped — not the role list that gates drafting, so by default only
 * the owner and an accountant can turn a draft into a real posting.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  const { id } = await ctx.params;
  // A non-UUID cannot name a draft, and `WHERE id = $2` against a `uuid`
  // column answers `invalid input syntax for type uuid` — a 500 and a generic
  // «خطای غیرمنتظره» — rather than the 404 it is. See `isUuid`.
  if (!isUuid(id)) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

  const location = await resolveActiveLocation(session);

  try {
    const result = await approveDraft({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      draftId: id,
      actorId: session.sub,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
