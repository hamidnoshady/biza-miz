import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireProjectCapability, WorkspaceError } from "@/lib/workspace";
import { PERMISSIONS } from "@/lib/permissions";
import { loadAgencyCampaign } from "@/lib/agency-campaign-service";
import {
  createCampaignReport,
  listCampaignReports,
  type ReportOwner,
} from "@/lib/agency-campaign-report-service";
import { CampaignReportError } from "@/lib/agency-campaign-report";
import {
  workspaceOwner,
  handleWorkspaceError,
} from "@/app/api/workspace/guard";
import {
  readCampaignBody,
  campaignErrorResponse,
} from "../../../campaign-guard";

type Context = { params: Promise<{ id: string }> };
function errorResponse(err: unknown) {
  if (err instanceof CampaignReportError)
    return NextResponse.json(
      { error: err.code },
      {
        status:
          err.code === "campaign_not_found"
            ? 404
            : err.code === "invalid_report"
              ? 400
              : 409,
      },
    );
  return campaignErrorResponse(err) ?? handleWorkspaceError(err);
}
export const GET = withTenantScope(
  async (request: NextRequest, context: Context) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const campaign = await loadAgencyCampaign(session.businessId, id);
      if (!campaign) throw new CampaignReportError("campaign_not_found");
      let owner: ReportOwner = {
        businessId: session.businessId,
        actorUserId: session.sub,
        actorName: session.fullName ?? "",
        workspaceAllowed: false,
      };
      if (campaign.projectId) {
        const result = await workspaceOwner(PERMISSIONS.workspaceView, request);
        if (result.error) return result.error;
        owner = { ...result.owner, workspaceAllowed: true };
      }
      const reports = await listCampaignReports(owner, id);
      const member = await memberAccessFor(session);
      let canWrite = Boolean(member?.permissions.has(PERMISSIONS.crmManage));
      if (campaign.projectId) {
        canWrite =
          canWrite &&
          Boolean(member?.permissions.has(PERMISSIONS.workspaceManage));
        try {
          await requireProjectCapability(owner, campaign.projectId, "manage");
        } catch (err) {
          if (!(err instanceof WorkspaceError)) throw err;
          canWrite = false;
        }
      }
      return NextResponse.json({
        reports,
        canWrite:
          canWrite &&
          ["running", "paused", "completed", "cancelled"].includes(
            campaign.status,
          ) &&
          Boolean(campaign.startDate),
      });
    } catch (err) {
      return errorResponse(err);
    }
  },
);
export const POST = withTenantScope(
  async (request: NextRequest, context: Context) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const campaign = await loadAgencyCampaign(session.businessId, id);
      if (!campaign) throw new CampaignReportError("campaign_not_found");
      let owner: ReportOwner = {
        businessId: session.businessId,
        actorUserId: session.sub,
        actorName: session.fullName ?? "",
        workspaceAllowed: false,
      };
      if (campaign.projectId) {
        const result = await workspaceOwner(
          PERMISSIONS.workspaceManage,
          request,
        );
        if (result.error) return result.error;
        owner = { ...result.owner, workspaceAllowed: true };
      }
      const body = await readCampaignBody(request);
      if (!body) throw new CampaignReportError("invalid_report");
      return NextResponse.json(
        { report: await createCampaignReport(owner, id, body) },
        { status: 201 },
      );
    } catch (err) {
      return errorResponse(err);
    }
  },
);
