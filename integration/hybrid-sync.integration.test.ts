/**
 * Hybrid sync, end to end, across two real databases: a central server and a
 * paired desktop (migration 0190, Phase 44).
 *
 * The desktop's HTTP calls are routed straight into the central server's own
 * route handlers, switching the shared pool to the central database for the
 * duration of each call — so what is exercised is the real wire format, the
 * real bearer authentication and the real merge on each side.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { getPool, query, withTenant, withoutTenantScope } from "../src/lib/db";
import { provisionBusiness } from "../src/lib/business-provisioning";
import { acknowledgePairingSession, issuePairingCode, redeemPairingCode } from "../src/lib/pairing-service";
import { applyPairingSnapshot } from "../src/lib/pairing-apply";
import { acknowledgePendingPairing, runServerPull, runServerPush } from "../src/lib/server-sync";
import { runMasterSync } from "../src/lib/master-sync-transport";
import { addItemsToOrder, createOrder, updateOrderItem } from "../src/lib/order-mutations";
import { closeOwnShift, openShift } from "../src/lib/shift-service";
import { syncClientEventId } from "../src/lib/sync-outbox";
import { resetSiteProfileGate, runSiteProfileSync } from "../src/lib/site-profile-service";
import { EMPTY_SITE_PROFILE_STATE } from "../src/lib/site-profile";
import { effectiveFeatures } from "../src/lib/features";
import { effectiveAppAvailability } from "../src/lib/app-availability-service";
import { setSetting, SETTING_KEYS } from "../src/lib/settings";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

/** The desktop owner the till routes act as. */
const session = vi.hoisted(() => ({ businessId: "", locationId: "", sub: "" }));

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  const granted = async () => ({
    session: {
      businessId: session.businessId,
      locationId: session.locationId,
      activeLocationId: session.locationId,
      sub: session.sub,
      role: "owner",
    },
    error: null,
  });
  const { withTenant: scoped } = await import("../src/lib/db");
  return {
    ...actual,
    requireRole: vi.fn(granted),
    requirePermission: vi.fn(granted),
    withTenantScope:
      (handler: (...args: never[]) => Promise<Response>) =>
      (...args: never[]) =>
        scoped(session.businessId, () => handler(...args)),
  };
});

vi.mock("../src/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn(async () => ({ id: session.locationId })) };
});

const globalForPg = globalThis as unknown as { pgPool?: Pool };
const originalRole = process.env.DEPLOYMENT_ROLE;
const originalFetch = globalThis.fetch;

let centralDb: string;
let siteDb: string;

const biz = {
  businessId: "",
  locationId: "",
  ownerId: "",
  menuItemId: "",
  categoryId: "",
  inventoryItemId: "",
};

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

async function maintenance<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function switchDatabase(name: string, role: "central" | "site"): Promise<void> {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
  process.env.DEPLOYMENT_ROLE = role;
}

async function onCentral<T>(fn: () => Promise<T>): Promise<T> {
  await switchDatabase(centralDb, "central");
  try {
    return await fn();
  } finally {
    await switchDatabase(siteDb, "site");
  }
}

const masterRoute = () => import("../src/app/api/server-sync/master/route");
const pushRoute = () => import("../src/app/api/server-sync/push/route");
const pullRoute = () => import("../src/app/api/server-sync/pull/route");

/** The desktop's fetch, answered by the central server's own route handlers. */
async function centralFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const request = new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body as BodyInit | undefined,
  });
  return onCentral(async () => {
    switch (url.pathname) {
      case "/api/server-sync/master":
        return request.method === "POST" ? (await masterRoute()).POST(request) : (await masterRoute()).GET(request);
      case "/api/server-sync/push":
        return (await pushRoute()).POST(request);
      case "/api/server-sync/pull":
        return (await pullRoute()).GET(request);
      case "/api/server-sync/digest":
        return (await import("../src/app/api/server-sync/digest/route")).POST(request);
      case "/api/server-sync/site-profile":
        return (await import("../src/app/api/server-sync/site-profile/route")).GET(request);
      case "/api/pairing/acknowledge":
        return Response.json({ ok: true });
      default:
        throw new Error(`unexpected central call ${url.pathname}`);
    }
  });
}

/** One sync round from the desktop: master data both ways, then operational events both ways. */
async function syncRound() {
  const master = await withTenant(biz.businessId, () => runMasterSync(biz.businessId));
  const push = await withTenant(biz.businessId, () => runServerPush(biz.businessId));
  const pull = await withTenant(biz.businessId, () => runServerPull(biz.businessId));
  return { master, push, pull };
}

