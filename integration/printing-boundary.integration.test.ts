/**
 * The printing boundary, against a real database (issue #815: tenant/branch
 * isolation, server-side loading and authorization of persisted documents).
 *
 * The unit tests pin *what* the loaders answer; this file pins the fact that
 * the answer is enforced by the database, on real rows, for the two boundaries
 * that actually exist in production:
 *
 *   - **branch** — one business, several locations. «فعالیت اخیر», the POS and
 *     the label screen all print for the caller's active branch only, so a
 *     reference to a sibling branch's sale, or a hand-edited `printerId` /
 *     `templateId` naming a sibling's hardware or layout, must not resolve;
 *   - **tenant** — two businesses. A reference (or an id) that leaked out of
 *     one tenant is a dead id inside the other, because every loader filters
 *     by `location_id` and RLS backs that up underneath.
 *
 * The positive half matters as much as the refusals: each branch prints its
 * OWN sale and label from those same rows. A test that only proved "returns
 * nothing" would also pass against an endpoint that is simply broken.
 *
 * Every read goes through the app pool connected as the deployment's
 * restricted runtime role (NOSUPERUSER/NOBYPASSRLS), so the row level security
 * underneath is enforced exactly as it is in production — a superuser
 * connection would bypass it and prove nothing.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, NextRequest } from "next/server";
import { Client } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";

const activeAuthContext = {
  businessId: "",
  locationId: "",
  role: "cashier",
  sub: "user-integration-1",
};

const capturedRenderedHtml: string[] = [];

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(async () => ({
      session: {
        businessId: activeAuthContext.businessId,
        sub: activeAuthContext.sub,
        role: activeAuthContext.role,
      },
      error: null,
    })),
    withTenantScope:
      (handler: (...args: unknown[]) => Promise<NextResponse>) =>
      async (...args: unknown[]) => {
        const dbMod = await import("../src/lib/db");
        return dbMod.withTenant(activeAuthContext.businessId, () => handler(...args));
      },
  };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/setup-state")>();
  return {
    ...actual,
    resolveActiveLocation: vi.fn(async () =>
      activeAuthContext.locationId ? { id: activeAuthContext.locationId } : null,
    ),
  };
});

vi.mock("@/lib/printing/chromium", () => ({
  renderHtmlToPng: vi.fn(async (html: string) => {
    capturedRenderedHtml.push(html);
    return sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }),
}));

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const roleName = "pos_printing_boundary";
const rolePassword = "printing_boundary_test_only";

let databaseName: string;
/** Fixtures and inspection: the database owner. */
let db: Client;
/** The runtime pool the application itself uses. */
let dbLib: typeof import("../src/lib/db");
/**
 * The deployment's restricted runtime role, on its own connection — the true
 * RLS boundary (a superuser ignores row level security; this role cannot).
 */
let appClient: Client;
/**
 * Whether that role really is unprivileged on this database.
 *
 * In CI it is, so the cross-tenant read below is proven. On the PGlite
 * wire-server fallback (`scripts/pglite-wire-server.mjs`) every connection is
 * served by one embedded Postgres superuser whatever role the URL names, so
 * that single assertion says why it is skipped instead of passing vacuously —
 * the policy assertions and every service-level assertion still run.
 */
let rlsActive = false;
let loader: typeof import("../src/lib/printing/document-loader");
let plan: typeof import("../src/lib/printing/plan");
let labels: typeof import("../src/lib/printing/label-print-data");
let templates: typeof import("../src/lib/print-templates-service");
let printRoute: typeof import("../src/app/api/printing/print/route");
let jobsRoute: typeof import("../src/app/api/printing/jobs/route");
let rulesRoute: typeof import("../src/app/api/settings/print-rules/route");

/** One tenant, one branch: what a request is scoped to. */
interface Branch {
  locationId: string;
  printerId: string;
}

const alphaMain: Branch = { locationId: "", printerId: "" };
const alphaOther: Branch = { locationId: "", printerId: "" };
const betaMain: Branch = { locationId: "", printerId: "" };

const alpha = { businessId: "" };
const beta = { businessId: "" };

/** Documents planted in a branch, so the other branches can be asked for them. */
const planted = {
  alphaMainOrderId: "",
  alphaOtherOrderId: "",
  betaOrderId: "",
  alphaOtherItemId: "",
  betaItemId: "",
  alphaMainTemplateId: "",
  betaTemplateId: "",
};

function urlFor(database: string, appRole = false): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (appRole) {
    url.username = roleName;
    url.password = rolePassword;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_printing_boundary_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName, password: rolePassword, quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  loader = await import("../src/lib/printing/document-loader");
  plan = await import("../src/lib/printing/plan");
  labels = await import("../src/lib/printing/label-print-data");
  templates = await import("../src/lib/print-templates-service");
  printRoute = await import("../src/app/api/printing/print/route");
  jobsRoute = await import("../src/app/api/printing/jobs/route");
  rulesRoute = await import("../src/app/api/settings/print-rules/route");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  appClient = new Client({ connectionString: urlFor(databaseName, true) });
  await appClient.connect();
  const { rows: privileged } = await appClient.query<{ privileged: boolean }>(
    "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
  );
  rlsActive = privileged[0]?.privileged === false;
}, 120_000);

