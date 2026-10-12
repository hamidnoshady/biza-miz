import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MulticurrencyError, voidRate } from "@/lib/multicurrency-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Voids a rate entered in error.
 *
 * The rate row itself is immutable — voiding writes an append-only void row
 * (who, when, why) and every future lookup skips it. Posted documents are
 * untouched by construction: they carry their own snapshot of the rate value,
 * so history never moves. A void needs the same permission as posting a rate.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "rate_not_found" }, { status: 404 });

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const reason = (body as { reason?: unknown }).reason;

  try {
    await voidRate({ businessId: session.businessId, rateId: id, actorId: session.sub, reason: typeof reason === "string" ? reason : null });
    return NextResponse.json({ voided: true });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
