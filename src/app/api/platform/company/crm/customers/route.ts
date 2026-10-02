import { NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";
import { POSTING_ACCOUNTS } from "@/lib/platform-company-billing";
import { withPlatformScope } from "@/lib/platform-auth";
import type { PlatformCompanyCustomerSummary } from "@/lib/platform-company-types";

/**
 * The Platform Business CRM's customer projection.
 *
 * It is a *relationship* projection, not a copy of anyone's data: it joins the
 * internal company's own customer mapping to the platform relationship facts
 * (linked tenants, subscription state, the accounting balance) and refuses to
 * read a tenant's private records. No tenant CRM notes, no private documents,
 * no tenant ledger, no tenant orders, no tenant staff, and no merging of two
 * companies because an email or a phone happens to match.
 *
 * The cross-tenant read is deliberately narrow and runs in its own, separate
 * platform-bypass section — the documented shape
 * (authenticate platform actor → read the minimal cross-tenant fact → return to
 * the internal company's tenant scope), never a blanket bypass around the whole
 * handler.
 */
const TENANT_FACTS_SQL = `
  SELECT b.id AS tenant_id, b.name AS tenant_name,
         s.status AS subscription_status,
         w.balance_rial::text AS wallet_balance_rial,
         COALESCE((SELECT sum(i.total_rial - i.paid_rial) FROM billing_invoices i
                    WHERE i.business_id = b.id AND i.status IN ('open','partially_paid','overdue')), 0)::text
           AS open_invoice_rial,
         COALESCE((SELECT count(*) FROM support_tickets t WHERE t.business_id = b.id), 0)::int
           AS support_tickets
    FROM businesses b
    LEFT JOIN business_subscriptions s ON s.business_id = b.id
    LEFT JOIN business_wallets w ON w.business_id = b.id
   WHERE b.id = ANY($1::uuid[])
`;

export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.crmView, async (actor) => {
    // Phase 1 — everything the internal company owns, under its own tenant scope.
    const { rows } = await query<{
      id: string;
      party_id: string;
      legal_name: string;
      billing_customer_key: string;
      churn_risk: string;
      owner_name: string | null;
      tenant_ids: string[] | null;
      invoiced_rial: string | null;
      settled_rial: string | null;
      project_count: string | null;
    }>(
      // Aggregate each relationship independently, never tenant × event ×
      // project joins that multiply balances. Receivables come from the actual
      // posted journal lines, not whole-event amounts: a partially-paid void
      // credits only its outstanding portion to A/R; the paid part becomes a
      // wallet liability. Credits and positive adjustments follow the same
      // ledger projection without inventing another accounting rule here.
      `SELECT c.id, c.party_id, c.legal_name, c.billing_customer_key, c.churn_risk,
              u.full_name AS owner_name,
              COALESCE((SELECT array_agg(ct.customer_tenant_id ORDER BY ct.created_at)
                          FROM platform_company_customer_tenants ct
                         WHERE ct.customer_id = c.id AND ct.business_id = c.business_id), '{}')
                AS tenant_ids,
              COALESCE(ledger.debits, 0)::text AS invoiced_rial,
              COALESCE(ledger.credits, 0)::text AS settled_rial,
              COALESCE((SELECT count(*) FROM ai_projects pr
                         WHERE pr.business_id = c.business_id
                           AND pr.party_id = c.party_id), 0)::text AS project_count
         FROM platform_company_customers c
         LEFT JOIN users u ON u.id = c.account_owner_user_id AND u.business_id = c.business_id
         LEFT JOIN LATERAL (
           SELECT sum(jl.debit) AS debits, sum(jl.credit) AS credits
             FROM platform_company_customer_tenants ct
             JOIN platform_company_billing_events e
               ON e.internal_business_id = c.business_id
              AND e.customer_tenant_id = ct.customer_tenant_id
             JOIN platform_company_accounting_postings p
               ON p.event_id = e.id AND p.business_id = c.business_id
             JOIN journal_entries je
               ON je.id = p.journal_entry_id AND je.business_id = c.business_id
              AND je.posted_at IS NOT NULL
             JOIN journal_lines jl ON jl.entry_id = je.id
             JOIN accounts a ON a.id = jl.account_id AND a.business_id = c.business_id AND a.code = $2
            WHERE ct.customer_id = c.id AND ct.business_id = c.business_id
         ) ledger ON true
        WHERE c.business_id = $1
        ORDER BY c.legal_name, c.id`,
      [actor.businessId, POSTING_ACCOUNTS.receivable],
    );

    const { rows: dealRows } = await query<{
      id: string;
      customer_id: string;
      title: string;
      value_rial: string;
      outcome: string | null;
      project_id: string | null;
    }>(
      `SELECT d.id, d.customer_id, d.title, d.value_rial, s.outcome, pr.id AS project_id
         FROM crm_deals d
         LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id AND s.business_id = d.business_id
         LEFT JOIN ai_projects pr ON pr.business_id = d.business_id AND pr.source_deal_id = d.id
        WHERE d.business_id = $1
        ORDER BY d.updated_at DESC
        LIMIT 400`,
      [actor.businessId],
    );

    // Phase 2 — the minimal cross-tenant facts, in their own bypass section.
    const tenantIds = [...new Set(rows.flatMap((row) => row.tenant_ids ?? []))];
    const facts = new Map<
      string,
      {
        tenantName: string | null;
        subscriptionStatus: string | null;
        walletBalanceRial: number | null;
        openInvoiceRial: number;
        supportTickets: number;
      }
    >();
    if (tenantIds.length) {
      const { rows: factRows } = await withoutTenantScope("platform", () =>
        query<{
          tenant_id: string;
          tenant_name: string | null;
          subscription_status: string | null;
          wallet_balance_rial: string | null;
          open_invoice_rial: string;
          support_tickets: number;
        }>(TENANT_FACTS_SQL, [tenantIds]),
      );
      for (const row of factRows) {
        facts.set(row.tenant_id, {
          tenantName: row.tenant_name,
          subscriptionStatus: row.subscription_status,
          walletBalanceRial: row.wallet_balance_rial === null ? null : Number(row.wallet_balance_rial),
          openInvoiceRial: Number(row.open_invoice_rial),
          supportTickets: Number(row.support_tickets),
        });
      }
    }

    const customers: PlatformCompanyCustomerSummary[] = rows.map((row) => {
      const invoicedRial = Number(row.invoiced_rial ?? 0);
      const settledRial = Number(row.settled_rial ?? 0);
      return {
        id: row.id,
        partyId: row.party_id,
        legalName: row.legal_name,
        billingCustomerKey: row.billing_customer_key,
        churnRisk: row.churn_risk,
        accountOwner: row.owner_name,
        tenants: (row.tenant_ids ?? []).map((tenantId) => {
          const fact = facts.get(tenantId);
          return {
            tenantId,
            tenantName: fact?.tenantName ?? null,
            subscriptionStatus: fact?.subscriptionStatus ?? null,
            walletBalanceRial: fact?.walletBalanceRial ?? null,
            openInvoiceRial: fact?.openInvoiceRial ?? 0,
            supportTickets: fact?.supportTickets ?? 0,
          };
        }),
        // «مانده حسابداری» — computed only from successfully POSTED accounting
        // events, so it can never disagree with the ledger.
        accountingBalanceRial: invoicedRial - settledRial,
        invoicedRial,
        settledRial,
        deals: dealRows
          .filter((deal) => deal.customer_id === row.party_id)
          .slice(0, 10)
          .map((deal) => ({
            id: deal.id,
            title: deal.title,
            valueRial: Number(deal.value_rial),
            outcome: deal.outcome,
            projectId: deal.project_id,
          })),
        projectCount: Number(row.project_count ?? 0),
      };
    });
    return customers;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ customers: result.value, balanceSource: "accounting_postings" });
});
