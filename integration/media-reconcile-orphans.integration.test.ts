/**
 * scripts/media-reconcile-orphans.ts against a real migrated database and an
 * in-memory S3 server (PUT/GET/DELETE *and* ListObjectsV2, unlike the mock
 * in media-library.integration.test.ts which never needs to list).
 *
 * The script is invoked as a child process through the repository-local
 * `tsx` CLI rather than by importing its internals, because its value is the
 * CLI contract (dry run vs. --apply --backup-confirmed, exit codes, stdout)
 * that a human or a cron job actually depends on.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const BID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

let databaseName: string;
let databaseUrl: string;
let db: Client;
let s3Server: Server;
let s3Port: number;
/** key → { bytes, lastModified } — what the mock bucket holds right now. */
const bucketObjects = new Map<string, { bytes: Buffer; lastModified: string }>();

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function listObjectsXml(prefix: string): string {
  const contents = [...bucketObjects.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(
      ([key, obj]) =>
        `<Contents><Key>${xmlEscape(key)}</Key><Size>${obj.bytes.byteLength}</Size><LastModified>${obj.lastModified}</LastModified></Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
}

beforeAll(async () => {
  s3Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawKey = decodeURIComponent(url.pathname.replace(/^\/media-orphan-test\/?/, ""));
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/xml");
      res.end(listObjectsXml(prefix));
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        bucketObjects.set(rawKey, { bytes: Buffer.concat(chunks), lastModified: new Date().toISOString() });
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      const obj = bucketObjects.get(rawKey);
      if (!obj) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.statusCode = 200;
      res.end(obj.bytes);
      return;
    }
    if (req.method === "DELETE") {
      bucketObjects.delete(rawKey);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  s3Port = (s3Server.address() as AddressInfo).port;

  databaseName = `pos_media_orphan_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });

  db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(`INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه سوم', 'cafe-three', 'pro')`, [BID]);
  await db.query(
    `UPDATE platform_media_config SET
       enabled = true, endpoint = $1, region = 'us-east-1', bucket = 'media-orphan-test',
       key_prefix = 'media/', access_key_id = 'test-access', secret_access_key = 'test-secret'
     WHERE id = true`,
    [`http://127.0.0.1:${s3Port}`],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await new Promise<void>((resolve) => s3Server?.close(() => resolve()));
});

beforeEach(async () => {
  bucketObjects.clear();
  await db.query(`DELETE FROM media_assets`);
});

async function runScript(...args: string[]): Promise<{ stdout: string; code: number }> {
  // Invoke the installed TSX entry point through Node directly. This avoids
  // npm consuming forwarded flags and avoids platform-specific `.cmd` shell
  // quoting on Windows CI.
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCliPath, "scripts/media-reconcile-orphans.ts", ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
    return { stdout, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n");
    return { stdout: output, code: err.code ?? 1 };
  }
}

const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago — past the grace period
const FRESH = new Date().toISOString(); // just now — inside the grace period

describe("scripts/media-reconcile-orphans.ts", () => {
  it("reports 'nothing to reconcile' when storage is not configured, without touching the bucket", async () => {
    await db.query(`UPDATE platform_media_config SET enabled = false WHERE id = true`);
    try {
      const { stdout, code } = await runScript();
      expect(code, stdout).toBe(0);
      expect(stdout).toContain("not configured/enabled");
    } finally {
      await db.query(`UPDATE platform_media_config SET enabled = true WHERE id = true`);
    }
  });

  it("dry run: finds an old orphaned object, ignores a fresh one (grace period), leaves the bucket untouched", async () => {
    const claimedKey = `media/${BID}/${randomUUID()}/kept.png`;
    bucketObjects.set(claimedKey, { bytes: Buffer.from("kept"), lastModified: OLD });
    await db.query(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', 'kept.png', 'image/png', 4, $2, repeat('a', 64))`,
      [BID, claimedKey],
    );

    const oldOrphanKey = `media/${BID}/${randomUUID()}/orphan-old.png`;
    bucketObjects.set(oldOrphanKey, { bytes: Buffer.from("orphan"), lastModified: OLD });

    const freshOrphanKey = `media/${BID}/${randomUUID()}/orphan-fresh.png`;
    bucketObjects.set(freshOrphanKey, { bytes: Buffer.from("orphan"), lastModified: FRESH });

    const { stdout, code } = await runScript();
    expect(code, stdout).toBe(0);
    expect(stdout).toContain("Orphaned objects (no row claims them, older than the grace period): 1");
    expect(stdout).toContain(oldOrphanKey);
    expect(stdout).not.toContain(freshOrphanKey);
    // Dry run never deletes.
    expect(bucketObjects.has(oldOrphanKey)).toBe(true);
    expect(bucketObjects.has(claimedKey)).toBe(true);
  }, 30_000);

  it("refuses --apply without --backup-confirmed and deletes nothing", async () => {
    const key = `media/${BID}/${randomUUID()}/orphan.png`;
    bucketObjects.set(key, { bytes: Buffer.from("x"), lastModified: OLD });
    const { stdout, code } = await runScript("--apply");
    expect(code, stdout).toBe(2);
    expect(bucketObjects.has(key)).toBe(true);
  });

  it("--apply --backup-confirmed deletes exactly the orphaned objects, and only those", async () => {
    const claimedKey = `media/${BID}/${randomUUID()}/kept.png`;
    bucketObjects.set(claimedKey, { bytes: Buffer.from("kept"), lastModified: OLD });
    await db.query(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', 'kept.png', 'image/png', 4, $2, repeat('b', 64))`,
      [BID, claimedKey],
    );
    const orphanKey = `media/${BID}/${randomUUID()}/orphan.png`;
    bucketObjects.set(orphanKey, { bytes: Buffer.from("orphan"), lastModified: OLD });

    const { stdout, code } = await runScript("--apply", "--backup-confirmed");
    expect(code, stdout).toBe(0);
    expect(stdout).toContain("Deleted 1/1 orphaned object(s)");
    expect(bucketObjects.has(orphanKey)).toBe(false);
    expect(bucketObjects.has(claimedKey)).toBe(true);
  }, 30_000);

  it("reports a broken reference (row exists, object missing) without deleting the row or crashing", async () => {
    const missingKey = `media/${BID}/${randomUUID()}/gone.png`;
    await db.query(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', 'gone.png', 'image/png', 4, $2, repeat('c', 64))`,
      [BID, missingKey],
    );
    const { stdout, code } = await runScript();
    expect(code, stdout).toBe(0);
    expect(stdout).toContain("Broken references (row exists, object missing");
    expect(stdout).toContain(missingKey);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM media_assets WHERE storage_key = $1`, [missingKey]);
    expect(rows[0].n).toBe(1); // the row is still there — this script never deletes rows
  });

  it("a trashed (soft-deleted) asset's object is treated as claimed, not orphaned", async () => {
    const key = `media/${BID}/${randomUUID()}/trashed.png`;
    bucketObjects.set(key, { bytes: Buffer.from("trashed"), lastModified: OLD });
    await db.query(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256, deleted_at)
       VALUES ($1, 'image', 'trashed.png', 'image/png', 7, $2, repeat('d', 64), now())`,
      [BID, key],
    );
    const { stdout, code } = await runScript();
    expect(code, stdout).toBe(0);
    expect(stdout).toContain("Orphaned objects (no row claims them, older than the grace period): 0");
    expect(bucketObjects.has(key)).toBe(true);
  });
});
