import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusinessAccessReport } from "@/lib/effective-access-report";
import { query } from "@/lib/db";

/**
 * Why a business can or cannot use each capability: the rollout layer, the
 * override that decided it, the plan's commercial row, and the six look-alike
 * key pairs side by side. Read-only; the decision itself is made by the request
 * gate and the entitlement resolver, which share one rule set.
 */
export const GET = withPlatformScope(
  async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("billing.view");
    if (guard.error) return guard.error;
    const { id: businessId } = await ctx.params;

    const { rows } = await query<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
    if (!rows[0]) return NextResponse.json({ error: "business_not_found" }, { status: 404 });

    return NextResponse.json(await getBusinessAccessReport(businessId));
  },
);