beforeAll(async () => {
  centralDb = `pos_hy_c_${randomUUID().replaceAll("-", "")}`;
  siteDb = `pos_hy_s_${randomUUID().replaceAll("-", "")}`;
  for (const name of [centralDb, siteDb]) {
    await maintenance((client) => client.query(`CREATE DATABASE "${name}"`));
    await runMigrations({ databaseUrl: urlFor(name), quiet: true });
  }

  // ---- central: a business with a small menu, paired to one desktop ------
  await switchDatabase(centralDb, "central");
  const created = await provisionBusiness({
    businessName: "کافه همگام",
    ownerName: "مالک",
    email: `owner-${randomUUID()}@example.com`,
    password: "correct-horse",
    seedChartOfAccounts: true,
  });
  biz.businessId = created.businessId;
  biz.locationId = created.locationId;
  biz.ownerId = created.userId;
  session.businessId = created.businessId;
  session.locationId = created.locationId;
  session.sub = created.userId;
  await withTenant(biz.businessId, async () => {
    const category = await query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, sort_order) VALUES ($1, 'نوشیدنی', 0) RETURNING id`,
      [biz.locationId],
    );
    biz.categoryId = category.rows[0].id;
    const item = await query<{ id: string }>(
      `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'اسپرسو', 850000) RETURNING id`,
      [biz.locationId, biz.categoryId],
    );
    biz.menuItemId = item.rows[0].id;
    const inventory = await query<{ id: string }>(
      `INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'دانه قهوه', 'g') RETURNING id`,
      [biz.locationId],
    );
    biz.inventoryItemId = inventory.rows[0].id;
  });
  const admin = await withoutTenantScope("platform", async () =>
    (
      await query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, 'x', 'operator') RETURNING id`,
        [`admin-${randomUUID()}@example.com`],
      )
    ).rows[0].id,
  );
  const issued = await withoutTenantScope("platform", () => issuePairingCode(biz.businessId, admin, biz.locationId));
  if (!("code" in issued)) throw new Error("pairing code not issued");
  const installationId = `desktop-${randomUUID()}`;
  const redeemed = await redeemPairingCode(issued.code, "127.0.0.1", "test desktop", installationId, { maxSnapshotVersion: 7 });
  if (!redeemed.ok) throw new Error("pairing code not redeemed");
  await acknowledgePairingSession(redeemed.pairingSessionId, installationId, redeemed.snapshot.syncToken);

  // ---- desktop: apply the snapshot and switch sync on --------------------
  await switchDatabase(siteDb, "site");
  await applyPairingSnapshot(redeemed.snapshot, "https://central.example.com", {
    pairingSessionId: redeemed.pairingSessionId,
    installationId,
  });
  globalThis.fetch = vi.fn(centralFetch) as typeof fetch;
  await withTenant(biz.businessId, () => acknowledgePendingPairing(biz.businessId));
}, 240_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (originalRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = originalRole;
  for (const name of [centralDb, siteDb]) {
    await maintenance((client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  }
});

describe("master data", () => {
  it("brings a customer created in the cloud to the desktop, and keeps both sides' edits to different fields", async () => {
    const partyId = await onCentral(() =>
      withTenant(biz.businessId, async () =>
        (
          await query<{ id: string }>(
            `INSERT INTO parties (business_id, name, phone) VALUES ($1, 'سارا', '09120000000') RETURNING id`,
            [biz.businessId],
          )
        ).rows[0].id,
      ),
    );

    // Pairing never carried customers; the feed does.
    await syncRound();
    const onDesktop = await withTenant(biz.businessId, () =>
      query<{ name: string; phone: string }>("SELECT name, phone FROM parties WHERE id = $1", [partyId]),
    );
    expect(onDesktop.rows[0]).toEqual({ name: "سارا", phone: "09120000000" });

    // Concurrent edits: the phone in the cloud, the address on the desktop.
    await onCentral(() =>
      withTenant(biz.businessId, () => query("UPDATE parties SET phone = '09351112222' WHERE id = $1", [partyId])),
    );
    await withTenant(biz.businessId, () => query("UPDATE parties SET address = 'شیراز' WHERE id = $1", [partyId]));

    await syncRound();
    await syncRound();

    const read = () =>
      withTenant(biz.businessId, () =>
        query<{ phone: string; address: string }>("SELECT phone, address FROM parties WHERE id = $1", [partyId]),
      );
    const desktop = (await read()).rows[0];
    const cloud = (await onCentral(read)).rows[0];
    expect(desktop).toEqual({ phone: "09351112222", address: "شیراز" });
    expect(cloud).toEqual(desktop);

    // Settled: another round moves nothing in either direction.
    const quiet = await syncRound();
    expect(quiet.master).toEqual({ status: "ok", pushed: 0, pulled: 0 });
  });

  it("lets the later edit win when both sides change the same field", async () => {
    const partyId = await onCentral(() =>
      withTenant(biz.businessId, async () =>
        (
          await query<{ id: string }>(`INSERT INTO parties (business_id, name) VALUES ($1, 'علی') RETURNING id`, [
            biz.businessId,
          ])
        ).rows[0].id,
      ),
    );
    await syncRound();
    await withTenant(biz.businessId, () => query("UPDATE parties SET name = 'علی (میز)' WHERE id = $1", [partyId]));
    await onCentral(() =>
      withTenant(biz.businessId, () => query("UPDATE parties SET name = 'علی رضایی' WHERE id = $1", [partyId])),
    );
    await syncRound();
    await syncRound();
    const read = () =>
      withTenant(biz.businessId, () => query<{ name: string }>("SELECT name FROM parties WHERE id = $1", [partyId]));
    expect((await read()).rows[0].name).toBe("علی رضایی");
    expect((await onCentral(read)).rows[0].name).toBe("علی رضایی");
  });

  it("carries menu edits both ways and never overwrites a cost each side derives itself", async () => {
    await onCentral(() =>
      withTenant(biz.businessId, async () => {
        await query("UPDATE menu_items SET price = 900000 WHERE id = $1", [biz.menuItemId]);
        await query("UPDATE inventory_items SET avg_cost = 111 WHERE id = $1", [biz.inventoryItemId]);
      }),
    );
    const newItemId = await withTenant(biz.businessId, async () => {
      await query("UPDATE inventory_items SET avg_cost = 999 WHERE id = $1", [biz.inventoryItemId]);
      return (
        await query<{ id: string }>(
          `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'لاته', 1200000) RETURNING id`,
          [biz.locationId, biz.categoryId],
        )
      ).rows[0].id;
    });

    await syncRound();

    const desktopPrice = await withTenant(biz.businessId, () =>
      query<{ price: string }>("SELECT price::text FROM menu_items WHERE id = $1", [biz.menuItemId]),
    );
    expect(desktopPrice.rows[0].price).toBe("900000");
    const cloudLatte = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ name: string; price: string }>("SELECT name, price::text FROM menu_items WHERE id = $1", [newItemId]),
      ),
    );
    expect(cloudLatte.rows[0]).toEqual({ name: "لاته", price: "1200000" });

    const cost = () =>
      withTenant(biz.businessId, () =>
        query<{ avg_cost: string }>("SELECT avg_cost::text FROM inventory_items WHERE id = $1", [biz.inventoryItemId]),
      );
    expect(Number((await cost()).rows[0].avg_cost)).toBe(999);
    expect(Number((await onCentral(cost)).rows[0].avg_cost)).toBe(111);
  });
});

