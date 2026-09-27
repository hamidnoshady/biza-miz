/**
 * The media library (migration 0149) against a real migrated database and an
 * in-memory S3 server — the two halves the unit tests cannot cover together:
 *
 *   • the platform_media_config singleton (secret keep/clear semantics);
 *   • store → read → delete round-trips through real SigV4 requests, with the
 *     object landing under the owning business's own key prefix;
 *   • tenant isolation twice over: RLS on the rows, and the fail-closed
 *     `keyBelongsToBusiness` check refusing a row whose storage_key points at
 *     another tenant's object even when the row itself is reachable;
 *   • listing filters, facets and usage rollups;
 *   • the daily billing tick: idempotent per Tehran day, flat + per-GB from
 *     the console tariff, and the insufficient-funds rollback that keeps a
 *     broke business billable tomorrow instead of silently written off.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { MediaStorageConfig } from "../src/lib/media";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let s3Server: Server;
/** key → bytes; what our mock bucket holds right now. */
const bucketObjects = new Map<string, Buffer>();

let media: typeof import("../src/lib/media-service");
let mediaLib: typeof import("../src/lib/media");
let wallet: typeof import("../src/lib/wallet-service");
let dbLib: typeof import("../src/lib/db");
let mediaPersist: typeof import("../src/lib/ai-media-persist");

const BID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // کافه اول — the funded one
const BID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // کافه دوم — the broke one

let config: MediaStorageConfig;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Real PNG magic so nothing upstream of the service would refuse these bytes. */
function pngOf(size: number): Buffer {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

beforeAll(async () => {
  // A path-style S3 endpoint: PUT/GET/DELETE /{bucket}/{key...}. s3-lite signs
  // every request with SigV4; the mock only needs to store and serve bytes.
  s3Server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "").replace(/^\/media-test\//, "").split("?")[0]);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        bucketObjects.set(key, Buffer.concat(chunks));
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      const body = bucketObjects.get(key);
      if (!body) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.statusCode = 200;
      res.end(body);
      return;
    }
    if (req.method === "DELETE") {
      bucketObjects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  const s3Port = (s3Server.address() as AddressInfo).port;

  databaseName = `pos_media_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  media = await import("../src/lib/media-service");
  mediaLib = await import("../src/lib/media");
  wallet = await import("../src/lib/wallet-service");
  dbLib = await import("../src/lib/db");
  mediaPersist = await import("../src/lib/ai-media-persist");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES
       ($1, 'کافه اول', 'cafe-one', 'pro'),
       ($2, 'کافه دوم', 'cafe-two', 'pro')`,
    [BID, BID2],
  );

  config = {
    ...mediaLib.DEFAULT_MEDIA_CONFIG,
    enabled: true,
    endpoint: `http://127.0.0.1:${s3Port}`,
    region: "us-east-1",
    bucket: "media-test",
    keyPrefix: "media/",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  };
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  await new Promise<void>((resolve) => s3Server?.close(() => resolve()));
  process.env.DATABASE_URL = rootDatabaseUrl;
});

function scoped<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("platform_media_config singleton", () => {
  it("starts disabled with defaults and reports storage not ready", async () => {
    const stored = await dbLib.withoutTenantScope("test", () => media.getMediaConfig());
    expect(stored.enabled).toBe(false);
    expect(stored.keyPrefix).toBe("media/");
    expect(media.isMediaStorageReady(stored)).toBe(false);
  });

  it("saves the config and round-trips every tariff field", async () => {
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig(
        { ...config, billingEnabled: true, dailyFlatRial: 5000, dailyPerGbRial: 20000, freeQuotaMb: 1 },
        null,
      ),
    );
    const stored = await dbLib.withoutTenantScope("test", () => media.getMediaConfig());
    expect(stored.enabled).toBe(true);
    expect(stored.secretAccessKey).toBe("test-secret");
    expect(stored.dailyFlatRial).toBe(5000);
    expect(stored.dailyPerGbRial).toBe(20000);
    expect(stored.freeQuotaMb).toBe(1);
    expect(media.isMediaStorageReady(stored)).toBe(true);
    // The browser-facing shape never carries the secret.
    const masked = mediaLib.maskMediaConfig(stored);
    expect(JSON.stringify(masked)).not.toContain("test-secret");
    expect(masked.secretAccessKeySet).toBe(true);
  });
});

describe("store → read → delete through real SigV4 against the bucket", () => {
  let assetId: string;
  const bytes = pngOf(600);

  it("stores bytes under the owning business's own prefix", async () => {
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID,
        userId: null,
        config,
        kind: "image",
        fileName: "اسپرسو دوبل.png",
        mimeType: "image/png",
        bytes,
        sha256: sha256(bytes),
      }),
    );
    assetId = asset.id;
    expect(asset.kind).toBe("image");
    expect(asset.byteSize).toBe(600);

    // The object exists in the bucket, keyed {prefix}{businessId}/{assetId}/…
    const keys = [...bucketObjects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`media/${BID}/${assetId}/`)).toBe(true);
    expect(mediaLib.keyBelongsToBusiness(keys[0], "media/", BID)).toBe(true);
    expect(mediaLib.keyBelongsToBusiness(keys[0], "media/", BID2)).toBe(false);
  });

  it("reads the exact bytes back", async () => {
    const read = await scoped(BID, () => media.readMediaObject(BID, assetId, config));
    expect(read).not.toBeNull();
    expect(read!.bytes.equals(bytes)).toBe(true);
    expect(read!.asset.fileName).toContain("اسپرسو");
  });

  it("refuses to read a row whose storage_key points at another tenant's object", async () => {
    // Simulate the impossible-but-catastrophic row: reachable under RLS but
    // carrying a foreign key path. The fail-closed check must refuse it
    // BEFORE s3-lite goes near the network.
    const foreignKey = `media/${BID2}/${randomUUID()}/stolen.png`;
    await db.query(`UPDATE media_assets SET storage_key = $1 WHERE id = $2`, [foreignKey, assetId]);
    const read = await scoped(BID, () => media.readMediaObject(BID, assetId, config));
    expect(read).toBeNull();
    // Restore the honest key for the delete test below.
    const realKey = [...bucketObjects.keys()][0];
    await db.query(`UPDATE media_assets SET storage_key = $1 WHERE id = $2`, [realKey, assetId]);
  });

  it("the other business cannot see or read the asset at all (RLS)", async () => {
    const listed = await scoped(BID2, () => media.listMediaAssets(BID2));
    expect(listed.total).toBe(0);
    const read = await scoped(BID2, () => media.readMediaObject(BID2, assetId, config));
    expect(read).toBeNull();
  });

  it("deletes the row first and then the object", async () => {
    const ok = await scoped(BID, () => media.deleteMediaAsset(BID, assetId, config));
    expect(ok).toBe(true);
    expect(bucketObjects.size).toBe(0);
    expect(await scoped(BID, () => media.getMediaAsset(BID, assetId))).toBeNull();
    // Deleting the already-deleted asset reports false, not an error.
    expect(await scoped(BID, () => media.deleteMediaAsset(BID, assetId, config))).toBe(false);
  });
});

