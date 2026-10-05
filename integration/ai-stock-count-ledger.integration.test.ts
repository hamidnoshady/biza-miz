/**
 * Issue #812 §14 — the stock-count executor's "before" figure.
 *
 * `inventory_items` carries cost and settings and no quantity column at all;
 * the append-only `stock_movements` ledger is the only place a quantity lives.
 * The §14 bug was that the executor snapshotted on-hand from the item row, so
 * every count recorded a "before" of zero and its undo reversed against a
 * figure that was never true.
 *
 * What is proven here is the ledger derivation, read through the executor's own
 * prior-state capture rather than by reading the SQL back:
 *
 *  - on-hand is the sum of the ledger, including movements that arrive after
 *    the item row was created;
 *  - an item with no movements reports zero, not a stale or missing value;
 *  - the count still lands, and the ledger stays authoritative afterwards.
 *
 * Each test seeds its own business rather than cleaning one up: a posted count
 * is a source document whose lines a trigger refuses to mutate
 * (`migrations/0072`), so a shared fixture cannot be reset between tests. The
 * whole database is dropped in `afterAll`, which is the same shape
 * `stock-count-corrections.integration.test.ts` uses.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let executors: typeof import("../src/lib/ai-autopilot-executors");

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
  databaseName = `pos_ai_stockcount_${randomUUID().replaceAll("-", "")}`;

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
  executors = await import("../src/lib/ai-autopilot-executors");

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

/**
 * A business with a location, an owner, the accounts a count resolves through,
 * a costing method, and a cost basis — the count writes a lot for what it gains
 * and a lot carries a value, so an item with no cost basis cannot have one.
 */
async function seed() {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    ["Stock Co", `stock-${randomUUID().slice(0, 8)}`],
  );
  const businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  await db.query(
    "INSERT INTO settings (business_id, key, value) VALUES ($1, 'inventory.costing', $2::jsonb)",
    [businessId, JSON.stringify({ method: "fifo" })],
  );
  for (const [code, name, type] of [
    ["1300", "Inventory", "asset"],
    ["5100", "COGS", "expense"],
    ["5160", "Count shortage", "expense"],
    ["4910", "Count gain", "revenue"],
  ] as const) {
    await db.query(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4::account_type)",
      [businessId, code, name, type],
    );
  }
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  const item = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, reorder_level, avg_cost, carrying_value_rial)
     VALUES ($1, 'Coffee beans', 'kg', 2, 1000, 0) RETURNING id`,
    [loc.rows[0].id],
  );

  return {
    businessId,
    locationId: loc.rows[0].id,
    userId: user.rows[0].id,
    itemId: item.rows[0].id,
  };
}

/** Appends a signed movement — the only way a quantity ever changes. */
async function move(locationId: string, itemId: string, quantity: number, type = "purchase") {
  const unitCost = type === "purchase" ? 1000 : null;
  await db.query(
    `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity, unit_cost, source_type)
     VALUES ($1, $2, $3, $4, $5, 'seed')`,
    [locationId, itemId, type, quantity, unitCost],
  );
}

/** The executor, inside the tenant scope it would run under in production. */
function runStockCount(
  target: Awaited<ReturnType<typeof seed>>,
  lines: { inventoryItemId: string; countedQty: string }[],
  note?: string,
) {
  return dbLib.withTenant(target.businessId, () =>
    executors.AUTOPILOT_EXECUTORS.stockCount({
      businessId: target.businessId,
      authorizedByUserId: target.userId,
      payload: { note, lines },
    }),
  );
}

describe("§14 — the stock-count executor snapshots on-hand from the ledger", () => {
  it("captures the ledger sum, not the item row's cost-and-settings shape", async () => {
    const target = await seed();
    // Movements arrive in whatever order real life produces them, including
    // after the item row itself was created.
    await move(target.locationId, target.itemId, 12, "purchase");
    await move(target.locationId, target.itemId, -3, "sale");

    const result = await runStockCount(target, [{ inventoryItemId: target.itemId, countedQty: "9" }]);

    if (!result.ok) throw new Error(`executor failed: ${JSON.stringify(result)}`);
    const items = (result.priorState as { items: { id: string; quantity: string }[] }).items;
    expect(items).toHaveLength(1);
    // 12 - 3. Not zero, which is what the item row alone would have said, and
    // not 12, which is what reading only the first movement would have said.
    expect(Number(items[0].quantity)).toBe(9);
  });

  it("reports zero for an item the ledger has never mentioned", async () => {
    // A new item has no movements at all. Reading on-hand from the item row
    // would have produced a stale figure or nothing; zero is the truth, and it
    // is what the count is about to correct.
    const target = await seed();
    const result = await runStockCount(target, [{ inventoryItemId: target.itemId, countedQty: "40" }]);

    if (!result.ok) throw new Error(`executor failed: ${JSON.stringify(result)}`);
    const items = (result.priorState as { items: { id: string; quantity: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(Number(items[0].quantity)).toBe(0);
  });

  it("still lands the count, and corrects the ledger rather than going around it", async () => {
    // The snapshot is only for undo. The count itself must still be recorded,
    // and it must do its correcting through the ledger — appending a variance
    // movement — rather than by writing a quantity somewhere else.
    const target = await seed();
    await move(target.locationId, target.itemId, 7, "purchase");

    const result = await runStockCount(target, [{ inventoryItemId: target.itemId, countedQty: "3" }]);
    if (!result.ok) throw new Error(`executor failed: ${JSON.stringify(result)}`);
    const stockCountId = (result.result as { stockCountId: string }).stockCountId;
    expect(stockCountId).toBeTruthy();

    const { rows: counts } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM stock_counts WHERE id = $1",
      [stockCountId],
    );
    expect(Number(counts[0].n)).toBe(1);

    const { rows } = await db.query<{ total: string | null }>(
      "SELECT sum(quantity)::text AS total FROM stock_movements WHERE inventory_item_id = $1",
      [target.itemId],
    );
    // 7 on hand, counted as 3: the count appended -4 and the ledger now says 3,
    // which is the counted figure. A second count of this item reads the same
    // number back off the ledger, because there is nowhere else to read it.
    expect(Number(rows[0].total)).toBe(3);
  });

  it("refuses a payload whose lines are empty rather than counting nothing", async () => {
    const target = await seed();
    const result = await runStockCount(target, []);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_payload");
  });
});
