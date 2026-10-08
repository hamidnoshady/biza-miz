/**
 * Audit F14 — optimistic concurrency on the price-list matrix save, against a
 * real database. The decision table is unit-tested in
 * `src/lib/price-list-conflicts.test.ts`; this pins what only Postgres can:
 *
 *  1. a save carrying a stale version is reported as a conflict — with the
 *     current value, version and time — and does NOT overwrite the row, while
 *     the non-conflicting cells of the same save are applied (partial apply);
 *  2. the reported current version is what a deliberate overwrite sends;
 *  3. a cell loaded empty that another session filled is a conflict too;
 *  4. «بروزرسانی سریع» moves the version, so a matrix opened before it conflicts;
 *  5. two simultaneous saves from the same loaded version: exactly one wins,
 *     the other is a conflict (the `FOR UPDATE` lock, not luck);
 *  6. an older client that sends no version keeps last-write-wins.
 *
 * `npm run test:db` (needs Postgres; not part of `npm test`).
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
let service: typeof import("../src/lib/price-lists-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let locationId = "";
let listId = "";
let itemA = "";
let itemB = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stored(itemId: string): Promise<number | null> {
  const { rows } = await db.query<{ price: string }>(
    "SELECT price FROM price_list_entries WHERE price_list_id = $1 AND item_id = $2",
    [listId, itemId],
  );
  return rows[0] ? Number(rows[0].price) : null;
}

/** What the matrix reads when it opens: the version of each filled cell. */
async function loadedVersion(itemId: string): Promise<string | null> {
  const entries = await dbLib.withTenant(businessId, () => service.listPriceEntries(locationId), {
    locationId,
  });
  return entries.find((e) => e.priceListId === listId && e.itemId === itemId)?.version ?? null;
}

function save(updates: Parameters<typeof service.savePriceEntries>[0]) {
  return dbLib.withTenant(
    businessId,
    () => service.savePriceEntries(updates, { locationId, businessId }),
    { locationId },
  );
}

beforeAll(async () => {
  databaseName = `pos_price_conflicts_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  service = await import("../src/lib/price-lists-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Shop', $1) RETURNING id",
    [`shop-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  locationId = location.rows[0].id;
  const items = await db.query<{ id: string; name: string }>(
    "INSERT INTO items (location_id, name) VALUES ($1, 'کرم'), ($1, 'شامپو') RETURNING id, name",
    [locationId],
  );
  itemA = items.rows.find((r) => r.name === "کرم")!.id;
  itemB = items.rows.find((r) => r.name === "شامپو")!.id;
  const list = await db.query<{ id: string }>(
    "INSERT INTO price_lists (location_id, name) VALUES ($1, 'عمده') RETURNING id",
    [locationId],
  );
  listId = list.rows[0].id;
  await db.query("INSERT INTO price_list_entries (price_list_id, item_id, price) VALUES ($1, $2, 50000)", [
    listId,
    itemA,
  ]);
});

