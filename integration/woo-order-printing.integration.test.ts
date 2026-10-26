/** #935: real PostgreSQL/RLS and routes; only Chromium/hardware is stubbed here. */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { PNG } from "pngjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";
import { wooPayload } from "../src/lib/printing/__fixtures__/woo-order";

const active = { businessId: "", locationId: "", sub: "", denied: "" };
const html: string[] = [];
vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(async (permission: string) => active.denied === permission
    ? { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) }
    : { session: { businessId: active.businessId, sub: active.sub, role: "owner" }, error: null }),
  withTenantScope: (handler: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
    const db = await import("../src/lib/db");
    return db.withTenant(active.businessId, () => handler(...args));
  },
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn(async () => ({ id: active.locationId })) }));
vi.mock("@/lib/printing/chromium", async original => ({
  ...await original<typeof import("../src/lib/printing/chromium")>(),
  renderHtmlToPng: vi.fn(async (value: string) => { html.push(value); return PNG.sync.write(new PNG({ width: 8, height: 8 })); }),
}));

const rootUrl = process.env.DATABASE_URL!;
const name = `pos_woo_print_${randomUUID().replaceAll("-", "")}`;
const role = "pos_woo_print_runtime";
function url(database: string, runtime = false) {
  const value = new URL(rootUrl); value.pathname = `/${database}`;
  if (runtime) { value.username = role; value.password = "test-only"; }
  return value.toString();
}
let owner: Client;
let db: typeof import("../src/lib/db");
let print: typeof import("../src/app/api/printing/print/route");
let preview: typeof import("../src/app/api/printing/preview/route");
let detail: typeof import("../src/app/api/integrations/connections/[id]/store/orders/[remoteId]/route");
let jobs: typeof import("../src/app/api/printing/jobs/route");
let rules: typeof import("../src/app/api/settings/print-rules/route");
let templates: typeof import("../src/lib/print-templates-service");
let plan: typeof import("../src/lib/printing/plan");
interface Store { business: string; location: string; connection: string; revision: string; label: string; invoice: string; }
let main: Store, sibling: Store, foreign: Store;
const request = (body: unknown, method = "POST") => new NextRequest("https://tenant.example/api/printing/print", { method, body: JSON.stringify(body) });
const ref = (store: Store, invoice = false) => ({ kind: invoice ? "woo-order-invoice" : "woo-order-shipping-label", connectionId: store.connection, remoteId: "1042", snapshotId: store.revision });
const detailContext = (store: Store) => ({ params: Promise.resolve({ id: store.connection, remoteId: "1042" }) });
let info: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  if (!rootUrl) throw new Error("DATABASE_URL required");
  vi.stubEnv("JWT_SECRET", "woo-print-db-throwaway-secret-0123456789abcdef");
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${name}"`); await maintenance.end();
  await runMigrations({ databaseUrl: url(name), quiet: true });
  await createAppRole({ databaseUrl: url(name), roleName: role, password: "test-only", quiet: true });
  process.env.DATABASE_URL = url(name, true);
  owner = new Client({ connectionString: url(name) }); await owner.connect();
  db = await import("../src/lib/db");
  print = await import("../src/app/api/printing/print/route");
  preview = await import("../src/app/api/printing/preview/route");
  detail = await import("../src/app/api/integrations/connections/[id]/store/orders/[remoteId]/route");
  jobs = await import("../src/app/api/printing/jobs/route");
  rules = await import("../src/app/api/settings/print-rules/route");
  templates = await import("../src/lib/print-templates-service");
  plan = await import("../src/lib/printing/plan");
}, 120_000);

afterAll(async () => {
  info?.mockRestore();
  await db?.closeDatabasePool(); await owner?.end(); process.env.DATABASE_URL = rootUrl;
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await maintenance.end();
});