describe("watch catalogue (issue #795 Phase 7)", () => {
  it("carries brand, model and structured attributes both ways — but never the serial units", async () => {
    // ---- central: a brand, a serialized model, its attributes, one unit --
    const ids = await onCentral(() =>
      withTenant(biz.businessId, async () => {
        const brand = await query<{ id: string }>(
          `INSERT INTO item_brands (location_id, name, country) VALUES ($1, 'رولکس', 'سوئیس') RETURNING id`,
          [biz.locationId],
        );
        const item = await query<{ id: string }>(
          `INSERT INTO items (location_id, name, sku, tracking, brand_id, service_interval_months)
           VALUES ($1, 'سابمارینر', 'SUB-1', 'serial', $2, 36) RETURNING id`,
          [biz.locationId, brand.rows[0].id],
        );
        await query(
          `INSERT INTO watch_item_attributes (item_id, reference_no, movement, water_resistance_m, gender)
           VALUES ($1, '126610LN', 'automatic', 300, 'men')`,
          [item.rows[0].id],
        );
        const serial = await query<{ id: string }>(
          `INSERT INTO item_serials (item_id, serial_number, unit_cost) VALUES ($1, 'SN-HYB-1', 30000000) RETURNING id`,
          [item.rows[0].id],
        );
        return { brandId: brand.rows[0].id, itemId: item.rows[0].id, serialId: serial.rows[0].id };
      }),
    );

    await syncRound();

    // The catalogue arrived whole: brand, model (with its brand reference
    // intact — brands rank before items in the feed), and attributes.
    const onDesktop = await withTenant(biz.businessId, async () => ({
      brand: (await query<{ name: string; country: string }>("SELECT name, country FROM item_brands WHERE id = $1", [ids.brandId])).rows[0],
      item: (
        await query<{ name: string; sku: string; tracking: string; brand_id: string; service_interval_months: number }>(
          "SELECT name, sku, tracking, brand_id, service_interval_months FROM items WHERE id = $1",
          [ids.itemId],
        )
      ).rows[0],
      attrs: (
        await query<{ reference_no: string; movement: string; water_resistance_m: number; gender: string }>(
          "SELECT reference_no, movement, water_resistance_m, gender FROM watch_item_attributes WHERE item_id = $1",
          [ids.itemId],
        )
      ).rows[0],
      serials: (await query<{ n: string }>("SELECT count(*)::text AS n FROM item_serials WHERE item_id = $1", [ids.itemId])).rows[0].n,
    }));
    expect(onDesktop.brand).toEqual({ name: "رولکس", country: "سوئیس" });
    expect(onDesktop.item).toEqual({
      name: "سابمارینر",
      sku: "SUB-1",
      tracking: "serial",
      brand_id: ids.brandId,
      service_interval_months: 36,
    });
    expect(onDesktop.attrs).toEqual({
      reference_no: "126610LN",
      movement: "automatic",
      water_resistance_m: 300,
      gender: "men",
    });
    // The physical unit did NOT travel: serialized stock is cloud-owned, so
    // exactly one side can ever move it to sold — a serial cannot sell twice
    // across devices because only the cloud sells it at all.
    expect(onDesktop.serials).toBe("0");
    const clockTables = await withTenant(biz.businessId, () =>
      query<{ table_name: string }>(
        "SELECT DISTINCT table_name FROM sync_row_clocks WHERE business_id = $1 AND table_name LIKE '%serial%'",
        [biz.businessId],
      ),
    );
    expect(clockTables.rows).toEqual([]);

    // ---- concurrent edits to DIFFERENT fields both survive ---------------
    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query("UPDATE watch_item_attributes SET movement = 'quartz' WHERE item_id = $1", [ids.itemId]),
      ),
    );
    await withTenant(biz.businessId, () =>
      query("UPDATE watch_item_attributes SET dial_color = 'مشکی' WHERE item_id = $1", [ids.itemId]),
    );
    await syncRound();
    await syncRound();
    const readAttrs = () =>
      withTenant(biz.businessId, () =>
        query<{ movement: string; dial_color: string }>(
          "SELECT movement, dial_color FROM watch_item_attributes WHERE item_id = $1",
          [ids.itemId],
        ),
      );
    const desktopAttrs = (await readAttrs()).rows[0];
    const cloudAttrs = (await onCentral(readAttrs)).rows[0];
    expect(desktopAttrs).toEqual({ movement: "quartz", dial_color: "مشکی" });
    expect(cloudAttrs).toEqual(desktopAttrs);

    // The serial in the cloud sells meanwhile; nothing about the unit leaks
    // into the desktop through the feed, and the settled feed moves nothing.
    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query("UPDATE item_serials SET status = 'sold', sold_at = now() WHERE id = $1", [ids.serialId]),
      ),
    );
    await syncRound();
    const stillNone = await withTenant(biz.businessId, () =>
      query<{ n: string }>("SELECT count(*)::text AS n FROM item_serials WHERE item_id = $1", [ids.itemId]),
    );
    expect(stillNone.rows[0].n).toBe("0");
    const quiet = await syncRound();
    expect(quiet.master).toEqual({ status: "ok", pushed: 0, pulled: 0 });
  });

  it("removes attributes everywhere when one side clears them (all-empty upsert deletes the row)", async () => {
    const itemId = await onCentral(() =>
      withTenant(biz.businessId, async () => {
        const item = await query<{ id: string }>(
          `INSERT INTO items (location_id, name, tracking) VALUES ($1, 'دیت‌جاست', 'serial') RETURNING id`,
          [biz.locationId],
        );
        await query(`INSERT INTO watch_item_attributes (item_id, movement) VALUES ($1, 'manual')`, [item.rows[0].id]);
        return item.rows[0].id;
      }),
    );
    await syncRound();
    const arrived = await withTenant(biz.businessId, () =>
      query<{ movement: string }>("SELECT movement FROM watch_item_attributes WHERE item_id = $1", [itemId]),
    );
    expect(arrived.rows[0]?.movement).toBe("manual");

    // The desktop clears the attributes; the tombstone travels back.
    await withTenant(biz.businessId, () =>
      query("DELETE FROM watch_item_attributes WHERE item_id = $1", [itemId]),
    );
    await syncRound();
    const onCloud = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ n: string }>("SELECT count(*)::text AS n FROM watch_item_attributes WHERE item_id = $1", [itemId]),
      ),
    );
    expect(onCloud.rows[0].n).toBe("0");
  });
});

