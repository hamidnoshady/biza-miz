import { NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";

/** Read-only CRM projection. Balances are derived only from posted Accounting events. */
export async function GET() {
  const result = await withPlatformCompany(PERMISSIONS.crmView, async (actor) => withoutTenantScope("platform", async () => {
    const { rows } = await query(
      `SELECT c.id,c.legal_name,c.billing_customer_key,c.churn_risk,c.party_id,
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'tenantId',ct.customer_tenant_id,
                'supportReferences',COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'ticketId',st.id,'status',st.status,'updatedAt',st.updated_at
                ) ORDER BY st.updated_at DESC) FROM support_tickets st
                  WHERE st.business_id=ct.customer_tenant_id),'[]'::jsonb)
              )) FILTER (WHERE ct.customer_tenant_id IS NOT NULL),'[]'::jsonb) AS tenants,
              COALESCE(sum(CASE
                WHEN e.source_kind='invoice_issued' THEN p.amount_rial
                WHEN e.source_kind IN ('invoice_payment','invoice_void') THEN -p.amount_rial
                ELSE 0 END),0)::text AS accounting_balance_rial
         FROM platform_company_customers c
         LEFT JOIN platform_company_customer_tenants ct ON ct.customer_id=c.id
         LEFT JOIN platform_company_billing_events e ON e.customer_tenant_id=ct.customer_tenant_id
         LEFT JOIN platform_company_accounting_postings p ON p.event_id=e.id AND p.business_id=c.business_id
        WHERE c.business_id=$1
        GROUP BY c.id,c.legal_name,c.billing_customer_key,c.churn_risk,c.party_id
        ORDER BY c.legal_name,c.id`, [actor.businessId],
    );
    return rows;
  }));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ customers: result.value, balanceSource: "accounting_postings" });
}
