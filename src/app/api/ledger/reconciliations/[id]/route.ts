import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  discardReconciliation,
  getReconciliation,
  ReconciliationError,
} from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Longest search string worth sending to an `ILIKE`. A reconciliation screen
 * search is a memo, a cheque serial or a line id; anything longer is a paste
 * mistake, and a megabyte of `%`-patterns is a slow query nobody meant to run.
 */
const MAX_SEARCH_LENGTH = 200;

/**
 * One reconciliation's candidate/cleared lines and computed balances.
 *
 * The lines are a *page*, not the whole history: a bank-clearing account on a
 * busy shop has thousands of unreconciled postings, and returning all of them
 * made one screen's payload and its render cost grow with how long the business
 * had been trading. `nextCursor` continues the list; the header totals
 * (`clearedTotal`, `difference`, `candidateCount`) are always computed over the
 * whole reconciliation, so paging and filtering never change «مغایرت».
 *
 *  - `limit` — page size, capped at `MAX_RECONCILIATION_LINES_PAGE`
 *  - `cursor` — the `nextCursor` from the previous page
 *  - `q` — free text over the memo, the document reference and the line id
 *  - `cleared=true` — only the lines this reconciliation has ticked
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const params = request.nextUrl.searchParams;

  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const rawCleared = params.get("cleared");
  if (rawCleared !== null && rawCleared !== "true" && rawCleared !== "false") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const search = params.get("q")?.trim().slice(0, MAX_SEARCH_LENGTH) || undefined;

  try {
    return NextResponse.json(
      await getReconciliation(session.businessId, id, {
        limit: rawLimit ? Number(rawLimit) : undefined,
        cursor: params.get("cursor"),
        clearedOnly: rawCleared === "true",
        search,
      }),
    );
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/**
 * Discard an in-progress reconciliation, so a mistyped statement balance does
 * not wedge the account. Completed reconciliations are immutable — they are
 * the next period's opening balance.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    await discardReconciliation({ businessId: session.businessId, reconciliationId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
