/**
 * Durable Billing Control Center → internal-company Accounting bridge.
 *
 * Billing remains the authoritative commercial system; this module only turns
 * each *authoritative* billing fact into exactly one balanced journal document
 * inside the internal company's ledger, once, and leaves anything it cannot
 * post visible for reconciliation.
 *
 * Three rules the previous implementation broke, and which the tests pin:
 *
 *   1. **Settlement is read from the settlement record, never inferred.** A
 *      wallet debit that carries `metadata.invoiceId` IS the invoice's
 *      settlement; a verified `billing_payments` row IS a gateway settlement.
 *      Anything left over when `billing_invoices.paid_rial` rises is the
 *      residual. An invoice settled 600k from the wallet and 400k by gateway
 *      therefore posts twice — once against the wallet liability and once
 *      against the bank — instead of once, wrongly, against whichever probe
 *      happened to match.
 *   2. **A void is not `total − paid` by reflex.** An unpaid void reverses
 *      revenue and cancels the receivable; a partially paid void also turns the
 *      money already received into a customer-credit liability, because that
 *      money exists and must not be pretended away.
 *   3. **Posting is idempotent at the database level.** Unique indexes on the
 *      event, the source reference and the journal entry's own source make a
 *      replay, a retry, a second worker or an out-of-order delivery unable to
 *      create a second document.
 */
import type { PoolClient } from "pg";
import { getPool, query, withTenant, withoutTenantScope } from "./db";
import { platformCompanyLog } from "./platform-company";
import { deploymentRole } from "./deployment-role";
import type {
  BillingEventStatus,
  BillingFailureKind,
  BillingReconciliationRow,
} from "./platform-company-types";

export const PLATFORM_COMPANY_BILLING_TICK_MS = 30_000;
export const PLATFORM_COMPANY_MAINTENANCE_TICK_MS = 6 * 60 * 60 * 1000;
/** A claim older than this is a worker that died; the row goes back in the queue. */
const STALE_LEASE_INTERVAL = "10 minutes";
const MAX_ATTEMPTS = 12;

/**
 * The accounts this bridge posts to. Codes, not ids: accounts are per business
 * and are resolved to ids at posting time, so a re-seeded chart still works.
 */
export const POSTING_ACCOUNTS = {
  bank: "1110",
  receivable: "1200",
  payable: "2100",
  walletLiability: "2455",
  salesReturns: "4400",
  subscriptionIncome: "4500",
  providerCost: "5670",
  otherExpense: "5900",
} as const;

/** Every account used by a posting plan; shared with the read-only health check. */
export const REQUIRED_POSTING_ACCOUNT_CODES = [
  POSTING_ACCOUNTS.bank,
  POSTING_ACCOUNTS.receivable,
  POSTING_ACCOUNTS.payable,
  POSTING_ACCOUNTS.walletLiability,
  POSTING_ACCOUNTS.salesReturns,
  POSTING_ACCOUNTS.subscriptionIncome,
  POSTING_ACCOUNTS.providerCost,
] as const;

type EventRow = {
  id: string;
  internal_business_id: string;
  source_kind: string;
  source_table: string;
  source_id: string;
  source_version: string;
  customer_tenant_id: string | null;
  amount_rial: string;
  payload: Record<string, unknown>;
  settlement_method: string | null;
  occurred_at: Date;
};

export interface PostingLine {
  code: string;
  debit: number;
  credit: number;
}

export interface PostingPlan {
  name: string;
  lines: PostingLine[];
}

/** machine-readable reason an event cannot be posted, for the reconciliation UI. */
export type FailureKindCode = BillingFailureKind;

export class PostingFailure extends Error {
  constructor(readonly kind: FailureKindCode, message: string) {
    super(message);
    this.name = "PostingFailure";
  }
}

