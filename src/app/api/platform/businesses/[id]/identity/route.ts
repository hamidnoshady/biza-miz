import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusinessIdentity } from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The business's identity alone — id, name, slug, host, status.
 *
 * The console shell draws the workspace's name in its sidebar on every
 * `/platform/businesses/{id}/…` navigation, and it used to read the full
 * summary endpoint to get it. That endpoint computes four counts, the alias
 * list and the industry data counts, and the workspace's own provider reads the
 * same endpoint again for the real page — so opening one business paid for two
 * heavy reads before any section rendered (issue #755 §11).
 *
 * A separate, cheap read keeps the shell from paying for data only the sections
 * need. Any admin may read it (`businesses.read`) — it is the same identity the
 * sidebar is about to display.
 */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("businesses.read");
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusinessIdentity(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ business });
});
