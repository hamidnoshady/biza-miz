/**
 * Phase 21 Wave 1 exit criterion (partial): the generic Item/Variant/Serial
 * primitive works end-to-end — a variant_parent's children carry their own
 * distinguishing attributes, a serial-tracked item's units have real
 * identity and a status lifecycle, and a business's chosen industry is
 * readable back exactly as stored. Cross-tenant isolation for the new
 * tables is proven generically by tenant-isolation.integration.test.ts
 * (it discovers every non-exempt table from pg_class), not re-proven here.
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
let itemsService: typeof import("../src/lib/items-service");
let productCreation: typeof import("../src/lib/product-creation-service");
let productAttributes: typeof import("../src/lib/product-attributes-service");
let productInput: typeof import("../src/lib/product-input");
let barcodes: typeof import("../src/lib/item-barcodes-service");
let accessories: typeof import("../src/lib/accessories-service");

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
  databaseName = `pos_items_${randomUUID().replaceAll("-", "")}`;

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
  itemsService = await import("../src/lib/items-service");
  productCreation = await import("../src/lib/product-creation-service");
  productAttributes = await import("../src/lib/product-attributes-service");
  productInput = await import("../src/lib/product-input");
  barcodes = await import("../src/lib/item-barcodes-service");
  accessories = await import("../src/lib/accessories-service");

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

beforeEach(async () => {
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM item_variant_attributes");
  await db.query("DELETE FROM item_attribute_definitions");
  await db.query("DELETE FROM item_stones");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string; industry: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Bijoux Co', $1) RETURNING id, industry",
    [`items-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  // Every business created before Phase 21 -- and any not given an explicit
  // industry -- is food_service by construction (the column's DEFAULT).
  expect(bizRow.rows[0].industry).toBe("food_service");

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
});

describe("businesses.industry", () => {
  it("is set and read back exactly as chosen", async () => {
    const row = await db.query<{ id: string; industry: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id, industry",
      [`jewelry-${randomUUID().slice(0, 8)}`],
    );
    expect(row.rows[0].industry).toBe("jewelry");
  });

  it("rejects an unknown industry value at the database", async () => {
    await expect(
      db.query("INSERT INTO businesses (name, slug, industry) VALUES ('Bad Co', $1, 'bakery')", [
        `bad-${randomUUID().slice(0, 8)}`,
      ]),
    ).rejects.toThrow();
  });
});

describe("items-service: simple items", () => {
  it("creates and lists a simple item", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر طلا" });
    expect(item.kind).toBe("simple");
    expect(item.tracking).toBe("none");

    const listed = await itemsService.listItems(biz.locationId);
    expect(listed.map((i) => i.id)).toContain(item.id);
  });

  it("refuses createItem for a variant_child (must go through createVariantChild)", async () => {
    await expect(
      itemsService.createItem({ locationId: biz.locationId, name: "x", kind: "variant_child" }),
    ).rejects.toThrow();
  });
});

describe("items-service: variant parent/child", () => {
  it("creates a variant parent with children carrying their own attributes", async () => {
    const parent = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند بدلیجات",
      kind: "variant_parent",
    });

    const red = await itemsService.createVariantChild(parent.id, biz.locationId, "قرمز - M", null, [
      { name: "رنگ", value: "قرمز" },
      { name: "سایز", value: "M" },
    ]);
    const blue = await itemsService.createVariantChild(parent.id, biz.locationId, "آبی - L", null, [
      { name: "رنگ", value: "آبی" },
      { name: "سایز", value: "L" },
    ]);

    expect(red.kind).toBe("variant_child");
    expect(red.parentItemId).toBe(parent.id);

    const children = await itemsService.listVariantChildren(parent.id);
    expect(children.map((c) => c.id).sort()).toEqual([blue.id, red.id].sort());

    const redAttrs = await itemsService.listVariantAttributes(red.id);
    expect(redAttrs.map((a) => [a.name, a.value]).sort()).toEqual([
      ["رنگ", "قرمز"],
      ["سایز", "M"],
    ]);
  });

  it("refuses a variant child with no attributes", async () => {
    const parent = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند",
      kind: "variant_parent",
    });
    await expect(
      itemsService.createVariantChild(parent.id, biz.locationId, "بی‌نام", null, []),
    ).rejects.toThrow();

    // Nothing partially committed: the failed attempt left no orphan item row.
    const children = await itemsService.listVariantChildren(parent.id);
    expect(children).toHaveLength(0);
  });
});

describe("product attribute definition service", () => {
  it("normalizes Persian duplicate names, scopes reads/writes to a branch, and uses edit versions", async () => {
    const first = await productAttributes.createAttributeDefinition({
      businessId: biz.id,
      locationId: biz.locationId,
      name: "كليد",
      options: ["روشن", "تیره"],
      isActive: true,
    });
    expect(first.definition).toMatchObject({ name: "کلید", version: 1, isActive: true });
    if (!first.definition) return;

    const duplicate = await productAttributes.createAttributeDefinition({
      businessId: biz.id,
      locationId: biz.locationId,
      name: "کليد",
      options: [],
      isActive: true,
    });
    // The Persian-aware comparison also ignores Arabic combining marks and
    // canonical variants, without silently changing a saved display label.
    expect(duplicate.error).toBe("duplicate_name");

    const otherLocation = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Attribute branch') RETURNING id",
      [biz.id],
    );
    expect(await productAttributes.updateAttributeDefinition(
      first.definition.id,
      otherLocation.rows[0].id,
      { name: "ویرایش شعبهٔ دیگر", version: 1 },
      biz.id,
    )).toEqual({ error: "not_found" });
    expect((await productAttributes.listAttributeDefinitions(otherLocation.rows[0].id))).toEqual([]);

    const updated = await productAttributes.updateAttributeDefinition(
      first.definition.id,
      biz.locationId,
      { options: ["روشن", "تیره", "مات"], version: 1 },
      biz.id,
    );
    expect(updated.definition).toMatchObject({ version: 2, options: ["روشن", "تیره", "مات"] });
    const stale = await productAttributes.updateAttributeDefinition(
      first.definition.id,
      biz.locationId,
      { name: "نام قدیمی", version: 1 },
      biz.id,
    );
    expect(stale).toMatchObject({ error: "version_conflict", current: { version: 2 } });

    const unused = await productAttributes.createAttributeDefinition({
      businessId: biz.id,
      locationId: biz.locationId,
      name: "جنس",
      options: [],
      isActive: true,
    });
    expect(unused.definition).toBeDefined();
    if (unused.definition) {
      expect(await productAttributes.deleteAttributeDefinition(unused.definition.id, biz.locationId, biz.id)).toEqual({});
    }
  });
});

describe("products workspace: publish status and descriptions (migration 0260)", () => {
  it("defaults an item to published with no text, so every existing row behaves as before", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "کالای قدیمی" });
    expect(item).toMatchObject({ publishStatus: "published", shortDescription: null, longDescription: null });
  });

  it("stores the status and both descriptions from creation, and the board reads them back", async () => {
    const parsed = productInput.parseProductCreateInput({
      name: "دستبند",
      sellPrice: 500_000,
      publishStatus: "draft",
      shortDescription: "  خلاصه  ",
      longDescription: "متن کامل",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const created = await productCreation.createProductRecord(biz.locationId, parsed.data);
    expect(created.item).toMatchObject({ publishStatus: "draft", shortDescription: "خلاصه", longDescription: "متن کامل" });

    const board = await accessories.listVariantBoard(biz.locationId);
    expect(board.find((row) => row.id === created.item.id)).toMatchObject({
      publishStatus: "draft",
      shortDescription: "خلاصه",
      longDescription: "متن کامل",
    });
  });

  it("updates through the meta patch, clears a text with null, and leaves untouched fields alone", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "کالا" });
    const first = await itemsService.updateItemMeta(item.id, {
      publishStatus: "private",
      shortDescription: "کوتاه",
      longDescription: "کامل",
    });
    expect(first).toMatchObject({ publishStatus: "private", shortDescription: "کوتاه", longDescription: "کامل" });

    const second = await itemsService.updateItemMeta(item.id, { shortDescription: null });
    expect(second).toMatchObject({ publishStatus: "private", shortDescription: null, longDescription: "کامل" });
  });

  it("refuses an unknown status or an over-long text at the database, whatever the caller validated", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "کالا" });
    await expect(
      db.query("UPDATE items SET publish_status = 'archived' WHERE id = $1", [item.id]),
    ).rejects.toThrow(/items_publish_status_check/);
    await expect(
      db.query("UPDATE items SET short_description = $2 WHERE id = $1", [item.id, "x".repeat(1001)]),
    ).rejects.toThrow(/items_short_description_length/);
    await expect(
      db.query("UPDATE items SET long_description = $2 WHERE id = $1", [item.id, "x".repeat(20001)]),
    ).rejects.toThrow(/items_long_description_length/);
  });
});

describe("products workspace: atomic creation", () => {
  it("keeps a purchase price without inventing a zero-quantity receipt and registers the barcode for scanning", async () => {
    const code = "4006381333931";
    const parsed = productInput.parseProductCreateInput({
      name: "محصول ساده",
      barcode: code,
      purchasePrice: 850_000,
      sellPrice: 1_200_000,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const created = await productCreation.createProductRecord(biz.locationId, parsed.data);
    const stock = await accessories.getStock(created.item.id);
    expect(stock).toMatchObject({ quantity: "0.000000000", unitCost: 850_000, unitPrice: 1_200_000 });

    const matches = await barcodes.lookupBarcode(biz.locationId, code);
    expect(matches).toHaveLength(1);
    expect(matches[0].itemId).toBe(created.item.id);
  });

  it("inherits common metadata on sellable variants and rolls the whole family back on a barcode conflict", async () => {
    await db.query(
      "INSERT INTO item_attribute_definitions (location_id, name, options) VALUES ($1, 'رنگ', '{}')",
      [biz.locationId],
    );
    const existing = await itemsService.createItem({ locationId: biz.locationId, name: "کالای موجود" });
    await barcodes.assignBarcode(existing.id, { code: "036000291452" });

    const parsed = productInput.parseProductCreateInput({
      name: "پیراهن",
      unit: "عدد",
      taxSalePercent: 10,
      sellPrice: 1_000_000,
      variants: [
        {
          barcode: "4006381333931",
          quantity: "2",
          attributes: [{ name: "رنگ", value: "مشکی" }],
        },
        {
          barcode: "036000291452",
          attributes: [{ name: "رنگ", value: "سفید" }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    await expect(productCreation.createProductRecord(biz.locationId, parsed.data)).rejects.toBeInstanceOf(
      barcodes.BarcodeConflictError,
    );

    const leaked = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE name LIKE 'پیراهن%'");
    expect(leaked.rows[0].count).toBe("0");
  });

  it("writes common units and tax metadata onto each sellable variant", async () => {
    await db.query(
      "INSERT INTO item_attribute_definitions (location_id, name, options) VALUES ($1, 'رنگ', '{}')",
      [biz.locationId],
    );
    const parsed = productInput.parseProductCreateInput({
      name: "پیراهن",
      unit: "عدد",
      taxSalePercent: 10,
      variants: [
        {
          quantity: "2",
          purchasePrice: 500_000,
          attributes: [{ name: "رنگ", value: "مشکی" }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const created = await productCreation.createProductRecord(biz.locationId, parsed.data);
    const row = await db.query<{ unit: string | null; tax_sale_percent: string | null }>(
      "SELECT unit, tax_sale_percent::text FROM items WHERE id = $1",
      [created.variants[0].id],
    );
    expect(row.rows[0]).toEqual({ unit: "عدد", tax_sale_percent: "10.00" });
    expect(await accessories.getStock(created.variants[0].id)).toMatchObject({
      quantity: "2.000000000",
      unitCost: 500_000,
    });
  });
});

describe("products workspace: branch-scoped variant attributes", () => {
  it("authorizes a new variant against the active branch and preserves its historical snapshot after definition edits", async () => {
    const definition = await db.query<{ id: string }>(
      "INSERT INTO item_attribute_definitions (location_id, name, options) VALUES ($1, 'رنگ', ARRAY['عسلی', 'مشکی']) RETURNING id",
      [biz.locationId],
    );
    const parsed = productInput.parseProductCreateInput({
      name: "کیف",
      variants: [{
        attributes: [{ definitionId: definition.rows[0].id, name: "رنگ", value: "عسلی" }],
      }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const created = await productCreation.createProductRecord(biz.locationId, parsed.data);
    const snapshot = await db.query<{
      attribute_definition_id: string;
      name: string;
      value: string;
    }>(
      "SELECT attribute_definition_id, name, value FROM item_variant_attributes WHERE item_id = $1",
      [created.variants[0].id],
    );
    expect(snapshot.rows[0]).toEqual({
      attribute_definition_id: definition.rows[0].id,
      name: "رنگ",
      value: "عسلی",
    });

    expect(await productAttributes.deleteAttributeDefinition(definition.rows[0].id, biz.locationId, biz.id)).toMatchObject({
      error: "in_use",
      usageCount: 1,
    });
    const deactivated = await productAttributes.updateAttributeDefinition(
      definition.rows[0].id,
      biz.locationId,
      { isActive: false, version: 1 },
      biz.id,
    );
    expect(deactivated.definition).toMatchObject({ isActive: false, version: 2, usageCount: 1 });

    await db.query(
      "UPDATE item_attribute_definitions SET name = 'طیف رنگ', options = ARRAY['سبز'] WHERE id = $1",
      [definition.rows[0].id],
    );
    const unchangedSnapshot = await db.query<{ name: string; value: string; attribute_definition_id: string }>(
      "SELECT name, value, attribute_definition_id FROM item_variant_attributes WHERE item_id = $1",
      [created.variants[0].id],
    );
    expect(unchangedSnapshot.rows[0]).toEqual({
      name: "رنگ",
      value: "عسلی",
      attribute_definition_id: definition.rows[0].id,
    });

    const freshProduct = productInput.parseProductCreateInput({
      name: "کیف تازه",
      variants: [{ attributes: [{ definitionId: definition.rows[0].id, name: "طیف رنگ", value: "سبز" }] }],
    });
    expect(freshProduct.ok).toBe(true);
    if (!freshProduct.ok) return;
    await expect(productCreation.createProductRecord(biz.locationId, freshProduct.data)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "inactive_attribute_definition" })]),
    });
    const leaked = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE name LIKE 'کیف تازه%'");
    expect(leaked.rows[0].count).toBe("0");
  });

  it("rejects a definition from another branch and a value outside the active option set", async () => {
    const otherLocation = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Other branch') RETURNING id",
      [biz.id],
    );
    const definition = await db.query<{ id: string }>(
      "INSERT INTO item_attribute_definitions (location_id, name, options) VALUES ($1, 'رنگ', ARRAY['عسلی']) RETURNING id",
      [otherLocation.rows[0].id],
    );
    const parsed = productInput.parseProductCreateInput({
      name: "محصول خارج شعبه",
      variants: [{ attributes: [{ definitionId: definition.rows[0].id, name: "رنگ", value: "عسلی" }] }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await expect(productCreation.createProductRecord(biz.locationId, parsed.data)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "unknown_attribute_definition" })]),
    });

    await db.query(
      "UPDATE item_attribute_definitions SET location_id = $1 WHERE id = $2",
      [biz.locationId, definition.rows[0].id],
    );
    const invalidOption = productInput.parseProductCreateInput({
      name: "محصول با گزینهٔ نامعتبر",
      variants: [{ attributes: [{ definitionId: definition.rows[0].id, name: "رنگ", value: "مشکی" }] }],
    });
    expect(invalidOption.ok).toBe(true);
    if (!invalidOption.ok) return;
    await expect(productCreation.createProductRecord(biz.locationId, invalidOption.data)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_attribute_value" })]),
    });
  });
});

describe("items-service: serialized items", () => {
  it("registers a serial only on a tracking:'serial' item", async () => {
    const watch = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت رولکس",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(watch.id, "RLX-0001");
    expect(serial.status).toBe("in_stock");

    const list = await itemsService.listSerials(watch.id);
    expect(list.map((s) => s.serialNumber)).toEqual(["RLX-0001"]);
  });

  it("refuses a serial on a non-serial-tracked item", async () => {
    const simple = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر" });
    await expect(itemsService.addSerial(simple.id, "X-1")).rejects.toThrow();
  });

  it("enforces the serial status lifecycle: sold is terminal", async () => {
    const watch = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(watch.id, "SN-1");

    await itemsService.setSerialStatus(serial.id, "reserved");
    const sold = await itemsService.setSerialStatus(serial.id, "sold");
    expect(sold.status).toBe("sold");

    await expect(itemsService.setSerialStatus(serial.id, "in_stock")).rejects.toThrow();
  });

  it("rejects a duplicate serial number on the same item", async () => {
    const watch = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت",
      tracking: "serial",
    });
    await itemsService.addSerial(watch.id, "DUP-1");
    await expect(itemsService.addSerial(watch.id, "DUP-1")).rejects.toThrow();
  });
});

describe("items-service: weighted items (Phase 21 Wave 2)", () => {
  it("sets weight/purity attributes on a tracking:'weight' item", async () => {
    const bracelet = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند طلا",
      tracking: "weight",
    });
    const attrs = await itemsService.setWeightAttributes(bracelet.id, {
      purity: "18",
      grossWeight: "12.500",
      netWeight: "12.500",
    });
    expect(attrs.purity).toBe("18");
    expect(attrs.grossWeight).toBe("12.500000000");

    const fetched = await itemsService.getWeightAttributes(bracelet.id);
    expect(fetched).toMatchObject({ purity: "18", grossWeight: "12.500000000" });
  });

  it("refuses weight attributes on a non-weight-tracked item", async () => {
    const simple = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر" });
    await expect(
      itemsService.setWeightAttributes(simple.id, { purity: "18", grossWeight: "1", netWeight: "1" }),
    ).rejects.toThrow();
  });

  it("upserts: setting weight attributes again replaces the previous values", async () => {
    const ring = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر",
      tracking: "weight",
    });
    await itemsService.setWeightAttributes(ring.id, { purity: "18", grossWeight: "3", netWeight: "3" });
    const updated = await itemsService.setWeightAttributes(ring.id, {
      purity: "21",
      grossWeight: "3.5",
      netWeight: "3.2",
    });
    expect(updated.purity).toBe("21");

    const fetched = await itemsService.getWeightAttributes(ring.id);
    expect(fetched?.purity).toBe("21");
    expect(fetched?.netWeight).toBe("3.200000000");
  });

  it("rejects net weight greater than gross weight at the database, not just the app layer", async () => {
    const necklace = await itemsService.createItem({
      locationId: biz.locationId,
      name: "گردنبند",
      tracking: "weight",
    });
    // Bypass the service validation to prove the CHECK constraint itself holds.
    await expect(
      db.query(
        `INSERT INTO item_weight_attributes (item_id, purity, gross_weight, net_weight) VALUES ($1, '18', 1, 2)`,
        [necklace.id],
      ),
    ).rejects.toThrow();
  });
});

describe("items-service: gem/stone add-ons (Phase 21 Wave 4)", () => {
  it("adds and lists stones on a weight-tracked item", async () => {
    const ring = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر جواهر",
      tracking: "weight",
    });
    await itemsService.addStone(ring.id, { stoneType: "الماس", carat: "0.5", cost: 20_000_000 });
    await itemsService.addStone(ring.id, { stoneType: "یاقوت", carat: "0.3", cost: 8_000_000 });

    const stones = await itemsService.listStones(ring.id);
    expect(stones).toHaveLength(2);
    expect(stones.map((s) => s.stoneType).sort()).toEqual(["الماس", "یاقوت"].sort());
  });

  it("refuses a stone on a non-weight-tracked item", async () => {
    const simple = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر" });
    await expect(
      itemsService.addStone(simple.id, { stoneType: "الماس", carat: "0.5", cost: 20_000_000 }),
    ).rejects.toThrow();
  });

  it("sums an item's stone costs, and treats no stones as zero", async () => {
    const ring = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر",
      tracking: "weight",
    });
    expect(await itemsService.totalStoneCost(ring.id)).toBe(0);

    await itemsService.addStone(ring.id, { stoneType: "الماس", carat: "0.5", cost: 20_000_000 });
    await itemsService.addStone(ring.id, { stoneType: "یاقوت", carat: "0.3", cost: 8_000_000 });
    expect(await itemsService.totalStoneCost(ring.id)).toBe(28_000_000);
  });

  it("removes a stone", async () => {
    const ring = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر",
      tracking: "weight",
    });
    const stone = await itemsService.addStone(ring.id, {
      stoneType: "الماس",
      carat: "0.5",
      cost: 20_000_000,
    });
    const removed = await itemsService.removeStone(stone.id, ring.id);
    expect(removed).toBe(true);
    expect(await itemsService.listStones(ring.id)).toHaveLength(0);
  });

  it("refuses to remove a stone from the wrong item (parent-child scoping)", async () => {
    const ring = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر",
      tracking: "weight",
    });
    const otherRing = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر دوم",
      tracking: "weight",
    });
    const stone = await itemsService.addStone(ring.id, {
      stoneType: "الماس",
      carat: "0.5",
      cost: 20_000_000,
    });

    const removed = await itemsService.removeStone(stone.id, otherRing.id);
    expect(removed).toBe(false);
    // The actual owner's stone is untouched.
    const stones = await itemsService.listStones(ring.id);
    expect(stones.map((s) => s.id)).toContain(stone.id);
  });

  it("leaving net_weight untouched: adding a stone does not change item_weight_attributes", async () => {
    const ring = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر",
      tracking: "weight",
    });
    await itemsService.setWeightAttributes(ring.id, { purity: "18", grossWeight: "5", netWeight: "4.5" });
    await itemsService.addStone(ring.id, { stoneType: "الماس", carat: "0.5", cost: 20_000_000 });

    const attrs = await itemsService.getWeightAttributes(ring.id);
    expect(attrs?.netWeight).toBe("4.500000000");
  });
});
