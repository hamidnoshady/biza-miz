/**
 * Explicit historical Billing → company Accounting backfill.
 *
 * Dry-run is the default: `--apply` is required before a single row is written.
 * It is never run as part of a migration, application startup or deployment —
 * the maintenance guide says to run it by hand, look at the candidate counts,
 * and only then apply.
 *
 * The event model here is deliberately the SAME one live operation produces
 * (see `src/lib/platform-company-billing.ts` and migration 0193): wallet debits
 * carrying `metadata.invoiceId` and verified `billing_payments` rows are the
 * authoritative settlements, and the invoice only contributes the residual
 * `paid_rial` no settlement record accounts for. A historical replay that used
 * a looser model would produce a different ledger from the same facts, which is
 * exactly the kind of second accounting model this file exists to prevent.
 *
 * Every insert is keyed by `source_table/source_id/source_version` and uses
 * `ON CONFLICT DO NOTHING`, so a repeated run — with a wider window, or after a
 * partial failure — cannot double-enqueue.
 */
import { query, withoutTenantScope, closeDatabasePool } from "../src/lib/db";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function usage(): never {
  throw new Error(
    "Usage: platform-company:billing-backfill --cutoff=<ISO> [--from=<ISO>] [--apply]\n" +
      "  --cutoff  end of the historical window (required, must be a valid ISO timestamp)\n" +
      "  --from    start of the historical window (optional; default: no lower bound)\n" +
      "  --apply   actually enqueue. Without it the run is a dry-run and writes nothing.\n\n" +
      "Never run this as part of a migration, startup or deployment.",
  );
}