describe("listing, folders, facets and usage", () => {
  let folderId: string;

  beforeAll(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_folders (business_id, name) VALUES ($1, 'تصاویر منو') RETURNING id`,
      [BID],
    );
    folderId = rows[0].id;

    const store = (fileName: string, kind: "image" | "document", size: number, folder: string | null) =>
      scoped(BID, async () => {
        const bytes = kind === "image" ? pngOf(size) : Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(size - 8)]);
        return media.storeMediaAsset({
          businessId: BID,
          userId: null,
          config,
          kind,
          fileName,
          mimeType: kind === "image" ? "image/png" : "application/pdf",
          bytes,
          sha256: sha256(bytes),
          folderId: folder,
        });
      });

    const a = await store("espresso.png", "image", 1000, folderId);
    await db.query(`UPDATE media_assets SET category = 'نوشیدنی', tags = ARRAY['قهوه','اسپرسو'] WHERE id = $1`, [a.id]);
    const b = await store("cheesecake.png", "image", 2000, null);
    await db.query(`UPDATE media_assets SET category = 'دسر', tags = ARRAY['کیک'] WHERE id = $1`, [b.id]);
    await store("منو.pdf", "document", 3000, null);
  });

  it("filters by folder, kind, category, tag and search", async () => {
    await scoped(BID, async () => {
      expect((await media.listMediaAssets(BID)).total).toBe(3);
      expect((await media.listMediaAssets(BID, { folderId })).total).toBe(1);
      expect((await media.listMediaAssets(BID, { folderId: null })).total).toBe(2);
      expect((await media.listMediaAssets(BID, { kind: "document" })).assets[0].fileName).toBe("منو.pdf");
      expect((await media.listMediaAssets(BID, { category: "دسر" })).assets[0].fileName).toBe("cheesecake.png");
      expect((await media.listMediaAssets(BID, { tag: "قهوه" })).assets[0].fileName).toBe("espresso.png");
      // Search matches file name OR category OR tag, case-insensitively.
      expect((await media.listMediaAssets(BID, { search: "ESPRESSO" })).total).toBe(1);
      expect((await media.listMediaAssets(BID, { search: "کیک" })).total).toBe(1);
    });
  });

  it("rolls up facets and usage from the same rows", async () => {
    await scoped(BID, async () => {
      const facets = await media.listMediaFacets(BID);
      expect(facets.categories).toEqual(["دسر", "نوشیدنی"]);
      expect(facets.tags).toEqual(["اسپرسو", "قهوه", "کیک"]);

      const usage = await media.mediaUsageFor(BID);
      expect(usage.assetCount).toBe(3);
      expect(usage.totalBytes).toBe(6000);
      expect(usage.byKind.image).toEqual({ count: 2, bytes: 3000 });
      expect(usage.byKind.document).toEqual({ count: 1, bytes: 3000 });

      const folders = await media.listMediaFolders(BID);
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe("تصاویر منو");
      expect(folders[0].assetCount).toBe(1);
    });
  });

  it("keeps the second business's shelves empty (facets/usage are per tenant)", async () => {
    await scoped(BID2, async () => {
      expect((await media.listMediaFacets(BID2)).tags).toEqual([]);
      expect((await media.mediaUsageFor(BID2)).assetCount).toBe(0);
    });
  });
});

describe("daily billing tick", () => {
  it("charges flat + per-GB above the free quota, exactly once per local day", async () => {
    // کافه اول stores 6000 bytes (< 1 MB free quota → flat only), and is funded.
    await scoped(BID, () => wallet.grantCredits({ businessId: BID, amountRial: 100_000, note: "شارژ تست" }));

    const charged = await media.runMediaBillingTick();
    expect(charged).toBe(1);

    const { rows: charges } = await db.query(
      `SELECT day, stored_bytes, flat_rial, per_gb_rial, amount_rial FROM media_usage_charges WHERE business_id = $1`,
      [BID],
    );
    expect(charges).toHaveLength(1);
    expect(charges[0].day).toBe(media.localBillingDay());
    expect(Number(charges[0].stored_bytes)).toBe(6000);
    expect(Number(charges[0].flat_rial)).toBe(5000);
    expect(Number(charges[0].per_gb_rial)).toBe(0); // under the 1 MB free quota
    expect(Number(charges[0].amount_rial)).toBe(5000);

    const balance = await scoped(BID, () => wallet.getWalletBalanceRial(BID));
    expect(balance).toBe(95_000);

    // Same day, second tick: the UNIQUE claim makes it a no-op.
    expect(await media.runMediaBillingTick()).toBe(0);
    expect(await scoped(BID, () => wallet.getWalletBalanceRial(BID))).toBe(95_000);
  });

  it("rolls the claim back for an empty wallet so tomorrow's tick retries", async () => {
    // کافه دوم now stores something but holds no credit.
    const bytes = pngOf(500);
    await scoped(BID2, () =>
      media.storeMediaAsset({
        businessId: BID2,
        userId: null,
        config,
        kind: "image",
        fileName: "latte.png",
        mimeType: "image/png",
        bytes,
        sha256: sha256(bytes),
      }),
    );

    // A fresh day so the funded business's existing claim doesn't mask the run.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const charged = await media.runMediaBillingTick(tomorrow);
    expect(charged).toBe(1); // funded business only

    const { rows: brokeCharges } = await db.query(
      `SELECT id FROM media_usage_charges WHERE business_id = $1`,
      [BID2],
    );
    // No claim row left for the broke business — it stays billable tomorrow.
    expect(brokeCharges).toHaveLength(0);

    const { rows: fundedCharges } = await db.query(
      `SELECT day FROM media_usage_charges WHERE business_id = $1 ORDER BY day`,
      [BID],
    );
    expect(fundedCharges).toHaveLength(2);
    expect(fundedCharges[1].day).toBe(media.localBillingDay(tomorrow));

    // Fund the wallet and re-run the same "tomorrow": now it charges.
    await scoped(BID2, () => wallet.grantCredits({ businessId: BID2, amountRial: 50_000, note: "شارژ" }));
    expect(await media.runMediaBillingTick(tomorrow)).toBe(1);
    expect(await scoped(BID2, () => wallet.getWalletBalanceRial(BID2))).toBe(45_000);
  });

  it("charges nothing when billing is disabled in the console", async () => {
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig({ ...config, billingEnabled: false }, null),
    );
    const dayAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await media.runMediaBillingTick(dayAfter)).toBe(0);
    // Restore for any test that runs after this file.
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig(
        { ...config, billingEnabled: true, dailyFlatRial: 5000, dailyPerGbRial: 20000, freeQuotaMb: 1 },
        null,
      ),
    );
  });

  it("bills the per-GB share once storage exceeds the free quota", async () => {
    // Push کافه دوم past the 1 MB free quota: store a 2 MB image.
    const big = pngOf(2 * 1024 * 1024);
    await scoped(BID2, () =>
      media.storeMediaAsset({
        businessId: BID2,
        userId: null,
        config,
        kind: "image",
        fileName: "banner.png",
        mimeType: "image/png",
        bytes: big,
        sha256: sha256(big),
      }),
    );

    const day3 = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await media.runMediaBillingTick(day3);

    const { rows } = await db.query(
      `SELECT per_gb_rial, amount_rial FROM media_usage_charges WHERE business_id = $1 AND day = $2`,
      [BID2, media.localBillingDay(day3)],
    );
    expect(rows).toHaveLength(1);
    // (2 MB + 500 B − 1 MB free) ≈ 1 MB billable → ceil(1MB/1GB × 20000) = 20 Rial.
    // The exact number matters less than the invariant: rounded UP, never free.
    expect(Number(rows[0].per_gb_rial)).toBeGreaterThan(0);
    expect(Number(rows[0].amount_rial)).toBe(5000 + Number(rows[0].per_gb_rial));
  });
});

describe("Phase G — asset provenance (source, AI authorship, conversation/project)", () => {
  it("defaults an ordinary store to a human upload with no workspace", async () => {
    const bytes = pngOf(300);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "plain.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );
    expect(asset.source).toBe("upload");
    expect(asset.createdByAi).toBe(false);
    expect(asset.conversationId).toBeNull();
    expect(asset.projectId).toBeNull();
  });

  it("records an AI attachment as user-authored but AI-adjacent, linked to its conversation", async () => {
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'رسید') RETURNING id`,
      [BID],
    );
    const bytes = pngOf(400);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "receipt.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_attachment", conversationId: conv[0].id,
      }),
    );
    expect(asset.source).toBe("ai_attachment");
    // An attachment is the user's own file; only generation is AI-authored.
    expect(asset.createdByAi).toBe(false);
    expect(asset.conversationId).toBe(conv[0].id);
  });

  it("marks a generated image AI-authored and derives createdByAi from source", async () => {
    const bytes = pngOf(500);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "generated.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_generated",
      }),
    );
    expect(asset.source).toBe("ai_generated");
    expect(asset.createdByAi).toBe(true);
  });

  it("filters the library by conversation and by project", async () => {
    const { rows: proj } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'کمپین', 'seed') RETURNING id`,
      [BID],
    );
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title, project_id)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'نخ', $2) RETURNING id`,
      [BID, proj[0].id],
    );
    const bytes = pngOf(360);
    const inWorkspace = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "ws.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_generated", conversationId: conv[0].id, projectId: proj[0].id,
      }),
    );

    const byConv = await scoped(BID, () => media.listMediaAssets(BID, { conversationId: conv[0].id }));
    expect(byConv.assets.map((a) => a.id)).toContain(inWorkspace.id);
    expect(byConv.assets.every((a) => a.conversationId === conv[0].id)).toBe(true);

    const byProject = await scoped(BID, () => media.listMediaAssets(BID, { projectId: proj[0].id }));
    expect(byProject.assets.map((a) => a.id)).toContain(inWorkspace.id);
    expect(byProject.assets.every((a) => a.projectId === proj[0].id)).toBe(true);
  });

  it("nulls the links when the conversation or project is deleted, keeping the asset", async () => {
    const { rows: proj } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'موقت', 'seed') RETURNING id`,
      [BID],
    );
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title, project_id)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'نخ موقت', $2) RETURNING id`,
      [BID, proj[0].id],
    );
    const bytes = pngOf(320);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "keep.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_attachment", conversationId: conv[0].id, projectId: proj[0].id,
      }),
    );

    await db.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv[0].id]);
    await db.query(`DELETE FROM ai_projects WHERE id = $1`, [proj[0].id]);

    const survived = await scoped(BID, () => media.getMediaAsset(BID, asset.id));
    expect(survived).not.toBeNull();
    expect(survived!.conversationId).toBeNull();
    expect(survived!.projectId).toBeNull();
    // The provenance label itself is retained — we still know it came from chat.
    expect(survived!.source).toBe("ai_attachment");
  });
});

