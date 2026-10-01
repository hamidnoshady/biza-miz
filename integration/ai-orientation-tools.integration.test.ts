/**
 * Phase 33 — the three tools that stop the assistant behaving like a form.
 *
 * Every case here is a real complaint reproduced against a real database:
 *
 *   - asked «نان چند تکه مونده؟», it demanded an `inventoryItemId` — a UUID
 *     nobody can read off a shelf. `find_items` resolves the Persian name.
 *   - it reported "پیدا نشد" for an item that was merely disabled.
 *   - asked for all bread waste ever, it reached for the current-stock tool
 *     and answered with «spoilage» and «staff_meal» in English.
 *   - it did not know which modules this business even has.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { SYSTEM_AI_READ_PERMISSIONS } from "../src/lib/ai-capabilities";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let aiTools: typeof import("../src/lib/ai-tools");

const cafe = { businessId: "", locationId: "", breadId: "", retiredId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_ai_orientation_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  aiTools = await import("../src/lib/ai-tools");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('کافه', $1, 'food_service') RETURNING id",
    [`cafe-${randomUUID().slice(0, 8)}`],
  );
  cafe.businessId = business.rows[0].id;

  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ ونک') RETURNING id",
    [cafe.businessId],
  );
  cafe.locationId = location.rows[0].id;

  const bread = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'نان باگت', 'عدد', 50000, 600000) RETURNING id`,
    [cafe.locationId],
  );
  cafe.breadId = bread.rows[0].id;

  // An item the café stopped carrying. It must be findable and reported as
  // disabled — "not found" would send the owner looking for a typo.
  const retired = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, is_active)
     VALUES ($1, 'نان جو', 'عدد', 40000, false) RETURNING id`,
    [cafe.locationId],
  );
  cafe.retiredId = retired.rows[0].id;

  await db.query(
    `INSERT INTO stock_movements
       (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial, source_type)
     VALUES ($1, $2, 'purchase', 12, 50000, 600000, 'opening')`,
    [cafe.locationId, cafe.breadId],
  );

  // Two nights of bread waste, for two different reasons.
  await db.query(
    `INSERT INTO stock_movements
       (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial, source_type, waste_reason, occurred_at)
     VALUES ($1, $2, 'waste', -8, 50000, 400000, 'waste', 'spoilage', now() - interval '2 days'),
            ($1, $2, 'waste', -2, 50000, 100000, 'waste', 'staff_meal', now() - interval '1 day')`,
    [cafe.locationId, cafe.breadId],
  );
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

function run(name: string, args: Record<string, unknown> = {}) {
  return dbLib.withTenant(cafe.businessId, () => aiTools.runReadTool(name, args, cafe.businessId, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS));
}

describe("find_items — the owner says a name, not a UUID", () => {
  it("finds an item from part of its Persian name, with everything needed to act", async () => {
    const result = await run("find_items", { query: "نان" });
    expect(result.ok).toBe(true);
    const data = result.data as { matches: Record<string, unknown>[]; matchCount: number };
    expect(data.matchCount).toBe(2);

    const baguette = data.matches.find((row) => row.name === "نان باگت");
    expect(baguette).toMatchObject({
      inventoryItemId: cafe.breadId,
      unit: "عدد",
      branch: "شعبهٔ ونک",
      isActive: true,
      statusLabel: "فعال",
    });
    // On hand now: 12 received, 10 wasted.
    expect(baguette?.onHandQty).toBe("2");
  });

  it("reports a disabled item as disabled — never as missing", async () => {
    const result = await run("find_items", { query: "نان جو" });
    const data = result.data as { matches: Record<string, unknown>[] };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ isActive: false, statusLabel: "غیرفعال" });
  });

  it("says plainly when nothing matched, instead of returning a bare empty list", async () => {
    const result = await run("find_items", { query: "قهوهٔ کلمبیا" });
    const data = result.data as { matchCount: number; note: string | null };
    expect(data.matchCount).toBe(0);
    expect(data.note).toContain("پیدا نشد");
  });

  it("refuses an empty query rather than dumping the whole catalogue", async () => {
    const result = await run("find_items", { query: "   " });
    expect(result.ok).toBe(false);
  });
});

describe("get_waste_history — the question that was answered badly", () => {
  it("breaks bread waste down by reason, in Persian, with Toman totals", async () => {
    const result = await run("get_waste_history", { itemQuery: "نان" });
    expect(result.ok).toBe(true);
    const data = result.data as {
      lines: Record<string, unknown>[];
      totalCost: { rial: number; toman: number };
    };

    expect(data.totalCost.rial).toBe(500_000);
    expect(data.totalCost.toman).toBe(50_000);

    const reasons = data.lines.map((line) => line.reason).sort();
    expect(reasons).toEqual(["فساد و ماندگی", "مصرف پرسنل"]);
    // The raw enum value must not leak into anything the model can echo.
    expect(JSON.stringify(data.lines)).not.toContain("spoilage");

    const spoilage = data.lines.find((line) => line.reason === "فساد و ماندگی");
    expect(spoilage).toMatchObject({ item: "نان باگت", unit: "عدد", quantity: "8" });
  });

  it("honours a date window", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await run("get_waste_history", { itemQuery: "نان", dateFrom: today });
    const data = result.data as { lines: unknown[] };
    // Both entries are older than today.
    expect(data.lines).toHaveLength(0);
  });

  it("says so when there is nothing, rather than implying zero waste is unknown", async () => {
    const result = await run("get_waste_history", { itemQuery: "چای" });
    const data = result.data as { note: string | null };
    expect(data.note).toContain("ثبت نشده");
  });
});

describe("describe_app — knowing which product this is", () => {
  it("reports the trade, its branches and the vocabulary it uses", async () => {
    const result = await run("describe_app");
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.industry).toMatchObject({ code: "food_service" });
    expect(data.branches).toEqual([{ name: "شعبهٔ ونک", isActive: true }]);
    expect(data.modules).toContain("inventory");
    expect((data.vocabulary as Record<string, string>).saleDocument).toBeTruthy();
  });

  it("lists what it may change, so it can answer «چه کاری از تو برمی‌آید؟»", async () => {
    const result = await run("describe_app");
    const data = result.data as { actionsICanPropose: { type: string; label: string }[] };
    expect(data.actionsICanPropose.length).toBeGreaterThan(10);
    for (const action of data.actionsICanPropose) {
      expect(action.label.length, action.type).toBeGreaterThan(0);
    }
  });
});
