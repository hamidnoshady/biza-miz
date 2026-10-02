/** Durable Billing Control Center -> internal-company Accounting bridge. */
import type { PoolClient } from "pg";
import { getPool, query, withTenant, withoutTenantScope } from "./db";

export const PLATFORM_COMPANY_BILLING_TICK_MS = 30_000;

type EventRow = {
  id: string; internal_business_id: string; source_kind: string; source_table: string;
  source_id: string; source_version: string; customer_tenant_id: string | null;
  amount_rial: string; payload: Record<string, unknown>; occurred_at: Date;
};

const RULES: Record<string, { debit: string; credit: string; name: string }> = {
  invoice_issued: { debit: "1200", credit: "4500", name: "صدور صورتحساب تجاری" },
  invoice_payment: { debit: "1110", credit: "1200", name: "وصول صورتحساب تجاری" },
  invoice_void: { debit: "4400", credit: "1200", name: "ابطال/اعتبار صورتحساب" },
  wallet_top_up: { debit: "1110", credit: "2455", name: "افزایش بدهی کیف پول مشتری" },
  wallet_spend: { debit: "2455", credit: "4500", name: "مصرف کیف پول مشتری" },
  wallet_refund: { debit: "4400", credit: "2455", name: "اعتبار بازپرداخت‌شده به کیف پول" },
  provider_cost: { debit: "5670", credit: "2100", name: "هزینه تأمین‌کننده پلتفرم" },
  adjustment: { debit: "5900", credit: "2100", name: "تعدیل تجاری" },
};

