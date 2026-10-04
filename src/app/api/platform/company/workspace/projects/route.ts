import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import { listWorkspaceProjects } from "@/lib/workspace";
import { workspaceAccessFlags } from "@/lib/workspace-shared";

export interface CompanyProjectSummary {
  id: string;
  name: string;
  status: string;
  priority: string;
  projectType: string | null;
  partyId: string | null;
  partyName: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Project-level plan figures — never accounting actuals. */
  budgetRial: number | null;
  forecastRevenueRial: number | null;
  sourceDealId: string | null;
  taskCount: number;
  doneTaskCount: number;
  memberCount: number;
  links: { linkKind: string; linkedId: string }[];
  /** Present only when the caller holds `ledger.view`. */
  postedActuals: null | { revenueRial: number; costRial: number };
}

/**
 * The internal company's projects, with their cross-area links.
 *
 * Financial visibility is deliberately split:
 *
 *   * budget and forecast are *project* data, visible to anyone who can see the
 *     project in My Workspace;
 *   * actual posted revenue/cost is *Accounting* data and is only included when
 *     the caller's preset holds `ledger.view`. A project manager sees what they
 *     are managing without being handed the ledger.
 *
 * There is no second project system here: this reads the same
 * `listWorkspaceProjects` engine every business uses and adds only the
 * platform-relationship links on top.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.workspaceView, async (actor) => {
    const projects = await listWorkspaceProjects(
      { businessId: actor.businessId, actorUserId: actor.userId, access: workspaceAccessFlags(actor.permissions) },
      { limit: 100 },
    );
    const ids = projects.map((project) => project.id);
    const links = new Map<string, { linkKind: string; linkedId: string }[]>();
    if (ids.length) {
      const { rows } = await query<{ project_id: string; link_kind: string; linked_id: string }>(
        `SELECT project_id, link_kind, linked_id
           FROM workspace_project_links
          WHERE business_id = $1 AND project_id = ANY($2::uuid[])
          ORDER BY created_at`,
        [actor.businessId, ids],
      );
      for (const row of rows) {
        const list = links.get(row.project_id) ?? [];
        list.push({ linkKind: row.link_kind, linkedId: row.linked_id });
        links.set(row.project_id, list);
      }
    }

    // Posted actuals come from Accounting, and only for a caller who may read
    // the ledger. They are summed from posted journal lines against the
    // project, never from invoices, wallets or subscription state.
    let postedByProject = new Map<string, { revenueRial: number; costRial: number }>();
    if (actor.permissions.has(PERMISSIONS.ledgerView) && ids.length) {
      const { rows } = await query<{ project_id: string; revenue_rial: string; cost_rial: string }>(
        `SELECT je.project_id,
                COALESCE(sum(jl.credit) FILTER (WHERE a.type = 'revenue'), 0)::text AS revenue_rial,
                COALESCE(sum(jl.debit) FILTER (WHERE a.type = 'expense'), 0)::text AS cost_rial
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
           JOIN accounts a ON a.id = jl.account_id AND a.business_id = je.business_id
          WHERE je.business_id = $1 AND je.project_id = ANY($2::uuid[])
          GROUP BY je.project_id`,
        [actor.businessId, ids],
      );
      postedByProject = new Map(
        rows.map((row) => [
          row.project_id,
          { revenueRial: Number(row.revenue_rial), costRial: Number(row.cost_rial) },
        ]),
      );
    }

    const summaries: CompanyProjectSummary[] = projects.map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      priority: project.priority,
      projectType: project.projectType,
      partyId: project.partyId,
      partyName: project.partyName,
      startDate: project.startDate,
      endDate: project.endDate,
      budgetRial: project.budgetRial,
      forecastRevenueRial: null,
      sourceDealId: null,
      taskCount: project.taskCount,
      doneTaskCount: project.doneTaskCount,
      memberCount: project.memberCount,
      links: links.get(project.id) ?? [],
      postedActuals: postedByProject.get(project.id) ?? null,
    }));

    // `source_deal_id` and `forecast_revenue_rial` are workspace columns this
    // list does not select; they are read in one small query so the UI can show
    // where a project came from without a second engine.
    if (ids.length) {
      const { rows } = await query<{
        id: string; source_deal_id: string | null; forecast_revenue_rial: string | null;
      }>(
        `SELECT id, source_deal_id, forecast_revenue_rial::text
           FROM ai_projects WHERE business_id = $1 AND id = ANY($2::uuid[])`,
        [actor.businessId, ids],
      );
      const extra = new Map(rows.map((row) => [row.id, row]));
      for (const summary of summaries) {
        const row = extra.get(summary.id);
        summary.sourceDealId = row?.source_deal_id ?? null;
        summary.forecastRevenueRial = row?.forecast_revenue_rial
          ? Number(row.forecast_revenue_rial)
          : null;
      }
    }
    return summaries;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    projects: result.value,
    actualsIncluded: result.actor?.permissions.has(PERMISSIONS.ledgerView) ?? false,
  });
});