describe("orders", () => {
  it("brings every change to an open bill to the cloud, not only its creation", async () => {
    const created = await withTenant(biz.businessId, () =>
      createOrder({
        locationId: biz.locationId,
        type: "takeaway",
        discount: { type: null },
        items: [{ menuItemId: biz.menuItemId, quantity: 1 }],
        openedBy: biz.ownerId,
        actorRole: "owner",
      }),
    );
    if (!created.ok) throw new Error(created.error);
    const orderId = created.data.id;
    const actor = { userId: biz.ownerId, role: "owner" as const };

    const added = await withTenant(biz.businessId, () =>
      addItemsToOrder({ locationId: biz.locationId, orderId, items: [{ menuItemId: biz.menuItemId, quantity: 2 }], actor }),
    );
    expect(added.ok).toBe(true);
    const firstLine = await withTenant(biz.businessId, () =>
      query<{ id: string }>("SELECT id FROM order_items WHERE order_id = $1 ORDER BY created_at, id LIMIT 1", [orderId]),
    );
    const edited = await withTenant(biz.businessId, () =>
      updateOrderItem({ locationId: biz.locationId, orderId, orderItemId: firstLine.rows[0].id, quantity: 3, actor }),
    );
    expect(edited.ok).toBe(true);

    const round = await syncRound();
    expect(round.push).toMatchObject({ status: "ok" });

    const bill = () =>
      withTenant(biz.businessId, () =>
        query<{ total: string; lines: string; units: string; order_number: string }>(
          `SELECT o.total::text, o.order_number::text,
                  (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.status <> 'voided')::text AS lines,
                  (SELECT sum(quantity) FROM order_items i WHERE i.order_id = o.id AND i.status <> 'voided')::text AS units
             FROM orders o WHERE o.id = $1`,
          [orderId],
        ),
      );
    const desktop = (await bill()).rows[0];
    const cloud = (await onCentral(bill)).rows[0];
    expect(desktop).toMatchObject({ lines: "2", units: "5" });
    expect(cloud).toEqual(desktop);
    // Same line ids on both sides: nothing had to be reconciled away.
    const voidedInCloud = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query("SELECT 1 FROM order_items WHERE order_id = $1 AND status = 'voided'", [orderId]),
      ),
    );
    expect(voidedInCloud.rowCount).toBe(0);
  });

  it("reconciles a bill whose creation came from an offline phone without line ids", async () => {
    // What an offline-queued phone sends: the order, but not its lines' ids.
    const orderId = randomUUID();
    const created = await withTenant(biz.businessId, () =>
      createOrder({
        locationId: biz.locationId,
        orderId,
        type: "takeaway",
        discount: { type: null },
        items: [{ menuItemId: biz.menuItemId, quantity: 1 }],
        openedBy: biz.ownerId,
        actorRole: "owner",
        recordSyncEvent: false,
      }),
    );
    if (!created.ok) throw new Error(created.error);
    await withTenant(biz.businessId, () =>
      query(
        `INSERT INTO sync_events (location_id, client_event_id, event_type, payload, occurred_at, applied_at,
                                  actor_user_id, actor_role, origin)
         VALUES ($1, $2, 'order.create', $3::jsonb, now(), now(), $4, 'owner', 'local')`,
        [
          biz.locationId,
          orderId,
          JSON.stringify({ orderId, type: "takeaway", discount: { type: null }, items: [{ menuItemId: biz.menuItemId, quantity: 1 }] }),
          biz.ownerId,
        ],
      ),
    );
    await withTenant(biz.businessId, () =>
      addItemsToOrder({
        locationId: biz.locationId,
        orderId,
        items: [{ menuItemId: biz.menuItemId, quantity: 1 }],
        actor: { userId: biz.ownerId, role: "owner" },
      }),
    );

    await syncRound();

    const active = () =>
      withTenant(biz.businessId, () =>
        query<{ id: string }>(
          "SELECT id FROM order_items WHERE order_id = $1 AND status <> 'voided' ORDER BY id",
          [orderId],
        ),
      );
    const desktopLines = (await active()).rows.map((row) => row.id);
    const cloudLines = (await onCentral(active)).rows.map((row) => row.id);
    expect(desktopLines).toHaveLength(2);
    expect(cloudLines).toEqual(desktopLines);
  });

  it("settles in the cloud a bill paid at the till after lines were added to it", async () => {
    const created = await withTenant(biz.businessId, () =>
      createOrder({
        locationId: biz.locationId,
        type: "takeaway",
        discount: { type: null },
        items: [{ menuItemId: biz.menuItemId, quantity: 1 }],
        openedBy: biz.ownerId,
        actorRole: "owner",
      }),
    );
    if (!created.ok) throw new Error(created.error);
    const orderId = created.data.id;
    await withTenant(biz.businessId, () =>
      addItemsToOrder({
        locationId: biz.locationId,
        orderId,
        items: [{ menuItemId: biz.menuItemId, quantity: 1 }],
        actor: { userId: biz.ownerId, role: "owner" },
      }),
    );
    const total = Number(
      (
        await withTenant(biz.businessId, () =>
          query<{ total: string }>("SELECT total::text FROM orders WHERE id = $1", [orderId]),
        )
      ).rows[0].total,
    );

    const { POST } = await import("../src/app/api/orders/[id]/pay/route");
    const response = await POST(
      new NextRequest(`http://localhost/api/orders/${orderId}/pay`, {
        method: "POST",
        body: JSON.stringify({ payments: [{ method: "cash", amount: total }] }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(response.status).toBe(200);

    const round = await syncRound();
    expect(round.push).toMatchObject({ status: "ok" });

    // Before order state, the cloud still held the one-line bill from
    // order.create and refused a payment for the two-line total.
    const settled = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ status: string; total: string; paid: string; entries: string }>(
          `SELECT o.status::text, o.total::text,
                  (SELECT coalesce(sum(amount), 0) FROM payments p WHERE p.order_id = o.id)::text AS paid,
                  (SELECT count(*) FROM journal_entries je WHERE je.source_type = 'order' AND je.source_id = o.id)::text AS entries
             FROM orders o WHERE o.id = $1`,
          [orderId],
        ),
      ),
    );
    expect(settled.rows[0]).toMatchObject({ status: "completed", total: String(total), paid: String(total) });
    expect(Number(settled.rows[0].entries)).toBeGreaterThan(0);

    // A correction to the paid bill at the till reaches the cloud's books too,
    // adding the very same line there.
    const lines = await withTenant(biz.businessId, () =>
      query<{ id: string; quantity: number }>(
        "SELECT id, quantity FROM order_items WHERE order_id = $1 AND status <> 'voided' ORDER BY created_at, id",
        [orderId],
      ),
    );
    const amend = await import("../src/app/api/orders/[id]/amend/route");
    const amended = await amend.POST(
      new NextRequest(`http://localhost/api/orders/${orderId}/amend`, {
        method: "POST",
        body: JSON.stringify({
          kind: "edit",
          reason: "یک اسپرسو دیگر",
          lines: [
            ...lines.rows.map((line) => ({ orderItemId: line.id, quantity: line.quantity })),
            { menuItemId: biz.menuItemId, quantity: 1 },
          ],
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(amended.status).toBe(200);
    await syncRound();

    const bill = () =>
      withTenant(biz.businessId, () =>
        query<{ total: string; ids: string[] }>(
          `SELECT o.total::text,
                  ARRAY(SELECT i.id::text FROM order_items i WHERE i.order_id = o.id AND i.status <> 'voided' ORDER BY i.id) AS ids
             FROM orders o WHERE o.id = $1`,
          [orderId],
        ),
      );
    const desktopBill = (await bill()).rows[0];
    expect(desktopBill.ids).toHaveLength(3);
    expect((await onCentral(bill)).rows[0]).toEqual(desktopBill);
  });

  it("delivers a bill rung up in the cloud to the branch", async () => {
    const orderId = await onCentral(async () => {
      const created = await withTenant(biz.businessId, () =>
        createOrder({
          locationId: biz.locationId,
          type: "takeaway",
          discount: { type: null },
          items: [{ menuItemId: biz.menuItemId, quantity: 1 }],
          openedBy: biz.ownerId,
          actorRole: "owner",
        }),
      );
      if (!created.ok) throw new Error(created.error);
      return created.data.id;
    });

    await syncRound();

    const onDesktop = await withTenant(biz.businessId, () =>
      query<{ status: string }>("SELECT status::text FROM orders WHERE id = $1", [orderId]),
    );
    expect(onDesktop.rows[0]?.status).toBe("open");
    // Replayed here, so it is not queued to go back up.
    const echoed = await withTenant(biz.businessId, () =>
      query("SELECT 1 FROM sync_events WHERE client_event_id = $1 AND origin = 'local'", [orderId]),
    );
    expect(echoed.rowCount).toBe(0);
  });

  it("acknowledges a cloud purchase instead of waiting forever for a supplier the desktop never gets (Phase 46)", async () => {
    const clientEventId = randomUUID();
    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query(
          `INSERT INTO sync_events
             (location_id, client_event_id, event_type, payload, occurred_at, applied_at, actor_user_id, actor_role, origin, schema_version)
           VALUES ($1, $2, 'inventory.purchase.created', $3, now(), now(), $4, 'owner', 'local', 1)`,
          [
            biz.locationId,
            clientEventId,
            JSON.stringify({
              purchaseId: randomUUID(),
              supplierId: randomUUID(),
              note: null,
              purchaseDate: null,
              items: [{ inventoryItemId: randomUUID(), purchaseQty: "1", totalCost: "1000" }],
            }),
            biz.ownerId,
          ],
        ),
      ),
    );

    await syncRound();

    const onDesktop = await withTenant(biz.businessId, () =>
      query<{ applied: boolean; status: string; effect_type: string }>(
        `SELECT se.applied_at IS NOT NULL AS applied, e.status, e.effect_type
           FROM sync_events se JOIN sync_domain_effects e ON e.client_event_id = se.client_event_id
          WHERE se.client_event_id = $1`,
        [clientEventId],
      ),
    );
    expect(onDesktop.rows[0]).toEqual({ applied: true, status: "applied", effect_type: "cloud_owned" });
  });
});

/** A signed-in till session for the owner on the desktop (openShift needs one). */
async function desktopTillSession(): Promise<string> {
  return withTenant(biz.businessId, async () => {
    await query("INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [biz.ownerId, biz.businessId]);
    const created = await query<{ id: string }>(
      `INSERT INTO employee_sessions (employee_id, business_id, location_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
      // token_hash is CHECKed to 64 characters (a sha256 hex).
      [biz.ownerId, biz.businessId, biz.locationId, (randomUUID() + randomUUID()).replaceAll("-", "")],
    );
    return created.rows[0].id;
  });
}

describe("shifts", () => {
  it("brings a shift opened and cashed up at the till to the cloud", async () => {
    const sessionId = await desktopTillSession();
    const opened = await withTenant(biz.businessId, () =>
      openShift(biz.ownerId, biz.businessId, sessionId, 5_000_000, biz.locationId, "owner"),
    );
    await withTenant(biz.businessId, () => closeOwnShift(biz.ownerId, biz.businessId, 7_500_000, "owner"));
    await syncRound();
    const cloud = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ employee_id: string; location_id: string; opening: string; closing: string; closed: boolean; session_id: string | null }>(
          `SELECT employee_id, location_id, opening_float::text AS opening, closing_float::text AS closing,
                  ended_at IS NOT NULL AS closed, session_id
             FROM employee_shifts WHERE id = $1`,
          [opened.id],
        ),
      ),
    );
    expect(cloud.rows[0]).toEqual({
      employee_id: biz.ownerId,
      location_id: biz.locationId,
      opening: "5000000",
      closing: "7500000",
      closed: true,
      session_id: null,
    });
  });

  it("refuses, visibly, a second open shift for the same person", async () => {
    const cloudShiftId = await onCentral(() =>
      withTenant(biz.businessId, async () => {
        await query("INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [biz.ownerId, biz.businessId]);
        return (
          await query<{ id: string }>(
            `INSERT INTO employee_shifts (employee_id, business_id, location_id, business_date)
             VALUES ($1, $2, $3, current_date) RETURNING id`,
            [biz.ownerId, biz.businessId, biz.locationId],
          )
        ).rows[0].id;
      }),
    );
    const sessionId = await desktopTillSession();
    const desktopShift = await withTenant(biz.businessId, () =>
      openShift(biz.ownerId, biz.businessId, sessionId, null, biz.locationId, "owner"),
    );
    await syncRound();
    const deadLetters = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ error_code: string }>(
          `SELECT error_code FROM sync_event_dead_letters WHERE business_id = $1 AND client_event_id = $2`,
          // The outbox stores the name-derived UUID of the identity.
          [biz.businessId, syncClientEventId(`shift.opened:${desktopShift.id}`)],
        ),
      ),
    );
    expect(deadLetters.rows.map((row) => row.error_code)).toEqual(["shift_already_open"]);
    // Tidy both sides so later tests start with nobody clocked in.
    await onCentral(() =>
      withTenant(biz.businessId, () => query("UPDATE employee_shifts SET ended_at = now() WHERE id = $1", [cloudShiftId])),
    );
    await withTenant(biz.businessId, () => closeOwnShift(biz.ownerId, biz.businessId, null, "owner"));
    // Deliver that cash-up too, so no unsent work is left for the drift check.
    await syncRound();
  });
});

describe("site profile", () => {
  // Each call here stands for a tick a full interval after the last one.
  const syncProfile = () => {
    resetSiteProfileGate();
    return withTenant(biz.businessId, () => runSiteProfileSync(biz.businessId));
  };

  it("asks the cloud at most once per sync interval, however often the tick wakes", async () => {
    const routed = globalThis.fetch;
    const spy = vi.fn(routed);
    globalThis.fetch = spy as typeof fetch;
    try {
      resetSiteProfileGate();
      const at = (ms: number) => withTenant(biz.businessId, () => runSiteProfileSync(biz.businessId, new Date(ms)));
      const start = Date.now();
      await at(start);
      await at(start + 1_500); // a NOTIFY wake right after a local commit
      expect(spy).toHaveBeenCalledTimes(1);
      await at(start + 30_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = routed;
    }
  });

  it("brings the branch's business-day start, so both sides put an after-midnight bill on the same day", async () => {
    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query("UPDATE locations SET business_day_start_minutes = 1080 WHERE id = $1", [biz.locationId]),
      ),
    );
    await syncProfile();
    const desktop = await withTenant(biz.businessId, () =>
      query<{ start: number | null; day: string }>(
        `SELECT business_day_start_minutes AS start,
                app_business_date('2026-09-30T00:30:00+03:30'::timestamptz, timezone, business_day_start_minutes)::text AS day
           FROM locations WHERE id = $1`,
        [biz.locationId],
      ),
    );
    expect(desktop.rows[0]).toEqual({ start: 1080, day: "2026-09-29" });
  });

  it("follows the cloud's switches: the assistant on, then off, and an app under maintenance", async () => {
    const setAssistant = (enabled: boolean) =>
      onCentral(() =>
        withTenant(biz.businessId, () =>
          query(
            `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'ai_assistant', $2)
             ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [biz.businessId, enabled],
          ),
        ),
      );
    await setAssistant(true);
    await syncProfile();
    expect((await withTenant(biz.businessId, () => effectiveFeatures(biz.businessId))).ai_assistant).toBe(true);
    await setAssistant(false);
    await syncProfile();
    expect((await withTenant(biz.businessId, () => effectiveFeatures(biz.businessId))).ai_assistant).toBe(false);

    // An unchanged profile is still applied: a local edit to the cloud's copy is repaired.
    await withTenant(biz.businessId, () =>
      query("DELETE FROM business_features WHERE business_id = $1 AND flag_key = 'ai_assistant'", [biz.businessId]),
    );
    await syncProfile();
    const restored = await withTenant(biz.businessId, () =>
      query<{ enabled: boolean }>(
        "SELECT enabled FROM business_features WHERE business_id = $1 AND flag_key = 'ai_assistant'",
        [biz.businessId],
      ),
    );
    expect(restored.rows).toEqual([{ enabled: false }]);

    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query(
          `INSERT INTO business_app_availability (business_id, app_key, state) VALUES ($1, 'growth', 'maintenance')
           ON CONFLICT (business_id, app_key) DO UPDATE SET state = EXCLUDED.state`,
          [biz.businessId],
        ),
      ),
    );
    await syncProfile();
    expect((await withTenant(biz.businessId, () => effectiveAppAvailability(biz.businessId))).growth.state).toBe("maintenance");
  });

  it("keeps the last copy and backs off when the cloud refuses", async () => {
    const routed = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("", { status: 502 })) as typeof fetch;
    try {
      const failed = await syncProfile();
      expect(failed.lastError).toBe("site_profile_rejected: HTTP 502");
      expect(failed.nextAttemptAt).not.toBeNull();
      expect(failed.hash).not.toBeNull();
      const start = await withTenant(biz.businessId, () =>
        query<{ start: number | null }>("SELECT business_day_start_minutes AS start FROM locations WHERE id = $1", [biz.locationId]),
      );
      expect(start.rows[0].start).toBe(1080);
      // Inside the backoff window the cloud is not asked again.
      await syncProfile();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = routed;
      await withTenant(biz.businessId, () => setSetting(biz.businessId, SETTING_KEYS.siteProfileState, EMPTY_SITE_PROFILE_STATE));
    }
  });
});

