import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { projectAecReports } from "@/lib/aec-reports-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError } from "../../../guard";

/**
 * Issue #799 §30 — the project's AEC report set, in one read.
 *
 * The screen is one screen (a card per report), so the route is one read: a
 * report per request would make the bundle's halves a second apart, and §30's
 * whole point is that the figures agree with each other.
 *
 * Two gates, in this order:
 *
 *   * `workspace.view` opens the module and `requireProjectCapability(…, "view")`
 *     opens *this* project — §32's rule that a report is project data;
 *   * the business's AEC capabilities decide which reports exist at all
 *     (`reportsForCapabilities`), so a business that switched `procurement` off
 *     is not handed a delay report whose register it does not have. The
 *     financial four additionally need `ledger.view` for the actual-cost column,
 *     which `getProjectCommercialSummary` answers with `null` rather than a
 *     zero — the same rule §20's cockpit follows.
 *
 * There is no `?key=` narrowing: §34's "progressive disclosure" is the screen's
 * job, and a per-report endpoint would be a second place for the capability
 * filter to live.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json(await projectAecReports(owner, id));
    } catch (err) {
      return handleAecError(err);
    }
  },
);
