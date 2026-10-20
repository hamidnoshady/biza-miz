/**
 * Issue #924, code-review follow-ups — the parts only Postgres can prove:
 *
 *  1. the price matrix is *bounded*: a page returns a `limit`ed item window,
 *     its own cells, and a catalogue total; search is server-side and `%` in a
 *     search is a literal, not a wildcard;
 *  2. the retail-advisor suggestion becomes audit metadata only when the saved
 *     price still equals the suggestion — a preview writes nothing, an accepted
 *     suggestion is recorded once as `source='recommendation'`, and a manual
 *     override stays `source='manual'` with no recommendation metadata;
 *  3. a member who holds `menu.edit` but not `inventory.adjust` is denied at the
 *     same guard every price writer uses — including the AI/MCP action map.
 *
 * `npm run test:db` (needs Postgres; not part of `npm test`).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
let creation: typeof import("../src/lib/product-creation-service");
let authorizeLib: typeof import("../src/lib/authorize");

let businessId = "";
let locationId = "";
let ownerId = "";
let menuOnlyId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function addItem(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO items (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, name],
  );
  return rows[0].id;
}

async function historyFor(itemId: string) {
  const { rows } = await db.query<{
    source: string;
    reason: string | null;
    metadata: Record<string, unknown> | null;
    old_price: string | null;
    new_price: string | null;
  }>(
    "SELECT source, reason, metadata, old_price::text, new_price::text FROM product_price_history WHERE item_id = $1 ORDER BY created_at",
    [itemId],
  );
  return rows.map((row) => ({
    source: row.source,
    reason: row.reason,
    metadata: row.metadata,
    oldPrice: row.old_price == null ? null : Number(row.old_price),
    newPrice: row.new_price == null ? null : Number(row.new_price),
  }));
}

beforeAll(async () => {
  databaseName = `pos_price_review_${randomUUID().replaceAll("-", "")}`;
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
  creation = await import("../src/lib/product-creation-service");
  authorizeLib = await import("../src/lib/authorize");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  const dbLib = await import("../src/lib/db");
  await dbLib.getPool().end().catch(() => {});
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
  await db.query("DELETE FROM product_price_history");
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

  const owner = await db.query<{ id: string }>(
    "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id",
    [businessId],
  );
  ownerId = owner.rows[0].id;

  // A member whose role grants exactly «دسترسی به منو» — the permission the
  // price routes used to require, and which must no longer be enough.
  const role = await db.query<{ id: string }>(
    "INSERT INTO tenant_roles (business_id, name, permissions) VALUES ($1, 'menu only', '[\"menu.edit\",\"menu.view\"]'::jsonb) RETURNING id",
    [businessId],
  );
  const menuOnly = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash, custom_role_id)
     VALUES ($1, 'cashier', 'Menu Only', 'x', $2) RETURNING id`,
    [businessId, role.rows[0].id],
  );
  menuOnlyId = menuOnly.rows[0].id;
});

describe("bounded matrix read (F12)", () => {
  it("returns one page of items, only that page's cells, and the catalogue total", async () => {
    const list = await db.query<{ id: string }>(
      "INSERT INTO price_lists (location_id, name) VALUES ($1, 'عمده') RETURNING id",
      [locationId],
    );
    const itemIds: string[] = [];
    for (let i = 0; i < 120; i += 1) itemIds.push(await addItem(`کالای ${String(i).padStart(3, "0")}`));
    // Every item has a named-list cell; the page must not return all of them.
    await db.query(
      `INSERT INTO price_list_entries (price_list_id, item_id, price)
       SELECT $1, unnest($2::uuid[]), 50000`,
      [list.rows[0].id, itemIds],
    );

    const page = await service.listPriceMatrix(locationId, service.normalizePriceMatrixQuery({ limit: "50" }));
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(120);
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(true);

    const returned = new Set(page.items.map((item) => item.id));
    expect(page.entries.length).toBe(50);
    expect(page.entries.every((entry) => returned.has(entry.itemId))).toBe(true);

    const last = await service.listPriceMatrix(locationId, service.normalizePriceMatrixQuery({ limit: "50", offset: "100" }));
    expect(last.items).toHaveLength(20);
    expect(last.hasMore).toBe(false);
    expect(last.entries.length).toBe(20);
  });

  it("searches server-side and treats LIKE metacharacters as literals", async () => {
    await addItem("کرم مرطوب‌کننده");
    await addItem("شامپو");
    await addItem("کرم 100% خالص");
    await addItem("کرم 100x خالص");

    const found = await service.listPriceMatrix(locationId, service.normalizePriceMatrixQuery({ q: "شامپو" }));
    expect(found.total).toBe(1);
    expect(found.items[0].name).toBe("شامپو");

    // `%` is a search character here, not "match everything".
    const percent = await service.listPriceMatrix(locationId, service.normalizePriceMatrixQuery({ q: "%" }));
    expect(percent.total).toBe(1);
    expect(percent.items[0].name).toBe("کرم 100% خالص");

    const all = await service.listPriceMatrix(locationId, service.normalizePriceMatrixQuery({}));
    expect(all.total).toBe(4);
  });

  it("caps the AI listing read so it cannot pull an unbounded cell set", async () => {
    const list = await db.query<{ id: string }>(
      "INSERT INTO price_lists (location_id, name) VALUES ($1, 'همکار') RETURNING id",
      [locationId],
    );
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await addItem(`کالای ${i}`));
    await db.query(
      `INSERT INTO price_list_entries (price_list_id, item_id, price)
       SELECT $1, unnest($2::uuid[]), 50000`,
      [list.rows[0].id, ids],
    );
    expect(await service.listPriceEntries(locationId, 2)).toHaveLength(2);
    expect(await service.listPriceEntries(locationId, 1_000_000)).toHaveLength(5);
  });
});

describe("recommendation provenance in the price audit (review item 3)", () => {
  const recommendation = {
    suggestedPriceRial: 135_000,
    mode: "markup" as const,
    inputs: {
      referenceCostRial: 100_000,
      fixedOverheadRial: 0,
      percentOverhead: 10,
      overheadBase: "reference",
      markupPercent: 22.7,
      marginPercent: null,
      rounding: "nearest",
      roundStepRial: 1_000,
      taxPercent: null,
      taxMode: null,
    },
  };

  function product(sellPrice: number) {
    return {
      name: "کرم مرطوب‌کننده",
      sku: null,
      barcode: null,
      isSellable: true,
      unit: null,
      subUnit: null,
      conversionFactor: null,
      minOrderQty: null,
      reorderReminderQty: null,
      leadTimeDays: null,
      storageLocation: null,
      taxSalePercent: null,
      taxPurchasePercent: null,
      sellPrice,
      purchasePrice: 100_000,
      quantity: "0",
      variants: [],
      priceRecommendation: recommendation,
    };
  }

  it("a preview writes nothing — no item, no price, no history", async () => {
    const engine = await import("../src/lib/retail-price-recommendation");
    const before = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM product_price_history");
    const beforeItems = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM items");

    const preview = engine.previewRetailPrice({
      referenceCost: { amountRial: 100_000, currency: "IRR" },
      overhead: { fixedRial: 0, percent: 10, base: "reference" },
      target: { kind: "markup", percent: 22.7 },
      rounding: { policy: "nearest", stepRial: 1_000 },
    });
    expect(preview.ok).toBe(true);

    const after = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM product_price_history");
    const afterItems = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM items");
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(afterItems.rows[0].count).toBe(beforeItems.rows[0].count);
  });

  it("an authorized save of the suggested price writes exactly one recommendation row with its inputs", async () => {
    const created = await creation.createProductRecord(locationId, product(recommendation.suggestedPriceRial), {
      businessId,
      userId: ownerId,
      recommendation,
    });

    const rows = await historyFor(created.item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "recommendation",
      reason: "product_created_with_recommended_price",
      oldPrice: null,
      newPrice: 135_000,
    });
    expect(rows[0].metadata).toMatchObject({
      kind: "retail_price_recommendation",
      mode: "markup",
      suggestedPriceRial: 135_000,
      appliedPriceRial: 135_000,
    });
    expect(rows[0].metadata?.inputs).toMatchObject({
      referenceCostRial: 100_000,
      percentOverhead: 10,
      markupPercent: 22.7,
      rounding: "nearest",
    });
  });

  it("a manual override is recorded as a manual edit, with no recommendation metadata", async () => {
    const created = await creation.createProductRecord(locationId, product(120_000), {
      businessId,
      userId: ownerId,
      recommendation,
    });

    const rows = await historyFor(created.item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "manual",
      reason: "product_created",
      newPrice: 120_000,
      metadata: null,
    });
  });

  it("a variant priced at the suggestion is recorded once per item, and only for matching prices", async () => {
    const input = {
      ...product(recommendation.suggestedPriceRial),
      variants: [
        {
          name: null,
          sku: null,
          barcode: null,
          attributes: [{ name: "حجم", value: "بزرگ" }],
          sellPrice: recommendation.suggestedPriceRial,
          purchasePrice: null,
          quantity: null,
        },
        {
          name: null,
          sku: null,
          barcode: null,
          attributes: [{ name: "حجم", value: "کوچک" }],
          sellPrice: 90_000,
          purchasePrice: null,
          quantity: null,
        },
      ],
    };
    const created = await creation.createProductRecord(locationId, input, {
      businessId,
      userId: ownerId,
      recommendation,
    });

    const all = await db.query<{ item_id: string; source: string; new_price: string }>(
      "SELECT item_id, source, new_price::text FROM product_price_history ORDER BY new_price",
    );
    expect(all.rows).toHaveLength(2);
    const byPrice = Object.fromEntries(all.rows.map((row) => [Number(row.new_price), row.source]));
    expect(byPrice[135_000]).toBe("recommendation");
    expect(byPrice[90_000]).toBe("manual");
    expect(created.variants).toHaveLength(2);
  });
});

describe("pricing permission gate (review item 4)", () => {
  const sessionFor = (sub: string) => ({
    sub,
    businessId,
    role: "cashier" as const,
    locationId,
    fullName: "Member",
  });

  it("a menu.edit member is allowed to edit the menu but denied inventory.adjust", async () => {
    const menu = await authorizeLib.authorize(sessionFor(menuOnlyId), { permission: "menu.edit" });
    expect(menu.ok).toBe(true);

    const adjust = await authorizeLib.authorize(sessionFor(menuOnlyId), { permission: "inventory.adjust" });
    expect(adjust.ok).toBe(false);
    expect(adjust).toMatchObject({ code: "MISSING_PERMISSION", permission: "inventory.adjust", status: 403 });

    const view = await authorizeLib.authorize(sessionFor(menuOnlyId), { permission: "inventory.view" });
    expect(view).toMatchObject({ ok: false, status: 403 });

    const owner = await authorizeLib.authorize(sessionFor(ownerId), { permission: "inventory.adjust" });
    expect(owner.ok).toBe(true);
  });

  it("every price-list writer route demands inventory.adjust, never menu.edit", () => {
    const routes = [
      "src/app/api/products/price-lists/route.ts",
      "src/app/api/products/price-lists/[id]/route.ts",
      "src/app/api/products/price-lists/entries/route.ts",
      "src/app/api/products/price-lists/stock/route.ts",
      "src/app/api/products/price-lists/quick-update/route.ts",
    ];
    for (const route of routes) {
      const source = readFileSync(join(__dirname, "..", route), "utf8");
      expect(source, `${route} must gate writes on inventory.adjust`).toContain(
        "requirePermission(PERMISSIONS.inventoryAdjust)",
      );
      expect(source, `${route} must not use a menu permission`).not.toContain("PERMISSIONS.menuEdit");
    }
    // The read side stays on inventory.view.
    const listRoute = readFileSync(
      join(__dirname, "..", "src/app/api/products/price-lists/route.ts"),
      "utf8",
    );
    expect(listRoute).toContain("requirePermission(PERMISSIONS.inventoryView)");
  });

  it("the AI/MCP price writers map to the same inventory.adjust gate", async () => {
    const { AI_ACTION_PERMISSION_MAP, AI_TOOL_PERMISSION_MAP } = await import("../src/lib/ai-capabilities");
    expect(AI_ACTION_PERMISSION_MAP["priceList.quick_update"]).toBe("inventory.adjust");
    expect(AI_ACTION_PERMISSION_MAP["priceList.entries.save"]).toBe("inventory.adjust");
    expect(AI_ACTION_PERMISSION_MAP["priceList.create"]).toBe("inventory.adjust");
    expect(AI_ACTION_PERMISSION_MAP["priceList.rename"]).toBe("inventory.adjust");
    expect(AI_ACTION_PERMISSION_MAP["priceList.delete"]).toBe("inventory.adjust");
    // Reading lists through MCP is a view capability, matching the HTTP GET.
    expect(AI_TOOL_PERMISSION_MAP.list_price_lists).toBe("inventory.view");
    expect(AI_TOOL_PERMISSION_MAP.list_price_list_entries).toBe("inventory.view");
  });
});
