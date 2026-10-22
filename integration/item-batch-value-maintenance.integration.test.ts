/**
 * The exact-cost invariant behind migration 0237.
 *
 * Migration 0236 declared `item_batches.total_value_rial` authoritative and
 * backfilled it once; nothing maintained it afterwards, so every FEFO sale,
 * transfer, write-off and supplier return left the lot's value describing the
 * quantity it *used* to hold. The readers prefer that column, which is how a
 * lot left holding 1 unit at 20,000 still reported 100,000 and the weighted
 * average came out at 25,000 instead of 11,667.
 *
 * `retail-batch-inventory.integration.test.ts` catches the symptom through the
 * service layer. These tests pin the rule itself, including the two cases the
 * service tests cannot easily reach: an explicit total must win (the warehouse
 * document path sets it and would otherwise be double-counted), and a lot with
 * no known cost must stay unknown rather than silently become zero.
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
let itemId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function insertBatch(
  quantity: string,
  unitCost: number | null,
  totalValue: number | null = null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO item_batches (item_id, batch_number, quantity, unit_cost, total_value_rial)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [itemId, `B-${randomUUID().slice(0, 8)}`, quantity, unitCost, totalValue],
  );
  return rows[0].id;
}

async function readBatch(id: string) {
  const { rows } = await db.query<{ quantity: string; unit_cost: string | null; total_value_rial: string | null }>(
    "SELECT quantity::text, unit_cost::text, total_value_rial::text FROM item_batches WHERE id = $1",
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  databaseName = `pos_batch_value_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end().catch(() => {});

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM item_batches");
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Batch', $1) RETURNING id",
    [`batch-${randomUUID().slice(0, 8)}`],
  );
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.rows[0].id],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO items (location_id, name) VALUES ($1, 'کرم') RETURNING id",
    [location.rows[0].id],
  );
  itemId = item.rows[0].id;
});

describe("a batch's exact total follows its quantity", () => {
  it("derives the total on insert from quantity × unit cost", async () => {
    const batch = await insertBatch("5", 20_000);
    expect((await readBatch(batch)).total_value_rial).toBe("100000");
  });

  it("keeps the value of the units that are left when part of a lot is consumed", async () => {
    const batch = await insertBatch("5", 20_000);

    await db.query("UPDATE item_batches SET quantity = quantity - 4 WHERE id = $1", [batch]);

    expect(await readBatch(batch)).toMatchObject({
      quantity: "1.000000000",
      total_value_rial: "20000",
    });
  });

  it("is never driven negative — the table's own check constraint refuses it", async () => {
    const batch = await insertBatch("2", 20_000);

    // `item_batches_quantity_check` rejects the row before the trigger's clamp
    // can matter, so an over-consumption cannot corrupt the value either.
    await expect(
      db.query("UPDATE item_batches SET quantity = quantity - 5 WHERE id = $1", [batch]),
    ).rejects.toThrow(/item_batches_quantity_check/);

    expect(await readBatch(batch)).toMatchObject({
      quantity: "2.000000000",
      total_value_rial: "40000",
    });
  });

  it("revalues a repriced lot whose quantity did not change", async () => {
    const batch = await insertBatch("4", 10_000);

    await db.query("UPDATE item_batches SET unit_cost = 12_500 WHERE id = $1", [batch]);

    expect((await readBatch(batch)).total_value_rial).toBe("50000");
  });

  it("stands aside when the caller sets the total explicitly", async () => {
    // The warehouse-document path moves quantity and value together; the
    // trigger must not add its own adjustment on top.
    const batch = await insertBatch("5", 20_000);

    await db.query(
      "UPDATE item_batches SET quantity = quantity - 2, total_value_rial = total_value_rial - 11111 WHERE id = $1",
      [batch],
    );

    expect(await readBatch(batch)).toMatchObject({
      quantity: "3.000000000",
      total_value_rial: "88889",
    });
  });

  it("leaves an unknown cost unknown rather than calling it zero", async () => {
    const batch = await insertBatch("3", null);
    expect((await readBatch(batch)).total_value_rial).toBeNull();

    await db.query("UPDATE item_batches SET quantity = quantity - 1 WHERE id = $1", [batch]);

    expect((await readBatch(batch)).total_value_rial).toBeNull();
  });
});
