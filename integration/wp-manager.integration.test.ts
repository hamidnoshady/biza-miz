/**
 * Phase 40 — the WordPress & WooCommerce Manager read models and content
 * mirror, end to end against a real database.
 *
 * These services are what every manager screen reads: the میز کار overview
 * counts, the store's customer list, the operational queue, and the mirrored
 * post/page/media library. They are DB-touching, so they are exercised here
 * rather than in a unit test — the pure title/entity decoding they lean on is
 * covered by `src/lib/integrations/wp-content-service.test.ts`.
 *
 * What is proved:
 *   1. The overview counts a business's connections, mapped entities, terms,
 *      content and queue depth — scoped to one connection or summed across a
 *      business.
 *   2. `upsertWpContent` is a real upsert (a re-sent post updates one row) and
 *      decodes the entities WordPress puts in a title, so the manager's list
 *      never shows a raw `&#8217;`.
 *   3. The queue merges outbound outbox jobs and inbound webhook failures, and
 *      the customer list includes unresolved profiles, joins valid local parties,
 *      and counts only orders mirrored from that store — not POS sales.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "cd".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let manager: typeof import("../src/lib/integrations/wp-manager-service");
let identity: typeof import("../src/lib/crm-external-identity");
let outbox: typeof import("../src/lib/integrations/outbox-service");
let content: typeof import("../src/lib/integrations/wp-content-service");
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let plugin: typeof import("../src/lib/integrations/plugin-service");
let taxonomy: typeof import("../src/lib/integrations/woo-taxonomy-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let sync: typeof import("../src/lib/integrations/sync-service");
let media: typeof import("../src/lib/media-service");

const biz = { id: "", locationId: "", userId: "", pluginConnId: "", restConnId: "" };

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

/**
 * A connection made through the real service, so the plugin-token constraint
 * (a plugin connection must carry a hashed + encrypted token) is satisfied the
 * same way the app satisfies it. The connection is then marked `active` so the
 * overview's active count is exercised.
 */
async function makeConnection(linkMode: "plugin" | "rest_api", name: string): Promise<string> {
  const result = await connections.createConnection(biz.id, biz.userId, {
    name,
    baseUrl: "https://shop.example.com",
    linkMode,
    currencyUnit: "toman",
    consumerKey: linkMode === "rest_api" ? "ck_test" : undefined,
    consumerSecret: linkMode === "rest_api" ? "cs_test" : undefined,
    locationId: biz.locationId,
  });
  if (!result.ok) throw new Error(`createConnection failed: ${result.error}`);
  await db.query(`UPDATE integration_connections SET status = 'active' WHERE id = $1`, [result.connection.id]);
  return result.connection.id;
}