async function seed(business?: string): Promise<Store> {
  business ??= (await owner.query("INSERT INTO businesses (name, slug, industry) VALUES ('فروشگاه', $1, 'food_service') RETURNING id", [`woo-${randomUUID()}`])).rows[0].id;
  // Woo printing is an integration capability; grant it explicitly in this
  // integration fixture rather than depending on the platform default.
  await owner.query(`INSERT INTO business_features (business_id, flag_key, enabled)
    VALUES ($1, 'integrations', true)
    ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = true`, [business]);
  const location = (await owner.query("INSERT INTO locations (business_id, name, address, phone) VALUES ($1, 'شعبه', 'نشانی فرستنده', '02100000000') RETURNING id", [business])).rows[0].id;
  const connection = (await owner.query(`INSERT INTO integration_connections (business_id, location_id, name, base_url, link_mode, link_token_hash, link_token_ciphertext, webhook_secret_ciphertext, currency_unit)
    VALUES ($1, $2, 'فروشگاه منبع', 'https://store.example', 'plugin', $3, 'encrypted', 'encrypted', 'toman') RETURNING id`, [business, location, randomUUID()])).rows[0].id;
  const revision = (await owner.query(`INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
    VALUES ($1, $2, 'order.created', '1042', $3, $4, 'pending') RETURNING id`, [business, connection, randomUUID(), JSON.stringify(wooPayload())])).rows[0].id;
  const printer = async (kind: string, paper: string, printerClass: string) => (await owner.query(`INSERT INTO printers (location_id, name, kind, connection, paper, printer_class, is_active)
    VALUES ($1, $2, $6, $3, $4, $5, true) RETURNING id`, [location, `Driver ${kind}`, JSON.stringify({ type: "windows", systemName: `Driver ${kind}` }), paper, printerClass, kind])).rows[0].id;
  return { business: business!, location, connection, revision, label: await printer("label", "label100x150", "label"), invoice: await printer("document", "a4", "page") };
}
beforeEach(async () => {
  await owner.query("DELETE FROM print_jobs; DELETE FROM businesses");
  main = await seed(); sibling = await seed(main.business); foreign = await seed();
  const staff = (await owner.query("INSERT INTO users (business_id, full_name, role, pin_hash) VALUES ($1, 'چاپ‌کننده', 'owner', 'test-only') RETURNING id", [main.business])).rows[0].id;
  Object.assign(active, { businessId: main.business, locationId: main.location, sub: staff, denied: "" });
  html.length = 0; info.mockClear();
});

async function counts() {
  return (await owner.query(`SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM payments) AS payments,
    (SELECT count(*)::int FROM journal_entries) AS journals, (SELECT count(*)::int FROM stock_movements) AS stock,
    (SELECT count(*)::int FROM integration_outbox_events) AS operations, (SELECT count(*)::int FROM integration_mappings) AS mappings`)).rows[0];
}