describe("drift check", () => {
  it("finds the two sides agreeing on settled days, and reports a day that differs", async () => {
    // Settled bills from the tests above, moved to yesterday on both sides so
    // they fall inside the compared window (today is still trading).
    const backdate = () =>
      withTenant(biz.businessId, () =>
        query("UPDATE orders SET opened_at = opened_at - interval '1 day' WHERE status = 'completed'"),
      );
    await backdate();
    await onCentral(backdate);
    const { runDriftCheck } = await import("../src/lib/sync-health-service");
    const now = new Date();

    const agreed = await withTenant(biz.businessId, () => runDriftCheck(biz.businessId, now));
    expect(agreed).toMatchObject({ status: "ok", days: [] });

    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query("UPDATE orders SET total = total + 10 WHERE status = 'completed' AND sync_state_hlc IS NOT NULL"),
      ),
    );
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    const drifted = await withTenant(biz.businessId, () => runDriftCheck(biz.businessId, later));
    expect(drifted.status).toBe("drift");
    expect(drifted.days).toHaveLength(1);

    const { getSyncHealth } = await import("../src/lib/sync-health-service");
    const health = await withTenant(biz.businessId, () => getSyncHealth(biz.businessId, later));
    expect(health.level).toBe("error");
    expect(health.issues.map((issue) => issue.code)).toContain("drift");
  });
});

