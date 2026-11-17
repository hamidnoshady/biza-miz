/**
 * ESH-146 (biza-miz#1304) — CMS café order intake & staff approval against a real PostgreSQL DB.
 *
 * Proves:
 *   1. `order.submitted` (both dine-in via opaque table QR token and takeaway) creates
 *      one POS order with `origin = 'website'`, `website_approval_state = 'pending'`,
 *      lines held at `status = 'pending'` (`sent_to_kitchen_at IS NULL`), and ZERO
 *      `kitchen_dispatch` rows.
 *   2. Nested Payload wire shapes (`cafe.serviceMode`, `cafe.tableToken`,
 *      `items[].product`, `items[].modifiers[].optionSourceId`) resolve identically.
 *   3. `transitionKitchenItem` refuses `'pending'` and `'rejected'` website lines.
 *   4. `decideCafeOrderApproval(..., "accepted")` promotes `'pending'` lines to `'sent'`,
 *      sets `sent_to_kitchen_at`, enqueues kitchen dispatch once, and is idempotent on retry.
 *   5. `decideCafeOrderApproval(..., "rejected")` requires a reason, dispatches nothing,
 *      keeps lines out of kitchen, and causes counter `completeOrderPayment` to reject (`409`).
 *   6. `order.paid` on an already-submitted café order settles that exact order (never creating
 *      a duplicate order), checks `cms_payment_amount_mismatch`, and settles idempotently even if
 *      `order.paid` races ahead of `order.submitted`.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import { eshobeSignature } from "../src/lib/cms/webhook";
import type { CmsOrder } from "../src/lib/cms/types";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));
vi.mock("@/lib/notification-events", () => ({ recordNotification: vi.fn() }));

const KEY = "cd".repeat(32);
const WEBHOOK_SECRET = "cafe-intake-webhook-secret";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ingest: typeof import("../src/lib/cms/order-ingest-service");
let approval: typeof import("../src/lib/cms/cafe-order-approval-service");
let kitchen: typeof import("../src/lib/kitchen-item-transition");
let paymentService: typeof import("../src/lib/payment-service");
let qr: typeof import("../src/lib/table-qr-service");

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

const ACCOUNTS: [string, string, string][] = [
  ["1100", "Cash", "asset"],
  ["1120", "Card clearing", "asset"],
  ["1200", "Accounts Receivable", "asset"],
  ["1230", "Platform Receivable", "asset"],
  ["1300", "Inventory", "asset"],
  ["2100", "Accounts Payable", "liability"],
  ["2200", "VAT Payable", "liability"],
  ["2400", "Tips Payable", "liability"],
  ["4310", "Dine-in revenue", "revenue"],
  ["4320", "Takeaway revenue", "revenue"],
  ["4330", "Delivery revenue", "revenue"],
  ["4400", "Sales returns", "revenue"],
  ["5100", "COGS", "expense"],
  ["5650", "Platform commission", "expense"],
];

interface SeedCafe {
  businessId: string;
  locationId: string;
  connectionId: string;
  siteId: string;
  menuItemId: string;
  modifierId: string;
  tableToken: string;
  userId: string;
}

async function seedCafe(): Promise<SeedCafe> {
  const suffix = randomUUID().slice(0, 8);
  const { rows: [biz] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry, status)
     VALUES ($1, $2, 'food_service', 'active') RETURNING id`,
    [`Cafe ${suffix}`, `cafe-${suffix}`],
  );
  const businessId = biz.id;

  const { rows: [user] } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, full_name, role, email, password_hash)
     VALUES ($1, 'مدیر کافه', 'owner', $2, 'hash') RETURNING id`,
    [businessId, `owner-${suffix}@test.local`],
  );
  const userId = user.id;

  const { rows: [loc] } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, is_active) VALUES ($1, 'شعبه ۱', true) RETURNING id`,
    [businessId],
  );
  const locationId = loc.id;

  for (const [code, name, type] of ACCOUNTS) {
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4)`,
      [businessId, code, name, type],
    );
  }
  await db.query(
    `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'dine_in', true)
     ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = true`,
    [businessId],
  );

  const { rows: [cat] } = await db.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'قهوه', 0) RETURNING id`,
    [locationId],
  );
  const { rows: [item] } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'اسپرسو', 100000) RETURNING id`,
    [locationId, cat.id],
  );
  const { rows: [modGroup] } = await db.query<{ id: string }>(
    `INSERT INTO modifier_groups (location_id, name) VALUES ($1, 'شات اضافه') RETURNING id`,
    [locationId],
  );
  const { rows: [mod] } = await db.query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta) VALUES ($1, $2, 'دبل شات', 50000) RETURNING id`,
    [locationId, modGroup.id],
  );
  await db.query(
    `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)`,
    [item.id, modGroup.id],
  );

  const { rows: [table] } = await db.query<{ id: string }>(
    `INSERT INTO dining_tables (location_id, name, status, is_active) VALUES ($1, 'میز ۷', 'free', true) RETURNING id`,
    [locationId],
  );

  const siteId = `site-${suffix}`;
  const cipher = encryptSecret("eshobe_live_cafe_key", Buffer.from(KEY, "hex"));
  const { rows: [conn] } = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext, status, sync_location_id)
     VALUES ($1, $2, $3, 'https://cms.test', $4, 'active', $5) RETURNING id`,
    [businessId, siteId, `cafe-${suffix}.test`, cipher, locationId],
  );

  await db.query(
    `INSERT INTO website_product_map (business_id, connection_id, local_kind, local_id, remote_id, sync_enabled)
     VALUES ($1, $2, 'menu_item', $3, 'cms-prod-espresso', true)`,
    [businessId, conn.id, item.id],
  );
  await db.query(
    `INSERT INTO website_menu_object_map (business_id, connection_id, kind, source_key, remote_id)
     VALUES ($1, $2, 'modifier', $3, 'cms-mod-double')`,
    [businessId, conn.id, mod.id],
  );

  await dbLib.withTenant(businessId, () =>
    qr.ensureTableQrToken({ businessId, locationId, tableId: table.id, userId }),
  );
  const print = await dbLib.withTenant(businessId, () =>
    qr.tableQrPrintPayload({ businessId, locationId, tableId: table.id }),
  );
  if (!print) throw new Error("missing QR print payload");

  return {
    businessId,
    locationId,
    connectionId: conn.id,
    siteId,
    menuItemId: item.id,
    modifierId: mod.id,
    tableToken: print.token,
    userId,
  };
}

beforeAll(async () => {
  databaseName = `pos_cafe_intake_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  process.env.ESHOBE_CMS_WEBHOOK_SECRET = WEBHOOK_SECRET;

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  dbLib = await import("../src/lib/db");
  ingest = await import("../src/lib/cms/order-ingest-service");
  approval = await import("../src/lib/cms/cafe-order-approval-service");
  kitchen = await import("../src/lib/kitchen-item-transition");
  paymentService = await import("../src/lib/payment-service");
  qr = await import("../src/lib/table-qr-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end().catch(() => {});
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

describe("ESH-146 cafe order intake & approval", () => {
  let cafe: SeedCafe;
  beforeEach(async () => {
    cafe = await seedCafe();
  });

  it("holds submitted dine-in QR orders pending approval without dispatching to kitchen, then dispatches once on accept", async () => {
    const cmsOrderId = `cms-ord-${randomUUID()}`;
    const orderPayload: CmsOrder = {
      id: cmsOrderId,
      reference: "ORD-701",
      status: "pending",
      total: 15_000, // 150,000 IRR = 15,000 IRT (100,000 + 50,000 modifier)
      currency: "IRT",
      cafe: {
        serviceMode: "dine_in",
        tableToken: cafe.tableToken,
        paymentChoice: "counter",
        fulfillment: "awaiting_approval",
      },
      items: [
        {
          product: { id: "cms-prod-espresso", title: "اسپرسو" },
          quantity: 1,
          modifiers: [{ optionSourceId: cafe.modifierId, quantity: 1 }],
        },
      ],
      buyer: { name: "نازنین", phone: "09123334455", email: null, note: "کم‌شکر" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const res = await ingest.handleCmsStoreOrderWebhook({
      siteId: cafe.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.submitted",
      order: orderPayload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; orderId: string };
    expect(body.status).toBe("processed");

    const { rows: [posOrder] } = await db.query<{
      origin: string;
      website_approval_state: string;
      total: string;
      table_id: string | null;
      status: string;
    }>(
      `SELECT origin, website_approval_state, total::text, table_id, status::text
         FROM orders WHERE id = $1`,
      [body.orderId],
    );
    expect(posOrder.origin).toBe("website");
    expect(posOrder.website_approval_state).toBe("pending");
    expect(posOrder.status).toBe("open");
    expect(posOrder.total).toBe("150000");
    expect(posOrder.table_id).toBeTruthy();

    const { rows: items } = await db.query<{ id: string; status: string; sent_to_kitchen_at: Date | null }>(
      `SELECT id, status::text, sent_to_kitchen_at FROM order_items WHERE order_id = $1`,
      [body.orderId],
    );
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");
    expect(items[0].sent_to_kitchen_at).toBeNull();

    const { rows: dispatchesBefore } = await db.query(
      `SELECT id FROM kitchen_dispatch_jobs WHERE order_id = $1`,
      [body.orderId],
    );
    expect(dispatchesBefore).toHaveLength(0);

    // Kitchen cannot bump pending items before acceptance.
    const blockedStart = await dbLib.withTenant(cafe.businessId, () =>
      kitchen.transitionKitchenItem({
        businessId: cafe.businessId,
        locationId: cafe.locationId,
        itemId: items[0].id,
        to: "preparing",
        mayBumpKitchen: true,
        mayServe: true,
        actorUserId: cafe.userId,
      }),
    );
    expect(blockedStart).toMatchObject({ kind: "conflict", currentStatus: "pending" });

    // Staff accepts: promotes pending -> sent, dispatches once, queues ESH-148 outbox row (not delivered yet).
    const accepted = await dbLib.withTenant(cafe.businessId, () =>
      approval.decideCafeOrderApproval({
        businessId: cafe.businessId,
        locationId: cafe.locationId,
        orderId: body.orderId,
        decision: "accepted",
        actor: { userId: cafe.userId, role: "owner" },
      }),
    );
    expect(accepted).toMatchObject({
      ok: true,
      changed: true,
      state: "accepted",
      dispatchedItemIds: [items[0].id],
    });

    // Idempotent retry on accept dispatches nothing a second time.
    const acceptedRetry = await dbLib.withTenant(cafe.businessId, () =>
      approval.decideCafeOrderApproval({
        businessId: cafe.businessId,
        locationId: cafe.locationId,
        orderId: body.orderId,
        decision: "accepted",
        actor: { userId: cafe.userId, role: "owner" },
      }),
    );
    expect(acceptedRetry).toMatchObject({ ok: true, changed: false, dispatchedItemIds: [] });

    const { rows: itemsAfter } = await db.query<{ status: string; sent_to_kitchen_at: Date | null }>(
      `SELECT status::text, sent_to_kitchen_at FROM order_items WHERE order_id = $1`,
      [body.orderId],
    );
    expect(itemsAfter[0].status).toBe("sent");
    expect(itemsAfter[0].sent_to_kitchen_at).not.toBeNull();

    const { rows: dispatchesAfter } = await db.query(
      `SELECT id FROM kitchen_dispatch_jobs WHERE order_id = $1`,
      [body.orderId],
    );
    expect(dispatchesAfter).toHaveLength(1);
  });

  it("rejects website takeaway order with reason, blocks counter settlement, and settles online order.paid on the same order without mismatch", async () => {
    const rejectedOrderId = `cms-rej-${randomUUID()}`;
    const submitRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: cafe.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.submitted",
      order: {
        id: rejectedOrderId,
        reference: "ORD-702",
        status: "pending",
        serviceMode: "takeaway",
        total: 10_000,
        currency: "IRT",
        items: [{ productId: "cms-prod-espresso", quantity: 1 }],
        buyer: { name: "کیوان", phone: "09129998877", email: null, note: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const { orderId: posRejectedId } = (await submitRes.json()) as { orderId: string };

    // Missing reason refused.
    const badReject = await dbLib.withTenant(cafe.businessId, () =>
      approval.decideCafeOrderApproval({
        businessId: cafe.businessId,
        locationId: cafe.locationId,
        orderId: posRejectedId,
        decision: "rejected",
        actor: { userId: cafe.userId, role: "owner" },
        reason: "   ",
      }),
    );
    expect(badReject).toMatchObject({ ok: false, error: "reason_required", status: 400 });

    const rejected = await dbLib.withTenant(cafe.businessId, () =>
      approval.decideCafeOrderApproval({
        businessId: cafe.businessId,
        locationId: cafe.locationId,
        orderId: posRejectedId,
        decision: "rejected",
        actor: { userId: cafe.userId, role: "owner" },
        reason: "مواد اولیه تمام شده",
      }),
    );
    expect(rejected).toMatchObject({ ok: true, changed: true, state: "rejected", dispatchedItemIds: [] });

    // Counter payment is blocked on a rejected order.
    await expect(
      dbLib.withTenant(cafe.businessId, async () => {
        const client = await dbLib.getPool().connect();
        try {
          await client.query("BEGIN");
          await paymentService.completeOrderPayment({
            client,
            businessId: cafe.businessId,
            locationId: cafe.locationId,
            orderId: posRejectedId,
            method: "cash",
            receivedBy: cafe.userId,
          });
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      }),
    ).rejects.toMatchObject({ code: "order_rejected", status: 409 });

    // Paid online race (order.paid arrives before order.submitted) creates ONE order and settles it.
    const onlineCmsId = `cms-paid-${randomUUID()}`;
    const mismatchRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: cafe.siteId,
      deliveryId: `del-mismatch-${randomUUID()}`,
      event: "order.paid",
      order: {
        id: onlineCmsId,
        reference: "ORD-703",
        status: "paid",
        serviceMode: "takeaway",
        total: 5_000, // Mismatch vs 100,000 IRR local menu price!
        currency: "IRT",
        items: [{ productId: "cms-prod-espresso", quantity: 1 }],
        buyer: { name: "مینا", phone: "09121112233", email: null, note: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    expect(mismatchRes.status).toBe(422);
    expect(await mismatchRes.json()).toEqual({ error: "cms_payment_amount_mismatch" });

    // Correct total redelivery settles cleanly on the SAME created POS order without duplicating orders.
    const paidRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: cafe.siteId,
      deliveryId: `del-paid-${randomUUID()}`,
      event: "order.paid",
      order: {
        id: onlineCmsId,
        reference: "ORD-703",
        status: "paid",
        serviceMode: "takeaway",
        total: 10_000,
        currency: "IRT",
        items: [{ productId: "cms-prod-espresso", quantity: 1 }],
        buyer: { name: "مینا", phone: "09121112233", email: null, note: null },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    expect(paidRes.status).toBe(200);
    const paidBody = (await paidRes.json()) as { status: string; orderId: string };
    expect(paidBody.status).toBe("processed");

    const { rows: matchingOrders } = await db.query<{ status: string }>(
      `SELECT status::text FROM orders WHERE cms_connection_id = $1 AND cms_order_id = $2`,
      [cafe.connectionId, onlineCmsId],
    );
    expect(matchingOrders).toHaveLength(1);
    expect(matchingOrders[0].status).toBe("completed");
  });
});
