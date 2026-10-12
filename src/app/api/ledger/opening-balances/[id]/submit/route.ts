import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { OpeningBalanceError, submitOpeningSet } from "@/lib/opening-balances-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * draft → review. A balanced set enters the review queue; the 0217 trigger
 * freezes its lines from here on, so this is also the last moment an editor
 * can reach them. `ledger.post` — the same capability that may start a
 * document.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });
  try {
    await submitOpeningSet({ businessId: session.businessId, setId: id, actorId: session.sub });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