beforeAll(async () => {
  databaseName = `pos_wp_mgr_${randomUUID().replaceAll("-", "")}`;

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
  manager = await import("../src/lib/integrations/wp-manager-service");
  identity = await import("../src/lib/crm-external-identity");
  outbox = await import("../src/lib/integrations/outbox-service");
  content = await import("../src/lib/integrations/wp-content-service");
  ingest = await import("../src/lib/integrations/webhook-ingest-service");
  plugin = await import("../src/lib/integrations/plugin-service");
  taxonomy = await import("../src/lib/integrations/woo-taxonomy-service");
  connections = await import("../src/lib/integrations/connections-service");
  sync = await import("../src/lib/integrations/sync-service");
  media = await import("../src/lib/media-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Shop', $1, 'accessories') RETURNING id",
    [`wp-mgr-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  biz.userId = userRow.rows[0].id;

  biz.pluginConnId = await makeConnection("plugin", "Plugin Store");
  biz.restConnId = await makeConnection("rest_api", "REST Store");
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

const conn = () => ({ id: biz.pluginConnId, business_id: biz.id }) as never;

describe("the content mirror upserts and decodes what WordPress sends", () => {
  it("creates a row, decodes its list title and retains raw editable fields", async () => {
    const outcome = await content.upsertWpContent(conn(), {
      id: 101,
      type: "post",
      // wptexturize output: apostrophe + curly quotes + ellipsis, plus a tag.
      title: {
        rendered: "<b>Caf&#233;</b>&#8217;s &#8220;News&#8221;&#8230;",
        raw: "Café's News",
      },
      content: { rendered: "<p>Rendered</p>", raw: "<!-- wp:paragraph --><p>Raw</p><!-- /wp:paragraph -->" },
      excerpt: { rendered: "<p>Rendered summary</p>", raw: "Raw summary" },
      status: "publish",
      slug: "cafe-news",
      link: "https://shop.example.com/cafe-news",
      date_modified: "2026-02-01T11:00:00+01:00",
      modified_gmt: "2026-02-01T10:00:00",
    });
    expect(outcome).toBe("created");

    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "post" });
    const row = rows.find((r) => r.remoteId === "101");
    expect(row).toBeTruthy();
    // The whole point of the fix: no raw &#8217; / &#8230; in front of the owner.
    expect(row!.title).toBe("Café’s “News”…");
    expect(row!.slug).toBe("cafe-news");
    expect(row!.status).toBe("publish");

    const detail = await content.getWpContent(biz.id, biz.pluginConnId, "post", "101");
    expect(detail?.editorTitle).toBe("Café's News");
    expect(detail?.content).toBe("<!-- wp:paragraph --><p>Raw</p><!-- /wp:paragraph -->");
    expect(detail?.excerpt).toBe("Raw summary");
    expect(new Date(detail!.remoteUpdatedAt!).toISOString()).toBe("2026-02-01T10:00:00.000Z");
  });

  it("updates one row on a re-send rather than duplicating it", async () => {
    await content.upsertWpContent(conn(), { id: 101, type: "post", title: "Renamed", status: "draft" });
    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "post" });
    const matching = rows.filter((r) => r.remoteId === "101");
    expect(matching).toHaveLength(1);
    expect(matching[0].title).toBe("Renamed");
    expect(matching[0].status).toBe("draft");
  });

  it("keeps a media attachment's safe source url, mime type and alt text", async () => {
    await content.upsertWpContent(conn(), {
      id: 900,
      type: "attachment",
      title: "Logo",
      source_url: "https://shop.example.com/logo.png",
      mime_type: "image/png",
      alt_text: "نشان فروشگاه",
    });
    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "attachment" });
    const media = rows.find((r) => r.remoteId === "900");
    expect(media?.mediaUrl).toBe("https://shop.example.com/logo.png");
    expect(media?.mimeType).toBe("image/png");
    expect(media?.altText).toBe("نشان فروشگاه");

    await content.upsertWpContent(conn(), {
      id: 901,
      type: "attachment",
      title: "Unsafe",
      source_url: "javascript:alert(1)",
      mime_type: "image/svg+xml",
    });
    const unsafe = (await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "attachment" }))
      .find((row) => row.remoteId === "901");
    expect(unsafe?.mediaUrl).toBeNull();
    expect(await content.deleteWpContent(biz.id, biz.pluginConnId, { id: 901, type: "attachment" })).toBe(true);
  });

  it("ignores invalid ids, unsafe links and malformed remote dates", async () => {
    await content.upsertWpContent(conn(), { id: 0, type: "post", title: "nope" });
    await content.upsertWpContent(conn(), { id: "", type: "post", title: "nope" });
    await content.upsertWpContent(conn(), {
      id: 102,
      type: "post",
      title: "Safe row",
      link: "javascript:alert(1)",
      date_modified: "not-a-date",
    });
    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "post" });
    expect(rows.some((r) => r.title === "nope")).toBe(false);
    const safe = rows.find((r) => r.remoteId === "102");
    expect(safe?.permalink).toBe("");
    expect(safe?.remoteUpdatedAt).toBeNull();
  });

  it("counts posts, pages and media by type", async () => {
    await content.upsertWpContent(conn(), { id: 200, type: "page", title: "About" });
    const counts = await content.wpContentCounts(biz.id, biz.pluginConnId);
    expect(counts.posts).toBeGreaterThanOrEqual(1);
    expect(counts.pages).toBe(1);
    expect(counts.media).toBe(1);
  });

  it("filters and pages media without hiding attachments after the first result page", async () => {
    await content.upsertWpContent(conn(), {
      id: 902,
      type: "attachment",
      title: "Launch video",
      source_url: "https://shop.example.com/launch.mp4",
      mime_type: "video/mp4",
    });
    await content.upsertWpContent(conn(), {
      id: 903,
      type: "attachment",
      title: "Price list",
      source_url: "https://shop.example.com/prices.pdf",
      mime_type: "application/pdf",
    });

    const videos = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      mediaKind: "video",
    });
    expect(videos.map((row) => row.remoteId)).toEqual(["902"]);
    expect(await content.countWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      mediaKind: "document",
    })).toBe(1);

    const first = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      limit: 1,
      offset: 0,
    });
    const second = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      limit: 1,
      offset: 1,
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].remoteId).not.toBe(first[0].remoteId);

    await content.deleteWpContent(biz.id, biz.pluginConnId, { id: 902, type: "attachment" });
    await content.deleteWpContent(biz.id, biz.pluginConnId, { id: 903, type: "attachment" });
  });

  it("applies plugin deletion and full-sync watermark events", async () => {
    await content.upsertWpContent(conn(), {
      id: 990,
      type: "attachment",
      title: "Delete me",
      source_url: "https://shop.example.com/delete-me.jpg",
      mime_type: "image/jpeg",
    });
    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    expect(connection).toBeTruthy();

    const deleted = await ingest.ingestPluginEvent(connection!, {
      topic: "content.deleted",
      deliveryId: randomUUID(),
      payload: { id: 990, type: "attachment" },
    });
    expect(deleted.status).toBe("processed");
    expect((await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "attachment" }))
      .some((row) => row.remoteId === "990")).toBe(false);

    const snapshotId = randomUUID();
    await content.upsertWpContent(conn(), { id: 991, type: "post", title: "Stale snapshot row" });
    await content.upsertWpContent(conn(), { id: 992, type: "post", title: "Current snapshot row", _snapshot_id: snapshotId });
    // Model the plugin's complete export by tagging all current mirror rows
    // except the deliberately stale row as seen in this generation.
    await db.query(
      `UPDATE integration_wp_content
          SET payload = jsonb_set(payload, '{_snapshot_id}', to_jsonb($3::text))
        WHERE business_id = $1 AND connection_id = $2 AND remote_id <> '991'`,
      [biz.id, biz.pluginConnId, snapshotId],
    );
    const expectedSnapshotRows = Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_wp_content
        WHERE business_id = $1 AND connection_id = $2 AND payload->>'_snapshot_id' = $3`,
      [biz.id, biz.pluginConnId, snapshotId],
    )).rows[0].n);
    const incompleteSnapshot = randomUUID();
    const incompleteDeliveryId = randomUUID();
    const incomplete = await ingest.ingestPluginEvent(connection!, {
      topic: "content.sync_completed",
      deliveryId: incompleteDeliveryId,
      payload: { id: incompleteSnapshot, _snapshot_id: incompleteSnapshot, type: "content", count: 2 },
    });
    expect(incomplete.status).toBe("failed");
    expect(await content.getWpContent(biz.id, biz.pluginConnId, "post", "991")).toBeTruthy();
    await db.query(`DELETE FROM integration_webhook_events WHERE delivery_id = $1`, [incompleteDeliveryId]);

    const completed = await ingest.ingestPluginEvent(connection!, {
      topic: "content.sync_completed",
      deliveryId: randomUUID(),
      payload: { id: snapshotId, _snapshot_id: snapshotId, type: "content", count: expectedSnapshotRows },
    });
    expect(completed.status).toBe("processed");
    expect(await content.getWpContent(biz.id, biz.pluginConnId, "post", "991")).toBeNull();
    expect(await content.getWpContent(biz.id, biz.pluginConnId, "post", "992")).toBeTruthy();
    expect((await connections.getConnection(biz.id, biz.pluginConnId))?.last_content_sync_at).toBeTruthy();

    await content.upsertWpContent(conn(), { id: 104, type: "page", title: "Delete me too" });
    await db.query(`UPDATE integration_connections SET last_content_sync_at = NULL WHERE id = $1`, [biz.pluginConnId]);
    const secondSnapshotId = randomUUID();
    await db.query(
      `UPDATE integration_wp_content
          SET payload = jsonb_set(payload, '{_snapshot_id}', to_jsonb($3::text))
        WHERE business_id = $1 AND connection_id = $2 AND remote_id <> '104'`,
      [biz.id, biz.pluginConnId, secondSnapshotId],
    );
    const secondSnapshotRows = Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_wp_content
        WHERE business_id = $1 AND connection_id = $2 AND payload->>'_snapshot_id' = $3`,
      [biz.id, biz.pluginConnId, secondSnapshotId],
    )).rows[0].n);
    const response = await plugin.pluginPushEvents(conn(), {
      events: [
        {
          topic: "content.deleted",
          deliveryId: randomUUID(),
          payload: { id: 104, type: "page" },
        },
        {
          topic: "content.sync_completed",
          deliveryId: randomUUID(),
          payload: { id: secondSnapshotId, _snapshot_id: secondSnapshotId, type: "content", count: secondSnapshotRows },
        },
      ],
    });
    const answer = (await response.json()) as { results: { status: string }[] };
    expect(answer.results.map((result) => result.status)).toEqual(["processed", "processed"]);
    expect(await content.getWpContent(biz.id, biz.pluginConnId, "page", "104")).toBeNull();
    expect((await connections.getConnection(biz.id, biz.pluginConnId))?.last_content_sync_at).toBeTruthy();
  });

  it("filters by title or slug, counts matches and removes permanent deletions", async () => {
    const hits = await content.listWpContent(biz.id, biz.pluginConnId, { search: "About" });
    expect(hits.every((r) => r.title.includes("About"))).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(1);

    await content.upsertWpContent(conn(), { id: 103, type: "post", title: "Different", slug: "needle-slug" });
    const slugHits = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "post",
      search: "needle-slug",
      limit: 1,
      offset: 0,
    });
    expect(slugHits.map((row) => row.remoteId)).toEqual(["103"]);
    expect(await content.countWpContent(biz.id, biz.pluginConnId, { wpType: "post", search: "needle-slug" })).toBe(1);

    expect(await content.deleteWpContent(biz.id, biz.pluginConnId, "post", "103")).toBe(true);
    expect(await content.getWpContent(biz.id, biz.pluginConnId, "post", "103")).toBeNull();
  });
});

describe("the overview counts what the manager mirrors", () => {
  it("counts connections by link mode across the business", async () => {
    const stats = await manager.wpOverviewStats(biz.id);
    expect(stats.connections.total).toBe(2);
    expect(stats.connections.plugin).toBe(1);
    expect(stats.connections.rest).toBe(1);
    expect(stats.connections.active).toBe(2);
    // Content mirrored above sums across the business.
    expect(stats.content.posts).toBeGreaterThanOrEqual(1);
    expect(stats.content.pages).toBe(1);
    expect(stats.content.media).toBe(1);
  });

  it("counts mapped products/orders/customers and terms for one connection", async () => {
    // A product mapping needs a real local item to point at (FK-free here, it
    // stores the uuid as text), plus a customer party and an order.
    const party = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone) VALUES ($1, 'سارا', '09120000000') RETURNING id`,
      [biz.id],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, customer_id, total)
       VALUES ($1, 5555, 'completed', $2, 30000) RETURNING id`,
      [biz.locationId, party.rows[0].id],
    );

    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '5001', $3),
              ($1, $2, 'customer', '7001', $4),
              ($1, $2, 'order', '9001', $5)`,
      [biz.id, biz.pluginConnId, randomUUID(), party.rows[0].id, order.rows[0].id],
    );
    await db.query(
      `INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name, slug)
       VALUES ($1, $2, 'product_cat', '11', 'پوشاک', 'clothing')`,
      [biz.id, biz.pluginConnId],
    );

    const stats = await manager.wpOverviewStats(biz.id, biz.pluginConnId);
    expect(stats.products).toBe(1);
    expect(stats.customers).toBe(1);
    expect(stats.orders).toBe(1);
    expect(stats.terms).toBe(1);
  });

  it("counts pending and failed queue depth from outbox and inbox", async () => {
    await db.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, status)
       VALUES ($1, $2, 'stock', '5001', '{}'::jsonb, 'pending'),
              ($1, $2, 'price', '5001', '{}'::jsonb, 'failed'),
              ($1, $2, 'product_update', '5002', '{}'::jsonb, 'dead')`,
      [biz.id, biz.pluginConnId],
    );
    await db.query(
      `INSERT INTO integration_webhook_events
         (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
       VALUES ($1, $2, 'order.created', '9002', $3, '{}'::jsonb, 'failed'),
              ($1, $2, 'order.created', '9003', $4, '{}'::jsonb, 'pending')`,
      [biz.id, biz.pluginConnId, randomUUID(), randomUUID()],
    );

    const stats = await manager.wpOverviewStats(biz.id, biz.pluginConnId);
    // pending + processing + failed
    expect(stats.pendingJobs).toBe(2);
    expect(stats.failedJobs).toBe(1);
    expect(stats.deadJobs).toBe(1);
    expect(stats.pendingInboxEvents).toBe(1);
    expect(stats.failedInboxEvents).toBe(1);
  });

  it("the overview's queue tile and the Queue page summary reconcile per store, including needs_review and deferred (#944 / OVR-03)", async () => {
    // Two rows the old overview left out of its KPIs: an outbound row that
    // needs a decision, and an inbound delivery deferred during a pause.
    await db.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, status)
       VALUES ($1, $2, 'product_update', '5003', '{}'::jsonb, 'needs_review')`,
      [biz.id, biz.pluginConnId],
    );
    await db.query(
      `INSERT INTO integration_webhook_events
         (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
       VALUES ($1, $2, 'order.updated', '9004', $3, '{}'::jsonb, 'deferred')`,
      [biz.id, biz.pluginConnId, randomUUID()],
    );
    // Noise on the sibling store: must never appear in the plugin store's counts.
    await db.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, status)
       VALUES ($1, $2, 'stock', '6001', '{}'::jsonb, 'failed')`,
      [biz.id, biz.restConnId],
    );

    const [stats, summary, siblingStats, siblingSummary] = await Promise.all([
      manager.wpOverviewStats(biz.id, biz.pluginConnId),
      manager.wpQueueSummary(biz.id, biz.pluginConnId),
      manager.wpOverviewStats(biz.id, biz.restConnId),
      manager.wpQueueSummary(biz.id, biz.restConnId),
    ]);

    const { oldestOpenAt: _oldestOpenAt, nextRetryAt: _nextRetryAt, ...summaryCounts } = summary;
    const {
      oldestOpenAt: _siblingOldestOpenAt,
      nextRetryAt: _siblingNextRetryAt,
      ...siblingSummaryCounts
    } = siblingSummary;
    expect(stats.queue).toEqual(summaryCounts);
    expect(siblingStats.queue).toEqual(siblingSummaryCounts);
    expect(stats.queue.needsReview).toBeGreaterThanOrEqual(1);
    expect(stats.queue.deferred).toBeGreaterThanOrEqual(1);
    expect(stats.queue.inFlight).toBe(stats.queue.pending + stats.queue.processing);
    expect(stats.queue.attention).toBe(stats.queue.failed + stats.queue.dead);
    expect(stats.queue.open).toBe(stats.queue.inFlight + stats.queue.attention);
    // Strictly the selected store's rows: the REST store has exactly its one failed job.
    expect(siblingStats.queue.total).toBe(1);
    expect(siblingStats.queue.attention).toBe(1);
    expect(siblingStats.queue.needsReview).toBe(0);
    // And a different business sees nothing of either store.
    const stranger = await manager.wpOverviewStats(randomUUID(), biz.pluginConnId);
    expect(stranger.connections.total).toBe(0);
    expect(stranger.queue.total).toBe(0);

    // Leave the queue as the later filter/retry tests expect it.
    await db.query(`DELETE FROM integration_outbox_events WHERE connection_id = $1 AND remote_id IN ('5003', '6001')`, [
      biz.pluginConnId,
    ]);
    await db.query(`DELETE FROM integration_outbox_events WHERE connection_id = $1 AND remote_id = '6001'`, [biz.restConnId]);
    await db.query(`DELETE FROM integration_webhook_events WHERE connection_id = $1 AND remote_id = '9004'`, [biz.pluginConnId]);
  });
});

describe("overview connection allowlists", () => {
  it("has identical single-connection counts for a UUID and a one-element allowlist", async () => {
    expect(await manager.wpOverviewStats(biz.id, [biz.pluginConnId]))
      .toEqual(await manager.wpOverviewStats(biz.id, biz.pluginConnId));
  });

  it("sums the allowed connections without double-counting repeated IDs", async () => {
    expect(await manager.wpOverviewStats(biz.id, [biz.pluginConnId, biz.restConnId, biz.pluginConnId]))
      .toEqual(await manager.wpOverviewStats(biz.id));
  });

  it("returns no business data for an explicit empty or foreign allowlist", async () => {
    const empty = await manager.wpOverviewStats(biz.id, []);
    expect(empty).toEqual({
      connections: { total: 0, active: 0, plugin: 0, rest: 0 },
      products: 0, orders: 0, customers: 0, terms: 0,
      content: { posts: 0, pages: 0, media: 0 },
      pendingJobs: 0, failedJobs: 0, deadJobs: 0, pendingInboxEvents: 0, failedInboxEvents: 0,
      // #944 / OVR-03: the overview's queue tile shares the Queue page classification.
      queue: {
        total: 0, pending: 0, processing: 0, sent: 0, failed: 0, dead: 0, deferred: 0, needsReview: 0,
        // `skipped` is part of the shared queue classification (#942): a job the
        // plugin's policy deliberately did not apply.
        skipped: 0,
        inboundPending: 0, inboundFailed: 0, outboundFailed: 0, inFlight: 0, attention: 0, open: 0,
      },
    });
    expect(await manager.wpOverviewStats(biz.id, [randomUUID()])).toEqual(empty);
    expect(await manager.wpOverviewStats(randomUUID(), [biz.pluginConnId])).toEqual(empty);
  });

  it("does not count retained content or queue rows after disconnect", async () => {
    const before = await manager.wpOverviewStats(biz.id, [biz.pluginConnId]);
    expect(before.content.posts).toBeGreaterThan(0);
    expect(before.pendingJobs).toBeGreaterThan(0);
    const columns = ["status", "consumer_key_ciphertext", "consumer_secret_ciphertext", "wp_username_ciphertext",
      "wp_application_password_ciphertext", "link_token_hash", "link_token_ciphertext"];
    const { rows: [saved] } = await db.query(`SELECT ${columns.join(", ")} FROM integration_connections WHERE id = $1`, [biz.pluginConnId]);
    await db.query(`UPDATE integration_connections SET deleted_at = now(), status = 'paused',
      consumer_key_ciphertext = NULL, consumer_secret_ciphertext = NULL, wp_username_ciphertext = NULL,
      wp_application_password_ciphertext = NULL, link_token_hash = NULL, link_token_ciphertext = NULL
      WHERE id = $1`, [biz.pluginConnId]);
    try {
      expect(await manager.wpOverviewStats(biz.id, [biz.pluginConnId]))
        .toEqual(await manager.wpOverviewStats(biz.id, []));
    } finally {
      await db.query(`UPDATE integration_connections SET deleted_at = NULL,
        ${columns.map((column, index) => `${column} = $${index + 2}`).join(", ")}
        WHERE id = $1`, [biz.pluginConnId, ...columns.map((column) => saved[column])]);
    }
  });
});

describe("the operational queue and the customer list", () => {
  it("merges outbound outbox jobs and inbound inbox failures, newest first", async () => {
    const rows = await manager.wpQueue(biz.id, biz.pluginConnId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.direction === "out")).toBe(true);
    expect(rows.some((r) => r.direction === "in")).toBe(true);
    // A dead outbox job is part of the operational queue.
    expect(rows.some((r) => r.status === "dead")).toBe(true);
    // Sorted by created_at DESC — timestamps are non-increasing.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].createdAt >= rows[i].createdAt).toBe(true);
    }
  });

  it("includes store profiles that are unresolved and have no legacy mapping", async () => {
    const profile = await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: biz.pluginConnId,
        provider: "woocommerce",
        remoteId: "profile-only-7601",
        name: "Unresolved store account",
        email: null,
        phone: null,
      },
      { allowCreate: false },
    );
    expect(profile.status).toBe("unmapped");

    const page = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { pageSize: 100 });
    const customer = page.customers.find((row) => row.remoteId === "profile-only-7601");
    expect(customer).toMatchObject({
      localId: null,
      identityStatus: "unmapped",
      name: "Unresolved store account",
    });
    expect(page.total).toBe(page.customers.length);
  });

  it("adopts a valid legacy mapping instead of creating a duplicate party on first profile sync", async () => {
    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    expect(connection).toBeTruthy();
    const party = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name) VALUES ($1, 'Legacy Buyer') RETURNING id`,
      [biz.id],
    );
    const remoteId = 7701;
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'customer', $3, $4)`,
      [biz.id, biz.pluginConnId, String(remoteId), party.rows[0].id],
    );

    const outcome = await sync.upsertCustomerFromWoo(connection!, {
      id: remoteId,
      first_name: "Legacy",
      last_name: "Buyer",
      email: "",
      date_modified: "2026-10-19T10:00:00Z",
      billing: {},
    });
    expect(outcome).toBe("updated");
    const { rows: profile } = await db.query<{ party_id: string | null; status: string; match_reason: string }>(
      `SELECT party_id, status, match_reason FROM crm_external_profiles
        WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3`,
      [biz.id, biz.pluginConnId, String(remoteId)],
    );
    expect(profile[0]).toMatchObject({
      party_id: party.rows[0].id,
      status: "confirmed",
      match_reason: "legacy_mapping",
    });
    const { rows: parties } = await db.query<{ id: string }>(
      `SELECT id FROM parties WHERE business_id = $1 AND name = 'Legacy Buyer'`,
      [biz.id],
    );
    expect(parties).toEqual([{ id: party.rows[0].id }]);
    const { rows: mappings } = await db.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = $3 AND local_id = $4`,
      [biz.id, biz.pluginConnId, String(remoteId), party.rows[0].id],
    );
    expect(mappings).toHaveLength(1);
  });

  it("resumes bounded REST batches and verifies missing IDs before tombstoning shifted-page customers", async () => {
    const restConnId = await makeConnection("rest_api", "Resumable REST Store");
    const actuallyDeleted = await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: restConnId,
        provider: "woocommerce",
        remoteId: "9300",
        name: "Actually deleted account",
        email: "deleted-sync-customer@example.test",
      },
      { allowCreate: true },
    );
    const skippedByMovingOffset = await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: restConnId,
        provider: "woocommerce",
        remoteId: "9301",
        name: "Still active Verified",
        email: "active-after-page-shift@example.test",
      },
      { allowCreate: true },
    );
    await db.query(
      `UPDATE crm_external_profiles SET last_synced_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`,
      [[actuallyDeleted.profileId, skippedByMovingOffset.profileId]],
    );

    const requests: number[] = [];
    const includeRequests: string[][] = [];
    const originalFetch = globalThis.fetch;
    const pageRows = new Map<number, Record<string, unknown>>([
      [1, { id: 9101, first_name: "Sync", last_name: "One", email: "sync-9101@example.test", date_modified: "2026-10-19T10:00:00Z", billing: {} }],
      [2, { id: 9102, first_name: "Sync", last_name: "Two", email: "sync-9102@example.test", date_modified: "2026-10-19T10:00:00Z", billing: {} }],
      [3, { id: 9103, first_name: "Sync", last_name: "Three", email: "sync-9103@example.test", date_modified: "2026-10-19T10:00:00Z", billing: {} }],
      [4, { id: 9104, first_name: "Sync", last_name: "Four", email: "sync-9104@example.test", date_modified: "2026-10-19T10:00:00Z", billing: {} }],
    ]);
    const exactCustomerRows = new Map<string, Record<string, unknown>>([
      ["9301", {
        id: 9301,
        first_name: "Still active",
        last_name: "Verified",
        email: "active-after-page-shift@example.test",
        date_modified: "2026-10-19T10:00:00Z",
        billing: {},
      }],
    ]);
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const include = url.searchParams.get("include");
      if (include) {
        const ids = include.split(",");
        includeRequests.push(ids);
        const rows = ids.flatMap((id) => exactCustomerRows.has(id) ? [exactCustomerRows.get(id)] : []);
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "X-WP-TotalPages": "1", "Content-Type": "application/json" },
        });
      }
      const page = Number(url.searchParams.get("page") ?? 1);
      requests.push(page);
      return new Response(JSON.stringify(pageRows.has(page) ? [pageRows.get(page)] : []), {
        status: 200,
        headers: { "X-WP-TotalPages": "4", "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const first = await sync.syncCustomers(biz.id, restConnId, { requestedBy: biz.userId });
      expect(first).toMatchObject({ status: "partial", hasMore: true, currentPage: 4, total: 3 });
      expect(await manager.wpCustomerSyncStatus(biz.id, restConnId)).toMatchObject({
        transport: "rest_api",
        status: "partial",
        processed: 3,
        currentPage: 4,
        totalPages: 4,
        hasError: false,
      });
      expect(requests).toEqual([1, 2, 3]);
      const { rows: beforeFinalPage } = await db.query<{ remote_id: string; remote_deleted_at: string | null }>(
        `SELECT remote_id, remote_deleted_at FROM crm_external_profiles
          WHERE id = ANY($1::uuid[]) ORDER BY remote_id`,
        [[actuallyDeleted.profileId, skippedByMovingOffset.profileId]],
      );
      expect(beforeFinalPage).toEqual([
        { remote_id: "9300", remote_deleted_at: null },
        { remote_id: "9301", remote_deleted_at: null },
      ]);

      const resumed = await sync.syncCustomers(biz.id, restConnId, { requestedBy: biz.userId });
      expect(resumed).toMatchObject({
        status: "completed",
        hasMore: false,
        total: 6,
        created: 4,
        updated: 1,
        deleted: 1,
        failed: 0,
      });
      expect(await manager.wpCustomerSyncStatus(biz.id, restConnId)).toMatchObject({
        transport: "rest_api",
        status: "completed",
        expected: 6,
        processed: 6,
        pending: 0,
        failed: 0,
        deleted: 1,
        hasError: false,
      });
      expect(requests).toEqual([1, 2, 3, 4]);
      expect(includeRequests).toEqual([["9300", "9301"]]);
      const { rows: afterFinalPage } = await db.query<{ remote_id: string; remote_deleted_at: string | null }>(
        `SELECT remote_id, remote_deleted_at FROM crm_external_profiles
          WHERE id = ANY($1::uuid[]) ORDER BY remote_id`,
        [[actuallyDeleted.profileId, skippedByMovingOffset.profileId]],
      );
      expect(afterFinalPage[0].remote_deleted_at).toBeTruthy();
      expect(afterFinalPage[1].remote_deleted_at).toBeNull();
      const { rows: verifiedMapping } = await db.query(
        `SELECT 1 FROM integration_mappings
          WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = '9301'`,
        [biz.id, restConnId],
      );
      expect(verifiedMapping).toHaveLength(1);
      const { rows: run } = await db.query<{ requested_by: string; current_page: number; total_pages: number }>(
        `SELECT requested_by, current_page, total_pages FROM integration_customer_sync_runs WHERE id = $1`,
        [resumed.runId],
      );
      expect(run[0]).toMatchObject({ requested_by: biz.userId, current_page: 5, total_pages: 4 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records failed REST rows and retries the same cursor before completing the snapshot", async () => {
    const restConnId = await makeConnection("rest_api", "Retry REST Store");
    const oldProfile = await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: restConnId,
        provider: "woocommerce",
        remoteId: "9302",
        name: "Preserve until retry",
        email: "old-before-retry@example.test",
      },
      { allowCreate: true },
    );
    await db.query(
      `UPDATE crm_external_profiles SET last_synced_at = now() - interval '1 minute' WHERE id = $1`,
      [oldProfile.profileId],
    );

    const requests: number[] = [];
    const originalFetch = globalThis.fetch;
    let failFirstAttempt = true;
    let failFirstTransport = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has("include")) {
        return new Response("[]", {
          status: 200,
          headers: { "X-WP-TotalPages": "0", "Content-Type": "application/json" },
        });
      }
      requests.push(Number(url.searchParams.get("page") ?? 1));
      if (failFirstTransport) {
        failFirstTransport = false;
        return new Response(JSON.stringify({ message: "Temporary store error" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const customer = {
        id: 9201,
        first_name: "Retry",
        last_name: "Me",
        email: "retry-customer@example.test",
        date_modified: failFirstAttempt ? "not-a-date" : "2026-10-19T10:00:00Z",
        billing: {},
      };
      return new Response(JSON.stringify([customer]), {
        status: 200,
        headers: { "X-WP-TotalPages": "1", "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const failed = await sync.syncCustomers(biz.id, restConnId, { requestedBy: biz.userId });
      expect(failed).toMatchObject({ status: "partial", hasMore: false, currentPage: 1, failed: 1 });
      expect(failed.lastError).toBe("customer_page_partial");
      expect(requests).toEqual([1, 1]);
      const { rows: beforeRetry } = await db.query<{ remote_deleted_at: string | null }>(
        `SELECT remote_deleted_at FROM crm_external_profiles WHERE id = $1`,
        [oldProfile.profileId],
      );
      expect(beforeRetry[0].remote_deleted_at).toBeNull();

      failFirstAttempt = false;
      const retried = await sync.syncCustomers(biz.id, restConnId, { requestedBy: biz.userId });
      expect(retried).toMatchObject({
        status: "completed",
        hasMore: false,
        currentPage: 2,
        failed: 0,
        created: 1,
        deleted: 1,
        total: 2,
      });
      expect(requests).toEqual([1, 1, 1]);
      const { rows: afterRetry } = await db.query<{ remote_deleted_at: string | null }>(
        `SELECT remote_deleted_at FROM crm_external_profiles WHERE id = $1`,
        [oldProfile.profileId],
      );
      expect(afterRetry[0].remote_deleted_at).toBeTruthy();
      const { rows: runItem } = await db.query<{ outcome: string; attempts: number }>(
        `SELECT outcome, attempts FROM integration_customer_sync_run_items WHERE run_id = $1 AND remote_id = '9201'`,
        [retried.runId],
      );
      expect(runItem[0]).toMatchObject({ outcome: "created", attempts: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not declare an empty offset page complete while Woo reports later pages", async () => {
    const restConnId = await makeConnection("rest_api", "Unstable REST Store");
    const profile = await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: restConnId,
        provider: "woocommerce",
        remoteId: "9304",
        name: "Keep during unstable page walk",
        email: "unstable-page@example.test",
      },
      { allowCreate: true },
    );
    await db.query(
      `UPDATE crm_external_profiles SET last_synced_at = now() - interval '1 minute' WHERE id = $1`,
      [profile.profileId],
    );

    const requests: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has("include")) throw new Error("absence verification must not run");
      requests.push(Number(url.searchParams.get("page") ?? 1));
      return new Response("[]", {
        status: 200,
        headers: { "X-WP-TotalPages": "2", "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await sync.syncCustomers(biz.id, restConnId, { requestedBy: biz.userId });
      expect(result).toMatchObject({
        status: "partial",
        currentPage: 1,
        totalPages: 2,
        lastError: "customer_page_empty_before_end",
        deleted: 0,
        failed: 0,
        hasMore: false,
      });
      expect(requests).toEqual([1]);
      const { rows } = await db.query<{ remote_deleted_at: string | null }>(
        `SELECT remote_deleted_at FROM crm_external_profiles WHERE id = $1`,
        [profile.profileId],
      );
      expect(rows[0].remote_deleted_at).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves a legacy mapping as a CRM-linked tombstone after exact REST absence verification", async () => {
    const party = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone, email)
       VALUES ($1, 'Legacy linked customer', '09123334444', 'legacy-link@example.test') RETURNING id`,
      [biz.id],
    );
    const remoteId = "9303";
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'customer', $3, $4)`,
      [biz.id, biz.restConnId, remoteId, party.rows[0].id],
    );
    await db.query(
      `UPDATE integration_mappings SET updated_at = now() - interval '1 minute'
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = $3`,
      [biz.id, biz.restConnId, remoteId],
    );

    const tombstoned = await identity.markWooCustomerVerifiedAbsent(
      biz.id,
      biz.restConnId,
      remoteId,
      new Date().toISOString(),
    );
    expect(tombstoned).toBe(true);
    const { rows: profile } = await db.query<{
      party_id: string | null;
      status: string;
      remote_deleted_at: string | null;
      match_reason: string;
    }>(
      `SELECT party_id, status, remote_deleted_at, match_reason FROM crm_external_profiles
        WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3`,
      [biz.id, biz.restConnId, remoteId],
    );
    expect(profile[0]).toMatchObject({
      party_id: party.rows[0].id,
      status: "confirmed",
      match_reason: "remote_deleted",
    });
    expect(profile[0].remote_deleted_at).toBeTruthy();
    const remainingMapping = await db.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = $3`,
      [biz.id, biz.restConnId, remoteId],
    );
    expect(remainingMapping.rows).toHaveLength(0);
    const defaultList = await manager.wpStoreCustomers(biz.id, biz.restConnId);
    expect(defaultList.customers.some((row) => row.remoteId === remoteId)).toBe(false);
    const deletedList = await manager.wpStoreCustomers(biz.id, biz.restConnId, { remoteFilter: "deleted" });
    expect(deletedList.customers.find((row) => row.remoteId === remoteId)).toMatchObject({
      localId: party.rows[0].id,
      identityStatus: "remote_deleted",
      remoteStatus: "deleted",
      name: "Legacy linked customer",
    });
  });

  it("keeps the plugin customer watermark behind failed export rows until their retry succeeds", async () => {
    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    expect(connection).toBeTruthy();
    const runId = randomUUID();
    const deliveryId = randomUUID();
    await db.query(`UPDATE integration_connections SET last_customer_sync_at = NULL WHERE id = $1`, [biz.pluginConnId]);

    const failed = await ingest.ingestPluginEvent(connection!, {
      topic: "customer.updated",
      deliveryId,
      payload: {
        id: 8801,
        first_name: "",
        last_name: "",
        email: "",
        date_modified: "not-a-date",
        billing: {},
        __pos_customer_sync_id: runId,
      },
    });
    expect(failed.status).toBe("failed");

    const marker = await ingest.ingestPluginEvent(connection!, {
      topic: "customers.sync_completed",
      deliveryId: randomUUID(),
      payload: { id: runId, sync_id: runId, type: "customers", count: 1 },
    });
    expect(marker.status).toBe("processed");
    const { rows: partial } = await db.query<{ status: string; expected_count: number; last_error: string }>(
      `SELECT status, expected_count, last_error FROM integration_customer_sync_runs WHERE id = $1`,
      [runId],
    );
    expect(partial[0]).toMatchObject({
      status: "partial",
      expected_count: 1,
      last_error: "customer_events_failed",
    });
    expect(await manager.wpCustomerSyncStatus(biz.id, biz.pluginConnId)).toMatchObject({
      transport: "plugin",
      status: "partial",
      expected: 1,
      processed: 1,
      pending: 0,
      failed: 1,
      hasError: true,
    });
    const { rows: beforeRetry } = await db.query<{ last_customer_sync_at: string | null }>(
      `SELECT last_customer_sync_at FROM integration_connections WHERE id = $1`,
      [biz.pluginConnId],
    );
    expect(beforeRetry[0].last_customer_sync_at).toBeNull();

    const retried = await ingest.ingestPluginEvent(connection!, {
      topic: "customer.updated",
      deliveryId,
      payload: {
        id: 8801,
        first_name: "",
        last_name: "",
        email: "",
        date_modified: "2026-10-19T10:00:00Z",
        billing: {},
        __pos_customer_sync_id: runId,
      },
    });
    expect(retried.status).toBe("processed");
    const { rows: completed } = await db.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM integration_customer_sync_runs WHERE id = $1`,
      [runId],
    );
    expect(completed[0]).toMatchObject({ status: "completed", last_error: null });
    const { rows: afterRetry } = await db.query<{ last_customer_sync_at: string | null }>(
      `SELECT last_customer_sync_at FROM integration_connections WHERE id = $1`,
      [biz.pluginConnId],
    );
    expect(afterRetry[0].last_customer_sync_at).toBeTruthy();
  });

  it("tombstones remotely deleted accounts without deleting canonical CRM history or allowing stale resurrection", async () => {
    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    expect(connection).toBeTruthy();
    const remoteId = "9901";
    const profile = await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: biz.pluginConnId,
        provider: "woocommerce",
        remoteId,
        name: "Account to delete",
        email: "delete-me@example.test",
        phone: null,
      },
      { allowCreate: true },
    );
    expect(profile.partyId).toBeTruthy();
    const deletedAt = new Date().toISOString();
    const deleted = await ingest.ingestPluginEvent(connection!, {
      topic: "customer.deleted",
      deliveryId: randomUUID(),
      payload: { id: Number(remoteId), deleted_at: deletedAt },
    });
    expect(deleted.status).toBe("processed");

    const stale = await ingest.ingestPluginEvent(connection!, {
      topic: "customer.updated",
      deliveryId: randomUUID(),
      payload: {
        id: Number(remoteId),
        first_name: "Stale resurrection",
        last_name: "",
        email: "stale@example.test",
        date_modified: new Date(Date.parse(deletedAt) - 60_000).toISOString(),
        billing: {},
      },
    });
    expect(stale.status).toBe("processed");

    const { rows: profileRows } = await db.query<{
      party_id: string | null;
      remote_deleted_at: string | null;
      remote_name: string;
    }>(
      `SELECT party_id, remote_deleted_at, remote_name FROM crm_external_profiles
        WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3`,
      [biz.id, biz.pluginConnId, remoteId],
    );
    expect(profileRows[0].party_id).toBe(profile.partyId);
    expect(profileRows[0].remote_deleted_at).toBeTruthy();
    expect(profileRows[0].remote_name).toBe("Account to delete");
    const { rows: mappings } = await db.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'customer' AND remote_id = $3`,
      [biz.id, biz.pluginConnId, remoteId],
    );
    expect(mappings).toHaveLength(0);
    const { rows: parties } = await db.query<{ id: string }>(
      `SELECT id FROM parties WHERE business_id = $1 AND id = $2`,
      [biz.id, profile.partyId],
    );
    expect(parties).toHaveLength(1);
    expect(await sync.resolveOrderCustomerId(connection!, { customer_id: Number(remoteId) } as never)).toBeNull();
    expect(await identity.partyForExternalCustomer(biz.id, biz.pluginConnId, remoteId)).toBeNull();
    const storeCustomers = await manager.wpStoreCustomers(biz.id, biz.pluginConnId);
    expect(storeCustomers.customers.some((row) => row.remoteId === remoteId)).toBe(false);
  });

  it("lists the store's customers joined to their local party and online order count", async () => {
    const { customers: rows, total } = await manager.wpStoreCustomers(biz.id, biz.pluginConnId);
    expect(total).toBe(rows.length);

    const sara = rows.find((r) => r.remoteId === "7001");
    expect(sara).toBeTruthy();
    expect(sara!.name).toBe("سارا");
    expect(sara!.phone).toBe("09120000000");
    // Her one online order: the '9001' order mapping mirrored from this store.
    expect(sara!.ordersCount).toBe(1);

    // A count over `orders.customer_id` alone would confuse the badge
    // («سفارش آنلاین») with *every* sale the party ever made. Neither her
    // POS purchase (no order mapping) nor an order mirrored by the *other*
    // connection may move this store's number.
    await db.query(
      `INSERT INTO orders (location_id, order_number, status, customer_id, total)
       VALUES ($1, 5556, 'completed', $2, 10000)`,
      [biz.locationId, sara!.localId],
    );
    const mirroredElsewhere = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, customer_id, total)
       VALUES ($1, 5557, 'completed', $2, 20000) RETURNING id`,
      [biz.locationId, sara!.localId],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'order', '9010', $3)`,
      [biz.id, biz.restConnId, mirroredElsewhere.rows[0].id],
    );

    const again = await manager.wpStoreCustomers(biz.id, biz.pluginConnId);
    expect(again.customers.find((r) => r.remoteId === "7001")!.ordersCount).toBe(1);

    const restricted = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, {
      includePartyDetails: false,
      includeIdentityDetails: false,
      includeOrderCounts: false,
    });
    expect(restricted.customers.find((r) => r.remoteId === "7001")).toMatchObject({
      localId: null,
      externalProfileId: null,
      identityStatus: "unavailable",
      name: "",
      phone: null,
      email: null,
      ordersCount: null,
    });
  });

  it("classifies registered accounts, guests and non-buying subscribers and filters remote deletions", async () => {
    const identities = [
      {
        remoteId: "guest:guest-customer@example.test",
        name: "Guest customer",
        email: "guest-customer@example.test",
        payload: { billing: { email: "guest-customer@example.test" } },
      },
      {
        remoteId: "7604",
        name: "Subscriber without orders",
        payload: { role: "subscriber", orders_count: 0, is_paying_customer: false },
      },
      {
        remoteId: "7605",
        name: "Subscriber who bought",
        payload: { role: "subscriber", orders_count: 2, is_paying_customer: true },
      },
    ];
    for (const input of identities) {
      await identity.reconcileExternalIdentity(
        {
          businessId: biz.id,
          connectionId: biz.pluginConnId,
          provider: "woocommerce",
          ...input,
        },
        { allowCreate: false },
      );
    }

    const guests = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { accountType: "guest" });
    expect(guests.customers.map((row) => row.remoteId)).toContain("guest:guest-customer@example.test");
    expect(guests.customers.every((row) => row.accountType === "guest")).toBe(true);

    const subscribers = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { accountType: "subscriber" });
    expect(subscribers.customers.map((row) => row.remoteId)).toContain("7604");
    expect(subscribers.customers.map((row) => row.remoteId)).not.toContain("7605");

    const registered = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { accountType: "registered" });
    expect(registered.customers.map((row) => row.remoteId)).toContain("7605");

    const deleted = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { remoteFilter: "deleted" });
    expect(deleted.customers.some((row) => row.remoteId === "9901")).toBe(true);
    expect((await manager.wpStoreCustomers(biz.id, biz.pluginConnId)).customers.some((row) => row.remoteId === "9901")).toBe(false);

    const restricted = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, {
      includeIdentityDetails: false,
      includePartyDetails: false,
      includeOrderCounts: false,
    });
    expect(restricted.customers.some((row) => row.identityStatus !== "unavailable" || row.externalProfileId !== null)).toBe(false);
  });

  it("keeps search wildcards literal and matches localized phone digits", async () => {
    await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: biz.pluginConnId,
        provider: "woocommerce",
        remoteId: "search-special-7602",
        name: "Discount 100%_ customer",
        email: null,
        phone: "09120000001",
      },
      { allowCreate: false },
    );
    await identity.reconcileExternalIdentity(
      {
        businessId: biz.id,
        connectionId: biz.pluginConnId,
        provider: "woocommerce",
        remoteId: "search-lookalike-7603",
        name: "Discount 100XY customer",
        email: null,
        phone: "09120000002",
      },
      { allowCreate: false },
    );

    const literal = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { search: "100%_" });
    expect(literal.customers.map((row) => row.remoteId)).toEqual(["search-special-7602"]);
    const localizedDigits = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { search: "۰۹۱۲۰۰۰۰۰۰۱" });
    expect(localizedDigits.customers.map((row) => row.remoteId)).toEqual(["search-special-7602"]);
  });

  it("does not expose a cross-tenant party through a corrupt legacy customer mapping", async () => {
    const otherBusiness = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry) VALUES ('Other tenant', $1, 'accessories') RETURNING id`,
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherParty = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone, email)
       VALUES ($1, 'Private other-tenant customer', '09129999999', 'private@example.test') RETURNING id`,
      [otherBusiness.rows[0].id],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'customer', 'cross-tenant-identity', $3)`,
      [biz.id, biz.pluginConnId, otherParty.rows[0].id],
    );

    const page = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, {
      includePartyDetails: true,
      includeOrderCounts: true,
    });
    const leaked = page.customers.find((row) => row.remoteId === "cross-tenant-identity");
    expect(leaked).toMatchObject({
      localId: null,
      identityStatus: "unmapped",
      name: "",
      phone: null,
      email: null,
      ordersCount: null,
    });
  });
});

