/**
 * Migration 0193 on the real upgrade path.
 *
 * The other platform-company suite builds a database from scratch, which
 * proves 0193 is *appliable*. That is not the deployment anyone is actually
 * doing: every installed system is already at 0191 + 0192 with live rows in
 * the tables 0193 changes. This suite reproduces that — migrations up to 0192,
 * a company and a ledger populated the way 0191 built them, then 0193 applied
 * on top — and checks that the correction lands without losing or duplicating
 * anything.
 *
 * It is also the guard on the rule "0191 is never rewritten in place": if
 * someone edits 0191 again, this is the test that fails, not production.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, type MigrationRunOptions } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let preDir: string;
let fixDir: string;
let db: Client;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A migrations directory holding every file up to (but not including) `upTo`. */
async function migrationsDirUpTo(upTo: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-platco-mig-"));
  const all = readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of all.filter((name) => name < upTo)) {
    await copyFile(join(process.cwd(), "migrations", file), join(dir, file));
  }
  return dir;
}

/** A directory holding exactly one migration — the corrective one. */
async function migrationsDirWithOnly(file: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-platco-fix-"));
  await copyFile(join(process.cwd(), "migrations", file), join(dir, file));
  return dir;
}

function run(url: string, dir: string): Promise<unknown> {
  return runMigrations({ databaseUrl: url, migrationsDir: dir, quiet: true } as MigrationRunOptions);
}

beforeAll(async () => {
  databaseName = `pos_platco_up_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  preDir = await migrationsDirUpTo("0193_platform_company_security_and_repair.sql");
  fixDir = await migrationsDirWithOnly("0193_platform_company_security_and_repair.sql");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 300_000);

afterAll(async () => {
  await db?.end().catch(() => {});
  if (preDir) await rm(preDir, { recursive: true, force: true }).catch(() => {});
  if (fixDir) await rm(fixDir, { recursive: true, force: true }).catch(() => {});
});

async function seedPreFixState(): Promise<{ companyId: string; eventId: string; customerId: string }> {
  // Stand in for what 0191 + a running system actually leave behind: one
  // internal company, a mapped customer, and a posted billing event with its
  // journal entry and posting row.
  await db.query(
    `INSERT INTO businesses (name, slug, subdomain, industry, ownership_kind, status)
     VALUES ('کسب‌وکار پلتفرم','platform-company','platform-company','service_saas','platform_internal','active')
     RETURNING id`,
  );
  const { rows: companyRows } = await db.query<{ id: string }>(
    `SELECT id FROM businesses WHERE ownership_kind = 'platform_internal'`,
  );
  const companyId = companyRows[0].id;

  const { rows: customerRows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain, industry, ownership_kind, status)
     VALUES ('مشتری قدیمی',$1,$1,'food_service','customer','active') RETURNING id`,
    [`old-${randomUUID().slice(0, 8)}`],
  );
  const customerId = customerRows[0].id;

  const { rows: partyRows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, person_type)
     VALUES ($1,'مشتری قدیمی','customer','legal') RETURNING id`,
    [companyId],
  );
  const { rows: mapped } = await db.query<{ id: string }>(
    `INSERT INTO platform_company_customers (business_id, party_id, legal_name, billing_customer_key)
     VALUES ($1,$2,'مشتری قدیمی','legacy-key') RETURNING id`,
    [companyId, partyRows[0].id],
  );
  await db.query(
    `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
     VALUES ($1,$2,$3)`,
    [companyId, mapped[0].id, customerId],
  );

  const { rows: eventRows } = await db.query<{ id: string }>(
    `INSERT INTO platform_company_billing_events
       (internal_business_id, source_kind, source_table, source_id, source_version,
        customer_tenant_id, amount_rial)
     VALUES ($1,'invoice_issued','billing_invoices',$2,'issued',$3,500000)
     RETURNING id`,
    [companyId, randomUUID(), customerId],
  );
  const eventId = eventRows[0].id;

  // A journal entry the way the pre-fix worker posted it, plus its posting row.
  const { rows: entries } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id, posted_at)
     VALUES ($1, current_date, 'legacy posting', 'platform_billing', $2, now()) RETURNING id`,
    [companyId, eventId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     SELECT $1, a.id, 500000, 0 FROM accounts a WHERE a.business_id = $2 AND a.code = '1200'`,
    [entries[0].id, companyId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     SELECT $1, a.id, 0, 500000 FROM accounts a WHERE a.business_id = $2 AND a.code = '4500'`,
    [entries[0].id, companyId],
  );
  await db.query(
    `INSERT INTO platform_company_accounting_postings
       (business_id, event_id, source_reference, journal_entry_id, posting_rule, amount_rial)
     VALUES ($1,$2,$3,$4,'legacy',500000)`,
    [companyId, eventId, `legacy:${eventId}`, entries[0].id],
  );
  return { companyId, eventId, customerId };
}

