/**
 * ESH-147 / biza-miz#1305 — table QR identity, against real rows.
 *
 * The properties that only a database can prove:
 *
 *  - one active print per table, even when two staff tabs generate at once;
 *  - rotation and revocation retire the old print without losing its history;
 *  - the token names one tenant/site/location/table, and a token from business
 *    B can never be submitted to business A's intake;
 *  - a QR order is a real `dine_in` order on the token's table, created through
 *    the shared `createOrder()` — with `reservations` OFF as long as `dine_in`
 *    is on — sharing the visit session with every other order on that table;
 *  - the customer's body cannot substitute a table;
 *  - settling an order leaves the table seated (it is not "free until paid").
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

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
let qr: typeof import("../src/lib/table-qr-service");
let tableSessions: typeof import("../src/lib/table-session-service");

interface Tenant {
  businessId: string;
  locationId: string;
  secondLocationId: string;
  menuItemId: string;
  freeTableId: string;
  otherTableId: string;
  cleaningTableId: string;
  outOfServiceTableId: string;
  archivedTableId: string;
  siteId: string;
  siteDomain: string;
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

async function createTenant(label: string, opts: { dineIn?: boolean } = {}): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `qr-${label}-${suffix}`;
  const siteDomain = `${label}-${suffix}.example`;
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
    [`QR ${label}`, slug],
  );
  const businessId = biz.rows[0].id;

  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name, is_active) VALUES ($1, 'کافهٔ مرکزی', true) RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const closed = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name, is_active) VALUES ($1, 'شعبهٔ تعطیل', false) RETURNING id",
    [businessId],
  );
  const secondLocationId = closed.rows[0].id;

  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'نوشیدنی', 9) RETURNING id",
    [locationId],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'لاته', 850000) RETURNING id",
    [locationId, category.rows[0].id],
  );

  async function table(name: string, status: string, isActive = true) {
    const res = await db.query<{ id: string }>(
      "INSERT INTO dining_tables (location_id, name, status, is_active) VALUES ($1, $2, $3, $4) RETURNING id",
      [locationId, name, status, isActive],
    );
    return res.rows[0].id;
  }

  const free = await table("میز ۱", "free");
  const other = await table("میز ۲", "free");
  const cleaning = await table("میز ۳", "cleaning");
  const oos = await table("میز ۴", "out_of_service");
  const archived = await table("میز ۵", "free", false);

  await db.query(
    "INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext, status) VALUES ($1, $2, $3, 'https://cms.example', 'x', 'active')",
    [businessId, `site-${label}-${suffix}`, siteDomain],
  );

  // The entitlement pair the ticket is about: table service independent of
  // reservations. Every other flag keeps its catalogue default.
  const features: [string, boolean][] = [
    ["dine_in", opts.dineIn ?? true],
    ["reservations", false],
  ];
  for (const [key, enabled] of features) {
    await db.query(
      `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [businessId, key, enabled],
    );
  }

  return {
    businessId,
    locationId,
    secondLocationId,
    menuItemId: item.rows[0].id,
    freeTableId: free,
    otherTableId: other,
    cleaningTableId: cleaning,
    outOfServiceTableId: oos,
    archivedTableId: archived,
    siteId: `site-${label}-${suffix}`,
    siteDomain,
  };
}

async function issueToken(
  tenant: Tenant,
  tableId: string,
): Promise<{ token: string; tokenId: string; prefix: string }> {
  const created = await dbLib.withTenant(tenant.businessId, () =>
    qr.ensureTableQrToken({
      businessId: tenant.businessId,
      locationId: tenant.locationId,
      tableId,
      userId: null,
    }),
  );
  const print = await dbLib.withTenant(tenant.businessId, () =>
    qr.tableQrPrintPayload({
      businessId: tenant.businessId,
      locationId: tenant.locationId,
      tableId,
    }),
  );
  if (!print) throw new Error("token payload missing");
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM table_qr_tokens WHERE token_hash = $1",
    [createHash("sha256").update(print.token).digest("hex")],
  );
  return { token: print.token, tokenId: rows[0].id, prefix: created.state.prefix };
}

function qrOrder(
  tenant: Tenant,
  token: string,
  extra: Partial<Parameters<typeof qr.createDineInOrderFromTableQr>[0]> = {},
) {
  return dbLib.withTenant(tenant.businessId, () =>
    qr.createDineInOrderFromTableQr({
      token,
      businessId: tenant.businessId,
      items: [{ menuItemId: tenant.menuItemId, quantity: 1 }],
      openedBy: null,
      clientRequestId: randomUUID(),
      ...extra,
    }),
  );
}

async function orderRow(orderId: string) {
  const { rows } = await db.query<{
    type: string;
    table_id: string | null;
    table_session_id: string | null;
    table_qr_token_id: string | null;
    status: string;
    location_id: string;
  }>("SELECT type, table_id, table_session_id, table_qr_token_id, status, location_id FROM orders WHERE id = $1", [
    orderId,
  ]);
  return rows[0];
}

beforeAll(async () => {
  databaseName = `table_qr_${randomUUID().replaceAll("-", "")}`;
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
  qr = await import("../src/lib/table-qr-service");
  tableSessions = await import("../src/lib/table-session-service");

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
  vi.clearAllMocks();
});

describe("staff print lifecycle", () => {
  it("creates one active print and never exposes the token or a uuid in its state", async () => {
    const tenant = await createTenant("create");
    const first = await dbLib.withTenant(tenant.businessId, () =>
      qr.ensureTableQrToken({
        businessId: tenant.businessId,
        locationId: tenant.locationId,
        tableId: tenant.freeTableId,
        userId: null,
      }),
    );
    expect(first.created).toBe(true);
    expect(first.state.prefix).toMatch(/^tqr_[A-Za-z0-9_-]{6}$/);
    expect(first.state.siteConnected).toBe(true);
    expect(first.state.menuUrl).toBe(`https://${tenant.siteDomain}/menu`);
    expect(JSON.stringify(first)).not.toContain(tenant.freeTableId);

    const second = await dbLib.withTenant(tenant.businessId, () =>
      qr.ensureTableQrToken({
        businessId: tenant.businessId,
        locationId: tenant.locationId,
        tableId: tenant.freeTableId,
        userId: null,
      }),
    );
    expect(second.created).toBe(false);
    expect(second.state.prefix).toBe(first.state.prefix);

    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM table_qr_tokens WHERE table_id = $1 AND status = 'active'",
      [tenant.freeTableId],
    );
    expect(rows[0].count).toBe("1");
  });

  it("serialises concurrent generation into a single print", async () => {
    const tenant = await createTenant("race");
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        dbLib.withTenant(tenant.businessId, () =>
          qr.ensureTableQrToken({
            businessId: tenant.businessId,
            locationId: tenant.locationId,
            tableId: tenant.freeTableId,
            userId: null,
          }),
        ),
      ),
    );
    expect(attempts.filter((a) => a.created)).toHaveLength(1);
    expect(new Set(attempts.map((a) => a.state.prefix)).size).toBe(1);
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM table_qr_tokens WHERE table_id = $1",
      [tenant.freeTableId],
    );
    expect(rows[0].count).toBe("1");
  });

  it("rotates: the old print stops resolving and the history survives", async () => {
    const tenant = await createTenant("rotate");
    const old = await issueToken(tenant, tenant.freeTableId);
    expect((await qr.resolveTableQrToken(old.token)).ok).toBe(true);

    const rotated = await dbLib.withTenant(tenant.businessId, () =>
      qr.rotateTableQrToken({
        businessId: tenant.businessId,
        locationId: tenant.locationId,
        tableId: tenant.freeTableId,
        userId: null,
      }),
    );
    expect(rotated.prefix).not.toBe(old.prefix);
    expect(rotated.rotatedFromPrefix).toBe(old.prefix);

    const refused = await qr.resolveTableQrToken(old.token);
    expect(refused).toMatchObject({ ok: false, reason: "token_rotated", status: 410 });

    const current = await dbLib.withTenant(tenant.businessId, () =>
      qr.tableQrPrintPayload({
        businessId: tenant.businessId,
        locationId: tenant.locationId,
        tableId: tenant.freeTableId,
      }),
    );
    expect(current).not.toBeNull();
    expect((await qr.resolveTableQrToken(current!.token)).ok).toBe(true);

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM table_qr_tokens WHERE table_id = $1 ORDER BY created_at",
      [tenant.freeTableId],
    );
    expect(rows.map((r) => r.status)).toEqual(["rotated", "active"]);
  });

  it("revokes: the print stops resolving and a second revoke is a no-op", async () => {
    const tenant = await createTenant("revoke");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const first = await dbLib.withTenant(tenant.businessId, () =>
      qr.revokeTableQrToken({
        businessId: tenant.businessId,
        locationId: tenant.locationId,
        tableId: tenant.freeTableId,
        userId: null,
      }),
    );
    expect(first).toBe(true);
    expect(await qr.resolveTableQrToken(issued.token)).toMatchObject({
      ok: false,
      reason: "token_revoked",
    });
    const again = await dbLib.withTenant(tenant.businessId, () =>
      qr.revokeTableQrToken({
        businessId: tenant.businessId,
        locationId: tenant.locationId,
        tableId: tenant.freeTableId,
        userId: null,
      }),
    );
    expect(again).toBe(false);
  });
});

describe("resolution", () => {
  it("names the right tenant/site/location/table and no ids", async () => {
    const tenant = await createTenant("resolve");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const resolved = await qr.resolveTableQrToken(issued.token);
    expect(resolved).toMatchObject({
      ok: true,
      siteId: tenant.siteId,
      table: { name: "میز ۱" },
      location: { name: "کافهٔ مرکزی" },
      serviceMode: "dine_in",
      sessionOpen: false,
    });
    expect(JSON.stringify(resolved)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("answers an ordinary unknown print as 404 without leaking existence", async () => {
    expect(await qr.resolveTableQrToken("not-a-token")).toMatchObject({
      ok: false,
      reason: "invalid_token",
      status: 404,
    });
    expect(await qr.resolveTableQrToken(`tqr_${"z".repeat(32)}`)).toMatchObject({
      ok: false,
      reason: "unknown_token",
      status: 404,
    });
  });

  it("refuses a print from another site (site_mismatch)", async () => {
    const a = await createTenant("sitea");
    const b = await createTenant("siteb");
    const issued = await issueToken(a, a.freeTableId);
    expect(await qr.resolveTableQrToken(issued.token, { siteId: b.siteId })).toMatchObject({
      ok: false,
      reason: "site_mismatch",
      status: 404,
    });
    expect(await qr.resolveTableQrToken(issued.token, { siteId: a.siteId })).toMatchObject({
      ok: true,
      siteId: a.siteId,
    });
  });

  it("refuses cleaning, out-of-service and archived tables and a closed branch", async () => {
    const tenant = await createTenant("states");
    const cleaning = await issueToken(tenant, tenant.cleaningTableId);
    expect(await qr.resolveTableQrToken(cleaning.token)).toMatchObject({
      reason: "table_unavailable",
    });

    const oos = await issueToken(tenant, tenant.outOfServiceTableId);
    expect(await qr.resolveTableQrToken(oos.token)).toMatchObject({
      reason: "table_unavailable",
    });

    // A print exists while the table is live, then the table is archived —
    // the archived print must stop resolving.
    await db.query("UPDATE dining_tables SET is_active = true WHERE id = $1", [
      tenant.archivedTableId,
    ]);
    const archived = await issueToken(tenant, tenant.archivedTableId);
    await db.query("UPDATE dining_tables SET is_active = false WHERE id = $1", [
      tenant.archivedTableId,
    ]);
    expect(await qr.resolveTableQrToken(archived.token)).toMatchObject({
      reason: "table_archived",
    });

    const live = await issueToken(tenant, tenant.freeTableId);
    await db.query("UPDATE locations SET is_active = false WHERE id = $1", [tenant.locationId]);
    expect(await qr.resolveTableQrToken(live.token)).toMatchObject({
      reason: "location_inactive",
    });
    await db.query("UPDATE locations SET is_active = true WHERE id = $1", [tenant.locationId]);
  });

  it("refuses the whole surface when the dine_in entitlement is off", async () => {
    const tenant = await createTenant("nodine", { dineIn: false });
    const issued = await issueToken(tenant, tenant.freeTableId);
    expect(await qr.resolveTableQrToken(issued.token)).toMatchObject({
      ok: false,
      reason: "service_disabled",
      status: 403,
    });
  });

  it("never resolves one business's token for another business's intake", async () => {
    const a = await createTenant("isoa");
    const b = await createTenant("isob");
    const issued = await issueToken(b, b.freeTableId);
    expect(
      await qr.resolveTableQrTokenForOrder({
        token: issued.token,
        businessId: a.businessId,
      }),
    ).toMatchObject({ ok: false, reason: "unknown_token" });
    const own = await qr.resolveTableQrTokenForOrder({
      token: issued.token,
      businessId: b.businessId,
    });
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.resolved.tableId).toBe(b.freeTableId);
      expect(own.resolved.locationId).toBe(b.locationId);
      expect(own.resolved.siteId).toBe(b.siteId);
    }
  });
});

describe("a QR order", () => {
  it("is a real dine_in order on the token's table, with reservations off", async () => {
    const tenant = await createTenant("order");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const result = await qrOrder(tenant, issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await orderRow(result.order.id);
    expect(row.type).toBe("dine_in");
    expect(row.table_id).toBe(tenant.freeTableId);
    expect(row.table_session_id).not.toBeNull();
    expect(row.table_qr_token_id).toBe(issued.tokenId);

    const table = await db.query<{ status: string }>(
      "SELECT status FROM dining_tables WHERE id = $1",
      [tenant.freeTableId],
    );
    expect(table.rows[0].status).toBe("seated");
    const session = await db.query<{ status: string }>(
      "SELECT status FROM table_sessions WHERE id = $1",
      [row.table_session_id],
    );
    expect(session.rows[0].status).toBe("open");
  });

  it("ignores a table the caller tries to substitute", async () => {
    const tenant = await createTenant("override");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const result = await qrOrder(tenant, issued.token, {
      // A crafted body asking for another table, or a location that is not the
      // token's, changes nothing: neither field is forwarded.
      ignoredTableId: tenant.otherTableId,
      locationId: tenant.secondLocationId,
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await orderRow(result.order.id)).table_id).toBe(tenant.freeTableId);
    const other = await db.query<{ status: string }>(
      "SELECT status FROM dining_tables WHERE id = $1",
      [tenant.otherTableId],
    );
    expect(other.rows[0].status).toBe("free");
  });

  it("shares the visit session with every other order on the table", async () => {
    const tenant = await createTenant("session");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const first = await qrOrder(tenant, issued.token);
    const second = await qrOrder(tenant, issued.token);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const [a, b] = [await orderRow(first.order.id), await orderRow(second.order.id)];
    expect(a.table_session_id).toBe(b.table_session_id);
    expect(a.table_qr_token_id).toBe(issued.tokenId);
    expect(b.table_qr_token_id).toBe(issued.tokenId);

    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM orders WHERE table_session_id = $1",
      [a.table_session_id],
    );
    expect(rows[0].count).toBe("2");
    // Two orders, one open session: a second round is not a second table.
    const sessions = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM table_sessions WHERE location_id = $1 AND status = 'open'",
      [tenant.locationId],
    );
    expect(sessions.rows[0].count).toBe("1");
  });

  it("keeps two concurrent QR orders on one session", async () => {
    const tenant = await createTenant("concurrent");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const results = await Promise.all([qrOrder(tenant, issued.token), qrOrder(tenant, issued.token)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = results.flatMap((r) => (r.ok ? [r.order.id] : []));
    expect(ids).toHaveLength(2);
    const rows = await Promise.all(ids.map((id) => orderRow(id)));
    expect(rows[0].table_session_id).toBe(rows[1].table_session_id);
    const sessions = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM table_sessions WHERE location_id = $1 AND status = 'open'",
      [tenant.locationId],
    );
    expect(sessions.rows[0].count).toBe("1");
  });

  it("settling an order leaves the table seated rather than freeing it", async () => {
    const tenant = await createTenant("settle");
    const issued = await issueToken(tenant, tenant.freeTableId);
    const result = await qrOrder(tenant, issued.token);
    if (!result.ok) throw new Error("order failed");
    const before = await orderRow(result.order.id);

    // The same call the payment route makes in its completion transaction.
    await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [result.order.id]);
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await tableSessions.releaseTableAfterOrderSettled(
        client,
        tenant.locationId,
        result.order.id,
        null,
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const session = await db.query<{ status: string }>(
      "SELECT status FROM table_sessions WHERE id = $1",
      [before.table_session_id],
    );
    expect(session.rows[0].status).toBe("open");
    const table = await db.query<{ status: string }>(
      "SELECT status FROM dining_tables WHERE id = $1",
      [tenant.freeTableId],
    );
    expect(table.rows[0].status).toBe("seated");
  });
});