describe("the customer list is a status-aware store read model (issue #937)", () => {
  it("shows the whole store population — profiles included — one row per remote identity", async () => {
    // A shopper waiting on an identity decision: profile only, no mapping.
    // The old mapping-only read made her vanish from the screen entirely.
    await db.query(
      `INSERT INTO crm_external_profiles (business_id, connection_id, remote_id, remote_name, remote_phone, status)
       VALUES ($1, $2, '7101', 'مینا', '09351111111', 'needs_review')`,
      [biz.id, biz.pluginConnId],
    );
    // An identity a human already rejected, with a legacy mapping still
    // pointing at a party: one row, and the profile's word governs.
    const ignoredParty = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name) VALUES ($1, 'ردشده') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO crm_external_profiles (business_id, connection_id, remote_id, remote_name, party_id, status)
       VALUES ($1, $2, '7102', 'ردشده', $3, 'ignored')`,
      [biz.id, biz.pluginConnId, ignoredParty.rows[0].id],
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'customer', '7102', $3)`,
      [biz.id, biz.pluginConnId, ignoredParty.rows[0].id],
    );
    // Resolved inside CRM before any sync wrote the legacy mapping: the
    // profile already knows the party.
    const confirmedParty = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name) VALUES ($1, 'تأییدشده') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO crm_external_profiles (business_id, connection_id, remote_id, remote_name, party_id, status)
       VALUES ($1, $2, '7103', 'تأییدشده', $3, 'confirmed')`,
      [biz.id, biz.pluginConnId, confirmedParty.rows[0].id],
    );
    // A mapping whose party is gone: honestly unmapped, not a blank "linked".
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'customer', '7104', $3)`,
      [biz.id, biz.pluginConnId, randomUUID()],
    );
    // The same remote id on the *other* connection must not leak in.
    await db.query(
      `INSERT INTO crm_external_profiles (business_id, connection_id, remote_id, remote_name, status)
       VALUES ($1, $2, '7101', 'غريبه', 'needs_review')`,
      [biz.id, biz.restConnId],
    );

    const { customers: rows } = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { pageSize: 100 });
    const byRemote = new Map(rows.map((r) => [r.remoteId, r]));

    const mina = byRemote.get("7101")!;
    expect(mina.status).toBe("needs_review");
    expect(mina.localId).toBeNull();
    expect(mina.name).toBe("مینا");
    expect(rows.filter((r) => r.remoteId === "7101")).toHaveLength(1);

    expect(byRemote.get("7102")!.status).toBe("ignored");
    expect(rows.filter((r) => r.remoteId === "7102")).toHaveLength(1);

    const confirmed = byRemote.get("7103")!;
    expect(confirmed.status).toBe("linked");
    expect(confirmed.localId).toBe(confirmedParty.rows[0].id);

    expect(byRemote.get("7104")!.status).toBe("unmapped");
    expect(byRemote.get("7104")!.localId).toBeNull();

    // The original mapping-only row still reads as linked.
    expect(byRemote.get("7001")!.status).toBe("linked");
  });

  it("filters by status and searches the remote snapshot of unreconciled rows", async () => {
    const review = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { status: "needs_review" });
    expect(review.total).toBe(review.customers.length);
    expect(review.customers.length).toBeGreaterThan(0);
    expect(review.customers.every((r) => r.status === "needs_review")).toBe(true);
    expect(review.customers.some((r) => r.remoteId === "7101")).toBe(true);

    // Mina has no local party; her store-side name/phone are the only handle.
    const byName = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { search: "مینا" });
    expect(byName.customers.map((r) => r.remoteId)).toContain("7101");
    const byPhone = await manager.wpStoreCustomers(biz.id, biz.pluginConnId, { search: "09351111111" });
    expect(byPhone.customers.map((r) => r.remoteId)).toContain("7101");
  });
});

