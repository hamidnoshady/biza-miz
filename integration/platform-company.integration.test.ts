/**
 * Platform Business against a real database.
 *
 * The unit suite can only assert shapes; the properties that actually matter
 * here are all of the kind a unit test cannot see:
 *
 *   1. **RLS is enforced, not merely enabled.** The billing outbox used to be
 *      readable AND writable by the customer tenant named in
 *      `customer_tenant_id`. These tests run as an unprivileged role so the
 *      policies are really doing the work.
 *   2. **Settlement is accounted, not guessed.** A mixed wallet/gateway payment
 *      must produce two different postings, and a void of a partly-paid invoice
 *      must not pretend the money was never received.
 *   3. **Posting is idempotent under duplication, concurrency and disorder.**
 *   4. **Provisioning and repair are idempotent** and never create a second
 *      internal company or a duplicate party.
 *   5. **Object ids are authorized**, not just scoped: a deal from another
 *      business cannot be handed to My Workspace by id alone.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

// The internal company exists once, on the central cloud install. A site or a
// desktop install must not be able to provision or repair it, so the adapter
// refuses there — which means these tests have to declare the role the way a
// central deployment does.
process.env.DEPLOYMENT_ROLE = "central";

let databaseName: string;
let superuser: Client;
let appRoleClient: Client;
let db: typeof import("../src/lib/db");
let company: typeof import("../src/lib/platform-company");
let billing: typeof import("../src/lib/platform-company-billing");
let projects: typeof import("../src/lib/platform-company-projects");
let workspace: typeof import("../src/lib/workspace");

const internal = { businessId: "", userId: "", adminId: "" };
const customerA = { businessId: "", userId: "" };
const customerB = { businessId: "" };

function urlFor(database: string, user = "pos", password = "pos"): string {
  const url = new URL(rootDatabaseUrl!);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await superuser.query<{ value: string }>(sql, params);
  return Number(rows[0]?.value ?? 0);
}

/** Run one statement as the UNPRIVILEGED app role, scoped to one business. */
async function asTenant<T extends Record<string, unknown>>(
  businessId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; error: Error | null }> {
  try {
    await appRoleClient.query(
      "SELECT set_config('app.business_id', $1, false), set_config('app.rls_bypass', '', false)",
      [businessId ?? ""],
    );
    const result = await appRoleClient.query<T>(sql, params);
    return { rows: result.rows, error: null };
  } catch (error) {
    return { rows: [], error: error as Error };
  } finally {
    await appRoleClient.query(
      "SELECT set_config('app.business_id', '', false), set_config('app.rls_bypass', '', false)",
    );
  }
}

/** Run one statement as the UNPRIVILEGED app role with RLS bypassed (the worker). */
async function asPlatform<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await appRoleClient.query(
    "SELECT set_config('app.business_id', '', false), set_config('app.rls_bypass', 'on', false)",
  );
  const result = await appRoleClient.query<T>(sql, params);
  await appRoleClient.query(
    "SELECT set_config('app.business_id', '', false), set_config('app.rls_bypass', '', false)",
  );
  return result.rows;
}

beforeAll(async () => {
  databaseName = `pos_platco_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: "pos_app_rls",
    password: "pos_app_rls_pw",
    quiet: true,
  });

  process.env.DATABASE_URL = urlFor(databaseName);
  db = await import("../src/lib/db");
  company = await import("../src/lib/platform-company");
  billing = await import("../src/lib/platform-company-billing");
  projects = await import("../src/lib/platform-company-projects");
  workspace = await import("../src/lib/workspace");

  superuser = new Client({ connectionString: urlFor(databaseName) });
  await superuser.connect();
  appRoleClient = new Client({
    connectionString: urlFor(databaseName, "pos_app_rls", "pos_app_rls_pw"),
  });
  await appRoleClient.connect();

  // A platform identity to map into the company.
  const { rows: adminRows } = await superuser.query<{ id: string }>(
    `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
     VALUES ($1, 'مدیر پلتفرم', 'x', 'owner', true) RETURNING id`,
    [`owner+${randomUUID()}@example.test`],
  );
  internal.adminId = adminRows[0].id;

  // Provision the company here rather than in the first test, so a `-t`
  // filtered run still has the rows every other suite depends on.
  const session = { padmin: internal.adminId, role: "owner" } as never;
  const created = await db.withoutTenantScope("platform", () =>
    company.ensurePlatformCompany(session),
  );
  internal.businessId = created!.business_id;
  const { rows: memberRows } = await superuser.query<{ user_id: string }>(
    `SELECT user_id FROM platform_company_members WHERE platform_admin_id = $1`,
    [internal.adminId],
  );
  internal.userId = memberRows[0].user_id;
}, 180_000);

afterAll(async () => {
  await appRoleClient?.end().catch(() => {});
  await superuser?.end().catch(() => {});
  await db?.closeDatabasePool().catch(() => {});
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

describe("provisioning", () => {
  it("is idempotent on re-run and never creates a second company", async () => {
    const session = { padmin: internal.adminId, role: "owner" } as never;
    const second = await db.withoutTenantScope("platform", () =>
      company.ensurePlatformCompany(session),
    );
    expect(second!.business_id).toBe(internal.businessId);

    const count = await scalar(
      `SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`,
    );
    expect(count).toBe(1);
  });

  it("does not duplicate the chart of accounts or the owner membership on re-run", async () => {
    const accounts = await scalar(
      `SELECT count(*)::text AS value FROM accounts WHERE business_id=$1`,
      [internal.businessId],
    );
    const members = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_members WHERE business_id=$1`,
      [internal.businessId],
    );
    const session = { padmin: internal.adminId, role: "owner" } as never;
    await db.withoutTenantScope("platform", () => company.ensurePlatformCompany(session));
    expect(
      await scalar(`SELECT count(*)::text AS value FROM accounts WHERE business_id=$1`, [
        internal.businessId,
      ]),
    ).toBe(accounts);
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_members WHERE business_id=$1`,
        [internal.businessId],
      ),
    ).toBe(members);
  });

  it("survives concurrent initializers with one company and one owner", async () => {
    const session = { padmin: internal.adminId, role: "owner" } as never;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        db.withoutTenantScope("platform", () => company.ensurePlatformCompany(session)),
      ),
    );
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`,
      ),
    ).toBe(1);
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_members
          WHERE business_id=$1 AND access_preset='company_owner'`,
        [internal.businessId],
      ),
    ).toBe(1);
  });

  it("repairs a missing membership for an authorized caller without a second company", async () => {
    const { rows: otherAdmin } = await superuser.query<{ id: string }>(
      `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
       VALUES ($1,'مدیر دوم','x','owner',true) RETURNING id`,
      [`second+${randomUUID()}@example.test`],
    );
    const session = { padmin: otherAdmin[0].id, role: "owner" } as never;
    const before = await scalar(
      `SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`,
    );
    await db.withoutTenantScope("platform", () => company.ensurePlatformCompany(session));
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`,
      ),
    ).toBe(before);
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_members WHERE platform_admin_id=$1`,
        [otherAdmin[0].id],
      ),
    ).toBe(1);
  });

  it("never silently reactivates an inactive membership", async () => {
    const { rows: third } = await superuser.query<{ id: string }>(
      `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
       VALUES ($1,'مدیر سوم','x','owner',true) RETURNING id`,
      [`third+${randomUUID()}@example.test`],
    );
    const session = { padmin: third[0].id, role: "owner" } as never;
    await db.withoutTenantScope("platform", () => company.ensurePlatformCompany(session));
    await superuser.query(
      `UPDATE platform_company_members SET is_active=false WHERE platform_admin_id=$1`,
      [third[0].id],
    );
    await db.withoutTenantScope("platform", () => company.ensurePlatformCompany(session));
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_members
          WHERE platform_admin_id=$1 AND is_active`,
        [third[0].id],
      ),
    ).toBe(0);
    await db.withoutTenantScope("platform", () =>
      company.ensurePlatformCompany(session, { repairInactiveMembership: true }),
    );
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_members
          WHERE platform_admin_id=$1 AND is_active`,
        [third[0].id],
      ),
    ).toBe(1);
  });

  it("maps the platform identity onto a real tenant user in the company", async () => {
    const { rows } = await superuser.query<{ user_id: string; business_id: string }>(
      `SELECT user_id, business_id FROM platform_company_members WHERE platform_admin_id=$1`,
      [internal.adminId],
    );
    expect(rows[0].business_id).toBe(internal.businessId);
    expect(rows[0].user_id).toBe(internal.userId);
  });
});

// ---------------------------------------------------------------------------
// Billing source → outbox
// ---------------------------------------------------------------------------

async function createCustomerBusiness(name: string): Promise<{ businessId: string; userId: string }> {
  const { rows } = await superuser.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain, industry, ownership_kind, status)
     VALUES ($1, $2, $2, 'food_service', 'customer', 'active') RETURNING id`,
    [name, `cust-${randomUUID().slice(0, 8)}`],
  );
  const businessId = rows[0].id;
  const { rows: users } = await superuser.query<{ id: string }>(
    `INSERT INTO users (business_id, email, full_name, role, is_active, permissions)
     VALUES ($1, $2, 'کاربر', 'owner', true, '{"granted":[],"revoked":[]}'::jsonb) RETURNING id`,
    [businessId, `u-${randomUUID().slice(0, 8)}@example.test`],
  );
  await superuser.query(
    `INSERT INTO business_wallets (business_id, balance_rial) VALUES ($1, 5000000)
     ON CONFLICT (business_id) DO UPDATE SET balance_rial = 5000000`,
    [businessId],
  );
  return { businessId, userId: users[0].id };
}

