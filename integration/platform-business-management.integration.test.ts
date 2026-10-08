/**
 * Super-admin business management — real-database regression coverage.
 *
 * A reset must clear the tenant's OPERATIONAL data without touching another
 * business, while retaining exactly one usable owner identity and starting
 * the target tenant at the first-run setup state.
 *
 * Issue #822 hardened this suite: the old reset deleted and recreated the
 * root `businesses` row, and the reset tests seeded no commercial state — so
 * the cascade that swept away subscriptions, wallets, invoices and payments
 * stayed invisible. These tests seed the full commercial/control-plane
 * surface and assert, column for column, what survives a reset and what a
 * hard delete deliberately destroys — including the platform-company
 * customer-tenant mapping that RESTRICT-references the business.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let platformService: typeof import("../src/lib/platform-service");
let setupState: typeof import("../src/lib/setup-state");

interface SeededBusiness {
  id: string;
  locationId: string;
  ownerId: string;
  platformUserId: string;
  name: string;
  slug: string;
  /** The host label the tenant is served from (Phase 23) — defaulted by migration 0066. */
  subdomain: string;
}

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_platform_business_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  platformService = await import("../src/lib/platform-service");
  setupState = await import("../src/lib/setup-state");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function seedBusiness(name: string, slug: string): Promise<SeededBusiness> {
  const email = `${slug}@example.com`;
  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, 'hash', $2)
     RETURNING id`,
    [email, `${name} Owner`],
  );
  const platformUserId = identity.rows[0].id;

  const business = await db.query<{ id: string; subdomain: string }>(
    `INSERT INTO businesses (name, slug, plan, timezone)
     VALUES ($1, $2, 'business', 'Asia/Tehran')
     RETURNING id, subdomain::text AS subdomain`,
    [name, slug],
  );
  const businessId = business.rows[0].id;
  const subdomain = business.rows[0].subdomain;

  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, address, phone)
     VALUES ($1, 'Original branch', 'Old address', '02100000000')
     RETURNING id`,
    [businessId],
  );
  const locationId = location.rows[0].id;

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'owner', $3, $4)
     RETURNING id`,
    [businessId, platformUserId, `${name} Owner`, email],
  );
  const ownerId = owner.rows[0].id;
  await db.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [
    ownerId,
    locationId,
  ]);

  const category = await db.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id`,
    [locationId],
  );
  const menuItem = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price)
     VALUES ($1, $2, 'Latte', 100000)
     RETURNING id`,
    [locationId, category.rows[0].id],
  );
  const inventoryItem = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit)
     VALUES ($1, 'Coffee beans', 'g')
     RETURNING id`,
    [locationId],
  );
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total)
     VALUES ($1, 1, 'takeaway', 'open', 100000)
     RETURNING id`,
    [locationId],
  );
  const orderItem = await db.query<{ id: string }>(
    `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity)
     VALUES ($1, $2, $3, 'Latte', 100000, 1)
     RETURNING id`,
    [locationId, order.rows[0].id, menuItem.rows[0].id],
  );
  await db.query(
    `INSERT INTO order_item_inventory_snapshots (order_item_id, inventory_item_id, required_quantity)
     VALUES ($1, $2, 18)`,
    [orderItem.rows[0].id, inventoryItem.rows[0].id],
  );
  await db.query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [order.rows[0].id]);
  await db.query(
    `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, posting_status)
     VALUES ($1, $2, 'opening', 'factory_reset_test', 'posted')`,
    [businessId, locationId],
  );
  await db.query(
    `INSERT INTO inventory_cutovers
       (business_id, location_id, effective_at, approved_by, backup_confirmation, evidence_sha256, manifest_sha256, status)
     VALUES ($1, $2, now(), $3, 'factory-reset', repeat('a', 64), repeat('b', 64), 'applied')`,
    [businessId, locationId, ownerId],
  );
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1000', 'Cash', 'asset')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'wizard.progress', '{"steps":{"business":"done"},"completedAt":"2026-01-01T00:00:00.000Z"}')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO business_features (business_id, flag_key, enabled)
     VALUES ($1, 'inventory', false)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'cashier', 'Temporary cashier', 'hash')`,
    [businessId],
  );

  return { id: businessId, locationId, ownerId, platformUserId, name, slug, subdomain };
}

/**
 * The full commercial/control-plane surface a real tenant accumulates —
 * exactly the rows the old delete/recreate reset cascaded away (issue #822).
 * Every value is chosen so the post-reset assertions can prove byte-for-byte
 * preservation, not merely row existence.
 */