describe("the taxonomy mirror learns terms from a product payload (plugin mode)", () => {
  it("upserts the categories and tags a pushed product carries, and records the assignment", async () => {
    // In plugin mode the app never reads /products/categories — the only
    // taxonomy facts that ever arrive are the arrays carried on each product.
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.pluginConnId, "5100", {
      categories: [
        { id: 21, name: "پوشاک", slug: "clothing" },
        { id: 22, name: "مردانه", slug: "mens" },
      ],
      tags: [{ id: 40, name: "حراج", slug: "sale" }],
    });

    const terms = await taxonomy.listTerms(biz.id, biz.pluginConnId);
    // Scope to the ids this payload introduced — the connection may already
    // carry other terms from earlier tests in this suite.
    const cats = terms.filter((t) => t.taxonomy === "product_cat" && ["21", "22"].includes(t.remoteId));
    const tags = terms.filter((t) => t.taxonomy === "product_tag" && t.remoteId === "40");
    expect(cats.map((t) => t.name).sort()).toEqual(["مردانه", "پوشاک"].sort());
    expect(tags.map((t) => t.name)).toEqual(["حراج"]);

    // The assignment is what lets a catalogue row show «دسته‌بندی: پوشاک».
    const byId = await taxonomy.termsByRemoteId(biz.id, biz.pluginConnId, ["5100"], "product_cat");
    expect(byId.get("5100")?.map((c) => c.name).sort()).toEqual(["مردانه", "پوشاک"].sort());
  });

  it("re-records the assignment as a replace, so a removed category disappears", async () => {
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.pluginConnId, "5100", {
      categories: [{ id: 21, name: "پوشاک", slug: "clothing" }],
      tags: [],
    });
    const byId = await taxonomy.termsByRemoteId(biz.id, biz.pluginConnId, ["5100"], "product_cat");
    expect(byId.get("5100")?.map((c) => c.remoteId)).toEqual(["21"]);
  });

  it("keeps an upserted term's name up to date but ignores an empty payload term", async () => {
    await taxonomy.upsertTermFromPayload(biz.id, biz.pluginConnId, "product_cat", { id: 21, name: "پوشاک بانوان" });
    await taxonomy.upsertTermFromPayload(biz.id, biz.pluginConnId, "product_cat", { id: 0, name: "junk" });
    const terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat");
    expect(terms.find((t) => t.remoteId === "21")?.name).toBe("پوشاک بانوان");
    expect(terms.some((t) => t.remoteId === "0")).toBe(false);
  });
});