describe("Phase G pt.2 — persisting AI chat image attachments into the library", () => {
  // The config singleton was saved earlier in this file; persist reads it via
  // getMediaConfig(). Guard by re-saving so this block is order-independent.
  beforeAll(async () => {
    await dbLib.withoutTenantScope("test", () => media.saveMediaConfig(config, null));
  });

  function pngDataUrl(size: number): string {
    return `data:image/png;base64,${pngOf(size).toString("base64")}`;
  }

  it("stores a chat image with source=ai_attachment linked to its conversation and project", async () => {
    const { rows: proj } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'کمپین چت', 'seed') RETURNING id`,
      [BID],
    );
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title, project_id)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'رسید چت', $2) RETURNING id`,
      [BID, proj[0].id],
    );

    const stored = await scoped(BID, () =>
      mediaPersist.persistChatImageAttachments({
        businessId: BID,
        userId: null,
        conversationId: conv[0].id,
        projectId: proj[0].id,
        attachments: [
          { kind: "image", dataUrl: pngDataUrl(220), name: "رسید.png" },
          // A PDF in the same turn must NOT be persisted — only images are kept.
          { kind: "pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjc=", name: "فاکتور.pdf" },
        ],
      }),
    );

    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("ai_attachment");
    expect(stored[0].createdByAi).toBe(false);
    expect(stored[0].conversationId).toBe(conv[0].id);
    expect(stored[0].projectId).toBe(proj[0].id);
    expect(stored[0].fileName).toBe("رسید.png");

    // It is now a real, listable library asset for this conversation.
    const listed = await scoped(BID, () => media.listMediaAssets(BID, { conversationId: conv[0].id }));
    expect(listed.assets.map((a) => a.id)).toContain(stored[0].id);
  });

  it("skips silently when storage is not configured", async () => {
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig({ ...config, enabled: false }, null),
    );
    const stored = await scoped(BID, () =>
      mediaPersist.persistChatImageAttachments({
        businessId: BID,
        userId: null,
        conversationId: null,
        projectId: null,
        attachments: [{ kind: "image", dataUrl: pngDataUrl(120) }],
      }),
    );
    expect(stored).toEqual([]);
    // Restore for any later block.
    await dbLib.withoutTenantScope("test", () => media.saveMediaConfig(config, null));
  });

  it("refuses a mislabeled image (bytes not matching the MIME) without storing it", async () => {
    const evil = Buffer.from("<script>alert(1)</script>").toString("base64");
    const stored = await scoped(BID, () =>
      mediaPersist.persistChatImageAttachments({
        businessId: BID,
        userId: null,
        conversationId: null,
        projectId: null,
        attachments: [{ kind: "image", dataUrl: `data:image/png;base64,${evil}` }],
      }),
    );
    expect(stored).toEqual([]);
  });
});

