import { query } from "./db";
import { createWorkspaceProject, type WorkspaceOwner } from "./workspace";
import { isUuid } from "./uuid";

/** Explicit, idempotent CRM -> Workspace handoff. It forecasts; it never posts revenue. */
export async function createCompanyProjectFromDeal(owner: WorkspaceOwner, dealId: string) {
  if (!isUuid(dealId)) throw new Error("deal_not_found");
  const { rows } = await query<{
    id: string; title: string; value_rial: string; customer_id: string | null; outcome: string | null;
  }>(
    `SELECT d.id,d.title,d.value_rial,d.customer_id,s.outcome
       FROM crm_deals d
       LEFT JOIN crm_pipeline_stages s ON s.id=d.stage_id AND s.business_id=d.business_id
      WHERE d.id=$1 AND d.business_id=$2`,
    [dealId, owner.businessId],
  );
  const deal = rows[0];
  if (!deal) throw new Error("deal_not_found");
  if (deal.outcome !== "won") throw new Error("deal_not_won");
  if (!deal.customer_id) throw new Error("deal_customer_required");
  return createWorkspaceProject(owner, {
    name: deal.title,
    description: "پروژه ایجادشده از معاملهٔ برنده CRM؛ مبلغ فقط پیش‌بینی است و اثر دفتری ندارد.",
    status: "planning",
    priority: "normal",
    projectType: "customer_onboarding",
    partyId: deal.customer_id,
    creationKey: `crm-deal:${deal.id}`,
    sourceDealId: deal.id,
    forecastRevenueRial: Number(deal.value_rial),
  });
}
