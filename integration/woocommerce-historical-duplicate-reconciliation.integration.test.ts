/**
 * Issue #1592 — the historical duplicate shape: an unmapped row from one month
 * beside a WooCommerce-mapped row of the same product from another, proved
 * against a real database.
 *
 * What is asserted:
 *  - the report classifies the weeks-apart pair as `historical_duplicate_candidate`
 *    and does not touch `RACE_WINDOW_MS`;
 *  - a zero-stock, unreferenced twin may be archived reversibly, through the
 *    review token, with its own audit action;
 *  - a stocked twin is blocked **even when `item_stock` is the only row that
 *    mentions it** — the 304-of-410 case;
 *  - a referenced twin is blocked;
 *  - a plan that changed after it was read (stock appeared) is refused;
 *  - another tenant's identical pair is invisible and untouched.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "ab".repeat(32);
const PRODUCT_NAME = "کرم مرطوب‌کننده";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let sync: typeof import("../src/lib/integrations/sync-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let report: typeof import("../src/lib/duplicate-items-report");
let resolve: typeof import("../src/lib/duplicate-items-resolve-service");
let review: typeof import("../src/lib/duplicate-items-review-service");

const biz = {
  id: "",
  locationId: "",
  ownerId: "",
  connectionId: "",
  pushConnectionId: "",
  otherBizId: "",
  otherLocationId: "",
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

function simpleProduct(id: number, sku: string, stock: number) {
  return {
    id,
    type: "simple",
    name: PRODUCT_NAME,
    sku,
    price: "250000",
    regular_price: "250000",
    sale_price: "",
    manage_stock: true,
    stock_quantity: stock,
    stock_status: "instock",
    status: "publish",
    attributes: [],
    categories: [],
    images: [],
  };
}

async function mapProduct(remoteId: number, sku: string): Promise<string> {
  const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
  await dbLib.withTenant(biz.id, () => sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(remoteId, sku, 6)));
  const { rows } = await db.query<{ local_id: string }>(
    `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = $2`,
    [biz.connectionId, String(remoteId)],
  );
  return rows[0].local_id;
}

/** The August row: same product and SKU, no mapping, `ageDays` before the mapped row. */
async function insertHistoricalTwin(
  sku: string,
  ageDays: number,
  quantity = 0,
  locationId = biz.locationId,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `WITH i AS (
       INSERT INTO items (location_id, name, sku, kind, created_at)
       VALUES ($1, $2, $3, 'simple', now() - ($4 || ' days')::interval)
       RETURNING id
     ), s AS (INSERT INTO item_stock (item_id, quantity) SELECT id, $5 FROM i)
     SELECT id::text AS id FROM i`,
    [locationId, PRODUCT_NAME, sku, String(ageDays), quantity],
  );
  return rows[0].id;
}

async function isActive(itemId: string): Promise<boolean> {
  const { rows } = await db.query<{ is_active: boolean }>(`SELECT is_active FROM items WHERE id = $1`, [itemId]);
  return rows[0].is_active;
}

async function quantityOf(itemId: string): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>(`SELECT quantity::text FROM item_stock WHERE item_id = $1`, [itemId]);
  return Number(rows[0].quantity);
}