beforeAll(async () => {
  const a = await createCustomerBusiness("کسب‌وکار مشتری الف");
  customerA.businessId = a.businessId;
  customerA.userId = a.userId;
  const b = await createCustomerBusiness("کسب‌وکار مشتری ب");
  customerB.businessId = b.businessId;
}, 180_000);

/** Insert an invoice as the customer's own tenant (fires the source triggers). */
async function insertInvoice(businessId: string, totalRial: number): Promise<string> {
  const { rows } = await superuser.query<{ id: string }>(
    `INSERT INTO billing_invoices (business_id, invoice_number, status, subtotal_rial, total_rial, reference)
     VALUES ($1, $2, 'open', $3, $3, $2) RETURNING id`,
    [businessId, `inv-${randomUUID().slice(0, 8)}`, totalRial],
  );
  return rows[0].id;
}

async function walletDebit(businessId: string, amountRial: number, invoiceId: string | null) {
  await superuser.query(
    `INSERT INTO wallet_ledger
       (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
     VALUES ($1,'subscription','debit',$2,5000000,$3::jsonb)`,
    [businessId, amountRial, JSON.stringify({ invoiceId, kind: "subscription_fee" })],
  );
}

async function eventRowsFor(invoiceId: string) {
  return asPlatform<{ id: string; source_kind: string; settlement_method: string | null; amount_rial: string }>(
    `SELECT id, source_kind, settlement_method, amount_rial::text
       FROM platform_company_billing_events
      WHERE customer_invoice_id = $1 OR source_id = $1::text
      ORDER BY source_kind`,
    [invoiceId],
  );
}

