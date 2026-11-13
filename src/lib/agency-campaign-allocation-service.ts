import { query, withTenantTransaction } from "./db";
import { requireProjectCapability, type WorkspaceOwner } from "./workspace";
import { assertAgencyIndustry } from "./agency-commercial-service";
import {
  CampaignAllocationError,
  readAllocationSourceLineId,
  readCampaignAllocationTargets,
  previewCampaignAllocation,
} from "./agency-campaign-allocation";

/**
 * Read-only proposal, NOT an approved allocation or campaign profitability.
 * HTTP caller additionally requires ledger.approve + ledger.view + crm.view + workspace.manage.
 * A single scoped query observes source and target eligibility in one snapshot;
 * a future writer must revalidate under locks and persist immutable source facts.
 */
export async function previewPostedCampaignAllocation(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
) {
  const sourceLineId = readAllocationSourceLineId(input.sourceLineId);
  const targets = readCampaignAllocationTargets(input.targets);
  await assertAgencyIndustry(owner.businessId);
  return withTenantTransaction(owner.businessId, async () => {
    await requireProjectCapability(owner, projectId, "manage");
    const { rows } = await query<{
      entry_id: string;
      amount_rial: string;
      account_code: string;
      eligible_campaign_ids: string[];
    }>(
      `SELECT e.id AS entry_id,l.debit::text AS amount_rial,a.code AS account_code,
        ARRAY(SELECT c.id::text FROM agency_client_campaigns c
          WHERE c.business_id=$1 AND c.project_id=p.id AND c.party_id=p.party_id
            AND c.id=ANY($4::uuid[])) AS eligible_campaign_ids
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id AND e.business_id=$1
       JOIN accounts a ON a.id=l.account_id AND a.business_id=$1
       JOIN ai_projects p ON p.id=e.project_id AND p.business_id=$1
       JOIN parties client ON client.id=p.party_id AND client.business_id=$1
       WHERE l.id=$3::bigint AND p.id=$2 AND a.type='expense'
         AND l.debit>0 AND l.credit=0 AND e.reversed_at IS NULL AND e.reverses_entry_id IS NULL`,
      [
        owner.businessId,
        projectId,
        sourceLineId,
        targets.map((row) => row.campaignId),
      ],
    );
    const source = rows[0];
    if (!source)
      throw new CampaignAllocationError("allocation_source_not_found");
    const eligible = new Set(source.eligible_campaign_ids);
    if (targets.some((row) => !eligible.has(row.campaignId))) {
      // Generic: never disclose which other tenant/client/project owns a target.
      throw new CampaignAllocationError("allocation_campaign_not_found");
    }
    return {
      previewOnly: true,
      sourceLineId,
      sourceEntryId: source.entry_id,
      sourceAccountCode: source.account_code,
      ...previewCampaignAllocation(source.amount_rial, targets),
    };
  });
}