function money(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

/**
 * The posting plan for one event.
 *
 * Returns `null` for "correctly ignored" — a promotional wallet credit, a zero
 * amount — which is a settled state, not a failure.
 */
export function postingPlanFor(event: EventRow): PostingPlan | null {
  const amount = Number(event.amount_rial);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const A = POSTING_ACCOUNTS;

  switch (event.source_kind) {
    case "invoice_issued":
      return {
        name: "صدور صورتحساب تجاری",
        lines: [
          { code: A.receivable, debit: amount, credit: 0 },
          { code: A.subscriptionIncome, debit: 0, credit: amount },
        ],
      };

    case "invoice_payment":
      // Wallet settlement clears the customer's wallet liability; anything else
      // (gateway, manual review, or the residual that no settlement record
      // claims) arrives as money in the bank.
      return {
        name:
          event.settlement_method === "wallet"
            ? "تسویه صورتحساب از کیف پول مشتری"
            : "وصول صورتحساب تجاری",
        lines: [
          {
            code: event.settlement_method === "wallet" ? A.walletLiability : A.bank,
            debit: amount,
            credit: 0,
          },
          { code: A.receivable, debit: 0, credit: amount },
        ],
      };

    case "invoice_void": {
      const total = Math.max(amount, 0);
      const paid = Math.min(Math.max(money(event.payload, "paidRial"), 0), total);
      const outstanding = total - paid;
      if (paid <= 0) {
        // Nothing was ever received: reverse the whole thing.
        return {
          name: "ابطال صورتحساب پرداخت‌نشده",
          lines: [
            { code: A.subscriptionIncome, debit: total, credit: 0 },
            { code: A.receivable, debit: 0, credit: total },
          ],
        };
      }
      // Money was received. Revenue is reversed in full, the outstanding
      // receivable is cancelled, and the amount actually collected becomes a
      // customer credit until a refund settles it.
      const lines: PostingLine[] = [
        { code: A.subscriptionIncome, debit: total, credit: 0 },
      ];
      if (outstanding > 0) lines.push({ code: A.receivable, debit: 0, credit: outstanding });
      lines.push({ code: A.walletLiability, debit: 0, credit: paid });
      return { name: "ابطال صورتحساب پرداخت‌شده", lines };
    }

    case "wallet_top_up":
      return {
        name: "افزایش بدهی کیف پول مشتری",
        lines: [
          { code: A.bank, debit: amount, credit: 0 },
          { code: A.walletLiability, debit: 0, credit: amount },
        ],
      };

    // A wallet debit with no invoice is metered consumption: the liability is
    // released and the service is earned. A debit that DOES carry an invoice is
    // emitted as `invoice_payment` and never reaches this branch.
    case "wallet_spend":
      return {
        name: "مصرف کیف پول مشتری",
        lines: [
          { code: A.walletLiability, debit: amount, credit: 0 },
          { code: A.subscriptionIncome, debit: 0, credit: amount },
        ],
      };

    case "wallet_refund":
      return {
        name: "اعتبار بازپرداخت‌شده به کیف پول",
        lines: [
          { code: A.salesReturns, debit: amount, credit: 0 },
          { code: A.walletLiability, debit: 0, credit: amount },
        ],
      };

    case "invoice_refund":
      return {
        name: "بازپرداخت نقدی صورتحساب",
        lines: [
          { code: A.salesReturns, debit: amount, credit: 0 },
          { code: A.bank, debit: 0, credit: amount },
        ],
      };

    case "credit_note":
      return {
        name: "اعتبار اصلاحی صورتحساب",
        lines: [
          { code: A.subscriptionIncome, debit: amount, credit: 0 },
          { code: A.receivable, debit: 0, credit: amount },
        ],
      };

    case "adjustment":
      // Only `billing_adjustments` is authoritative enough to post: it carries
      // an explicit reason, an invoice and a signed amount, and it is
      // append-only. A wallet row this bridge could not classify is left
      // unposted rather than guessed at — "pending mapping" beats an invented
      // entry in the company's own ledger.
      if (event.source_table !== "billing_adjustments") return null;
      return {
        name: "تعدیل افزایشی صورتحساب",
        lines: [
          { code: A.receivable, debit: amount, credit: 0 },
          { code: A.subscriptionIncome, debit: 0, credit: amount },
        ],
      };

    // Only `wallet_noncash_credit` is ignored: a promotional grant or an admin
    // goodwill credit creates no receivable and moves no money, so it has no
    // double-entry meaning until it is spent.
    case "wallet_noncash_credit":
      return null;

    case "provider_cost":
      return {
        name: "هزینه تأمین‌کننده پلتفرم",
        lines: [
          { code: A.providerCost, debit: amount, credit: 0 },
          { code: A.payable, debit: 0, credit: amount },
        ],
      };

    default:
      throw new PostingFailure("permanent", `missing_posting_rule:${event.source_kind}`);
  }
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

async function claim(limit: number): Promise<EventRow[]> {
  return withoutTenantScope("platform", async () => {
    // A worker killed after claiming is recoverable; no source is lost forever.
    await query(
      `UPDATE platform_company_billing_events
          SET status='failed', last_error='stale_processing_lease',
              failure_kind='transient', available_at = now()
        WHERE status='processing' AND available_at < now() - interval '${STALE_LEASE_INTERVAL}'`,
    );
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<EventRow>(
        `SELECT id, internal_business_id, source_kind, source_table, source_id, source_version,
                customer_tenant_id, amount_rial, payload, settlement_method, occurred_at
           FROM platform_company_billing_events
          WHERE status IN ('pending','failed') AND available_at <= now() AND attempts < $2
            AND (failure_kind IS NULL OR failure_kind = 'transient'
                 OR failure_kind IN ('missing_account','missing_customer'))
          ORDER BY occurred_at, id
          FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit, MAX_ATTEMPTS],
      );
      if (rows.length) {
        await client.query(
          `UPDATE platform_company_billing_events
              SET status='processing', attempts = attempts + 1, available_at = now()
            WHERE id = ANY($1::uuid[])`,
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

// ---------------------------------------------------------------------------
// Customer mapping
// ---------------------------------------------------------------------------

/**
 * Create the internal company's CRM view of a customer tenant, once.
 *
 * The previous version inserted a `parties` row before checking anything, so a
 * retry or a concurrent worker left orphan duplicate parties behind whenever
 * the surrounding transaction rolled back or the unique mapping resolved
 * afterwards. The advisory lock is now taken first, the canonical mapping is
 * checked, an existing party is reused when one is already there, and all three
 * inserts live in one transaction.
 *
 * Only the platform directory's legal display name crosses the boundary. The
 * customer tenant's CRM, documents, contacts, ledger and orders are never read.
 */
async function ensureCustomerMapping(event: EventRow): Promise<void> {
  if (!event.customer_tenant_id || event.source_kind === "provider_cost") return;
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`platform-company-customer:${event.customer_tenant_id}`],
      );
      const existing = await client.query(
        `SELECT 1 FROM platform_company_customer_tenants
          WHERE business_id = $1 AND customer_tenant_id = $2`,
        [event.internal_business_id, event.customer_tenant_id],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return;
      }
      const { rows: tenants } = await client.query<{ name: string }>(
        `SELECT name FROM businesses WHERE id = $1 AND ownership_kind = 'customer'`,
        [event.customer_tenant_id],
      );
      if (!tenants[0]) throw new PostingFailure("missing_customer", "billing_customer_tenant_not_found");

      const key = `tenant:${event.customer_tenant_id}`;
      const { rows: existingCustomers } = await client.query<{ id: string; party_id: string }>(
        `SELECT id, party_id FROM platform_company_customers
          WHERE business_id = $1 AND billing_customer_key = $2`,
        [event.internal_business_id, key],
      );
      let customerId = existingCustomers[0]?.id;
      if (!customerId) {
        // `platform_company_customers` is unique on (business_id, party_id):
        // one party belongs to exactly one company customer. Reusing a party
        // by NAME alone therefore breaks the moment two customer tenants share
        // a business name — «کافه نادری» is not a rare name — because the
        // second one's INSERT collides with the first's party instead of
        // getting its own.
        //
        // So a party is only adopted when it is genuinely orphaned: same name
        // and referenced by NO customer row. That is the recovery path for a
        // run that created the party and then died before the customer row,
        // and it cannot steal another tenant's party.
        const { rows: parties } = await client.query<{ id: string }>(
          `SELECT p.id FROM parties p
            WHERE p.business_id = $1 AND p.name = $2
              AND NOT EXISTS (
                SELECT 1 FROM platform_company_customers c
                 WHERE c.business_id = p.business_id AND c.party_id = p.id)
            ORDER BY p.created_at, p.id LIMIT 1`,
          [event.internal_business_id, tenants[0].name],
        );
        let partyId = parties[0]?.id;
        if (!partyId) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO parties (business_id, name, role, person_type, notes)
             VALUES ($1,$2,'customer','legal',$3)
             RETURNING id`,
            [
              event.internal_business_id,
              tenants[0].name,
              // Two customers can legitimately share a legal name; the key is
              // what tells their rows apart when someone has to look.
              `ایجاد خودکار از نگاشت صورتحساب پلتفرم (${key})`,
            ],
          );
          partyId = inserted.rows[0].id;
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO platform_company_customers
             (business_id, party_id, legal_name, billing_customer_key)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id, billing_customer_key) DO UPDATE
             SET legal_name = EXCLUDED.legal_name
           RETURNING id`,
          [event.internal_business_id, partyId, tenants[0].name, key],
        );
        customerId = inserted.rows[0].id;
      }
      await client.query(
        `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
         VALUES ($1,$2,$3) ON CONFLICT (customer_id, customer_tenant_id) DO NOTHING`,
        [event.internal_business_id, customerId, event.customer_tenant_id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

async function requireCustomerMapping(client: PoolClient, event: EventRow): Promise<void> {
  if (!event.customer_tenant_id || event.source_kind === "provider_cost") return;
  const { rows } = await client.query(
    `SELECT 1 FROM platform_company_customer_tenants
      WHERE business_id = $1 AND customer_tenant_id = $2`,
    [event.internal_business_id, event.customer_tenant_id],
  );
  if (!rows[0]) throw new PostingFailure("missing_customer", "missing_customer_mapping");
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

async function postEvent(event: EventRow): Promise<"posted" | "ignored"> {
  const plan = postingPlanFor(event);
  if (!plan) return "ignored";

  // Customer-scoped facts need the internal company's CRM mapping before they
  // can be posted; a provider cost belongs to nobody and needs none.
  await ensureCustomerMapping(event);

  return withTenant(event.internal_business_id, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query(
        `SELECT 1 FROM platform_company_accounting_postings WHERE event_id = $1`,
        [event.id],
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return "posted" as const;
      }
      await requireCustomerMapping(client, event);

      const codes = [...new Set(plan.lines.flatMap((line) => [line.code]))];
      const { rows: accountRows } = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM accounts
          WHERE business_id = $1 AND code = ANY($2::text[]) AND is_active`,
        [event.internal_business_id, codes],
      );
      const accounts = new Map(accountRows.map((row) => [row.code, row.id]));
      const missing = codes.filter((code) => !accounts.has(code));
      if (missing.length) {
        throw new PostingFailure("missing_account", `missing_account_mapping:${missing.join(",")}`);
      }

      const debitTotal = plan.lines.reduce((sum, line) => sum + line.debit, 0);
      const creditTotal = plan.lines.reduce((sum, line) => sum + line.credit, 0);
      if (debitTotal !== creditTotal) {
        throw new PostingFailure("permanent", `unbalanced_posting_plan:${debitTotal}/${creditTotal}`);
      }

      const { rows: entryRows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (business_id, entry_date, memo, source_type, source_id, created_by, posting_kind, posted_at)
         VALUES ($1,$2,$3,'platform_billing',$4,$5,'posted', now())
         ON CONFLICT (business_id, source_id) WHERE source_type = 'platform_billing' DO NOTHING
         RETURNING id`,
        [
          event.internal_business_id,
          event.occurred_at.toISOString().slice(0, 10),
          `${plan.name} — ${event.source_table}:${event.source_id}`,
          event.id,
          null,
        ],
      );
      let entryId = entryRows[0]?.id;
      if (!entryId) {
        // The unique index already has this source: another worker posted it.
        const { rows: existing } = await client.query<{ id: string }>(
          `SELECT id FROM journal_entries
            WHERE business_id = $1 AND source_type = 'platform_billing' AND source_id = $2`,
          [event.internal_business_id, event.id],
        );
        entryId = existing[0].id;
        await client.query(
          `INSERT INTO platform_company_accounting_postings
             (business_id, event_id, source_reference, journal_entry_id, posting_rule, amount_rial)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.internal_business_id,
            event.id,
            `${event.source_table}:${event.source_id}:${event.source_version}`,
            entryId,
            event.source_kind,
            debitTotal,
          ],
        );
        await client.query("COMMIT");
        return "posted" as const;
      }

      for (const line of plan.lines) {
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
           VALUES ($1,$2,$3,$4)`,
          [entryId, accounts.get(line.code), String(line.debit), String(line.credit)],
        );
      }
      await client.query(
        `INSERT INTO platform_company_accounting_postings
           (business_id, event_id, source_reference, journal_entry_id, posting_rule, amount_rial)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.internal_business_id,
          event.id,
          `${event.source_table}:${event.source_id}:${event.source_version}`,
          entryId,
          event.source_kind,
          debitTotal,
        ],
      );
      await client.query("COMMIT");
      platformCompanyLog("posting.posted", {
        businessId: event.internal_business_id,
        eventId: event.id,
        kind: event.source_kind,
        settlementMethod: event.settlement_method,
        amountRial: debitTotal,
        lines: plan.lines.length,
      });
      return "posted" as const;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

