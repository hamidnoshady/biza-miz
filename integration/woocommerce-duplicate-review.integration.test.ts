/**
 * Issue #1207 §C — the duplicate review the Accounting screen uses, proved
 * against a real database.
 *
 * The report and the guarded archive already had their own integration test
 * (`woocommerce-duplicate-orphan-archive.integration.test.ts`). What is new is
 * the seam between them and a screen: one read that carries the plan, the two
 * decisions, the review token that refuses a changed plan, and the audited
 * «نگهداری جداگانه» that writes nothing to `items`.
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

const KEY = "ef".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let sync: typeof import("../src/lib/integrations/sync-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let review: typeof import("../src/lib/duplicate-items-review-service");

const biz = { id: "", locationId: "", connectionId: "", otherBizId: "", otherLocationId: "" };
const STORE_WIDE = "zza05023";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function simpleProduct(id: number, sku: string) {
  return {
    id,
    type: "simple",
    name: "اسپری دوفاز ضد موخوره",
    sku,
    price: "1027000",
    regular_price: "1027000",
    sale_price: "",
    manage_stock: true,
    stock_quantity: 1,
    stock_status: "instock",
    status: "publish",
    attributes: [],
    categories: [],
    images: [],
  };
}

/** Maps one remote product through the real sync, returning the kept twin's item id. */
async function mapProduct(remoteId: number, sku: string): Promise<string> {
  const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
  await dbLib.withTenant(biz.id, () => sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(remoteId, sku)));
  const { rows } = await db.query<{ local_id: string }>(
    `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = $2`,
    [biz.connectionId, String(remoteId)],
  );
  return rows[0].local_id;
}