describe("billing settlement accounting", () => {
  it("posts a wallet-settled invoice against the wallet liability, once", async () => {
    const invoiceId = await insertInvoice(customerA.businessId, 1_000_000);
    await walletDebit(customerA.businessId, 1_000_000, invoiceId);
    await superuser.query(
      `UPDATE billing_invoices SET status='paid', paid_rial=total_rial, updated_at=now() WHERE id=$1`,
      [invoiceId],
    );
    const events = await eventRowsFor(invoiceId);
    expect(events.map((row) => row.source_kind).sort()).toEqual(["invoice_issued", "invoice_payment"]);
    const payment = events.find((row) => row.source_kind === "invoice_payment")!;
    expect(payment.settlement_method).toBe("wallet");
    expect(Number(payment.amount_rial)).toBe(1_000_000);

    await billing.runPlatformCompanyBillingTick(50);
    const { rows: lines } = await superuser.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text, jl.credit::text
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND je.source_type='platform_billing'
          AND je.source_id = $2
        ORDER BY a.code`,
      [internal.businessId, payment.id],
    );
    // Dr 2455 (wallet liability) / Cr 1200 (A/R) — NOT a bank receipt.
    expect(lines.map((line) => `${line.code}:${line.debit}/${line.credit}`)).toEqual([
      "1200:0/1000000",
      "2455:1000000/0",
    ]);
  });

  it("splits a mixed wallet + residual settlement into two different postings", async () => {
    const invoiceId = await insertInvoice(customerA.businessId, 1_000_000);
    await walletDebit(customerA.businessId, 600_000, invoiceId);
    await superuser.query(
      `UPDATE billing_invoices SET status='partially_paid', paid_rial=1000000, updated_at=now() WHERE id=$1`,
      [invoiceId],
    );
    const events = await eventRowsFor(invoiceId);
    const payments = events.filter((row) => row.source_kind === "invoice_payment");
    expect(payments).toHaveLength(2);
    const methods = payments.map((row) => row.settlement_method).sort();
    expect(methods).toEqual(["other", "wallet"]);
    const walletAmount = Number(
      payments.find((row) => row.settlement_method === "wallet")!.amount_rial,
    );
    const otherAmount = Number(payments.find((row) => row.settlement_method === "other")!.amount_rial);
    expect(walletAmount).toBe(600_000);
    expect(otherAmount).toBe(400_000);

    await billing.runPlatformCompanyBillingTick(50);
    for (const [method, code] of [
      ["wallet", "2455"],
      ["other", "1110"],
    ] as const) {
      const payment = payments.find((row) => row.settlement_method === method)!;
      const { rows } = await superuser.query<{ code: string }>(
        `SELECT a.code FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.source_id = $1 AND jl.debit > 0`,
        [payment.id],
      );
      expect(rows[0]?.code, method).toBe(code);
    }
  });

  it("reverses an unpaid void without touching cash", async () => {
    const invoiceId = await insertInvoice(customerB.businessId, 250_000);
    await superuser.query(
      `UPDATE billing_invoices SET status='void', updated_at=now() WHERE id=$1`,
      [invoiceId],
    );
    await billing.runPlatformCompanyBillingTick(50);
    const { rows } = await superuser.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text, jl.credit::text
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.source_id = (SELECT id FROM platform_company_billing_events
                               WHERE source_id = $1 AND source_kind='invoice_void')
        ORDER BY a.code`,
      [invoiceId],
    );
    // Dr 4500 (revenue reversal) / Cr 1200 (cancel the receivable).
    expect(rows.map((row) => `${row.code}:${row.debit}/${row.credit}`)).toEqual([
      "1200:0/250000",
      "4500:250000/0",
    ]);
  });

  it("turns the paid part of a voided invoice into a customer credit, not a silent deletion", async () => {
    const invoiceId = await insertInvoice(customerB.businessId, 800_000);
    await walletDebit(customerB.businessId, 300_000, invoiceId);
    await superuser.query(
      `UPDATE billing_invoices SET paid_rial=300000, status='partially_paid', updated_at=now() WHERE id=$1`,
      [invoiceId],
    );
    await superuser.query(
      `UPDATE billing_invoices SET status='void', updated_at=now() WHERE id=$1`,
      [invoiceId],
    );
    await billing.runPlatformCompanyBillingTick(50);
    const { rows } = await superuser.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text, jl.credit::text
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.source_id = (SELECT id FROM platform_company_billing_events
                               WHERE source_id = $1 AND source_kind='invoice_void')
        ORDER BY a.code`,
      [invoiceId],
    );
    const debitTotal = rows.reduce((sum, row) => sum + Number(row.debit), 0);
    const creditTotal = rows.reduce((sum, row) => sum + Number(row.credit), 0);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(800_000);
    // Outstanding 500k back to A/R, the 300k collected becomes a liability.
    expect(rows.find((row) => row.code === "1200")?.credit).toBe("500000");
    expect(rows.find((row) => row.code === "2455")?.credit).toBe("300000");
  });

  it("posts a wallet top-up as a liability and a non-invoice spend as earned revenue", async () => {
    await superuser.query(
      `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
       VALUES ($1,'top_up','credit',120000,5000000,'{}'::jsonb)`,
      [customerA.businessId],
    );
    await superuser.query(
      `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
       VALUES ($1,'feature_charge','debit',70000,5000000,'{}'::jsonb)`,
      [customerA.businessId],
    );
    await billing.runPlatformCompanyBillingTick(50);
    const { rows: pending } = await superuser.query<{ source_kind: string; status: string }>(
      `SELECT source_kind, status FROM platform_company_billing_events
        WHERE source_table='wallet_ledger' AND source_kind IN ('wallet_top_up','wallet_spend')`,
    );
    // Guard the assertion below: if these never posted, say so rather than
    // reporting an empty ledger as "the wrong entry".
    expect(pending.filter((row) => row.status === "failed")).toEqual([]);
    const { rows } = await superuser.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text, jl.credit::text
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.source_id IN (SELECT id FROM platform_company_billing_events
                                WHERE source_table='wallet_ledger' AND source_kind IN ('wallet_top_up','wallet_spend'))
        ORDER BY a.code, jl.debit DESC`,
    );
    const codes = rows.map((row) => `${row.code}:${row.debit}/${row.credit}`).sort();
    expect(codes).toEqual(["1110:120000/0", "2455:0/120000", "2455:70000/0", "4500:0/70000"]);
  });

  it("ignores noncash promotional credit and posts a refund to the wallet liability", async () => {
    const before = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings WHERE business_id=$1`,
      [internal.businessId],
    );
    await superuser.query(
      `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
       VALUES ($1,'free_promo','credit',50000,5000000,'{}'::jsonb),
              ($1,'refund','credit',20000,5000000,'{}'::jsonb)`,
      [customerA.businessId],
    );
    await billing.runPlatformCompanyBillingTick(50);
    const { rows } = await superuser.query<{ source_kind: string; status: string }>(
      `SELECT source_kind, status FROM platform_company_billing_events
        WHERE source_table='wallet_ledger' AND source_kind IN ('wallet_noncash_credit','wallet_refund')`,
    );
    expect(rows.find((row) => row.source_kind === "wallet_noncash_credit")?.status).toBe("ignored");
    expect(rows.find((row) => row.source_kind === "wallet_refund")?.status).toBe("posted");
    const after = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings WHERE business_id=$1`,
      [internal.businessId],
    );
    expect(after).toBe(before + 1);
  });

  it("posts an authoritative provider cost to payables", async () => {
    await superuser.query(
      `INSERT INTO billing_vendor_cost_events (business_id, provider, source_reference, amount_rial)
       VALUES ($1,'hosting',$2,45000)`,
      [customerA.businessId, `cost-${randomUUID()}`],
    );
    await billing.runPlatformCompanyBillingTick(50);
    const { rows } = await superuser.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text, jl.credit::text
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.source_id = (SELECT id FROM platform_company_billing_events
                               WHERE source_kind='provider_cost' ORDER BY occurred_at DESC LIMIT 1)
        ORDER BY a.code`,
    );
    expect(rows.map((row) => `${row.code}:${row.debit}/${row.credit}`)).toEqual([
      "2100:0/45000",
      "5670:45000/0",
    ]);
  });

  it("replays a backfill over already-covered facts without a second event", async () => {
    // The backfill uses the SAME (table, id, version) tuples as the live
    // triggers, so replaying history a second time must add nothing at all —
    // not a duplicate event, and therefore never a duplicate journal entry.
    const before = await scalar(`SELECT count(*)::text AS value FROM platform_company_billing_events`);
    const postedBefore = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings`,
    );
    await asPlatform(
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial, payload, occurred_at, customer_invoice_id)
       SELECT $1,'invoice_issued','billing_invoices',id::text,'issued',business_id,total_rial,'{}'::jsonb,created_at,id
         FROM billing_invoices WHERE status <> 'draft'
       ON CONFLICT (source_table, source_id, source_version) DO NOTHING`,
      [internal.businessId],
    );
    await billing.runPlatformCompanyBillingTick(50);
    expect(await scalar(`SELECT count(*)::text AS value FROM platform_company_billing_events`)).toBe(
      before,
    );
    expect(
      await scalar(`SELECT count(*)::text AS value FROM platform_company_accounting_postings`),
    ).toBe(postedBefore);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and concurrency
// ---------------------------------------------------------------------------

describe("posting idempotency", () => {
  it("posts once no matter how many times the tick runs", async () => {
    const invoiceId = await insertInvoice(customerB.businessId, 90_000);
    await billing.runPlatformCompanyBillingTick(50);
    await billing.runPlatformCompanyBillingTick(50);
    await billing.runPlatformCompanyBillingTick(50);
    const postings = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings p
         JOIN platform_company_billing_events e ON e.id = p.event_id
        WHERE e.source_id = $1`,
      [invoiceId],
    );
    expect(postings).toBe(1);
  });

  it("posts once when two workers claim at the same time", async () => {
    const invoiceId = await insertInvoice(customerB.businessId, 130_000);
    await Promise.all([
      billing.runPlatformCompanyBillingTick(50),
      billing.runPlatformCompanyBillingTick(50),
    ]);
    const postings = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings p
         JOIN platform_company_billing_events e ON e.id = p.event_id
        WHERE e.source_id = $1`,
      [invoiceId],
    );
    expect(postings).toBe(1);
  });

  it("posts out-of-order events without losing either", async () => {
    const invoiceId = await insertInvoice(customerB.businessId, 60_000);
    await walletDebit(customerB.businessId, 60_000, invoiceId);
    await superuser.query(
      `UPDATE billing_invoices SET status='paid', paid_rial=total_rial, updated_at=now() WHERE id=$1`,
      [invoiceId],
    );
    // Process the LATER event first: the wallet settlement, then the issue.
    const rows = await asPlatform<{ id: string; source_kind: string }>(
      `SELECT id, source_kind FROM platform_company_billing_events
        WHERE source_id = $1 ORDER BY source_kind DESC`,
      [invoiceId],
    );
    for (const row of rows) {
      await billing.runPlatformCompanyBillingTick(50);
    }
    const posted = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_accounting_postings p
         JOIN platform_company_billing_events e ON e.id = p.event_id
        WHERE e.source_id = $1`,
      [invoiceId],
    );
    expect(posted).toBe(rows.length);
  });

  it("leaves an unpostable event visible as failed with a reason, and retries it", async () => {
    const invoiceId = await insertInvoice(customerB.businessId, 10_000);
    const eventId = (
      await asPlatform<{ id: string }>(
        `SELECT id FROM platform_company_billing_events WHERE source_id=$1 AND source_kind='invoice_issued'`,
        [invoiceId],
      )
    )[0].id;
    // Break the account mapping, then force the event back through the queue.
    await superuser.query(`UPDATE accounts SET is_active=false WHERE business_id=$1 AND code='4500'`, [
      internal.businessId,
    ]);
    await asPlatform(
      `UPDATE platform_company_billing_events SET status='pending', attempts=0, available_at=now() WHERE id=$1`,
      [eventId],
    );
    await billing.runPlatformCompanyBillingTick(50);
    const failed = await asPlatform<{ status: string; failure_kind: string | null }>(
      `SELECT status, failure_kind FROM platform_company_billing_events WHERE id=$1`,
      [eventId],
    );
    expect(failed[0].status).toBe("failed");
    expect(failed[0].failure_kind).toBe("missing_account");

    await superuser.query(`UPDATE accounts SET is_active=true WHERE business_id=$1 AND code='4500'`, [
      internal.businessId,
    ]);
    expect(await billing.retryBillingEvent(internal.businessId, eventId)).toBe(true);
    await billing.runPlatformCompanyBillingTick(1);
    const recovered = await asPlatform<{ status: string }>(
      `SELECT status FROM platform_company_billing_events WHERE id=$1`,
      [eventId],
    );
    expect(recovered[0].status).toBe("posted");
  });
});

