import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  delayedCommitments,
  listProjectCommitments,
  listProjectRequests,
  listProjectRfqs,
  pendingMaterialRequests,
  projectProcurementSummary,
} from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError } from "../../../guard";

/**
 * §18's procurement tab, in one read.
 *
 * The screen is one screen — the KPI row, the requirement register, the tenders
 * with their comparison sheets, the awards and the delay warning — so this route
 * answers all of it once instead of making the panel fire six requests whose
 * halves can be a second apart. Everything on it is a read on `workspace.view`;
 * the *service* additionally requires the `procurement` capability, because §18
 * asks for the whole register to be switchable off for a small office.
 *
 * The delay warning is §22's widget data (`delayedCommitments`) and the request
 * queue is §22's "material requests waiting" (`pendingMaterialRequests`), so the
 * assistant's `list_procurement_delays` tool and this screen are reading one
 * implementation.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      const [summary, requests, rfqs, commitments, delays, pending] = await Promise.all([
        projectProcurementSummary(owner.businessId, id),
        listProjectRequests(owner.businessId, id),
        listProjectRfqs(owner.businessId, id),
        listProjectCommitments(owner.businessId, id),
        delayedCommitments(owner.businessId, { projectId: id, limit: 50 }),
        pendingMaterialRequests(owner.businessId, { projectId: id, limit: 50 }),
      ]);
      return NextResponse.json({ summary, requests, rfqs, commitments, delays, pending });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
