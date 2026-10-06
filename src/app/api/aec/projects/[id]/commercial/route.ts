import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  expiringSecurities,
  getProjectCommercialSummary,
  listProjectContractCommercials,
} from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError } from "../../../guard";

/**
 * §20's commercial cockpit for one project, plus §17's contract blocks.
 *
 * One route rather than three, because the screen is one screen: the summary
 * adds up the contracts, the variations and the certificates, and the contracts
 * are listed with their AEC block (advance, retention, guarantees, insurance,
 * the responsible manager) so the reader can see which contract produced which
 * number. Everything is a read on `workspace.view` — the *service* additionally
 * requires the `financials` capability, because a design office that has switched
 * the commercial cockpit off should not be handed it by an API guess.
 *
 * The Accounting-owned figures are not here as numbers: the summary names them
 * (`readInAccounting`) and reports actual cost from the ledger as `null` for an
 * actor without `ledger.view`, which is the same rule `projectReport` applies.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      const [summary, contracts, securities] = await Promise.all([
        getProjectCommercialSummary(owner, id),
        listProjectContractCommercials(owner.businessId, id),
        expiringSecurities(owner.businessId, { projectId: id, withinDays: 90 }),
      ]);
      return NextResponse.json({ summary, contracts, securities });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
