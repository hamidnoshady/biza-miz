/**
 * Codex review regressions for PR #806, against real PostgreSQL.
 *
 * Source writes, posting and the CRM/Growth route handlers use the restricted
 * runtime role (NOSUPERUSER/NOBYPASSRLS). Only fixture DDL and inspection use
 * the database owner. The sole framework stub is the request cookie store;
 * session verification, active-identity/membership checks, permissions and
 * tenant scoping all remain real.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";
import type { PlatformCompanyCustomerSummary } from "../src/lib/platform-company-types";
import type { GrowthAudienceSummary } from "../src/app/api/platform/company/growth/audience/route";

const cookie = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "pos_platform_session" && cookie.value
      ? { value: cookie.value }
      : undefined,
  }),
}));

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
const originalDeploymentRole = process.env.DEPLOYMENT_ROLE;
const exec = promisify(execFile);
const roleName = "pos_platco_review";
const rolePassword = "platform_company_review_test_only";
let databaseName: string;
let owner: Client;
let db: typeof import("../src/lib/db");
let billing: typeof import("../src/lib/platform-company-billing");
let crm: typeof import("../src/lib/crm-service");
let customerRoute: typeof import("../src/app/api/platform/company/crm/customers/route");
let growthRoute: typeof import("../src/app/api/platform/company/growth/audience/route");
let companyId: string;

function databaseUrl(database: string, appRole = false): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (appRole) {
    url.username = roleName;
    url.password = rolePassword;
  }
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_platco_review_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: databaseUrl("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: databaseUrl(databaseName), quiet: true });
  await createAppRole({ databaseUrl: databaseUrl(databaseName), roleName, password: rolePassword, quiet: true });
  owner = new Client({ connectionString: databaseUrl(databaseName) });
  await owner.connect();
  const { rows: admins } = await owner.query<{ id: string }>(
    `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
     VALUES ($1, 'مدیر آزمون', 'x', 'owner', true) RETURNING id`,
    [`review-${randomUUID()}@example.test`],
  );
  process.env.DATABASE_URL = databaseUrl(databaseName, true);
  process.env.DEPLOYMENT_ROLE = "central";
  db = await import("../src/lib/db");
  billing = await import("../src/lib/platform-company-billing");
  crm = await import("../src/lib/crm-service");
  const company = await import("../src/lib/platform-company");
  const auth = await import("../src/lib/platform-auth");
  const session = { padmin: admins[0].id, role: "owner" as const, fullName: "مدیر آزمون", email: "review@example.test" };
  const provisioned = await db.withoutTenantScope("platform", () => company.ensurePlatformCompany(session));
  companyId = provisioned!.business_id;
  cookie.value = await auth.signPlatformSession(session);
  customerRoute = await import("../src/app/api/platform/company/crm/customers/route");
  growthRoute = await import("../src/app/api/platform/company/growth/audience/route");
}, 180_000);

afterAll(async () => {
  cookie.value = "";
  await db?.closeDatabasePool();
  await owner?.end();
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (originalDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = originalDeploymentRole;
  if (databaseName) {
    const maintenance = new Client({ connectionString: databaseUrl("postgres") });
    await maintenance.connect();
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await maintenance.end();
    }
  }
});

async function newTenant(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain, ownership_kind, status)
     VALUES ('مشتری آزمون', $1, $1, 'customer', 'active') RETURNING id`,
    [`review-${randomUUID().slice(0, 12)}`],
  );
  return rows[0].id;
}

async function invoice(tenantId: string, total = 1_000_000): Promise<string> {
  const { rows } = await db.withTenant(tenantId, () => db.query<{ id: string }>(
    `INSERT INTO billing_invoices (business_id, invoice_number, reference, status, subtotal_rial, total_rial)
     VALUES ($1, $2, $2, 'open', $3, $3) RETURNING id`,
    [tenantId, `review-${randomUUID()}`, total],
  ));
  return rows[0].id;
}

async function debitWallet(tenantId: string, invoiceId: string, amount: number) {
  await db.withTenant(tenantId, () => db.query(
    `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
     VALUES ($1, 'subscription', 'debit', $2, 5000000, jsonb_build_object('invoiceId', $3::text))`,
    [tenantId, amount, invoiceId],
  ));
}

async function verifyPayment(tenantId: string, invoiceId: string, amount: number, gateway = "zarinpal") {
  return db.withTenant(tenantId, async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO billing_payments (business_id, invoice_id, gateway, amount_rial, credit_rial, status)
       VALUES ($1, $2, $3, $4, 0, 'pending') RETURNING id`,
      [tenantId, invoiceId, gateway, amount],
    );
    await db.query(`UPDATE billing_payments SET status='verified', verified_at=now() WHERE id=$1`, [rows[0].id]);
    return rows[0].id;
  });
}

async function recordPaid(tenantId: string, invoiceId: string, amount: number) {
  await db.withTenant(tenantId, () => db.query(
    `UPDATE billing_invoices SET paid_rial=$2,
            status=CASE WHEN $2=total_rial THEN 'paid' ELSE 'partially_paid' END,
            updated_at=now() WHERE id=$1`,
    [invoiceId, amount],
  ));
}

async function paymentsFor(invoiceId: string) {
  const { rows } = await owner.query<{ id: string; amount_rial: string; settlement_method: string }>(
    `SELECT id, amount_rial::text, settlement_method FROM platform_company_billing_events
      WHERE customer_invoice_id=$1 AND source_kind='invoice_payment'
      ORDER BY settlement_method, occurred_at, id`,
    [invoiceId],
  );
  return rows;
}

async function post() {
  expect((await billing.runPlatformCompanyBillingTick(100)).failed).toBe(0);
}

async function customers() {
  const response = await customerRoute.GET();
  expect(response.status).toBe(200);
  return await response.json() as { customers: PlatformCompanyCustomerSummary[]; balanceSource: string };
}

async function audience() {
  const response = await growthRoute.GET();
  expect(response.status).toBe(200);
  return (await response.json() as { audience: GrowthAudienceSummary }).audience;
}

describe("verified settlement excludes its own AFTER UPDATE row from prior payments", () => {
  it("uses a real restricted runtime role", async () => {
    const { rows } = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it.each(["zarinpal", "manual"])("posts a fully %s-paid invoice exactly once", async (gateway) => {
    const tenantId = await newTenant();
    const invoiceId = await invoice(tenantId);
    const paymentId = await verifyPayment(tenantId, invoiceId, 1_000_000, gateway);
    await recordPaid(tenantId, invoiceId, 1_000_000);
    const events = await paymentsFor(invoiceId);
    expect(events).toHaveLength(1);
    expect(events[0].amount_rial).toBe("1000000");
    expect(events[0].settlement_method).toBe(gateway === "manual" ? "manual" : "gateway");
    await post();
    const { rows } = await owner.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text, jl.credit::text
         FROM platform_company_accounting_postings p
         JOIN journal_lines jl ON jl.entry_id=p.journal_entry_id
         JOIN accounts a ON a.id=jl.account_id WHERE p.event_id=$1 ORDER BY a.code`,
      [events[0].id],
    );
    expect(rows).toEqual([
      { code: "1110", debit: "1000000", credit: "0" },
      { code: "1200", debit: "0", credit: "1000000" },
    ]);
    await db.withTenant(tenantId, () => db.query(
      `UPDATE billing_payments SET status='verified' WHERE id=$1`, [paymentId],
    ));
    await post();
    expect(await paymentsFor(invoiceId)).toEqual(events);
    const count = await owner.query<{ count: string }>(
      `SELECT count(*)::text FROM platform_company_accounting_postings WHERE event_id=$1`, [events[0].id],
    );
    expect(count.rows[0].count).toBe("1");
  });

  it("does not clip a payment larger than half, or omit the final payment", async () => {
    const tenantId = await newTenant();
    const invoiceId = await invoice(tenantId);
    await verifyPayment(tenantId, invoiceId, 700_000);
    expect((await paymentsFor(invoiceId)).map(row => row.amount_rial)).toEqual(["700000"]);
    await verifyPayment(tenantId, invoiceId, 300_000);
    await recordPaid(tenantId, invoiceId, 1_000_000);
    expect((await paymentsFor(invoiceId)).map(row => Number(row.amount_rial)).sort((a, b) => a - b))
      .toEqual([300_000, 700_000]);
  });

  it("posts real 600k wallet + 400k verified gateway sources, not a residual substitute", async () => {
    const tenantId = await newTenant();
    const invoiceId = await invoice(tenantId);
    await debitWallet(tenantId, invoiceId, 600_000);
    await verifyPayment(tenantId, invoiceId, 400_000);
    await recordPaid(tenantId, invoiceId, 1_000_000);
    const events = await paymentsFor(invoiceId);
    expect(events.map(row => [row.settlement_method, row.amount_rial])).toEqual([
      ["gateway", "400000"], ["wallet", "600000"],
    ]);
    await post();
    const { rows } = await owner.query<{ code: string; debit: string }>(
      `SELECT a.code, jl.debit::text FROM platform_company_accounting_postings p
         JOIN platform_company_billing_events e ON e.id=p.event_id
         JOIN journal_lines jl ON jl.entry_id=p.journal_entry_id
         JOIN accounts a ON a.id=jl.account_id
        WHERE e.customer_invoice_id=$1 AND e.source_kind='invoice_payment' AND jl.debit>0
        ORDER BY a.code`,
      [invoiceId],
    );
    expect(rows).toEqual([{ code: "1110", debit: "400000" }, { code: "2455", debit: "600000" }]);
  });
});

describe("CRM balance follows posted receivable lines, including invoice voids", () => {
  it.each([0, 300_000, 1_000_000])("clears a void with %i Rial already paid, only after Accounting posts", async (paid) => {
    const tenantId = await newTenant();
    const invoiceId = await invoice(tenantId);
    if (paid) {
      await debitWallet(tenantId, invoiceId, paid);
      await recordPaid(tenantId, invoiceId, paid);
    }
    await post();
    const find = async () => (await customers()).customers.find(c => c.tenants.some(t => t.tenantId === tenantId))!;
    expect((await find()).accountingBalanceRial).toBe(1_000_000 - paid);
    await db.withTenant(tenantId, () => db.query(
      `UPDATE billing_invoices SET status='void', updated_at=now() WHERE id=$1`, [invoiceId],
    ));
    // Operational state cannot clear the CRM balance before the reversal posts.
    expect((await find()).accountingBalanceRial).toBe(1_000_000 - paid);
    await post();
    const customer = await find();
    expect(customer.accountingBalanceRial).toBe(0);
    expect(customer.invoicedRial).toBe(1_000_000);
    expect(customer.settledRial).toBe(1_000_000);
    const { rows } = await owner.query<{ balance: string }>(
      `SELECT COALESCE(sum(jl.debit-jl.credit),0)::text AS balance
         FROM platform_company_billing_events e
         JOIN platform_company_accounting_postings p ON p.event_id=e.id
         JOIN journal_lines jl ON jl.entry_id=p.journal_entry_id
         JOIN accounts a ON a.id=jl.account_id
        WHERE e.customer_invoice_id=$1 AND a.code='1200'`,
      [invoiceId],
    );
    expect(Number(rows[0].balance)).toBe(customer.accountingBalanceRial);
    expect((await customers()).balanceSource).toBe("accounting_postings");
  });

  it("includes posted positive adjustments and credit notes, but never wallet top-up liabilities", async () => {
    const tenantId = await newTenant();
    const invoiceId = await invoice(tenantId, 100_000);
    await post();
    const find = async () => (await customers()).customers.find(c => c.tenants.some(t => t.tenantId === tenantId))!;
    await db.withTenant(tenantId, () => db.query(
      `INSERT INTO billing_adjustments (business_id, invoice_id, amount_rial, reason)
       VALUES ($1, $2, 50000, 'additional service'), ($1, $2, -20000, 'commercial credit')`,
      [tenantId, invoiceId],
    ));
    await db.withTenant(tenantId, () => db.query(
      `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial)
       VALUES ($1, 'top_up', 'credit', 80000, 80000)`,
      [tenantId],
    ));
    expect((await find()).accountingBalanceRial).toBe(100_000);
    await post();
    const customer = await find();
    expect(customer.invoicedRial).toBe(150_000);
    expect(customer.settledRial).toBe(20_000);
    expect(customer.accountingBalanceRial).toBe(130_000);
  });
});

async function party(role = "customer", active = true): Promise<string> {
  const { rows } = await db.withTenant(companyId, () => db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles, is_active)
     VALUES ($1, 'رضایت آزمون', $2, ARRAY[$2]::text[], $3) RETURNING id`,
    [companyId, role, active],
  ));
  return rows[0].id;
}

describe("Growth consent is current CRM state, not a historical grant", () => {
  it("removes revoked SMS and email consent without deleting their audit history", async () => {
    const id = await party();
    for (const channel of ["sms", "email"] as const) {
      await crm.setConsent(companyId, id, { channel, granted: true, source: "customer_request" });
      await crm.setConsent(companyId, id, { channel, granted: false, source: "customer_request" });
    }
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text FROM crm_consent_events WHERE customer_id=$1`, [id],
    );
    expect(rows[0].count).toBe("4");
    expect((await audience()).consent).toEqual({ sms: 0, email: 0, partiesWithConsent: 0 });
  });

  it("counts the union of consenting live customers, excluding archived, merged and supplier records", async () => {
    const sms = await party();
    const email = await party();
    const both = await party();
    await crm.setConsent(companyId, sms, { channel: "sms", granted: true });
    await crm.setConsent(companyId, email, { channel: "email", granted: true });
    await crm.setConsent(companyId, both, { channel: "sms", granted: true });
    await crm.setConsent(companyId, both, { channel: "email", granted: true });
    const inactive = await party("customer", false);
    const supplier = await party("supplier");
    const merged = await party();
    await db.withTenant(companyId, () => db.query(
      `UPDATE parties SET sms_consent=true, marketing_consent=true WHERE id=ANY($1::uuid[])`,
      [[inactive, supplier, merged]],
    ));
    await db.withTenant(companyId, () => db.query(`UPDATE parties SET merged_into_id=$2 WHERE id=$1`, [merged, both]));
    expect((await audience()).consent).toEqual({ sms: 2, email: 2, partiesWithConsent: 3 });
  });
});

describe("Growth renewals are upcoming, renewable and explicitly mapped", () => {
  it("excludes old periods, cancelled/expired/scheduled cancellations and dates after 14 days", async () => {
    const cases = [
      { status: "active", days: 2, expected: true },
      { status: "trialing", days: 13, expected: true },
      { status: "past_due", days: 3, expected: true },
      { status: "active", days: -1, expected: false },
      { status: "past_due", days: -100, expected: false },
      { status: "cancelled", days: 2, expected: false },
      { status: "expired", days: 2, expected: false },
      { status: "active", days: 2, cancellation: true, expected: false },
      { status: "active", days: 15, expected: false },
      { status: "active", days: 2, archived: true, expected: false },
      { status: "active", days: 2, unmapped: true, expected: false },
    ];
    const expected: string[] = [];
    for (const scenario of cases) {
      const tenantId = await newTenant();
      // The public worker creates the explicit CRM/customer mapping; do not
      // export or bypass its private mapping implementation just for a fixture.
      if (!scenario.unmapped) {
        await invoice(tenantId, 1);
        await post();
      }
      await owner.query(
        `INSERT INTO business_subscriptions (business_id, plan_key, status, current_period_end, cancel_at_period_end, auto_renew)
         VALUES ($1, 'free', $2, now()+($3::int*interval '1 day'), $4, true)`,
        [tenantId, scenario.status, scenario.days, scenario.cancellation ?? false],
      );
      if (scenario.archived) await owner.query(`UPDATE businesses SET status='archived' WHERE id=$1`, [tenantId]);
      if (scenario.expected) expected.push(tenantId);
    }
    const candidates = (await audience()).renewalCandidates;
    expect(candidates.map(c => c.tenantId).sort()).toEqual(expected.sort());
    for (const candidate of candidates) expect(candidate.daysLeft).toBeGreaterThanOrEqual(0);
  });
});

describe("explicit historical backfill preserves gateway/manual and mixed settlement amounts", () => {
  it("is read-only by default, enqueues the same amounts as live sources, and replays as a no-op", async () => {
    const scenarios = [
      { gateway: "zarinpal", wallet: 0, payment: 1_000_000 },
      { gateway: "manual", wallet: 0, payment: 1_000_000 },
      { gateway: "zarinpal", wallet: 600_000, payment: 400_000 },
      { gateway: "zarinpal", wallet: 0, payment: 700_000 },
    ];
    const fixtures: { invoiceId: string; gateway: string; wallet: number; payment: number }[] = [];
    // Historical facts existed before the corrected source triggers. Disable
    // only these outbox producers, inside one test-only transaction; no posted
    // event or journal is removed/rewritten to simulate the history.
    await owner.query("BEGIN");
    try {
      await owner.query(`ALTER TABLE billing_invoices DISABLE TRIGGER platform_company_invoice_outbox`);
      await owner.query(`ALTER TABLE billing_payments DISABLE TRIGGER platform_company_payment_outbox`);
      await owner.query(`ALTER TABLE wallet_ledger DISABLE TRIGGER platform_company_wallet_outbox`);
      for (const scenario of scenarios) {
        const tenantId = await newTenant();
        const invoiceId = randomUUID();
        const paid = scenario.wallet + scenario.payment;
        await owner.query(
          `INSERT INTO billing_invoices
             (id, business_id, invoice_number, reference, status, subtotal_rial, total_rial, paid_rial, created_at, updated_at)
           VALUES ($1::uuid, $2, $1::uuid::text, $1::uuid::text, $3, 1000000, 1000000, $4, '2020-01-10', '2020-01-11')`,
          [invoiceId, tenantId, paid === 1_000_000 ? "paid" : "partially_paid", paid],
        );
        if (scenario.wallet) await owner.query(
          `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, metadata, created_at)
           VALUES ($1, 'subscription', 'debit', $2, 5000000, jsonb_build_object('invoiceId', $3::text), '2020-01-11')`,
          [tenantId, scenario.wallet, invoiceId],
        );
        await owner.query(
          `INSERT INTO billing_payments (business_id, invoice_id, gateway, amount_rial, credit_rial, status, created_at, verified_at)
           VALUES ($1, $2, $3, $4, 0, 'verified', '2020-01-10', '2020-01-11')`,
          [tenantId, invoiceId, scenario.gateway, scenario.payment],
        );
        fixtures.push({ invoiceId, ...scenario });
      }
      await owner.query(`ALTER TABLE billing_invoices ENABLE TRIGGER platform_company_invoice_outbox`);
      await owner.query(`ALTER TABLE billing_payments ENABLE TRIGGER platform_company_payment_outbox`);
      await owner.query(`ALTER TABLE wallet_ledger ENABLE TRIGGER platform_company_wallet_outbox`);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
    const args = [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      join(process.cwd(), "scripts", "platform-company-billing-backfill.ts"),
      "--from=2020-01-01T00:00:00Z", "--cutoff=2020-02-01T00:00:00Z"];
    const options = { env: { ...process.env, DATABASE_URL: databaseUrl(databaseName, true) }, timeout: 20_000 };
    const dryRun = await exec(process.execPath, args, options);
    expect(dryRun.stdout).toContain('"dryRun": true');
    for (const fixture of fixtures) expect(await paymentsFor(fixture.invoiceId)).toEqual([]);
    await exec(process.execPath, [...args, "--apply"], options);
    const snapshots = [];
    for (const fixture of fixtures) {
      const events = await paymentsFor(fixture.invoiceId);
      const expected = [[fixture.gateway === "manual" ? "manual" : "gateway", String(fixture.payment)]];
      if (fixture.wallet) expected.push(["wallet", String(fixture.wallet)]);
      expect(events.map(row => [row.settlement_method, row.amount_rial])).toEqual(expected);
      snapshots.push(events);
    }
    await exec(process.execPath, [...args, "--apply"], options);
    for (const [index, fixture] of fixtures.entries()) expect(await paymentsFor(fixture.invoiceId)).toEqual(snapshots[index]);
  }, 60_000);
});