describe("duplicate detection — tenant-scoped by sha256", () => {
  beforeAll(async () => {
    await dbLib.withoutTenantScope("test", () => media.saveMediaConfig(config, null));
  });

  it("finds an existing asset with the exact same bytes in the same business, and not across tenants", async () => {
    const bytes = pngOf(700);
    const hash = sha256(bytes);
    const stored = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "dup-source.png", mimeType: "image/png", bytes, sha256: hash,
      }),
    );

    const found = await scoped(BID, () => media.findMediaAssetByHash(BID, hash));
    expect(found?.id).toBe(stored.id);

    // The same bytes uploaded by the other tenant must not "find" this one.
    const foundAcrossTenants = await scoped(BID2, () => media.findMediaAssetByHash(BID2, hash));
    expect(foundAcrossTenants).toBeNull();

    // A hash nobody has stored yet resolves to nothing.
    expect(await scoped(BID, () => media.findMediaAssetByHash(BID, "0".repeat(64)))).toBeNull();
  });
});

describe("sorting", () => {
  it("orders by name, size and recency as requested", async () => {
    await scoped(BID, async () => {
      const zebra = await media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "zebra.png", mimeType: "image/png", bytes: pngOf(9000), sha256: sha256(pngOf(9000)),
      });
      const alphaBytes = pngOf(100);
      const alpha = await media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "alpha.png", mimeType: "image/png", bytes: alphaBytes, sha256: sha256(alphaBytes),
      });

      const byNameAsc = await media.listMediaAssets(BID, { sort: "name_asc", limit: 200 });
      const alphaIdx = byNameAsc.assets.findIndex((a) => a.id === alpha.id);
      const zebraIdx = byNameAsc.assets.findIndex((a) => a.id === zebra.id);
      expect(alphaIdx).toBeGreaterThanOrEqual(0);
      expect(alphaIdx).toBeLessThan(zebraIdx);

      const byNameDesc = await media.listMediaAssets(BID, { sort: "name_desc", limit: 200 });
      expect(byNameDesc.assets.findIndex((a) => a.id === zebra.id)).toBeLessThan(
        byNameDesc.assets.findIndex((a) => a.id === alpha.id),
      );

      const bySmallest = await media.listMediaAssets(BID, { sort: "smallest", limit: 200 });
      expect(bySmallest.assets[0].byteSize).toBeLessThanOrEqual(bySmallest.assets[1].byteSize);
    });
  });
});

