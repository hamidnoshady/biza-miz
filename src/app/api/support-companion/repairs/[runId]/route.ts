import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import { getRecipe, getRepairRun } from "@/lib/support-companion/repair-catalog";

/** The companion fetches one approved run plus its full catalog recipe:
 * the two halves the envelope builder verifies against each other before
 * anything plans or executes. Session-bound (ticket + installation must
 * both match) with the session's `repair.execute` scope; misses are a
 * uniform `not_found`, never a cross-ticket oracle. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await requireCompanionSession(request);
  if ("response" in auth) return auth.response;
  const session = auth.session;
  if (!session.scope.includes("repair.execute")) {
    return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
  }

  const { runId } = await params;
  if (!/^[0-9a-fA-F-]{1,64}$/.test(runId ?? "")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const bundle = await withTenant(session.businessId, async () => {
    let run;
    try {
      run = await getRepairRun(session.businessId, runId);
    } catch {
      return null;
    }
    if (!run || run.ticketId !== session.ticketId || run.installationId !== session.installationId) {
      return null;
    }
    const recipe = await getRecipe(run.recipeId, run.recipeVersion);
    if (!recipe) return null;
    return { run, recipe };
  });

  if (!bundle) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(bundle);
}