describe("Woo print-only API against PostgreSQL with restricted RLS runtime role", () => {
  it("prints independent remote-only COD label/invoice jobs with exact money, immutable revision, encrypted data and actor provenance; makes zero business mutations", async () => {
    const before = await counts();
    const label = await print.POST(request({ document: ref(main), printRequestId: "label-1" }));
    const invoice = await print.POST(request({ document: ref(main, true), printRequestId: "invoice-1" }));
    expect(label.status).toBe(200); expect(invoice.status).toBe(200);
    expect(await label.json()).toMatchObject({ pageGeometry: { widthMm: 100, heightMm: 150 } });
    expect(await invoice.json()).toMatchObject({ pageGeometry: { widthMm: 210, heightMm: 297 } });
    expect(await counts()).toEqual(before);
    const result = await owner.query("SELECT * FROM print_jobs ORDER BY created_at");
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row).toMatchObject({ connection_id: main.connection, initiated_by: active.sub, document_ref: "1042", source_revision: main.revision, status: "sending", entity_id: `woo:${main.connection}:1042` });
      expect(JSON.stringify(row.render_snapshot)).not.toContain("09121234567");
      expect(row.render_snapshot.job.type).toBe("woo-order-sealed");
    }
    expect(html[1]).toContain("۲۴٫۴۵ USD");
    expect(html[1]).toContain("غیرمالیاتی");
    expect(JSON.stringify(info.mock.calls)).not.toContain("سارا");
    expect(JSON.stringify(info.mock.calls)).not.toContain("09121234567");
  });

  it("returns authorized details/history and keeps previews side-effect-free", async () => {
    const before = await counts();
    const shown = await detail.GET(new NextRequest("https://tenant.example/detail"), detailContext(main));
    expect(shown.status).toBe(200);
    expect((await shown.json()).detail).toMatchObject({ snapshotId: main.revision, localOrderId: null, order: { paid: "0", total: "24.45" } });
    const image = await preview.POST(request({ document: ref(main), templateKey: "woo-shipping-100x150" }));
    expect(image.status).toBe(200);
    expect((await owner.query("SELECT count(*)::int AS n FROM print_jobs")).rows[0].n).toBe(0);
    expect(await counts()).toEqual(before);
    await print.POST(request({ document: ref(main, true), printRequestId: "history" }));
    const history = await jobs.GET();
    expect((await history.json()).jobs[0]).toMatchObject({ connectionId: main.connection, initiatedBy: active.sub, sourceRevision: main.revision, documentRef: "1042", printRequestId: "history" });
  });

  it("denies guessed sibling-branch and foreign-tenant store identities on detail, preview and print", async () => {
    for (const store of [sibling, foreign]) {
      expect((await detail.GET(new NextRequest("https://tenant.example/detail"), detailContext(store))).status).toBe(404);
      expect((await preview.POST(request({ document: ref(store) }))).status).toBe(404);
      expect((await print.POST(request({ document: ref(store) }))).status).toBe(404);
    }
    expect(html).toHaveLength(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM print_jobs")).rows[0].n).toBe(0);
  });

  it("cannot use another store's revision, printer or template even when ids are known", async () => {
    expect((await print.POST(request({ document: { ...ref(main), snapshotId: sibling.revision } }))).status).toBe(404);
    expect((await print.POST(request({ document: ref(main), printerId: sibling.label }))).status).toBe(404);
    const saved = await db.withTenant(foreign.business, () => templates.createPrintTemplate({ locationId: foreign.location, template: { name: "خصوصی", docType: "shipping_label", paper: "label100x150", blocks: [{ type: "receiver" }] } }));
    expect(saved.template).toBeTruthy();
    expect((await print.POST(request({ document: ref(main), templateId: saved.template!.id }))).status).toBe(404);
    expect(html).toHaveLength(0);
  });

  it.each(["printing.execute", "woocommerce.view"])("denies revoked %s on both initial print and preview", async permission => {
    active.denied = permission;
    expect((await print.POST(request({ document: ref(main) }))).status).toBe(403);
    expect((await preview.POST(request({ document: ref(main) }))).status).toBe(403);
    expect(html).toHaveLength(0);
  });

  it("blocks incomplete recipient labels but still prints their independent invoice", async () => {
    await owner.query("UPDATE integration_webhook_events SET payload = $2 WHERE id = $1", [main.revision, JSON.stringify(wooPayload({ shipping: {} }))]);
    expect((await print.POST(request({ document: ref(main) }))).status).toBe(409);
    expect((await preview.POST(request({ document: ref(main) }))).status).toBe(409);
    expect((await print.POST(request({ document: ref(main, true) }))).status).toBe(200);
    expect((await owner.query("SELECT document_type FROM print_jobs")).rows).toEqual([{ document_type: "woo_invoice" }]);
  });

  it("uses the chosen stored revision after a newer source snapshot arrives, and does not silently reload it", async () => {
    await owner.query(`INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status, created_at)
      VALUES ($1, $2, 'order.updated', '1042', $3, $4, 'failed', now() + interval '1 minute')`, [main.business, main.connection, randomUUID(), JSON.stringify(wooPayload({ total: "999.99" }))]);
    expect((await print.POST(request({ document: ref(main, true) }))).status).toBe(200);
    expect(html[0]).toContain("۲۴٫۴۵ USD"); expect(html[0]).not.toContain("۹۹۹٫۹۹ USD");
    const shown = await detail.GET(new NextRequest("https://tenant.example/detail"), detailContext(main));
    expect((await shown.json()).detail.order.total).toBe("999.99");
  });

  it("atomically rejects duplicate in-flight submissions, while a completed intentional reprint is a new attempt", async () => {
    const [a, b] = await Promise.all([print.POST(request({ document: ref(main), printRequestId: "double-click" })), print.POST(request({ document: ref(main), printRequestId: "double-click" }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]); expect(html).toHaveLength(1);
    const first = await (a.status === 200 ? a : b).json();
    await jobs.PATCH(request({ jobId: first.jobId, status: "handed_off" }, "PATCH"));
    expect((await print.POST(request({ document: ref(main), printRequestId: "double-click" }))).status).toBe(200);
    expect((await owner.query("SELECT count(*)::int AS n FROM print_jobs")).rows[0].n).toBe(2);
  });

  it("resolves store → branch rules, explicit choices, saved revisions and same-paper fallback without changing generic invoice rules", async () => {
    const branch = await rules.PUT(request({ documentType: "shipping_label", printerId: main.label, templateKey: "woo-shipping-100x150" }, "PUT"));
    expect(branch.status).toBe(200);
    const backup = (await owner.query(`INSERT INTO printers (location_id, name, kind, connection, paper, printer_class) VALUES ($1, 'پشتیبان', 'label', $2, 'label100x150', 'label') RETURNING id`, [main.location, JSON.stringify({ type: "windows", systemName: "Backup" })])).rows[0].id;
    const saved = await db.withTenant(main.business, () => templates.createPrintTemplate({ locationId: main.location, template: { name: "قالب فروشگاه", docType: "shipping_label", paper: "label100x150", blocks: [{ type: "receiver" }] } }));
    expect(saved.template).toBeTruthy();
    const store = await rules.PUT(request({ connectionId: main.connection, documentType: "shipping_label", printerId: backup, fallbackPrinterId: main.label, templateId: saved.template!.id }, "PUT"));
    expect(store.status).toBe(200);
    const resolved = await db.withTenant(main.business, () => plan.resolvePrintPlan({ locationId: main.location, documentType: "shipping_label", connectionId: main.connection }));
    expect(resolved).toMatchObject({ ok: true, plan: { printer: { id: backup }, templateId: saved.template!.id, templateVersion: 1 } });
    const explicit = await db.withTenant(main.business, () => plan.resolvePrintPlan({ locationId: main.location, documentType: "shipping_label", connectionId: main.connection, requestedPrinterId: main.label, requestedTemplateKey: "woo-shipping-100x150" }));
    expect(explicit).toMatchObject({ ok: true, plan: { printer: { id: main.label }, templateKey: "woo-shipping-100x150" } });
    expect((await owner.query("SELECT count(*)::int AS n FROM print_rules WHERE document_type = 'invoice'")).rows[0].n).toBe(0);
    expect((await rules.PUT(request({ connectionId: foreign.connection, documentType: "shipping_label", printerId: main.label }, "PUT"))).status).toBe(404);
  });

  it("binds runtime fallback to the original encrypted data/template, and rechecks current store/branch permission", async () => {
    const backup = (await owner.query(`INSERT INTO printers (location_id, name, kind, connection, paper, printer_class) VALUES ($1, 'پشتیبان', 'document', $2, 'a4', 'page') RETURNING id`, [main.location, JSON.stringify({ type: "windows", systemName: "Backup" })])).rows[0].id;
    expect((await rules.PUT(request({ documentType: "woo_invoice", connectionId: main.connection, printerId: main.invoice, fallbackPrinterId: backup, templateKey: "woo-a4-invoice" }, "PUT"))).status).toBe(200);
    const first = await print.POST(request({ document: ref(main, true), printRequestId: "failover" })); expect(first.status).toBe(200);
    const firstJob = await first.json();
    await jobs.PATCH(request({ jobId: firstJob.jobId, status: "failed", errorCode: "printer_offline" }, "PATCH"));
    const fallback = { document: ref(main, true), printRequestId: "failover", failedPrinterId: main.invoice, previousJobId: firstJob.jobId };
    active.denied = "woocommerce.view"; expect((await print.POST(request(fallback))).status).toBe(403); active.denied = "";
    await owner.query("UPDATE integration_connections SET location_id = $2 WHERE id = $1", [main.connection, sibling.location]);
    expect((await print.POST(request(fallback))).status).toBe(404);
    await owner.query("UPDATE integration_connections SET location_id = $2 WHERE id = $1", [main.connection, main.location]);
    const second = await print.POST(request(fallback)); const secondBody = await second.json(); expect(second.status, JSON.stringify(secondBody)).toBe(200);
    expect(secondBody).toMatchObject({ printerId: backup, previousJobId: firstJob.jobId, attemptNumber: 2 });
    expect(html[0]).toBe(html[1]);
  });

  it("enforces tenant RLS on store rules and jobs using an actual NOSUPERUSER/NOBYPASSRLS app connection", async () => {
    await print.POST(request({ document: ref(main), printRequestId: "rls" }));
    const privilege = await db.withTenant(main.business, () => db.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"));
    expect(privilege.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const foreignRead = await db.withTenant(foreign.business, () => db.query("SELECT id FROM print_jobs")); expect(foreignRead.rows).toEqual([]);
    await expect(db.withTenant(main.business, () => db.query(`INSERT INTO print_rules (location_id, document_type, connection_id) VALUES ($1, 'shipping_label', $2)`, [main.location, foreign.connection]))).rejects.toMatchObject({ code: "42501" });
    await expect(db.withTenant(main.business, () => db.query(`INSERT INTO print_rules (location_id, document_type, connection_id) VALUES ($1, 'shipping_label', $2)`, [main.location, sibling.connection]))).rejects.toMatchObject({ code: "42501" });
  });

  it("expires Woo fallback data after 30 days without erasing audit metadata or unrelated POS snapshots", async () => {
    const { pruneExpiredWooSnapshots } = await import("../src/lib/printing/woo-history-service");
    const printed = await print.POST(request({ document: ref(main), printRequestId: "expiry" }));
    expect(printed.status).toBe(200);
    const printedJob = await printed.json();
    await owner.query("UPDATE print_jobs SET created_at = now() - interval '31 days' WHERE id = $1", [printedJob.jobId]);
    const expiredFallback = await print.POST(request({ document: ref(main), printRequestId: "expiry", previousJobId: printedJob.jobId, failedPrinterId: main.label }));
    expect(expiredFallback.status).toBe(409);
    expect((await expiredFallback.json()).error).toBe("fallback_parent_not_found");
    const before = await owner.query("SELECT initiated_by, connection_id, document_ref, template_key FROM print_jobs WHERE id = $1", [printedJob.jobId]);
    const pos = (await owner.query(`INSERT INTO print_jobs (location_id, document_type, status, render_snapshot, created_at) VALUES ($1, 'receipt', 'failed', '{"sentinel": true}', now() - interval '31 days') RETURNING id`, [main.location])).rows[0].id;
    // Store deletion nulls the FK, but must never turn expired Woo ciphertext into permanent history.
    const orphan = (await owner.query(`INSERT INTO print_jobs (location_id, document_type, connection_id, status, render_snapshot, created_at) VALUES ($1, 'woo_invoice', $2, 'failed', '{"job":{"type":"woo-order-sealed","ciphertext":"expired"}}', now() - interval '31 days') RETURNING id`, [foreign.location, foreign.connection])).rows[0].id;
    await owner.query("DELETE FROM integration_connections WHERE id = $1", [foreign.connection]);
    expect(await pruneExpiredWooSnapshots()).toBe(2);
    expect((await owner.query("SELECT connection_id, render_snapshot FROM print_jobs WHERE id = $1", [orphan])).rows[0]).toEqual({ connection_id: null, render_snapshot: null });
    expect((await owner.query("SELECT render_snapshot FROM print_jobs WHERE id = $1", [pos])).rows[0].render_snapshot).toEqual({ sentinel: true });
    const retained = await owner.query("SELECT initiated_by, connection_id, document_ref, template_key, render_snapshot FROM print_jobs WHERE id = $1", [printedJob.jobId]);
    expect(retained.rows[0]).toEqual({ ...before.rows[0], render_snapshot: null });
  });

});