async function seedCommercialState(businessId: string): Promise<{ invoiceId: string }> {
  await db.query(
    `INSERT INTO business_subscriptions
       (business_id, plan_key, status, started_at, current_period_start, current_period_end, auto_renew)
     VALUES ($1, 'business', 'active', '2026-01-15T08:00:00Z', '2026-09-15T08:00:00Z', '2026-10-15T08:00:00Z', true)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO business_wallets (business_id, balance_rial, total_topped_up_rial, total_spent_rial)
     VALUES ($1, 500000, 700000, 200000)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, note, created_at)
     VALUES
       ($1, 'top_up', 'credit', 700000, 700000, 'seed top-up', '2026-02-01T08:00:00Z'),
       ($1, 'feature_charge', 'debit', 200000, 500000, 'seed charge', '2026-02-02T08:00:00Z')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO billing_payments (business_id, gateway, purpose, amount_rial, credit_rial, description, status, created_at)
     VALUES ($1, 'manual', 'top_up', 700000, 700000, 'seed payment', 'verified', '2026-02-01T08:00:00Z')`,
    [businessId],
  );
  const invoice = await db.query<{ id: string }>(
    `INSERT INTO billing_invoices
       (business_id, invoice_number, status, subtotal_rial, total_rial, paid_rial, reference, created_at)
     VALUES ($1, 'INV-1', 'paid', 150000000, 150000000, 150000000, 'seed-invoice', '2026-01-15T08:00:00Z')
     RETURNING id`,
    [businessId],
  );
  await db.query(
    `INSERT INTO billing_invoice_lines (invoice_id, kind, description, quantity, unit_amount_rial, amount_rial)
     VALUES ($1, 'plan', 'پلن سازمانی', 1, 150000000, 150000000)`,
    [invoice.rows[0].id],
  );
  await db.query(
    `INSERT INTO business_entitlements (business_id, feature_key, source)
     VALUES ($1, 'inventory', 'plan')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO feature_usage (business_id, feature_key, used_count, charged_count, spent_rial)
     VALUES ($1, 'inventory', 42, 10, 25000)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO business_spend_policies (business_id, monthly_budget_rial)
     VALUES ($1, 10000000)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO billing_vendor_cost_events (business_id, provider, source_reference, amount_rial)
     VALUES ($1, 'litellm', 'seed-cost-1', 1234)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO website_service_subscriptions (business_id, plan_key, status, current_period_start, current_period_end)
     VALUES ($1, 'site_starter', 'active', '2026-09-01T08:00:00Z', '2026-10-01T08:00:00Z')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO website_service_charges (business_id, kind, description, amount_rial, reference)
     VALUES ($1, 'subscription', 'ماهانه', 2000000, 'seed-charge-1')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO ai_plan_allowance_usage (business_id, period_month, granted_rial, used_rial)
     VALUES ($1, '2026-09', 500000, 100000)`,
    [businessId],
  );
  return { invoiceId: invoice.rows[0].id };
}

interface PlatformCompanyMapping {
  internalBusinessId: string;
  customerId: string;
}

/**
 * Maps one or more customer tenants into the platform company's CRM domain —
 * the `platform_company_customer_tenants` rows whose RESTRICT foreign key on
 * `customer_tenant_id` used to make both reset and hard delete fail with a
 * raw FK error once a real customer was mapped (issue #822).
 */
async function seedPlatformCompanyMapping(
  customerTenantIds: string[],
): Promise<PlatformCompanyMapping> {
  const internal = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain, industry, ownership_kind, status, plan)
     VALUES ('شرکت سکو', 'platform-internal-co', 'platform-internal-co', 'service_saas', 'platform_internal', 'active', 'business')
     RETURNING id`,
  );
  const internalBusinessId = internal.rows[0].id;
  const party = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role)
     VALUES ($1, 'مشتریِ نگاشت‌شده', 'customer')
     RETURNING id`,
    [internalBusinessId],
  );
  const customer = await db.query<{ id: string }>(
    `INSERT INTO platform_company_customers (business_id, party_id, legal_name, billing_customer_key)
     VALUES ($1, $2, 'کسب‌وکار مشتری', 'CUST-1')
     RETURNING id`,
    [internalBusinessId, party.rows[0].id],
  );
  const customerId = customer.rows[0].id;
  for (const tenantId of customerTenantIds) {
    await db.query(
      `INSERT INTO platform_company_customer_tenants (business_id, customer_id, customer_tenant_id)
       VALUES ($1, $2, $3)`,
      [internalBusinessId, customerId, tenantId],
    );
  }
  return { internalBusinessId, customerId };
}

