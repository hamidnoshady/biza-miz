import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { FiscalPeriodError, setPeriodStatus } from "@/lib/fiscal-periods-service";
import type { FiscalPeriodStatus } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

const VALID_STATUSES: FiscalPeriodStatus[] = ["open", "soft_closed", "locked"];

/**
 * Moves a period between open / soft-closed / locked / reopened.
 * `ledger.close_period` — the same effective capability used by the database
 * for posting to a closed-but-not-locked period; the same permission
 * gates both closing it and (later) posting into it while it's soft-closed,
 * since both are the same trust boundary.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.status || !VALID_STATUSES.includes(body.status as FiscalPeriodStatus)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const { id } = await ctx.params;
  try {
    const period = await setPeriodStatus(
      session.businessId,
      id,
      body.status as FiscalPeriodStatus,
      session.sub,
    );
    return NextResponse.json({ period });
  } catch (err) {
    if (err instanceof FiscalPeriodError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
