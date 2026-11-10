import { businessToday } from "./business-day-service";
import { query, withTenantTransaction } from "./db";
import { isUuid } from "./uuid";
import {
  requireProjectCapability,
  WorkspaceError,
  type WorkspaceOwner,
} from "./workspace";
import {
  CampaignReportError,
  readCampaignReport,
  campaignReportMetrics,
  type CampaignReportInput,
} from "./agency-campaign-report";

export type ReportOwner = WorkspaceOwner & { workspaceAllowed: boolean };
export type CampaignReport = CampaignReportInput & {
  id: string;
  campaignBudgetRial: number | null;
  createdAt: string;
  createdByName: string;
  superseded: boolean;
  metrics: ReturnType<typeof campaignReportMetrics>;
};
async function scope(owner: ReportOwner, campaignId: string, write: boolean) {
  if (!isUuid(campaignId)) throw new CampaignReportError("campaign_not_found");
  const row = (
    await query<{
      project_id: string | null;
      status: string;
      start_iso: string | null;
      end_iso: string | null;
    }>(
      `SELECT project_id,status,start_date::text AS start_iso,end_date::text AS end_iso FROM agency_client_campaigns
    WHERE business_id=$1 AND id=$2 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
      [owner.businessId, campaignId],
    )
  ).rows[0];
  if (!row) throw new CampaignReportError("campaign_not_found");
  if (row.project_id) {
    if (!owner.workspaceAllowed)
      throw new WorkspaceError("insufficient_project_role");
    await requireProjectCapability(
      owner,
      row.project_id,
      write ? "manage" : "view",
    );
  }
  return row;
}
export async function listCampaignReports(
  owner: ReportOwner,
  campaignId: string,
): Promise<CampaignReport[]> {
  return withTenantTransaction(owner.businessId, async () => {
    await scope(owner, campaignId, false);
    const { rows } = await query<{
      id: string;
      start_iso: string;
      end_iso: string;
      evidence_reference: string;
      attribution_note: string;
      attribution_confirmed: boolean;
      spend_rial: string;
      reach: string | null;
      campaign_budget_rial: string | null;
      impressions: string;
      clicks: string;
      leads_generated: string;
      conversions: string;
      revenue_rial: string | null;
      supersedes_id: string | null;
      created_at: Date | string;
      created_by_name: string;
      superseded: boolean;
    }>(
      `SELECT r.*,r.period_start::text AS start_iso,r.period_end::text AS end_iso,
    EXISTS(SELECT 1 FROM agency_campaign_reports n WHERE n.business_id=$1 AND n.campaign_id=$2 AND n.supersedes_id=r.id) AS superseded
    FROM agency_campaign_reports r WHERE r.business_id=$1 AND r.campaign_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
      [owner.businessId, campaignId],
    );
    return rows.map((r) => {
      const input: CampaignReportInput = {
        periodStart: r.start_iso,
        periodEnd: r.end_iso,
        evidenceReference: r.evidence_reference,
        attributionNote: r.attribution_note,
        attributionConfirmed: r.attribution_confirmed,
        spendRial: Number(r.spend_rial),
        reach: r.reach === null ? null : Number(r.reach),
        impressions: Number(r.impressions),
        clicks: Number(r.clicks),
        leadsGenerated: Number(r.leads_generated),
        conversions: Number(r.conversions),
        revenueRial: r.revenue_rial === null ? null : Number(r.revenue_rial),
        supersedesId: r.supersedes_id,
      };
      return {
        ...input,
        campaignBudgetRial:
          r.campaign_budget_rial === null
            ? null
            : Number(r.campaign_budget_rial),
        id: r.id,
        createdAt: new Date(r.created_at).toISOString(),
        createdByName: r.created_by_name,
        superseded: r.superseded,
        metrics: campaignReportMetrics(input),
      };
    });
  });
}
export async function createCampaignReport(
  owner: ReportOwner,
  campaignId: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  const data = readCampaignReport(input);
  return withTenantTransaction(owner.businessId, async () => {
    const campaign = await scope(owner, campaignId, true);
    if (
      !["running", "paused", "completed", "cancelled"].includes(
        campaign.status,
      ) ||
      !campaign.start_iso
    )
      throw new CampaignReportError("report_state");
    if (
      (campaign.start_iso && data.periodStart < campaign.start_iso) ||
      (campaign.end_iso && data.periodEnd > campaign.end_iso) ||
      data.periodEnd > (await businessToday(owner.businessId))
    )
      throw new CampaignReportError("invalid_report");
    if (data.supersedesId) {
      const previous = (
        await query(
          `SELECT id FROM agency_campaign_reports r WHERE r.id=$3 AND r.business_id=$1 AND r.campaign_id=$2
        AND r.period_start=$4::date AND r.period_end=$5::date
        AND NOT EXISTS(SELECT 1 FROM agency_campaign_reports n WHERE n.business_id=$1 AND n.campaign_id=$2 AND n.supersedes_id=r.id)`,
          [
            owner.businessId,
            campaignId,
            data.supersedesId,
            data.periodStart,
            data.periodEnd,
          ],
        )
      ).rows[0];
      if (!previous) throw new CampaignReportError("report_conflict");
    } else if (
      (
        await query(
          `SELECT id FROM agency_campaign_reports WHERE business_id=$1 AND campaign_id=$2 AND period_start=$3::date AND period_end=$4::date`,
          [owner.businessId, campaignId, data.periodStart, data.periodEnd],
        )
      ).rows.length
    )
      throw new CampaignReportError("report_conflict");
    const r = await query<{ id: string }>(
      `INSERT INTO agency_campaign_reports (business_id,campaign_id,period_start,period_end,
      evidence_reference,attribution_note,attribution_confirmed,spend_rial,impressions,clicks,leads_generated,conversions,revenue_rial,supersedes_id,created_by,created_by_name,reach)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [
        owner.businessId,
        campaignId,
        data.periodStart,
        data.periodEnd,
        data.evidenceReference,
        data.attributionNote,
        data.attributionConfirmed,
        data.spendRial,
        data.impressions,
        data.clicks,
        data.leadsGenerated,
        data.conversions,
        data.revenueRial,
        data.supersedesId,
        owner.actorUserId,
        (owner.actorName ?? "").slice(0, 200),
        data.reach,
      ],
    );
    return r.rows[0];
  });
}
