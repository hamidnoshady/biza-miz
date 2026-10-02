/**
 * Explicit historical Billing -> company Accounting backfill.
 * Dry-run is the default. Nothing is enqueued without --apply and --cutoff.
 */
import { query, withoutTenantScope, closeDatabasePool } from "../src/lib/db";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const cutoff = arg("cutoff");
  const apply = process.argv.includes("--apply");
  if (!cutoff || Number.isNaN(Date.parse(cutoff))) {
    throw new Error("A valid --cutoff=ISO timestamp is required; historical scope must be explicit.");
  }
  await withoutTenantScope("platform", async () => {
    const { rows: companyRows } = await query<{ id: string }>(
      `SELECT id FROM businesses WHERE ownership_kind='platform_internal'`,
    );
    const companyId = companyRows[0]?.id;
    if (!companyId) throw new Error("platform company is not provisioned");
    const { rows } = await query<{ invoices: string; wallet: string; costs: string }>(
      `SELECT
        (SELECT count(*)::text FROM billing_invoices WHERE created_at <= $1 AND status <> 'draft') invoices,
        (SELECT count(*)::text FROM wallet_ledger WHERE created_at <= $1) wallet,
        (SELECT count(*)::text FROM billing_vendor_cost_events WHERE occurred_at <= $1) costs`,
      [cutoff],
    );
    console.log(JSON.stringify({ dryRun: !apply, cutoff, candidates: rows[0] }, null, 2));
    if (!apply) return;

    await query(
      `INSERT INTO platform_company_billing_events
        (internal_business_id,source_kind,source_table,source_id,source_version,customer_tenant_id,amount_rial,payload,occurred_at)
       SELECT $1,'invoice_issued','billing_invoices',id::text,'backfill:issued',business_id,total_rial,
              jsonb_build_object('invoiceNumber',invoice_number,'backfill',true),created_at
         FROM billing_invoices WHERE created_at <= $2 AND status <> 'draft'
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff],
    );
    await query(
      `INSERT INTO platform_company_billing_events
        (internal_business_id,source_kind,source_table,source_id,source_version,customer_tenant_id,amount_rial,payload,occurred_at)
       SELECT $1,
              CASE WHEN kind='top_up' THEN 'wallet_top_up'
                   WHEN kind IN ('admin_grant','free_promo') THEN 'wallet_noncash_credit'
                   WHEN kind='refund' AND direction='credit' THEN 'wallet_refund'
                   WHEN direction='debit' THEN 'wallet_spend' ELSE 'adjustment' END,
              'wallet_ledger',id::text,'backfill:created',business_id,amount_rial,
              jsonb_build_object('kind',kind,'direction',direction,'paymentId',payment_id,'metadata',metadata,'backfill',true),created_at
         FROM wallet_ledger WHERE created_at <= $2
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff],
    );
    await query(
      `INSERT INTO platform_company_billing_events
        (internal_business_id,source_kind,source_table,source_id,source_version,customer_tenant_id,amount_rial,payload,occurred_at)
       SELECT $1,'provider_cost','billing_vendor_cost_events',id::text,'backfill:created',business_id,amount_rial,
              jsonb_build_object('provider',provider,'meterKey',meter_key,'backfill',true),occurred_at
         FROM billing_vendor_cost_events WHERE occurred_at <= $2
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff],
    );
    console.log("Historical events enqueued. The normal reconciliation worker will validate mappings and post them.");
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDatabasePool());