describe("savePriceEntries — optimistic concurrency", () => {
  it("reports a stale save as a conflict and does not overwrite, while applying the rest", async () => {
    const loaded = await loadedVersion(itemA);
    expect(loaded).toMatch(/^\d+$/);

    // A colleague saves from the same loaded matrix first.
    const first = await save([{ priceListId: listId, itemId: itemA, price: 55_000, expectedVersion: loaded }]);
    expect(first).toEqual({ touched: 1, conflicts: [] });
    const afterColleague = await loadedVersion(itemA);
    expect(afterColleague).not.toBe(loaded);

    // This screen still holds the old version; its save also fills item B.
    const stale = await save([
      { priceListId: listId, itemId: itemA, price: 60_000, expectedVersion: loaded },
      { priceListId: listId, itemId: itemB, price: 30_000, expectedVersion: null },
    ]);

    expect(stale.touched).toBe(1);
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.conflicts[0]).toMatchObject({
      priceListId: listId,
      itemId: itemA,
      requestedPrice: 60_000,
      currentPrice: 55_000,
      currentVersion: afterColleague,
    });
    expect(Number.isNaN(Date.parse(stale.conflicts[0].updatedAt!))).toBe(false);

    expect(await stored(itemA)).toBe(55_000); // not overwritten
    expect(await stored(itemB)).toBe(30_000); // the non-conflicting cell landed
  });

  it("a deliberate overwrite with the reported current version is applied", async () => {
    const loaded = await loadedVersion(itemA);
    await save([{ priceListId: listId, itemId: itemA, price: 55_000, expectedVersion: loaded }]);
    const stale = await save([{ priceListId: listId, itemId: itemA, price: 60_000, expectedVersion: loaded }]);
    const current = stale.conflicts[0].currentVersion;

    const overwrite = await save([{ priceListId: listId, itemId: itemA, price: 60_000, expectedVersion: current }]);
    expect(overwrite).toEqual({ touched: 1, conflicts: [] });
    expect(await stored(itemA)).toBe(60_000);
  });

  it("a stale clear is a conflict and leaves the row in place", async () => {
    const loaded = await loadedVersion(itemA);
    await save([{ priceListId: listId, itemId: itemA, price: 52_000, expectedVersion: loaded }]);
    const stale = await save([{ priceListId: listId, itemId: itemA, price: null, expectedVersion: loaded }]);
    expect(stale.conflicts[0]).toMatchObject({ requestedPrice: null, currentPrice: 52_000 });
    expect(await stored(itemA)).toBe(52_000);
  });

  it("a cell loaded empty that someone else filled is a conflict, not an overwrite", async () => {
    expect(await loadedVersion(itemB)).toBeNull();
    await save([{ priceListId: listId, itemId: itemB, price: 31_000, expectedVersion: null }]);

    const stale = await save([{ priceListId: listId, itemId: itemB, price: 35_000, expectedVersion: null }]);
    expect(stale.touched).toBe(0);
    expect(stale.conflicts[0]).toMatchObject({ itemId: itemB, currentPrice: 31_000 });
    expect(await stored(itemB)).toBe(31_000);
  });

  it("a quick update after the matrix loaded makes its save a conflict", async () => {
    const loaded = await loadedVersion(itemA);
    await dbLib.withTenant(
      businessId,
      () =>
        service.quickUpdatePrices({
          target: { kind: "list", priceListId: listId },
          mode: "percent",
          value: 10,
          round: false,
          itemIds: [],
          locationId,
        }),
      { locationId },
    );
    expect(await stored(itemA)).toBe(55_000);

    const stale = await save([{ priceListId: listId, itemId: itemA, price: 51_000, expectedVersion: loaded }]);
    expect(stale.conflicts).toHaveLength(1);
    expect(await stored(itemA)).toBe(55_000);
  });

  it("two simultaneous saves from one loaded version: exactly one wins", async () => {
    const loaded = await loadedVersion(itemA);
    const [left, right] = await Promise.all([
      save([{ priceListId: listId, itemId: itemA, price: 61_000, expectedVersion: loaded }]),
      save([{ priceListId: listId, itemId: itemA, price: 62_000, expectedVersion: loaded }]),
    ]);
    const winners = [left, right].filter((r) => r.conflicts.length === 0);
    const losers = [left, right].filter((r) => r.conflicts.length === 1);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winningPrice = winners[0] === left ? 61_000 : 62_000;
    expect(await stored(itemA)).toBe(winningPrice);
    expect(losers[0].conflicts[0].currentPrice).toBe(winningPrice);
  });

  it("two simultaneous first fills of an empty cell: exactly one wins", async () => {
    const [left, right] = await Promise.all([
      save([{ priceListId: listId, itemId: itemB, price: 41_000, expectedVersion: null }]),
      save([{ priceListId: listId, itemId: itemB, price: 42_000, expectedVersion: null }]),
    ]);
    expect([left, right].filter((r) => r.conflicts.length === 0)).toHaveLength(1);
    expect([left, right].filter((r) => r.conflicts.length === 1)).toHaveLength(1);
  });

  it("an older client that sends no version keeps last-write-wins", async () => {
    const loaded = await loadedVersion(itemA);
    await save([{ priceListId: listId, itemId: itemA, price: 55_000, expectedVersion: loaded }]);

    const legacy = await save([
      { priceListId: listId, itemId: itemA, price: 70_000 },
      { priceListId: listId, itemId: itemB, price: 20_000 },
    ]);
    expect(legacy).toEqual({ touched: 2, conflicts: [] });
    expect(await stored(itemA)).toBe(70_000);
    expect(await stored(itemB)).toBe(20_000);
  });
});