describe("the content mirror pulls over the WordPress REST API (rest mode)", () => {
  it("walks every content type, upserts each row and prunes deleted remote media", async () => {
    const restConn = { id: biz.restConnId, business_id: biz.id } as never;
    await content.upsertWpContent(restConn, {
      id: 3999,
      type: "attachment",
      title: "Deleted remotely",
      source_url: "https://x/deleted.png",
      mime_type: "image/png",
    });
    // A fake wp/v2 client: one page each of posts, pages, media.
    const pagesByType: Record<string, Record<string, unknown>[]> = {
      posts: [
        {
          id: 3001,
          type: "post",
          title: { rendered: "Ben &amp; Jerry", raw: "Ben & Jerry" },
          content: { raw: "<!-- wp:paragraph --><p>body</p><!-- /wp:paragraph -->" },
          status: "draft",
        },
      ],
      pages: [{ id: 3002, type: "page", title: { rendered: "درباره&#8230;" }, status: "private" }],
      media: [
        { id: 3003, type: "attachment", title: { rendered: "Logo" }, source_url: "https://x/y.png", mime_type: "image/png" },
      ],
    };
    const calls: { type: string; query: Record<string, unknown> }[] = [];
    const client = {
      wpListPage: async (type: string, query: Record<string, unknown>) => {
        calls.push({ type, query });
        return { items: pagesByType[type] ?? [], totalPages: 1 };
      },
    };

    const outcome = await content.syncWpContentRest(restConn, client);
    expect(outcome).toEqual({ total: 3, removed: 1 });
    expect(calls.filter((call) => call.type !== "media").every((call) => call.query.context === "edit")).toBe(true);
    expect(String(calls.find((call) => call.type === "posts")?.query.status)).toContain("draft");
    expect(calls.find((call) => call.type === "media")?.query.context).toBe("edit");
    expect(calls.find((call) => call.type === "media")?.query.status).toBe("inherit,private,trash");

    const rows = await content.listWpContent(biz.id, biz.restConnId);
    expect(rows.find((r) => r.remoteId === "3001")?.title).toBe("Ben & Jerry");
    expect(rows.find((r) => r.remoteId === "3002")?.title).toBe("درباره…");
    expect(rows.find((r) => r.remoteId === "3003")?.mimeType).toBe("image/png");
    expect(rows.some((r) => r.remoteId === "3999")).toBe(false);
    expect((await content.getWpContent(biz.id, biz.restConnId, "post", "3001"))?.content).toContain("wp:paragraph");
  });

  it("keeps paging when a WordPress host omits X-WP-TotalPages", async () => {
    const restConn = { id: biz.restConnId, business_id: biz.id } as never;
    const calls: string[] = [];
    const client = {
      wpListPage: async (type: string, query: { page: number }) => {
        calls.push(`${type}:${query.page}`);
        if (type !== "posts") return { items: [], totalPages: 0 };
        if (query.page === 1) {
          return {
            items: Array.from({ length: 100 }, (_, index) => ({
              id: 4000 + index,
              title: { rendered: `Post ${index}` },
              status: "publish",
            })),
            totalPages: 0,
          };
        }
        if (query.page === 2) {
          return { items: [{ id: 4100, title: { rendered: "Last post" }, status: "publish" }], totalPages: 0 };
        }
        return { items: [], totalPages: 0 };
      },
    };

    const outcome = await content.syncWpContentRest(restConn, client);
    expect(outcome.total).toBe(101);
    expect(calls).toContain("posts:2");
    const rows = await content.listWpContent(biz.id, biz.restConnId, { wpType: "post", limit: 200 });
    expect(rows).toHaveLength(101);
    expect(rows.some((row) => row.remoteId === "4100")).toBe(true);
  });
});

describe("the enhanced WP queue summary, filtering, and retries", () => {
  it("computes accurate summary metrics across outbox and inbox", async () => {
    const summary = await manager.wpQueueSummary(biz.id, biz.pluginConnId);
    expect(summary.total).toBeGreaterThanOrEqual(4);
    expect(summary.pending).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.dead).toBeGreaterThanOrEqual(1);
  });

  it("filters queue by status and direction", async () => {
    const failedRows = await manager.wpQueue(biz.id, biz.pluginConnId, { status: "failed" });
    expect(failedRows.every((r) => r.status === "failed" || r.status === "dead")).toBe(true);

    const outRows = await manager.wpQueue(biz.id, biz.pluginConnId, { direction: "out" });
    expect(outRows.every((r) => r.direction === "out")).toBe(true);

    const inRows = await manager.wpQueue(biz.id, biz.pluginConnId, { direction: "in" });
    expect(inRows.every((r) => r.direction === "in")).toBe(true);
  });

  it("filters queue by search query", async () => {
    const searched = await manager.wpQueue(biz.id, biz.pluginConnId, { search: "5001" });
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((r) => r.remoteId.includes("5001") || r.kind.includes("5001"))).toBe(true);
  });

  it("retries a dead outbox row, resetting status to pending and attempts to 0", async () => {
    const deadRows = await manager.wpQueue(biz.id, biz.pluginConnId, { status: "dead" });
    expect(deadRows.length).toBeGreaterThan(0);
    const target = deadRows[0];

    const result = await manager.retryWpQueueRow(biz.id, biz.pluginConnId, target.id, "out");
    expect(result.ok).toBe(true);

    const refreshed = await manager.wpQueue(biz.id, biz.pluginConnId, { status: "all" });
    const updated = refreshed.find((r) => r.id === target.id);
    expect(updated?.status).toBe("pending");
    expect(updated?.attempts).toBe(0);
  });

  it("retries all failed and dead events in batch", async () => {
    // Insert a failed event to test batch retry
    await db.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, status, attempts, last_error)
       VALUES ($1, $2, 'price', '9999', '{}'::jsonb, 'failed', 3, 'temporary error')
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET status = 'failed', attempts = 3, last_error = 'temporary error'`,
      [biz.id, biz.pluginConnId],
    );

    const result = await manager.retryAllFailedWpQueue(biz.id, biz.pluginConnId);
    expect(result.ok).toBe(true);
    expect(result.outboxRetried).toBeGreaterThanOrEqual(1);

    const all = await manager.wpQueue(biz.id, biz.pluginConnId, { status: "all" });
    const row = all.find((r) => r.remoteId === "9999");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
  });

  it("flushes outbox queue reporting mode and status", async () => {
    const pluginFlush = await manager.flushWpOutbox(biz.id, biz.pluginConnId);
    expect(pluginFlush.ok).toBe(true);
    expect(pluginFlush.mode).toBe("plugin");

    const restFlush = await manager.flushWpOutbox(biz.id, biz.restConnId);
    expect(restFlush.ok).toBe(true);
    expect(restFlush.mode).toBe("rest_api");
  });
});

describe("WordPress as a view over the central Media Library — correlating a push back to its mapping", () => {
  async function makeAsset(fileName: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', $2, 'image/png', 100, $3, $4) RETURNING id`,
      [biz.id, fileName, `media/${biz.id}/${randomUUID()}.png`, randomUUID().replaceAll("-", "")],
    );
    return rows[0].id;
  }

  it("a content.updated event carrying the plugin's echoed operation id confirms the pending mapping", async () => {
    const assetId = await makeAsset("pushed-banner.png");
    const operationId = `wp-media:${biz.pluginConnId}:${randomUUID()}`;
    await dbLib!.withTenant(biz.id, () =>
      media.recordWordPressMediaPush({ businessId: biz.id, mediaAssetId: assetId, connectionId: biz.pluginConnId, operationId }),
    );

    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    const outcome = await ingest.ingestPluginEvent(connection!, {
      topic: "content.updated",
      deliveryId: randomUUID(),
      payload: {
        id: 7331,
        type: "attachment",
        title: { rendered: "pushed-banner", raw: "pushed-banner" },
        source_url: "https://shop.example.com/wp-content/uploads/pushed-banner.png",
        mime_type: "image/png",
        media_type: "image",
        operation_id: operationId,
      },
    });
    expect(outcome.status).toBe("processed");

    const mapping = await dbLib!.withTenant(biz.id, () => media.getWordPressMediaMapping(biz.id, biz.pluginConnId, assetId));
    expect(mapping?.status).toBe("synced");
    expect(mapping?.wpMediaId).toBe("7331");
    expect(mapping?.wpUrl).toBe("https://shop.example.com/wp-content/uploads/pushed-banner.png");
  });

  it("an ordinary attachment sync with no operation id never touches any mapping", async () => {
    const assetId = await makeAsset("untouched.png");
    const operationId = `wp-media:${biz.pluginConnId}:${randomUUID()}`;
    await dbLib!.withTenant(biz.id, () =>
      media.recordWordPressMediaPush({ businessId: biz.id, mediaAssetId: assetId, connectionId: biz.pluginConnId, operationId }),
    );

    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    // A site owner's own upload — same event topic and shape, no operation id.
    await ingest.ingestPluginEvent(connection!, {
      topic: "content.updated",
      deliveryId: randomUUID(),
      payload: { id: 7332, type: "attachment", title: "owner-upload", source_url: "https://shop.example.com/owner-upload.png", mime_type: "image/png" },
    });

    const mapping = await dbLib!.withTenant(biz.id, () => media.getWordPressMediaMapping(biz.id, biz.pluginConnId, assetId));
    expect(mapping?.status).toBe("pending"); // unaffected — this event was never this asset's push
  });

  it("a media_create job that exhausts its retries dead-letters and fails the mapping instead of leaving it pending forever", async () => {
    const assetId = await makeAsset("will-never-land.png");
    const operationId = `wp-media:${biz.pluginConnId}:${randomUUID()}`;
    await dbLib!.withTenant(biz.id, () =>
      media.recordWordPressMediaPush({ businessId: biz.id, mediaAssetId: assetId, connectionId: biz.pluginConnId, operationId }),
    );

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id, attempts)
       VALUES ($1, $2, 'media_create', $3, $4::jsonb, $5, 5)
       RETURNING id`,
      [biz.id, biz.pluginConnId, `asset-${assetId}-${randomUUID()}`, JSON.stringify({ url: "https://bucket.example.com/x.png", __operationId: operationId }), operationId],
    );
    const jobId = rows[0].id;

    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    const response = await plugin.pluginAckJobs(connection! as never, [{ id: jobId, status: "failed", error: "سایت پاسخ نداد" }]);
    const body = (await response.json()) as { ok: boolean; failed: number };
    expect(body.ok).toBe(true);
    expect(body.failed).toBe(1);

    const outboxRow = await db.query<{ status: string }>(`SELECT status FROM integration_outbox_events WHERE id = $1`, [jobId]);
    expect(outboxRow.rows[0].status).toBe("dead");

    const mapping = await dbLib!.withTenant(biz.id, () => media.getWordPressMediaMapping(biz.id, biz.pluginConnId, assetId));
    expect(mapping?.status).toBe("failed");
    expect(mapping?.lastError).toContain("سایت");
  });

  it("a media_create job's ordinary (non-final) failure leaves the mapping pending — only the dead letter gives up", async () => {
    const assetId = await makeAsset("retry-me.png");
    const operationId = `wp-media:${biz.pluginConnId}:${randomUUID()}`;
    await dbLib!.withTenant(biz.id, () =>
      media.recordWordPressMediaPush({ businessId: biz.id, mediaAssetId: assetId, connectionId: biz.pluginConnId, operationId }),
    );

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id, attempts)
       VALUES ($1, $2, 'media_create', $3, $4::jsonb, $5, 0)
       RETURNING id`,
      [biz.id, biz.pluginConnId, `asset-${assetId}-${randomUUID()}`, JSON.stringify({ url: "https://bucket.example.com/y.png", __operationId: operationId }), operationId],
    );
    const jobId = rows[0].id;

    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    await plugin.pluginAckJobs(connection! as never, [{ id: jobId, status: "failed", error: "timeout" }]);

    const outboxRow = await db.query<{ status: string }>(`SELECT status FROM integration_outbox_events WHERE id = $1`, [jobId]);
    expect(outboxRow.rows[0].status).toBe("failed"); // not dead yet — will be retried

    const mapping = await dbLib!.withTenant(biz.id, () => media.getWordPressMediaMapping(biz.id, biz.pluginConnId, assetId));
    expect(mapping?.status).toBe("pending");
  });
});

