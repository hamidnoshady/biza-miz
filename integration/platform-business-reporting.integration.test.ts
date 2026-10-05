/** Release gate #810: real RLS, deliberately unequal tenants, real platform routes. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { INDUSTRIES } from "../src/lib/industries";
import { pageReportDetails } from "../src/lib/report-detail-page";
import { standardReportsFor, reportShape, REPORT_VIEWS, previousPeriodRange } from "../src/lib/reports";
import { getTenantScope } from "../src/lib/tenant-context";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined }) }));
// Only the external HTTP boundary is replaced; connection lookup/decryption,
// tenant selection and overview composition are the real services.
vi.mock("../src/lib/cms/client", async (load) => {
  const actual = await load<typeof import("../src/lib/cms/client")>();
  const docs = async (config: { siteDomain?: string }) => ({ docs: [{ id: config.siteDomain, title: config.siteDomain, _status: "published", privateToken: "do-not-forward" }] });
  return { ...actual, fetchSiteDescriptor: async (config: { siteDomain?: string }) => ({ type: "store", domain: config.siteDomain }),
    fetchPages: docs, fetchPosts: docs, fetchProducts: docs, fetchOrders: async () => ({ docs: [] }) };
});
const root = process.env.DATABASE_URL;
if (!root) throw new Error("DATABASE_URL is required");
const database = `pos_platform_reports_${randomUUID().replaceAll("-", "")}`;
const role = `reports_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
function url(db: string, app = false) {
  const u = new URL(root!); u.pathname = `/${db}`;
  if (app) { u.username = role; u.password = "test-password"; }
  return u.toString();
}
let owner: Client;
let db: typeof import("../src/lib/db");
let reports: typeof import("../src/lib/platform-business-reporting");
let route: ReturnType<typeof import("../src/lib/platform-report-route")["platformReportRoute"]>;
let standard: typeof route;
let custom: typeof route;
let token: string;
let a: Awaited<ReturnType<typeof seed>>;
let b: typeof a;
async function seed(name: string, count: number, customers: number, currency: string) {
  const id = (await owner.query("INSERT INTO businesses (name, slug) VALUES ($1::text, $1::text) RETURNING id", [name])).rows[0].id as string;
  const locationId = (await owner.query("INSERT INTO locations (business_id, name, business_day_start_minutes) VALUES ($1, $2, 360) RETURNING id", [id, name])).rows[0].id as string;
  const customerId = (await owner.query("INSERT INTO parties (business_id, name, role) SELECT $1, $2 || g, 'customer' FROM generate_series(1, $3::int) g RETURNING id", [id, name, customers])).rows[0].id;
  await owner.query(`INSERT INTO orders (location_id, order_number, type, status, total, subtotal, opened_at, closed_at, customer_id)
    SELECT $1, g, 'takeaway', 'completed', 100000, 100000, now() - interval '2 hours', now() - interval '1 hour', $3 FROM generate_series(1, $2::int) g`, [locationId, count, customerId]);
  const accounts = (await owner.query(`INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4100', 'Sales', 'revenue') RETURNING id, code`, [id])).rows;
  const entry = (await owner.query("INSERT INTO journal_entries (business_id, location_id, entry_date, memo) VALUES ($1, $2, CURRENT_DATE, 'report fixture') RETURNING id", [id, locationId])).rows[0].id;
  await owner.query("INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)", [entry, accounts.find((r) => r.code === "1100").id, accounts.find((r) => r.code === "4100").id, count * 100000]);
  await owner.query("INSERT INTO promotions (business_id, name, kind, value) SELECT $1, $2 || g, 'percent', 10 FROM generate_series(1, $3::int) g", [id, name, customers]);
  await owner.query("INSERT INTO gift_cards (business_id, code, initial_value) VALUES ($1, $2, 100000)", [id, `secret-${name}`]);
  const connection = (await owner.query(`INSERT INTO integration_connections (business_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext)
    VALUES ($1, $2, 'https://store.example.test', 'private-key', 'private-secret', 'private-webhook') RETURNING id`, [id, name])).rows[0].id;
  await owner.query(`INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
    SELECT $1, $2, 'order', g::text, gen_random_uuid() FROM generate_series(1, $3::int) g`, [id, connection, count]);
  await owner.query("INSERT INTO settings (business_id, key, value) VALUES ($1, 'business.prefs', $2)", [id, JSON.stringify({ currencyDisplay: currency })]);
  await owner.query("INSERT INTO settings (business_id, key, value) VALUES ($1, 'deployment.profile', '{\"profile\":\"cloud\"}')", [id]);
  await owner.query(`INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload)
    SELECT $1, $2, 'order.created', g::text, g::text, '{}' FROM generate_series(1, $3::int) g`, [id, connection, customers]);
  await owner.query(`INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name)
    SELECT $1,$2,'product_cat',g::text,'Category ' || g FROM generate_series(1,$3::int) g`, [id, connection, customers]);
  if (name === "report-alpha") await owner.query("UPDATE integration_connections SET link_mode='plugin', link_token_hash='private-hash', link_token_ciphertext='private-token' WHERE id=$1", [connection]);
  return { id, locationId, count, customers, currency };
}
/** Deliberately tied sort values exercise the unique SQL tie-breakers. */
async function seedPagedDetails(t: Awaited<ReturnType<typeof seed>>, count: number, amount: number) {
  const ids = (await owner.query(`WITH brands AS (
    INSERT INTO item_brands (location_id,name) SELECT $1,'Brand-' || g FROM generate_series(1,$2::int) g RETURNING id
  ) INSERT INTO items (location_id,name,brand_id) SELECT $1,'Same item name',id FROM brands RETURNING id`, [t.locationId, count])).rows.map((r) => r.id);
  await owner.query(`INSERT INTO item_stock (item_id,quantity,unit_cost,reorder_point)
    SELECT unnest($1::uuid[]),1.25,$2,2`, [ids, amount]);
  await owner.query(`INSERT INTO item_batches (item_id,batch_number,expiry_date,quantity,unit_cost)
    SELECT id,'same-batch',CURRENT_DATE + ((n::int % 3) * 30 - 5),1,$2
    FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)`, [ids, amount]);
  await owner.query(`WITH serials AS (
    INSERT INTO item_serials (item_id,serial_number) SELECT unnest($1::uuid[]),'same-serial' RETURNING id
  ) INSERT INTO serial_warranties (serial_id,months,start_date,end_date)
    SELECT id,12,CURRENT_DATE-365,CURRENT_DATE+(row_number() OVER ()::int % 3)*30-1 FROM serials`, [ids]);
  for (const [event, payload] of [["accessory.sale_revenue", { quantity: 1, net: amount }], ["accessory.sale_cogs", { cost: 5 }], ["cosmetic.sale_revenue", { quantity: 1, net: amount }], ["cosmetic.sale_cogs", { cost: 5 }]] as const) {
    await owner.query(`INSERT INTO domain_events (business_id,location_id,event_type,source_id,payload)
      SELECT $1,$2,$3,unnest($4::uuid[]),$5`, [t.id, t.locationId, event, ids, payload]);
  }
  await owner.query(`WITH tickets AS (
    INSERT INTO repair_tickets (location_id,ticket_number,item_description,status,labor_charge,under_warranty)
    SELECT $1,g,'Same repair',CASE WHEN g % 3=0 THEN 'received' ELSE 'closed' END,
      CASE WHEN g % 2=0 THEN 0 ELSE $3::int END,g % 2=0 FROM generate_series(1,$2::int) g RETURNING id,under_warranty
  ) INSERT INTO repair_ticket_parts (ticket_id,description,quantity,unit_cost,charge)
    SELECT id,'part',1.25,10,CASE WHEN under_warranty THEN 0 ELSE 20 END FROM tickets`, [t.locationId, count, amount]);
  await owner.query(`INSERT INTO layaway_plans (business_id,location_id,plan_number,customer_id,grams,price_per_gram,total_value_rial,paid_rial,status)
    SELECT $1,$2,g,(SELECT id FROM parties WHERE business_id=$1 LIMIT 1),1.25,100,125,25,
      CASE WHEN g%3=0 THEN 'cancelled' WHEN g%3=1 THEN 'open' ELSE 'completed' END FROM generate_series(1,$3::int) g`, [t.id, t.locationId, count]);
  await owner.query(`WITH consignors AS (
    INSERT INTO consignors (business_id,location_id,name) SELECT $1,$2,'Same consignor' FROM generate_series(1,$3::int) RETURNING id
  ) INSERT INTO domain_events (business_id,location_id,event_type,payload)
    SELECT $1,$2,'consignment.payout',jsonb_build_object('consignorId',id,'amount',$4::int) FROM consignors`, [t.id, t.locationId, count, amount]);
  const inventory = (await owner.query("INSERT INTO inventory_items (location_id,name,unit,avg_cost) VALUES ($1,'Ingredient','g',2) RETURNING id", [t.locationId])).rows[0].id;
  await owner.query("INSERT INTO orders (location_id,order_number,status) VALUES ($1,999,'open')", [t.locationId]);
  await owner.query(`WITH menu AS (
    INSERT INTO menu_items (location_id,name,price) SELECT $1,'Same menu item',100 FROM generate_series(1,$2::int) RETURNING id
  ), sold AS (
    INSERT INTO order_items (location_id,order_id,menu_item_id,name_snapshot,unit_price,quantity,status)
    SELECT $1,(SELECT id FROM orders WHERE location_id=$1 AND status='open' LIMIT 1),id,'Same menu item',100,1,'served' FROM menu RETURNING id,menu_item_id
  ) INSERT INTO order_item_inventory_snapshots (order_item_id,inventory_item_id,required_quantity,source_menu_item_id)
    SELECT id,$3,0.25,menu_item_id FROM sold`, [t.locationId, count, inventory]);
  await owner.query("UPDATE orders SET status='completed', closed_at=now() WHERE location_id=$1 AND status='open'", [t.locationId]);
}

