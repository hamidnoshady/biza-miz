import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MulticurrencyError, reverseFxEntry } from "@/lib/multicurrency-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a posted foreign-currency document.
 *
 * Append-only, exactly like the manual journal's reversal: a NEW entry with
 * every base and foreign amount swapped, stamped `reverses_entry_id`, dated
 * the day it is recorded — and crucially, reverting at the ORIGINAL rate
 * snapshot. Reversing at today's rate would silently revalue the past, which
 * is the one thing this subsystem exists to make impossible.
 *
 * Same trust level as the manual entry's reversal — `ledger.approve` there,
 * `ledger.post` here, because these documents are posted (not proposed) and
 * the reversal is the correction path.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "entry_not_found" }, { status: 404 });

  let body: { memo?: unknown; entryDate?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await reverseFxEntry({
      businessId: session.businessId,
      entryId: id,
      actorId: session.sub,
      memo: typeof body.memo === "string" ? body.memo : null,
      entryDate: typeof body.entryDate === "string" ? body.entryDate : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