/** An unmapped twin, as the pre-fix race left it. */
async function insertOrphan(sku: string, locationId = biz.locationId): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'اسپری دوفاز ضد موخوره', $2, 'simple') RETURNING id::text AS id`,
    [locationId, sku],
  );
  return rows[0].id;
}

async function isActive(itemId: string): Promise<boolean> {
  const { rows } = await db.query<{ is_active: boolean }>(`SELECT is_active FROM items WHERE id = $1`, [itemId]);
  return rows[0].is_active;
}

async function auditRows(action: string, entityId?: string) {
  const { rows } = await db.query<{ payload: Record<string, unknown> }>(
    entityId
      ? `SELECT payload FROM audit_log WHERE action = $1 AND entity_id = $2`
      : `SELECT payload FROM audit_log WHERE action = $1`,
    entityId ? [action, entityId] : [action],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_woo_review_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(rootDatabaseUrl!);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
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
  review = await import("../src/lib/duplicate-items-review-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  biz.id = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Beauty', $1, 'cosmetics') RETURNING id::text AS id",
      [`woo-review-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  biz.locationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id::text AS id", [
      biz.id,
    ])
  ).rows[0].id;
  biz.connectionId = (
    await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url,
          consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
          currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Store', 'https://beauty.example.com', $3, $4, $5, 'toman', true, true, true, false, false)
       RETURNING id::text AS id`,
      [
        biz.id,
        biz.locationId,
        encryptSecret("ck", Buffer.from(KEY, "hex")),
        encryptSecret("cs", Buffer.from(KEY, "hex")),
        encryptSecret("ws", Buffer.from(KEY, "hex")),
      ],
    )
  ).rows[0].id;

  biz.otherBizId = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Other', $1, 'cosmetics') RETURNING id::text AS id",
      [`woo-review-o-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  biz.otherLocationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id::text AS id", [
      biz.otherBizId,
    ])
  ).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  const maintenanceUrl = new URL(rootDatabaseUrl!);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("the duplicate review", () => {
  it("reads the group with its plan and writes nothing", async () => {
    const kept = await mapProduct(5023, STORE_WIDE);
    const orphan = await insertOrphan(STORE_WIDE);
    // A same-SKU orphan in another branch is a per-branch copy, not this pair.
    await insertOrphan(STORE_WIDE, biz.otherLocationId);

    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: STORE_WIDE });
    expect(group).toMatchObject({ sku: STORE_WIDE, verdict: "race_orphan", needsAction: true, reviewed: false });
    expect(group.plan).toMatchObject({ orphanItemId: orphan, twinItemId: kept, status: "archive", blockers: [] });
    expect(group.reviewToken).toMatch(/^[0-9a-f]{64}$/);
    // §C: the notes say why a person, not a screen, decides.
    expect(group.notes.length).toBeGreaterThan(0);
    expect(group.separateReasons).toContain("ردیف بدون پیوند (محلی)");

    expect(await isActive(orphan)).toBe(true);
    expect(await auditRows(review.KEEP_SEPARATE_ACTION)).toHaveLength(0);
    expect(await auditRows("item.duplicate_orphan_archived")).toHaveLength(0);
  });

  it("reports the flagged SKUs for the list and keeps other tenants out", async () => {
    expect(await review.listDuplicateCandidateSkus(biz.id)).toContain(STORE_WIDE);
    expect(await review.listDuplicateCandidateSkus(biz.otherBizId)).toEqual([]);
    expect(await review.loadDuplicateReviewGroups(biz.otherBizId, { sku: STORE_WIDE })).toEqual([]);
  });

  it("records «نگهداری جداگانه» without touching a row, and stops repeating the question", async () => {
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: STORE_WIDE });
    const updated = await review.recordDuplicateKeepSeparate(biz.id, {
      sku: STORE_WIDE,
      reviewToken: group.reviewToken,
      actorUserId: null,
    });
    expect(updated.reviewed).toBe(true);
    expect(updated.reviewedAt).toBeTruthy();

    const audit = await auditRows(review.KEEP_SEPARATE_ACTION);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ sku: STORE_WIDE, verdict: "race_orphan" });
    expect((audit[0].payload.itemIds as string[]).sort()).toEqual(group.members.map((member) => member.itemId).sort());

    // Nothing was archived and nothing was merged.
    for (const member of group.members) expect(await isActive(member.itemId)).toBe(true);
    // The decision survives a fresh read.
    const [again] = await review.loadDuplicateReviewGroups(biz.id, { sku: STORE_WIDE });
    expect(again.reviewed).toBe(true);
    // Reported, but no longer as an open question.
    expect(review.isUnresolvedDuplicate(again)).toBe(false);
  });

  it("refuses a token whose evidence changed, and archives nothing", async () => {
    const kept = await mapProduct(5400, "zza05400");
    const orphan = await insertOrphan("zza05400");
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "zza05400" });
    expect(group.plan?.twinItemId).toBe(kept);

    // A third row joins the group after the reader loaded it.
    const late = await insertOrphan("zza05400");
    await expect(
      review.archiveDuplicateOrphanFromReview(biz.id, {
        sku: "zza05400",
        orphanItemId: orphan,
        reviewToken: group.reviewToken,
        actorUserId: null,
      }),
    ).rejects.toThrow("duplicate_review_changed");
    expect(await isActive(orphan)).toBe(true);
    expect(await isActive(late)).toBe(true);
  });

  it("archives a proven orphan through the review and audits the twin", async () => {
    const kept = await mapProduct(5500, "zza05500");
    const orphan = await insertOrphan("zza05500");
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "zza05500" });
    const result = await review.archiveDuplicateOrphanFromReview(biz.id, {
      sku: "zza05500",
      orphanItemId: orphan,
      reviewToken: group.reviewToken,
      actorUserId: null,
    });
    expect(result.archived?.orphanItemId).toBe(orphan);
    expect(result.blockers).toEqual([]);
    expect(await isActive(orphan)).toBe(false);
    expect(await isActive(kept)).toBe(true);
    const audit = await auditRows("item.duplicate_orphan_archived", orphan);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ sku: "zza05500", twinItemId: kept });
  });

  it("never offers the archive for a referenced orphan", async () => {
    await mapProduct(5600, "zza05600");
    const orphan = await insertOrphan("zza05600");
    await db.query(`INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, '2000000056001', 'internal')`, [
      biz.locationId,
      orphan,
    ]);
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "zza05600" });
    expect(group.plan?.status).toBe("blocked");
    expect(group.plan?.blockers).toContain("has_references");

    const result = await review.archiveDuplicateOrphanFromReview(biz.id, {
      sku: "zza05600",
      orphanItemId: orphan,
      reviewToken: group.reviewToken,
      actorUserId: null,
    });
    expect(result.archived).toBeNull();
    expect(result.blockers).toContain("has_references");
    expect(await isActive(orphan)).toBe(true);
  });

  it("leaves legitimate shared SKUs alone", async () => {
    // Two hand-made rows days apart: no integration owns either, so the screen
    // reports the question but never a plan.
    await db.query(
      `INSERT INTO items (location_id, name, sku, created_at) VALUES
         ($1, 'سرم', 'MANUAL-1', now() - interval '2 days'), ($1, 'سرم', 'MANUAL-1', now())`,
      [biz.locationId],
    );
    const [group] = await review.loadDuplicateReviewGroups(biz.id, { sku: "MANUAL-1" });
    expect(group).toMatchObject({ verdict: "unmapped_duplicate", needsAction: true });
    expect(group.plan).toBeNull();
  });
});
