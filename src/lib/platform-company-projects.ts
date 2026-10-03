/**
 * Explicit, idempotent CRM → My Workspace handoff.
 *
 * The project is created in the SAME project engine every business uses — this
 * is not a second project system. What it adds is the durable identity a
 * handoff needs: a creation key so a retried click cannot make two projects,
 * the back-link to the originating deal, and the platform-customer link when
 * the deal's party is a mapped platform customer.
 *
 * It forecasts; it never posts revenue. `forecast_revenue_rial` is deliberately
 * a project figure, kept apart from the ledger's posted actuals, so a
 * salesperson's pipeline number can never be mistaken for accounting revenue.
 */
import { query } from "./db";
import { createWorkspaceProject, type WorkspaceOwner } from "./workspace";
import { isUuid } from "./uuid";

/** The link kinds this handoff is allowed to write. `link_kind` is validated in SQL too. */
export type ProjectLinkKind = "deal" | "invoice" | "campaign" | "website" | "support_ticket" | "customer_tenant";

export interface CreateProjectFromDealResult {
  projectId: string;
  name: string;
  created: boolean;
  dealId: string;
  forecastRevenueRial: number;
}

export async function createCompanyProjectFromDeal(
  owner: WorkspaceOwner,
  dealId: string,
): Promise<CreateProjectFromDealResult> {
  if (!isUuid(dealId)) throw new Error("deal_not_found");
  const { rows } = await query<{
    id: string;
    title: string;
    value_rial: string;
    customer_id: string | null;
    outcome: string | null;
  }>(
    `SELECT d.id, d.title, d.value_rial, d.customer_id, s.outcome
       FROM crm_deals d
       LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id AND s.business_id = d.business_id
      WHERE d.id = $1 AND d.business_id = $2`,
    [dealId, owner.businessId],
  );
  const deal = rows[0];
  // Scoped by the internal company's own business id, so a deal belonging to a
  // customer tenant is not reachable by id alone.
  if (!deal) throw new Error("deal_not_found");
  if (deal.outcome !== "won") throw new Error("deal_not_won");

  const forecastRevenueRial = Math.max(Number(deal.value_rial) || 0, 0);
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM ai_projects WHERE business_id = $1 AND creation_key = $2`,
    [owner.businessId, `crm-deal:${deal.id}`],
  );

  const project = await createWorkspaceProject(owner, {
    name: deal.title,
    description:
      "پروژه ایجادشده از معاملهٔ برنده CRM؛ مبلغ فقط پیش‌بینی است و اثر دفتری ندارد.",
    status: "planning",
    priority: "normal",
    projectType: "customer_onboarding",
    partyId: deal.customer_id,
    creationKey: `crm-deal:${deal.id}`,
    sourceDealId: deal.id,
    forecastRevenueRial,
  });

  // Back-links, idempotently: the deal always, the platform-customer tenant
  // when the deal's party is one the company has already mapped.
  await linkProject(owner, project.id, "deal", deal.id);
  if (deal.customer_id) {
    const { rows: mapped } = await query<{ customer_tenant_id: string }>(
      `SELECT ct.customer_tenant_id
         FROM platform_company_customers c
         JOIN platform_company_customer_tenants ct ON ct.customer_id = c.id
        WHERE c.business_id = $1 AND c.party_id = $2`,
      [owner.businessId, deal.customer_id],
    );
    if (mapped[0]) await linkProject(owner, project.id, "customer_tenant", mapped[0].customer_tenant_id);
  }

  return {
    projectId: project.id,
    name: project.name,
    created: !existing[0],
    dealId: deal.id,
    forecastRevenueRial,
  };
}

/**
 * Attach one validated link to a project.
 *
 * `workspace_project_links.linked_id` is text and cannot be foreign-keyed, so
 * the check is explicit here AND enforced by the `workspace_project_links_guard`
 * trigger (migration 0193): the referenced row must exist and must belong to
 * the internal business. Without that, any UUID or free text could be attached
 * and later resolved as if it were a real record.
 */
export async function linkProject(
  owner: WorkspaceOwner,
  projectId: string,
  linkKind: ProjectLinkKind,
  linkedId: string,
): Promise<void> {
  if (!isUuid(projectId)) throw new Error("project_not_found");
  if (!linkedId) throw new Error("invalid_project_link");
  // The trigger re-validates ownership; this check exists so a caller gets a
  // usable error instead of a raw constraint violation.
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM ai_projects WHERE id = $1 AND business_id = $2`,
    [projectId, owner.businessId],
  );
  if (!rows[0]) throw new Error("project_not_found");
  await query(
    `INSERT INTO workspace_project_links (business_id, project_id, link_kind, linked_id, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (project_id, link_kind, linked_id) DO NOTHING`,
    [owner.businessId, projectId, linkKind, linkedId, owner.actorUserId],
  );
}