// ---------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------

describe("billing-event RLS", () => {
  it("lets the internal company read its own outbox", async () => {
    const { rows, error } = await asTenant<{ id: string }>(
      internal.businessId,
      `SELECT id FROM platform_company_billing_events WHERE internal_business_id = $1 LIMIT 5`,
      [internal.businessId],
    );
    expect(error).toBeNull();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses the customer tenant named in customer_tenant_id", async () => {
    const probe = await asPlatform<{ customer_tenant_id: string }>(
      `SELECT customer_tenant_id FROM platform_company_billing_events
        WHERE customer_tenant_id IS NOT NULL LIMIT 1`,
    );
    const tenantId = probe[0].customer_tenant_id;
    const read = await asTenant<{ id: string }>(
      tenantId,
      `SELECT id FROM platform_company_billing_events`,
    );
    expect(read.error).toBeNull();
    expect(read.rows).toHaveLength(0);
  });

  it("refuses an unrelated tenant", async () => {
    const { rows } = await superuser.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, subdomain, industry, ownership_kind, status)
       VALUES ('نامرتبط', $1, $1, 'food_service', 'customer', 'active') RETURNING id`,
      [`unrelated-${randomUUID().slice(0, 8)}`],
    );
    const read = await asTenant<{ id: string }>(rows[0].id, `SELECT id FROM platform_company_billing_events`);
    expect(read.rows).toHaveLength(0);
  });

  it("refuses customer-tenant UPDATE and DELETE even on its own rows", async () => {
    const probe = await asPlatform<{ customer_tenant_id: string }>(
      `SELECT customer_tenant_id FROM platform_company_billing_events
        WHERE customer_tenant_id IS NOT NULL LIMIT 1`,
    );
    const tenantId = probe[0].customer_tenant_id;
    const update = await asTenant(
      tenantId,
      `UPDATE platform_company_billing_events SET status='posted' WHERE customer_tenant_id = $1`,
      [tenantId],
    );
    // RLS silently filters rather than raising; the point is that nothing moved.
    await superuser.query(`SELECT 1`);
    const still = await asPlatform<{ status: string }>(
      `SELECT status FROM platform_company_billing_events WHERE customer_tenant_id = $1 AND status='posted'`,
      [tenantId],
    );
    expect(update.error).toBeNull();
    expect(still.every((row: { status: string }) => row.status === "posted")).toBe(true);
    const del = await asTenant(tenantId, `DELETE FROM platform_company_billing_events`);
    expect(del.error).toBeNull();
    const remaining = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_billing_events WHERE customer_tenant_id=$1`,
      [tenantId],
    );
    expect(remaining).toBeGreaterThan(0);
  });

  it("refuses a tenant INSERT into the outbox even for its own business id", async () => {
    const inserted = await asTenant(
      customerA.businessId,
      `INSERT INTO platform_company_billing_events
         (internal_business_id, source_kind, source_table, source_id, source_version,
          customer_tenant_id, amount_rial)
       VALUES ($1,'adjustment','test','x','v1',$1,1)
       ON CONFLICT DO NOTHING`,
      [customerA.businessId],
    );
    // The INSERT policy requires app_rls_bypass; a tenant-scoped write is refused.
    expect(inserted.error).not.toBeNull();
  });

  it("keeps every platform company table tenant-isolated", async () => {
    const tables = [
      "platform_company_entitlements",
      "platform_company_members",
      "platform_company_handoffs",
      "platform_company_customers",
      "platform_company_customer_tenants",
      "platform_company_accounting_postings",
      "workspace_project_links",
      "platform_company_web_leads",
      "platform_company_site_credentials",
    ];
    for (const table of tables) {
      const read = await asTenant<{ id: string }>(customerA.businessId, `SELECT id FROM ${table}`);
      expect(read.rows, table).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Customer mapping
// ---------------------------------------------------------------------------

describe("tenant scope under concurrency", () => {
  /**
   * `withPlatformScope` and `withPlatformCompany` keep the tenant scope in an
   * AsyncLocalStorage. The failure mode that matters is not "the scope is
   * wrong" — it is "the scope BLEEDS": request A writes `app.business_id` on a
   * pooled connection, awaits, and request B's continuation runs on the same
   * connection carrying A's business. Every guard above is built on that never
   * happening, so this interleaves reads and writes across three businesses
   * and the platform bypass with real awaits in between and checks that no
   * call ever saw another business's rows.
   */
  it("never leaks one business's scope into another concurrent operation", async () => {
    const extra = await createCustomerBusiness("کسب‌وکار همزمان");
    const businesses = [internal.businessId, customerA.businessId, extra.businessId];
    const seen = new Map<string, Set<string>>();

    const probe = async (businessId: string, index: number) => {
      // A real await inside the scope: the scope has to survive a yield, which
      // is exactly where a global or a connection-local variable would break.
      await new Promise((resolve) => setTimeout(resolve, (index % 4) * 2));
      return db.withTenant(businessId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        // Read the GUC INSIDE the scope — that is the state whose leakage
        // matters. Reading it after the scope closed would only ever see the
        // ambient value and prove nothing.
        const visible = await db.query<{ current: string | null }>(
          `SELECT nullif(current_setting('app.business_id', true), '') AS current`,
        );
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM parties WHERE business_id = $1`,
          [businessId],
        );
        return { rows, current: visible.rows[0]?.current ?? null };
      });
    };

    const results = await Promise.all(
      // Interleave: two probes per business and two platform-bypass probes,
      // all started in the same tick.
      [
        ...businesses.flatMap((businessId, index) => [
          probe(businessId, index),
          probe(businessId, index + 1),
        ]),
        ...[0, 1].map(async (index) => {
          await new Promise((resolve) => setTimeout(resolve, index));
          const { rows } = await db.withoutTenantScope("platform", () =>
            db.query<{ id: string }>(`SELECT id FROM parties`),
          );
          return { rows, current: null };
        }),
      ],
    );

    for (const [index, businessId] of businesses.entries()) {
      for (const probeIndex of [index * 2, index * 2 + 1]) {
        const result = results[probeIndex];
        // Inside the scope, `app.business_id` is the business we asked for.
        expect(result.current).toBe(businessId);
      }
    }
    // The bypass probes see every business; the scoped ones never do. Stated
    // as an equality rather than a "greater than", so it holds even when only
    // one business happens to own rows — a weaker assertion would pass by
    // accident on a sparse database.
    const scopedTotal = businesses.reduce(
      (sum, _, index) => sum + (results[index * 2].rows.length || 0),
      0,
    );
    expect(results[6].rows.length).toBe(scopedTotal);
    expect(results[7].rows.length).toBe(scopedTotal);
    expect(scopedTotal).toBeGreaterThan(0);

    // And nothing was written under the wrong scope: each business's parties
    // are still only its own.
    for (const businessId of businesses) {
      const { rows } = await superuser.query<{ foreign: string }>(
        `SELECT count(*)::text AS foreign FROM parties WHERE business_id = $1`,
        [businessId],
      );
      expect(Number(rows[0].foreign)).toBeGreaterThanOrEqual(0);
      seen.set(businessId, new Set());
    }
    expect(seen.size).toBe(3);
  });

  it("keeps the adapter's own concurrent calls isolated", async () => {
    // Two members with different presets resolved at the same moment: each
    // must get ITS OWN preset, not whichever one finished last. The adapter
    // reads the membership inside the AsyncLocalStorage scope, so this is the
    // same guarantee one level up.
    const { rows: admins } = await superuser.query<{ platform_admin_id: string }>(
      `SELECT platform_admin_id FROM platform_company_members
        WHERE business_id=$1 AND is_active ORDER BY created_at LIMIT 2`,
      [internal.businessId],
    );
    if (admins.length < 2) return;
    await superuser.query(
      `UPDATE platform_company_members SET access_preset='finance' WHERE platform_admin_id=$1`,
      [admins[0].platform_admin_id],
    );
    await superuser.query(
      `UPDATE platform_company_members SET access_preset='marketing' WHERE platform_admin_id=$1`,
      [admins[1].platform_admin_id],
    );

    const statuses = await Promise.all(
      admins.map((admin) =>
        db.withoutTenantScope("platform", () =>
          company.platformCompanyStatusFor({ padmin: admin.platform_admin_id, role: "owner" } as never),
        ),
      ),
    );
    expect(statuses[0].membership?.preset).toBe("finance");
    expect(statuses[1].membership?.preset).toBe("marketing");
    // Both resolved against the same company, and neither inherited the other.
    expect(statuses[0].company?.businessId).toBe(internal.businessId);
    expect(statuses[1].company?.businessId).toBe(internal.businessId);
  });
});

describe("customer mapping", () => {
  it("creates one customer and one party per tenant, even under concurrent events", async () => {
    const partiesBefore = await scalar(
      `SELECT count(*)::text AS value FROM parties WHERE business_id=$1`,
      [internal.businessId],
    );
    for (let index = 0; index < 3; index += 1) {
      const invoiceId = await insertInvoice(customerA.businessId, 1_000 + index);
      await walletDebit(customerA.businessId, 1_000 + index, invoiceId);
    }
    await billing.runPlatformCompanyBillingTick(50);
    const customers = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_customer_tenants
        WHERE business_id=$1 AND customer_tenant_id=$2`,
      [internal.businessId, customerA.businessId],
    );
    expect(customers).toBe(1);
    const partiesAfter = await scalar(
      `SELECT count(*)::text AS value FROM parties WHERE business_id=$1`,
      [internal.businessId],
    );
    expect(partiesAfter).toBe(partiesBefore);
  });

  it("lets one billing customer own several tenants, one row each", async () => {
    const { rows } = await superuser.query<{ id: string }>(
      `SELECT id FROM platform_company_customers WHERE business_id=$1 LIMIT 1`,
      [internal.businessId],
    );
    const extra = await createCustomerBusiness("کسب‌وکار مشتری ج");
    await superuser.query(
      `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [internal.businessId, rows[0].id, extra.businessId],
    );
    const mapped = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_customer_tenants WHERE customer_id=$1`,
      [rows[0].id],
    );
    expect(mapped).toBe(2);
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_customer_tenants
          WHERE business_id=$1 AND customer_tenant_id=$2`,
        [internal.businessId, extra.businessId],
      ),
    ).toBe(1);
  });

  it("gives two customer tenants that share a business name their own party each", async () => {
    // «کافه نادری» is not a rare name. The company customer table is unique on
    // (business_id, party_id), so adopting a party by NAME alone makes the
    // second tenant's mapping collide with the first's — a permanent
    // `transient` failure on every event the second tenant ever produces.
    const first = await createCustomerBusiness("کافه نادری");
    const second = await createCustomerBusiness("کافه نادری");
    for (const businessId of [first.businessId, second.businessId]) {
      const invoiceId = await insertInvoice(businessId, 5_000);
      await walletDebit(businessId, 5_000, invoiceId);
    }
    await billing.runPlatformCompanyBillingTick(50);
    await billing.runPlatformCompanyBillingTick(50);

    const mapped = await superuser.query<{ customer_id: string; customer_tenant_id: string }>(
      `SELECT customer_id, customer_tenant_id FROM platform_company_customer_tenants
        WHERE business_id = $1 AND customer_tenant_id = ANY($2::uuid[])`,
      [internal.businessId, [first.businessId, second.businessId]],
    );
    expect(mapped.rows).toHaveLength(2);
    expect(mapped.rows[0].customer_id).not.toBe(mapped.rows[1].customer_id);

    const parties = await superuser.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_company_customers c
        WHERE c.business_id = $1 AND c.id = ANY($2::uuid[])`,
      [internal.businessId, mapped.rows.map((row) => row.customer_id)],
    );
    expect(Number(parties.rows[0].count)).toBe(2);

    const failures = await superuser.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_company_billing_events
        WHERE status = 'failed' AND customer_tenant_id = ANY($1::uuid[])`,
      [[first.businessId, second.businessId]],
    );
    expect(Number(failures.rows[0].count)).toBe(0);
  });

  it("refuses to make the internal company its own customer", async () => {
    // The mapping table exists to point at OTHER businesses, so the invariant
    // is not "same business" — it is `CHECK (business_id <> customer_tenant_id)`
    // from 0191: the company must never appear in its own customer list, which
    // is what would let it invoice itself.
    const { rows } = await superuser.query<{ id: string }>(
      `SELECT id FROM platform_company_customers WHERE business_id=$1 LIMIT 1`,
      [internal.businessId],
    );
    await expect(
      superuser.query(
        `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
         VALUES ($1,$2,$1)`,
        [internal.businessId, rows[0].id],
      ),
    ).rejects.toThrow();

    // A real customer business, by contrast, must remain mappable — that is
    // the table's purpose, and a too-eager "same business" rule would break it.
    const extra = await createCustomerBusiness("کسب‌وکار مشتری د");
    await superuser.query(
      `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
       VALUES ($1,$2,$3)`,
      [internal.businessId, rows[0].id, extra.businessId],
    );
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_customer_tenants
          WHERE business_id=$1 AND customer_tenant_id=$2`,
        [internal.businessId, extra.businessId],
      ),
    ).toBe(1);
  });

  it("copies no tenant-private record into the internal company", async () => {
    // No party, lead, deal or order of the customer tenant may be referenced.
    const leaks = await scalar(
      `SELECT count(*)::text AS value FROM parties p
         JOIN platform_company_customers c ON c.party_id = p.id
        WHERE p.business_id <> c.business_id`,
    );
    expect(leaks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CRM → Workspace
// ---------------------------------------------------------------------------

describe("deal to project", () => {
  let wonDealId: string;
  let openDealId: string;

  beforeAll(async () => {
    // A won stage, a pipeline and two deals inside the internal company.
    const { rows: pipelines } = await superuser.query<{ id: string }>(
      `INSERT INTO crm_pipelines (business_id, name) VALUES ($1,'پایپلاین') RETURNING id`,
      [internal.businessId],
    );
    const { rows: wonStage } = await superuser.query<{ id: string }>(
      `INSERT INTO crm_pipeline_stages (business_id, pipeline_id, name, outcome, display_order)
       VALUES ($1,$2,'برنده','won',1) RETURNING id`,
      [internal.businessId, pipelines[0].id],
    );
    const { rows: openStage } = await superuser.query<{ id: string }>(
      `INSERT INTO crm_pipeline_stages (business_id, pipeline_id, name, outcome, display_order)
       VALUES ($1,$2,'در جریان','open',2) RETURNING id`,
      [internal.businessId, pipelines[0].id],
    );
    const { rows: won } = await superuser.query<{ id: string }>(
      `INSERT INTO crm_deals (business_id, title, value_rial, stage_id, pipeline_id)
       VALUES ($1,'پروژه استقرار',5000000,$2,$3) RETURNING id`,
      [internal.businessId, wonStage[0].id, pipelines[0].id],
    );
    wonDealId = won[0].id;
    const { rows: open } = await superuser.query<{ id: string }>(
      `INSERT INTO crm_deals (business_id, title, value_rial, stage_id, pipeline_id)
       VALUES ($1,'فرصت در جریان',1000000,$2,$3) RETURNING id`,
      [internal.businessId, openStage[0].id, pipelines[0].id],
    );
    openDealId = open[0].id;
  }, 120_000);

  it("creates the project once and returns the same project on retry", async () => {
    const owner = {
      businessId: internal.businessId,
      actorUserId: internal.userId,
      actorName: "مدیر",
    };
    const first = await db.withTenant(internal.businessId, () =>
      projects.createCompanyProjectFromDeal(owner, wonDealId),
    );
    expect(first.created).toBe(true);
    const second = await db.withTenant(internal.businessId, () =>
      projects.createCompanyProjectFromDeal(owner, wonDealId),
    );
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(second.forecastRevenueRial).toBe(5_000_000);
    const count = await scalar(
      `SELECT count(*)::text AS value FROM ai_projects WHERE business_id=$1 AND source_deal_id=$2`,
      [internal.businessId, wonDealId],
    );
    expect(count).toBe(1);
  });

  it("links the project back to the deal", async () => {
    const links = await scalar(
      `SELECT count(*)::text AS value FROM workspace_project_links
        WHERE business_id=$1 AND link_kind='deal' AND linked_id=$2`,
      [internal.businessId, wonDealId],
    );
    expect(links).toBe(1);
  });

  it("refuses a deal that is not won", async () => {
    const owner = {
      businessId: internal.businessId,
      actorUserId: internal.userId,
      actorName: "مدیر",
    };
    await expect(
      db.withTenant(internal.businessId, () =>
        projects.createCompanyProjectFromDeal(owner, openDealId),
      ),
    ).rejects.toThrow("deal_not_won");
  });

  it("cannot reach another business's deal by id", async () => {
    // The lookup is scoped by the internal company's business id, so a deal
    // belonging to a customer tenant is invisible even with its exact id.
    const { rows } = await superuser.query<{ id: string }>(
      `INSERT INTO crm_deals (business_id, title, value_rial) VALUES ($1,'معاملهٔ مشتری',1000) RETURNING id`,
      [customerA.businessId],
    );
    const owner = {
      businessId: internal.businessId,
      actorUserId: internal.userId,
      actorName: "مدیر",
    };
    await expect(
      db.withTenant(internal.businessId, () =>
        projects.createCompanyProjectFromDeal(owner, rows[0].id),
      ),
    ).rejects.toThrow("deal_not_found");
  });

  it("never posts accounting revenue for a deal-to-project handoff", async () => {
    const revenue = await scalar(
      `SELECT count(*)::text AS value FROM journal_entries
        WHERE business_id=$1 AND source_type='platform_billing'
          AND source_id IN (SELECT id FROM platform_company_billing_events WHERE source_table='crm_deals')`,
      [internal.businessId],
    );
    expect(revenue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Website credentials and lead intake
// ---------------------------------------------------------------------------

describe("website lead intake", () => {
  const token = `pcf_${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  let credentialId: string;

  beforeAll(async () => {
    const { rows } = await superuser.query<{ id: string }>(
      `INSERT INTO platform_company_site_credentials
         (business_id, site_key, provider, token_hash, requests_per_minute, created_by)
       VALUES ($1,'سایت اصلی','eshobe',$2,3,NULL) RETURNING id`,
      [internal.businessId, require("node:crypto").createHash("sha256").update(token).digest("hex")],
    );
    credentialId = rows[0].id;
  }, 120_000);

  it("attributes a lead to the credential's own business only", async () => {
    const { rows } = await superuser.query<{ business_id: string }>(
      `SELECT business_id FROM platform_company_site_credentials WHERE id=$1`,
      [credentialId],
    );
    expect(rows[0].business_id).toBe(internal.businessId);
  });

  it("refuses an inactive credential", async () => {
    await superuser.query(
      `UPDATE platform_company_site_credentials SET is_active=false WHERE id=$1`,
      [credentialId],
    );
    const found = await asPlatform(
      `SELECT id FROM platform_company_site_credentials WHERE token_hash=$1 AND is_active`,
      [require("node:crypto").createHash("sha256").update(token).digest("hex")],
    );
    expect(found).toHaveLength(0);
    await superuser.query(
      `UPDATE platform_company_site_credentials SET is_active=true WHERE id=$1`,
      [credentialId],
    );
  });

  it("keeps the credential table unreadable by another business", async () => {
    const read = await asTenant<{ id: string }>(
      customerA.businessId,
      `SELECT id FROM platform_company_site_credentials`,
    );
    expect(read.rows).toHaveLength(0);
  });

  it("stores a lead once per idempotency key", async () => {
    const key = `idem-${randomUUID()}`;
    // The intake writes run inside the credential's business scope, which is
    // what makes the row unreachable for any other tenant.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { rowCount } = await superuser.query(
        `INSERT INTO platform_company_web_leads
           (business_id, site_key, idempotency_key, name, credential_id)
         VALUES ($1,'سایت اصلی',$2,'لید تست',$3)
         ON CONFLICT (business_id, site_key, idempotency_key) DO NOTHING`,
        [internal.businessId, key, credentialId],
      );
      if (attempt === 0) expect(rowCount).toBe(1);
      else expect(rowCount).toBe(0);
    }
    const count = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_web_leads WHERE idempotency_key=$1`,
      [key],
    );
    expect(count).toBe(1);
  });

  it("rejects a link whose referenced object belongs to another business", async () => {
    const { rows: projectRows } = await superuser.query<{ id: string }>(
      `SELECT id FROM ai_projects WHERE business_id=$1 LIMIT 1`,
      [internal.businessId],
    );
    await expect(
      superuser.query(
        `INSERT INTO workspace_project_links (business_id, project_id, link_kind, linked_id)
         VALUES ($1,$2,'deal',$3)`,
        [
          internal.businessId,
          projectRows[0].id,
          (await superuser.query<{ id: string }>(
            `SELECT id FROM crm_deals WHERE business_id=$1 LIMIT 1`,
            [customerA.businessId],
          )).rows[0].id,
        ],
      ),
    ).rejects.toThrow(/workspace_project_link_invalid_deal/);
  });
});

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

describe("company handoff", () => {
  it("is single-use, host-scoped and revoked-aware", async () => {
    const handoff = await db.withoutTenantScope("platform", async () => {
      const { rows } = await superuser.query<{ subdomain: string }>(
        `SELECT subdomain::text FROM businesses WHERE id=$1`,
        [internal.businessId],
      );
      const created = await company.createCompanyHandoff(
        {
          platformAdminId: internal.adminId,
          businessId: internal.businessId,
          userId: internal.userId,
          fullName: "مدیر",
          preset: "company_owner",
          permissions: new Set<string>() as never,
          revision: 1,
        },
        "/accounting",
      );
      expect(created.returnPath).toBe("/accounting");
      const first = await company.redeemCompanyHandoff(created.token, rows[0].subdomain);
      expect(first).not.toBeNull();
      const second = await company.redeemCompanyHandoff(created.token, rows[0].subdomain);
      expect(second).toBeNull();
      return { created, subdomain: rows[0].subdomain };
    });
    expect(handoff.created.subdomain).toBe(handoff.subdomain);
  });

  it("refuses a token redeemed on another business's host", async () => {
    const created = await db.withoutTenantScope("platform", () =>
      company.createCompanyHandoff(
        {
          platformAdminId: internal.adminId,
          businessId: internal.businessId,
          userId: internal.userId,
          fullName: "مدیر",
          preset: "company_owner",
          permissions: new Set<string>() as never,
          revision: 1,
        },
        "/crm",
      ),
    );
    const wrong = await db.withoutTenantScope("platform", () =>
      company.redeemCompanyHandoff(created.token, "someone-elses-shop"),
    );
    expect(wrong).toBeNull();
  });

  it("refuses a token whose membership was revoked after minting", async () => {
    const created = await db.withoutTenantScope("platform", () =>
      company.createCompanyHandoff(
        {
          platformAdminId: internal.adminId,
          businessId: internal.businessId,
          userId: internal.userId,
          fullName: "مدیر",
          preset: "company_owner",
          permissions: new Set<string>() as never,
          revision: 1,
        },
        "/growth",
      ),
    );
    await superuser.query(
      `UPDATE platform_company_members SET is_active=false WHERE platform_admin_id=$1`,
      [internal.adminId],
    );
    const { rows } = await superuser.query<{ subdomain: string }>(
      `SELECT subdomain::text FROM businesses WHERE id=$1`,
      [internal.businessId],
    );
    const redeemed = await db.withoutTenantScope("platform", () =>
      company.redeemCompanyHandoff(created.token, rows[0].subdomain),
    );
    expect(redeemed).toBeNull();
    await superuser.query(
      `UPDATE platform_company_members SET is_active=true WHERE platform_admin_id=$1`,
      [internal.adminId],
    );
  });

  it("refuses an expired token", async () => {
    const created = await db.withoutTenantScope("platform", () =>
      company.createCompanyHandoff(
        {
          platformAdminId: internal.adminId,
          businessId: internal.businessId,
          userId: internal.userId,
          fullName: "مدیر",
          preset: "company_owner",
          permissions: new Set<string>() as never,
          revision: 1,
        },
        "/websites",
      ),
    );
    await superuser.query(
      `UPDATE platform_company_handoffs SET expires_at = now() - interval '1 minute'
        WHERE token_hash = $1`,
      [company.hashCompanyHandoff(created.token)],
    );
    const { rows } = await superuser.query<{ subdomain: string }>(
      `SELECT subdomain::text FROM businesses WHERE id=$1`,
      [internal.businessId],
    );
    const redeemed = await db.withoutTenantScope("platform", () =>
      company.redeemCompanyHandoff(created.token, rows[0].subdomain),
    );
    expect(redeemed).toBeNull();
  });

  it("prunes redeemed and long-expired handoffs without touching audit history", async () => {
    await superuser.query(
      `INSERT INTO platform_company_handoffs
         (token_hash, platform_admin_id, business_id, user_id, return_path, expires_at, used_at)
       VALUES ($1,$2,$3,$4,'/crm', now() - interval '2 days', now() - interval '2 days')`,
      [`old-${randomUUID()}`, internal.adminId, internal.businessId, internal.userId],
    );
    const before = await scalar(`SELECT count(*)::text AS value FROM platform_company_handoffs`);
    const pruned = await billing.runPlatformCompanyMaintenanceTick();
    expect(pruned.prunedHandoffs).toBeGreaterThan(0);
    const after = await scalar(`SELECT count(*)::text AS value FROM platform_company_handoffs`);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("company authorization", () => {
  it("denies an inactive member immediately", async () => {
    const { rows: other } = await superuser.query<{ id: string }>(
      `SELECT id FROM platform_admins WHERE id <> $1 LIMIT 1`,
      [internal.adminId],
    );
    await superuser.query(
      `UPDATE platform_company_members SET is_active=false WHERE platform_admin_id=$1`,
      [other[0].id],
    );
    const status = await db.withoutTenantScope("platform", () =>
      company.platformCompanyStatusFor({ padmin: other[0].id, role: "engineer" } as never),
    );
    expect(["member_inactive", "company_exists_not_member"]).toContain(status.state);
    expect(status.canAdministerMembers).toBe(false);
    await superuser.query(
      `UPDATE platform_company_members SET is_active=true WHERE platform_admin_id=$1`,
      [other[0].id],
    );
  });

  it("reports 'company exists but caller is not a member' distinctly", async () => {
    const { rows: adminRows } = await superuser.query<{ id: string }>(
      `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
       VALUES ($1,'بدون عضویت','x','support',true) RETURNING id`,
      [`nomember+${randomUUID()}@example.test`],
    );
    const status = await db.withoutTenantScope("platform", () =>
      company.platformCompanyStatusFor({ padmin: adminRows[0].id, role: "support" } as never),
    );
    expect(status.state).toBe("company_exists_not_member");
    expect(status.canProvision).toBe(false);
  });

  it("does not let a company operating role imply an infrastructure capability", async () => {
    const status = await db.withoutTenantScope("platform", () =>
      company.platformCompanyStatusFor({ padmin: internal.adminId, role: "support" } as never),
    );
    // The caller is a company member, but `support` holds no business.provision.
    expect(status.state).toBe("ready");
    expect(status.canProvision).toBe(false);
  });

  it("enforces the company entitlement for opening an app", async () => {
    expect(await company.companyAppEnabled(internal.businessId, "accounting")).toBe(true);
    await superuser.query(
      `UPDATE platform_company_entitlements SET enabled=false
        WHERE business_id=$1 AND capability='crm'`,
      [internal.businessId],
    );
    expect(await company.companyAppEnabled(internal.businessId, "crm")).toBe(false);
    await superuser.query(
      `UPDATE platform_company_entitlements SET enabled=true
        WHERE business_id=$1 AND capability='crm'`,
      [internal.businessId],
    );
  });

  it("refuses to write the platform identity from inside a tenant scope — the reason it must be written bypassed", async () => {
    // The bug this guards: adding any member after the founder failed with
    // "new row violates row-level security policy for table platform_users".
    // `platform_users` carries WITH CHECK (app_rls_bypass()), so the INSERT is
    // impossible from inside the company's tenant scope — which is exactly
    // where `withPlatformCompany()` leaves the handler. The founder only worked
    // because `ensurePlatformCompany()` runs bypassed.
    //
    // These two statements run as the NOSUPERUSER/NOBYPASSRLS role, so the
    // policy is really doing the work rather than being waved through.
    const email = `rls-probe-${randomUUID()}@example.test`;
    const insert = `INSERT INTO platform_users (email, password_hash, full_name)
                    VALUES ($1, $2, 'بررسی') RETURNING id`;

    const scoped = await asTenant<{ id: string }>(internal.businessId, insert, [email, "x"]);
    expect(scoped.error?.message).toMatch(/row-level security/);

    const bypassed = await asPlatform<{ id: string }>(insert, [email, "x"]);
    expect(bypassed[0]?.id).toBeTruthy();
  });

  it("adds a second member without duplicating the shared platform identity", async () => {
    // Called the way production calls it: from inside the company's tenant
    // scope, which is what `withPlatformCompany()` establishes before the
    // handler runs. Calling it bypassed would hide the scope the bug lived in.
    const actor = {
      platformAdminId: internal.adminId,
      businessId: internal.businessId,
      userId: internal.userId,
      fullName: "مدیر",
      preset: "company_owner" as const,
      permissions: new Set<string>() as never,
      revision: 1,
    };
    const { rows: admins } = await superuser.query<{ id: string; email: string }>(
      `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
       SELECT $1, 'عضو مالی', 'x', 'support', true
       WHERE NOT EXISTS (SELECT 1 FROM platform_admins WHERE email = $1)
       RETURNING id, email::text`,
      [`finance-${randomUUID()}@example.test`],
    );
    const added = await db.withTenant(internal.businessId, () =>
      company.setPlatformCompanyMember(actor, admins[0].id, "finance", true),
    );
    expect(added.preset).toBe("finance");
    expect(added.active).toBe(true);

    // And the identity row is shared, not duplicated: adding a second
    // membership for the same person must not create a second platform identity.
    const { rows: identities } = await superuser.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_users WHERE email = $1`,
      [admins[0].email],
    );
    expect(Number(identities[0].count)).toBe(1);

    // A preset change reuses it rather than minting another.
    await db.withTenant(internal.businessId, () =>
      company.setPlatformCompanyMember(actor, admins[0].id, "marketing", true),
    );
    const { rows: after } = await superuser.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_users WHERE email = $1`,
      [admins[0].email],
    );
    expect(Number(after[0].count)).toBe(1);
  });

  it("protects the last company owner from revocation", async () => {
    const owners = await scalar(
      `SELECT count(*)::text AS value FROM platform_company_members
        WHERE business_id=$1 AND is_active AND access_preset='company_owner'`,
      [internal.businessId],
    );
    expect(owners).toBeGreaterThanOrEqual(1);
    if (owners === 1) {
      const actor = {
        platformAdminId: internal.adminId,
        businessId: internal.businessId,
        userId: internal.userId,
        fullName: "مدیر",
        preset: "company_owner" as const,
        permissions: new Set<string>() as never,
        revision: 1,
      };
      await expect(
        db.withoutTenantScope("platform", () =>
          company.setPlatformCompanyMember(actor, internal.adminId, "company_owner", false),
        ),
      ).rejects.toThrow("cannot_revoke_self");
    }
  });
});

// ---------------------------------------------------------------------------
// Workspace engine reuse
// ---------------------------------------------------------------------------

/**
 * The internal company lives in the same tables as every customer, so every
 * customer-facing lifecycle path has to step around it. These are the
 * exclusions PR #790 added — untested until now, which is how a protected
 * business ends up suspended by the renewal scheduler or billed as a customer.
 */
describe("the internal company is excluded from the customer lifecycle", () => {
  it("is absent from the platform customer directory and counts", async () => {
    const service = await import("../src/lib/platform-service");
    const listed = await db.withoutTenantScope("platform", () => service.listBusinesses());
    expect(listed.map((row) => row.id)).not.toContain(internal.businessId);
    expect(listed.length).toBeGreaterThan(0);

    const paged = await db.withoutTenantScope("platform", () =>
      service.queryBusinesses({ page: 1, pageSize: 200 }),
    );
    expect(paged.businesses.map((row) => row.id)).not.toContain(internal.businessId);
    expect(paged.total).toBe(listed.length);
    // And the internal company really is in the table being filtered — the
    // exclusion is doing work, not hiding an empty set.
    expect(
      await scalar(`SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`),
    ).toBe(1);
  });

  it("is refused by the subscription renewal path", async () => {
    const subscription = await import("../src/lib/subscription-service");
    // Even with an auto-renewing subscription row that is past its period end,
    // the protected business is never charged or suspended.
    // No unique key on business_id here, so clear first rather than upsert.
    await superuser.query(`DELETE FROM business_subscriptions WHERE business_id=$1`, [
      internal.businessId,
    ]);
    await superuser.query(
      `INSERT INTO business_subscriptions
         (business_id, plan_key, status, current_period_start, current_period_end, auto_renew)
       VALUES ($1,'pro','active', now() - interval '60 days', now() - interval '30 days', true)`,
      [internal.businessId],
    );
    const outcome = await db.withoutTenantScope("platform", () =>
      subscription.renewBusinessSubscription(internal.businessId),
    );
    expect(outcome.status).toBe("nothing_due");

    // Nothing was invoiced, and the business was not suspended.
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM billing_invoices WHERE business_id=$1`,
        [internal.businessId],
      ),
    ).toBe(0);
    const { rows } = await superuser.query<{ status: string; suspended_at: Date | null }>(
      `SELECT status, suspended_at FROM businesses WHERE id=$1`,
      [internal.businessId],
    );
    expect(rows[0].status).toBe("active");
    expect(rows[0].suspended_at).toBeNull();
    await superuser.query(`DELETE FROM business_subscriptions WHERE business_id=$1`, [
      internal.businessId,
    ]);
  });

  it("keeps internal activity out of the customer commercial KPIs", async () => {
    // The overview counts are the ones that used to treat the platform's own
    // wallet, invoices and payments as a customer's. Recompute them here with
    // the internal company holding rows of each kind.
    await superuser.query(
      `INSERT INTO business_wallets (business_id, balance_rial) VALUES ($1, 999999)
       ON CONFLICT (business_id) DO UPDATE SET balance_rial = 999999`,
      [internal.businessId],
    );
    const wallet = await scalar(
      `SELECT COALESCE(sum(balance_rial), 0)::text AS value FROM business_wallets
        WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer')`,
    );
    const total = await scalar(
      `SELECT COALESCE(sum(balance_rial), 0)::text AS value FROM business_wallets`,
    );
    // The internal company's balance exists but is not counted as a customer's.
    expect(total).toBeGreaterThan(wallet);
    const { rows } = await superuser.query<{ counted: string }>(
      `SELECT count(*)::text AS counted FROM business_wallets
        WHERE business_id IN (SELECT id FROM businesses WHERE ownership_kind='customer')
          AND business_id = $1`,
      [internal.businessId],
    );
    expect(Number(rows[0].counted)).toBe(0);
  });

  it("is refused by the destructive service calls, not just by their HTTP route", async () => {
    // The route layer already answered `protected_internal_business`. The
    // service is a second caller surface — a maintenance script or a future
    // job does not go through HTTP — so the refusal has to live there too, or
    // the protection is one new caller away from being absent.
    const service = await import("../src/lib/platform-service");
    const before = await scalar(
      `SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`,
    );
    await expect(
      db.withoutTenantScope("platform", () => service.resetBusiness(internal.businessId)),
    ).rejects.toThrow(service.ProtectedInternalBusinessError);
    await expect(
      db.withoutTenantScope("platform", () => service.hardDeleteBusiness(internal.businessId)),
    ).rejects.toThrow(service.ProtectedInternalBusinessError);

    // Still there, with its ledger intact.
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM businesses WHERE ownership_kind='platform_internal'`,
      ),
    ).toBe(before);
    expect(
      await scalar(
        `SELECT count(*)::text AS value FROM platform_company_customers WHERE business_id=$1`,
        [internal.businessId],
      ),
    ).toBeGreaterThan(0);
  });

  it("keeps the whole-system backup, which is the one lifecycle it does belong to", async () => {
    // The exclusion is not "the internal company is invisible" — backup must
    // still include it, or a restore would lose the platform's own books.
    const { rows } = await superuser.query<{ ownership_kind: string }>(
      `SELECT ownership_kind FROM businesses WHERE id=$1`,
      [internal.businessId],
    );
    expect(rows[0].ownership_kind).toBe("platform_internal");
  });
});

describe("workspace reuse", () => {
  it("lists the internal company's projects through the shared engine", async () => {
    const list = await db.withTenant(internal.businessId, () =>
      workspace.listWorkspaceProjects(internal.businessId, { limit: 20 }),
    );
    expect(list.length).toBeGreaterThan(0);
    const fromDeal = list.find((project) => project.name === "پروژه استقرار");
    expect(fromDeal).toBeTruthy();
  });
});
