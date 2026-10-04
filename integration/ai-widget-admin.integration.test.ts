/**
 * Issue #799 §22 (Wave 10) — the platform's recommended AI widgets, against a
 * real PostgreSQL.
 *
 * `src/app/api/platform/ai/widgets/route.test.ts` proves the route's boundary
 * with mocks. What can only be proven with the schema in the way is §22's own
 * sentence — *super-admin should be able to provide recommended industry widgets
 * without preventing users from creating their own* — which is a statement about
 * two tables and their RLS policies:
 *
 *   * a recommendation written by the platform console is a
 *     `ai_widget_templates` row with `business_id IS NULL`, and it reaches
 *     exactly the industry it targets: `listRecommendedAiWidgets` offers it to
 *     that industry's tenants and to nobody else, and withholds it from a member
 *     who does not hold its permissions;
 *   * a template that asks for a permission key that does not exist has it
 *     dropped rather than stored, so the offer cannot become invisible;
 *   * **retiring is not deleting**: a disabled template keeps its row (and any
 *     widget that was created from it keeps its `template_id`), it simply stops
 *     being offered — the console's «بازنشسته کردن»;
 *   * **none of this touches a member's own widgets**: a hand-written
 *     `ai_widgets` row survives a platform save and a platform retire untouched,
 *     is not listed by the console's catalogue read (which only ever sees
 *     `business_id IS NULL`), and a tenant-scoped template is not editable
 *     through the platform path either.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Permission } from "../src/lib/permissions";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let widgets: typeof import("../src/lib/ai-widgets");
let admin: typeof import("../src/lib/ai-widget-admin");

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
  databaseName = `pos_ai_widget_admin_${randomUUID().replaceAll("-", "")}`;

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
  widgets = await import("../src/lib/ai-widgets");
  admin = await import("../src/lib/ai-widget-admin");

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

let seq = 0;

async function provisionBusiness(industry: "architecture_construction" | "food_service") {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار ویجت ${seq}`,
    ownerName: "مالک",
    email: `owner-widgets-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `widgets${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  return { businessId: result.businessId, ownerUserId: result.userId };
}

const ALL: ReadonlySet<Permission> = new Set<Permission>([
  "workspace.view",
  "workspace.approve",
  "ai.use",
  "ledger.view",
]);

function recommended(businessId: string, industry: string, permissions: ReadonlySet<Permission> = ALL) {
  return dbLib.withTenant(businessId, () => widgets.listRecommendedAiWidgets(industry, permissions));
}

describe("§22's recommended widgets", () => {
  it("offers a platform recommendation to its industry only, and withholds it by permission", async () => {
    const created = await admin.saveAiWidgetTemplate("admin-1", {
      name: `ویجت آزمون ${seq}`,
      description: "برای آزمون",
      industry: "architecture_construction",
      sourceApp: "workspace",
      prompt: "با ابزار list_upcoming_milestones نقاط عطف را بنویس.",
      outputFormat: "bullets",
      requiredPermissions: ["workspace.view"],
      width: 2,
      height: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const name = created.template.name;

    const stage = await db.query<{ business_id: string | null; created_by: string | null }>(
      `SELECT business_id, created_by FROM ai_widget_templates WHERE id = $1`,
      [created.template.id],
    );
    // A platform recommendation is a platform row, and it says who wrote it.
    expect(stage.rows[0].business_id).toBeNull();
    expect(stage.rows[0].created_by).toBe("platform:admin-1");

    const aec = await provisionBusiness("architecture_construction");
    const cafe = await provisionBusiness("food_service");
    expect((await recommended(aec.businessId, "architecture_construction")).map((w) => w.name)).toContain(name);
    expect((await recommended(cafe.businessId, "food_service")).map((w) => w.name)).not.toContain(name);

    // Withheld from someone without the permission, and offered again with it.
    const without = await recommended(aec.businessId, "architecture_construction", new Set(["ai.use"]));
    expect(without.map((w) => w.name)).not.toContain(name);
  });

  it("drops a permission key that does not exist rather than storing it", async () => {
    const created = await admin.saveAiWidgetTemplate("admin-1", {
      name: `ویجت مجوز ${seq}`,
      industry: "architecture_construction",
      prompt: "…",
      requiredPermissions: ["workspace.view", "not.a.permission"],
      width: 1,
      height: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The unknown key is gone and the known one stayed: a stored unknown key
    // would make the offer invisible to every member, which reads as a bug.
    expect(created.template.requiredPermissions).toEqual(["workspace.view"]);

    const readBack = await admin.listAiWidgetTemplates();
    expect(readBack.find((entry) => entry.id === created.template.id)?.requiredPermissions).toEqual([
      "workspace.view",
    ]);
  });

  it("retires a recommendation without deleting it, and never touches a member's own widget", async () => {
    const created = await admin.saveAiWidgetTemplate("admin-1", {
      name: `ویجت بازنشسته ${seq}`,
      industry: "architecture_construction",
      prompt: "با ابزار list_pending_rfis استعلام‌های بی‌پاسخ را بنویس.",
      requiredPermissions: ["workspace.view"],
      width: 2,
      height: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const { businessId, ownerUserId } = await provisionBusiness("architecture_construction");
    const offered = await recommended(businessId, "architecture_construction");
    const template = offered.find((entry) => entry.id === created.template.id)!;

    // A member takes the offer — the tenant side's own create path.
    const own = await dbLib.withTenant(businessId, () =>
      widgets.createAiWidget(
        businessId,
        ownerUserId,
        {
          name: template.name,
          description: template.description,
          sourceApp: template.sourceApp,
          projectId: null,
          prompt: template.prompt,
          outputFormat: template.outputFormat,
          requiredPermissions: template.requiredPermissions,
          width: template.defaultWidth,
          height: template.defaultHeight,
        },
        ALL,
      ),
    );
    // The provenance a recommendation leaves behind: `ai_widgets.template_id`
    // is what makes «بازنشسته کردن» a retire rather than a delete.
    await db.query(`UPDATE ai_widgets SET template_id = $2 WHERE id = $1`, [own.id, template.id]);

    // The platform retires it: the offer stops, the row and the provenance stay.
    const retired = await admin.setAiWidgetTemplateEnabled(created.template.id, false);
    expect(retired?.enabled).toBe(false);
    expect((await recommended(businessId, "architecture_construction")).map((w) => w.id)).not.toContain(
      created.template.id,
    );
    const still = await db.query<{ business_id: string | null }>(
      `SELECT business_id FROM ai_widget_templates WHERE id = $1`,
      [created.template.id],
    );
    expect(still.rowCount).toBe(1);
    expect(still.rows[0].business_id).toBeNull();

    // The member's widget is untouched — same row, same prompt, same provenance.
    const mine = await dbLib.withTenant(businessId, () =>
      widgets.getAiWidget(businessId, ownerUserId, own.id),
    );
    expect(mine?.name).toBe(template.name);
    expect(mine?.prompt).toBe(template.prompt);
    expect(mine?.templateId).toBe(created.template.id);

    // The console never lists a tenant's widgets: they are not its rows.
    const catalogue = await admin.listAiWidgetTemplates();
    expect(catalogue.every((entry) => entry.id !== own.id)).toBe(true);
  });

  it("refuses an unknown industry and an incomplete widget, and cannot edit a tenant template", async () => {
    const badIndustry = await admin.saveAiWidgetTemplate("admin-1", {
      name: "ویجت",
      industry: "restaurants_of_mars",
      prompt: "…",
    });
    expect(badIndustry).toEqual({ ok: false, error: "unknown_industry" });

    const incomplete = await admin.saveAiWidgetTemplate("admin-1", { industry: "all", name: "بی‌متن" });
    expect(incomplete).toEqual({ ok: false, error: "invalid_widget" });

    // A tenant-scoped template is not the platform's to edit or retire.
    const { businessId } = await provisionBusiness("architecture_construction");
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO ai_widget_templates (business_id, name, prompt, industry, created_by)
       VALUES ($1, 'ویجت کسب‌وکار', '…', 'architecture_construction', 'tenant') RETURNING id`,
      [businessId],
    );
    const tenantTemplateId = inserted.rows[0].id;
    expect(await admin.setAiWidgetTemplateEnabled(tenantTemplateId, false)).toBeNull();
    const update = await admin.saveAiWidgetTemplate("admin-1", {
      id: tenantTemplateId,
      name: "دست‌کاری‌شده",
      prompt: "…",
    });
    expect(update).toEqual({ ok: false, error: "template_not_found" });
    expect((await admin.listAiWidgetTemplates()).some((entry) => entry.id === tenantTemplateId)).toBe(false);
  });
});