async function markFailure(event: EventRow, error: unknown): Promise<void> {
  const failure: FailureKindCode =
    error instanceof PostingFailure ? error.kind : "transient";
  const message = error instanceof Error ? error.message.slice(0, 500) : "unknown_error";
  await withoutTenantScope("platform", () => query(
    `UPDATE platform_company_billing_events
        SET status='failed', last_error=$2, failure_kind=$3,
            available_at = now() + (LEAST(attempts, 8) * interval '1 minute')
      WHERE id=$1`,
    [event.id, message, failure],
  ));
  platformCompanyLog("posting.failed", {
    businessId: event.internal_business_id,
    eventId: event.id,
    kind: event.source_kind,
    settlementMethod: event.settlement_method,
    failureKind: failure,
    error: message,
  });
}

export async function runPlatformCompanyBillingTick(limit = 30) {
  // The company exists once, on the central cloud install. A site or a desktop
  // install has no company ledger to post into, and letting it run would be a
  // second writer claiming events another process is already claiming.
  if (deploymentRole() !== "central") return { checked: 0, posted: 0, ignored: 0, failed: 0 };
  const events = await claim(Math.min(Math.max(limit, 1), 100));
  let posted = 0;
  let ignored = 0;
  let failed = 0;
  for (const event of events) {
    try {
      const outcome = await postEvent(event);
      await withoutTenantScope("platform", () => query(
        `UPDATE platform_company_billing_events
            SET status=$2, last_error=NULL, failure_kind=NULL, posted_at=now()
          WHERE id=$1`,
        [event.id, outcome],
      ));
      if (outcome === "posted") posted++;
      else ignored++;
    } catch (error) {
      failed++;
      await markFailure(event, error).catch((markError) => {
        console.error("platform company billing: could not record failure", markError);
      });
    }
  }
  if (events.length) {
    platformCompanyLog("tick.completed", { checked: events.length, posted, ignored, failed });
  }
  return { checked: events.length, posted, ignored, failed };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Housekeeping for tables that only ever grow: redeemed and long-expired
 * handoff tokens. Retention is the database function's default (24h redeemed,
 * 7d expired); the audit trail of who opened what lives in
 * `platform_audit_log`, not in the handoff table, so pruning loses nothing.
 */
