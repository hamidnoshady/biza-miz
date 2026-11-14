/**
 * ESH-146 / biza-miz#1304 — a submitted CMS café order becomes one POS order,
 * and staff approval decides whether the kitchen ever sees it.
 *
 * The properties only a real database can prove:
 *
 *  - `order.submitted` writes one `dine_in`/`takeaway` order through the shared
 *    mutation, priced from local menu records, on the token's table, sharing
 *    the visit session with any other order on it;
 *  - a replayed event (same or new delivery id) still produces one order, and
 *    `order.paid` later attaches the payment to the *same* order;
 *  - an unmappable line fails the whole basket instead of importing half of it;
 *  - a takeaway with a table token, or dine-in without one, is refused;
 *  - the order waits: nothing is enqueued for the kitchen until a staff member
 *    accepts it, accepting twice prints once, and rejecting queues a CMS state
 *    row while never dispatching.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { CmsOrder } from "../src/lib/cms/types";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));
vi.mock("@/lib/notification-events", () => ({ recordNotification: vi.fn() }));
vi.mock("@/lib/order-state-sync", () => ({ recordOrderState: vi.fn() }));

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let café: typeof import("../src/lib/cms/cafe-order-intake-service");
let approval: typeof import("../src/lib/cms/cafe-order-approval-service");
let qr: typeof import("../src/lib/table-qr-service");
let connections: typeof import("../src/lib/website/connection-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let ingest: typeof import("../src/lib/cms/order-ingest-service");

interface Tenant {
  businessId: string;
  locationId: string;
  tableId: string;
  token: string;
  connectionId: string;
  siteId: string;
  latteId: string;
  cakeId: string;
  latteRemoteId: string;
  cakeRemoteId: string;
}

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

async function createTenant(): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const created = await provisioning.provisionBusiness({
    businessName: `کافه ${suffix}`,
    ownerName: "مالک",
    email: `cafe-${suffix}@example.com`,
    password: "correct-horse-battery",
    industry: "food_service",
    // The payment path posts through the real ledger, so the tenant needs its
    // chart — the same one setup seeds.
    seedChartOfAccounts: true,
    completeSetup: true,
  });
  const businessId = created.businessId;

  const { rows: locRows } = await db.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at, id LIMIT 1",
    [businessId],
  );
  const locationId = locRows[0].id;

  const { rows: catRows } = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'نوشیدنی', 0) RETURNING id",
    [locationId],
  );
  const { rows: latte } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'لاته', 850000) RETURNING id",
    [locationId, catRows[0].id],
  );
  const { rows: cake } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'کیک', 420000) RETURNING id",
    [locationId, catRows[0].id],
  );

  const { rows: tableRows } = await db.query<{ id: string }>(
    "INSERT INTO dining_tables (location_id, name, status, is_active) VALUES ($1, 'میز ۱', 'free', true) RETURNING id",
    [locationId],
  );
  const tableId = tableRows[0].id;

  const siteId = `site-${suffix}`;
  const { rows: connRows } = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections
       (business_id, site_id, site_domain, base_url, api_key_ciphertext, status, sync_location_id)
     VALUES ($1, $2, $3, 'https://cms.example', 'x', 'active', $4)
     RETURNING id`,
    [businessId, siteId, `${suffix}.example`, locationId],
  );

  const latteRemoteId = `prod-latte-${suffix}`;
  const cakeRemoteId = `prod-cake-${suffix}`;
  for (const [remoteId, localId] of [
    [latteRemoteId, latte[0].id],
    [cakeRemoteId, cake[0].id],
  ] as const) {
    await db.query(
      `INSERT INTO website_product_map (business_id, connection_id, remote_id, local_kind, local_id, sync_enabled)
       VALUES ($1, $2, $3, 'menu_item', $4, true)`,
      [businessId, connRows[0].id, remoteId, localId],
    );
  }

  // Table QR — the only way a dine-in order may name its table.
  const issued = await dbLib.withTenant(businessId, () =>
    qr.ensureTableQrToken({ businessId, locationId, tableId, userId: null }),
  );
  const print = await dbLib.withTenant(businessId, () =>
    qr.tableQrPrintPayload({ businessId, locationId, tableId }),
  );
  if (!print) throw new Error(`token payload missing for ${issued.state.prefix}`);

  return {
    businessId,
    locationId,
    tableId,
    token: print.token,
    connectionId: connRows[0].id,
    siteId,
    latteId: latte[0].id,
    cakeId: cake[0].id,
    latteRemoteId,
    cakeRemoteId,
  };
}

function connectionFor(tenant: Tenant) {
  return dbLib.withTenant(tenant.businessId, () =>
    connections.getWebsiteConnectionRow(tenant.businessId, tenant.connectionId),
  );
}

interface OrderOptions {
  serviceMode?: "dine_in" | "takeaway" | null;
  tableToken?: string | null;
  status?: "pending" | "paid";
  lines?: { remoteProductId: string; quantity?: number }[];
  id?: string;
}

function cmsOrder(tenant: Tenant, opts: OrderOptions = {}): CmsOrder {
  const id = opts.id ?? `cms-${randomUUID()}`;
  const lines = opts.lines ?? [{ remoteProductId: tenant.latteRemoteId, quantity: 2 }];
  const total = lines.reduce((sum, line) => sum + (line.quantity ?? 1) * 850000, 0);
  return {
    id,
    reference: `REF-${id.slice(-6)}`,
    status: opts.status ?? "pending",
    product: lines[0].remoteProductId,
    quantity: lines[0].quantity ?? 1,
    unitPrice: 850000,
    total,
    currency: "IRR" as const,
    buyer: { name: "سارا", phone: "09120000000", note: null },
    serviceMode: opts.serviceMode === undefined ? "dine_in" : opts.serviceMode,
    tableToken: opts.tableToken === undefined ? tenant.token : opts.tableToken,
    items: lines.map((line, index) => ({
      lineId: `${id}-${index}`,
      productId: line.remoteProductId,
      quantity: line.quantity ?? 1,
      unitPrice: 850000,
      total: 850000 * (line.quantity ?? 1),
      modifierIds: [],
    })),
    paymentMethod: "online" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function intake(tenant: Tenant, order: ReturnType<typeof cmsOrder>) {
  const connection = await connectionFor(tenant);
  if (!connection) throw new Error("connection missing");
  return dbLib.withTenant(tenant.businessId, () => café.intakeSubmittedCafeOrder(connection, order));
}

async function decide(
  tenant: Tenant,
  orderId: string,
  decision: "accepted" | "rejected",
  reason?: string,
) {
  return dbLib.withTenant(tenant.businessId, () =>
    approval.decideCafeOrderApproval({
      businessId: tenant.businessId,
      locationId: tenant.locationId,
      orderId,
      decision,
      actor: { userId: null, role: "owner" },
      reason: reason ?? null,
    }),
  );
}

beforeAll(async () => {
  databaseName = `cafe_order_${randomUUID().replaceAll("-", "")}`;
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
  café = await import("../src/lib/cms/cafe-order-intake-service");
  approval = await import("../src/lib/cms/cafe-order-approval-service");
  qr = await import("../src/lib/table-qr-service");
  connections = await import("../src/lib/website/connection-service");
  ingest = await import("../src/lib/cms/order-ingest-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect().catch(() => {});
  await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await maintenance.end().catch(() => {});
}, 120_000);

describe("submitted café order → one POS order", () => {
  let tenant: Tenant;

  beforeEach(async () => {
    tenant = await createTenant();
  }, 120_000);

  it("writes a dine-in order on the token's table, priced locally, awaiting approval", async () => {
    const order = cmsOrder(tenant, {
      lines: [
        { remoteProductId: tenant.latteRemoteId, quantity: 2 },
        { remoteProductId: tenant.cakeRemoteId, quantity: 1 },
      ],
    });
    const result = await intake(tenant, order);
    expect(result.created).toBe(true);

    const { rows } = await db.query<{
      type: string;
      table_id: string;
      table_session_id: string;
      table_qr_token_id: string;
      origin: string;
      cms_order_id: string;
      website_approval_state: string;
      subtotal: string;
      total: string;
      status: string;
    }>(
      `SELECT type, table_id, table_session_id, table_qr_token_id, origin, cms_order_id,
              website_approval_state, subtotal::text, total::text, status
         FROM orders WHERE id = $1`,
      [result.orderId],
    );
    const row = rows[0];
    expect(row.type).toBe("dine_in");
    expect(row.table_id).toBe(tenant.tableId);
    expect(row.table_qr_token_id).toBeTruthy();
    expect(row.table_session_id).toBeTruthy();
    expect(row.origin).toBe("website");
    expect(row.cms_order_id).toBe(order.id);
    expect(row.website_approval_state).toBe("pending");
    // Priced from the local menu (8500 + 4200), never from the CMS snapshot.
    expect(row.subtotal).toBe("2120000");

    const { rows: items } = await db.query<{ menu_item_id: string; quantity: number }>(
      "SELECT menu_item_id, quantity FROM order_items WHERE order_id = $1 ORDER BY menu_item_id",
      [result.orderId],
    );
    // Sorted by menu item id: two lines created in one transaction can share a
    // `created_at`, so the link order is not a stable assertion.
    const byItem = new Map(items.map((item) => [item.menu_item_id, item.quantity]));
    expect(byItem.get(tenant.latteId)).toBe(2);
    expect(byItem.get(tenant.cakeId)).toBe(1);
    expect(items).toHaveLength(2);

    // Nothing for the kitchen yet.
    const { rows: dispatch } = await db.query(
      "SELECT 1 FROM kitchen_dispatch_jobs WHERE order_id = $1",
      [result.orderId],
    );
    expect(dispatch).toHaveLength(0);
  });

  it("a replayed event, and a second delivery of it, resolve to the same order", async () => {
    const order = cmsOrder(tenant);
    const first = await intake(tenant, order);
    const again = await intake(tenant, order);
    expect(again.orderId).toBe(first.orderId);
    expect(again.created).toBe(false);

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE cms_connection_id = $1 AND cms_order_id = $2",
      [tenant.connectionId, order.id],
    );
    expect(rows[0].count).toBe("1");
  });

  it("a takeaway order may not carry a table token", async () => {
    await expect(intake(tenant, cmsOrder(tenant, { serviceMode: "takeaway" }))).rejects.toThrow(
      "table_token_not_allowed",
    );
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE location_id = $1 AND origin = 'website'",
      [tenant.locationId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("dine-in without a token is refused", async () => {
    await expect(
      intake(tenant, cmsOrder(tenant, { serviceMode: "dine_in", tableToken: null })),
    ).rejects.toThrow("table_token_required");
  });

  it("one unmappable line fails the whole basket — no partial order", async () => {
    const order = cmsOrder(tenant, {
      lines: [
        { remoteProductId: tenant.latteRemoteId, quantity: 1 },
        { remoteProductId: "prod-not-mapped", quantity: 1 },
      ],
    });
    await expect(intake(tenant, order)).rejects.toThrow("product_not_mapped:prod-not-mapped");
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE location_id = $1 AND origin = 'website'",
      [tenant.locationId],
    );
    expect(rows[0].count).toBe("0");
  });

  describe("staff decision", () => {
    it("accept dispatches the exact line set once, and only after approval", async () => {
      const { orderId } = await intake(tenant, cmsOrder(tenant));
      const first = await decide(tenant, orderId, "accepted");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.changed).toBe(true);
      expect(first.dispatchedItemIds).toHaveLength(1);

      const { rows } = await db.query<{ item_ids: string[]; idempotency_key: string }>(
        "SELECT item_ids, idempotency_key FROM kitchen_dispatch_jobs WHERE order_id = $1",
        [orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].item_ids).toEqual(first.dispatchedItemIds);

      const second = await decide(tenant, orderId, "accepted");
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.changed).toBe(false);
      const { rows: after } = await db.query("SELECT 1 FROM kitchen_dispatch_jobs WHERE order_id = $1", [orderId]);
      expect(after).toHaveLength(1);
    });

    it("reject never dispatches, records the reason and queues one CMS state row", async () => {
      const { orderId } = await intake(tenant, cmsOrder(tenant));
      const result = await decide(tenant, orderId, "rejected", "تمام شد");
      expect(result.ok).toBe(true);

      const { rows: dispatch } = await db.query("SELECT 1 FROM kitchen_dispatch_jobs WHERE order_id = $1", [orderId]);
      expect(dispatch).toHaveLength(0);

      const { rows: orderRows } = await db.query<{ website_approval_state: string; website_approval_reason: string }>(
        "SELECT website_approval_state, website_approval_reason FROM orders WHERE id = $1",
        [orderId],
      );
      expect(orderRows[0]).toEqual({
        website_approval_state: "rejected",
        website_approval_reason: "تمام شد",
      });

      const { rows: outbox } = await db.query<{ state: string; reason: string; delivered_at: string | null }>(
        "SELECT state, reason, delivered_at FROM cms_order_state_outbox WHERE pos_order_id = $1",
        [orderId],
      );
      expect(outbox).toEqual([{ state: "rejected", reason: "تمام شد", delivered_at: null }]);
    });

    it("a rejection needs a reason, and a decided order cannot be flipped", async () => {
      const { orderId } = await intake(tenant, cmsOrder(tenant));
      const noReason = await decide(tenant, orderId, "rejected");
      expect(noReason.ok).toBe(false);

      await decide(tenant, orderId, "accepted");
      const flip = await decide(tenant, orderId, "rejected", "دیر شد");
      expect(flip.ok).toBe(false);
      if (!flip.ok) expect(flip.error).toBe("already_decided");
    });
  });

  it("order.paid attaches one payment to the same order — never a second sale", async () => {
    const submitted = cmsOrder(tenant);
    const { orderId } = await intake(tenant, submitted);
    const connection = await connectionFor(tenant);
    if (!connection) throw new Error("connection missing");

    const paid = { ...submitted, status: "paid" as const };
    const first = await dbLib.withTenant(tenant.businessId, () =>
      café.attachCafeOrderPayment(connection, paid, orderId),
    );
    const second = await dbLib.withTenant(tenant.businessId, () =>
      café.attachCafeOrderPayment(connection, paid, orderId),
    );
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const { rows: orders } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE cms_connection_id = $1 AND cms_order_id = $2",
      [tenant.connectionId, submitted.id],
    );
    expect(orders[0].count).toBe("1");

    const { rows: payments } = await db.query<{ amount: string; method: string }>(
      "SELECT amount::text, method FROM payments WHERE order_id = $1",
      [orderId],
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe("online");
    // Two lattes, priced locally — the same total the POS order carries.
    expect(payments[0].amount).toBe("1700000");

    // Paying does not free the table: the visit is still open (ESH-147/#916).
    const { rows: tableRows } = await db.query<{ status: string }>(
      "SELECT status FROM dining_tables WHERE id = $1",
      [tenant.tableId],
    );
    expect(tableRows[0].status).toBe("seated");
  });

  it("two orders on one table share the visit session", async () => {
    const a = await intake(tenant, cmsOrder(tenant));
    const b = await intake(tenant, cmsOrder(tenant));
    expect(a.orderId).not.toBe(b.orderId);
    const { rows } = await db.query<{ table_session_id: string }>(
      "SELECT table_session_id FROM orders WHERE id = ANY($1::uuid[])",
      [[a.orderId, b.orderId]],
    );
    expect(new Set(rows.map((row) => row.table_session_id)).size).toBe(1);
  });

  describe("signed webhook", () => {
    async function deliver(event: string, order: ReturnType<typeof cmsOrder>, deliveryId: string) {
      const response = await ingest.handleCmsStoreOrderWebhook({
        siteId: tenant.siteId,
        deliveryId,
        event,
        order,
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    it("delivers `order.submitted` twice and still leaves one order", async () => {
      const order = cmsOrder(tenant);
      const first = await deliver("order.submitted", order, `d1-${randomUUID()}`);
      const second = await deliver("order.submitted", order, `d2-${randomUUID()}`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("processed");
      expect(second.body.status).toBe("processed");

      const { rows } = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM orders WHERE cms_connection_id = $1 AND cms_order_id = $2",
        [tenant.connectionId, order.id],
      );
      expect(rows[0].count).toBe("1");

      const { rows: inbox } = await db.query<{ status: string }>(
        "SELECT status FROM cms_store_order_inbox WHERE cms_connection_id = $1 AND cms_order_id = $2",
        [tenant.connectionId, order.id],
      );
      expect(inbox).toEqual([{ status: "processed" }]);
    });

    it("`order.paid` after `order.submitted` settles the same order", async () => {
      const submitted = cmsOrder(tenant);
      const intakeResult = await deliver("order.submitted", submitted, `d1-${randomUUID()}`);
      const orderId = String(intakeResult.body.orderId);

      const paid = await deliver("order.paid", { ...submitted, status: "paid" }, `d2-${randomUUID()}`);
      expect(paid.status).toBe(200);
      expect(paid.body.orderId).toBe(orderId);
      expect(paid.body.duplicatePayment).toBe(false);

      const { rows: orders } = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM orders WHERE cms_connection_id = $1 AND cms_order_id = $2",
        [tenant.connectionId, submitted.id],
      );
      expect(orders[0].count).toBe("1");
      const { rows: payments } = await db.query<{ amount: string }>(
        "SELECT amount::text FROM payments WHERE order_id = $1",
        [orderId],
      );
      expect(payments).toHaveLength(1);
    });

    it("a café reversal is recorded as refused rather than run through the retail engine", async () => {
      const submitted = cmsOrder(tenant);
      await deliver("order.submitted", submitted, `d1-${randomUUID()}`);
      const cancelled = await deliver(
        "order.cancelled",
        { ...submitted, status: "cancelled" },
        `d2-${randomUUID()}`,
      );
      expect(cancelled.status).toBe(422);
      expect(cancelled.body.error).toBe("cafe_order_reversal_not_supported");
    });
  });

  it("the queue lists pending website orders only", async () => {
    const pending = await intake(tenant, cmsOrder(tenant));
    const accepted = await intake(tenant, cmsOrder(tenant));
    await decide(tenant, accepted.orderId, "accepted");

    const queued = await approval.listOrdersAwaitingApproval(tenant.locationId);
    expect(queued.map((row) => row.id)).toEqual([pending.orderId]);
  });
});