/**
 * Issue #942 — queue leasing, ack fencing, retry eligibility and truthful
 * operator actions. Each scenario runs on its own freshly-made connection
 * so the counts asserted here are exact, not "at least".
 */
describe("queue leasing, fencing and operator actions (issue #942)", () => {
  let leaseConnId = "";

  beforeAll(async () => {
    leaseConnId = await makeConnection("plugin", "Lease Store");
    // A protocol-3 plugin: the only kind issued (and fenced by) lease tokens.
    await db.query(
      `UPDATE integration_connections
          SET plugin_capabilities = '{"protocolVersion":3,"jobTypes":["stock","price","product_update","order_status","refund_create","media_create","post_upsert"]}'::jsonb
        WHERE id = $1`,
      [leaseConnId],
    );
  });

  async function leaseConnection() {
    const connection = await connections.getConnection(biz.id, leaseConnId);
    if (!connection) throw new Error("lease connection missing");
    return connection;
  }

  async function insertOutbox(
    connectionId: string,
    entityType: string,
    remoteId: string,
    payload: Record<string, unknown>,
    extra: { status?: string; attempts?: number; operationId?: string } = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, status, attempts, operation_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [biz.id, connectionId, entityType, remoteId, JSON.stringify(payload), extra.status ?? "pending", extra.attempts ?? 0, extra.operationId ?? null],
    );
    return rows[0].id;
  }

  async function outboxStatus(id: string): Promise<string> {
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM integration_outbox_events WHERE id = $1`, [id]);
    return rows[0].status;
  }

  it("fences plugin acks on the lease generation: a stale ack cannot close a newer attempt (F01)", async () => {
    const jobId = await insertOutbox(leaseConnId, "stock", "7701", { stock_quantity: 5, manage_stock: true });
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       VALUES ($1, $2, 'product', '7701', $3, '{"stock":1,"remoteParentId":"77"}'::jsonb)`,
      [biz.id, leaseConnId, randomUUID()],
    );

    const connection = await leaseConnection();
    const first = (await (await plugin.pluginPullJobs(connection)).json()) as {
      jobs: { id: string; leaseToken: string | null }[];
    };
    expect(first.jobs.find((j) => j.id === jobId)?.leaseToken).toBeTruthy();
    const firstToken = first.jobs.find((j) => j.id === jobId)!.leaseToken!;
    expect(await outboxStatus(jobId)).toBe("processing");

    // While the lease is live, a second pull must not hand the job out again.
    const second = (await (await plugin.pluginPullJobs(connection)).json()) as { jobs: { id: string }[] };
    expect(second.jobs.some((j) => j.id === jobId)).toBe(false);

    // The holder dies; the lease expires; the job is re-leased under a NEW token.
    await db.query(`UPDATE integration_outbox_events SET leased_until = now() - interval '1 minute' WHERE id = $1`, [jobId]);
    const third = (await (await plugin.pluginPullJobs(connection)).json()) as {
      jobs: { id: string; leaseToken: string | null }[];
    };
    const secondToken = third.jobs.find((j) => j.id === jobId)!.leaseToken!;
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    // The zombie holder wakes up and acks `done` with the OLD token: ignored.
    const staleAck = (await (
      await plugin.pluginAckJobs(connection, [{ id: jobId, status: "done", leaseToken: firstToken }])
    ).json()) as { done: number; stale: number };
    expect(staleAck.done).toBe(0);
    expect(staleAck.stale).toBe(1);
    expect(await outboxStatus(jobId)).toBe("processing");

    // The current holder's ack lands — and the mapping learns the delivered
    // stock while keeping the variation's parent id (F03).
    const ack = (await (
      await plugin.pluginAckJobs(connection, [{ id: jobId, status: "done", leaseToken: secondToken }])
    ).json()) as { done: number; stale: number };
    expect(ack.done).toBe(1);
    expect(await outboxStatus(jobId)).toBe("sent");

    const { rows: mappingRows } = await db.query<{ last_pushed_payload: Record<string, unknown> }>(
      `SELECT last_pushed_payload FROM integration_mappings
        WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = '7701'`,
      [leaseConnId],
    );
    expect(mappingRows[0].last_pushed_payload.stock).toBe(5);
    expect(mappingRows[0].last_pushed_payload.remoteParentId).toBe("77");
  });

  it("records the acknowledged price payload as last-pushed, in Rial (F03)", async () => {
    const jobId = await insertOutbox(leaseConnId, "price", "7702", { regular_price: "100" });
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       VALUES ($1, $2, 'product', '7702', $3, '{"priceRial":"0"}'::jsonb)`,
      [biz.id, leaseConnId, randomUUID()],
    );

    const connection = await leaseConnection();
    const pull = (await (await plugin.pluginPullJobs(connection)).json()) as {
      jobs: { id: string; leaseToken: string | null }[];
    };
    const token = pull.jobs.find((j) => j.id === jobId)!.leaseToken!;
    await plugin.pluginAckJobs(connection, [{ id: jobId, status: "done", leaseToken: token }]);

    const { rows } = await db.query<{ last_pushed_payload: Record<string, unknown> }>(
      `SELECT last_pushed_payload FROM integration_mappings
        WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = '7702'`,
      [leaseConnId],
    );
    // 100 Toman were delivered == 1000 Rial recorded — from the payload,
    // not from whatever the local price happens to be now.
    expect(rows[0].last_pushed_payload.priceRial).toBe("1000");
  });

  it("acks a policy-off job as skipped without touching the last-pushed mapping (F10/F03)", async () => {
    const jobId = await insertOutbox(leaseConnId, "stock", "7703", { stock_quantity: 9, manage_stock: true });
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       VALUES ($1, $2, 'product', '7703', $3, '{"stock":2}'::jsonb)`,
      [biz.id, leaseConnId, randomUUID()],
    );

    const connection = await leaseConnection();
    const pull = (await (await plugin.pluginPullJobs(connection)).json()) as {
      jobs: { id: string; leaseToken: string | null }[];
    };
    const token = pull.jobs.find((j) => j.id === jobId)!.leaseToken!;
    const ack = (await (
      await plugin.pluginAckJobs(connection, [
        { id: jobId, status: "skipped", error: "apply_stock_disabled", leaseToken: token },
      ])
    ).json()) as { skipped: number; done: number };
    expect(ack.skipped).toBe(1);
    expect(ack.done).toBe(0);
    expect(await outboxStatus(jobId)).toBe("skipped");

    // The store still holds 2 — the mapping must still say so, or the next
    // diff would believe 9 was delivered.
    const { rows } = await db.query<{ last_pushed_payload: Record<string, unknown> }>(
      `SELECT last_pushed_payload FROM integration_mappings
        WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = '7703'`,
      [leaseConnId],
    );
    expect(rows[0].last_pushed_payload.stock).toBe(2);

    // And a skipped job is never leased again.
    const again = (await (await plugin.pluginPullJobs(connection)).json()) as { jobs: { id: string }[] };
    expect(again.jobs.some((j) => j.id === jobId)).toBe(false);
  });

  it("claims REST outbox batches atomically and reclaims crashed processing rows (F02/F04)", async () => {
    const claimConnId = await makeConnection("rest_api", "Claim Store");
    const pendingIds = [
      await insertOutbox(claimConnId, "stock", "7801", { stock_quantity: 1 }),
      await insertOutbox(claimConnId, "stock", "7802", { stock_quantity: 2 }),
      await insertOutbox(claimConnId, "stock", "7803", { stock_quantity: 3 }),
    ];
    // A crashed worker's row: processing, lease long expired.
    const crashedId = await insertOutbox(claimConnId, "stock", "7804", { stock_quantity: 4 }, { status: "processing" });
    await db.query(`UPDATE integration_outbox_events SET leased_until = now() - interval '10 minutes' WHERE id = $1`, [crashedId]);
    // A pre-fencing stuck row: processing with no lease at all, long untouched.
    const stuckId = await insertOutbox(claimConnId, "stock", "7805", { stock_quantity: 5 }, { status: "processing" });
    await db.query(`UPDATE integration_outbox_events SET updated_at = now() - interval '1 hour' WHERE id = $1`, [stuckId]);
    // Terminal rows are never claimable.
    const sentId = await insertOutbox(claimConnId, "stock", "7806", { stock_quantity: 6 }, { status: "sent" });

    const [batchA, batchB] = await dbLib!.withTenant(biz.id, () =>
      Promise.all([outbox.claimOutboxBatch(claimConnId, 2), outbox.claimOutboxBatch(claimConnId, 2)]),
    );
    const claimedIds = [...batchA, ...batchB].map((row) => row.id);
    // Two concurrent drainers, zero overlap.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds).not.toContain(sentId);
    // Every claim carries its own lease generation.
    expect(new Set([...batchA, ...batchB].map((row) => row.lease_token)).size).toBe(claimedIds.length);

    const rest = await dbLib!.withTenant(biz.id, () => outbox.claimOutboxBatch(claimConnId, 10));
    const allClaimed = new Set([...claimedIds, ...rest.map((row) => row.id)]);
    for (const id of [...pendingIds, crashedId, stuckId]) {
      expect(allClaimed.has(id)).toBe(true);
    }
    expect(allClaimed.has(sentId)).toBe(false);
    expect(await outboxStatus(sentId)).toBe("sent");
  });

  it("refuses blind retries of sent/processing/needs_review rows and resolves reviews explicitly (F05/F15)", async () => {
    const sentId = await insertOutbox(leaseConnId, "stock", "7901", { stock_quantity: 1 }, { status: "sent" });
    const processingId = await insertOutbox(leaseConnId, "stock", "7902", { stock_quantity: 1 }, { status: "processing" });
    const reviewId = await insertOutbox(
      leaseConnId,
      "refund_create",
      "7903",
      { amount: "100", __operationId: "op-7903" },
      { status: "needs_review", operationId: "op-7903" },
    );
    const deadId = await insertOutbox(leaseConnId, "stock", "7904", { stock_quantity: 1 }, { status: "dead", attempts: 6 });

    for (const [id, status] of [
      [sentId, "sent"],
      [processingId, "processing"],
      [reviewId, "needs_review"],
    ] as const) {
      const refused = await manager.retryWpQueueRow(biz.id, leaseConnId, id, "out");
      expect(refused).toEqual({ ok: false, error: "not_retryable", status });
      expect(await outboxStatus(id)).toBe(status);
    }

    const retried = await manager.retryWpQueueRow(biz.id, leaseConnId, deadId, "out");
    expect(retried.ok).toBe(true);
    expect(await outboxStatus(deadId)).toBe("pending");

    // Resolving a row that is not in review is refused with its real status.
    const notReview = await manager.resolveWpQueueReview(biz.id, leaseConnId, sentId, "retry");
    expect(notReview).toEqual({ ok: false, error: "not_in_review", status: "sent" });
    const missing = await manager.resolveWpQueueReview(biz.id, leaseConnId, randomUUID(), "retry");
    expect(missing).toEqual({ ok: false, error: "not_found" });

    // The explicit decisions work, one row each.
    const resolved = await manager.resolveWpQueueReview(biz.id, leaseConnId, reviewId, "mark_sent", biz.userId);
    expect(resolved).toEqual({ ok: true, status: "sent" });
    expect(await outboxStatus(reviewId)).toBe("sent");
    const { rows: audit } = await db.query<{ payload: { resolution?: string; actorId?: string } }>(
      `SELECT payload FROM integration_audit_log
        WHERE connection_id = $1 AND action = 'queue.review_resolved' AND remote_id = '7903'`,
      [leaseConnId],
    );
    expect(audit[0]?.payload.resolution).toBe("mark_sent");
    expect(audit[0]?.payload.actorId).toBe(biz.userId);
  });

  it("enforces the paused guard in the shared action service (F06) and never replays a processed inbox row (F05)", async () => {
    const deadId = await insertOutbox(leaseConnId, "stock", "7905", { stock_quantity: 1 }, { status: "dead", attempts: 6 });
    const { rows: inboxRows } = await db.query<{ id: string }>(
      `INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status, processed_at)
       VALUES ($1, $2, 'order.created', '7906', $3, '{"id":7906,"status":"completed"}'::jsonb, 'processed', now())
       RETURNING id`,
      [biz.id, leaseConnId, randomUUID()],
    );
    const inboxId = inboxRows[0].id;

    const connection = await leaseConnection();
    const outcome = await ingest.reprocessExistingIngestEvent(connection, inboxId);
    expect(outcome.status).toBe("duplicate");
    const refused = await manager.retryWpQueueRow(biz.id, leaseConnId, inboxId, "in");
    expect(refused).toEqual({ ok: false, error: "not_retryable", status: "processed" });

    await db.query(`UPDATE integration_connections SET status = 'paused' WHERE id = $1`, [leaseConnId]);
    try {
      expect(await manager.retryWpQueueRow(biz.id, leaseConnId, deadId, "out")).toEqual({
        ok: false,
        error: "connection_paused",
        status: "paused",
      });
      const bulk = await manager.retryAllFailedWpQueue(biz.id, leaseConnId);
      expect(bulk.ok).toBe(false);
      expect(bulk.error).toBe("connection_paused");
      expect(await outboxStatus(deadId)).toBe("dead");
    } finally {
      await db.query(`UPDATE integration_connections SET status = 'active' WHERE id = $1`, [leaseConnId]);
    }
  });

  it("moves bulk retry in bounded batches and never sweeps needs_review (F07)", async () => {
    const bulkConnId = await makeConnection("plugin", "Bulk Store");
    await insertOutbox(bulkConnId, "stock", "8001", { stock_quantity: 1 }, { status: "failed", attempts: 2 });
    await insertOutbox(bulkConnId, "stock", "8002", { stock_quantity: 1 }, { status: "failed", attempts: 2 });
    await insertOutbox(bulkConnId, "stock", "8003", { stock_quantity: 1 }, { status: "dead", attempts: 6 });
    const reviewId = await insertOutbox(
      bulkConnId,
      "refund_create",
      "8004",
      { amount: "10", __operationId: "op-8004" },
      { status: "needs_review", operationId: "op-8004" },
    );

    const first = await manager.retryAllFailedWpQueue(biz.id, bulkConnId, { outboxLimit: 2, inboxLimit: 5 });
    expect(first.ok).toBe(true);
    expect(first.outboxRetried).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.remaining).toBe(1);
    expect(await outboxStatus(reviewId)).toBe("needs_review");

    const second = await manager.retryAllFailedWpQueue(biz.id, bulkConnId);
    expect(second.outboxRetried).toBe(1);
    expect(second.remaining).toBe(0);
    expect(second.hasMore).toBe(false);
    expect(await outboxStatus(reviewId)).toBe("needs_review");
  });

  it("keeps one status classification across summary and filtered totals, and clamps pages (F14/F17)", async () => {
    const summaryConnId = await makeConnection("plugin", "Summary Store");
    await insertOutbox(summaryConnId, "stock", "8101", { stock_quantity: 1 }, { status: "pending" });
    await insertOutbox(summaryConnId, "price", "8102", { regular_price: "1" }, { status: "pending" });
    await insertOutbox(summaryConnId, "stock", "8103", { stock_quantity: 1 }, { status: "processing" });
    await insertOutbox(summaryConnId, "stock", "8104", { stock_quantity: 1 }, { status: "failed" });
    await insertOutbox(summaryConnId, "price", "8105", { regular_price: "1" }, { status: "dead" });
    await insertOutbox(summaryConnId, "refund_create", "8106", { amount: "1" }, { status: "needs_review", operationId: "op-8106" });
    await insertOutbox(summaryConnId, "stock", "8107", { stock_quantity: 1 }, { status: "skipped" });
    await insertOutbox(summaryConnId, "stock", "8108", { stock_quantity: 1 }, { status: "sent" });
    for (const [remote, status] of [
      ["8201", "pending"],
      ["8202", "deferred"],
      ["8203", "failed"],
      ["8204", "processed"],
    ] as const) {
      await db.query(
        `INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
         VALUES ($1, $2, 'order.created', $3, $4, '{}'::jsonb, $5)`,
        [biz.id, summaryConnId, remote, randomUUID(), status],
      );
    }

    const summary = await manager.wpQueueSummary(biz.id, summaryConnId);
    expect(summary).toMatchObject({
      total: 12,
      open: 9,
      pending: 4,
      processing: 1,
      failed: 3,
      dead: 1,
      needsReview: 1,
      skipped: 1,
      sent: 2,
      deferred: 1,
      inboundFailed: 1,
      outboundFailed: 3,
    });

    // Every KPI number is exactly the filtered total its click lists.
    for (const [status, expected] of [
      ["open", summary.open],
      ["pending", summary.pending],
      ["processing", summary.processing],
      ["failed", summary.failed],
      ["needs_review", summary.needsReview],
      ["sent", summary.sent],
      ["deferred", summary.deferred],
      ["all", summary.total],
    ] as const) {
      const page = await manager.wpQueuePage(biz.id, summaryConnId, { status });
      expect(page.total, status).toBe(expected);
    }

    // A stale deep page clamps to the last real page instead of showing
    // an empty "all synced" list.
    const clamped = await manager.wpQueuePage(biz.id, summaryConnId, { status: "all", page: 99, pageSize: 5 });
    expect(clamped.totalPages).toBe(3);
    expect(clamped.page).toBe(3);
    expect(clamped.rows.length).toBe(2);
  });

  it("keeps payloads out of the list and redacts them in the per-row detail (F13)", async () => {
    const rowId = await insertOutbox(leaseConnId, "product_update", "8301", {
      name: "Widget",
      consumer_secret: "cs_should_never_show",
      billing: { email: "Sara@example.com" },
    });

    const page = await manager.wpQueuePage(biz.id, leaseConnId, { status: "all", search: "8301" });
    const listed = page.rows.find((row) => row.id === rowId);
    expect(listed?.payload).toBeNull();
    expect(listed?.hasPayload).toBe(true);

    const detail = await manager.wpQueueRowDetail(biz.id, leaseConnId, rowId, "out");
    const payload = detail?.payload as { consumer_secret: string; name: string; billing: { email: string } };
    expect(payload.consumer_secret).not.toContain("cs_should_never_show");
    expect(payload.billing.email).not.toContain("Sara");
    expect(payload.name).toBe("Widget");

    // A row id from another scope reads as not found, never as a leak.
    expect(await manager.wpQueueRowDetail(biz.id, biz.pluginConnId, rowId, "out")).toBeNull();
  });

  it("mints a stable operation id when a review is retried without one, so the retry can actually land (PR #1053 review)", async () => {
    // A pre-idempotency refund: in review precisely because nothing about
    // it is verifiable. A bare status flip would bounce straight back.
    const reviewId = await insertOutbox(
      leaseConnId,
      "refund_create",
      "8401",
      { amount: "500" },
      { status: "needs_review" },
    );
    const resolved = await manager.resolveWpQueueReview(biz.id, leaseConnId, reviewId, "retry", biz.userId);
    expect(resolved).toEqual({ ok: true, status: "pending" });
    const { rows } = await db.query<{ status: string; operation_id: string | null; payload: Record<string, unknown> }>(
      `SELECT status, operation_id, payload FROM integration_outbox_events WHERE id = $1`,
      [reviewId],
    );
    expect(rows[0].status).toBe("pending");
    expect(rows[0].operation_id).toContain("woo-refund:");
    // Column and payload agree, and the merge kept the original payload.
    expect(rows[0].payload.__operationId).toBe(rows[0].operation_id);
    expect(rows[0].payload.__orderRemoteId).toBe("8401");
    expect(rows[0].payload.amount).toBe("500");

    // The pull sweep no longer bounces it back to needs_review: it leases.
    const connection = await leaseConnection();
    const pull = (await (await plugin.pluginPullJobs(connection)).json()) as { jobs: { id: string }[] };
    expect(pull.jobs.some((j) => j.id === reviewId)).toBe(true);
    expect(await outboxStatus(reviewId)).toBe("processing");

    // Same backfill for media_create (asserted at the row level; its pull
    // path carries media-library lease logic of its own).
    const mediaId = await insertOutbox(
      leaseConnId,
      "media_create",
      "8403",
      { title: "photo" },
      { status: "needs_review" },
    );
    await manager.resolveWpQueueReview(biz.id, leaseConnId, mediaId, "retry");
    const { rows: mediaRows } = await db.query<{ operation_id: string | null; payload: Record<string, unknown> }>(
      `SELECT operation_id, payload FROM integration_outbox_events WHERE id = $1`,
      [mediaId],
    );
    expect(mediaRows[0].operation_id).toContain("wp-media:");
    expect(mediaRows[0].payload.__operationId).toBe(mediaRows[0].operation_id);

    // A row that already carries an operation id keeps exactly that id.
    const knownId = await insertOutbox(
      leaseConnId,
      "refund_create",
      "8402",
      { amount: "700", __operationId: "op-8402", __orderRemoteId: "8402" },
      { status: "needs_review", operationId: "op-8402" },
    );
    await manager.resolveWpQueueReview(biz.id, leaseConnId, knownId, "retry");
    const { rows: knownRows } = await db.query<{ operation_id: string | null }>(
      `SELECT operation_id FROM integration_outbox_events WHERE id = $1`,
      [knownId],
    );
    expect(knownRows[0].operation_id).toBe("op-8402");
  });

  it("counts legacy unleased stale rows as due, so flush reporting never disagrees with the claim (PR #1053 review)", async () => {
    const countsConnId = await makeConnection("rest_api", "Counts Store");
    for (let i = 0; i < 25; i++) {
      await insertOutbox(countsConnId, "stock", `85${String(i).padStart(2, "0")}`, { stock_quantity: 1 });
    }
    // A pre-fencing leftover: processing with no lease at all, long untouched.
    const staleId = await insertOutbox(countsConnId, "stock", "8526", { stock_quantity: 9 }, { status: "processing" });
    await db.query(
      `UPDATE integration_outbox_events SET leased_until = NULL, updated_at = now() - interval '1 hour' WHERE id = $1`,
      [staleId],
    );
    await insertOutbox(countsConnId, "stock", "8527", { stock_quantity: 1 }, { status: "sent" });

    const counts = await dbLib!.withTenant(biz.id, () => outbox.outboxOpenCounts(countsConnId));
    expect(counts.open).toBe(26);
    // The stale row is claimable, so it must count as due — the arm the old
    // hand-copied count missed, reporting hasMore=false with work waiting.
    expect(counts.due).toBe(26);
  });

  it("verifies needs_review rows honestly: plugin mode and missing operation ids are 'unknown', not guesses (F11)", async () => {
    const reviewId = await insertOutbox(
      leaseConnId,
      "refund_create",
      "8601",
      { amount: "100", __operationId: "op-8601" },
      { status: "needs_review", operationId: "op-8601" },
    );
    const pluginVerdict = await manager.verifyWpQueueReview(biz.id, leaseConnId, reviewId, biz.userId);
    expect(pluginVerdict.ok).toBe(true);
    // The server never dials a plugin-mode store, so it must say so.
    expect(pluginVerdict.verdict).toBe("unknown");
    expect(pluginVerdict.detail).toContain("افزونه");
    // The probe is read-only: the row is still awaiting a decision.
    expect(await outboxStatus(reviewId)).toBe("needs_review");
    const { rows: audit } = await db.query<{ payload: { verdict?: string; actorId?: string } }>(
      `SELECT payload FROM integration_audit_log
        WHERE connection_id = $1 AND action = 'queue.review_verified' AND remote_id = '8601'`,
      [leaseConnId],
    );
    expect(audit[0]?.payload.verdict).toBe("unknown");
    expect(audit[0]?.payload.actorId).toBe(biz.userId);

    const sentId = await insertOutbox(leaseConnId, "stock", "8602", { stock_quantity: 1 }, { status: "sent" });
    expect(await manager.verifyWpQueueReview(biz.id, leaseConnId, sentId)).toEqual({
      ok: false,
      error: "not_in_review",
      status: "sent",
    });
    expect(await manager.verifyWpQueueReview(biz.id, leaseConnId, randomUUID())).toEqual({
      ok: false,
      error: "not_found",
    });

    // REST refund with no verification handle: still an honest "unknown"
    // (and, importantly, no HTTP call is attempted without an operation id).
    const restReviewId = await insertOutbox(
      biz.restConnId,
      "refund_create",
      "8603",
      { amount: "100" },
      { status: "needs_review" },
    );
    const restVerdict = await manager.verifyWpQueueReview(biz.id, biz.restConnId, restReviewId);
    expect(restVerdict.ok).toBe(true);
    expect(restVerdict.verdict).toBe("unknown");
  });

  it("verifies plugin-mode creates from the app's own records: landed on an exact operation id, otherwise unknown (issue #1075)", async () => {
    const postOp = `wp-post:${leaseConnId}:new-${randomUUID()}`;
    const postId = await insertOutbox(
      leaseConnId,
      "post_upsert",
      "new-1",
      { title: "Hello", __operationId: postOp },
      { status: "needs_review", operationId: postOp },
    );
    const pluginConnection = await connections.getConnection(biz.id, leaseConnId);

    // No echo from the plugin yet: not "not landed" — the report may be late.
    const before = await manager.verifyWpQueueReview(biz.id, leaseConnId, postId);
    expect(before.verdict).toBe("unknown");
    expect(before.detail).toContain("گزارشی از افزونه");

    // A post with the same title but another (or no) operation id proves nothing.
    await content.upsertWpContent(pluginConnection!, { id: 5101, type: "post", title: "Hello" });
    await content.upsertWpContent(pluginConnection!, { id: 5102, type: "post", title: "Hello", operation_id: "someone-else" });
    expect((await manager.verifyWpQueueReview(biz.id, leaseConnId, postId)).verdict).toBe("unknown");

    // The plugin's content event carries the stamped id: now it provably landed.
    await content.upsertWpContent(pluginConnection!, { id: 5103, type: "post", title: "Hello", operation_id: postOp });
    const after = await manager.verifyWpQueueReview(biz.id, leaseConnId, postId);
    expect(after.verdict).toBe("landed");
    expect(after.detail).toContain("۵۱۰۳");
    expect(await outboxStatus(postId)).toBe("needs_review");

    // An edit (known remote id) is not a create: never claimed from the mirror.
    const editOp = `wp-post:${leaseConnId}:edit`;
    await content.upsertWpContent(pluginConnection!, { id: 5104, type: "page", title: "Edit", operation_id: editOp });
    const editId = await insertOutbox(
      leaseConnId,
      "post_upsert",
      "5104",
      { id: 5104, title: "Edit", __operationId: editOp },
      { status: "needs_review", operationId: editOp },
    );
    expect((await manager.verifyWpQueueReview(biz.id, leaseConnId, editId)).verdict).toBe("unknown");

    // Media: the attachment echo in the mirror, scoped to this connection.
    const mediaOp = `wp-media:${leaseConnId}:${randomUUID()}`;
    const mediaId = await insertOutbox(
      leaseConnId,
      "media_create",
      `asset-${randomUUID()}`,
      { url: "https://bucket.example.com/z.png", __operationId: mediaOp },
      { status: "needs_review", operationId: mediaOp },
    );
    expect((await manager.verifyWpQueueReview(biz.id, leaseConnId, mediaId)).verdict).toBe("unknown");
    const otherConnection = await connections.getConnection(biz.id, biz.pluginConnId);
    await content.upsertWpContent(otherConnection!, { id: 5201, type: "attachment", title: "z", operation_id: mediaOp });
    expect((await manager.verifyWpQueueReview(biz.id, leaseConnId, mediaId)).verdict).toBe("unknown");
    await content.upsertWpContent(pluginConnection!, { id: 5202, type: "attachment", title: "z", operation_id: mediaOp });
    const mediaVerdict = await manager.verifyWpQueueReview(biz.id, leaseConnId, mediaId);
    expect(mediaVerdict.verdict).toBe("landed");
    expect(mediaVerdict.detail).toContain("۵۲۰۲");
  });
});