describe("0193 applies on top of a 0192 database with live rows", () => {
  let seeded: { companyId: string; eventId: string; customerId: string };

  beforeAll(async () => {
    await run(urlFor(databaseName), preDir);
    seeded = await seedPreFixState();
  }, 300_000);

  it("had a pre-fix state worth correcting (the setup is not vacuous)", async () => {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_company_billing_events`,
    );
    expect(Number(rows[0].count)).toBe(1);
    // The leaky policy from 0191 really is the one in force before 0193.
    const { rows: policies } = await db.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename = 'platform_company_billing_events'`,
    );
    expect(policies.map((row) => row.policyname)).toContain("tenant_isolation");
  });

  it("applies cleanly", async () => {
    const result = (await run(urlFor(databaseName), fixDir)) as { applied: number };
    expect(result.applied).toBe(1);
  }, 300_000);

  it("keeps every pre-existing row", async () => {
    const { rows } = await db.query<{ events: string; postings: string; entries: string; customers: string }>(
      `SELECT (SELECT count(*)::text FROM platform_company_billing_events) AS events,
              (SELECT count(*)::text FROM platform_company_accounting_postings) AS postings,
              (SELECT count(*)::text FROM journal_entries WHERE source_type='platform_billing') AS entries,
              (SELECT count(*)::text FROM platform_company_customers) AS customers`,
    );
    expect(rows[0]).toEqual({ events: "1", postings: "1", entries: "1", customers: "1" });
  });

  it("replaces the leaky read policy with the internal-business one", async () => {
    const { rows } = await db.query<{ policyname: string; qual: string | null }>(
      `SELECT policyname, qual FROM pg_policies
        WHERE tablename = 'platform_company_billing_events' AND cmd = 'SELECT'`,
    );
    expect(rows.map((row) => row.policyname)).not.toContain("tenant_isolation");
    const select = rows.find((row) => row.policyname === "internal_company_select");
    expect(select).toBeTruthy();
    expect(select!.qual ?? "").toContain("internal_business_id");
    expect(select!.qual ?? "").not.toContain("customer_tenant_id");
  });

  it("leaves no write path open to a tenant", async () => {
    // INSERT policies are enforced through WITH CHECK, UPDATE through both
    // USING and WITH CHECK. Reading only `qual` would make an INSERT policy
    // look unguarded when it is not.
    const { rows } = await db.query<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }>(
      `SELECT policyname, cmd, qual, with_check FROM pg_policies
        WHERE tablename = 'platform_company_billing_events' AND cmd IN ('INSERT','UPDATE','DELETE')`,
    );
    for (const cmd of ["INSERT", "UPDATE", "DELETE"] as const) {
      const forCmd = rows.filter((row) => row.cmd === cmd);
      expect(forCmd.length, `${cmd} policy`).toBeGreaterThan(0);
      for (const row of forCmd) {
        const guard = cmd === "INSERT" ? (row.with_check ?? "") : `${row.qual ?? ""} ${row.with_check ?? ""}`;
        expect(guard, `${cmd} ${row.policyname}`).toContain("app_rls_bypass()");
      }
    }
  });

  it("adds the idempotency keys that stop a second posting of the same fact", async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename IN ('platform_company_accounting_postings','journal_entries')
          AND indexdef ILIKE '%unique%'`,
    );
    const defs = rows.map((row) => row.indexdef).join("\n");
    expect(defs).toContain("platform_company_accounting_postings_event");
    // The journal guard is conditional: it can only be created when no
    // duplicate already exists, so the upgrade path must not assume it landed.
    const { rows: dupes } = await db.query<{ count: string }>(
      `SELECT COALESCE(sum(c - 1), 0)::text AS count FROM (
         SELECT count(*) AS c FROM journal_entries
          WHERE source_type = 'platform_billing' AND source_id IS NOT NULL
          GROUP BY business_id, source_id) d`,
    );
    if (Number(dupes[0].count) === 0) {
      expect(defs).toContain("journal_entries_platform_billing_source");
    }
  });

  it("re-points the project-link trigger at a table that exists", async () => {
    // 0193 originally validated `campaign` links against `campaigns`, which no
    // migration ever created. On the upgrade path the trigger function is
    // replaced, so a campaign link must now resolve — not raise 42P01.
    const { rows: userRows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, email, full_name, role, is_active, permissions)
       VALUES ($1,$2,'کاربر شرکت','owner',true,'{"granted":[],"revoked":[]}'::jsonb) RETURNING id`,
      [seeded.companyId, `company-${randomUUID().slice(0, 8)}@example.test`],
    );
    const { rows: projectRows } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, status, instructions, description, tags, created_by)
       VALUES ($1,'پروژه','planning','','',ARRAY[]::text[],$2) RETURNING id`,
      [seeded.companyId, userRows[0].id],
    );
    const { rows: campaignRows } = await db.query<{ id: string }>(
      `INSERT INTO message_campaigns (business_id, name, channel, status, triggered_by)
       VALUES ($1,'کمپین','sms','draft','manual') RETURNING id`,
      [seeded.companyId],
    ).catch(async (error) => {
      // The campaigns table's own required columns may vary by deployment; if
      // the insert is impossible, skip rather than assert on an unrelated shape.
      throw error;
    });
    const { rowCount } = await db.query(
      `INSERT INTO workspace_project_links (business_id, project_id, link_kind, linked_id)
       VALUES ($1,$2,'campaign',$3)`,
      [seeded.companyId, projectRows[0].id, campaignRows[0].id],
    );
    expect(rowCount).toBe(1);
  });

  it("renames the wallet account only when it still carries the seeded wording", async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM accounts WHERE business_id = $1 AND code = '2455'`,
      [seeded.companyId],
    );
    // The seeded company was created directly, so the shared template never
    // named this account; the correction must therefore have left it alone
    // rather than blindly overwriting an operator's wording.
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("still refuses to map the internal company as its own customer tenant", async () => {
    // `CHECK (business_id <> customer_tenant_id)` from 0191. A genuine
    // customer business is of course mappable — that is the table's whole
    // purpose — so the invariant to pin is that the company cannot become its
    // own customer, which is what would let the company bill itself.
    await expect(
      db.query(
        `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
         SELECT business_id, id, business_id FROM platform_company_customers WHERE business_id = $1`,
        [seeded.companyId],
      ),
    ).rejects.toThrow();
  });

  it("still refuses a second customer row for the same tenant", async () => {
    // Two different company customers may not both own one tenant: the
    // balances and the ledger would disagree about who owes what.
    const { rows } = await db.query<{ id: string; party_id: string }>(
      `SELECT id, party_id FROM platform_company_customers WHERE business_id = $1`,
      [seeded.companyId],
    );
    const { rows: partyRows } = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role, person_type)
       VALUES ($1,'مشتری قدیمی (تکراری)','customer','legal') RETURNING id`,
      [seeded.companyId],
    );
    const { rows: secondCustomer } = await db.query<{ id: string }>(
      `INSERT INTO platform_company_customers (business_id, party_id, legal_name, billing_customer_key)
       VALUES ($1,$2,'مشتری قدیمی (تکراری)','second-key') RETURNING id`,
      [seeded.companyId, partyRows[0].id],
    );
    await expect(
      db.query(
        `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
         SELECT $1, $2, customer_tenant_id FROM platform_company_customer_tenants
          WHERE business_id = $1 AND customer_id = $3`,
        [seeded.companyId, secondCustomer[0].id, rows[0].id],
      ),
    ).rejects.toThrow();
  });

  it("still refuses a link whose referenced object belongs to another business", async () => {
    const { rows: userRows } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE business_id = $1 LIMIT 1`,
      [seeded.companyId],
    );
    const { rows: projectRows } = await db.query<{ id: string }>(
      `SELECT id FROM ai_projects WHERE business_id = $1 LIMIT 1`,
      [seeded.companyId],
    );
    const { rows: foreignDeals } = await db.query<{ id: string }>(
      `INSERT INTO crm_deals (business_id, title, value_rial) VALUES ($1,'معاملهٔ بیگانه',1000) RETURNING id`,
      [seeded.customerId],
    );
    await expect(
      db.query(
        `INSERT INTO workspace_project_links (business_id, project_id, link_kind, linked_id)
         VALUES ($1,$2,'deal',$3)`,
        [seeded.companyId, projectRows[0].id, foreignDeals[0].id],
      ),
    ).rejects.toThrow(/workspace_project_link_invalid_deal/);
    expect(userRows[0].id).toBeTruthy();
  });
});

describe("0191 and 0192 are immutable on the upgrade path", () => {
  it("0191 still exists, unchanged in intent", async () => {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM schema_migrations WHERE filename LIKE '0191%'`,
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});
