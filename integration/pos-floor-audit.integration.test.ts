/**
 * Issue #913 (POS cashier audit) — the fixes that only prove themselves
 * against real rows, in one fresh database per run:
 *
 *  P1-6  voiding / moving / detaching the LAST open order of a table session
 *        releases that session (and frees its tables) exactly like payment
 *        does — while a session with surviving orders stays seated, and the
 *        `table_session.updated` broadcast fires only for what was released.
 *  P1-4  promotions are applied at CREATION, snapshotted on the order
 *        (`orders.promotion_ids` + `opened_at`), and re-evaluated under that
 *        frozen eligibility on every amendment — a campaign paused or
 *        activated mid-order cannot change an agreed bill — with the
 *        `promotion_applications` audit rewritten atomically each time.
 *  P2-11 tax is frozen per line when the line enters the order
 *        (`order_items.tax_rate_snapshot`); a later category-rate change
 *        prices new lines only, and recompute reads the snapshot.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const h = vi.hoisted(() => ({
  broadcasts: [] as Array<{ type: string; sessionId?: string; orderId?: string }>,
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => unknown) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));

vi.mock("@/lib/realtime", () => ({
  broadcast: vi.fn((locationId: string, event: Record<string, unknown>) => {
    h.broadcasts.push(event as { type: string });
  }),
}));

vi.mock("@/lib/notification-events", () => ({
  recordNotification: vi.fn(),
}));

vi.mock("@/lib/order-state-sync", () => ({
  recordOrderState: vi.fn(),
}));

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let orderMutations: typeof import("../src/lib/order-mutations");
let auth: typeof import("../src/lib/auth");
let setupState: typeof import("../src/lib/setup-state");

interface Floor {
  businessId: string;
  locationId: string;
  categoryId: string;
  menuItemId: string;
  tableOneId: string;
  tableTwoId: string;
  userId: string;
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

async function createFloor(): Promise<Floor> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Floor Audit ${randomUUID().slice(0, 6)}`, `floor-audit-${randomUUID().slice(0, 8)}`],
  );
  const businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'چای', 10) RETURNING id",
    [locationId],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'چای کوچک', 600000) RETURNING id",
    [locationId, category.rows[0].id],
  );
  const t1 = await db.query<{ id: string }>(
    "INSERT INTO dining_tables (location_id, name) VALUES ($1, 'میز ۱') RETURNING id",
    [locationId],
  );
  const t2 = await db.query<{ id: string }>(
    "INSERT INTO dining_tables (location_id, name) VALUES ($1, 'میز ۲') RETURNING id",
    [locationId],
  );
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'cashier', 'صندوقچی', 'x') RETURNING id`,
    [businessId],
  );
  return {
    businessId,
    locationId,
    categoryId: category.rows[0].id,
    menuItemId: item.rows[0].id,
    tableOneId: t1.rows[0].id,
    tableTwoId: t2.rows[0].id,
    userId: user.rows[0].id,
  };
}

async function openTableOrder(floor: Floor, tableId: string) {
  const result = await dbLib.withTenant(floor.businessId, () =>
    orderMutations.createOrder({
      locationId: floor.locationId,
      type: "dine_in",
      tableId,
      discount: { type: null },
      items: [{ menuItemId: floor.menuItemId, quantity: 1 }],
      openedBy: null,
      clientRequestId: randomUUID(),
    }),
  );
  if (!result.ok) throw new Error(`createOrder failed: ${result.error}`);
  return result.data;
}

function patchRequest(body: unknown) {
  return { json: async () => body } as never;
}

function patchContext(id: string) {
  return { params: Promise.resolve({ id }) } as never;
}

async function sessionOf(orderId: string): Promise<{ id: string; status: string } | null> {
  const { rows } = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM table_sessions WHERE id = (SELECT table_session_id FROM orders WHERE id = $1)",
    [orderId],
  );
  return rows[0] ?? null;
}

async function tableStatus(tableId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    "SELECT status FROM dining_tables WHERE id = $1",
    [tableId],
  );
  return rows[0].status;
}

beforeAll(async () => {
  databaseName = `pos_flooraudit_${randomUUID().replaceAll("-", "")}`;

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
  orderMutations = await import("../src/lib/order-mutations");
  auth = await import("../src/lib/auth");
  setupState = await import("../src/lib/setup-state");

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

beforeEach(() => {
  h.broadcasts.length = 0;
  const uuid = "00000000-0000-4000-8000-0000000000ff";
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: { businessId: "", sub: uuid, role: "cashier" },
    error: null,
  } as never);
});

describe("P1-6 — voiding an open order reconciles its table session", () => {
  async function allow(...permissions: string[]) {
    return allowAs("cashier", ...permissions);
  }
  /**
   * Whole-order void is additionally gated by the order-control policy
   * (`wholeOrderVoidRequiresManager`), which is a *role* rule on top of the
   * `orders.void` key this file's P1-6 tests exercise; the two void tests
   * therefore act as a manager, the move/detach tests stay cashiers.
   */
  async function allowAs(role: "cashier" | "manager", ...permissions: string[]) {
    const allowed = new Set(permissions);
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (allowed.has(permission)) {
        return {
          session: { businessId: floorHolder!.businessId, sub: floorHolder!.userId, role },
          error: null,
        } as never;
      }
      const { NextResponse } = await import("next/server");
      return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never;
    }) as never);
  }
  let floorHolder: Floor | null = null;

  it("frees the table and closes the session when the last open order is voided", async () => {
    const floor = await createFloor();
    floorHolder = floor;
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: floor.locationId } as never);

    const order = await openTableOrder(floor, floor.tableOneId);
    const session = await sessionOf(order.id);
    expect(session?.status).toBe("open");

    await allowAs("manager", "orders.create", "orders.void");
    const { PATCH } = await import("../src/app/api/orders/[id]/route");
    const res = await PATCH(patchRequest({ void: { reason: "ریختن نوشیدنی" } }), patchContext(order.id));
    expect(res.status).toBe(200);

    const after = await sessionOf(order.id);
    expect(after?.status).toBe("closed");
    expect(await tableStatus(floor.tableOneId)).toBe("free");

    const { rows: orderRow } = await db.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.id],
    );
    expect(orderRow[0].status).toBe("voided");

    // The floor hears about it exactly like the payment path announces it.
    expect(h.broadcasts).toContainEqual({ type: "order.updated", orderId: order.id });
    expect(h.broadcasts).toContainEqual({ type: "table_session.updated", sessionId: session!.id });
  });

  it("keeps the session seated while another open order survives the void", async () => {
    const floor = await createFloor();
    floorHolder = floor;
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: floor.locationId } as never);

    const first = await openTableOrder(floor, floor.tableOneId);
    const second = await openTableOrder(floor, floor.tableOneId);
    // Both rounds share the session.
    expect((await sessionOf(second.id))!.id).toBe((await sessionOf(first.id))!.id);
    const session = await sessionOf(first.id);

    await allowAs("manager", "orders.create", "orders.void");
    const { PATCH } = await import("../src/app/api/orders/[id]/route");
    const res = await PATCH(patchRequest({ void: { reason: "مشتری رفت" } }), patchContext(first.id));
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM table_sessions WHERE id = $1",
      [session!.id],
    );
    expect(rows[0].status).toBe("open");
    expect(await tableStatus(floor.tableOneId)).not.toBe("free");
    expect(h.broadcasts.filter((b) => b.type === "table_session.updated")).toHaveLength(0);
  });

  it("releases the OLD session when a last order moves to another table, and joins the new one", async () => {
    const floor = await createFloor();
    floorHolder = floor;
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: floor.locationId } as never);

    const mover = await openTableOrder(floor, floor.tableOneId);
    const occupant = await openTableOrder(floor, floor.tableTwoId);
    const oldSession = await sessionOf(mover.id);
    const newSession = await sessionOf(occupant.id);
    expect(oldSession!.id).not.toBe(newSession!.id);

    await allow("orders.create", "orders.void", "orders.discount");
    const { PATCH } = await import("../src/app/api/orders/[id]/route");
    const res = await PATCH(patchRequest({ tableId: floor.tableTwoId }), patchContext(mover.id));
    expect(res.status).toBe(200);

    const { rows: oldRows } = await db.query<{ status: string }>(
      "SELECT status FROM table_sessions WHERE id = $1",
      [oldSession!.id],
    );
    expect(oldRows[0].status).toBe("closed");
    expect(await tableStatus(floor.tableOneId)).toBe("free");

    const { rows: newRows } = await db.query<{ status: string }>(
      "SELECT status FROM table_sessions WHERE id = $1",
      [newSession!.id],
    );
    expect(newRows[0].status).toBe("open");
    const { rows: moved } = await db.query<{ table_session_id: string }>(
      "SELECT table_session_id FROM orders WHERE id = $1",
      [mover.id],
    );
    expect(moved[0].table_session_id).toBe(newSession!.id);
    expect(h.broadcasts).toContainEqual({ type: "table_session.updated", sessionId: oldSession!.id });
  });

  it("preserves the old session when a sibling order still sits at the table", async () => {
    const floor = await createFloor();
    floorHolder = floor;
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: floor.locationId } as never);

    const stay = await openTableOrder(floor, floor.tableOneId);
    const mover = await openTableOrder(floor, floor.tableOneId);
    const session = await sessionOf(stay.id);

    await allow("orders.create", "orders.void", "orders.discount");
    const { PATCH } = await import("../src/app/api/orders/[id]/route");
    const res = await PATCH(patchRequest({ tableId: floor.tableTwoId }), patchContext(mover.id));
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM table_sessions WHERE id = $1",
      [session!.id],
    );
    expect(rows[0].status).toBe("open");
    expect(await tableStatus(floor.tableOneId)).not.toBe("free");
  });
});

