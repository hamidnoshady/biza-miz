import { NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { consentCoverage } from "@/lib/crm-service";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";

export interface GrowthAudienceSummary {
  leads: { total: number; byStatus: Record<string, number>; websiteLeads: number; unconverted: number };
  consent: { sms: number; email: number; partiesWithConsent: number };
  customers: { total: number; byChurnRisk: Record<string, number> };
  campaigns: { total: number; draft: number; sending: number; completed: number };
  renewalCandidates: {
    tenantId: string;
    tenantName: string | null;
    periodEnd: string | null;
    daysLeft: number | null;
  }[];
}

/**
 * A read-only audience/operations summary for the Platform Business Growth
 * landing page.
 *
 * It reports on the SAME engines the shared Growth app writes — CRM leads and
 * consent, message campaigns — and adds the platform relationship facts the
 * tenant engine cannot see: mapped platform customers by churn risk, and tenants
 * whose subscription period is about to end.
 *
 * Nothing here sends anything. Campaign activation stays an explicit act inside
 * the shared Growth engine, and no migration, setup, backfill or deployment
 * enqueues a send.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.growthView, async (actor) => {
    const { rows: leadRows } = await query<{ status: string; source: string; count: string }>(
      `SELECT status, source, count(*)::text AS count
         FROM crm_leads WHERE business_id = $1
        GROUP BY status, source`,
      [actor.businessId],
    );
    // The audit trail records past grants AND revocations. The shared CRM
    // engine reads current flags on live, unmerged customer parties instead.
    const consent = await consentCoverage(actor.businessId);
    const { rows: customerRows } = await query<{ churn_risk: string; count: string }>(
      `SELECT churn_risk, count(*)::text AS count
         FROM platform_company_customers WHERE business_id = $1
        GROUP BY churn_risk`,
      [actor.businessId],
    );
    const { rows: campaignRows } = await query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM message_campaigns WHERE business_id = $1
        GROUP BY status`,
      [actor.businessId],
    );

    // The one cross-tenant read: which mapped customer tenants come up for
    // renewal soon. Business name and period end only — nothing else.
    const { rows: tenantRows } = await query<{ customer_tenant_id: string }>(
      `SELECT customer_tenant_id FROM platform_company_customer_tenants
        WHERE business_id = $1`,
      [actor.businessId],
    );
    const tenantIds = tenantRows.map((row) => row.customer_tenant_id);
    let renewalCandidates: GrowthAudienceSummary["renewalCandidates"] = [];
    if (tenantIds.length) {
      const { rows } = await withoutTenantScope("platform", () =>
        query<{ tenant_id: string; tenant_name: string | null; period_end: Date | null }>(
          `SELECT b.id AS tenant_id, b.name AS tenant_name, s.current_period_end AS period_end
             FROM businesses b
             JOIN business_subscriptions s ON s.business_id = b.id
            WHERE b.id = ANY($1::uuid[])
              AND b.status = 'active'
              AND s.status IN ('active', 'trialing', 'past_due')
              AND NOT s.cancel_at_period_end
              AND s.current_period_end >= now()
              AND s.current_period_end <= now() + interval '14 days'
            ORDER BY s.current_period_end`,
          [tenantIds],
        ),
      );
      renewalCandidates = rows.map((row) => {
        const periodEnd = row.period_end ? row.period_end.toISOString() : null;
        const daysLeft = periodEnd
          ? Math.ceil((Date.parse(periodEnd) - Date.now()) / 86_400_000)
          : null;
        return { tenantId: row.tenant_id, tenantName: row.tenant_name, periodEnd, daysLeft };
      });
    }

    const byStatus: Record<string, number> = {};
    let websiteLeads = 0;
    let unconverted = 0;
    let leadsTotal = 0;
    for (const row of leadRows) {
      const count = Number(row.count);
      leadsTotal += count;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
      if (row.source === "website") websiteLeads += count;
      if (row.status !== "converted") unconverted += count;
    }
    const byChurnRisk: Record<string, number> = {};
    let customersTotal = 0;
    for (const row of customerRows) {
      const count = Number(row.count);
      customersTotal += count;
      byChurnRisk[row.churn_risk] = (byChurnRisk[row.churn_risk] ?? 0) + count;
    }
    const campaignCounts: Record<string, number> = {};
    let campaignsTotal = 0;
    for (const row of campaignRows) {
      const count = Number(row.count);
      campaignsTotal += count;
      campaignCounts[row.status] = (campaignCounts[row.status] ?? 0) + count;
    }

    const summary: GrowthAudienceSummary = {
      leads: { total: leadsTotal, byStatus, websiteLeads, unconverted },
      consent: {
        sms: consent.smsGranted,
        email: consent.emailGranted,
        partiesWithConsent: consent.partiesWithConsent,
      },
      customers: { total: customersTotal, byChurnRisk },
      campaigns: {
        total: campaignsTotal,
        draft: campaignCounts.draft ?? 0,
        sending: campaignCounts.sending ?? 0,
        completed: campaignCounts.completed ?? 0,
      },
      renewalCandidates,
    };
    return summary;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ audience: result.value });
});