async function auditRows(action: string, entityId: string) {
  const { rows } = await db.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM audit_log WHERE action = $1 AND entity_id = $2`,
    [action, entityId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_woo_hist_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  dbLib = await import("../src/lib/db");
  sync = await import("../src/lib/integrations/sync-service");
  connections = await import("../src/lib/integrations/connections-service");
  report = await import("../src/lib/duplicate-items-report");
  resolve = await import("../src/lib/duplicate-items-resolve-service");
  review = await import("../src/lib/duplicate-items-review-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  biz.id = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Beauty', $1, 'cosmetics') RETURNING id",
      [`woo-hist-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  biz.locationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [biz.id])
  ).rows[0].id;
  biz.ownerId = (
    await db.query<{ id: string }>(
      `INSERT INTO users (business_id, location_id, role, full_name, password_hash)
       VALUES ($1, $2, 'owner', 'مالک', 'x') RETURNING id`,
      [biz.id, biz.locationId],
    )
  ).rows[0].id;
  biz.connectionId = (
    await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url,
          consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
          currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Store', 'https://beauty.example.com', $3, $4, $5, 'toman', true, true, true, false, false)
       RETURNING id`,
      [
        biz.id,
        biz.locationId,
        encryptSecret("ck", Buffer.from(KEY, "hex")),
        encryptSecret("cs", Buffer.from(KEY, "hex")),
        encryptSecret("ws", Buffer.from(KEY, "hex")),
      ],
    )
  ).rows[0].id;

  // A push-enabled link, for the outbound pause while a duplicate is open.
  biz.pushConnectionId = (
    await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url,
          consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
          currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Store (push)', 'https://push.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
       RETURNING id`,
      [
        biz.id,
        biz.locationId,
        encryptSecret("ck-push", Buffer.from(KEY, "hex")),
        encryptSecret("cs-push", Buffer.from(KEY, "hex")),
        encryptSecret("ws-push", Buffer.from(KEY, "hex")),
      ],
    )
  ).rows[0].id;

  biz.otherBizId = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Other', $1, 'cosmetics') RETURNING id",
      [`woo-hist-o-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  biz.otherLocationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id", [biz.otherBizId])
  ).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("weeks-apart duplicate products", () => {
  it("classifies the pair as historical and archives the zero-stock twin reversibly", async () => {
    const kept = await mapProduct(7001, "HIST-1");
    const old = await insertHistoricalTwin("HIST-1", 34);

    const groups = await report.findDuplicateItemGroups(biz.id, { sku: "HIST-1" });
    expect(groups).toHaveLength(1);
    expect(groups[0].verdict).toBe("historical_duplicate_candidate");

    const mappingCount = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM integration_mappings`)).rows[0].n;
    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "HIST-1" });
    expect(plan).toMatchObject({
      kind: "historical_duplicate_candidate",
      orphanItemId: old,
      twinItemId: kept,
      status: "archive",
      blockers: [],
    });
    expect(plan.daysApart).toBe(34);

    const result = await resolve.archiveDuplicateOrphans(biz.id, [plan]);
    expect(result.archived.map((p) => p.orphanItemId)).toEqual([old]);
    expect(await isActive(old)).toBe(false);
    expect(await isActive(kept)).toBe(true);
    // Nothing was merged, moved or deleted.
    expect(await quantityOf(old)).toBe(0);
    expect(await quantityOf(kept)).toBe(6);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM items`)).rows[0].n).toBe(2);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM integration_mappings`)).rows[0].n).toBe(mappingCount);

    const audit = await auditRows("item.duplicate_historical_archived", old);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      kind: "historical_duplicate_candidate",
      sku: "HIST-1",
      twinItemId: kept,
      daysApart: 34,
    });

    // Reversible through the same review: the row was never deleted and no
    // inventory/history moved, so restoring is one audited flag.
    const [archivedGroup] = await review.loadDuplicateReviewGroups(biz.id, { sku: "HIST-1", locationId: biz.locationId });
    expect(archivedGroup.plan?.status).toBe("already_archived");
    const restored = await review.restoreDuplicateFromReview(biz.id, {
      sku: "HIST-1",
      itemId: old,
      reviewToken: archivedGroup.reviewToken,
      actorUserId: null,
      locationId: biz.locationId,
    });
    expect(restored).toEqual({ restored: true });
    expect(await isActive(old)).toBe(true);
    expect(await auditRows("item.duplicate_archive_restored", old)).toHaveLength(1);
    // Only this workflow's archive is reversible; a second restore is refused.
    expect(await resolve.restoreArchivedDuplicateItem(biz.id, { itemId: old })).toEqual({
      restored: false,
      reason: "already_active",
    });
  });

  it("blocks a historical twin that still holds stock, even with only item_stock as evidence", async () => {
    await mapProduct(7002, "HIST-2");
    const stocked = await insertHistoricalTwin("HIST-2", 34, 5);

    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "HIST-2" });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContain("nonzero_stock");
    expect(Number(plan.orphanQuantity)).toBe(5);

    const result = await resolve.archiveDuplicateOrphans(biz.id, [plan]);
    expect(result.archived).toEqual([]);
    expect(await isActive(stocked)).toBe(true);
    expect(await quantityOf(stocked)).toBe(5);
    expect(await auditRows("item.duplicate_historical_archived", stocked)).toHaveLength(0);
  });

  it("blocks a historical twin with a sale or other reference and says which table", async () => {
    await mapProduct(7003, "HIST-3");
    const referenced = await insertHistoricalTwin("HIST-3", 34);
    await db.query(
      `INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, '2000000070031', 'internal')`,
      [biz.locationId, referenced],
    );

    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "HIST-3" });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContain("has_references");
    expect(plan.references).toEqual([{ table: "item_barcodes", column: "item_id", count: 1 }]);

    const result = await resolve.archiveDuplicateOrphans(biz.id, [plan]);
    expect(result.archived).toEqual([]);
    expect(await isActive(referenced)).toBe(true);
  });

  it("refuses a review whose evidence changed after it was read", async () => {
    await mapProduct(7004, "HIST-4");
    const old = await insertHistoricalTwin("HIST-4", 34);

    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "HIST-4", locationId: biz.locationId });
    expect(group.verdict).toBe("historical_duplicate_candidate");
    expect(group.plan?.status).toBe("archive");

    // Stock appears between the read and the confirmation.
    await db.query(`UPDATE item_stock SET quantity = 3 WHERE item_id = $1`, [old]);
    await expect(
      review.archiveDuplicateOrphanFromReview(biz.id, {
        sku: "HIST-4",
        orphanItemId: old,
        reviewToken: group.reviewToken,
        actorUserId: null,
        locationId: biz.locationId,
      }),
    ).rejects.toThrow("duplicate_review_changed");
    expect(await isActive(old)).toBe(true);
  });

  it("records a prior link to the same store as provenance and copies no mappings", async () => {
    const created = await connections.createConnection(biz.id, biz.ownerId, {
      name: "Store (relinked)",
      baseUrl: "https://www.beauty.example.com/",
      linkMode: "plugin",
      currencyUnit: "toman",
      locationId: biz.locationId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The original connection is recognised as an earlier link to this store,
    // including how many product mappings it owns.
    expect(created.reconnectOf?.some((prior) => prior.connectionId === biz.connectionId)).toBe(true);
    expect(created.reconnectOf?.find((prior) => prior.connectionId === biz.connectionId)?.mappedProducts).toBeGreaterThan(0);
    // Nothing is copied or re-pointed: the new link starts with no mappings.
    expect(
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration_mappings WHERE connection_id = $1`,
          [created.connection.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration_audit_log
            WHERE connection_id = $1 AND action = 'connection.created' AND payload ? 'reconnectOf'`,
          [created.connection.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("never reads or plans another tenant's identical pair", async () => {
    await db.query(
      `INSERT INTO items (location_id, name, sku, kind) VALUES
         ($1, $2, 'HIST-5', 'simple'), ($1, $2, 'HIST-5', 'simple')`,
      [biz.otherLocationId, PRODUCT_NAME],
    );
    expect(await report.findDuplicateItemGroups(biz.otherBizId, { sku: "HIST-5" })).toHaveLength(1);
    // No WooCommerce mapping exists there, so there is no provable twin at all.
    expect(await resolve.planDuplicateOrphanArchives(biz.otherBizId, { sku: "HIST-5" })).toEqual([]);
  });

  it("pauses automatic stock/price pushes while the unmapped twin holds the stock", async () => {
    const outbox = await import("../src/lib/integrations/outbox-service");
    const pushConnection = (await connections.getConnection(biz.id, biz.pushConnectionId))!;
    await dbLib.withTenant(biz.id, () =>
      sync.upsertProductFromWoo(pushConnection, biz.locationId, simpleProduct(7100, "PUSH-1", 6)),
    );
    const twin = await insertHistoricalTwin("PUSH-1", 34, 5);

    await outbox.refreshOutboxForConnection(pushConnection);
    expect(
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration_outbox_events WHERE connection_id = $1`,
          [biz.pushConnectionId],
        )
      ).rows[0].n,
    ).toBe(0);

    // The owner resolves the duplicate: the mapped row owns the quantity and
    // the twin is empty and archived. Pushes resume deliberately.
    await db.query(`UPDATE item_stock SET quantity = 0 WHERE item_id = $1`, [twin]);
    await db.query(`UPDATE items SET is_active = false WHERE id = $1`, [twin]);
    await outbox.refreshOutboxForConnection(pushConnection);
    const queued = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM integration_outbox_events
        WHERE connection_id = $1 AND entity_type = 'stock'`,
      [biz.pushConnectionId],
    );
    expect(queued.rows).toHaveLength(1);
    expect(Number(queued.rows[0].payload.stock_quantity)).toBe(6);
  });
});

describe("variable-family orphans (issue #1592 follow-up)", () => {
  async function insertMappedItem(input: {
    sku: string;
    kind: "simple" | "variant_parent" | "variant_child";
    parentItemId?: string | null;
    remoteId: string;
    quantity: number | null;
    name?: string;
    locationId?: string;
    connectionId?: string;
  }): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind, created_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 days') RETURNING id`,
      [input.locationId ?? biz.locationId, input.parentItemId ?? null, input.name ?? PRODUCT_NAME, input.sku, input.kind],
    );
    const id = rows[0].id;
    if (input.quantity != null) {
      await db.query(`INSERT INTO item_stock (item_id, quantity) VALUES ($1, $2)`, [id, input.quantity]);
    }
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', $3, $4)`,
      [biz.id, input.connectionId ?? biz.connectionId, input.remoteId, id],
    );
    return id;
  }

  async function mapFamily(sku: string, base: number): Promise<{ parent: string; child: string }> {
    const parent = await insertMappedItem({ sku, kind: "variant_parent", remoteId: String(base), quantity: null });
    const child = await insertMappedItem({
      sku,
      kind: "variant_child",
      parentItemId: parent,
      remoteId: String(base + 1),
      quantity: 2,
    });
    return { parent, child };
  }

  it("classifies and archives the flat August copy of a mapped variable family", async () => {
    const { parent } = await mapFamily("FAM-1", 8100);
    const flat = await insertHistoricalTwin("FAM-1", 34);

    const groups = await report.findDuplicateItemGroups(biz.id, { sku: "FAM-1" });
    expect(groups).toHaveLength(1);
    expect(groups[0].verdict).toBe("historical_variant_orphan");

    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "FAM-1" });
    expect(plan).toMatchObject({
      kind: "historical_variant_orphan",
      orphanItemId: flat,
      twinItemId: parent,
      status: "archive",
    });

    const result = await resolve.archiveDuplicateOrphans(biz.id, [plan]);
    expect(result.archived.map((row) => row.orphanItemId)).toEqual([flat]);
    expect(await isActive(flat)).toBe(false);
    expect(await auditRows("item.duplicate_variant_orphan_archived", flat)).toHaveLength(1);
    // The family and its stock are untouched; the flat row's zero stock stays.
    expect(await quantityOf(flat)).toBe(0);
  });

  it("blocks the flat copy when it still holds stock", async () => {
    await mapFamily("FAM-2", 8110);
    const flat = await insertHistoricalTwin("FAM-2", 34, 1);
    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "FAM-2" });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContain("nonzero_stock");
    expect(await isActive(flat)).toBe(true);
  });

  it("does not pair a differently-named simple row, and does not guess between two families", async () => {
    await mapFamily("FAM-3", 8120);
    await db.query(
      `INSERT INTO items (location_id, name, sku, kind, created_at)
       VALUES ($1, 'کرم دیگر', 'FAM-3', 'simple', now() - interval '34 days')`,
      [biz.locationId],
    );
    expect((await report.findDuplicateItemGroups(biz.id, { sku: "FAM-3" }))[0].verdict).toBe("unmapped_duplicate");
    expect(await resolve.planDuplicateOrphanArchives(biz.id, { sku: "FAM-3" })).toEqual([]);

    await mapFamily("FAM-4", 8130);
    await mapFamily("FAM-4", 8140);
    await insertHistoricalTwin("FAM-4", 34);
    expect((await report.findDuplicateItemGroups(biz.id, { sku: "FAM-4" }))[0].verdict).toBe("unmapped_duplicate");
    expect(await resolve.planDuplicateOrphanArchives(biz.id, { sku: "FAM-4" })).toEqual([]);
  });

  it("keeps branch and tenant isolation for family orphans", async () => {
    // A family in another branch must not become the twin of this branch's row.
    const otherBranch = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id`,
      [biz.id],
    );
    const otherParent = await insertMappedItem({
      sku: "FAM-5",
      kind: "variant_parent",
      remoteId: "8150",
      quantity: null,
      locationId: otherBranch.rows[0].id,
    });
    await insertMappedItem({
      sku: "FAM-5",
      kind: "variant_child",
      parentItemId: otherParent,
      remoteId: "8151",
      quantity: 1,
      locationId: otherBranch.rows[0].id,
    });
    const flatHere = await insertHistoricalTwin("FAM-5", 34);
    expect((await report.findDuplicateItemGroups(biz.id, { sku: "FAM-5" }))[0].verdict).toBe("unmapped_duplicate");
    expect(await resolve.planDuplicateOrphanArchives(biz.id, { sku: "FAM-5" })).toEqual([]);
    expect(await isActive(flatHere)).toBe(true);
  });
});

describe("resolution states and history disposition", () => {
  it("retains a history-referenced row without calling it deduplicated", async () => {
    await mapProduct(7200, "HIST-REF");
    const orphan = await insertHistoricalTwin("HIST-REF", 34);
    await db.query(
      `INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, '2000000072000', 'internal')`,
      [biz.locationId, orphan],
    );

    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "HIST-REF", locationId: biz.locationId });
    expect(group.resolution).toBe("blocked_history");
    expect(group.needsAction).toBe(true);
    expect(group.resolved).toBe(false);

    const retained = await review.recordDuplicateHistoryRetained(biz.id, {
      sku: "HIST-REF",
      reviewToken: group.reviewToken,
      actorUserId: null,
      locationId: biz.locationId,
    });
    expect(retained.resolution).toBe("history_retained");
    expect(retained.resolved).toBe(true);
    expect(retained.needsAction).toBe(false);
    expect(retained.deduplicated).toBe(false);
    expect(await isActive(orphan)).toBe(true);
    expect(await auditRows("item.duplicate_history_retained", group.members[0].itemId)).toHaveLength(1);
    // The product list no longer flags this SKU.
    expect(await review.listDuplicateCandidateSkus(biz.id, { locationId: biz.locationId })).not.toContain("HIST-REF");
  });

  it("refuses to retain history for a stocked row (stock needs its own decision)", async () => {
    await mapProduct(7201, "HIST-REF-STOCK");
    const orphan = await insertHistoricalTwin("HIST-REF-STOCK", 34, 2);
    await db.query(
      `INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, '2000000072010', 'internal')`,
      [biz.locationId, orphan],
    );
    const [group] = await review.loadDuplicateReviewGroups(biz.id, {
      sku: "HIST-REF-STOCK",
      locationId: biz.locationId,
    });
    await expect(
      review.recordDuplicateHistoryRetained(biz.id, {
        sku: "HIST-REF-STOCK",
        reviewToken: group.reviewToken,
        actorUserId: null,
        locationId: biz.locationId,
      }),
    ).rejects.toThrow("duplicate_history_has_stock");
  });

  it("keeps keep-separate distinct from deduplication and stops the flag", async () => {
    await db.query(
      `INSERT INTO items (location_id, name, sku, kind) VALUES
         ($1, 'کرم یک', 'SEP-1', 'simple'), ($1, 'کرم دو', 'SEP-1', 'simple')`,
      [biz.locationId],
    );
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "SEP-1", locationId: biz.locationId });
    expect(group.resolution).toBe("pending_review");
    const kept = await review.recordDuplicateKeepSeparate(biz.id, {
      sku: "SEP-1",
      reviewToken: group.reviewToken,
      actorUserId: null,
      locationId: biz.locationId,
    });
    expect(kept.resolution).toBe("kept_separate");
    expect(kept.deduplicated).toBe(false);
    expect(kept.needsAction).toBe(false);
    expect(await review.listDuplicateCandidateSkus(biz.id, { locationId: biz.locationId })).not.toContain("SEP-1");
  });

  it("stops flagging a safely archived row and reports it as archived, not pending", async () => {
    await mapProduct(7202, "HIST-ARCH");
    const orphan = await insertHistoricalTwin("HIST-ARCH", 34);
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "HIST-ARCH", locationId: biz.locationId });
    const archived = await review.archiveDuplicateOrphanFromReview(biz.id, {
      sku: "HIST-ARCH",
      orphanItemId: orphan,
      reviewToken: group.reviewToken,
      actorUserId: null,
      locationId: biz.locationId,
    });
    expect(archived.archived).not.toBeNull();
    const [after] = await review.loadDuplicateReviewGroups(biz.id, { sku: "HIST-ARCH", locationId: biz.locationId });
    expect(after.resolution).toBe("safely_archived");
    expect(after.deduplicated).toBe(true);
    expect(after.needsAction).toBe(false);
    expect(await review.listDuplicateCandidateSkus(biz.id, { locationId: biz.locationId })).not.toContain("HIST-ARCH");
  });
});

describe("stock-authority preview", () => {
  async function storePayload(remoteId: string, sku: string, stock: number | null) {
    await db.query(
      `INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
       VALUES ($1, $2, 'product.updated', $3, $4, $5, 'processed')`,
      [
        biz.id,
        biz.connectionId,
        remoteId,
        `auth-${randomUUID()}`,
        JSON.stringify({ ...simpleProduct(Number(remoteId), sku, stock ?? 0), stock_quantity: stock }),
      ],
    );
  }

  it("marks a store-equal pair safe, proposes zero physical movement and writes nothing", async () => {
    const authority = await import("../src/lib/duplicate-items-stock-authority-service");
    const canonical = await mapProduct(7300, "AUTH-1"); // 6 units locally
    await storePayload("7300", "AUTH-1", 6);
    const orphan = await insertHistoricalTwin("AUTH-1", 34, 5);

    const preview = await authority.previewStockAuthority(biz.id, { sku: "AUTH-1", locationId: biz.locationId });
    expect(preview.totals).toMatchObject({ pairs: 1, safe: 1, needsReconciliation: 0, manual: 0 });
    const [item] = preview.items;
    expect(item).toMatchObject({
      itemId: orphan,
      canonicalItemId: canonical,
      orphanQuantity: 5,
      canonicalQuantity: 6,
      storeQuantity: 6,
      evidence: "canonical_matches_store",
      verdict: "safe_to_archive",
    });
    expect(item.proposal.physicalUnitsDelta).toBe(0);
    expect(item.proposal.catalogueUnitsDelta).toBe(-5);
    expect(preview.approvalToken).toMatch(/^[0-9a-f]{64}$/);
    // Stable evidence ⇒ stable token; the preview is read-only.
    const again = await authority.previewStockAuthority(biz.id, { sku: "AUTH-1", locationId: biz.locationId });
    expect(again.approvalToken).toBe(preview.approvalToken);
    expect(await isActive(orphan)).toBe(true);
    expect(await quantityOf(orphan)).toBe(5);
    expect(await auditRows("item.duplicate_historical_archived", orphan)).toHaveLength(0);
  });

  it("refuses negative store stock and a missing stock_quantity", async () => {
    const authority = await import("../src/lib/duplicate-items-stock-authority-service");
    await mapProduct(7301, "AUTH-NEG");
    await storePayload("7301", "AUTH-NEG", -1);
    await insertHistoricalTwin("AUTH-NEG", 34, 2);
    const negative = await authority.previewStockAuthority(biz.id, { sku: "AUTH-NEG", locationId: biz.locationId });
    expect(negative.items[0].evidence).toBe("store_stock_negative");
    expect(negative.items[0].verdict).toBe("needs_store_reconciliation");
    expect(negative.approvalToken).toMatch(/^[0-9a-f]{64}$/);

    await mapProduct(7302, "AUTH-NONE");
    await storePayload("7302", "AUTH-NONE", null);
    await insertHistoricalTwin("AUTH-NONE", 34, 2);
    const missing = await authority.previewStockAuthority(biz.id, { sku: "AUTH-NONE", locationId: biz.locationId });
    expect(missing.items[0].evidence).toBe("store_stock_missing");
  });

  it("sends a stocked variable-family orphan to a person", async () => {
    const authority = await import("../src/lib/duplicate-items-stock-authority-service");
    const parent = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, $2, 'AUTH-FAM', 'variant_parent') RETURNING id`,
      [biz.locationId, PRODUCT_NAME],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '7310', $3)`,
      [biz.id, biz.connectionId, parent.rows[0].id],
    );
    const child = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind) VALUES ($1, $2, $3, 'AUTH-FAM', 'variant_child')
       RETURNING id`,
      [biz.locationId, parent.rows[0].id, PRODUCT_NAME],
    );
    await db.query(`INSERT INTO item_stock (item_id, quantity) VALUES ($1, 2)`, [child.rows[0].id]);
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '7311', $3)`,
      [biz.id, biz.connectionId, child.rows[0].id],
    );
    await insertHistoricalTwin("AUTH-FAM", 34, 1);
    const preview = await authority.previewStockAuthority(biz.id, { sku: "AUTH-FAM", locationId: biz.locationId });
    expect(preview.items[0].variantFamily).toBe(true);
    expect(preview.items[0].verdict).toBe("manual_review");
  });
});

describe("mapping provenance on a physical connection delete", () => {
  it("archives the connection snapshot and every mapping before the cascade", async () => {
    const provenance = await import("../src/lib/integrations/mapping-provenance-service");
    const created = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext,
          webhook_secret_ciphertext, currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Store (delete)', 'https://delete.example.com', $3, $4, $5, 'toman', true, true, true, false, false)
       RETURNING id`,
      [
        biz.id,
        biz.locationId,
        encryptSecret("ck", Buffer.from(KEY, "hex")),
        encryptSecret("cs", Buffer.from(KEY, "hex")),
        encryptSecret("ws", Buffer.from(KEY, "hex")),
      ],
    );
    const connectionId = created.rows[0].id;
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'کرم حذف', 'PROV-1', 'simple') RETURNING id`,
      [biz.locationId],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '9001', $3)`,
      [biz.id, connectionId, item.rows[0].id],
    );

    await db.query(`DELETE FROM integration_connections WHERE id = $1`, [connectionId]);
    expect(
      (
        await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM integration_mappings WHERE connection_id = $1`, [
          connectionId,
        ])
      ).rows[0].n,
    ).toBe(0);

    const rows = await provenance.listMappingProvenance(biz.id, { connectionId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId,
      connectionName: "Store (delete)",
      provider: "woocommerce",
      entityType: "product",
      remoteId: "9001",
      localId: item.rows[0].id,
      archivedReason: "connection_deleted",
    });
    expect(rows[0].storeKey).toContain("delete.example.com");
    // The item itself is untouched: provenance is evidence, not a re-link.
    expect(await isActive(item.rows[0].id)).toBe(true);
  });

  it("never blocks a tenant deletion (the business is already gone when the cascade runs)", async () => {
    const business = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry) VALUES ('Gone', $1, 'cosmetics') RETURNING id`,
      [`gone-${randomUUID().slice(0, 8)}`],
    );
    const location = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'Gone') RETURNING id`,
      [business.rows[0].id],
    );
    const connection = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext,
          webhook_secret_ciphertext, currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Gone store', 'https://gone.example.com', $3, $4, $5, 'toman', true, true, true, false, false)
       RETURNING id`,
      [
        business.rows[0].id,
        location.rows[0].id,
        encryptSecret("ck", Buffer.from(KEY, "hex")),
        encryptSecret("cs", Buffer.from(KEY, "hex")),
        encryptSecret("ws", Buffer.from(KEY, "hex")),
      ],
    );
    const goneItem = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'Gone item', 'GONE-1', 'simple') RETURNING id`,
      [location.rows[0].id],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '9999', $3)`,
      [business.rows[0].id, connection.rows[0].id, goneItem.rows[0].id],
    );

    await expect(db.query(`DELETE FROM businesses WHERE id = $1`, [business.rows[0].id])).resolves.toBeDefined();
    expect(
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration_mapping_provenance WHERE business_id = $1`,
          [business.rows[0].id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

describe("reporting after an archive", () => {
  it("keeps the archived row's stock and history while operational totals exclude it", async () => {
    await mapProduct(7400, "REPORT-1");
    const orphan = await insertHistoricalTwin("REPORT-1", 34);
    const before = (
      await db.query<{ units: string }>(
        `SELECT sum(s.quantity)::text AS units FROM item_stock s JOIN items i ON i.id = s.item_id
          WHERE i.location_id = $1 AND i.is_active`,
        [biz.locationId],
      )
    ).rows[0].units;
    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "REPORT-1" });
    await resolve.archiveDuplicateOrphans(biz.id, [plan]);

    const after = (
      await db.query<{ units: string }>(
        `SELECT sum(s.quantity)::text AS units FROM item_stock s JOIN items i ON i.id = s.item_id
          WHERE i.location_id = $1 AND i.is_active`,
        [biz.locationId],
      )
    ).rows[0].units;
    // The orphan held zero, so operational units are unchanged; its row and
    // stock snapshot still exist for history and restore.
    expect(after).toBe(before);
    expect(await quantityOf(orphan)).toBe(0);
    expect((await db.query<{ is_active: boolean }>(`SELECT is_active FROM items WHERE id = $1`, [orphan])).rows[0].is_active).toBe(false);
  });
});