async function main() {
  const cutoff = arg("cutoff");
  const from = arg("from");
  const apply = process.argv.includes("--apply");
  if (!cutoff || Number.isNaN(Date.parse(cutoff))) usage();
  if (from && Number.isNaN(Date.parse(from))) usage();
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  await withoutTenantScope("platform", async () => {
    const { rows: companyRows } = await query<{ id: string }>(
      `SELECT id FROM businesses WHERE ownership_kind='platform_internal'`,
    );
    const companyId = companyRows[0]?.id;
    if (!companyId) throw new Error("platform company is not provisioned");

    const windowFrom = from ?? "1970-01-01T00:00:00Z";
    const candidates = await query<{ label: string; count: string }>(
      `SELECT 'invoices' AS label,
              (SELECT count(*)::text FROM billing_invoices
                WHERE created_at > $2::timestamptz AND created_at <= $1::timestamptz AND status <> 'draft')
       UNION ALL SELECT 'wallet_settlements',
              (SELECT count(*)::text FROM wallet_ledger
                WHERE created_at > $2::timestamptz AND created_at <= $1::timestamptz
                  AND direction='debit' AND metadata->>'invoiceId' IS NOT NULL)
       UNION ALL SELECT 'wallet_other',
              (SELECT count(*)::text FROM wallet_ledger
                WHERE created_at > $2::timestamptz AND created_at <= $1::timestamptz
                  AND NOT (direction='debit' AND metadata->>'invoiceId' IS NOT NULL))
       UNION ALL SELECT 'invoice_voids',
              (SELECT count(*)::text FROM billing_invoices
                WHERE updated_at > $2::timestamptz AND updated_at <= $1::timestamptz AND status='void')
       UNION ALL SELECT 'verified_payments',
              (SELECT count(*)::text FROM billing_payments
                WHERE verified_at IS NOT NULL AND verified_at > $2::timestamptz
                  AND verified_at <= $1::timestamptz AND invoice_id IS NOT NULL)
       UNION ALL SELECT 'adjustments',
              (SELECT count(*)::text FROM billing_adjustments
                WHERE created_at > $2::timestamptz AND created_at <= $1::timestamptz AND invoice_id IS NOT NULL)
       UNION ALL SELECT 'provider_costs',
              (SELECT count(*)::text FROM billing_vendor_cost_events
                WHERE occurred_at > $2::timestamptz AND occurred_at <= $1::timestamptz)`,
      [cutoff, windowFrom],
    );
    console.log(
      JSON.stringify(
        {
          dryRun: !apply,
          companyId,
          from: from ?? null,
          cutoff,
          candidates: Object.fromEntries(candidates.rows.map((row) => [row.label, Number(row.count)])),
        },
        null,
        2,
      ),
    );
    if (!apply) {
      console.log("Dry run only. Re-run with --apply to enqueue these events.");
      return;
    }

    // Every statement below uses the SAME source_version the live triggers in
    // migration 0193 use, so a replay of an already-covered fact is a strict
    // no-op instead of a second event. Where the live trigger clips an amount
    // to what is still outstanding, the backfill clips it with the same helper
    // (`platform_company_invoice_settled_rial`), so a replayed settlement is
    // byte-identical to the one live operation would have emitted.
    //
    //   1. Invoice issue.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, customer_invoice_id)
       SELECT $1,'invoice_issued','billing_invoices',id::text,'issued',business_id,total_rial,
              jsonb_build_object('invoiceNumber',invoice_number,'invoiceId',id,'backfill',true),created_at,id
         FROM billing_invoices
        WHERE created_at > $3::timestamptz AND created_at <= $2::timestamptz AND status <> 'draft'
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   2. Wallet debits carrying an invoice id — the authoritative settlement.
    //      A debit whose invoice no longer exists is an unattributable
    //      adjustment, exactly as the live trigger classifies it: recorded,
    //      visible, and not posted.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, settlement_method, customer_invoice_id)
       SELECT $1,'invoice_payment','wallet_ledger',w.id::text,'invoice-settlement',w.business_id,
              LEAST(w.amount_rial, GREATEST(i.total_rial
                     - platform_company_invoice_settled_rial(w.business_id, (w.metadata->>'invoiceId')::uuid)
                     + w.amount_rial, 0)),
              jsonb_build_object('invoiceId',(w.metadata->>'invoiceId')::uuid,'walletLedgerId',w.id,
                                 'kind',w.kind,'settlement','wallet','backfill',true),
              w.created_at,'wallet',(w.metadata->>'invoiceId')::uuid
         FROM wallet_ledger w
         JOIN billing_invoices i ON i.id = (w.metadata->>'invoiceId')::uuid
        WHERE w.created_at > $3::timestamptz AND w.created_at <= $2::timestamptz
          AND w.direction='debit' AND w.metadata->>'invoiceId' IS NOT NULL
          AND w.metadata->>'invoiceId' ~ '^[0-9a-fA-F-]{36}$'
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at)
       SELECT $1,'adjustment','wallet_ledger',w.id::text,'created',w.business_id,w.amount_rial,
              jsonb_build_object('kind',w.kind,'direction',w.direction,'invoiceId',w.metadata->>'invoiceId',
                                 'reason','wallet_debit_with_unknown_invoice','backfill',true),w.created_at
         FROM wallet_ledger w
        WHERE w.created_at > $3::timestamptz AND w.created_at <= $2::timestamptz
          AND w.direction='debit' AND w.metadata->>'invoiceId' IS NOT NULL
          AND w.metadata->>'invoiceId' ~ '^[0-9a-fA-F-]{36}$'
          AND NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.id = (w.metadata->>'invoiceId')::uuid)
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   3. Every other wallet movement.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at)
       SELECT $1,
              CASE WHEN kind='top_up' THEN 'wallet_top_up'
                   WHEN kind IN ('admin_grant','free_promo') THEN 'wallet_noncash_credit'
                   WHEN kind='refund' AND direction='credit' THEN 'wallet_refund'
                   WHEN direction='debit' THEN 'wallet_spend' ELSE 'adjustment' END,
              'wallet_ledger',id::text,'created',business_id,amount_rial,
              jsonb_build_object('kind',kind,'direction',direction,'paymentId',payment_id,
                                 'metadata',metadata,'backfill',true),created_at
         FROM wallet_ledger
        WHERE created_at > $3::timestamptz AND created_at <= $2::timestamptz
          AND NOT (direction='debit' AND metadata->>'invoiceId' IS NOT NULL
                   AND metadata->>'invoiceId' ~ '^[0-9a-fA-F-]{36}$')
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   4. Verified gateway/manual payments against an invoice.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, settlement_method, customer_invoice_id)
       SELECT $1,'invoice_payment','billing_payments',p.id::text,'settlement:verified',p.business_id,
              LEAST(p.amount_rial, GREATEST(i.total_rial
                     - platform_company_invoice_settled_rial(p.business_id, p.invoice_id)
                     + p.amount_rial, 0)),
              jsonb_build_object('invoiceId',p.invoice_id,'paymentId',p.id,'gateway',p.gateway,
                                 'settlement',CASE WHEN p.gateway='manual' THEN 'manual' ELSE 'gateway' END,
                                 'backfill',true),
              COALESCE(p.verified_at, now()),
              CASE WHEN p.gateway='manual' THEN 'manual' ELSE 'gateway' END, p.invoice_id
         FROM billing_payments p
         JOIN billing_invoices i ON i.id = p.invoice_id
        WHERE p.status='verified' AND p.verified_at IS NOT NULL AND p.verified_at > $3::timestamptz
          AND p.verified_at <= $2::timestamptz AND p.invoice_id IS NOT NULL
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   5. The residual the invoice itself owes, when no settlement record
    //      accounts for part of `paid_rial`.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, settlement_method, customer_invoice_id)
       SELECT $1,'invoice_payment','billing_invoices',i.id::text,'paid:'||i.paid_rial::text,i.business_id,
              i.paid_rial - platform_company_invoice_settled_rial(i.business_id, i.id),
              jsonb_build_object('invoiceId',i.id,'paidTotalRial',i.paid_rial,
                                 'settledBySourceRial',platform_company_invoice_settled_rial(i.business_id, i.id),
                                 'settlement','residual','backfill',true),
              COALESCE(i.updated_at, now()),'other',i.id
         FROM billing_invoices i
        WHERE i.updated_at > $3::timestamptz AND i.updated_at <= $2::timestamptz
          AND i.paid_rial > platform_company_invoice_settled_rial(i.business_id, i.id)
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   6. Voids, carrying the paid/outstanding split the posting rule needs.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, customer_invoice_id)
       SELECT $1,'invoice_void','billing_invoices',id::text,'void',business_id,total_rial,
              jsonb_build_object('invoiceId',id,'totalRial',total_rial,'paidRial',paid_rial,
                                 'outstandingRial',GREATEST(total_rial-paid_rial,0),'backfill',true),
              updated_at,id
         FROM billing_invoices
        WHERE updated_at > $3::timestamptz AND updated_at <= $2::timestamptz AND status='void'
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   7. Commercial adjustments: negative is a credit note.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, customer_invoice_id)
       SELECT $1,
              CASE WHEN amount_rial < 0 THEN 'credit_note' ELSE 'adjustment' END,
              'billing_adjustments',id::text,'created',business_id,abs(amount_rial),
              jsonb_build_object('invoiceId',invoice_id,'reason',reason,'backfill',true),created_at,invoice_id
         FROM billing_adjustments
        WHERE created_at > $3::timestamptz AND created_at <= $2::timestamptz AND invoice_id IS NOT NULL
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    //   8. Provider cost.
    await query(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at)
       SELECT $1,'provider_cost','billing_vendor_cost_events',id::text,'created',business_id,amount_rial,
              jsonb_build_object('provider',provider,'meterKey',meter_key,'backfill',true),occurred_at
         FROM billing_vendor_cost_events
        WHERE occurred_at > $3::timestamptz AND occurred_at <= $2::timestamptz
       ON CONFLICT (source_table,source_id,source_version) DO NOTHING`,
      [companyId, cutoff, windowFrom],
    );

    const { rows: enqueued } = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_company_billing_events
        WHERE payload->>'backfill' = 'true'`,
    );
    console.log(
      JSON.stringify(
        { applied: true, cutoff, from: from ?? null, backfilledEvents: Number(enqueued[0]?.count ?? 0) },
        null,
        2,
      ),
    );
    console.log("Historical events enqueued. The normal reconciliation worker will post them.");
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
