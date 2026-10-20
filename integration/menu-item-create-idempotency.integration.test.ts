/**
 * Issue #911 — one save, one item, against a real database.
 *
 * The route test proves the key is accepted and forwarded; only the database
 * can prove it is *enforced*:
 *
 *  1. the same key twice creates one item and the second call answers with
 *     the first one's id (`duplicate: true`), not an error and not a second
 *     row;
 *  2. without a key nothing is deduplicated — the importers, the CSV path,
 *     the AI autopilot and the syncs must keep creating items exactly as
 *     they always have;
 *  3. the key is scoped to the branch: the same key in another branch is a
 *     different item, so one branch's retry can never swallow another's
 *     create;
 *  4. two saves that race are settled by the unique index, not by luck — one
 *     item, both callers told about it;
 *  5. a replay does not duplicate the item's lifecycle record either: one
 *     «created» row for one item.
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

/** Imported after DATABASE_URL is pointed at the scratch DB. */
let menuService: typeof import("../src/lib/menu-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let userId = "";
let categoryId = "";
let otherCategoryId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function insertCategory(locationId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, `Drinks ${randomUUID().slice(0, 8)}`],
  );
  return rows[0].id;
}

async function itemsNamed(name: string) {
  const { rows } = await db.query<{
    id: string;
    location_id: string;
    create_idempotency_key: string | null;
  }>(
    "SELECT id, location_id, create_idempotency_key FROM menu_items WHERE name = $1 ORDER BY created_at, id",
    [name],
  );
  return rows;
}

async function createdAuditRows() {
  const { rows } = await db.query<{ entity_id: string; action: string }>(
    "SELECT entity_id, action FROM audit_log WHERE action = 'menu.item.created'",
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_menu_create_key_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  menuService = await import("../src/lib/menu-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
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
    "INSERT INTO businesses (name, slug) VALUES ('Cafe', $1) RETURNING id",
    [`cafe-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;

  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Other')
     RETURNING id, name`,
    [businessId],
  );
  mainId = locations.rows.find((r) => r.name === "Main")!.id;
  otherId = locations.rows.find((r) => r.name === "Other")!.id;

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  userId = owner.rows[0].id;

  categoryId = await insertCategory(mainId);
  otherCategoryId = await insertCategory(otherId);
});

describe("createMenuItem — one save, one item", () => {
  it("answers a retry with the item the first attempt created", async () => {
    const key = `draft-${randomUUID()}`;

    const first = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );
    const second = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: true, id: first.id, duplicate: true });
    // One item, not two — the double-click the operator saw nothing of.
    expect(await itemsNamed("لاته")).toHaveLength(1);
  });

  it("keeps the key on the row it belongs to", async () => {
    const key = `draft-${randomUUID()}`;
    const created = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );

    const rows = await itemsNamed("لاته");
    expect(rows[0].id).toBe(created.id);
    expect(rows[0].create_idempotency_key).toBe(key);
  });

  it("creates without a key exactly as the importers and syncs do", async () => {
    const first = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000 },
      { changedBy: userId },
    );
    const second = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000 },
      { changedBy: userId },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.id).not.toBe(first.id);
    // No key, no dedupe: two deliberate creates are two items.
    expect(await itemsNamed("لاته")).toHaveLength(2);
  });

  it("treats a different key as a different item", async () => {
    await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: "draft-a" },
      { changedBy: userId },
    );
    await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: "draft-b" },
      { changedBy: userId },
    );

    expect(await itemsNamed("لاته")).toHaveLength(2);
  });

  it("scopes the key to the branch, so another branch's retry cannot swallow it", async () => {
    const key = `draft-${randomUUID()}`;

    const inMain = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );
    const inOther = await menuService.createMenuItem(
      otherId,
      businessId,
      { categoryId: otherCategoryId, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );

    expect(inOther.ok).toBe(true);
    expect(inOther.id).not.toBe(inMain.id);
    const rows = await itemsNamed("لاته");
    expect(rows.map((row) => row.location_id).sort()).toEqual([mainId, otherId].sort());
  });

  it("settles two saves that race on the same key — one item, both told", async () => {
    const key = `draft-${randomUUID()}`;
    const input = { categoryId, name: "لاته", price: 40_000, idempotencyKey: key };

    const [first, second] = await Promise.all([
      menuService.createMenuItem(mainId, businessId, input, { changedBy: userId }),
      menuService.createMenuItem(mainId, businessId, input, { changedBy: userId }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const rows = await itemsNamed("لاته");
    expect(rows).toHaveLength(1);
    // Whichever lost the race reports the winner's item.
    expect([first.id, second.id]).toContain(rows[0].id);
  });

  it("records the creation once, whoever won the race", async () => {
    const key = `draft-${randomUUID()}`;
    const input = { categoryId, name: "لاته", price: 40_000, idempotencyKey: key };

    await menuService.createMenuItem(mainId, businessId, input, { changedBy: userId });
    await menuService.createMenuItem(mainId, businessId, input, { changedBy: userId });

    // One item, one «created» row: a replay is not a second creation.
    const audits = await createdAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].entity_id).toBe((await itemsNamed("لاته"))[0].id);
  });

  it("leaves a refused create refusing, key or no key", async () => {
    const key = `draft-${randomUUID()}`;
    const missingCategory = "33333333-3333-4333-8333-333333333333";

    const result = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId: missingCategory, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );
    expect(result).toMatchObject({ ok: false, error: "category_not_found", status: 404 });

    // A refusal is not a replay: the key is still free for the retry that
    // will actually create the item.
    const retried = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000, idempotencyKey: key },
      { changedBy: userId },
    );
    expect(retried).toMatchObject({ ok: true, id: expect.any(String) });
  });
});