beforeAll(async () => {
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${database}"`); await maintenance.end();
  await runMigrations({ databaseUrl: url(database), quiet: true });
  await createAppRole({ databaseUrl: url(database), roleName: role, password: "test-password", quiet: true });
  owner = new Client({ connectionString: url(database) }); await owner.connect();
  a = await seed("report-alpha", 10, 2, "toman"); b = await seed("report-beta", 100, 7, "rial");
  const admin = (await owner.query("INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ('reports@example.test', 'x', 'Support', 'support') RETURNING id")).rows[0].id;
  process.env.DATABASE_URL = url(database, true);
  db = await import("../src/lib/db");
  reports = await import("../src/lib/platform-business-reporting");
  const connections = await import("../src/lib/cms/connections");
  for (const tenant of [a, b]) await db.withTenant(tenant.id, () => connections.saveCmsConnection({
    businessId: tenant.id, siteId: tenant.id, siteDomain: `${tenant.id}.example.test`, baseUrl: "https://cms.example.test", apiKey: `private-${tenant.id}`,
  }));
  const auth = await import("../src/lib/platform-auth-edge");
  token = await auth.signPlatformSession({ padmin: admin, fullName: "Support", email: "reports@example.test", role: "support" });
  const factory = (await import("../src/lib/platform-report-route")).platformReportRoute;
  route = factory("section"); standard = factory("standard"); custom = factory("query");
  jar.set(auth.PLATFORM_SESSION_COOKIE, token);
}, 180_000);
afterAll(async () => {
  await db?.closeDatabasePool(); await owner?.end(); process.env.DATABASE_URL = root;
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await maintenance.query(`DROP ROLE IF EXISTS "${role}"`); await maintenance.end();
});
async function read(id: string, section: string, qs = "", key?: string) {
  const response = await (key ? standard : route)(new NextRequest(`http://test/api/platform/businesses/${id}/reports/${section}${qs}`), { params: Promise.resolve({ id, section, key }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.json();
}
describe("tenant-scoped platform reporting", () => {
  it("uses a non-superuser / non-BYPASSRLS database role", async () => {
    const result = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it("requires platform authentication and rejects a tenant token even in the platform cookie", async () => {
    jar.clear();
    const req = new NextRequest(`http://test/api/platform/businesses/${a.id}/reports/catalog`);
    const ctx = { params: Promise.resolve({ id: a.id, section: "catalog" }) };
    expect((await route(req, ctx)).status).toBe(401);
    const { signSession } = await import("../src/lib/auth-edge");
    jar.set("pos_platform_session", await signSession({ sub: randomUUID(), businessId: a.id, role: "owner", fullName: "Tenant", locationId: a.locationId }));
    expect((await route(req, ctx)).status).toBe(401);
    jar.set("pos_platform_session", token);
  });
  for (const name of ["a", "b"] as const) {
    it(`isolates ${name.toUpperCase()} across sales, accounting, CRM, Growth, websites, branches and custom queries; matches tenant services`, async () => {
      const t = name === "a" ? a : b;
      const catalog = await read(t.id, "catalog");
      expect(catalog.currencyDisplay).toBe(t.currency);
      expect(catalog.reports.map((r: { key: string }) => r.key)).toEqual(standardReportsFor("food_service").map((r) => r.key));
      expect(catalog.locations.map((r: { id: string }) => r.id)).toEqual([t.locationId]);
      const sales = await read(t.id, "standard", "", "daily_sales_summary");
      expect(sales.rows.reduce((n: number, r: { value: string }) => n + Number(r.value), 0)).toBe(t.count * 100000);
      const tenant = await import("../src/lib/reports-service");
      expect(sales.rows).toEqual(JSON.parse(JSON.stringify(await db.withTenant(t.id, () => tenant.runCustomReportQuery(t.id, catalog.reports.find((r: { key: string }) => r.key === "daily_sales_summary").config)))));
      const pnl = await read(t.id, "standard", "", "profit_and_loss");
      expect(pnl.report.totalRevenue).toBe(t.count * 100000);
      expect(pnl.report).toEqual(await db.withTenant(t.id, () => tenant.getProfitAndLoss(t.id)));
      const branches = await read(t.id, "branches");
      expect(branches.consolidated.orderCount).toBe(t.count);
      expect(branches.branches).toHaveLength(1);
      const crm = await read(t.id, "crm");
      expect(crm.customers.total).toBe(t.customers);
      expect(crm).toEqual(await db.withTenant(t.id, () => import("../src/lib/crm-overview").then((s) => s.crmOverview(t.id))));
      const growth = await read(t.id, "growth");
      expect(growth.campaigns.counts.live).toBe(t.customers);
      const tenantGrowth = await db.withTenant(t.id, async () => (await import("../src/lib/growth-overview")).growthOverview(t.id, { locationId: null, today: await (await import("../src/lib/business-day-service")).businessToday(t.id) }));
      expect(growth.campaigns).toEqual(tenantGrowth.campaigns);
      expect(growth.bridge).toEqual(tenantGrowth.bridge);
      expect(JSON.stringify(growth)).not.toContain("secret-");
      const websites = await read(t.id, "websites");
      expect(websites.wp.data.orders).toBe(t.count);
      expect(websites.wp.data.pendingInboxEvents).toBe(t.customers);
      expect(websites.wp.data.terms).toBe(t.customers);
      expect(websites.wp.data.connections).toEqual({ total: 1, active: 1, plugin: t === a ? 1 : 0, rest: t === a ? 0 : 1 });
      expect(websites.wp.data).toEqual(await db.withTenant(t.id, () => import("../src/lib/integrations/wp-manager-service").then((s) => s.wpOverviewStats(t.id))));
      expect(JSON.stringify(websites)).not.toContain("private-");
      const cms = await read(t.id, "cms");
      expect(cms.managers.data.cms.domain).toBe(`${t.id}.example.test`);
      expect(cms.overview.data.pages).toEqual([{ id: `${t.id}.example.test`, title: `${t.id}.example.test`, status: "published" }]);
      expect(JSON.stringify(cms)).not.toContain("private-");
      expect(JSON.stringify(cms)).not.toContain("do-not-forward");
      const other = name === "a" ? b : a;
      expect(JSON.stringify(cms)).not.toContain(other.id);

      const customResponse = await custom(new NextRequest(`http://test/api/platform/businesses/${t.id}/reports/query?locationId=${t.locationId}`, { method: "POST", body: JSON.stringify({ view: "v_sales_by_day", metric: "order_count", aggregation: "sum", dimension: "day" }) }), { params: Promise.resolve({ id: t.id }) });
      expect(customResponse.status).toBe(200);
      const result = await customResponse.json();
      expect(result.rows.reduce((n: number, r: { value: string }) => n + Number(r.value), 0)).toBe(t.count);
      // A service query without a business WHERE still cannot see the sibling.
      await db.withoutTenantScope("platform", () => reports.withBusinessReporting(t.id, { compare: false }, async () => {
        expect(getTenantScope()).toMatchObject({ kind: "business", businessId: t.id });
        const rows = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM parties");
        expect(Number(rows.rows[0].n)).toBe(t.customers);
      }));
    });
  }
  it("rejects a sibling branch before any report can run", async () => {
    for (const [own, other] of [[a, b], [b, a]]) {
      const response = await route(new NextRequest(`http://test/api/platform/businesses/${own.id}/reports/overview?locationId=${other.locationId}`), { params: Promise.resolve({ id: own.id, section: "overview" }) });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid_location" });
    }
  });
  it("enforces app availability on the server, not just the catalog", async () => {
    await owner.query("INSERT INTO business_app_availability (business_id, app_key, state) VALUES ($1, 'crm', 'disabled')", [a.id]);
    try {
      const catalog = await read(a.id, "catalog");
      expect(catalog.apps).not.toContain("crm");
      const response = await route(new NextRequest("http://test"), { params: Promise.resolve({ id: a.id, section: "crm" }) });
      expect(response.status).toBe(404);
      expect((await read(b.id, "crm")).customers.total).toBe(b.customers);
    } finally { await owner.query("DELETE FROM business_app_availability WHERE business_id = $1", [a.id]); }
  });
  it("rejects unknown businesses, inapplicable reports and SQL sources", async () => {
    const missing = await route(new NextRequest("http://test"), { params: Promise.resolve({ id: randomUUID(), section: "catalog" }) });
    expect(missing.status).toBe(404);
    const wrongTrade = await standard(new NextRequest("http://test"), { params: Promise.resolve({ id: a.id, key: "weight_reconciliation" }) });
    expect(wrongTrade.status).toBe(404);
    const sql = await custom(new NextRequest("http://test", { method: "POST", body: JSON.stringify({ view: "orders; SELECT * FROM users", metric: "total", aggregation: "sum", dimension: "day" }) }), { params: Promise.resolve({ id: a.id }) });
    expect(sql.status).toBe(400);
  });
  it("keeps installed versions, rollout decisions and errors tenant-scoped, without forwarding release secrets", async () => {
    const desktop = await import("../src/lib/desktop-release-service");
    await owner.query(`INSERT INTO platform_releases
      (version,build_commit,build_id,channel,status,rollout_state,rollout_percentage,released_at,
       minimum_supported_version,installer_url,installer_sha256,installer_size,manifest_signature,expected_publisher)
      VALUES ('1.2.0','abc1234','test','stable','published','full',100,now(), '1.0.0',
       'https://example.test/private-installer', $1,1000,$2,'Test')`, ["a".repeat(64), "A".repeat(96)]);
    for (const [t, version] of [[a, "1.1.0"], [b, "1.2.0"]] as const) {
      const device = (await owner.query(`INSERT INTO site_devices (business_id,location_id,display_name,status)
        VALUES ($1,$2,$3,'active') RETURNING id`, [t.id, t.locationId, `Device-${t.id}`])).rows[0].id;
      await owner.query(`INSERT INTO site_device_runtime_status (site_device_id,business_id,location_id,app_version,reported_at)
        VALUES ($1,$2,$3,$4,now())`, [device, t.id, t.locationId, version]);
    }
    for (const t of [a, b]) {
      const health = await read(t.id, "health");
      const expected = await db.withTenant(t.id, () => desktop.businessDesktopCompliance(t.id));
      expect(expected.devices).toHaveLength(1);
      expect(health.devices.error).toBeNull();
      expect(health.devices.data).toHaveLength(1);
      expect(health.devices.data[0]).toMatchObject({
        id: expected.devices[0].siteDeviceId, installedVersion: t === a ? "1.1.0" : "1.2.0",
        targetVersion: "1.2.0", compliance: t === a ? "update_available" : "up_to_date", connectivity: "online",
      });
      expect(JSON.stringify(health)).not.toContain((t === a ? b : a).id);
      expect(JSON.stringify(health)).not.toContain("private-installer");
      expect(JSON.stringify(health)).not.toContain("manifestSignature");
    }
    await owner.query("UPDATE site_device_runtime_status SET last_error_code='TEST', last_error_message='private-error-detail' WHERE business_id=$1", [a.id]);
    const failed = await read(a.id, "health");
    expect(failed.devices.data[0]).toMatchObject({ compliance: "error", hasError: true });
    expect(JSON.stringify(failed)).not.toContain("private-error-detail");
    expect((await read(b.id, "health")).devices.data[0].hasError).toBe(false);
  });

  // Exercise every catalog entry, not just representative keys. Accounting and
  // sales are populated for all industries; specialised empty shapes are also
  // a compatibility contract. The scale test below covers nonempty trade pages.
  it.each(INDUSTRIES)("matches every %s catalog report and structured comparison to its tenant service", async (industry) => {
    const t = await seed(`catalog-${industry}`, 3, 1, "rial");
    await owner.query("UPDATE businesses SET industry=$2 WHERE id=$1", [t.id, industry]);
    const catalog = await read(t.id, "catalog");
    const definitions = standardReportsFor(industry);
    expect(catalog.reports.map((r: { key: string }) => r.key)).toEqual(definitions.map((r) => r.key));
    const tenant = await import("../src/lib/reports-service");
    const { runStandardReport } = await import("../src/lib/standard-report-service");
    const year = new Date().getUTCFullYear();
    const options = { locationId: t.locationId, dateFrom: `${year}-01-01`, dateTo: `${year}-12-31`, previousAsOfDate: `${year - 1}-12-31`, compare: true };
    const qs = `?${new URLSearchParams({ ...options, compare: "1" })}`;
    for (const def of definitions) {
      const actual = await read(t.id, "standard", qs, def.key);
      const expected = await db.withTenant(t.id, async () => {
        if (reportShape(def) === "rows" && def.defaultChart) {
          const config = def.defaultChart.config;
          const dated = REPORT_VIEWS[config.view].dateColumn;
          const current = { ...config, limit: Math.min(config.limit ?? 1000, 1000), filters: {
            ...config.filters, ...(dated ? { dateFrom: options.dateFrom, dateTo: options.dateTo } : {}),
          } };
          return { rows: await tenant.runCustomReportQuery(t.id, current, t.locationId),
            previous: dated ? await tenant.runCustomReportQuery(t.id, { ...current, filters: {
              ...current.filters, ...previousPeriodRange(options.dateFrom, options.dateTo),
            } }, t.locationId) : null };
        }
        const result = await runStandardReport(t.id, industry, def, options);
        return result.report ? pageReportDetails(result.report as unknown as Record<string, unknown>) : result;
      });
      expect(actual, `${industry}/${def.key}`).toEqual(JSON.parse(JSON.stringify(expected)));
      if (def.key === "profit_and_loss") {
        expect(actual.comparison.current.totalRevenue).toBe(300000);
        expect(actual.comparison.previous.totalRevenue).toBe(0);
      }
    }
  }, 60_000);


  it("SQL-pages every detail shape with identical full totals, stable ties and inverse tenant isolation", async () => {
    const first = await seed("paged-first", 1, 1, "rial");
    const second = await seed("paged-second", 1, 1, "rial");
    await seedPagedDetails(first, 121, 10); await seedPagedDetails(second, 73, 100);
    const { runStandardReport } = await import("../src/lib/standard-report-service");
    const { warrantyState, repairProfit, layawayBook } = await import("../src/lib/industry-reports");
    const cases = [
      ["jewelry", "consignor_statements", "summaries"], ["jewelry", "layaway_book", "rows"],
      ["watch", "warranty_register", "rows"], ["watch", "repair_profitability", "rows"],
      ["accessories", "variant_sales", "rows"], ["cosmetics", "brand_sales", "rows"],
      ["cosmetics", "near_expiry_batches", "rows"], ["accessories", "low_stock", "rows"],
      ["accessories", "dead_stock", "rows"], ["food_service", "food_cost_variance", "items"],
    ] as const;
    for (const [industry, key, collection] of cases) {
      for (const [t, count] of [[first, 121], [second, 73]] as const) {
        await owner.query("UPDATE businesses SET industry=$2 WHERE id=$1", [t.id, industry]);
        const def = standardReportsFor(industry).find((r) => r.key === key)!;
        const result = await db.withTenant(t.id, () => runStandardReport(t.id, industry, def, { locationId: t.locationId }));
        const full = JSON.parse(JSON.stringify(result.report));
        expect(full[collection], key).toHaveLength(count);
        const rows = [];
        for (let page = 1; page <= Math.ceil(count / 50); page++) {
          const actual = await read(t.id, "standard", `?locationId=${t.locationId}&page=${page}`, key);
          expect(actual, `${key}/${t.id}/page${page}`).toEqual(pageReportDetails(full, page));
          rows.push(...actual.report[collection]);
        }
        expect(rows).toEqual(full[collection]);
        const clamped = await read(t.id, "standard", `?locationId=${t.locationId}&page=999999`, key);
        expect(clamped).toEqual(pageReportDetails(full, 999999));
        // Independent pure contracts guard against SQL-vs-JS bucketing/rounding drift.
        if (key === "warranty_register") {
          const today = (await owner.query("SELECT CURRENT_DATE::text AS today")).rows[0].today;
          for (const row of full.rows) expect(row.state).toBe(warrantyState(row, today));
        }
        if (key === "repair_profitability") expect(full.totals).toEqual(repairProfit(full.rows.filter((r: { status: string }) => r.status === "closed")));
        if (key === "layaway_book") expect(full.book).toEqual(layawayBook(full.rows));
        if (key === "dead_stock") expect(full.totalValueRial).toBe(count * Math.round(1.25 * (t === first ? 10 : 100)));
        if (key === "food_cost_variance") expect(full.theoreticalCost).toBe(count); // Per-item ROUND(0.25 * 2), then SUM.
      }
    }
  }, 60_000);

  it("filters dead stock at the UTC timestamp cutoff before counting and paging", async () => {
    const t = await seed("stock-cutoff", 1, 1, "rial");
    const { deadStockReportPage } = await import("../src/lib/retail-stock-service");
    await owner.query(`WITH items AS (
      INSERT INTO items (location_id,name) SELECT $1,'Stock-' || g FROM generate_series(1,5) g RETURNING id,name
    ) INSERT INTO item_stock (item_id,quantity,unit_cost,last_sold_at)
      SELECT id,1,10,CASE name WHEN 'Stock-1' THEN NULL WHEN 'Stock-2' THEN '2026-05-18T00:00:00Z'::timestamptz
      WHEN 'Stock-3' THEN '2026-05-17T23:59:59Z'::timestamptz WHEN 'Stock-4' THEN '2026-05-18T00:00:00.001Z'::timestamptz
      ELSE '2026-08-16T12:00:00Z'::timestamptz END FROM items`, [t.locationId]);
    const result = await db.withTenant(t.id, () => deadStockReportPage(t.locationId, 90, "2026-08-16", 1));
    expect(result.total).toBe(3); expect(result.rows.map((r) => r.itemName)).toEqual(["Stock-1", "Stock-2", "Stock-3"]);
    expect(result.summary.totalValueRial).toBe(30);
    expect((await db.withTenant(t.id, () => deadStockReportPage(t.locationId, 0, "2026-08-16", 1))).total).toBe(0);
  });

  it("bounds 10,000-row trade responses, preserves whole-report totals, and avoids consignor N+1 reads", async () => {
    const jewelry = await seed("scale-jewelry", 1, 1, "rial");
    const retail = await seed("scale-retail", 1, 1, "rial");
    await owner.query("UPDATE businesses SET industry='jewelry' WHERE id=$1", [jewelry.id]);
    await owner.query("UPDATE businesses SET industry='accessories' WHERE id=$1", [retail.id]);
    await owner.query(`INSERT INTO consignors (business_id,location_id,name)
      SELECT $1,$2,'Consignor-' || lpad(g::text,5,'0') FROM generate_series(1,10000) g`, [jewelry.id, jewelry.locationId]);
    await owner.query(`INSERT INTO domain_events (business_id,location_id,event_type,payload)
      SELECT business_id,location_id,'consignment.payout',jsonb_build_object('consignorId',id,'amount',100)
      FROM consignors WHERE business_id=$1`, [jewelry.id]);
    await owner.query(`WITH inserted AS (
      INSERT INTO items (location_id,name) SELECT $1,'Item-' || lpad(g::text,5,'0') FROM generate_series(1,10000) g RETURNING id
    ) INSERT INTO item_stock (item_id,quantity,unit_cost,reorder_point) SELECT id,1,25000,5 FROM inserted`, [retail.locationId]);
    const spy = vi.spyOn(db, "query");
    try {
      for (const [t, key, collection] of [[jewelry, "consignor_statements", "summaries"], [retail, "dead_stock", "rows"]] as const) {
        const started = performance.now();
        spy.mockClear();
        const first = await read(t.id, "standard", `?locationId=${t.locationId}`, key);
        const queries = spy.mock.calls.length;
        const pageRead = spy.mock.calls.findIndex(([sql]) => sql.includes("report_source AS MATERIALIZED"));
        expect(pageRead).toBeGreaterThanOrEqual(0);
        expect(spy.mock.calls[pageRead][1]?.slice(-2)).toEqual([50, 1]);
        // This asserts the DB boundary itself, not merely a sliced HTTP body.
        expect((await spy.mock.results[pageRead].value).rows).toHaveLength(50);

        expect(first.pagination).toEqual({ page: 1, pageSize: 50, total: 10000, pages: 200 });
        expect(first.report[collection]).toHaveLength(50);
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(32000);
        // Generous regression budget, not an SLA; catches query-per-record regressions.
        expect(queries).toBeLessThan(40);
        expect(performance.now() - started).toBeLessThan(15000);
        const last = await read(t.id, "standard", `?locationId=${t.locationId}&page=999999`, key);
        expect(last.pagination.page).toBe(200);
        expect(last.report[collection]).toHaveLength(50);
        expect(last.report[collection][0]).not.toEqual(first.report[collection][0]);
        if (key === "consignor_statements") {
          expect(first.report.summary).toEqual({ count: 10000, balance: -1000000, totalPaid: 1000000, totalOwed: 0 });
          expect(last.report.summary).toEqual(first.report.summary);
        } else {
          expect(first.report.totalCount).toBe(10000);
          expect(first.report.totalValueRial).toBe(250000000);
          expect(last.report.totalValueRial).toBe(first.report.totalValueRial);
        }
        console.info(`platform-report-scale ${key}: ${Math.round(performance.now() - started)}ms for first+last pages, ${queries} queries/page, ${Buffer.byteLength(JSON.stringify(first))} response bytes`);
      }
    } finally { spy.mockRestore(); }
  }, 60_000);

});