afterAll(async () => {
  await dbLib?.closeDatabasePool().catch(() => {});
  await appClient?.end().catch(() => {});
  await db?.end();
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function seedBusiness(name: string, slug: string, branchNames: string[]) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'food_service') RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;
  const branches: Branch[] = [];
  for (const branchName of branchNames) {
    const location = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name, address, phone) VALUES ($1, $2, $3, $4) RETURNING id",
      [businessId, branchName, `نشانی ${branchName}`, "02100000000"],
    );
    const locationId = location.rows[0].id;
    // A canonical, usable receipt printer: one per branch, so the resolver has
    // something to choose and a cross-branch id has something to fail against.
    const printer = await db.query<{ id: string }>(
      `INSERT INTO printers (location_id, name, kind, connection, printer_class, paper, paper_width_mm, supports_drawer)
       VALUES ($1, $2, 'receipt', $3, 'thermal', 'thermal80', 80, true) RETURNING id`,
      [locationId, `چاپگر ${branchName}`, JSON.stringify({ type: "network", ip: "10.0.0.5", port: 9100 })],
    );
    branches.push({ locationId, printerId: printer.rows[0].id });
  }
  return { businessId, branches };
}

async function seedOrder(locationId: string, orderNumber: number, name: string, unitPrice: number) {
  // Opened, filled, then closed: a trigger refuses a line on a finished sale,
  // which is the same rule the till lives under.
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, subtotal, tax, total, opened_at)
     VALUES ($1, $2, 'takeaway', 'open', $3, 0, $3, now() - interval '1 hour')
     RETURNING id`,
    [locationId, orderNumber, unitPrice],
  );
  const orderId = order.rows[0].id;
  await db.query(
    `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
     VALUES ($1, $2, $3, $4, 1, 'served')`,
    [locationId, orderId, name, unitPrice],
  );
  await db.query(`UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1`, [orderId]);
  return orderId;
}

async function seedLabel(locationId: string, itemName: string, code: string) {
  const item = await db.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, $2, 'unit') RETURNING id",
    [locationId, itemName],
  );
  const itemId = item.rows[0].id;
  await db.query(
    "INSERT INTO inventory_item_barcodes (location_id, inventory_item_id, code, symbology) VALUES ($1, $2, $3, 'internal')",
    [locationId, itemId, code],
  );
  return itemId;
}

async function seedTemplate(businessId: string, locationId: string, name: string) {
  // Through the product's own write boundary, so a saved template here is one
  // the resolver can actually render.
  const saved = await dbLib.withTenant(businessId, () =>
    templates.createPrintTemplate({
      locationId,
      template: {
        name,
        docType: "receipt",
        paper: "thermal80",
        blocks: [
          { type: "businessName" },
          { type: "businessMeta" },
          { type: "text", text: name },
          { type: "items" },
          { type: "totals" },
        ],
      },
    }),
  );
  if (!saved.template) throw new Error(`template seed failed: ${saved.error}`);
  return saved.template.id;
}

beforeEach(async () => {
  // A settled sale's lines are immutable (guard_order_item_financial_mutation,
  // migration 0036), so the wipe takes the same transaction-local escape hatch
  // the confirmed factory reset takes — never a weakened guard.
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM print_jobs");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const seededAlpha = await seedBusiness("آلفا", `alpha-${randomUUID().slice(0, 8)}`, ["شعبهٔ مرکزی", "شعبهٔ دوم"]);
  alpha.businessId = seededAlpha.businessId;
  Object.assign(alphaMain, seededAlpha.branches[0]);
  Object.assign(alphaOther, seededAlpha.branches[1]);

  const seededBeta = await seedBusiness("بتا", `beta-${randomUUID().slice(0, 8)}`, ["شعبهٔ بتا"]);
  beta.businessId = seededBeta.businessId;
  Object.assign(betaMain, seededBeta.branches[0]);

  planted.alphaMainOrderId = await seedOrder(alphaMain.locationId, 1, "چای آلفا", 100_000);
  planted.alphaOtherOrderId = await seedOrder(alphaOther.locationId, 2, "قهوهٔ شعبهٔ دوم", 200_000);
  planted.betaOrderId = await seedOrder(betaMain.locationId, 3, "کیک بتا", 300_000);

  planted.alphaOtherItemId = await seedLabel(alphaOther.locationId, "آرد شعبهٔ دوم", "2000000000015");
  planted.betaItemId = await seedLabel(betaMain.locationId, "شکر بتا", "2000000000022");

  planted.alphaMainTemplateId = await seedTemplate(alpha.businessId, alphaMain.locationId, "قالب شعبهٔ مرکزی");
  planted.betaTemplateId = await seedTemplate(beta.businessId, betaMain.locationId, "قالب بتا");
});

describe("a print request cannot reach past the caller's branch", () => {
  it("prints its own branch's sale — the positive control", async () => {
    const result = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaMain.locationId,
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
        documentType: "receipt",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.entityId).toBe(planted.alphaMainOrderId);
    const receipt = (result.document.job as { type: string; receipt: { lines: { name: string }[]; business: { address: string | null } } }).receipt;
    expect(receipt.lines.map((line) => line.name)).toEqual(["چای آلفا"]);
    // …and the letterhead is the branch's own, not the tenant's first address.
    expect(receipt.business.address).toBe("نشانی شعبهٔ مرکزی");
  });

  it("refuses a SIBLING branch's sale, in the same business", async () => {
    const result = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaMain.locationId,
        document: { kind: "order-receipt", orderId: planted.alphaOtherOrderId },
        documentType: "receipt",
      }),
    );
    expect(result).toEqual({ ok: false, status: 404, error: "document_not_found" });

    // The same sale through its own branch loads — so the refusal above is
    // branch scoping, not a broken reader.
    const own = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaOther.locationId,
        document: { kind: "order-receipt", orderId: planted.alphaOtherOrderId },
        documentType: "receipt",
      }),
    );
    expect(own.ok).toBe(true);
  });

  it("refuses ANOTHER TENANT's sale, ticket and label", async () => {
    const sale = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaMain.locationId,
        document: { kind: "order-receipt", orderId: planted.betaOrderId },
        documentType: "invoice",
      }),
    );
    expect(sale).toEqual({ ok: false, status: 404, error: "document_not_found" });

    const ticket = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaMain.locationId,
        document: { kind: "kitchen-ticket", orderId: planted.betaOrderId },
        documentType: "kitchen",
      }),
    );
    expect(ticket).toEqual({ ok: false, status: 404, error: "document_not_found" });

    const label = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaMain.locationId,
        document: { kind: "item-label", itemId: planted.betaItemId },
        documentType: "label",
      }),
    );
    expect(label).toEqual({ ok: false, status: 404, error: "document_not_found" });
  });

  it("refuses a sibling branch's label even when the caller knows its code", async () => {
    // The code is unique per location, not per tenant, so naming it must not
    // widen the search.
    const row = await db.query<{ code: string }>(
      "SELECT code FROM inventory_item_barcodes WHERE inventory_item_id = $1",
      [planted.alphaOtherItemId],
    );
    const result = await dbLib.withTenant(alpha.businessId, () =>
      loader.loadPrintDocument({
        businessId: alpha.businessId,
        locationId: alphaMain.locationId,
        document: { kind: "item-label", itemId: planted.alphaOtherItemId, code: row.rows[0].code },
        documentType: "label",
      }),
    );
    expect(result).toEqual({ ok: false, status: 404, error: "document_not_found" });

    const own = await dbLib.withTenant(alpha.businessId, () =>
      labels.getLabelPrintData({
        businessId: alpha.businessId,
        locationId: alphaOther.locationId,
        itemId: planted.alphaOtherItemId,
        code: row.rows[0].code,
      }),
    );
    expect(own?.label.code).toBe(row.rows[0].code);
  });

  it("will not route to another branch's printer, however the id is named", async () => {
    // A sibling branch of the same business…
    const sibling = await dbLib.withTenant(alpha.businessId, () =>
      plan.resolvePrintPlan({
        locationId: alphaMain.locationId,
        documentType: "receipt",
        requestedPrinterId: alphaOther.printerId,
      }),
    );
    expect(sibling).toEqual({ ok: false, error: "printer_not_found" });

    // …and another tenant's.
    const foreign = await dbLib.withTenant(alpha.businessId, () =>
      plan.resolvePrintPlan({
        locationId: alphaMain.locationId,
        documentType: "receipt",
        requestedPrinterId: betaMain.printerId,
      }),
    );
    expect(foreign).toEqual({ ok: false, error: "printer_not_found" });

    // The branch's own printer still resolves.
    const own = await dbLib.withTenant(alpha.businessId, () =>
      plan.resolvePrintPlan({
        locationId: alphaMain.locationId,
        documentType: "receipt",
        requestedPrinterId: alphaMain.printerId,
      }),
    );
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.plan.printer.id).toBe(alphaMain.printerId);
  });

  it("will not render another branch's saved template", async () => {
    for (const templateId of [planted.betaTemplateId, planted.alphaMainTemplateId]) {
      const locationId = templateId === planted.betaTemplateId ? alphaMain.locationId : alphaOther.locationId;
      const result = await dbLib.withTenant(alpha.businessId, () =>
        plan.resolvePrintPlan({ locationId, documentType: "receipt", requestedTemplateId: templateId }),
      );
      expect(result, `template ${templateId} from ${locationId}`).toEqual({ ok: false, error: "template_not_found" });
    }

    const own = await dbLib.withTenant(alpha.businessId, () =>
      plan.resolvePrintPlan({
        locationId: alphaMain.locationId,
        documentType: "receipt",
        requestedTemplateId: planted.alphaMainTemplateId,
      }),
    );
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.plan.templateId).toBe(planted.alphaMainTemplateId);
  });
});

describe("the history table is branch-scoped underneath the routes", () => {
  it("carries RLS on every table the print path reads and writes", async () => {
    const { rows } = await db.query<{ relname: string; forced: boolean; policy: string | null }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced,
              (SELECT p.polname FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY p.polname LIMIT 1) AS policy
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [["print_jobs", "print_rules", "print_templates", "printers"]],
    );
    expect(rows.map((row) => row.relname)).toEqual(["print_jobs", "print_rules", "print_templates", "printers"]);
    for (const row of rows) {
      expect(row.forced, `${row.relname} must FORCE row level security`).toBe(true);
      expect(row.policy, `${row.relname} must carry a tenant policy`).toBe("tenant_isolation");
    }
  });

  it("shows a branch only its own attempts", async () => {
    // Two attempts in the sibling branch: one addressed by its own id, one
    // with no correlation id at all (the shape 0213 allows).
    await db.query(
      `INSERT INTO print_jobs (location_id, document_type, printer_id, status, print_request_id)
       VALUES ($1, 'receipt', $2, 'handed_off', 'receipt:sibling')`,
      [alphaOther.locationId, alphaOther.printerId],
    );
    await db.query(
      `INSERT INTO print_jobs (location_id, document_type, printer_id, status)
       VALUES ($1, 'receipt', $2, 'failed')`,
      [betaMain.locationId, betaMain.printerId],
    );
    await db.query(
      `INSERT INTO print_jobs (location_id, document_type, printer_id, status, print_request_id)
       VALUES ($1, 'receipt', $2, 'handed_off', 'receipt:mine')`,
      [alphaMain.locationId, alphaMain.printerId],
    );

    // The route's own read: `WHERE location_id = $1`. Run under the tenant
    // scope so RLS is exercised as the runtime role sees it too.
    const mine = await dbLib.withTenant(alpha.businessId, async () => {
      const { rows } = await dbLib.query<{ print_request_id: string | null; location_id: string }>(
        "SELECT print_request_id, location_id FROM print_jobs WHERE location_id = $1",
        [alphaMain.locationId],
      );
      return rows;
    });
    expect(mine).toEqual([{ print_request_id: "receipt:mine", location_id: alphaMain.locationId }]);

    // …and the tenant cannot read the other business's row even when it asks
    // for that branch's location directly, because RLS refuses it. This runs
    // on the deployment's restricted role, so a superuser owner connection
    // cannot make it pass vacuously.
    if (!rlsActive) {
      console.warn("skipping the cross-tenant print_jobs read: the test role is privileged (RLS bypassed)");
      return;
    }
    await appClient.query("SELECT set_config('app.business_id', $1, false)", [alpha.businessId]);
    await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
    const trespass = await appClient.query<{ id: string }>(
      "SELECT id FROM print_jobs WHERE location_id = $1",
      [betaMain.locationId],
    );
    expect(trespass.rows).toEqual([]);
    // The tenant's own attempt is still visible through the same role, so the
    // emptiness above is the policy and not a broken connection.
    const mineAsRole = await appClient.query<{ print_request_id: string | null }>(
      "SELECT print_request_id FROM print_jobs WHERE location_id = $1",
      [alphaMain.locationId],
    );
    expect(mineAsRole.rows).toEqual([{ print_request_id: "receipt:mine" }]);
  });

  it("resolves primary and fallback plans on real PostgreSQL rows and records both attempts in print_jobs", async () => {
    const backupPrinter = await db.query<{ id: string }>(
      `INSERT INTO printers (location_id, name, kind, printer_class, paper, paper_width_mm, is_active, connection)
       VALUES ($1, 'چاپگر پشتیبان صندوق', 'receipt', 'thermal', 'thermal80', 80, true, '{"type":"windows","systemName":"Backup-POS"}'::jsonb)
       RETURNING id`,
      [alphaMain.locationId],
    );
    const backupId = backupPrinter.rows[0].id;

    await db.query(
      `INSERT INTO print_rules (location_id, document_type, printer_id, fallback_printer_id, template_id)
       VALUES ($1, 'receipt', $2, $3, $4)
       ON CONFLICT (location_id, document_type) WHERE connection_id IS NULL DO UPDATE
         SET printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             template_id = EXCLUDED.template_id`,
      [alphaMain.locationId, alphaMain.printerId, backupId, planted.alphaMainTemplateId],
    );

    const primaryPlan = await dbLib.withTenant(alpha.businessId, () =>
      plan.resolvePrintPlan({
        locationId: alphaMain.locationId,
        documentType: "receipt",
      }),
    );
    expect(primaryPlan.ok).toBe(true);
    if (!primaryPlan.ok) return;
    expect(primaryPlan.plan.printer.id).toBe(alphaMain.printerId);
    expect(primaryPlan.plan.backupPrinter?.id).toBe(backupId);
    expect(primaryPlan.plan.reason).toBe("rule");
    expect(primaryPlan.plan.templateId).toBe(planted.alphaMainTemplateId);

    const fallbackPlan = await dbLib.withTenant(alpha.businessId, () =>
      plan.resolvePrintPlan({
        locationId: alphaMain.locationId,
        documentType: "receipt",
        failedPrinterId: alphaMain.printerId,
      }),
    );
    expect(fallbackPlan.ok).toBe(true);
    if (!fallbackPlan.ok) return;
    expect(fallbackPlan.plan.printer.id).toBe(backupId);
    expect(fallbackPlan.plan.fallbackPrinter?.id).toBe(alphaMain.printerId);
    expect(fallbackPlan.plan.reason).toBe("fallback");
    expect(fallbackPlan.plan.templateId).toBe(planted.alphaMainTemplateId);
    expect(fallbackPlan.plan.templateVersion).toBe(primaryPlan.plan.templateVersion);

    // Record attempt 1 (primary failed) and attempt 2 (fallback handed_off) under the same print_request_id:
    const reqId = "receipt:fallback-seq";
    const attempt1 = await db.query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id, document_type, printer_id, template_id, template_key, template_version, status, error_code, print_request_id)
       VALUES ($1, 'receipt', $2, $3, $4, $5, 'failed', 'printer_offline', $6)
       RETURNING id`,
      [
        alphaMain.locationId,
        primaryPlan.plan.printer.id,
        primaryPlan.plan.templateId,
        primaryPlan.plan.templateKey,
        primaryPlan.plan.templateVersion,
        reqId,
      ],
    );
    const attempt2 = await db.query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id, document_type, printer_id, template_id, template_key, template_version, status, handed_off_at, print_request_id)
       VALUES ($1, 'receipt', $2, $3, $4, $5, 'handed_off', now(), $6)
       RETURNING id`,
      [
        alphaMain.locationId,
        fallbackPlan.plan.printer.id,
        fallbackPlan.plan.templateId,
        fallbackPlan.plan.templateKey,
        fallbackPlan.plan.templateVersion,
        reqId,
      ],
    );
    expect(attempt1.rows[0].id).not.toBe(attempt2.rows[0].id);

    const history = await db.query<{ id: string; printer_id: string; status: string; error_code: string | null }>(
      `SELECT id, printer_id, status, error_code
         FROM print_jobs
        WHERE location_id = $1 AND print_request_id = $2
        ORDER BY created_at ASC`,
      [alphaMain.locationId, reqId],
    );
    expect(history.rows).toEqual([
      { id: attempt1.rows[0].id, printer_id: alphaMain.printerId, status: "failed", error_code: "printer_offline" },
      { id: attempt2.rows[0].id, printer_id: backupId, status: "handed_off", error_code: null },
    ]);
  });

  it("exercises actual /api/printing/print and /api/printing/jobs persistence, immutable fallback across concurrent DB edits, one-fallback limit, and ambiguous delivery refusal", async () => {
    activeAuthContext.businessId = alpha.businessId;
    activeAuthContext.locationId = alphaMain.locationId;
    capturedRenderedHtml.length = 0;

    const backupPrinter = await db.query<{ id: string }>(
      `INSERT INTO printers (location_id, name, kind, printer_class, paper, paper_width_mm, is_active, connection)
       VALUES ($1, 'چاپگر پشتیبان صندوق', 'receipt', 'thermal', 'thermal80', 80, true, '{"type":"windows","systemName":"Backup-POS"}'::jsonb)
       RETURNING id`,
      [alphaMain.locationId],
    );
    const backupId = backupPrinter.rows[0].id;

    await db.query(
      `INSERT INTO print_rules (location_id, document_type, printer_id, fallback_printer_id, template_id)
       VALUES ($1, 'receipt', $2, $3, $4)
       ON CONFLICT (location_id, document_type) WHERE connection_id IS NULL DO UPDATE
         SET printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             template_id = EXCLUDED.template_id`,
      [alphaMain.locationId, alphaMain.printerId, backupId, planted.alphaMainTemplateId],
    );

    const jsonReq = (body: unknown, method = "POST"): NextRequest =>
      ({
        json: async () => body,
        method,
        headers: { get: () => null },
      }) as unknown as NextRequest;

    // 1. Primary attempt via POST /api/printing/print:
    const reqId = `receipt:${planted.alphaMainOrderId}`;
    const primaryRes = await printRoute.POST(
      jsonReq({
        printRequestId: reqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(primaryRes.status).toBe(200);
    const primaryBody = (await primaryRes.json()) as {
      ok: boolean;
      jobId: string;
      attemptNumber: number;
      printerId: string;
      fallbackPrinterId: string | null;
      templateVersion: number;
      routeReason: string;
    };
    expect(primaryBody).toMatchObject({
      ok: true,
      attemptNumber: 1,
      printerId: alphaMain.printerId,
      fallbackPrinterId: backupId,
      templateVersion: 1,
      routeReason: "rule",
    });
    expect(capturedRenderedHtml).toHaveLength(1);
    const attempt1Html = capturedRenderedHtml[0];
    expect(attempt1Html).toContain("چای آلفا");
    expect(attempt1Html).toContain("قالب شعبهٔ مرکزی");

    // 2. Client reports pre-handoff non-delivery (printer_offline) via PATCH /api/printing/jobs:
    const patch1Res = await jobsRoute.PATCH(
      jsonReq({ jobId: primaryBody.jobId, status: "failed", errorCode: "printer_offline" }, "PATCH"),
    );
    expect(patch1Res.status).toBe(200);

    // 3. Concurrent database modifications BEFORE attempt 2 is requested:
    //    - mutate order item name & price in PostgreSQL (using factory_reset bypass for settled order trigger)
    //    - update the saved template in PostgreSQL (bumping version 1 -> 2 and changing custom text)
    //    - update the business name & branch address in PostgreSQL
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.factory_reset', 'true', true)");
    await db.query(
      `UPDATE order_items SET name_snapshot = 'آیتم دستکاری‌شده', unit_price = 999000 WHERE order_id = $1`,
      [planted.alphaMainOrderId],
    );
    await db.query(`UPDATE orders SET subtotal = 999000, total = 999000 WHERE id = $1`, [planted.alphaMainOrderId]);
    await db.query("COMMIT");

    await dbLib.withTenant(alpha.businessId, () =>
      templates.updatePrintTemplate({
        locationId: alphaMain.locationId,
        id: planted.alphaMainTemplateId,
        template: {
          name: "قالب نسخهٔ جدید ۲",
          docType: "receipt",
          paper: "thermal80",
          blocks: [{ type: "text", text: "متن تغییریافته در نسخهٔ ۲" }],
        },
      }),
    );
    await db.query(`UPDATE businesses SET name = 'آلفای تغییریافته' WHERE id = $1`, [alpha.businessId]);
    await db.query(`UPDATE locations SET address = 'نشانی تغییریافته' WHERE id = $1`, [alphaMain.locationId]);

    // Attempt 2 must restore PostgreSQL print_jobs.render_snapshot despite the edits above.

    // 4. Fallback attempt (attempt 2) via POST /api/printing/print:
    const fallbackRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: primaryBody.jobId,
        printRequestId: reqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(fallbackRes.status).toBe(200);
    const fallbackBody = (await fallbackRes.json()) as {
      ok: boolean;
      jobId: string;
      previousJobId: string | null;
      attemptNumber: number;
      printerId: string;
      printerName: string;
      fallbackFromPrinterId: string | null;
      fallbackFromPrinterName: string | null;
      templateId: string | null;
      templateVersion: number;
      routeReason: string;
      fallbackPrinterId: string | null;
    };
    expect(fallbackBody).toMatchObject({
      ok: true,
      attemptNumber: 2,
      previousJobId: primaryBody.jobId,
      printerId: backupId,
      printerName: "چاپگر پشتیبان صندوق",
      fallbackFromPrinterId: alphaMain.printerId,
      templateId: planted.alphaMainTemplateId,
      templateVersion: 1,
      routeReason: "runtime_fallback",
      fallbackPrinterId: null,
    });

    // Attempt 2 rendered the exact same HTML from attempt 1's snapshot (never reloading the mutated order/template/branding):
    expect(capturedRenderedHtml).toHaveLength(2);
    const attempt2Html = capturedRenderedHtml[1];
    expect(attempt2Html).toBe(attempt1Html);
    expect(attempt2Html).toContain("چای آلفا");
    expect(attempt2Html).not.toContain("آیتم دستکاری‌شده");
    expect(attempt2Html).not.toContain("متن تغییریافته در نسخهٔ ۲");
    expect(attempt2Html).not.toContain("نشانی تغییریافته");

    // 5. Close attempt 2 as handed_off via PATCH /api/printing/jobs:
    const patch2Res = await jobsRoute.PATCH(
      jsonReq({ jobId: fallbackBody.jobId, status: "handed_off" }, "PATCH"),
    );
    expect(patch2Res.status).toBe(200);

    // 6. Verify a 3rd attempt (second fallback) is refused with 409 (one-fallback limit):
    const thirdRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: backupId,
        previousJobId: primaryBody.jobId,
        printRequestId: reqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(thirdRes.status).toBe(409);

    // 7. Read linked history via GET /api/printing/jobs:
    const historyRes = await jobsRoute.GET();
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as { jobs: Array<Record<string, unknown>> };
    const opJobs = historyBody.jobs.filter((j) => j.printRequestId === reqId);
    expect(opJobs).toHaveLength(2);
    expect(opJobs[0]).toMatchObject({
      id: fallbackBody.jobId,
      attemptNumber: 2,
      previousJobId: primaryBody.jobId,
      routeReason: "runtime_fallback",
      deliveryOutcome: "handed_off",
      status: "handed_off",
      printerId: backupId,
      printerName: "چاپگر پشتیبان صندوق",
      fallbackFromPrinterId: alphaMain.printerId,
      templateId: planted.alphaMainTemplateId,
      templateName: "قالب شعبهٔ مرکزی",
      templateVersion: 1,
    });
    expect(opJobs[1]).toMatchObject({
      id: primaryBody.jobId,
      attemptNumber: 1,
      previousJobId: null,
      routeReason: "rule",
      deliveryOutcome: "not_delivered",
      status: "failed",
      errorCode: "printer_offline",
      printerId: alphaMain.printerId,
      templateId: planted.alphaMainTemplateId,
      templateName: "قالب شعبهٔ مرکزی",
      templateVersion: 1,
    });

    // 8. Verify that an ambiguous failure (print_failed) on a new operation refuses fallback server-side:
    const ambReqId = `receipt:amb-${planted.alphaMainOrderId}`;
    const ambPrimaryRes = await printRoute.POST(
      jsonReq({
        printRequestId: ambReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    const ambPrimary = (await ambPrimaryRes.json()) as { jobId: string };
    await jobsRoute.PATCH(
      jsonReq({ jobId: ambPrimary.jobId, status: "failed", errorCode: "print_failed" }, "PATCH"),
    );
    const ambFallbackRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: ambPrimary.jobId,
        printRequestId: ambReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(ambFallbackRes.status).toBe(409);
    expect(await ambFallbackRes.json()).toMatchObject({ ok: false, error: "job_timeout" });
  });

  it("enforces atomic fallback reservation under real PostgreSQL contention and validates pending, handed-off, missing, wrong-branch, missing-snapshot, and repeated reprint cases", async () => {
    activeAuthContext.businessId = alpha.businessId;
    activeAuthContext.locationId = alphaMain.locationId;
    capturedRenderedHtml.length = 0;

    const backupPrinter = await db.query<{ id: string }>(
      `INSERT INTO printers (location_id, name, kind, printer_class, paper, paper_width_mm, is_active, connection)
       VALUES ($1, 'چاپگر پشتیبان رقابت', 'receipt', 'thermal', 'thermal80', 80, true, '{"type":"windows","systemName":"Backup-Contention"}'::jsonb)
       RETURNING id`,
      [alphaMain.locationId],
    );
    const backupId = backupPrinter.rows[0].id;

    await db.query(
      `INSERT INTO print_rules (location_id, document_type, printer_id, fallback_printer_id, template_id)
       VALUES ($1, 'receipt', $2, $3, $4)
       ON CONFLICT (location_id, document_type) WHERE connection_id IS NULL DO UPDATE
         SET printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             template_id = EXCLUDED.template_id`,
      [alphaMain.locationId, alphaMain.printerId, backupId, planted.alphaMainTemplateId],
    );

    const jsonReq = (body: unknown, method = "POST"): NextRequest =>
      ({
        json: async () => body,
        method,
        headers: { get: () => null },
      }) as unknown as NextRequest;

    // A. Create primary attempt 1 via POST /api/printing/print:
    const raceReqId = `receipt:race-${planted.alphaMainOrderId}`;
    const primaryRes = await printRoute.POST(
      jsonReq({
        printRequestId: raceReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(primaryRes.status).toBe(200);
    const primaryBody = (await primaryRes.json()) as { jobId: string };

    // B. While attempt 1 is still pending ('sending'), fallback must be rejected with 409 fallback_parent_pending:
    const pendingRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: primaryBody.jobId,
        printRequestId: raceReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(pendingRes.status).toBe(409);
    expect(await pendingRes.json()).toMatchObject({ ok: false, error: "fallback_parent_pending" });

    // C. Close attempt 1 as confirmed pre-handoff non-delivery ('printer_offline'):
    const patchRes = await jobsRoute.PATCH(
      jsonReq({ jobId: primaryBody.jobId, status: "failed", errorCode: "printer_offline" }, "PATCH"),
    );
    expect(patchRes.status).toBe(200);

    // D. Deterministic real-PostgreSQL contention:
    // Hold a row-level FOR UPDATE lock on the parent print_jobs row using `db`
    // so both concurrent fallback requests pass `loadPriorAttemptForFallback`
    // (MVCC plain SELECT) and contend directly on `reserveFallbackJobRow`'s
    // `FOR UPDATE` + `ON CONFLICT (previous_job_id)` in PostgreSQL.
    const rendersBeforeRace = capturedRenderedHtml.length;
    await db.query("BEGIN");
    await db.query("SELECT id FROM print_jobs WHERE id = $1 FOR UPDATE", [primaryBody.jobId]);

    const fallbackPayload = {
      failedPrinterId: alphaMain.printerId,
      previousJobId: primaryBody.jobId,
      printRequestId: raceReqId,
      documentType: "receipt",
      document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
    };

    const req1Promise = printRoute.POST(jsonReq(fallbackPayload));
    const req2Promise = printRoute.POST(jsonReq(fallbackPayload));

    // Wait until both concurrent requests are blocked on the PostgreSQL row lock:
    let waitersObserved = 0;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const waiting = await appClient.query<{ count: number }>(
        `SELECT count(DISTINCT pid)::int AS count
           FROM pg_locks
          WHERE NOT granted`,
      );
      waitersObserved = waiting.rows[0]?.count ?? 0;
      if (waitersObserved >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waitersObserved).toBeGreaterThanOrEqual(2);

    // Release the barrier lock so both requests race in PostgreSQL:
    await db.query("ROLLBACK");

    const [res1, res2] = await Promise.all([req1Promise, req2Promise]);
    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const body1 = (await res1.json()) as Record<string, unknown>;
    const body2 = (await res2.json()) as Record<string, unknown>;
    const winner = res1.status === 200 ? body1 : body2;
    const loser = res1.status === 409 ? body1 : body2;

    expect(winner).toMatchObject({
      ok: true,
      attemptNumber: 2,
      previousJobId: primaryBody.jobId,
      printerId: backupId,
      routeReason: "runtime_fallback",
    });
    expect(typeof winner.dataBase64).toBe("string");
    expect((winner.dataBase64 as string).length).toBeGreaterThan(0);

    expect(loser).toMatchObject({
      ok: false,
      error: "fallback_already_reserved",
    });
    expect(loser.dataBase64).toBeUndefined();

    // Only the winning request rendered HTML:
    expect(capturedRenderedHtml.length - rendersBeforeRace).toBe(1);

    // Only one fallback row exists in PostgreSQL for this parent:
    const childRows = await db.query<{ id: string }>(
      "SELECT id FROM print_jobs WHERE previous_job_id = $1",
      [primaryBody.jobId],
    );
    expect(childRows.rows).toHaveLength(1);
    expect(childRows.rows[0].id).toBe(winner.jobId);

    // E. Retried / lost-response request for the same parent returns 409 without rendering:
    const retryRes = await printRoute.POST(jsonReq(fallbackPayload));
    expect(retryRes.status).toBe(409);
    const retryBody = (await retryRes.json()) as Record<string, unknown>;
    expect(retryBody).toMatchObject({ ok: false, error: "fallback_already_reserved" });
    expect(retryBody.dataBase64).toBeUndefined();
    expect(capturedRenderedHtml.length - rendersBeforeRace).toBe(1);

    // F. Handed-off parent is rejected with 409 job_timeout:
    const handedPrimaryRes = await printRoute.POST(
      jsonReq({
        printRequestId: `receipt:handed-${planted.alphaMainOrderId}`,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    const handedPrimary = (await handedPrimaryRes.json()) as { jobId: string };
    await jobsRoute.PATCH(jsonReq({ jobId: handedPrimary.jobId, status: "handed_off" }, "PATCH"));
    const handedFallbackRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: handedPrimary.jobId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(handedFallbackRes.status).toBe(409);
    expect(await handedFallbackRes.json()).toMatchObject({ ok: false, error: "job_timeout" });

    // G. Missing / wrong-branch / cross-tenant parent is rejected with 409 fallback_parent_not_found:
    const siblingJob = await db.query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id, document_type, entity_id, printer_id, status, error_code, delivery_outcome)
       VALUES ($1, 'receipt', $2, $3, 'failed', 'printer_offline', 'not_delivered')
       RETURNING id`,
      [alphaOther.locationId, planted.alphaMainOrderId, alphaOther.printerId],
    );
    const wrongBranchRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: siblingJob.rows[0].id,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(wrongBranchRes.status).toBe(409);
    expect(await wrongBranchRes.json()).toMatchObject({ ok: false, error: "fallback_parent_not_found" });

    // H. Missing render_snapshot on parent row is rejected with 409 fallback_snapshot_missing (never reloads mutable data):
    const noSnapPrimaryRes = await printRoute.POST(
      jsonReq({
        printRequestId: `receipt:nosnap-${planted.alphaMainOrderId}`,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    const noSnapPrimary = (await noSnapPrimaryRes.json()) as { jobId: string };
    await jobsRoute.PATCH(
      jsonReq({ jobId: noSnapPrimary.jobId, status: "failed", errorCode: "printer_offline" }, "PATCH"),
    );
    await db.query("UPDATE print_jobs SET render_snapshot = NULL WHERE id = $1", [noSnapPrimary.jobId]);

    const rendersBeforeNoSnap = capturedRenderedHtml.length;
    const noSnapFallbackRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: noSnapPrimary.jobId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(noSnapFallbackRes.status).toBe(409);
    expect(await noSnapFallbackRes.json()).toMatchObject({ ok: false, error: "fallback_snapshot_missing" });
    expect(capturedRenderedHtml.length).toBe(rendersBeforeNoSnap);

    // I. Intentional repeated reprints sharing print_request_id:
    // Two independent primary prints of the same order share `printRequestId`
    // (`receipt:${orderId}`). Both are recorded as attempt 1 (`previousJobId: null`),
    // and if the second reprint fails pre-handoff, its fallback attempt still succeeds!
    const sharedReprintReqId = `receipt:reprint-${planted.alphaMainOrderId}`;
    const reprint1Res = await printRoute.POST(
      jsonReq({
        printRequestId: sharedReprintReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    const reprint1 = (await reprint1Res.json()) as { jobId: string; attemptNumber: number; previousJobId: string | null };
    expect(reprint1).toMatchObject({ attemptNumber: 1, previousJobId: null });
    await jobsRoute.PATCH(jsonReq({ jobId: reprint1.jobId, status: "handed_off" }, "PATCH"));

    const reprint2Res = await printRoute.POST(
      jsonReq({
        printRequestId: sharedReprintReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    const reprint2 = (await reprint2Res.json()) as { jobId: string; attemptNumber: number; previousJobId: string | null };
    expect(reprint2).toMatchObject({ attemptNumber: 1, previousJobId: null });
    await jobsRoute.PATCH(
      jsonReq({ jobId: reprint2.jobId, status: "failed", errorCode: "printer_offline" }, "PATCH"),
    );

    const reprint2FallbackRes = await printRoute.POST(
      jsonReq({
        failedPrinterId: alphaMain.printerId,
        previousJobId: reprint2.jobId,
        printRequestId: sharedReprintReqId,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(reprint2FallbackRes.status).toBe(200);
    expect(await reprint2FallbackRes.json()).toMatchObject({
      ok: true,
      attemptNumber: 2,
      previousJobId: reprint2.jobId,
      routeReason: "runtime_fallback",
    });

    // J. Automatic routing vs configured-primary failover across PUT/GET /api/settings/print-rules and POST /api/printing/print:
    // 1) When the configured primary printer is deactivated, routing fails over to the configured fallback:
    await db.query("UPDATE printers SET is_active = false WHERE id = $1", [alphaMain.printerId]);
    const failoverRes = await printRoute.POST(
      jsonReq({
        printRequestId: `receipt:inactive-primary-${planted.alphaMainOrderId}`,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(failoverRes.status).toBe(200);
    expect(await failoverRes.json()).toMatchObject({
      ok: true,
      printerId: backupId,
      route: "fallback",
      routeReason: "fallback",
      fallbackFromPrinterId: alphaMain.printerId,
    });
    await db.query("UPDATE printers SET is_active = true, is_default = true WHERE id = $1", [alphaMain.printerId]);

    // 2) Switching fixed-primary -> automatic via PUT /api/settings/print-rules clears fallback_printer_id in PostgreSQL:
    const putAutoRes = await rulesRoute.PUT(
      jsonReq(
        {
          documentType: "receipt",
          templateId: planted.alphaMainTemplateId,
          printerId: null,
          fallbackPrinterId: backupId,
        },
        "PUT",
      ),
    );
    expect(putAutoRes.status).toBe(200);
    const persistedRule = await db.query<{ printer_id: string | null; fallback_printer_id: string | null }>(
      "SELECT printer_id, fallback_printer_id FROM print_rules WHERE location_id = $1 AND document_type = 'receipt'",
      [alphaMain.locationId],
    );
    expect(persistedRule.rows[0]).toEqual({ printer_id: null, fallback_printer_id: null });

    // 3) Even if an existing stale rule in PostgreSQL has printer_id = NULL and fallback_printer_id = backupId,
    // GET /api/settings/print-rules and POST /api/printing/print preserve automatic default selection:
    await db.query(
      "UPDATE print_rules SET printer_id = NULL, fallback_printer_id = $2 WHERE location_id = $1 AND document_type = 'receipt'",
      [alphaMain.locationId, backupId],
    );
    const getRulesRes = await rulesRoute.GET(new NextRequest("https://tenant.example/api/settings/print-rules"));
    expect(getRulesRes.status).toBe(200);
    const getRulesBody = (await getRulesRes.json()) as {
      rules: Array<{ document_type: string; printer_id: string | null; fallback_printer_id: string | null }>;
      resolved: Record<string, { ok: boolean; printerId?: string; route?: string }>;
    };
    const receiptRuleRow = getRulesBody.rules.find((r) => r.document_type === "receipt");
    expect(receiptRuleRow).toMatchObject({
      document_type: "receipt",
      printer_id: null,
      fallback_printer_id: null,
    });
    expect(getRulesBody.resolved.receipt).toMatchObject({
      ok: true,
      printerId: alphaMain.printerId,
      route: "default",
    });

    const autoPrintRes = await printRoute.POST(
      jsonReq({
        printRequestId: `receipt:auto-default-${planted.alphaMainOrderId}`,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: planted.alphaMainOrderId },
      }),
    );
    expect(autoPrintRes.status).toBe(200);
    expect(await autoPrintRes.json()).toMatchObject({
      ok: true,
      printerId: alphaMain.printerId,
      route: "default",
      routeReason: "default",
      fallbackFromPrinterId: null,
      fallbackPrinterId: null,
    });
  });
});

