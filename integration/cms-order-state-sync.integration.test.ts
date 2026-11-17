/**
 * ESH-148 (biza-miz#1306) — POS → CMS order state synchronization, echo suppression,
 * leased delivery worker, dead-lettering, and Hybrid desktop/cloud convergence.
 *
 * Tests against a real PostgreSQL database (no DB mocking; only HTTP fetch to the
 * CMS endpoint is mocked via `fetchImpl`).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import { quantityText, rialText } from "../src/lib/inventory-exact";
import { validateAmendment } from "../src/lib/order-amendments";
import type { FetchLike } from "../src/lib/cms/client";
import type { CmsOrder } from "../src/lib/cms/types";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));
vi.mock("@/lib/notification-events", () => ({ recordNotification: vi.fn() }));

const KEY = "ef".repeat(32);
const WEBHOOK_SECRET = "cms-sync-webhook-secret";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ingest: typeof import("../src/lib/cms/order-ingest-service");
let approval: typeof import("../src/lib/cms/cafe-order-approval-service");
let kitchen: typeof import("../src/lib/kitchen-item-transition");
let orderMutations: typeof import("../src/lib/order-mutations");
let paymentService: typeof import("../src/lib/payment-service");
let returnService: typeof import("../src/lib/customer-return-service");
let amendmentService: typeof import("../src/lib/order-amendment-service");
let outbox: typeof import("../src/lib/cms/order-state-outbox-service");
let syncEvents: typeof import("../src/lib/sync-events");
let inboxService: typeof import("../src/lib/cms/order-inbox-service");

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

interface Env {
  businessId: string;
  locationId: string;
  connectionId: string;
  siteId: string;
  userId: string;
  menuItemId: string;
  secondMenuItemId: string;
}

async function seedEnv(): Promise<Env> {
  const suffix = randomUUID().slice(0, 8);
  const { rows: [biz] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry, status)
     VALUES ($1, $2, 'food_service', 'active') RETURNING id`,
    [`SyncCafe ${suffix}`, `synccafe-${suffix}`],
  );
  const businessId = biz.id;

  const { rows: [user] } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, full_name, role, email, password_hash)
     VALUES ($1, 'مالک کافه', 'owner', $2, 'hash') RETURNING id`,
    [businessId, `owner-${suffix}@test.local`],
  );
  const userId = user.id;

  const { rows: [loc] } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, is_active) VALUES ($1, 'شعبه مرکزی', true) RETURNING id`,
    [businessId],
  );
  const locationId = loc.id;

  for (const [code, name, type] of ACCOUNTS) {
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4)`,
      [businessId, code, name, type],
    );
  }

  const { rows: [cat] } = await db.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'نوشیدنی', 0) RETURNING id`,
    [locationId],
  );
  const { rows: [m1] } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'کاپوچینو', 120000) RETURNING id`,
    [locationId, cat.id],
  );
  const { rows: [m2] } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'کیک', 80000) RETURNING id`,
    [locationId, cat.id],
  );

  const siteId = `site-${suffix}`;
  const cipher = encryptSecret("eshobe_live_sync_key", Buffer.from(KEY, "hex"));
  const { rows: [conn] } = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext, status, sync_location_id)
     VALUES ($1, $2, $3, 'https://cms.test', $4, 'active', $5) RETURNING id`,
    [businessId, siteId, `sync-${suffix}.test`, cipher, locationId],
  );

  await db.query(
    `INSERT INTO website_product_map (business_id, connection_id, local_kind, local_id, remote_id, sync_enabled)
     VALUES ($1, $2, 'menu_item', $3, 'cms-cap', true),
            ($1, $2, 'menu_item', $4, 'cms-cake', true)`,
    [businessId, conn.id, m1.id, m2.id],
  );

  return {
    businessId,
    locationId,
    connectionId: conn.id,
    siteId,
    userId,
    menuItemId: m1.id,
    secondMenuItemId: m2.id,
  };
}

function submittedTakeaway(
  cmsOrderId: string,
  items: { productId: string; quantity: number }[],
  totalIrt: number,
): CmsOrder {
  return {
    id: cmsOrderId,
    reference: `ORD-${cmsOrderId.slice(0, 6)}`,
    status: "pending",
    serviceMode: "takeaway",
    total: totalIrt,
    currency: "IRT",
    items,
    buyer: { name: "سارا", phone: "09120001122", email: null, note: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  databaseName = `pos_cms_sync_${randomUUID().replaceAll("-", "")}`;
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
  process.env.DEPLOYMENT_ROLE = "central";

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  dbLib = await import("../src/lib/db");
  ingest = await import("../src/lib/cms/order-ingest-service");
  approval = await import("../src/lib/cms/cafe-order-approval-service");
  kitchen = await import("../src/lib/kitchen-item-transition");
  orderMutations = await import("../src/lib/order-mutations");
  paymentService = await import("../src/lib/payment-service");
  returnService = await import("../src/lib/customer-return-service");
  amendmentService = await import("../src/lib/order-amendment-service");
  outbox = await import("../src/lib/cms/order-state-outbox-service");
  syncEvents = await import("../src/lib/sync-events");
  inboxService = await import("../src/lib/cms/order-inbox-service");

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

describe("ESH-148 POS → CMS order state outbox, delivery worker, and echo suppression", () => {
  let env: Env;
  beforeEach(async () => {
    process.env.DEPLOYMENT_ROLE = "central";
    env = await seedEnv();
  });

  it("enqueues accepted → preparing → ready → served across multi-item lines and item void, plus counter paid", async () => {
    const cmsOrderId = `cms-flow-${randomUUID()}`;
    const intake = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.submitted",
      order: submittedTakeaway(
        cmsOrderId,
        [
          { productId: "cms-cap", quantity: 1 },
          { productId: "cms-cake", quantity: 1 },
        ],
        20_000,
      ),
    });
    const { orderId } = (await intake.json()) as { orderId: string };

    // 1. Accept -> queues fulfillment='accepted' (not delivered until worker runs).
    await dbLib.withTenant(env.businessId, () =>
      approval.decideCafeOrderApproval({
        businessId: env.businessId,
        locationId: env.locationId,
        orderId,
        decision: "accepted",
        actor: { userId: env.userId, role: "owner" },
      }),
    );

    const { rows: itemRows } = await db.query<{ id: string }>(
      `SELECT id FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    );
    const [item1, item2] = itemRows.map((r) => r.id);

    // Move item1 to preparing -> aggregate fulfillment advances to 'preparing' and supersedes undelivered 'accepted'.
    const p1 = await dbLib.withTenant(env.businessId, () =>
      kitchen.transitionKitchenItem({
        businessId: env.businessId,
        locationId: env.locationId,
        itemId: item1,
        to: "preparing",
        mayBumpKitchen: true,
        mayServe: true,
        actorUserId: env.userId,
      }),
    );
    expect(p1).toMatchObject({ kind: "updated" });
    const outboxRows = await dbLib.withTenant(env.businessId, () =>
      outbox.listCmsOrderStateOutbox(env.businessId, "all"),
    );
    expect(outboxRows.filter((r) => r.status === "pending").map((r) => r.state)).toEqual(["preparing"]);
    expect(outboxRows.find((r) => r.state === "accepted")?.status).toBe("superseded");

    // Move item2 to preparing -> aggregate remains 'preparing' (idempotent).
    const p2 = await dbLib.withTenant(env.businessId, () =>
      kitchen.transitionKitchenItem({
        businessId: env.businessId,
        locationId: env.locationId,
        itemId: item2,
        to: "preparing",
        mayBumpKitchen: true,
        mayServe: true,
        actorUserId: env.userId,
      }),
    );
    expect(p2).toMatchObject({ kind: "updated" });

    // Move item1 to ready (still 'preparing' while item2 is preparing), then void lagging item2 -> advances to 'ready'!
    const r1 = await dbLib.withTenant(env.businessId, () =>
      kitchen.transitionKitchenItem({
        businessId: env.businessId,
        locationId: env.locationId,
        itemId: item1,
        to: "ready",
        mayBumpKitchen: true,
        mayServe: true,
        actorUserId: env.userId,
      }),
    );
    expect(r1).toMatchObject({ kind: "updated" });
    const midRows = await dbLib.withTenant(env.businessId, () =>
      outbox.listCmsOrderStateOutbox(env.businessId, "all"),
    );
    expect(midRows.some((r) => r.state === "ready")).toBe(false);
    const voidItemRes = await dbLib.withTenant(env.businessId, () =>
      orderMutations.updateOrderItem({
        locationId: env.locationId,
        orderId,
        orderItemId: item2,
        void: { reason: "مشتری انصراف داد" },
        actor: { businessId: env.businessId, userId: env.userId, role: "owner" },
      }),
    );
    expect(voidItemRes).toMatchObject({ ok: true, data: { voided: true } });

    // Serve item1 -> aggregate advances to 'served'.
    const s1 = await dbLib.withTenant(env.businessId, () =>
      kitchen.transitionKitchenItem({
        businessId: env.businessId,
        locationId: env.locationId,
        itemId: item1,
        to: "served",
        mayBumpKitchen: true,
        mayServe: true,
        actorUserId: env.userId,
      }),
    );
    expect(s1).toMatchObject({ kind: "updated" });

    // Settle at counter -> queues payment='paid' on payment axis without disturbing fulfillment.
    await dbLib.withTenant(env.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await paymentService.completeOrderPayment({
          client,
          businessId: env.businessId,
          locationId: env.locationId,
          orderId,
          method: "cash",
          receivedBy: env.userId,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });

    // Drain via worker and verify HTTP PATCH sequence sent to eshobe-cms.
    const sentPatches: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetchMock: FetchLike = (url, init) => {
      const headers = init.headers as Headers;
      sentPatches.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: headers.get("Authorization"),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ id: cmsOrderId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const result = await dbLib.withTenant(env.businessId, () =>
      outbox.syncCmsOrderStatesForBusiness(env.businessId, {
        limit: 50,
        fetchImpl: fetchMock,
      }),
    );
    expect(result.sent).toBe(2); // latest non-superseded fulfillment ('served') + payment ('paid')
    expect(sentPatches).toHaveLength(2);
    expect(sentPatches.map((p) => p.body)).toEqual([
      expect.objectContaining({
        cafe: expect.objectContaining({ fulfillment: "served" }),
      }),
      { status: "paid" },
    ]);
    expect(sentPatches[0].auth).toBe("Bearer eshobe_live_sync_key");

    const syncSummary = await dbLib.withTenant(env.businessId, () =>
      inboxService.syncStatusForCmsOrders(env.connectionId, [cmsOrderId]),
    );
    expect(syncSummary[cmsOrderId]?.fulfillment?.state).toBe("served");
    expect(syncSummary[cmsOrderId]?.fulfillment?.status).toBe("sent");
    expect(syncSummary[cmsOrderId]?.payment?.state).toBe("paid");
    expect(syncSummary[cmsOrderId]?.payment?.status).toBe("sent");
  });

  it("emits 'refunded' only on full return, suppresses echo webhooks, and dead-letters 4xx / retries 5xx", async () => {
    const cmsOrderId = `cms-ret-${randomUUID()}`;
    const intake = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.submitted",
      order: submittedTakeaway(
        cmsOrderId,
        [
          { productId: "cms-cap", quantity: 1 },
          { productId: "cms-cake", quantity: 1 },
        ],
        20_000,
      ),
    });
    const { orderId } = (await intake.json()) as { orderId: string };

    // Settle via counter payment (200,000 IRR total = 120,000 + 80,000).
    await dbLib.withTenant(env.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await paymentService.completeOrderPayment({
          client,
          businessId: env.businessId,
          locationId: env.locationId,
          orderId,
          method: "cash",
          receivedBy: env.userId,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });

    const { rows: items } = await db.query<{ id: string }>(
      `SELECT id FROM order_items WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    );

    // Partial return (only item 2 = 80,000 IRR) must NOT enqueue 'refunded' yet.
    await dbLib.withTenant(env.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await returnService.createCustomerReturn(client, {
          businessId: env.businessId,
          locationId: env.locationId,
          orderId,
          refundMethod: "cash",
          refundAmount: rialText("80000"),
          reason: "برگشت کیک",
          idempotencyKey: `ret-part-${randomUUID()}`,
          createdBy: env.userId,
          lines: [{ orderItemId: items[1].id, quantity: quantityText("1"), disposition: "discarded" }],
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    let queue = await dbLib.withTenant(env.businessId, () =>
      outbox.listCmsOrderStateOutbox(env.businessId, "all"),
    );
    expect(queue.some((r) => r.state === "refunded")).toBe(false);

    // Remaining return (120,000 IRR) brings remainingRefundRial to 0 -> queues 'refunded'!
    await dbLib.withTenant(env.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await returnService.createCustomerReturn(client, {
          businessId: env.businessId,
          locationId: env.locationId,
          orderId,
          refundMethod: "cash",
          refundAmount: rialText("120000"),
          reason: "برگشت کاپوچینو",
          idempotencyKey: `ret-full-${randomUUID()}`,
          createdBy: env.userId,
          lines: [{ orderItemId: items[0].id, quantity: quantityText("1"), disposition: "discarded" }],
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    queue = await dbLib.withTenant(env.businessId, () =>
      outbox.listCmsOrderStateOutbox(env.businessId, "all"),
    );
    const refundRow = queue.find((r) => r.state === "refunded");
    expect(refundRow).toBeTruthy();

    // Echo webhook `order.refunded` from CMS after POS already recorded refund must be suppressed cleanly!
    const echoRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-echo-${randomUUID()}`,
      event: "order.refunded",
      order: {
        ...submittedTakeaway(cmsOrderId, [{ productId: "cms-cap", quantity: 1 }], 20_000),
        status: "refunded",
      },
    });
    expect(echoRes.status).toBe(200);
    expect(await echoRes.json()).toMatchObject({ status: "processed", alreadyReversed: true });

    // Worker test: 500 backs off into 'failed', manual retry requeues, 400 dead-letters + writes URL-scrubbed audit.
    const fail500: FetchLike = () =>
      Promise.resolve(new Response(JSON.stringify({ message: "server error" }), { status: 500 }));
    const res500 = await dbLib.withTenant(env.businessId, () =>
      outbox.syncCmsOrderStatesForBusiness(env.businessId, { limit: 10, fetchImpl: fail500 }),
    );
    expect(res500.failed).toBe(1);

    // Requeue manually via retryCmsOrderStateOutboxRow, then hit 400 -> dead-lettered + audit!
    const requeued = await dbLib.withTenant(env.businessId, () =>
      outbox.retryCmsOrderStateOutboxRow(env.businessId, refundRow!.id),
    );
    expect(requeued).toBe(true);

    const fail400: FetchLike = () =>
      Promise.resolve(new Response(JSON.stringify({ message: "bad transition" }), { status: 400 }));
    const res400 = await dbLib.withTenant(env.businessId, () =>
      outbox.syncCmsOrderStatesForBusiness(env.businessId, { limit: 10, fetchImpl: fail400 }),
    );
    expect(res400.dead).toBe(1);

    const { rows: audits } = await db.query<{ action: string; error: string | null }>(
      `SELECT action, error FROM integration_audit_log WHERE business_id = $1`,
      [env.businessId],
    );
    expect(audits.some((a) => a.action === "cms.order_state.dead_lettered")).toBe(true);
  });

  it("handles genuine CMS-initiated cancellation on open & settled orders without echoing back, and bridges Hybrid desktop order state back to CMS outbox", async () => {
    // 1. Open website order cancelled from CMS -> voids POS order and emits NO outbound 'cancelled' echo.
    const openCmsId = `cms-open-cancel-${randomUUID()}`;
    const openRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.submitted",
      order: submittedTakeaway(openCmsId, [{ productId: "cms-cap", quantity: 1 }], 12_000),
    });
    const { orderId: openPosId } = (await openRes.json()) as { orderId: string };

    const cancelRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-cancel-${randomUUID()}`,
      event: "order.cancelled",
      order: {
        ...submittedTakeaway(openCmsId, [{ productId: "cms-cap", quantity: 1 }], 12_000),
        status: "cancelled",
      },
    });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toMatchObject({ status: "processed", alreadyReversed: false });

    const { rows: [openOrderAfter] } = await db.query<{ status: string }>(
      `SELECT status::text FROM orders WHERE id = $1`,
      [openPosId],
    );
    expect(openOrderAfter.status).toBe("voided");

    // Verify no outbound 'cancelled' row was echoed back.
    const openOutbox = await dbLib.withTenant(env.businessId, () =>
      outbox.listCmsOrderStateOutbox(env.businessId, "all"),
    );
    expect(openOutbox.filter((r) => r.cmsOrderId === openCmsId && r.state === "cancelled")).toHaveLength(0);

    // 2. Paid online website order cancelled from CMS -> reverses closed sale with skipCmsOrderStateSync=true.
    const paidCmsId = `cms-paid-cancel-${randomUUID()}`;
    await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.paid",
      order: {
        ...submittedTakeaway(paidCmsId, [{ productId: "cms-cap", quantity: 1 }], 12_000),
        status: "paid",
      },
    });
    const paidCancelRes = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-paid-cancel-${randomUUID()}`,
      event: "order.cancelled",
      order: {
        ...submittedTakeaway(paidCmsId, [{ productId: "cms-cap", quantity: 1 }], 12_000),
        status: "cancelled",
      },
    });
    expect(paidCancelRes.status).toBe(200);
    expect(await paidCancelRes.json()).toMatchObject({ status: "processed", alreadyReversed: false });

    // 3. Hybrid sync: automated cloud `order.create` + desktop `order.state.synced` replay on central triggers ESH-148 outbox.
    const hybridOrderId = randomUUID();
    const hybridItemId = randomUUID();
    const hybridCmsId = `cms-hybrid-${randomUUID()}`;

    // Simulate desktop pulling automated cloud `order.create` (actorUserId === "").
    const pullCreate = await dbLib.withTenant(env.businessId, () =>
      syncEvents.applySyncEvent(
        env.locationId,
        { userId: "", role: "cashier" },
        {
          clientEventId: hybridOrderId,
          type: "order.create",
          occurredAt: new Date().toISOString(),
          payload: {
            orderId: hybridOrderId,
            type: "takeaway",
            items: [{ menuItemId: env.menuItemId, quantity: 1 }],
            itemIds: [hybridItemId],
            holdKitchenDispatch: true,
            websiteOrigin: {
              cmsConnectionId: env.connectionId,
              cmsOrderId: hybridCmsId,
              websiteApprovalState: "pending",
            },
          },
        },
        "remote",
        { pulledFromCloud: true },
      ),
    );
    expect(pullCreate.ok).toBe(true);

    // Now simulate desktop bumping item to 'ready' after acceptance & pushing `order.state.synced` to Central Cloud.
    const hlcRes = await db.query<{ hlc: string }>(`SELECT app_sync_next_hlc() AS hlc`);
    const pushState = await dbLib.withTenant(env.businessId, () =>
      syncEvents.applySyncEvent(
        env.locationId,
        { userId: env.userId, role: "owner" },
        {
          clientEventId: randomUUID(),
          type: "order.state.synced",
          occurredAt: new Date().toISOString(),
          payload: {
            orderId: hybridOrderId,
            stateHlc: hlcRes.rows[0].hlc,
            order: {
              type: "takeaway",
              status: "open",
              orderNumber: "9001",
              tableId: null,
              tableSessionId: null,
              customerId: null,
              guestCount: null,
              note: null,
              discountType: null,
              discountValue: null,
              subtotal: "120000",
              discount: "0",
              serviceCharge: "0",
              tax: "0",
              total: "120000",
              openedAt: new Date().toISOString(),
              openedBy: null,
              voidedReason: null,
              closedBy: null,
              closedAt: null,
              origin: "website",
              cmsConnectionId: env.connectionId,
              cmsOrderId: hybridCmsId,
              websiteApprovalState: "accepted",
            },
            items: [
              {
                id: hybridItemId,
                menuItemId: env.menuItemId,
                nameSnapshot: "کاپوچینو",
                unitPrice: "120000",
                quantity: 1,
                status: "ready",
                note: null,
                sentToKitchenAt: new Date().toISOString(),
                readyAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                voidReason: null,
                modifiers: [],
              },
            ],
          },
        },
        "remote",
        { schemaVersion: 1 },
      ),
    );
    expect(pushState).toEqual(expect.objectContaining({ ok: true }));

    const hybridSummary = await dbLib.withTenant(env.businessId, () =>
      inboxService.syncStatusForCmsOrders(env.connectionId, [hybridCmsId]),
    );
    expect(hybridSummary[hybridCmsId]?.fulfillment?.state).toBe("ready");

    // 4. App gate disabled (`disabled_retained`) suppresses outbox tick drain without losing queued rows.
    await db.query(
      `INSERT INTO business_service_activations (business_id, service_kind, service_key, state)
       VALUES ($1, 'app', 'website', 'disabled_retained')`,
      [env.businessId],
    );
    const disabledTick = await outbox.runCmsOrderStateOutboxTick();
    expect(disabledTick).toMatchObject({ businesses: 0, sent: 0 });

    // 5. Closed-order amendment void emits payment='cancelled'.
    const amendCmsId = `cms-amend-${randomUUID()}`;
    const amendIntake = await ingest.handleCmsStoreOrderWebhook({
      siteId: env.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.submitted",
      order: submittedTakeaway(amendCmsId, [{ productId: "cms-cap", quantity: 1 }], 12_000),
    });
    const { orderId: amendPosId } = (await amendIntake.json()) as { orderId: string };
    await dbLib.withTenant(env.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await paymentService.completeOrderPayment({
          client,
          businessId: env.businessId,
          locationId: env.locationId,
          orderId: amendPosId,
          method: "cash",
          receivedBy: env.userId,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    const validatedVoid = validateAmendment({ kind: "void", reason: "اصلاح فاکتور" });
    if (!validatedVoid.ok) throw new Error(validatedVoid.error);
    await dbLib.withTenant(env.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await amendmentService.amendClosedOrder(client, {
          businessId: env.businessId,
          locationId: env.locationId,
          orderId: amendPosId,
          actorId: env.userId,
          input: validatedVoid.value,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    const amendSummary = await dbLib.withTenant(env.businessId, () =>
      inboxService.syncStatusForCmsOrders(env.connectionId, [amendCmsId]),
    );
    expect(amendSummary[amendCmsId]?.payment?.state).toBe("cancelled");
  });
});