describe("source filter", () => {
  it("narrows the library to one provenance", async () => {
    await scoped(BID, async () => {
      const bytes = pngOf(222);
      await media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "source-filter-generated.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_generated",
      });
      const onlyGenerated = await media.listMediaAssets(BID, { source: "ai_generated" });
      expect(onlyGenerated.assets.every((a) => a.source === "ai_generated")).toBe(true);
      expect(onlyGenerated.assets.length).toBeGreaterThan(0);
    });
  });
});

describe("search normalization — mixed Persian/Arabic input", () => {
  it("finds a Persian-lettered tag when searching with the Arabic letter variant", async () => {
    await scoped(BID, async () => {
      const bytes = pngOf(333);
      const asset = await media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "کتاب‌فروشی.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      });
      // Arabic ك (kaf) / ي (yeh) — what many keyboards actually produce — must
      // still find the Persian ک/ی spelling stored on the file name, and the
      // stored value itself is never rewritten.
      const found = await media.listMediaAssets(BID, { search: "كتاب" });
      expect(found.assets.map((a) => a.id)).toContain(asset.id);
      const stillPersian = await media.getMediaAsset(BID, asset.id);
      expect(stillPersian!.fileName).toBe("کتاب‌فروشی.png");
    });
  });
});

describe("usage references — where a catalogue item points at an asset", () => {
  let menuItemId: string;
  let inventoryItemId: string;
  let assetId: string;
  let unusedAssetId: string;

  beforeAll(async () => {
    const { rows: loc } = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
      [BID],
    );
    const locationId = loc[0].id;

    const bytes = pngOf(444);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "used-everywhere.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );
    assetId = asset.id;

    const unused = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "unused.png", mimeType: "image/png", bytes: pngOf(50), sha256: sha256(pngOf(50)),
      }),
    );
    unusedAssetId = unused.id;

    const { rows: menuItem } = await db.query<{ id: string }>(
      `INSERT INTO menu_items (location_id, name, price, image_media_id) VALUES ($1, 'کاپوچینو', 150000, $2) RETURNING id`,
      [locationId, assetId],
    );
    menuItemId = menuItem[0].id;

    const { rows: invItem } = await db.query<{ id: string }>(
      `INSERT INTO inventory_items (location_id, name, unit, image_media_id) VALUES ($1, 'دانهٔ قهوه', 'kg', $2) RETURNING id`,
      [locationId, assetId],
    );
    inventoryItemId = invItem[0].id;
  });

  it("reports every menu/inventory row pointing at the asset", async () => {
    const usage = await scoped(BID, () => media.getMediaAssetUsage(assetId));
    expect(usage.menuItems.map((r) => r.id)).toContain(menuItemId);
    expect(usage.inventoryItems.map((r) => r.id)).toContain(inventoryItemId);
    expect(media.mediaAssetUsageIsEmpty(usage)).toBe(false);
  });

  it("reports empty usage for an asset nothing points at", async () => {
    const usage = await scoped(BID, () => media.getMediaAssetUsage(unusedAssetId));
    expect(media.mediaAssetUsageIsEmpty(usage)).toBe(true);
  });

  it("loses only the pointer (FK SET NULL) when the asset is deleted — the catalogue rows survive", async () => {
    await scoped(BID, () => media.deleteMediaAsset(BID, assetId, config));
    const { rows } = await db.query<{ image_media_id: string | null }>(
      `SELECT image_media_id FROM menu_items WHERE id = $1`,
      [menuItemId],
    );
    expect(rows[0].image_media_id).toBeNull();
  });
});

describe("trash — soft delete, restore, and the retention purge tick", () => {
  it("moves an asset to the trash without touching the row or the object", async () => {
    const bytes = pngOf(80);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "trash-me.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );

    const trashed = await scoped(BID, () => media.softDeleteMediaAsset(BID, asset.id));
    expect(trashed).toBe(true);

    // Still readable by id (administrative paths, e.g. restore) …
    const stillThere = await scoped(BID, () => media.getMediaAsset(BID, asset.id));
    expect(stillThere?.deletedAt).not.toBeNull();
    // … but no longer served through the normal read path.
    const read = await scoped(BID, () => media.readMediaObject(BID, asset.id, config));
    expect(read).toBeNull();
    // … and excluded from the default library listing.
    const listed = await scoped(BID, () => media.listMediaAssets(BID, {}));
    expect(listed.assets.map((a) => a.id)).not.toContain(asset.id);
    // … while showing up in the trash view.
    const trash = await scoped(BID, () => media.listMediaAssets(BID, { trashed: true }));
    expect(trash.assets.map((a) => a.id)).toContain(asset.id);

    // A second soft-delete is a no-op (idempotent), not an error.
    const again = await scoped(BID, () => media.softDeleteMediaAsset(BID, asset.id));
    expect(again).toBe(false);

    // Restoring clears it and it is a normal asset again.
    const restored = await scoped(BID, () => media.restoreMediaAsset(BID, asset.id));
    expect(restored).toBe(true);
    const backNormal = await scoped(BID, () => media.getMediaAsset(BID, asset.id));
    expect(backNormal?.deletedAt).toBeNull();
    const listedAgain = await scoped(BID, () => media.listMediaAssets(BID, {}));
    expect(listedAgain.assets.map((a) => a.id)).toContain(asset.id);
  });

  it("a duplicate upload never reuses a trashed asset's hash", async () => {
    const bytes = pngOf(81);
    const hash = sha256(bytes);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "will-be-trashed.png", mimeType: "image/png", bytes, sha256: hash,
      }),
    );
    await scoped(BID, () => media.softDeleteMediaAsset(BID, asset.id));
    const found = await scoped(BID, () => media.findMediaAssetByHash(BID, hash));
    expect(found).toBeNull();
  });

  it("the retention sweep purges only what is past the cutoff, leaving fresher trash alone", async () => {
    const oldBytes = pngOf(82);
    const freshBytes = pngOf(83);
    const oldAsset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "old-trash.png", mimeType: "image/png", bytes: oldBytes, sha256: sha256(oldBytes),
      }),
    );
    const freshAsset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "fresh-trash.png", mimeType: "image/png", bytes: freshBytes, sha256: sha256(freshBytes),
      }),
    );
    await scoped(BID, () => media.softDeleteMediaAsset(BID, oldAsset.id));
    await scoped(BID, () => media.softDeleteMediaAsset(BID, freshAsset.id));
    // Backdate only the "old" one past a 30-day retention window.
    await db.query(`UPDATE media_assets SET deleted_at = now() - interval '31 days' WHERE id = $1`, [oldAsset.id]);

    const purged = await media.runMediaTrashPurgeTick(new Date(), 30);
    expect(purged).toBeGreaterThanOrEqual(1);

    const oldStillThere = await scoped(BID, () => media.getMediaAsset(BID, oldAsset.id));
    expect(oldStillThere).toBeNull(); // row gone for good
    const freshStillThere = await scoped(BID, () => media.getMediaAsset(BID, freshAsset.id));
    expect(freshStillThere?.deletedAt).not.toBeNull(); // still in the trash, untouched
  });
});

