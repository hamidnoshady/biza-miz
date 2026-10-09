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
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";

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
      template: { name, docType: "receipt", paper: "thermal80", blocks: [{ type: "text", text: name }] },
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
});
