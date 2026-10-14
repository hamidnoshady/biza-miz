import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import type { PlatformCompanyDealSummary } from "@/lib/platform-company-types";

/**
 * The internal company's own CRM deals, with the Workspace link already made
 * for each one.
 *
 * This is the caller the deal→project endpoint was missing: the Platform
 * Business CRM page lists a won deal and offers «ایجاد پروژه», which posts to
 * `/api/platform/company/workspace/from-deal`. It reads the SAME `crm_deals`
 * table the shared CRM engine writes — there is no second pipeline — and adds
 * only the platform relationship facts (the linked project) on top.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.crmView, async (actor) => {
    const { rows } = await query<{
      id: string;
      title: string;
      value_rial: string;
      outcome: string | null;
      stage_name: string | null;
      customer_name: string | null;
      closed_at: Date | null;
      project_id: string | null;
      project_name: string | null;
    }>(
      `SELECT d.id, d.title, d.value_rial, st.outcome, st.name AS stage_name,
              p.name AS customer_name, d.closed_at,
              pr.id AS project_id, pr.name AS project_name
         FROM crm_deals d
         LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id AND st.business_id = d.business_id
         LEFT JOIN parties p ON p.id = d.customer_id AND p.business_id = d.business_id
         LEFT JOIN ai_projects pr ON pr.business_id = d.business_id AND pr.source_deal_id = d.id
        WHERE d.business_id = $1
        ORDER BY d.updated_at DESC
        LIMIT 200`,
      [actor.businessId],
    );
    const deals: PlatformCompanyDealSummary[] = rows.map((row) => {
      const won = row.outcome === "won";
      return {
        id: row.id,
        title: row.title,
        valueRial: Number(row.value_rial ?? 0),
        outcome: row.outcome,
        stageName: row.stage_name,
        customerName: row.customer_name,
        closedAt: row.closed_at ? row.closed_at.toISOString() : null,
        projectId: row.project_id,
        projectName: row.project_name,
        eligible: won && !row.project_id,
        ineligibleReason: !won
          ? "deal_not_won"
          : row.project_id
            ? "project_already_exists"
            : null,
      };
    });
    return deals;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ deals: result.value });
});