describe("collections — a named set an asset can belong to any number of", () => {
  let assetA: string;
  let assetB: string;

  beforeAll(async () => {
    const a = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "campaign-1.png", mimeType: "image/png", bytes: pngOf(90), sha256: sha256(pngOf(90)),
      }),
    );
    const b = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "campaign-2.png", mimeType: "image/png", bytes: pngOf(91), sha256: sha256(pngOf(91)),
      }),
    );
    assetA = a.id;
    assetB = b.id;
  });

  it("creates, lists, and renames a collection; membership counts follow non-trashed assets", async () => {
    const created = await scoped(BID, () =>
      media.createMediaCollection(BID, null, "کمپین تابستانه", "بنرهای فصلی"),
    );
    expect(created.assetCount).toBe(0);

    const addedA = await scoped(BID, () => media.addAssetToCollection(BID, created.id, assetA, null));
    const addedB = await scoped(BID, () => media.addAssetToCollection(BID, created.id, assetB, null));
    expect(addedA).toBe(true);
    expect(addedB).toBe(true);
    // Adding the same asset twice is a no-op, not a duplicate row / an error.
    await scoped(BID, () => media.addAssetToCollection(BID, created.id, assetA, null));

    const list = await scoped(BID, () => media.listMediaCollections(BID));
    const found = list.find((c) => c.id === created.id);
    expect(found?.assetCount).toBe(2);

    const forAssetA = await scoped(BID, () => media.listCollectionsForAsset(BID, assetA));
    expect(forAssetA.map((c) => c.id)).toContain(created.id);

    // Filtering the library by collection returns exactly its members.
    const filtered = await scoped(BID, () => media.listMediaAssets(BID, { collectionId: created.id }));
    expect(filtered.assets.map((a) => a.id).sort()).toEqual([assetA, assetB].sort());

    const renamed = await scoped(BID, () => media.renameMediaCollection(BID, created.id, "کمپین بهاره", undefined));
    expect(renamed).toBe(true);

    const removed = await scoped(BID, () => media.removeAssetFromCollection(BID, created.id, assetB));
    expect(removed).toBe(true);
    const afterRemove = await scoped(BID, () => media.listMediaCollections(BID));
    expect(afterRemove.find((c) => c.id === created.id)?.assetCount).toBe(1);

    // Deleting the collection disbands the grouping; the assets are untouched.
    const deleted = await scoped(BID, () => media.deleteMediaCollection(BID, created.id));
    expect(deleted).toBe(true);
    const stillThere = await scoped(BID, () => media.getMediaAsset(BID, assetA));
    expect(stillThere).not.toBeNull();
  });

  it("two businesses can each have their own collection of the same name (tenant-scoped uniqueness)", async () => {
    const one = await scoped(BID, () => media.createMediaCollection(BID, null, "پرفروش‌ترین‌ها", null));
    const two = await scoped(BID2, () => media.createMediaCollection(BID2, null, "پرفروش‌ترین‌ها", null));
    expect(one.id).not.toBe(two.id);
    const forBid = await scoped(BID, () => media.listMediaCollections(BID));
    const forBid2 = await scoped(BID2, () => media.listMediaCollections(BID2));
    expect(forBid.map((c) => c.id)).toContain(one.id);
    expect(forBid.map((c) => c.id)).not.toContain(two.id);
    expect(forBid2.map((c) => c.id)).toContain(two.id);
    expect(forBid2.map((c) => c.id)).not.toContain(one.id);
  });
});

