import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  OpeningBalanceError,
  getOpeningSet,
  updateOpeningSetLines,
} from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One opening set with its lines (each line carries the account and the
 * party it attributes to, so the drill-down reads names, not ids). GET is
 * read permission; PUT replaces the set's lines while it is still a draft or
 * in review — after submission the 0217 trigger freezes it at the database.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });
  const result = await getOpeningSet(session.businessId, id);
  if (!result) return NextResponse.json({ error: "set_not_found" }, { status: 404 });
  return NextResponse.json(result);
});

export const PUT = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });

  let body: { lines?: unknown; note?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await updateOpeningSetLines({
      businessId: session.businessId,
      setId: id,
      lines: body.lines,
      note: body.note,
      actorId: session.sub,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