/**
 * Issue #939 — plugin taxonomy snapshot events, gated at the ingest boundary.
 *
 * The event is a destructive replace, so the payload is validated BEFORE it
 * may mutate anything: a malformed `terms` field is a failed event with an
 * actionable error (visible and retryable on the queue screen), never an
 * empty snapshot that quietly wipes the taxonomy (TAX-03). A `generated_at`
 * watermark rides along, and a snapshot older than the mirror is refused, so
 * a retried or reordered queue row cannot resurrect deleted terms (TAX-15).
 */
describe("plugin taxonomy snapshots are validated before they may destroy (issue #939)", () => {
  const topic = "catalogue.taxonomy_terms";

  async function deliver(payload: Record<string, unknown>) {
    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    expect(connection).toBeTruthy();
    return ingest.ingestPluginEvent(connection!, { topic, deliveryId: randomUUID(), payload });
  }

  it("refuses a malformed terms payload as a failed event and keeps the mirror", async () => {
    await taxonomy.replaceTerms(biz.id, biz.pluginConnId, "product_cat", [
      { id: 21, name: "پوشاک", slug: "clothing", parent: 0, description: "", count: 2 },
    ]);

    // THE TAX-03 bug: `terms: null` used to be coerced to `[]`, applied as a
    // valid empty snapshot, and delete the whole taxonomy.
    const nullTerms = await deliver({ taxonomy: "product_cat", terms: null });
    expect(nullTerms.status).toBe("failed");
    expect(nullTerms.error).toMatch(/terms_not_array/);
    let terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat");
    expect(terms.map((t) => t.remoteId)).toEqual(["21"]);

    const missingTerms = await deliver({ taxonomy: "product_cat" });
    expect(missingTerms.status).toBe("failed");
    expect(missingTerms.error).toMatch(/terms_not_array/);

    const missingTaxonomy = await deliver({ terms: [] });
    expect(missingTaxonomy.status).toBe("failed");
    expect(missingTaxonomy.error).toMatch(/taxonomy_missing/);

    // One unreadable term poisons the whole snapshot — it is refused, not
    // dropped, because a truncated payload must not pass as a complete one.
    const badTerm = await deliver({
      taxonomy: "product_cat",
      terms: [{ id: 21, name: "پوشاک", slug: "clothing" }, { name: "بدون شناسه" }],
    });
    expect(badTerm.status).toBe("failed");
    expect(badTerm.error).toMatch(/term_1_bad_id/);
    terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat");
    expect(terms.map((t) => t.remoteId)).toEqual(["21"]);
  });

  it("applies an explicitly empty snapshot — a taxonomy with zero terms is data, not an error", async () => {
    const result = await deliver({
      taxonomy: "product_cat",
      terms: [],
      generated_at: new Date().toISOString(),
    });
    expect(result.status).toBe("processed");
    expect(await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat")).toEqual([]);
    const states = await taxonomy.listTaxonomyStates(biz.id, biz.pluginConnId);
    expect(states.find((s) => s.taxonomy === "product_cat")).toMatchObject({ status: "synced", termCount: 0 });
  });

  it("refuses a late snapshot older than the mirror's watermark, and acks it so the queue stops retrying (TAX-15)", async () => {
    const newer = "2026-10-12T10:00:00Z";
    const older = "2026-10-12T09:00:00Z";

    const applied = await deliver({
      taxonomy: "brand",
      terms: [{ id: 31, name: "نایک", slug: "nike", parent: 0, description: "", count: 2 }],
      generated_at: newer,
    });
    expect(applied.status).toBe("processed");

    // The store deleted term 30 BEFORE the newer snapshot; a retried queue
    // row carrying the older tree arrives late. It must not restore it.
    const stale = await deliver({
      taxonomy: "brand",
      terms: [
        { id: 30, name: "قدیمی", slug: "gone", parent: 0, description: "", count: 1 },
        { id: 31, name: "نایک", slug: "nike", parent: 0, description: "", count: 2 },
      ],
      generated_at: older,
    });
    // Processed, not failed: nothing is wrong with the event, it is simply
    // history — failing it would make the plugin re-send it eight times.
    expect(stale.status).toBe("processed");
    const terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "brand");
    expect(terms.map((t) => t.remoteId)).toEqual(["31"]);
  });

  it("assembles a chunked snapshot and applies it only when complete (TAX-15)", async () => {
    const generatedAt = new Date().toISOString();
    const chunk = (index: number, count: number, terms: unknown[]) =>
      deliver({
        taxonomy: "size",
        terms,
        generated_at: generatedAt,
        snapshot_id: "snap-wp-1",
        chunk_index: index,
        chunk_count: count,
      });

    expect((await chunk(0, 2, [{ id: 41, name: "کوچک", slug: "small" }])).status).toBe("processed");
    // Half a snapshot must not exist in the mirror…
    expect(await taxonomy.listTerms(biz.id, biz.pluginConnId, "size")).toEqual([]);
    // …and a malformed chunk header is a failed event.
    const badChunk = await deliver({
      taxonomy: "size",
      terms: [],
      snapshot_id: "snap-wp-2",
      chunk_index: 5,
      chunk_count: 2,
    });
    expect(badChunk.status).toBe("failed");
    expect(badChunk.error).toMatch(/bad_chunk_index/);

    expect((await chunk(1, 2, [{ id: 42, name: "بزرگ", slug: "large" }])).status).toBe("processed");
    // The completed set applied as one atomic replace.
    const terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "size");
    expect(terms.map((t) => t.remoteId).sort()).toEqual(["41", "42"]);
  });

  it("renames and reparents terms in place — plugin snapshots follow the store like REST ones (gate 4)", async () => {
    // Watermarks ahead of the `generated_at: now()` an earlier test in this
    // file stamped onto product_cat, so these snapshots are judged by their
    // content, not by arrival order.
    const first = new Date(Date.now() + 60_000).toISOString();
    const second = new Date(Date.now() + 120_000).toISOString();

    expect(
      (
        await deliver({
          taxonomy: "product_cat",
          terms: [
            { id: 70, name: "نوشیدنی", slug: "drinks", parent: 0, description: "", count: 3 },
            { id: 71, name: "چای", slug: "tea", parent: 70, description: "", count: 1 },
          ],
          generated_at: first,
        })
      ).status,
    ).toBe("processed");
    let terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat");
    expect(terms.find((t) => t.remoteId === "71")?.parentRemoteId).toBe("70");

    // The store renames both terms and promotes the child to the root.
    expect(
      (
        await deliver({
          taxonomy: "product_cat",
          terms: [
            { id: 70, name: "نوشیدنی گرم", slug: "hot-drinks", parent: 0, description: "", count: 3 },
            { id: 71, name: "چای سیاه", slug: "black-tea", parent: 0, description: "", count: 1 },
          ],
          generated_at: second,
        })
      ).status,
    ).toBe("processed");

    terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat");
    expect(terms).toHaveLength(2);
    expect(terms.find((t) => t.remoteId === "70")).toMatchObject({ name: "نوشیدنی گرم", slug: "hot-drinks" });
    expect(terms.find((t) => t.remoteId === "71")).toMatchObject({
      name: "چای سیاه",
      slug: "black-tea",
      parentRemoteId: null,
    });
  });
});