async function claim(limit: number): Promise<EventRow[]> {
  return withoutTenantScope("platform", async () => {
    // A worker killed after claiming is recoverable; no source is lost forever.
    await query(
      `UPDATE platform_company_billing_events
          SET status='failed',last_error='stale_processing_lease',available_at=now()
        WHERE status='processing' AND available_at < now()-interval '10 minutes'`,
    );
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<EventRow>(
        `SELECT id,internal_business_id,source_kind,source_table,source_id,source_version,
                customer_tenant_id,amount_rial,payload,occurred_at
           FROM platform_company_billing_events
          WHERE status IN ('pending','failed') AND available_at<=now() AND attempts<12
          ORDER BY occurred_at,id
          FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      if (rows.length) {
        await client.query(
          `UPDATE platform_company_billing_events
              SET status='processing',attempts=attempts+1,available_at=now()
            WHERE id=ANY($1::uuid[])`,
          [rows.map((row) => row.id)],
        );
      }
      await client.query("COMMIT");
      return rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

async function ensureCustomerMapping(event: EventRow): Promise<void> {
  if (!event.customer_tenant_id || event.source_kind === "provider_cost") return;
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`platform-company-customer:${event.customer_tenant_id}`]);
      const existing = await client.query(
        `SELECT 1 FROM platform_company_customer_tenants WHERE business_id=$1 AND customer_tenant_id=$2`,
        [event.internal_business_id, event.customer_tenant_id],
      );
      if (!existing.rows[0]) {
        const { rows: tenants } = await client.query<{ name: string }>(
          `SELECT name FROM businesses WHERE id=$1 AND ownership_kind='customer'`, [event.customer_tenant_id],
        );
        if (!tenants[0]) throw new Error("billing_customer_tenant_not_found");
        // Only the platform directory's legal display name crosses the boundary.
        // Tenant CRM, documents, contacts and ledger are never queried or copied.
        const { rows: parties } = await client.query<{ id: string }>(
          `INSERT INTO parties (business_id,name,role,person_type,notes)
           VALUES ($1,$2,'customer','legal','ایجاد خودکار از نگاشت صورتحساب پلتفرم') RETURNING id`,
          [event.internal_business_id, tenants[0].name],
        );
        const { rows: customers } = await client.query<{ id: string }>(
          `INSERT INTO platform_company_customers
             (business_id,party_id,legal_name,billing_customer_key)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id,billing_customer_key) DO UPDATE SET legal_name=EXCLUDED.legal_name
           RETURNING id`,
          [event.internal_business_id, parties[0].id, tenants[0].name, `tenant:${event.customer_tenant_id}`],
        );
        await client.query(
          `INSERT INTO platform_company_customer_tenants (business_id,customer_id,customer_tenant_id)
           VALUES ($1,$2,$3) ON CONFLICT (customer_id,customer_tenant_id) DO NOTHING`,
          [event.internal_business_id, customers[0].id, event.customer_tenant_id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  });
}

async function requireCustomerMapping(client: PoolClient, event: EventRow): Promise<void> {
  if (!event.customer_tenant_id || event.source_kind === "provider_cost") return;
  const { rows } = await client.query(
    `SELECT 1 FROM platform_company_customer_tenants
      WHERE business_id=$1 AND customer_tenant_id=$2`,
    [event.internal_business_id, event.customer_tenant_id],
  );
  if (!rows[0]) throw new Error("missing_customer_mapping");
}

async function postingRule(event: EventRow) {
  // Subscription renewal emits both the invoice-payment transition and its
  // wallet debit in one transaction. The invoice remains the revenue source;
  // the debit is settlement, not a second sale. Resolve settlement from the
  // authoritative wallet row under the worker's platform scope.
  if (event.source_kind === "wallet_spend") {
    const metadata = event.payload.metadata;
    if (metadata && typeof metadata === "object" && "invoiceId" in metadata && metadata.invoiceId) return null;
  }
  if (event.source_kind === "invoice_payment") {
    const { rows } = await withoutTenantScope("platform", () => query(
      `SELECT 1 FROM wallet_ledger WHERE metadata->>'invoiceId'=$1 LIMIT 1`,
      [event.source_id],
    ));
    if (rows[0]) return { debit: "2455", credit: "1200", name: "تسویه صورتحساب از کیف پول" };
  }
  return RULES[event.source_kind] ?? undefined;
}

async function postEvent(event: EventRow): Promise<"posted" | "ignored"> {
  if (event.source_kind === "wallet_noncash_credit" || Number(event.amount_rial) === 0) return "ignored";
  const rule = await postingRule(event);
  if (rule === null) return "ignored";
  if (!rule) throw new Error("missing_posting_rule");
  await ensureCustomerMapping(event);
  return withTenant(event.internal_business_id, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query(
        `SELECT 1 FROM platform_company_accounting_postings WHERE event_id=$1`, [event.id],
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return "posted" as const;
      }
      await requireCustomerMapping(client, event);
      const { rows: accountRows } = await client.query<{ id: string; code: string }>(
        `SELECT id,code FROM accounts WHERE business_id=$1 AND code=ANY($2::text[]) AND is_active`,
        [event.internal_business_id, [rule.debit, rule.credit]],
      );
      const accounts = new Map(accountRows.map((row) => [row.code, row.id]));
      if (!accounts.has(rule.debit) || !accounts.has(rule.credit)) throw new Error("missing_account_mapping");
      const { rows: entryRows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (business_id,entry_date,memo,source_type,source_id,created_by)
         VALUES ($1,$2,$3,'platform_billing',$4,$5) RETURNING id`,
        [
          event.internal_business_id,
          event.occurred_at.toISOString().slice(0, 10),
          `${rule.name} — ${event.source_table}:${event.source_id}`,
          event.id,
          null,
        ],
      );
      const amount = event.amount_rial;
      await client.query(
        `INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES
          ($1,$2,$4,0),($1,$3,0,$4)`,
        [entryRows[0].id, accounts.get(rule.debit), accounts.get(rule.credit), amount],
      );
      await client.query(
        `INSERT INTO platform_company_accounting_postings
          (business_id,event_id,source_reference,journal_entry_id,posting_rule,amount_rial)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [event.internal_business_id, event.id, `${event.source_table}:${event.source_id}:${event.source_version}`, entryRows[0].id, event.source_kind, amount],
      );
      await client.query("COMMIT");
      return "posted" as const;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function runPlatformCompanyBillingTick(limit = 30) {
  const events = await claim(Math.min(Math.max(limit, 1), 100));
  let posted = 0, ignored = 0, failed = 0;
  for (const event of events) {
    try {
      const outcome = await postEvent(event);
      await withoutTenantScope("platform", () => query(
        `UPDATE platform_company_billing_events
            SET status=$2,last_error=NULL,posted_at=now()
          WHERE id=$1`, [event.id, outcome],
      ));
      if (outcome === "posted") posted++;
      else ignored++;
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message.slice(0, 500) : "unknown_error";
      await withoutTenantScope("platform", () => query(
        `UPDATE platform_company_billing_events
            SET status='failed',last_error=$2,
                available_at=now()+(LEAST(attempts,8)*interval '1 minute')
          WHERE id=$1`, [event.id, message],
      ));
    }
  }
  return { checked: events.length, posted, ignored, failed };
}

export async function billingReconciliation(businessId: string) {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string; source_kind: string; source_table: string; source_id: string; source_version: string;
      amount_rial: string; status: string; attempts: number; last_error: string | null;
      occurred_at: Date; posted_at: Date | null; journal_entry_id: string | null;
    }>(
      `SELECT e.id,e.source_kind,e.source_table,e.source_id,e.source_version,e.amount_rial,
              e.status,e.attempts,e.last_error,e.occurred_at,e.posted_at,p.journal_entry_id
         FROM platform_company_billing_events e
         LEFT JOIN platform_company_accounting_postings p ON p.event_id=e.id
        WHERE e.internal_business_id=$1 ORDER BY e.occurred_at DESC LIMIT 200`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id, kind: row.source_kind, source: `${row.source_table}:${row.source_id}`,
      version: row.source_version, amountRial: Number(row.amount_rial), status: row.status,
      attempts: row.attempts, error: row.last_error,
      occurredAt: row.occurred_at.toISOString(), postedAt: row.posted_at?.toISOString() ?? null,
      journalEntryId: row.journal_entry_id,
    }));
  });
}

export async function retryBillingEvent(businessId: string, eventId: string): Promise<boolean> {
  const { rows } = await withoutTenantScope("platform", () => query<{ id: string }>(
    `UPDATE platform_company_billing_events
        SET status='pending',available_at=now(),last_error=NULL
      WHERE id=$1 AND internal_business_id=$2 AND status='failed' RETURNING id`,
    [eventId, businessId],
  ));
  return Boolean(rows[0]);
}