describe("P1-4 — creation pricing and frozen promotion eligibility", () => {
  async function insertPromotion(businessId: string, percent: number, active = true): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO promotions (business_id, name, kind, value, is_active)
       VALUES ($1, 'چای ۱۰٪', 'percent', $2, $3) RETURNING id`,
      [businessId, percent, active],
    );
    return rows[0].id;
  }

  it("applies the campaign AT CREATION and snapshots it on the order", async () => {
    const floor = await createFloor();
    const promotionId = await insertPromotion(floor.businessId, 10);

    const order = await openTableOrder(floor, floor.tableOneId);
    const { rows } = await db.query<{
      discount: string;
      subtotal: string;
      tax: string;
      total: string;
      promotion_ids: string[] | null;
    }>(
      "SELECT discount::text, subtotal::text, tax::text, total::text, promotion_ids FROM orders WHERE id = $1",
      [order.id],
    );
    // 600000 − 10% = 540000 + 10% VAT on the discounted share.
    expect(Number(rows[0].subtotal)).toBe(600_000);
    expect(Number(rows[0].discount)).toBe(60_000);
    expect(Number(rows[0].tax)).toBe(54_000);
    expect(Number(rows[0].total)).toBe(594_000);
    expect(rows[0].promotion_ids).toEqual([promotionId]);

    const { rows: apps } = await db.query<{ discount_rial: string }>(
      `SELECT discount_rial::text FROM promotion_applications
        WHERE source_type = 'order' AND source_id = $1 AND promotion_id = $2`,
      [order.id, promotionId],
    );
    expect(apps).toHaveLength(1);
    expect(Number(apps[0].discount_rial)).toBe(60_000);
  });

  it("keeps pricing the open bill under its SNAPSHOT when the campaign is paused mid-order", async () => {
    const floor = await createFloor();
    const promotionId = await insertPromotion(floor.businessId, 10);

    const order = await openTableOrder(floor, floor.tableOneId);

    // The manager pauses the campaign while the table is still eating…
    await db.query("UPDATE promotions SET is_active = false WHERE id = $1", [promotionId]);

    // …and an amendment re-prices the order (add a round).
    const added = await dbLib.withTenant(floor.businessId, () =>
      orderMutations.addItemsToOrder({
        locationId: floor.locationId,
        orderId: order.id,
        items: [{ menuItemId: floor.menuItemId, quantity: 1 }],
      }),
    );
    expect(added.ok).toBe(true);

    const { rows } = await db.query<{ discount: string; total: string }>(
      "SELECT discount::text, total::text FROM orders WHERE id = $1",
      [order.id],
    );
    // The frozen candidate set still evaluates: 10% of 1200000.
    expect(Number(rows[0].discount)).toBe(120_000);
    expect(Number(rows[0].total)).toBe(1_188_000);

    // The audit trail was rewritten WITH the totals, not alongside them —
    // one row per discounted line, exactly like retail's own applications.
    const { rows: apps } = await db.query<{ discount_rial: string }>(
      `SELECT discount_rial::text FROM promotion_applications WHERE source_type = 'order' AND source_id = $1`,
      [order.id],
    );
    expect(apps).toHaveLength(2);
    const auditSum = apps.reduce((sum, row) => sum + Number(row.discount_rial), 0);
    expect(auditSum).toBe(120_000);
  });

  it("never lets a campaign activated AFTER opening join an open order", async () => {
    const floor = await createFloor();
    // Opened under an empty snapshot — no campaign existed yet.
    const order = await openTableOrder(floor, floor.tableOneId);
    const { rows: before } = await db.query<{ promotion_ids: string[] | null }>(
      "SELECT promotion_ids FROM orders WHERE id = $1",
      [order.id],
    );
    expect(before[0].promotion_ids).toEqual([]);

    const promotionId = await insertPromotion(floor.businessId, 50);

    const added = await dbLib.withTenant(floor.businessId, () =>
      orderMutations.addItemsToOrder({
        locationId: floor.locationId,
        orderId: order.id,
        items: [{ menuItemId: floor.menuItemId, quantity: 1 }],
      }),
    );
    expect(added.ok).toBe(true);

    const { rows } = await db.query<{ discount: string; promotion_ids: string[] }>(
      "SELECT discount::text, promotion_ids FROM orders WHERE id = $1",
      [order.id],
    );
    expect(Number(rows[0].discount)).toBe(0);
    expect(rows[0].promotion_ids).toEqual([]);
    const { rows: apps } = await db.query(
      "SELECT 1 FROM promotion_applications WHERE source_type = 'order' AND source_id = $1",
      [order.id],
    );
    expect(apps).toHaveLength(0);
    expect(promotionId).toBeTruthy();
  });
});

describe("issue #1123 — a cashier adds a round to an order the kitchen already holds", () => {
  it("appends the new line once, keeps the sent line, and still refuses editing the sent line", async () => {
    const floor = await createFloor();
    const order = await openTableOrder(floor, floor.tableOneId);
    const actor = { userId: floor.userId, role: "cashier" as const, businessId: floor.businessId };

    const { rows: sent } = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM order_items WHERE order_id = $1",
      [order.id],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("sent");

    const added = await dbLib.withTenant(floor.businessId, () =>
      orderMutations.addItemsToOrder({
        locationId: floor.locationId,
        orderId: order.id,
        items: [{ menuItemId: floor.menuItemId, quantity: 2 }],
        actor,
      }),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.data.itemIds).toHaveLength(1);

    const { rows: lines } = await db.query<{ id: string; quantity: number }>(
      "SELECT id, quantity FROM order_items WHERE order_id = $1 AND status <> 'voided' ORDER BY created_at",
      [order.id],
    );
    expect(lines.map((line) => Number(line.quantity))).toEqual([1, 2]);
    expect(lines[0].id).toBe(sent[0].id);

    // Creation queued the first line; the append queues only the new one, so
    // the kitchen is never sent the line it already holds a second time.
    const { rows: jobs } = await db.query<{ item_ids: string[] }>(
      "SELECT item_ids FROM kitchen_dispatch_jobs WHERE order_id = $1 ORDER BY created_at",
      [order.id],
    );
    expect(jobs.map((job) => job.item_ids)).toEqual([[sent[0].id], added.data.itemIds]);

    // Changing a line the kitchen already holds is still a manager decision.
    const edited = await dbLib.withTenant(floor.businessId, () =>
      orderMutations.updateOrderItem({
        locationId: floor.locationId,
        orderId: order.id,
        orderItemId: sent[0].id,
        quantity: 5,
        actor,
      }),
    );
    expect(edited).toMatchObject({ ok: false, error: "manager_approval_required", status: 403 });
  });
});

describe("P2-11 — the tax rate is frozen when a line enters the order", () => {
  it("keeps old lines at their snapshot while a category-rate change prices new lines only", async () => {
    const floor = await createFloor();
    const order = await openTableOrder(floor, floor.tableOneId);

    const { rows: firstLine } = await db.query<{ tax_rate_snapshot: string }>(
      `SELECT tax_rate_snapshot::text FROM order_items WHERE order_id = $1`,
      [order.id],
    );
    expect(Number(firstLine[0].tax_rate_snapshot)).toBe(10);

    // The category's rate changes mid-shift…
    await db.query("UPDATE menu_categories SET tax_rate = 20 WHERE id = $1", [floor.categoryId]);

    // …an amendment adds a line and re-prices the order.
    const added = await dbLib.withTenant(floor.businessId, () =>
      orderMutations.addItemsToOrder({
        locationId: floor.locationId,
        orderId: order.id,
        items: [{ menuItemId: floor.menuItemId, quantity: 1 }],
      }),
    );
    expect(added.ok).toBe(true);

    const { rows: orderRow } = await db.query<{ tax: string; total: string }>(
      "SELECT tax::text, total::text FROM orders WHERE id = $1",
      [order.id],
    );
    // Old line: 600000 @ 10% = 60000. New line: 600000 @ 20% = 120000.
    expect(Number(orderRow[0].tax)).toBe(180_000);
    expect(Number(orderRow[0].total)).toBe(1_380_000);

    const { rows: lines } = await db.query<{ tax_rate_snapshot: string }>(
      "SELECT tax_rate_snapshot::text FROM order_items WHERE order_id = $1 ORDER BY created_at, id",
      [order.id],
    );
    expect(lines.map((l) => Number(l.tax_rate_snapshot)).sort()).toEqual([10, 20]);

    // And the session-level bill (same lines, same math) agrees with the order.
    const { computeSessionBill } = await import("../src/lib/table-session-service");
    const { rows: sessionRows } = await db.query<{ table_session_id: string }>(
      "SELECT table_session_id FROM orders WHERE id = $1",
      [order.id],
    );
    const bill = await computeSessionBill(sessionRows[0].table_session_id);
    expect(bill.total).toBe(1_380_000);
  });
});