export async function runPlatformCompanyMaintenanceTick(): Promise<{ prunedHandoffs: number }> {
  if (deploymentRole() !== "central") return { prunedHandoffs: 0 };
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ pruned: number }>(`SELECT prune_platform_company_handoffs()::int AS pruned`),
  );
  const prunedHandoffs = rows[0]?.pruned ?? 0;
  if (prunedHandoffs) platformCompanyLog("maintenance.handoffs_pruned", { prunedHandoffs });
  return { prunedHandoffs };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationFilter {
  status?: BillingEventStatus | "needs_attention";
  kind?: string;
  limit?: number;
  offset?: number;
}

export const BLOCKED_REASONS: Record<string, string> = {
  missing_account_mapping: "حساب‌های مقصد در چارت حساب‌های شرکت تعریف نشده‌اند؛ ابتدا حساب را بسازید.",
  missing_customer_mapping: "نگاشت مشتری پلتفرم برای این کسب‌وکار ساخته نشده است.",
  billing_customer_tenant_not_found: "کسب‌وکار مشتری یافت نشد.",
};

/** Why a failed row will not succeed on a blind retry, in the operator's words. */
function blockedReasonFor(row: {
  status: string;
  failure_kind: string | null;
  last_error: string | null;
}): string | null {
  if (row.status !== "failed") return null;
  if (row.failure_kind === "permanent") {
    return row.last_error?.startsWith("missing_posting_rule")
      ? "برای این نوع رویداد قانون دفتری تعریف نشده است."
      : "این رویداد قابل ثبت نیست و باید با سند اصلاحی حسابداری رفع شود.";
  }
  if (row.failure_kind === "missing_account") {
    return BLOCKED_REASONS.missing_account_mapping;
  }
  if (row.failure_kind === "missing_customer") {
    const code = row.last_error ?? "";
    return code.includes("billing_customer_tenant_not_found")
      ? BLOCKED_REASONS.billing_customer_tenant_not_found
      : BLOCKED_REASONS.missing_customer_mapping;
  }
  return null;
}

