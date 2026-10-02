/**
 * Read-only Platform Business health check, with an explicitly-requested repair
 * mode.
 *
 * Diagnosing an already-deployed system is the first thing an operator needs
 * after a bad rollout and the last thing they should be able to do by accident,
 * so the default run changes nothing at all. `--apply` runs only the repairs
 * that are deterministic and non-destructive (missing entitlements, missing app
 * availability, a subscription row left auto-renewing); everything that needs a
 * judgement call is reported for a human to decide.
 *
 * It never deletes a posted journal entry, a customer mapping, a billing event
 * or a credential, and it never re-runs opening balances.
 */
import { query, withoutTenantScope, closeDatabasePool } from "../src/lib/db";

const REPAIRABLE = ["entitlements", "app_availability", "auto_renew"] as const;
type Repairable = (typeof REPAIRABLE)[number];

function flag(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const only = flag("repair");
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      `Usage: tsx scripts/platform-company-health.ts [--apply] [--repair=${REPAIRABLE.join("|")}]\n` +
        "Default is read-only. --apply performs only deterministic, non-destructive repairs.",
    );
    return;
  }
  const repairs: Repairable[] =
    only && (REPAIRABLE as readonly string[]).includes(only) ? [only as Repairable] : [...REPAIRABLE];
  const actor = flag("actor") ?? null;

  const report = await withoutTenantScope("platform", async () => {
    const { rows: companies } = await query<{
      id: string; name: string; subdomain: string; status: string; industry: string; created_at: Date;
    }>(
      `SELECT id, name, subdomain::text, status, industry, created_at
         FROM businesses WHERE ownership_kind = 'platform_internal'`,
    );

    const out: Record<string, unknown> = {
      mode: apply ? "apply" : "read-only",
      internalCompanyCount: companies.length,
      company: companies[0]
        ? {
            id: companies[0].id,
            name: companies[0].name,
            subdomain: companies[0].subdomain,
            status: companies[0].status,
            industry: companies[0].industry,
            createdAt: companies[0].created_at.toISOString(),
          }
        : null,
    };
    const companyId = companies[0]?.id ?? null;
    if (!companyId) {
      out.note = "The internal company is not provisioned. Run POST /api/platform/company/setup.";
      return out;
    }

    const scalar = async (sql: string, params: unknown[] = []): Promise<number> => {
      const { rows } = await query<{ value: string }>(sql, params);
      return Number(rows[0]?.value ?? 0);
    };

    const { rows: entitlements } = await query<{ capability: string; enabled: boolean }>(
      `SELECT capability, enabled FROM platform_company_entitlements
        WHERE business_id = $1 ORDER BY capability`,
      [companyId],
    );
    const { rows: availability } = await query<{ app_key: string; state: string }>(
      `SELECT app_key, state FROM business_app_availability WHERE business_id = $1 ORDER BY app_key`,
      [companyId],
    );
    const { rows: members } = await query<{
      platform_admin_id: string; full_name: string; access_preset: string;
      is_active: boolean; user_active: boolean | null;
    }>(
      `SELECT m.platform_admin_id, u.full_name, m.access_preset, m.is_active, u.is_active AS user_active
         FROM platform_company_members m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.business_id = $1 ORDER BY m.created_at`,
      [companyId],
    );
    const { rows: events } = await query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM platform_company_billing_events
        WHERE internal_business_id = $1 GROUP BY status ORDER BY status`,
      [companyId],
    );
    const { rows: failedKinds } = await query<{ failure_kind: string; count: string }>(
      `SELECT COALESCE(failure_kind, 'unknown') AS failure_kind, count(*)::text AS count
         FROM platform_company_billing_events
        WHERE internal_business_id = $1 AND status = 'failed' GROUP BY 1 ORDER BY 1`,
      [companyId],
    );

    out.entitlements = entitlements;
    out.appAvailability = availability;
    out.members = members.map((row) => ({
      platformAdminId: row.platform_admin_id,
      fullName: row.full_name,
      preset: row.access_preset,
      membershipActive: row.is_active,
      tenantUserActive: row.user_active ?? false,
    }));
    out.brokenMappings = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_members m
         LEFT JOIN users u ON u.id = m.user_id AND u.business_id = m.business_id
        WHERE m.business_id = $1 AND u.id IS NULL`,
      [companyId],
    );
    out.orphanCustomerMappings = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_customer_tenants t
        WHERE t.business_id = $1
          AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = t.customer_tenant_id AND b.ownership_kind = 'customer')`,
      [companyId],
    );
    // A party shared by two company customers is a real defect — the
    // (business_id, party_id) unique key makes it impossible, so any non-zero
    // value here means that constraint is gone. Two customers sharing a LEGAL
    // NAME, on the other hand, is normal («کافه نادری» is not a rare name) and
    // is reported separately as information, not as a defect.
    out.sharedParties = await scalar(
      `SELECT COALESCE(sum(c - 1), 0)::text AS value FROM (
         SELECT count(*) AS c FROM platform_company_customers
          WHERE business_id = $1 GROUP BY party_id HAVING count(*) > 1) dup`,
      [companyId],
    );
    out.sameNameParties = await scalar(
      `SELECT count(*)::text AS value FROM (
         SELECT 1 FROM parties p
           JOIN platform_company_customers c ON c.party_id = p.id AND c.business_id = p.business_id
          WHERE p.business_id = $1 GROUP BY p.name HAVING count(*) > 1) same_name`,
      [companyId],
    );
    out.missingAccounts = await scalar(
      `SELECT (5 - count(DISTINCT a.code))::text AS value FROM accounts a
        WHERE a.business_id = $1 AND a.is_active
          AND a.code = ANY(ARRAY['1110','1200','2100','2455','4500'])`,
      [companyId],
    );
    out.invalidProjectLinks = await scalar(
      `SELECT count(*)::text AS value FROM workspace_project_links l
        WHERE l.business_id = $1
          AND NOT EXISTS (SELECT 1 FROM ai_projects p WHERE p.id = l.project_id AND p.business_id = l.business_id)`,
      [companyId],
    );
    out.siteCredentials = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_site_credentials WHERE business_id = $1`,
      [companyId],
    );
    out.activeSiteCredentials = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_site_credentials
        WHERE business_id = $1 AND is_active`,
      [companyId],
    );
    out.unresolvedLeads = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_web_leads
        WHERE business_id = $1 AND lead_id IS NULL`,
      [companyId],
    );
    out.accountingPostings = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings WHERE business_id = $1`,
      [companyId],
    );
    out.postedJournalEntries = await scalar(
      `SELECT count(*)::text AS value FROM journal_entries
        WHERE business_id = $1 AND source_type = 'platform_billing'`,
      [companyId],
    );
    out.billingEvents = Object.fromEntries(events.map((row) => [row.status, Number(row.count)]));
    out.failedByKind = Object.fromEntries(failedKinds.map((row) => [row.failure_kind, Number(row.count)]));
    out.autoRenewSubscriptionRows = await scalar(
      `SELECT count(*)::text AS value FROM business_subscriptions WHERE business_id = $1 AND auto_renew`,
      [companyId],
    );

    if (apply) {
      const applied: string[] = [];
      if (repairs.includes("entitlements")) {
        await query(
          `INSERT INTO platform_company_entitlements (business_id, capability)
           SELECT $1, unnest(ARRAY['accounting','crm','growth','website','workspace'])
           ON CONFLICT (business_id, capability) DO UPDATE SET enabled = true`,
          [companyId],
        );
        applied.push("entitlements");
      }
      if (repairs.includes("app_availability") && actor) {
        await query(
          `INSERT INTO business_app_availability (business_id, app_key, state, note, updated_by)
           SELECT $1, unnest(ARRAY['accounting','crm','growth','website']), 'available',
                  'ترمیم توسط بررسی سلامت', $2
           ON CONFLICT (business_id, app_key) DO UPDATE SET state = 'available', updated_at = now()`,
          [companyId, actor],
        );
        applied.push("app_availability");
      }
      if (repairs.includes("auto_renew")) {
        await query(
          `UPDATE business_subscriptions SET auto_renew = false, updated_at = now()
            WHERE business_id = $1 AND auto_renew`,
          [companyId],
        );
        applied.push("auto_renew");
      }
      out.appliedRepairs = applied;
      out.note =
        "Only deterministic repairs were applied. Nothing was deleted; unresolved accounting " +
        "failures still need an explicit reversing document, not a rewrite.";
    }
    return out;
  });

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
