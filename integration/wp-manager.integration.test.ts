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
 *      the customer list joins a mapping to its local party, counting only
 *      the orders mirrored from that store — not the party's POS sales.
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
let content: typeof import("../src/lib/integrations/wp-content-service");
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let plugin: typeof import("../src/lib/integrations/plugin-service");
let taxonomy: typeof import("../src/lib/integrations/woo-taxonomy-service");
let connections: typeof import("../src/lib/integrations/connections-service");
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
  content = await import("../src/lib/integrations/wp-content-service");
  ingest = await import("../src/lib/integrations/webhook-ingest-service");
  plugin = await import("../src/lib/integrations/plugin-service");
  taxonomy = await import("../src/lib/integrations/woo-taxonomy-service");
  connections = await import("../src/lib/integrations/connections-service");
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
      date_modified: "2026-02-01T10:00:00Z",
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

    const completed = await ingest.ingestPluginEvent(connection!, {
      topic: "content.sync_completed",
      deliveryId: randomUUID(),
      payload: { id: "content:all", type: "content", count: 1 },
    });
    expect(completed.status).toBe("processed");
    expect((await connections.getConnection(biz.id, biz.pluginConnId))?.last_content_sync_at).toBeTruthy();

    await content.upsertWpContent(conn(), { id: 104, type: "page", title: "Delete me too" });
    await db.query(`UPDATE integration_connections SET last_content_sync_at = NULL WHERE id = $1`, [biz.pluginConnId]);
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
          payload: { id: "content:batch", type: "content", count: 1 },
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

    expect(stats.queue).toEqual(summary);
    expect(siblingStats.queue).toEqual(siblingSummary);
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
    expect(calls.find((call) => call.type === "media")?.query.context).toBe("view");

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
