import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { CampaignAllocationError } from "@/lib/agency-campaign-allocation";
import { previewPostedCampaignAllocation } from "@/lib/agency-campaign-allocation-service";
import {
  agencyOwner,
  PERMISSIONS,
  readBody,
  handleAgencyError,
} from "../../../guard";

type Context = { params: Promise<{ id: string }> };
/** A read-only calculation. No journal, draft, dimension or campaign is changed. */
export const POST = withTenantScope(
  async (request: NextRequest, context: Context) => {
    const ledger = await requirePermission(PERMISSIONS.ledgerApprove);
    if (ledger.error) return ledger.error;
    const readLedger = await requirePermission(PERMISSIONS.ledgerView);
    if (readLedger.error) return readLedger.error;
    const crm = await requirePermission(PERMISSIONS.crmView);
    if (crm.error) return crm.error;
    const { owner, error } = await agencyOwner(
      PERMISSIONS.workspaceManage,
      request,
    );
    if (error) return error;
    try {
      return NextResponse.json(
        await previewPostedCampaignAllocation(
          owner,
          (await context.params).id,
          await readBody(request),
        ),
      );
    } catch (err) {
      if (err instanceof CampaignAllocationError) {
        return NextResponse.json(
          { error: err.code },
          { status: err.code === "invalid_allocation" ? 400 : 404 },
        );
      }
      return handleAgencyError(err);
    }
  },
);
