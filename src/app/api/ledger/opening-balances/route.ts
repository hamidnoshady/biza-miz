import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, createOpeningSet, listOpeningSets } from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

/**
 * «ترازات افتتاحیه» — the accountant's opening-balance workspace (issue
 * #867). GET lists the business's opening sets (one per fiscal year, the
 * posted one carrying the year); POST starts a new manual draft.
 *
 * Everything that happens to a set afterwards — edit, submit, approve, post,
 * reverse, reconcile — is a sibling route under `[id]`, the same shape the
 * manual journal's drafts use. The wizard's own opening step is untouched: it
 * keeps posting its `source_type = 'opening'` entry the way it always did,
 * and this workspace answers for it through the same ledger.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json(await listOpeningSets(session.businessId));
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: {
    fiscalYearLabel?: string;
    effectiveDate?: string | null;
    note?: string | null;
    lines?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const { setId } = await createOpeningSet({
      businessId: session.businessId,
      fiscalYearLabel: body.fiscalYearLabel,
      effectiveDate: body.effectiveDate,
      note: body.note,
      lines: body.lines,
      actorId: session.sub,
    });
    return NextResponse.json({ ok: true, setId }, { status: 201 });
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