describe("WordPress mapping — canonical asset ↔ one connection's remote attachment", () => {
  let assetId: string;
  let connectionId: string;

  beforeAll(async () => {
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "product-shot.png", mimeType: "image/png", bytes: pngOf(95), sha256: sha256(pngOf(95)),
      }),
    );
    assetId = asset.id;

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, name, provider, base_url, consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext)
       VALUES ($1, 'فروشگاه وردپرسی', 'woocommerce', 'https://example.com', 'ck', 'cs', 'wh')
       RETURNING id`,
      [BID],
    );
    connectionId = rows[0].id;
  });

  it("records a pending push, then a confirm fills in the remote identity", async () => {
    const operationId = `wp-media:${connectionId}:${randomUUID()}`;
    const mapping = await scoped(BID, () =>
      media.recordWordPressMediaPush({ businessId: BID, mediaAssetId: assetId, connectionId, operationId }),
    );
    expect(mapping.status).toBe("pending");
    expect(mapping.wpMediaId).toBeNull();

    const confirmed = await scoped(BID, () =>
      media.confirmWordPressMediaSync(operationId, "4821", "https://example.com/wp-content/uploads/product-shot.png"),
    );
    expect(confirmed).toBe(true);

    const mappings = await scoped(BID, () => media.listWordPressMappingsForAsset(BID, assetId));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].status).toBe("synced");
    expect(mappings[0].wpMediaId).toBe("4821");

    const direct = await scoped(BID, () => media.getWordPressMediaMapping(BID, connectionId, assetId));
    expect(direct?.status).toBe("synced");
  });

  it("re-pushing the same asset to the same connection updates the existing row instead of duplicating it", async () => {
    const secondOperationId = `wp-media:${connectionId}:${randomUUID()}`;
    await scoped(BID, () =>
      media.recordWordPressMediaPush({
        businessId: BID,
        mediaAssetId: assetId,
        connectionId,
        operationId: secondOperationId,
      }),
    );
    const mappings = await scoped(BID, () => media.listWordPressMappingsForAsset(BID, assetId));
    expect(mappings).toHaveLength(1); // still one row, not two
    expect(mappings[0].status).toBe("pending"); // reset by the re-push
    expect(mappings[0].operationId).toBe(secondOperationId);
  });

  it("a failed push is recorded distinctly from a synced one", async () => {
    const operationId = `wp-media:${connectionId}:${randomUUID()}`;
    const failAsset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "will-fail.png", mimeType: "image/png", bytes: pngOf(96), sha256: sha256(pngOf(96)),
      }),
    );
    await scoped(BID, () =>
      media.recordWordPressMediaPush({ businessId: BID, mediaAssetId: failAsset.id, connectionId, operationId }),
    );
    const failed = await scoped(BID, () => media.failWordPressMediaSync(operationId, "سایت وردپرس پاسخ نداد"));
    expect(failed).toBe(true);
    const mapping = await scoped(BID, () => media.getWordPressMediaMapping(BID, connectionId, failAsset.id));
    expect(mapping?.status).toBe("failed");
    expect(mapping?.lastError).toContain("وردپرس");
  });
});

describe("readMediaObjectDownloadUrl — a presigned link for a fetch this app cannot proxy", () => {
  it("mints a URL that actually fetches the object's real bytes straight from the bucket", async () => {
    const bytes = pngOf(120);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "for-wordpress.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );

    const result = await scoped(BID, () => media.readMediaObjectDownloadUrl(BID, asset.id, config, 300));
    expect(result).not.toBeNull();
    expect(result?.asset.id).toBe(asset.id);
    expect(result?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media-test\/media\//);
    expect(result?.url).toContain("X-Amz-Expires=300");

    // The mock bucket from this file's beforeAll actually serves whatever URL
    // comes out — the same server a real presigned-GET client would hit.
    const response = await fetch(result!.url);
    expect(response.status).toBe(200);
    const fetched = Buffer.from(await response.arrayBuffer());
    expect(fetched.equals(bytes)).toBe(true);
  });

  it("refuses a business's asset id under another tenant, the same fail-closed check as readMediaObject", async () => {
    const bytes = pngOf(121);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "tenant-only.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );
    const result = await scoped(BID2, () => media.readMediaObjectDownloadUrl(BID2, asset.id, config, 300));
    expect(result).toBeNull();
  });

  it("returns null for an asset that does not exist", async () => {
    const result = await scoped(BID, () =>
      media.readMediaObjectDownloadUrl(BID, "00000000-0000-0000-0000-000000000000", config, 300),
    );
    expect(result).toBeNull();
  });
});

describe("deterministic transforms (migration 0175) — crop/rotate/resize as derived assets", () => {
  it("stores a 'transformed' variant pointing back at its source, carrying its transform_ops, and round-trips through getMediaAsset", async () => {
    const originalBytes = pngOf(200);
    const original = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "میز-اول.png", mimeType: "image/png", bytes: originalBytes, sha256: sha256(originalBytes),
      }),
    );
    expect(original.variant).toBe("original");
    expect(original.sourceAssetId).toBeNull();
    expect(original.transformOps).toEqual([]);

    const rotatedBytes = pngOf(210);
    const rotateOp = { operation: "rotate" as const, degrees: 90 };
    const rotated = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "میز-اول-rotate.png", mimeType: "image/png", bytes: rotatedBytes, sha256: sha256(rotatedBytes),
        folderId: original.folderId,
        variant: "transformed",
        sourceAssetId: original.id,
        transformOps: [rotateOp],
      }),
    );
    expect(rotated.variant).toBe("transformed");
    expect(rotated.sourceAssetId).toBe(original.id);
    expect(rotated.transformOps).toEqual([rotateOp]);

    // The DB round-trip (not just the freshly-returned row) preserves everything,
    // proving the jsonb column and the widened variant CHECK both persisted correctly.
    const reread = await scoped(BID, () => media.getMediaAsset(BID, rotated.id));
    expect(reread).not.toBeNull();
    expect(reread!.variant).toBe("transformed");
    expect(reread!.sourceAssetId).toBe(original.id);
    expect(reread!.transformOps).toEqual([rotateOp]);

    // The original asset itself is untouched — non-destructive by construction.
    const rereadOriginal = await scoped(BID, () => media.getMediaAsset(BID, original.id));
    expect(rereadOriginal!.variant).toBe("original");
    expect(rereadOriginal!.transformOps).toEqual([]);
  });

  it("a chain of transforms (crop then resize) each records only its own op, not the whole history", async () => {
    const originalBytes = pngOf(220);
    const original = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "banner.png", mimeType: "image/png", bytes: originalBytes, sha256: sha256(originalBytes),
      }),
    );

    const cropOp = { operation: "crop" as const, x: 0, y: 0, width: 100, height: 100 };
    const croppedBytes = pngOf(230);
    const cropped = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "banner-crop.png", mimeType: "image/png", bytes: croppedBytes, sha256: sha256(croppedBytes),
        variant: "transformed", sourceAssetId: original.id, transformOps: [cropOp],
      }),
    );

    const resizeOp = { operation: "resize" as const, width: 80, fit: "inside" as const };
    const resizedBytes = pngOf(240);
    const resized = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "banner-crop-resize.png", mimeType: "image/png", bytes: resizedBytes, sha256: sha256(resizedBytes),
        variant: "transformed", sourceAssetId: cropped.id, transformOps: [resizeOp],
      }),
    );

    expect(resized.sourceAssetId).toBe(cropped.id);
    expect(resized.transformOps).toEqual([resizeOp]);
    expect(cropped.sourceAssetId).toBe(original.id);
    expect(cropped.transformOps).toEqual([cropOp]);
  });

  it("a transformed asset shows up in the library listing next to its source, filterable like any other asset", async () => {
    const originalBytes = pngOf(250);
    const original = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "listable.png", mimeType: "image/png", bytes: originalBytes, sha256: sha256(originalBytes),
      }),
    );
    const transformedBytes = pngOf(260);
    const transformed = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "listable-rotate.png", mimeType: "image/png", bytes: transformedBytes, sha256: sha256(transformedBytes),
        variant: "transformed", sourceAssetId: original.id, transformOps: [{ operation: "rotate", degrees: -90 }],
      }),
    );

    const listed = await scoped(BID, () => media.listMediaAssets(BID, { search: "listable" }));
    const ids = listed.assets.map((item) => item.id);
    expect(ids).toContain(original.id);
    expect(ids).toContain(transformed.id);
  });
});

describe("getMediaAssetLineage — the version-history walk the asset drawer's disclosed gap needed", () => {
  it("returns no ancestors and no descendants for a plain, untouched upload", async () => {
    const bytes = pngOf(300);
    const original = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lonely.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );
    const lineage = await scoped(BID, () => media.getMediaAssetLineage(BID, original.id));
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.descendants).toEqual([]);
  });

  it("walks a multi-hop chain (original → crop → enhance) root-first, further than the immediate parent alone", async () => {
    const originalBytes = pngOf(310);
    const original = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lineage-original.png", mimeType: "image/png", bytes: originalBytes, sha256: sha256(originalBytes),
      }),
    );
    const croppedBytes = pngOf(320);
    const cropped = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lineage-crop.png", mimeType: "image/png", bytes: croppedBytes, sha256: sha256(croppedBytes),
        variant: "transformed", sourceAssetId: original.id, transformOps: [{ operation: "crop", x: 0, y: 0, width: 50, height: 50 }],
      }),
    );
    const enhancedBytes = pngOf(330);
    const enhanced = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lineage-enhance.png", mimeType: "image/png", bytes: enhancedBytes, sha256: sha256(enhancedBytes),
        variant: "enhanced", sourceAssetId: cropped.id,
      }),
    );

    // From the leaf (`enhanced`): the whole chain, root-first — not just `cropped`.
    const lineage = await scoped(BID, () => media.getMediaAssetLineage(BID, enhanced.id));
    expect(lineage.ancestors.map((a) => a.id)).toEqual([original.id, cropped.id]);
    expect(lineage.ancestors[0].variant).toBe("original");
    expect(lineage.ancestors[1].variant).toBe("transformed");
    expect(lineage.descendants).toEqual([]);

    // From the middle (`cropped`): one ancestor up, one descendant down — it
    // never walks into the descendant's own further descendants.
    const midLineage = await scoped(BID, () => media.getMediaAssetLineage(BID, cropped.id));
    expect(midLineage.ancestors.map((a) => a.id)).toEqual([original.id]);
    expect(midLineage.descendants.map((d) => d.id)).toEqual([enhanced.id]);
  });

  it("lists every direct descendant when an asset was edited more than one way (crop and upscale, both from the same original)", async () => {
    const originalBytes = pngOf(340);
    const original = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lineage-fork.png", mimeType: "image/png", bytes: originalBytes, sha256: sha256(originalBytes),
      }),
    );
    const cropBytes = pngOf(350);
    const crop = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lineage-fork-crop.png", mimeType: "image/png", bytes: cropBytes, sha256: sha256(cropBytes),
        variant: "transformed", sourceAssetId: original.id, transformOps: [{ operation: "rotate", degrees: 90 }],
      }),
    );
    const upscaleBytes = pngOf(360);
    const upscale = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "lineage-fork-upscale.png", mimeType: "image/png", bytes: upscaleBytes, sha256: sha256(upscaleBytes),
        variant: "upscaled", sourceAssetId: original.id,
      }),
    );

    const lineage = await scoped(BID, () => media.getMediaAssetLineage(BID, original.id));
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.descendants.map((d) => d.id).sort()).toEqual([crop.id, upscale.id].sort());
  });

  it("returns an empty lineage, not another tenant's data, for an asset id outside the caller's business", async () => {
    const otherBytes = pngOf(370);
    const foreign = await scoped(BID2, () =>
      media.storeMediaAsset({
        businessId: BID2, userId: null, config, kind: "image",
        fileName: "other-tenant.png", mimeType: "image/png", bytes: otherBytes, sha256: sha256(otherBytes),
      }),
    );
    // getMediaAssetLineage is asked about BID2's own asset while scoped to BID —
    // the same tenant-isolation shape every other media-service read enforces
    // (getMediaAsset re-checks business_id on every hop, including the first).
    const lineage = await scoped(BID, () => media.getMediaAssetLineage(BID, foreign.id));
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.descendants).toEqual([]);
  });
});