beforeEach(async () => {
  await db.query("TRUNCATE TABLE businesses CASCADE");
  await db.query("DELETE FROM platform_users");
});

describe("super-admin business metadata", () => {
  it("updates only the editable business metadata", async () => {
    const business = await seedBusiness("Edit Cafe", `edit-${randomUUID().slice(0, 8)}`);

    const updated = await platformService.updateBusiness(business.id, {
      name: "Edited Cafe",
      timezone: "Europe/Berlin",
    });

    expect(updated).toMatchObject({
      id: business.id,
      name: "Edited Cafe",
      slug: business.slug,
      timezone: "Europe/Berlin",
    });
    const { rows } = await db.query<{ name: string; timezone: string }>(
      `SELECT name, timezone FROM businesses WHERE id = $1`,
      [business.id],
    );
    expect(rows[0]).toEqual({ name: "Edited Cafe", timezone: "Europe/Berlin" });
  });
});

describe("businessUsage", () => {
  it("returns per-business counts and last activity", async () => {
    const business = await seedBusiness("Usage Cafe", `usage-${randomUUID().slice(0, 8)}`);

    const usage = await platformService.businessUsage(business.id);

    expect(usage).toMatchObject({
      orders: 1,
      openOrders: 0,
      members: 2,
      locations: 1,
      menuItems: 1,
      journalEntries: 0,
    });
    // lastActivity comes from the order's opened_at (orders has no created_at);
    // the seeded order defaults opened_at to now, so it must be non-null.
    expect(usage.lastActivity).toBeTruthy();
  });
});

