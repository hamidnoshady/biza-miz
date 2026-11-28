/**
 * #1567 P0 2.2–2.3 — per-category attribute templates for the fashion shop.
 *
 * Two doors share one rule (skip-existing, like the chart of accounts):
 *
 *   - provisioning a `fashion_apparel` business seeds the apparel preset
 *     into the new branch's own `item_attribute_definitions` rows — tenant
 *     data, editable and deletable like anything the shop typed itself;
 *   - applying a category template later inserts only the axes the branch
 *     does not already own, and never rewrites an edit.
 *
 * A non-fashion tenant seeds nothing: the catalog decides, not a hardcode.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let attributeService: typeof import("../src/lib/product-attributes-service");
let templates: typeof import("../src/lib/product-attribute-templates");

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

let seq = 0;

async function provision(industry: "fashion_apparel" | "wholesale") {
  seq += 1;
  return provisioning.provisionBusiness({
    businessName: `قالب ویژگی ${seq}`,
    ownerName: "مالک",
    email: `owner-attrtpl-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `attrtpl${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
}

async function definitionsOf(locationId: string): Promise<{ name: string; options: string[] }[]> {
  const { rows } = await db.query<{ name: string; options: string[] }>(
    "SELECT name, options FROM item_attribute_definitions WHERE location_id = $1 ORDER BY created_at, id",
    [locationId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_attr_tpl_${randomUUID().replaceAll("-", "")}`;
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
  provisioning = await import("../src/lib/business-provisioning");
  attributeService = await import("../src/lib/product-attributes-service");
  templates = await import("../src/lib/product-attribute-templates");

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

describe("fashion attribute templates at provisioning", () => {
  it("opens a new fashion shop's attribute master with the apparel preset", async () => {
    const tenant = await provision("fashion_apparel");
    const rows = await definitionsOf(tenant.locationId);
    const names = rows.map((row) => row.name);

    const apparel = templates.attributeTemplateByKey("fashion_apparel")!;
    for (const definition of apparel.attributes) {
      expect(names, definition.name).toContain(definition.name);
    }
    const sizes = rows.find((row) => row.name === "سایز");
    expect(sizes?.options).toEqual(["XS", "S", "M", "L", "XL", "XXL"]);
    // Preset rows are live definitions from day one — not a hidden template.
    const used = await db.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM item_attribute_definitions WHERE location_id = $1 AND is_active",
      [tenant.locationId],
    );
    expect(Number(used.rows[0].count)).toBe(apparel.attributes.length);
  });

  it("seeds nothing for an industry without a default template", async () => {
    const tenant = await provision("wholesale");
    const rows = await definitionsOf(tenant.locationId);
    expect(rows).toHaveLength(0);
  });
});

describe("applying a category template later", () => {
  it("inserts only what the branch does not own, and is idempotent on re-apply", async () => {
    const tenant = await provision("fashion_apparel");
    const before = await definitionsOf(tenant.locationId);

    const footwear = templates.attributeTemplateByKey("fashion_footwear")!;
    const first = await dbLib.withTenant(tenant.businessId, () =>
      dbLib.withTenantTransaction(
        tenant.businessId,
        (client) =>
          attributeService.applyAttributeTemplate(client as PoolClient, {
            locationId: tenant.locationId,
            template: footwear,
          }),
        { locationId: tenant.locationId },
      ),
    );
    // «رنگ», «جنسیت», «فصل» and «برند» already exist from the apparel seed;
    // only the footwear-specific axes are new.
    expect(first.created).toBe(
      footwear.attributes.filter(
        (definition) => !before.some((row) => row.name === definition.name),
      ).length,
    );
    expect(first.created).toBeGreaterThan(0);

    const second = await dbLib.withTenant(tenant.businessId, () =>
      dbLib.withTenantTransaction(
        tenant.businessId,
        (client) =>
          attributeService.applyAttributeTemplate(client as PoolClient, {
            locationId: tenant.locationId,
            template: footwear,
          }),
        { locationId: tenant.locationId },
      ),
    );
    expect(second).toEqual({ created: 0, skipped: footwear.attributes.length });

    const after = await definitionsOf(tenant.locationId);
    expect(after.length).toBe(before.length + first.created);
    // Shared axes were skipped, not duplicated or overwritten.
    const colorRows = after.filter((row) => row.name === "رنگ");
    expect(colorRows).toHaveLength(1);
    expect(colorRows[0].options).toEqual(before.find((row) => row.name === "رنگ")!.options);
  });

  it("never touches a definition the tenant has renamed — a rename is an edit", async () => {
    const tenant = await provision("fashion_apparel");
    await db.query(
      `UPDATE item_attribute_definitions SET name = 'سایز لباس'
        WHERE location_id = $1 AND name = 'سایز'`,
      [tenant.locationId],
    );

    const apparel = templates.attributeTemplateByKey("fashion_apparel")!;
    const result = await dbLib.withTenant(tenant.businessId, () =>
      dbLib.withTenantTransaction(
        tenant.businessId,
        (client) =>
          attributeService.applyAttributeTemplate(client as PoolClient, {
            locationId: tenant.locationId,
            template: apparel,
          }),
        { locationId: tenant.locationId },
      ),
    );
    // The renamed axis stays (skip-existing is by name); the plain «سایز»
    // axis the template offers is added back alongside it — predictable and
    // documented, never a silent overwrite of the tenant's own word.
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(apparel.attributes.length - 1);
    const rows = await definitionsOf(tenant.locationId);
    expect(rows.map((row) => row.name)).toContain("سایز لباس");
    expect(rows.map((row) => row.name)).toContain("سایز");
  });
});