describe("the pull cursor", () => {
  it("never hands out a row ahead of an earlier one that is still committing", async () => {
    await onCentral(async () => {
      const pool = getPool();
      const slow = await pool.connect();
      const fast = await pool.connect();
      const insert = (client: typeof slow) =>
        client.query(
          `INSERT INTO sync_events (location_id, client_event_id, event_type, payload, occurred_at, applied_at, origin)
           VALUES ($1, $2, 'order_item.status', '{}'::jsonb, now(), now(), 'local') RETURNING id::text, txid::text`,
          [biz.locationId, randomUUID()],
        );
      try {
        await slow.query("SELECT set_config('app.rls_bypass', 'on', false)");
        await fast.query("SELECT set_config('app.rls_bypass', 'on', false)");
        const { rows: cursorRows } = await slow.query<{ txid: string }>(
          "SELECT coalesce(max(txid)::text, '0') AS txid FROM sync_events",
        );
        const cursor = cursorRows[0].txid;

        await slow.query("BEGIN");
        const early = (await insert(slow)).rows[0];
        const late = (await insert(fast)).rows[0]; // autocommits
        expect(Number(late.id)).toBeGreaterThan(Number(early.id));

        // The later row has committed, the earlier one has not: a reader must
        // not move past the earlier one's position.
        const visibleWhileOpen = await fast.query<{ id: string }>(
          `SELECT id::text FROM sync_events
            WHERE txid > $1::xid8 AND txid < pg_snapshot_xmin(pg_current_snapshot())`,
          [cursor],
        );
        expect(visibleWhileOpen.rows.map((row) => row.id)).not.toContain(late.id);

        await slow.query("COMMIT");
        const visibleAfter = await fast.query<{ id: string }>(
          `SELECT id::text FROM sync_events
            WHERE txid > $1::xid8 AND txid < pg_snapshot_xmin(pg_current_snapshot())
            ORDER BY txid, id`,
          [cursor],
        );
        expect(visibleAfter.rows.map((row) => row.id)).toEqual([early.id, late.id]);
      } finally {
        await slow.query("ROLLBACK").catch(() => {});
        slow.release();
        fast.release();
      }
    });
  });
});