export async function billingReconciliation(
  businessId: string,
  filter: ReconciliationFilter = {},
): Promise<{
  events: BillingReconciliationRow[];
  total: number;
  counts: Record<BillingEventStatus, number>;
}> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const params: unknown[] = [businessId];
  const conditions: string[] = ["e.internal_business_id = $1"];
  if (filter.status && filter.status !== "needs_attention") {
    params.push(filter.status);
    conditions.push(`e.status = $${params.length}`);
  } else if (filter.status === "needs_attention") {
    conditions.push(`e.status = 'failed'`);
  }
  if (filter.kind) {
    params.push(filter.kind);
    conditions.push(`e.source_kind = $${params.length}`);
  }
  const where = conditions.join(" AND ");

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string; source_kind: string; source_table: string; source_id: string; source_version: string;
      amount_rial: string; status: BillingEventStatus; attempts: number; last_error: string | null;
      failure_kind: BillingFailureKind | null; settlement_method: string | null;
      occurred_at: Date; posted_at: Date | null; journal_entry_id: string | null;
      customer_tenant_id: string | null; customer_name: string | null; total: string;
    }>(
      `SELECT e.id, e.source_kind, e.source_table, e.source_id, e.source_version, e.amount_rial,
              e.status, e.attempts, e.last_error, e.failure_kind, e.settlement_method,
              e.occurred_at, e.posted_at, p.journal_entry_id, e.customer_tenant_id,
              b.name AS customer_name,
              count(*) OVER() AS total
         FROM platform_company_billing_events e
         LEFT JOIN platform_company_accounting_postings p ON p.event_id = e.id
         LEFT JOIN businesses b ON b.id = e.customer_tenant_id
        WHERE ${where}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const { rows: countRows } = await query<{ status: BillingEventStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM platform_company_billing_events
        WHERE internal_business_id = $1 GROUP BY status`,
      [businessId],
    );
    const counts: Record<BillingEventStatus, number> = {
      pending: 0, processing: 0, posted: 0, failed: 0, ignored: 0,
    };
    for (const row of countRows) counts[row.status] = Number(row.count);

    return {
      events: rows.map((row) => ({
        id: row.id,
        kind: row.source_kind,
        source: `${row.source_table}:${row.source_id}`,
        version: row.source_version,
        amountRial: Number(row.amount_rial),
        status: row.status,
        attempts: row.attempts,
        error: row.last_error,
        failureKind: row.failure_kind,
        blockedReason: blockedReasonFor(row),
        settlementMethod: row.settlement_method,
        occurredAt: row.occurred_at.toISOString(),
        postedAt: row.posted_at?.toISOString() ?? null,
        journalEntryId: row.journal_entry_id,
        customerTenantId: row.customer_tenant_id,
        customerName: row.customer_name,
      })),
      total: rows[0] ? Number(rows[0].total) : 0,
      counts,
    };
  });
}

/**
 * Queue one failed event again.
 *
 * The attempt counter is reset so the exponential backoff restarts: an operator
 * who has just created the missing account should not wait out the whole
 * backoff ladder a previous failure built up.
 */
export async function retryBillingEvent(businessId: string, eventId: string): Promise<boolean> {
  const { rows } = await withoutTenantScope("platform", () => query<{ id: string }>(
    `UPDATE platform_company_billing_events
        SET status='pending', available_at=now(), last_error=NULL,
            failure_kind=NULL, attempts=0
      WHERE id=$1 AND internal_business_id=$2 AND status='failed'
      RETURNING id`,
    [eventId, businessId],
  ));
  if (rows[0]) {
    platformCompanyLog("reconciliation.retry", { businessId, eventId });
  }
  return Boolean(rows[0]);
}