describe("resetBusiness", () => {
  it("clears one tenant completely, preserves its owner identity and plan, and leaves another tenant untouched", async () => {
    const target = await seedBusiness("Reset Cafe", `reset-${randomUUID().slice(0, 8)}`);
    const neighbour = await seedBusiness("Neighbour Cafe", `neighbour-${randomUUID().slice(0, 8)}`);

    await platformService.resetBusiness(target.id);

    const { rows: resetBusinesses } = await db.query<{
      id: string;
      name: string;
      slug: string;
      plan: string;
      timezone: string;
      status: string;
      subdomain: string;
    }>(
      `SELECT id, name, slug::text AS slug, plan, timezone, status::text AS status,
              subdomain::text AS subdomain
         FROM businesses
        WHERE id = $1`,
      [target.id],
    );
    expect(resetBusinesses).toEqual([
      {
        id: target.id,
        name: target.name,
        slug: target.slug,
        plan: "business",
        timezone: "Asia/Tehran",
        status: "active",
        // The tenant's origin since Phase 23. A reset re-inserts the business
        // row, and the column defaults to a random 'biz-<random>' — so leaving
        // it out of the insert moved the tenant to a host nobody had been told
        // about, locking the Owner out of their own bookmark.
        subdomain: target.subdomain,
      },
    ]);

    const { rows: resetLocationRows } = await db.query<{ id: string; name: string; address: string | null }>(
      `SELECT id, name, address FROM locations WHERE business_id = $1`,
      [target.id],
    );
    expect(resetLocationRows).toHaveLength(1);
    expect(resetLocationRows[0]).toMatchObject({ name: "شعبه مرکزی", address: null });
    expect(resetLocationRows[0].id).not.toBe(target.locationId);

    const { rows: resetMembers } = await db.query<{
      id: string;
      platform_user_id: string;
      role: string;
      full_name: string;
    }>(
      `SELECT id, platform_user_id, role::text AS role, full_name
         FROM users
        WHERE business_id = $1`,
      [target.id],
    );
    expect(resetMembers).toEqual([
      {
        id: expect.any(String),
        platform_user_id: target.platformUserId,
        role: "owner",
        full_name: "Reset Cafe Owner",
      },
    ]);
    expect(resetMembers[0].id).not.toBe(target.ownerId);

    const ownerIdentity = await db.query(`SELECT 1 FROM platform_users WHERE id = $1`, [
      target.platformUserId,
    ]);
    expect(ownerIdentity.rowCount).toBe(1);

    for (const table of ["settings", "accounts", "business_features"] as const) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
        [target.id],
      );
      expect(rows[0].n, table).toBe("0");
    }

    for (const table of ["menu_categories", "menu_items", "orders"] as const) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE location_id = $1`,
        [resetLocationRows[0].id],
      );
      expect(rows[0].n, table).toBe("0");
    }

    const state = await dbLib.withTenant(target.id, () => setupState.computeSetupState(target.id));
    expect(state.progress.completedAt).toBeNull();
    expect(state.counts).toMatchObject({ accounts: 0, users: 1, categories: 0, items: 0 });

    const { rows: resetBlockers } = await db.query<{
      inventory_events: string;
      inventory_cutovers: string;
      inventory_snapshots: string;
    }>(
      `SELECT
         (SELECT count(*) FROM inventory_events WHERE business_id = $1)::text AS inventory_events,
         (SELECT count(*) FROM inventory_cutovers WHERE business_id = $1)::text AS inventory_cutovers,
         (
           SELECT count(*)
             FROM order_item_inventory_snapshots snapshot
             JOIN order_items item ON item.id = snapshot.order_item_id
             JOIN orders order_row ON order_row.id = item.order_id
             JOIN locations location_row ON location_row.id = order_row.location_id
            WHERE location_row.business_id = $1
         )::text AS inventory_snapshots`,
      [target.id],
    );
    expect(resetBlockers[0]).toEqual({
      inventory_events: "0",
      inventory_cutovers: "0",
      inventory_snapshots: "0",
    });

    const neighbourData = await db.query<{ menu_items: string; orders: string; users: string }>(
      `SELECT
         (SELECT count(*) FROM menu_items WHERE location_id = $1)::text AS menu_items,
         (SELECT count(*) FROM orders WHERE location_id = $1)::text AS orders,
         (SELECT count(*) FROM users WHERE business_id = $2)::text AS users`,
      [neighbour.locationId, neighbour.id],
    );
    expect(neighbourData.rows[0]).toEqual({ menu_items: "1", orders: "1", users: "2" });

    const { rows: neighbourBlockers } = await db.query<{
      inventory_events: string;
      inventory_cutovers: string;
      inventory_snapshots: string;
    }>(
      `SELECT
         (SELECT count(*) FROM inventory_events WHERE business_id = $1)::text AS inventory_events,
         (SELECT count(*) FROM inventory_cutovers WHERE business_id = $1)::text AS inventory_cutovers,
         (
           SELECT count(*)
             FROM order_item_inventory_snapshots snapshot
             JOIN order_items item ON item.id = snapshot.order_item_id
             JOIN orders order_row ON order_row.id = item.order_id
             JOIN locations location_row ON location_row.id = order_row.location_id
            WHERE location_row.business_id = $1
         )::text AS inventory_snapshots`,
      [neighbour.id],
    );
    expect(neighbourBlockers[0]).toEqual({
      inventory_events: "1",
      inventory_cutovers: "1",
      inventory_snapshots: "1",
    });
  });
});

describe("resetBusiness — commercial state survives (issue #822)", () => {
  it("keeps id, created_at, identity, status, wallet, invoices, payments, subscriptions and mappings while clearing operational data", async () => {
    const target = await seedBusiness("Commercial Cafe", `commercial-${randomUUID().slice(0, 8)}`);
    const neighbour = await seedBusiness("Neighbour Cafe 3", `neighbour3-${randomUUID().slice(0, 8)}`);
    const commercial = await seedCommercialState(target.id);
    await seedPlatformCompanyMapping([target.id, neighbour.id]);

    const before = await db.query<{ created_at: string; subdomain: string }>(
      `SELECT created_at, subdomain::text AS subdomain FROM businesses WHERE id = $1`,
      [target.id],
    );

    await platformService.resetBusiness(target.id);

    // Root identity: same row, untouched — id, created_at, slug, subdomain,
    // name, plan, status, industry and timezone must all survive verbatim.
    const { rows: afterRows } = await db.query<{
      id: string;
      created_at: string;
      name: string;
      slug: string;
      subdomain: string;
      status: string;
      plan: string;
      industry: string;
      timezone: string;
    }>(
      `SELECT id, created_at, name, slug::text AS slug, subdomain::text AS subdomain,
              status::text AS status, plan, industry, timezone
         FROM businesses WHERE id = $1`,
      [target.id],
    );
    expect(afterRows[0]).toEqual({
      id: target.id,
      created_at: before.rows[0].created_at,
      name: target.name,
      slug: target.slug,
      subdomain: before.rows[0].subdomain,
      status: "active",
      plan: "business",
      industry: "food_service",
      timezone: "Asia/Tehran",
    });

    // Subscription survives with its exact period/renewal state.
    const { rows: subscriptions } = await db.query(
      `SELECT plan_key, status, auto_renew, started_at, current_period_end
         FROM business_subscriptions WHERE business_id = $1`,
      [target.id],
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ plan_key: "business", status: "active", auto_renew: true });

    // Wallet balance and the full ledger history survive with exact values.
    const { rows: wallets } = await db.query(
      `SELECT balance_rial, total_topped_up_rial, total_spent_rial
         FROM business_wallets WHERE business_id = $1`,
      [target.id],
    );
    expect(wallets[0]).toEqual({
      balance_rial: "500000",
      total_topped_up_rial: "700000",
      total_spent_rial: "200000",
    });
    const { rows: ledger } = await db.query<{ kind: string; direction: string; amount_rial: string }>(
      `SELECT kind, direction, amount_rial::text AS amount_rial
         FROM wallet_ledger WHERE business_id = $1 ORDER BY created_at`,
      [target.id],
    );
    expect(ledger).toEqual([
      { kind: "top_up", direction: "credit", amount_rial: "700000" },
      { kind: "feature_charge", direction: "debit", amount_rial: "200000" },
    ]);

    // Payments, invoices and invoice lines survive.
    const { rows: payments } = await db.query(
      `SELECT amount_rial, credit_rial, status FROM billing_payments WHERE business_id = $1`,
      [target.id],
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount_rial: "700000", credit_rial: "700000", status: "verified" });
    const { rows: invoices } = await db.query(
      `SELECT invoice_number, status, total_rial, paid_rial
         FROM billing_invoices WHERE business_id = $1`,
      [target.id],
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      invoice_number: "INV-1",
      status: "paid",
      total_rial: "150000000",
      paid_rial: "150000000",
    });
    const { rows: invoiceLines } = await db.query(
      `SELECT amount_rial FROM billing_invoice_lines WHERE invoice_id = $1`,
      [commercial.invoiceId],
    );
    expect(invoiceLines).toHaveLength(1);

    // Entitlements, usage meters, spend policy and vendor costs survive.
    expect(
      (await db.query(`SELECT 1 FROM business_entitlements WHERE business_id = $1 AND feature_key = 'inventory'`, [target.id])).rowCount,
    ).toBe(1);
    const { rows: usage } = await db.query(
      `SELECT used_count, charged_count, spent_rial FROM feature_usage WHERE business_id = $1`,
      [target.id],
    );
    expect(usage[0]).toEqual({ used_count: "42", charged_count: "10", spent_rial: "25000" });
    const { rows: policies } = await db.query(
      `SELECT monthly_budget_rial FROM business_spend_policies WHERE business_id = $1`,
      [target.id],
    );
    expect(policies[0]).toEqual({ monthly_budget_rial: "10000000" });
    expect(
      (await db.query(`SELECT 1 FROM billing_vendor_cost_events WHERE business_id = $1 AND source_reference = 'seed-cost-1'`, [target.id])).rowCount,
    ).toBe(1);

    // Website commercial state and the AI plan allowance survive.
    expect(
      (await db.query(`SELECT 1 FROM website_service_subscriptions WHERE business_id = $1 AND plan_key = 'site_starter'`, [target.id])).rowCount,
    ).toBe(1);
    expect(
      (await db.query(`SELECT 1 FROM website_service_charges WHERE business_id = $1 AND reference = 'seed-charge-1'`, [target.id])).rowCount,
    ).toBe(1);
    const { rows: allowance } = await db.query(
      `SELECT granted_rial, used_rial FROM ai_plan_allowance_usage WHERE business_id = $1`,
      [target.id],
    );
    expect(allowance[0]).toEqual({ granted_rial: "500000", used_rial: "100000" });

    // The platform-company customer mapping survives the reset — the
    // RESTRICT FK that used to break delete/recreate resets.
    const { rows: mappings } = await db.query<{ customer_tenant_id: string }>(
      `SELECT customer_tenant_id FROM platform_company_customer_tenants
        WHERE customer_tenant_id IN ($1, $2)
        ORDER BY customer_tenant_id`,
      [target.id, neighbour.id],
    );
    expect(mappings.map((m) => m.customer_tenant_id).sort()).toEqual(
      [target.id, neighbour.id].sort(),
    );

    // The operational data is gone, replaced by the first-run state:
    // one blank default branch and exactly one owner membership.
    for (const table of ["settings", "accounts", "business_features"] as const) {
      const { rows } = await db.query(
        `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
        [target.id],
      );
      expect(rows[0].n, table).toBe("0");
    }
    const { rows: locations } = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM locations WHERE business_id = $1`,
      [target.id],
    );
    expect(locations).toHaveLength(1);
    expect(locations[0].name).toBe("شعبه مرکزی");
    expect(locations[0].id).not.toBe(target.locationId);
    const { rows: ordersLeft } = await db.query(
      `SELECT count(*)::text AS n FROM orders WHERE location_id = $1`,
      [target.locationId],
    );
    expect(ordersLeft[0].n).toBe("0");
    const { rows: members } = await db.query<{ role: string; platform_user_id: string }>(
      `SELECT role::text AS role, platform_user_id FROM users WHERE business_id = $1`,
      [target.id],
    );
    expect(members).toEqual([{ role: "owner", platform_user_id: target.platformUserId }]);

    // Another tenant — and its commercial mapping — is untouched.
    const neighbourState = await db.query<{ menu_items: string; users: string }>(
      `SELECT
         (SELECT count(*) FROM menu_items WHERE location_id = $1)::text AS menu_items,
         (SELECT count(*) FROM users WHERE business_id = $2)::text AS users`,
      [neighbour.locationId, neighbour.id],
    );
    expect(neighbourState.rows[0]).toEqual({ menu_items: "1", users: "2" });
  });

  it("does not silently reactivate a suspended tenant", async () => {
    const target = await seedBusiness("Suspended Cafe", `suspended-${randomUUID().slice(0, 8)}`);
    await seedCommercialState(target.id);
    await db.query(
      `UPDATE businesses SET status = 'suspended', suspended_at = '2026-03-01T08:00:00Z' WHERE id = $1`,
      [target.id],
    );

    await platformService.resetBusiness(target.id);

    const { rows } = await db.query<{ status: string; suspended_at: string | null }>(
      `SELECT status::text AS status, suspended_at FROM businesses WHERE id = $1`,
      [target.id],
    );
    // Reset is an operational cleanup, not a lifecycle move: the status and
    // its timestamp survive exactly as they were.
    expect(rows[0].status).toBe("suspended");
    expect(new Date(rows[0].suspended_at!).toISOString()).toBe("2026-03-01T08:00:00.000Z");
  });

  it("rolls back completely when the sweep fails part-way — no partial reset", async () => {
    const target = await seedBusiness("Atomic Cafe", `atomic-${randomUUID().slice(0, 8)}`);
    await seedCommercialState(target.id);
    await seedPlatformCompanyMapping([target.id]);
    const before = await db.query<{ created_at: string }>(
      `SELECT created_at FROM businesses WHERE id = $1`,
      [target.id],
    );

    // Inject a failure into the middle of the operational sweep: settings is
    // one of the swept children, so the transaction dies mid-reset. The whole
    // point of the single transaction is that nothing observable changes.
    await db.query(
      `CREATE FUNCTION fail_reset_injection() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected reset failure'; END; $$`,
    );
    await db.query(
      `CREATE TRIGGER fail_reset_injection AFTER DELETE ON settings
         FOR EACH ROW EXECUTE FUNCTION fail_reset_injection()`,
    );

    try {
      await expect(platformService.resetBusiness(target.id)).rejects.toThrow(/injected reset failure/);
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS fail_reset_injection ON settings`);
      await db.query(`DROP FUNCTION IF EXISTS fail_reset_injection()`);
    }

    // Nothing changed: commercial rows intact…
    const { rows: wallets } = await db.query(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [target.id],
    );
    expect(wallets[0].balance_rial).toBe("500000");
    expect(
      (await db.query(`SELECT 1 FROM platform_company_customer_tenants WHERE customer_tenant_id = $1`, [target.id])).rowCount,
    ).toBe(1);
    // …and operational rows still in place, including the original branch,
    // memberships, menu and settings.
    const survivors = await db.query<{
      users: string;
      menu_items: string;
      settings: string;
      locations: string;
    }>(
      `SELECT
         (SELECT count(*) FROM users WHERE business_id = $1)::text AS users,
         (SELECT count(*) FROM menu_items WHERE location_id = $2)::text AS menu_items,
         (SELECT count(*) FROM settings WHERE business_id = $1)::text AS settings,
         (SELECT count(*) FROM locations WHERE business_id = $1)::text AS locations`,
      [target.id, target.locationId],
    );
    expect(survivors.rows[0]).toEqual({ users: "2", menu_items: "1", settings: "1", locations: "1" });
    const after = await db.query<{ created_at: string }>(
      `SELECT created_at FROM businesses WHERE id = $1`,
      [target.id],
    );
    expect(after.rows[0].created_at).toEqual(before.rows[0].created_at);
  });

  it("refuses the protected platform-internal business", async () => {
    const { internalBusinessId } = await seedPlatformCompanyMapping([]);
    await expect(platformService.resetBusiness(internalBusinessId)).rejects.toBeInstanceOf(
      platformService.ProtectedInternalBusinessError,
    );
    await expect(platformService.hardDeleteBusiness(internalBusinessId)).rejects.toBeInstanceOf(
      platformService.ProtectedInternalBusinessError,
    );
    const { rows } = await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [internalBusinessId]);
    expect(rows).toHaveLength(1);
  });

  it("serializes concurrent resets — both run, the result stays exactly one owner, one branch, commercial intact", async () => {
    const target = await seedBusiness("Race Reset Cafe", `racereset-${randomUUID().slice(0, 8)}`);
    await seedCommercialState(target.id);

    // Two operators hit reset at once: the row lock serializes them, and the
    // outcome must be indistinguishable from a single reset — never two
    // branches, two owners, or a commercial row lost in the interleaving.
    await Promise.all([platformService.resetBusiness(target.id), platformService.resetBusiness(target.id)]);

    const { rows: locations } = await db.query(
      `SELECT count(*)::text AS n FROM locations WHERE business_id = $1`,
      [target.id],
    );
    expect(locations[0].n).toBe("1");
    const { rows: members } = await db.query<{ role: string }>(
      `SELECT role::text AS role FROM users WHERE business_id = $1`,
      [target.id],
    );
    expect(members).toEqual([{ role: "owner" }]);
    const { rows: wallet } = await db.query(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [target.id],
    );
    expect(wallet[0].balance_rial).toBe("500000");
    expect(
      (await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [target.id])).rowCount,
    ).toBe(1);
  });
});

describe("hardDeleteBusiness", () => {
  it("deletes an active business immediately, with no archive step, and leaves another tenant untouched", async () => {
    const target = await seedBusiness("Doomed Cafe", `doomed-${randomUUID().slice(0, 8)}`);
    const neighbour = await seedBusiness("Neighbour Cafe 2", `neighbour2-${randomUUID().slice(0, 8)}`);

    // Still "active" — no archive, no grace window. Confirms deletion isn't
    // gated on business status.
    const { rows: statusRows } = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM businesses WHERE id = $1`,
      [target.id],
    );
    expect(statusRows[0].status).toBe("active");

    await platformService.hardDeleteBusiness(target.id);

    const { rows: remaining } = await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [
      target.id,
    ]);
    expect(remaining).toHaveLength(0);

    const { rows: orphanUsers } = await db.query(`SELECT 1 FROM users WHERE business_id = $1`, [
      target.id,
    ]);
    expect(orphanUsers).toHaveLength(0);

    // A hard delete removes *everything*, including the login: the owner's
    // platform identity had no membership left anywhere, so it's purged too
    // — otherwise the email would stay "already registered" forever and block
    // recreating the business.
    const ownerIdentity = await db.query(`SELECT 1 FROM platform_users WHERE id = $1`, [
      target.platformUserId,
    ]);
    expect(ownerIdentity.rowCount).toBe(0);

    const neighbourData = await db.query<{ menu_items: string; orders: string }>(
      `SELECT
         (SELECT count(*) FROM menu_items WHERE location_id = $1)::text AS menu_items,
         (SELECT count(*) FROM orders WHERE location_id = $1)::text AS orders`,
      [neighbour.locationId],
    );
    expect(neighbourData.rows[0]).toEqual({ menu_items: "1", orders: "1" });
  });

  it("keeps the platform identity when it still owns another business", async () => {
    const target = await seedBusiness("Doomed Cafe 2", `doomed2-${randomUUID().slice(0, 8)}`);

    // Same person also owns a second business — give its membership the
    // first business's platform identity instead of a fresh one.
    const other = await seedBusiness("Other Cafe", `other-${randomUUID().slice(0, 8)}`);
    await db.query(`UPDATE users SET platform_user_id = $1 WHERE id = $2`, [
      target.platformUserId,
      other.ownerId,
    ]);
    await db.query(`DELETE FROM platform_users WHERE id = $1`, [other.platformUserId]);

    await platformService.hardDeleteBusiness(target.id);

    const identity = await db.query(`SELECT 1 FROM platform_users WHERE id = $1`, [
      target.platformUserId,
    ]);
    expect(identity.rowCount).toBe(1);

    const stillMember = await db.query(`SELECT 1 FROM users WHERE id = $1`, [other.ownerId]);
    expect(stillMember.rowCount).toBe(1);
  });

  it("raises BusinessNotFoundError for a business that doesn't exist", async () => {
    await expect(platformService.hardDeleteBusiness(randomUUID())).rejects.toBeInstanceOf(
      platformService.BusinessNotFoundError,
    );
  });

  it("deliberately detaches the platform-company customer mapping — never a raw FK failure (issue #822)", async () => {
    const target = await seedBusiness("Mapped Cafe", `mapped-${randomUUID().slice(0, 8)}`);
    const neighbour = await seedBusiness("Mapped Neighbour", `mappedn-${randomUUID().slice(0, 8)}`);
    const mapping = await seedPlatformCompanyMapping([target.id, neighbour.id]);

    // The mapping RESTRICT-references the tenant; the delete must handle it
    // on purpose and report the severance, not crash on the FK.
    const result = await platformService.hardDeleteBusiness(target.id);
    expect(result.detachedCustomerTenantMappings).toBe(1);

    expect(
      (await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [target.id])).rowCount,
    ).toBe(0);
    // The deleted tenant's mapping row is gone; the other tenant's link, the
    // CRM customer record and its party all survive — the platform company's
    // domain is corrupted by nothing.
    const { rows: remaining } = await db.query<{ customer_tenant_id: string }>(
      `SELECT customer_tenant_id FROM platform_company_customer_tenants
        WHERE customer_id = $1`,
      [mapping.customerId],
    );
    expect(remaining).toEqual([{ customer_tenant_id: neighbour.id }]);
    expect(
      (await db.query(`SELECT 1 FROM platform_company_customers WHERE id = $1`, [mapping.customerId])).rowCount,
    ).toBe(1);
  });

  it("removes commercial history too — a hard delete wipes what a reset preserves", async () => {
    const target = await seedBusiness("Broke Cafe", `broke-${randomUUID().slice(0, 8)}`);
    await seedCommercialState(target.id);

    const result = await platformService.hardDeleteBusiness(target.id);
    expect(result.detachedCustomerTenantMappings).toBe(0);

    for (const table of [
      "business_subscriptions",
      "business_wallets",
      "wallet_ledger",
      "billing_payments",
      "billing_invoices",
      "business_entitlements",
      "feature_usage",
      "business_spend_policies",
      "billing_vendor_cost_events",
      "website_service_subscriptions",
      "website_service_charges",
      "ai_plan_allowance_usage",
    ] as const) {
      const { rows } = await db.query(
        `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
        [target.id],
      );
      expect(rows[0].n, table).toBe("0");
    }

    // The owner's global identity is purged when orphaned (no membership
    // anywhere else), so the email is free to sign up again.
    expect(
      (await db.query(`SELECT 1 FROM platform_users WHERE id = $1`, [target.platformUserId])).rowCount,
    ).toBe(0);
  });

  it("deletes a suspended tenant the same way", async () => {
    const target = await seedBusiness("Doomed Suspended", `doomeds-${randomUUID().slice(0, 8)}`);
    await db.query(`UPDATE businesses SET status = 'suspended', suspended_at = now() WHERE id = $1`, [target.id]);

    await platformService.hardDeleteBusiness(target.id);

    expect(
      (await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [target.id])).rowCount,
    ).toBe(0);
  });

  it("serializes concurrent deletes — one wins, the other reports not found, never a corrupted state", async () => {
    const target = await seedBusiness("Race Cafe", `race-${randomUUID().slice(0, 8)}`);
    await seedCommercialState(target.id);

    // Both calls race for the same `FOR UPDATE` lock; the loser waits, then
    // finds the row gone. The contract: exactly one success, the other a
    // clean BusinessNotFoundError — no half-deleted tenant either way.
    const results = await Promise.allSettled([
      platformService.hardDeleteBusiness(target.id),
      platformService.hardDeleteBusiness(target.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      platformService.BusinessNotFoundError,
    );

    expect(
      (await db.query(`SELECT 1 FROM businesses WHERE id = $1`, [target.id])).rowCount,
    ).toBe(0);
    // The commercial rows cascaded with the one winning delete — no orphaned
    // half of them survived the race.
    const { rows: leftovers } = await db.query(
      `SELECT (SELECT count(*) FROM business_wallets WHERE business_id = $1)
             + (SELECT count(*) FROM billing_invoices WHERE business_id = $1)
             + (SELECT count(*) FROM business_subscriptions WHERE business_id = $1) AS n`,
      [target.id],
    );
    expect(leftovers[0].n).toBe("0");
  });
});
