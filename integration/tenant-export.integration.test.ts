/**
 * Phase 17 — per-tenant export, against real databases.
 *
 * `exportTenantData` reads every tenant table scoped to one business via
 * ordinary RLS (the same mechanism protecting every other request in this
 * app), so this proves two things at once:
 *
 *  1. The export genuinely contains only the requested business's rows,
 *     even with a second business's data sitting in the same tables.
 *  2. The SQL `tenantDataToSql` produces is actually restorable: applying it
 *     to a second, freshly-migrated, otherwise-empty database reproduces
 *     exactly those rows there — the literal Phase 17 exit criterion ("a
 *     single tenant's backup restores into a clean database without
 *     carrying any other tenant's rows").
 *
 * The *physical* restore workflow (verify into a scratch database, then apply
 * after a typed confirmation) now exists in the dashboard and the super-admin
 * console — issue #807 put both halves on `restore-engine.ts`. Replaying a
 * *logical* snapshot like this one through an application path is still future
 * work; `restore-engine.ts` refuses it by name (`artifact_is_logical_snapshot`)
 * rather than treating it as a dump.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_export_test_role";
const APP_PASSWORD = "export-test-password";

let sourceDbName: string;
let targetDbName: string;
let source: Client; // superuser connection to the source DB, for seeding
let target: Client; // superuser connection to the clean restore-target DB
let dbLib: typeof import("../src/lib/db");
let tenantExport: typeof import("../src/lib/tenant-export");

const bizX = { id: "", locationId: "" };
const bizY = { id: "", locationId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  sourceDbName = `pos_export_src_${randomUUID().replaceAll("-", "")}`;
  targetDbName = `pos_export_dst_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${sourceDbName}"`);
    await maintenance.query(`CREATE DATABASE "${targetDbName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(sourceDbName), quiet: true });
  await runMigrations({ databaseUrl: urlFor(targetDbName), quiet: true });

  // The stock docker-compose.yml (and this dev/test environment) connects as
  // a superuser, which makes RLS a silent no-op — exactly the pitfall
  // tenant-isolation.integration.test.ts exists to catch. exportTenantData
  // relies entirely on RLS to filter each table, so dbLib's own pool has to
  // run as an unprivileged role for this test to prove anything at all.
  await createAppRole({ databaseUrl: urlFor(sourceDbName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  process.env.DATABASE_URL = urlFor(sourceDbName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  tenantExport = await import("../src/lib/tenant-export");

  source = new Client({ connectionString: urlFor(sourceDbName) });
  await source.connect();
  target = new Client({ connectionString: urlFor(targetDbName) });
  await target.connect();

  // Two businesses in the SAME source database, so "only bizX's rows"
  // actually means something.
  const x = await source.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Export Co', $1) RETURNING id",
    [`export-x-${randomUUID().slice(0, 8)}`],
  );
  bizX.id = x.rows[0].id;
  const locX = await source.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [bizX.id],
  );
  bizX.locationId = locX.rows[0].id;

  const y = await source.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Noise Co', $1) RETURNING id",
    [`export-y-${randomUUID().slice(0, 8)}`],
  );
  bizY.id = y.rows[0].id;
  const locY = await source.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [bizY.id],
  );
  bizY.locationId = locY.rows[0].id;

  for (const [biz, tag] of [[bizX, "x"] as const, [bizY, "y"] as const]) {
    const category = await source.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [biz.locationId, `Category ${tag}`],
    );
    await source.query(
      "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, $3, 10000)",
      [biz.locationId, category.rows[0].id, `Item ${tag}`],
    );
    const order = await source.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'open', 10000) RETURNING id`,
      [biz.locationId],
    );
    await source.query(
      "INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status) VALUES ($1, $2, $3, 10000, 1, 'served')",
      [biz.locationId, order.rows[0].id, `Item ${tag}`],
    );
    // A trigger refuses inserting order_items once an order is no longer
    // 'open' — so the order has to close *after* seeding its items, same as
    // real usage. Exported (and later restored) in its final, closed state:
    // a DB restore must be able to replay this order+items pair even though
    // a live INSERT of the same order_items against an already-closed order
    // would be refused (see restore-tenant.ts's session_replication_role use).
    await source.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [order.rows[0].id]);
  }

  // A self-referencing accounts pair for bizX only — the row-ordering edge case.
  const parentAccount = await source.query<{ id: string }>(
    "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1000', 'Assets', 'asset') RETURNING id",
    [bizX.id],
  );
  await source.query(
    "INSERT INTO accounts (business_id, parent_id, code, name, type) VALUES ($1, $2, '1010', 'Cash', 'asset')",
    [bizX.id, parentAccount.rows[0].id],
  );

  // stock_movements uses `bigint GENERATED ALWAYS AS IDENTITY` — restoring an
  // explicit id into that column needs OVERRIDING SYSTEM VALUE, which a fixture
  // touching only uuid-keyed tables would never have caught (see restore-tenant
  // decision in the phase doc for the bug this exact row exposed).
  const invItem = await source.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'Beans', 'kg') RETURNING id",
    [bizX.locationId],
  );
  await source.query(
    "INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity) VALUES ($1, $2, 'purchase', 5)",
    [bizX.locationId, invItem.rows[0].id],
  );
}, 120_000);

afterAll(async () => {
  await source?.end();
  await target?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${sourceDbName}" WITH (FORCE)`);
    await maintenance.query(`DROP DATABASE IF EXISTS "${targetDbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("listForeignKeys (as the unprivileged app role)", () => {
  it("finds cross-table foreign keys, e.g. accounts -> businesses", async () => {
    // Regression guard: information_schema.constraint_column_usage hides
    // rows the querying role lacks certain privileges on, which silently
    // dropped this exact edge when read as the app role instead of the
    // table owner — pg_catalog (what listForeignKeys actually uses) doesn't
    // filter by privilege this way. Caught by the round-trip test below
    // failing outright; this pins the specific edge that regressed.
    const tenantTables = await import("../src/lib/tenant-tables");
    const edges = await tenantTables.listForeignKeys();
    expect(edges).toContainEqual({ table: "accounts", column: "business_id", foreignTable: "businesses" });
  });
});

describe("exportTenantData", () => {
  it("returns only the requested business's rows, even with another business's data present", async () => {
    const tables = await tenantExport.exportTenantData(bizX.id);
    const orders = tables.find((t) => t.name === "orders");
    expect(orders?.rows).toHaveLength(1);

    const menuItems = tables.find((t) => t.name === "menu_items")!;
    expect(menuItems.rows.map((r) => r.name)).toEqual(["Item x"]);

    // Never bizY's business/location id anywhere in the export.
    const locations = tables.find((t) => t.name === "locations")!;
    expect(locations.rows.map((r) => r.id)).toEqual([bizX.locationId]);
    expect(locations.rows.map((r) => r.id)).not.toContain(bizY.locationId);
  });

  it("orders a self-referencing table's rows parent-before-child", async () => {
    const tables = await tenantExport.exportTenantData(bizX.id);
    const accounts = tables.find((t) => t.name === "accounts")!;
    const codes = accounts.rows.map((r) => r.code);
    expect(codes.indexOf("1000")).toBeLessThan(codes.indexOf("1010"));
  });

  it("omits empty tables entirely", async () => {
    const tables = await tenantExport.exportTenantData(bizX.id);
    expect(tables.every((t) => t.rows.length > 0)).toBe(true);
  });
});

describe("tenantDataToSql round-trip", () => {
  it("restores into a clean, freshly-migrated database with exactly that business's rows", async () => {
    const tables = await tenantExport.exportTenantData(bizX.id);
    const sql = tenantExport.tenantDataToSql(tables);

    await target.query(sql);

    const { rows: businesses } = await target.query<{ id: string; name: string }>(
      "SELECT id, name FROM businesses",
    );
    expect(businesses).toEqual([{ id: bizX.id, name: "Export Co" }]);

    const { rows: orders } = await target.query("SELECT * FROM orders");
    expect(orders).toHaveLength(1);

    const { rows: menuItems } = await target.query<{ name: string }>("SELECT name FROM menu_items");
    expect(menuItems.map((r) => r.name)).toEqual(["Item x"]);

    // Regression check: stock_movements.id is `GENERATED ALWAYS AS IDENTITY`,
    // which rejects an explicit id without OVERRIDING SYSTEM VALUE.
    const { rows: movements } = await target.query<{ quantity: string }>(
      "SELECT quantity FROM stock_movements",
    );
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].quantity)).toBe(5);

    // bizY never existed in the export, so it can't exist in the restore target either.
    const { rows: locationCount } = await target.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM locations",
    );
    expect(locationCount[0].count).toBe("1");

    const { rows: accounts } = await target.query<{ code: string; parent_id: string | null }>(
      "SELECT code, parent_id FROM accounts ORDER BY code",
    );
    expect(accounts[0]).toMatchObject({ code: "1000", parent_id: null });
    expect(accounts[1]).toMatchObject({ code: "1010" });
    expect(accounts[1].parent_id).not.toBeNull();
  });
});
