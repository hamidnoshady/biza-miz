/**
 * Hardening integration: stock accuracy, dead-stock aging boundaries, trigger, inactive, last_sold_at rebuild.
 * Covers 0232 trigger TG_OP branch, P0 missing-row, inactive policy, 89/90/91, void/reversal.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let stockService: typeof import("../src/lib/retail-stock-service");
let itemsService: typeof import("../src/lib/items-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "" };

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
  databaseName = `pos_harden_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  stockService = await import("../src/lib/retail-stock-service");
  itemsService = await import("../src/lib/items-service");
  provisioning = await import("../src/lib/business-provisioning");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
});

beforeEach(async () => {
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");
  const bizRow = await db.query<{ id: string }>("INSERT INTO businesses (name, slug, industry) VALUES ('Harden Co', $1, 'accessories') RETURNING id", [`harden-${randomUUID().slice(0, 8)}`]);
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [biz.id]);
  biz.locationId = locRow.rows[0].id;
  const client = await dbLib.getPool().connect();
  try { await provisioning.seedChartOfAccounts(client, biz.id, "accessories"); } finally { client.release(); }
});

describe("trigger set_first_stocked_at TG_OP branch (no OLD on INSERT)", () => {
  it("INSERT with qty>0 sets first_stocked_at without touching OLD", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "Trigger Item 1", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, created_at) VALUES ($1, 5, 1000, now())", [item.id]);
    const row = await db.query<{ first_stocked_at: string | null }>("SELECT first_stocked_at FROM item_stock WHERE item_id=$1", [item.id]);
    expect(row.rows[0].first_stocked_at).not.toBeNull();
  });

  it("INSERT with qty 0 does not set first_stocked_at", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "Trigger Item 2", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, created_at) VALUES ($1, 0, 1000, now())", [item.id]);
    const row = await db.query<{ first_stocked_at: string | null }>("SELECT first_stocked_at FROM item_stock WHERE item_id=$1", [item.id]);
    expect(row.rows[0].first_stocked_at).toBeNull();
  });

  it("UPDATE 0→>0 sets first_stocked_at once and preserves on second cycle", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "Trigger Item 3", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost) VALUES ($1, 0, 1000)", [item.id]);
    const before = await db.query<{ first_stocked_at: string | null }>("SELECT first_stocked_at FROM item_stock WHERE item_id=$1", [item.id]);
    expect(before.rows[0].first_stocked_at).toBeNull();
    await db.query("UPDATE item_stock SET quantity=10 WHERE item_id=$1", [item.id]);
    const after1 = await db.query<{ first_stocked_at: string | null }>("SELECT first_stocked_at FROM item_stock WHERE item_id=$1", [item.id]);
    expect(after1.rows[0].first_stocked_at).not.toBeNull();
    const firstTs = after1.rows[0].first_stocked_at;
    // cycle back to 0 then to >0 again — should preserve original
    await db.query("UPDATE item_stock SET quantity=0 WHERE item_id=$1", [item.id]);
    await db.query("UPDATE item_stock SET quantity=5 WHERE item_id=$1", [item.id]);
    const after2 = await db.query<{ first_stocked_at: string | null }>("SELECT first_stocked_at FROM item_stock WHERE item_id=$1", [item.id]);
    expect(String(after2.rows[0].first_stocked_at)).toBe(String(firstTs));
  });
});

describe("P0 missing-row as qty 0 out", () => {
  it("low-stock includes items with no item_stock row as out", async () => {
    const withStock = await itemsService.createItem({ locationId: biz.locationId, name: "With Stock", tracking: "none" });
    const withoutStock = await itemsService.createItem({ locationId: biz.locationId, name: "Without Stock", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, reorder_point) VALUES ($1, 1, 1000, 5)", [withStock.id]);
    // withoutStock has no item_stock row
    const report = await stockService.lowStockReport(biz.locationId);
    const ids = report.map(r => r.itemId);
    expect(ids).toContain(withStock.id);
    expect(ids).toContain(withoutStock.id);
    const missing = report.find(r => r.itemId === withoutStock.id)!;
    expect(missing.quantity).toBe("0");
    expect(missing.level).toBe("out");
  });
});

describe("inactive policy", () => {
  it("excludes inactive by default, includes when includeInactive true", async () => {
    const active = await itemsService.createItem({ locationId: biz.locationId, name: "Active Item", tracking: "none" });
    const inactive = await itemsService.createItem({ locationId: biz.locationId, name: "Inactive Item", tracking: "none" });
    await db.query("UPDATE items SET is_active=false WHERE id=$1", [inactive.id]);
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, reorder_point) VALUES ($1, 1, 1000, 5), ($2, 1, 1000, 5)", [active.id, inactive.id]);
    const without = await stockService.lowStockReport(biz.locationId, { includeInactive: false });
    expect(without.some(r => r.itemId === inactive.id)).toBe(false);
    expect(without.some(r => r.itemId === active.id)).toBe(true);
    const withInactive = await stockService.lowStockReport(biz.locationId, { includeInactive: true });
    expect(withInactive.some(r => r.itemId === inactive.id)).toBe(true);
  });
});

describe("dead-stock 89/90/91 day boundaries", () => {
  const today = "2026-10-19";
  const cutoff90 = "2026-07-21"; // 90 days before 2026-10-19
  const before89 = "2026-07-22"; // 89 days before
  const after91 = "2026-07-20"; // 91 days before

  it("never-sold 89d old not dead, 90d dead, 91d dead", async () => {
    const item89 = await itemsService.createItem({ locationId: biz.locationId, name: "89d", tracking: "none" });
    const item90 = await itemsService.createItem({ locationId: biz.locationId, name: "90d", tracking: "none" });
    const item91 = await itemsService.createItem({ locationId: biz.locationId, name: "91d", tracking: "none" });
    const fresh = await itemsService.createItem({ locationId: biz.locationId, name: "Fresh", tracking: "none" });
    // Use created_at as age for never-sold
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, created_at, first_stocked_at) VALUES ($1,5,1000,$2,$2)", [item89.id, before89]);
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, created_at, first_stocked_at) VALUES ($1,5,1000,$2,$2)", [item90.id, cutoff90]);
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, created_at, first_stocked_at) VALUES ($1,5,1000,$2,$2)", [item91.id, after91]);
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, created_at, first_stocked_at) VALUES ($1,5,1000,$2,$2)", [fresh.id, today]);
    const dead = await stockService.deadStockReport(biz.locationId, 90, today);
    const ids = dead.map(r => r.itemId);
    expect(ids).not.toContain(item89.id);
    expect(ids).toContain(item90.id);
    expect(ids).toContain(item91.id);
    expect(ids).not.toContain(fresh.id);
  });

  it("sold 89d ago not dead, 91d ago dead", async () => {
    const s89 = await itemsService.createItem({ locationId: biz.locationId, name: "Sold 89", tracking: "none" });
    const s91 = await itemsService.createItem({ locationId: biz.locationId, name: "Sold 91", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, last_sold_at, created_at) VALUES ($1,5,1000,$2,$3)", [s89.id, before89, today]);
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost, last_sold_at, created_at) VALUES ($1,5,1000,$2,$3)", [s91.id, after91, today]);
    const dead = await stockService.deadStockReport(biz.locationId, 90, today);
    const ids = dead.map(r => r.itemId);
    expect(ids).not.toContain(s89.id);
    expect(ids).toContain(s91.id);
  });
});

describe("last_sold_at rebuild after void/reversal", () => {
  it("recomputes from most recent non-voided sale; voided sale falls back to previous", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "Void Item", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost) VALUES ($1,10,1000)", [item.id]);
    // Create two orders: older and newer
    const o1 = await db.query<{ id: string }>("INSERT INTO orders (location_id, order_number, status) VALUES ($1, 1, 'open') RETURNING id", [biz.locationId]);
    await db.query("INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status, item_id) VALUES ($1,$2,'Void Item',1000,1,'served',$3)", [biz.locationId, o1.rows[0].id, item.id]);
    await db.query("UPDATE orders SET status='completed', closed_at=$2 WHERE id=$1", [o1.rows[0].id, "2026-07-01"]);
    const o2 = await db.query<{ id: string }>("INSERT INTO orders (location_id, order_number, status) VALUES ($1, 2, 'open') RETURNING id", [biz.locationId]);
    await db.query("INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status, item_id) VALUES ($1,$2,'Void Item',1000,1,'served',$3)", [biz.locationId, o2.rows[0].id, item.id]);
    await db.query("UPDATE orders SET status='completed', closed_at=$2 WHERE id=$1", [o2.rows[0].id, "2026-08-15"]);
    // Initially last should be Aug 15
    const client1 = await dbLib.getPool().connect();
    try {
      const last = await stockService.recomputeLastSoldAt(client1, item.id);
      expect(last).toContain("2026-08-15");
    } finally { client1.release(); }
    // Void the newer order
    await db.query("UPDATE orders SET status='voided' WHERE id=$1", [o2.rows[0].id]);
    const client2 = await dbLib.getPool().connect();
    try {
      const lastAfterVoid = await stockService.recomputeLastSoldAt(client2, item.id);
      expect(lastAfterVoid).toContain("2026-07-01");
    } finally { client2.release(); }
    // Void also the older -> no valid sale
    await db.query("UPDATE orders SET status='voided' WHERE id=$1", [o1.rows[0].id]);
    const client3 = await dbLib.getPool().connect();
    try {
      const lastNone = await stockService.recomputeLastSoldAt(client3, item.id);
      expect(lastNone).toBeNull();
    } finally { client3.release(); }
  });
});
