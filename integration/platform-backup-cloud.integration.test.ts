/**
 * Issue #1296 — the whole-platform backup's *off-site* half, end to end.
 *
 * Three lies were possible at once on the live deployment, and each needs a
 * database, a bucket and the real upload path to be disproved:
 *
 *   1. "running" without a deadline — a worker that died mid-upload left a row
 *      that the catch-up read as in flight, forever. The recovery is checked
 *      here by writing such a row, letting its lease expire, and letting the
 *      scheduler tick reclaim it.
 *   2. "retryable" without a classifier — a bare undici `fetch failed` skipped
 *      the retry ladder. The mock bucket speaks each failure shape (503, 403, a
 *      destroyed socket, a 200 over a truncated body) and the run rows have to
 *      say the right thing about each.
 *   3. "protected" without comparing today's artifact with what is off-site —
 *      a 2.84 MB September object kept the console green while a 319 MB capture
 *      sat on one disk. The health line is asserted per artifact, including the
 *      historical object and the case where retention deleted a confirmed copy.
 *
 * Most artifacts here come from the `pg_dump` stub and are small, but they travel
 * the same code: hash → encrypt-if-needed → streamed signed PUT → HEAD/size proof
 * (or a full re-download and hash) → confirmation on the local run row. Two
 * groups deliberately step outside that:
 *
 *   • the *restore drill* deletes the local file and restores from the bucket
 *     into a scratch database, because "the object is there" is not the same
 *     claim as "the object is a recovery point";
 *   • the *large artifact* is a real 64 MiB file, because the incident was about
 *     a 319 MB body and a ~120 KB fixture cannot show that the streaming path and
 *     its size-derived timeout behave at that scale.
 *
 * Nothing in this file talks to a real bucket, and no production database is
 * touched.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "support", "pg-stub.cjs");
const databaseName = `plat_cloud_${Math.random().toString(36).slice(2, 10)}`;
const PREFIX = "platform-backups/";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/**
 * The bucket, in memory and path-style, with switches for the failures the
 * issue actually saw. Every request is SigV4-signed by the client; the mock
 * never validates the signature (that is `s3-lite.test.ts`'s job) but it does
 * record the `Authorization` header so a test can prove it never reaches a run
 * row, a diagnostics column or an audit line.
 */
interface Behavior {
  /** answer this many PUTs with 503 SlowDown, then behave */
  put503: number;
  /** answer every PUT with 403 SignatureDoesNotMatch */
  put403: boolean;
  /** destroy the socket halfway through the next PUT body */
  resetNextPut: boolean;
  /** store a body missing its last byte, and answer 200 */
  truncateNextPut: boolean;
}

const bucket = new Map<string, Buffer>();
const behavior: Behavior = { put503: 0, put403: false, resetNextPut: false, truncateNextPut: false };
const seenAuth: string[] = [];
/** PUTs the mock received, so "how many attempts really happened" is observable. */
let putCount = 0;

function resetBehavior() {
  behavior.put503 = 0;
  behavior.put403 = false;
  behavior.resetNextPut = false;
  behavior.truncateNextPut = false;
  putCount = 0;
}

let s3Server: Server;
let endpoint = "";

function listXml(prefix: string): string {
  const contents = [...bucket.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([key, body]) =>
        `<Contents><Key>${key}</Key><Size>${body.byteLength}</Size><LastModified>2026-11-07T06:00:00.000Z</LastModified></Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

function serveS3(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const raw = url.pathname.replace(/^\/+/, "");
  const slash = raw.indexOf("/");
  const key = slash === -1 ? "" : decodeURIComponent(raw.slice(slash + 1));
  const auth = req.headers.authorization;
  if (typeof auth === "string") seenAuth.push(auth);

  if (req.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/xml");
    res.end(listXml(url.searchParams.get("prefix") ?? ""));
    return;
  }

  if (req.method === "HEAD") {
    const stored = bucket.get(key);
    if (!stored) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-length", String(stored.byteLength));
    res.setHeader("etag", `"${sha(stored)}"`);
    res.end();
    return;
  }

  if (req.method === "PUT") {
    putCount += 1;
    if (behavior.put403) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/xml");
      res.end("<Error><Code>SignatureDoesNotMatch</Code><Message>signature mismatch</Message></Error>");
      return;
    }
    if (behavior.put503 > 0) {
      behavior.put503 -= 1;
      res.statusCode = 503;
      res.setHeader("content-type", "application/xml");
      res.end("<Error><Code>SlowDown</Code><Message>please slow down</Message></Error>");
      return;
    }
    if (behavior.resetNextPut) {
      behavior.resetNextPut = false;
      // The shape that produced the live `TypeError: fetch failed`: the socket
      // goes away mid-body, after headers, with no provider error document.
      req.on("data", () => req.socket.destroy());
      req.on("error", () => undefined);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (behavior.truncateNextPut) {
        behavior.truncateNextPut = false;
        body = body.subarray(0, Math.max(1, body.byteLength - 1));
      }
      bucket.set(key, body);
      res.statusCode = 200;
      res.setHeader("etag", `"${sha(body)}"`);
      res.end();
    });
    return;
  }

  if (req.method === "GET") {
    const stored = bucket.get(key);
    if (!stored) {
      res.statusCode = 404;
      res.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-length", String(stored.byteLength));
    res.end(stored);
    return;
  }

  if (req.method === "DELETE") {
    bucket.delete(key);
    res.statusCode = 204;
    res.end();
    return;
  }

  res.statusCode = 405;
  res.end();
}

let svc: typeof import("../src/lib/platform-backup-service");
let dbLib: typeof import("../src/lib/db");
let workDir: string;
let scratch: Client;

beforeAll(async () => {
  s3Server = createServer(serveS3);
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(s3Server.address() as AddressInfo).port}`;

  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-platform-cloud-"));
  const windows = process.platform === "win32";
  const dumpSh = path.join(workDir, windows ? "pg_dump.cmd" : "pg_dump");
  const restoreSh = path.join(workDir, windows ? "pg_restore.cmd" : "pg_restore");
  if (windows) {
    const node = process.execPath;
    await fs.writeFile(dumpSh, `@echo off\r\n"${node}" "${STUB}" dump %*\r\n`, "utf8");
    await fs.writeFile(restoreSh, `@echo off\r\n"${node}" "${STUB}" restore %*\r\n`, "utf8");
  } else {
    await fs.writeFile(dumpSh, `#!/bin/sh\nexec node "${STUB}" dump "$@"\n`, { mode: 0o755 });
    await fs.writeFile(restoreSh, `#!/bin/sh\nexec node "${STUB}" restore "$@"\n`, { mode: 0o755 });
  }
  process.env.PG_DUMP_PATH = dumpSh;
  process.env.PG_RESTORE_PATH = restoreSh;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.PLATFORM_BACKUP_DIR = path.join(workDir, "backups");
  delete process.env.PLATFORM_BACKUP_SECONDARY_DIR;
  delete process.env.PLATFORM_BACKUP_PASSPHRASE;

  svc = await import("../src/lib/platform-backup-service");
  dbLib = await import("../src/lib/db");
  scratch = new Client({ connectionString: urlFor(databaseName) });
  await scratch.connect();
}, 180_000);

afterAll(async () => {
  await scratch?.end().catch(() => {});
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.PG_DUMP_PATH;
  delete process.env.PG_RESTORE_PATH;
  delete process.env.PLATFORM_BACKUP_DIR;
  await new Promise<void>((resolve) => s3Server?.close(() => resolve()));
  await fs.rm(workDir, { recursive: true, force: true });

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(() => {
  resetBehavior();
});

/** The console's PUT, minus HTTP: partial body merged with what is stored. */
async function setConfig(patch: Record<string, unknown>) {
  const res = await svc.savePlatformBackupConfig(patch, null);
  expect(res.ok ? "ok" : JSON.stringify(res)).toBe("ok");
}

const cloudConfig = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  endpoint,
  region: "us-east-1",
  bucket: "backups",
  prefix: PREFIX,
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  retention: 30,
  ...extra,
});

/** A run with a fresh artifact and the bucket wired up. */
async function captureAndConfigure(extra: Record<string, unknown> = {}) {
  await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
  await setConfig({ cloud: cloudConfig(extra) });
  const run = await svc.runPlatformLocalBackup("manual", null);
  if (run.status !== "ok") throw new Error(`backup failed: ${"error" in run ? run.error : run.status}`);
  return run;
}

const objectKeyFor = (artifact: string) => `${PREFIX}${artifact.endsWith(".enc") ? artifact : `${artifact}.enc`}`;

/**
 * Every test starts from a world with one artifact, one bucket and one history —
 * the bucket, the artifact directory and the run table are all globals shared by
 * the module under test, so leaving yesterday's rows behind would let an earlier
 * test's failed attempt fund (or suppress) a later test's ladder.
 */
async function prepare() {
  resetBehavior();
  await scratch.query("DELETE FROM platform_backup_runs");
  bucket.clear();
  const dir = svc.platformBackupDir();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

describe("a fresh artifact reaches the bucket and is confirmed there", () => {
  it("uploads it encrypted, proves it by HEAD, and records the confirmation on the local run", async () => {
    await prepare();
    const run = await captureAndConfigure();
    const localPath = path.join(svc.platformBackupDir(), run.artifact);
    const bytes = await fs.readFile(localPath);
    // The live artifact was `.dump.enc`; the upload path must never send the
    // plaintext dump, and the stub archive's own magic is the standing check.
    expect(run.artifact.endsWith(".enc")).toBe(true);
    expect(bytes.subarray(0, 7).toString("latin1")).toBe("POSBKP1");

    const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(result.status === "ok" ? "ok" : JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.key).toBe(objectKeyFor(run.artifact));
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.verifyMode).toBe("size");

    // What the bucket actually holds is the ciphertext we hashed locally.
    const stored = bucket.get(result.key);
    expect(stored?.byteLength).toBe(bytes.byteLength);
    expect(sha(stored!)).toBe(sha(bytes));
    expect(stored!.subarray(0, 7).toString("latin1")).toBe("POSBKP1");

    // …and the proof landed on the *local* row, not on the cloud row: that row is
    // the artifact's identity, and "this capture is off-site" is a fact about it.
    const confirmed = await scratch.query<{
      artifact: string;
      cloud_verified_key: string;
      cloud_verified_size: string;
      cloud_verify_mode: string;
      cloud_verified_at: Date;
    }>(
      `SELECT artifact, cloud_verified_key, cloud_verified_size, cloud_verify_mode, cloud_verified_at
         FROM platform_backup_runs
        WHERE kind = 'local' AND artifact = $1`,
      [run.artifact],
    );
    expect(confirmed.rows).toHaveLength(1);
    expect(confirmed.rows[0].cloud_verified_key).toBe(result.key);
    expect(Number(confirmed.rows[0].cloud_verified_size)).toBe(bytes.byteLength);
    expect(confirmed.rows[0].cloud_verify_mode).toBe("size");
    expect(confirmed.rows[0].cloud_verified_at).toBeInstanceOf(Date);
  });

  it("reads as `current` in the health contract, with no alert", async () => {
    await prepare();
    const run = await captureAndConfigure();
    const uploaded = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(uploaded.status).toBe("ok");

    const health = await svc.getPlatformBackupHealth();
    expect(health.cloudEnabled).toBe(true);
    expect(health.cloudReachable).toBe(true);
    expect(health.cloud.state).toBe("current");
    expect(health.cloud.currentArtifact).toBe(run.artifact);
    expect(health.cloud.currentConfirmed).toBe(true);
    expect(health.cloud.latestConfirmedArtifact).toBe(run.artifact);
    expect(health.cloud.behindMs).toBe(0);
    expect(health.cloud.rpoBreached).toBe(false);
    expect(health.cloud.historical.map((h) => h.artifact)).not.toContain(run.artifact);
    expect(health.alert).toEqual({ level: "ok", reason: "ok" });
    // The legacy field is still there, and now means what it says: *some* upload
    // finished. It is not what the console reads as current protection.
    expect(health.cloudLastSuccessAt).not.toBeNull();
  });
});

describe("failure classification, retries and redaction", () => {
  it("retries a 503 SlowDown inside one call and still ends confirmed", async () => {
    await prepare();
    const run = await captureAndConfigure();
    behavior.put503 = 2;
    const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(result.status === "ok" ? "ok" : JSON.stringify(result)).toBe("ok");
    expect(putCount).toBe(3);
    expect(bucket.has(objectKeyFor(run.artifact))).toBe(true);
  });

  it("fails fast on 403 SignatureDoesNotMatch: no retry, a terminal row, a redacted message", async () => {
    await prepare();
    const run = await captureAndConfigure();
    behavior.put403 = true;
    const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    // One attempt, not five: a wrong signature cannot heal.
    expect(putCount).toBe(1);
    expect(result.retryable).toBe(false);
    expect(result.diagnostics.providerStatus).toBe(403);
    expect(result.diagnostics.code).toBe("SignatureDoesNotMatch");
    expect(result.diagnostics.phase).toBe("uploading");
    expect(result.diagnostics.attempts).toBe(1);
    expect(result.diagnostics.expectedBytes).toBeGreaterThan(0);
    // The attempt's own row id is the handle support quotes; it must be there and
    // must be the row the failure was written to.
    expect(result.diagnostics.runId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await scratch.query<{ id: string; status: string; error: string; diagnostics: unknown; attempt_phase: string }>(
      `SELECT id, status, error, diagnostics, attempt_phase FROM platform_backup_runs
        WHERE kind = 'cloud' AND artifact = $1 ORDER BY started_at DESC LIMIT 1`,
      [run.artifact],
    );
    expect(rows.rows[0].status).toBe("failed");
    expect(rows.rows[0].attempt_phase).toBe("uploading");
    expect((rows.rows[0] as { id: string }).id).toBe(result.diagnostics.runId);
    const diag = rows.rows[0].diagnostics as Record<string, unknown>;
    expect(diag.providerStatus).toBe(403);
    expect(diag.code).toBe("SignatureDoesNotMatch");
  });

  it("retries a destroyed socket, and the recorded diagnostics carry no key or signing material", async () => {
    await prepare();
    const run = await captureAndConfigure();
    behavior.resetNextPut = true;
    const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    // The mock resets only the first PUT; the ladder reopens the file and the
    // second attempt lands. That is the whole point of the fix for the live
    // `TypeError: fetch failed`: a transport failure is transient.
    expect(result.status === "ok" ? "ok" : JSON.stringify(result)).toBe("ok");
    expect(putCount).toBe(2);

    const everything = JSON.stringify(
      await scratch.query(`SELECT * FROM platform_backup_runs WHERE artifact = $1`, [run.artifact]),
    );
    // Nothing that could be replayed: no access key, no signature, no signed URL.
    expect(everything).not.toContain("test-secret");
    expect(everything).not.toContain("test-access");
    expect(everything).not.toContain("AWS4-HMAC-SHA256");
    expect(everything).not.toContain("Signature=");
    for (const auth of seenAuth) expect(auth).toContain("AWS4-HMAC-SHA256");
  });

  it("refuses a 200 over a truncated body: the PUT is not proof, the HEAD is", async () => {
    await prepare();
    const run = await captureAndConfigure();
    behavior.truncateNextPut = true;
    const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.diagnostics.phase).toBe("verifying");
    expect(result.error).toMatch(/verify_failed:object_size_mismatch/);
    // No confirmation was written for a body the bucket could not reproduce.
    const row = await scratch.query<{ cloud_verified_at: Date | null }>(
      `SELECT cloud_verified_at FROM platform_backup_runs WHERE kind = 'local' AND artifact = $1`,
      [run.artifact],
    );
    expect(row.rows[0].cloud_verified_at).toBeNull();

    const health = await svc.getPlatformBackupHealth();
    expect(health.cloud.currentConfirmed).toBe(false);
    expect(health.cloud.state).not.toBe("current");
    expect(health.alert.reason).toMatch(/^cloud_/);
  });

  it("re-downloads and hashes on request, and the sha256 mode records the stronger proof", async () => {
    await prepare();
    const run = await captureAndConfigure();
    const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null, { verify: "sha256" });
    expect(result.status === "ok" ? "ok" : JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.verifyMode).toBe("sha256");
    const local = await fs.readFile(path.join(svc.platformBackupDir(), run.artifact));
    const row = await scratch.query<{ cloud_verified_sha256: string; cloud_verify_mode: string }>(
      `SELECT cloud_verified_sha256, cloud_verify_mode FROM platform_backup_runs
        WHERE kind = 'local' AND artifact = $1`,
      [run.artifact],
    );
    expect(row.rows[0].cloud_verify_mode).toBe("sha256");
    expect(row.rows[0].cloud_verified_sha256).toBe(sha(local));
  });

  it("reports a confirmed object that retention has since deleted as history, not as protection", async () => {
    await prepare();
    const run = await captureAndConfigure();
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");
    // The provider's own retention (or another admin) removes the object while
    // our confirmation row still says it was there. The confirmation is only
    // worth what the bucket still lists.
    bucket.delete(objectKeyFor(run.artifact));

    const health = await svc.getPlatformBackupHealth();
    expect(health.cloud.currentConfirmed).toBe(false);
    expect(health.cloud.state).not.toBe("current");
    expect(health.cloud.latestConfirmedArtifact).toBeNull();
    expect(health.alert.level).toBe("error");
  });
});

describe("a crashed upload is recovered, and only one worker holds an artifact", () => {
  it("reclaims a `running` row whose lease has expired, then uploads", async () => {
    await prepare();
    const run = await captureAndConfigure({ enabled: false });
    // The shape the live deployment was stuck in: a cloud run left `running`,
    // started an hour ago, no lease (the old build never wrote one). Nothing but
    // a bounded age rule can tell this apart from a live transfer.
    const stuck = await scratch.query<{ id: string }>(
      `INSERT INTO platform_backup_runs
         (kind, trigger, status, artifact, attempt, started_at, lease_expires_at)
       VALUES ('cloud', 'scheduled', 'running', $1, 1, now() - interval '1 hour', NULL)
       RETURNING id`,
      [run.artifact],
    );
    // Cloud mirroring on, so a tick is allowed to act on it.
    await setConfig({ cloud: cloudConfig() });

    await svc.runPlatformBackupTick();

    const after = await scratch.query<{ id: string; status: string; error: string | null }>(
      `SELECT id, status, error FROM platform_backup_runs
        WHERE kind = 'cloud' AND artifact = $1 ORDER BY started_at DESC`,
      [run.artifact],
    );
    // Exactly one live answer for the artifact: the abandoned row is closed, and
    // a fresh attempt — if it ran — is a *different* row.
    const terminal = after.rows.find((r) => r.id === stuck.rows[0].id)!;
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toMatch(/lease_expired/);
    expect(bucket.has(objectKeyFor(run.artifact))).toBe(true);
    expect(after.rows.filter((r) => r.status === "running")).toHaveLength(0);
    // The history is preserved: the abandoned attempt is still there, with its
    // own reason, next to the run that replaced it.
    expect(after.rows.length).toBeGreaterThan(1);
  });

  it("refuses to start a second uploader of the same artifact from another instance", async () => {
    await prepare();
    const run = await captureAndConfigure();
    const { LOCK_KEYS, tryAcquireLock } = await import("../src/lib/db-locks");
    // Stand in for the other replica: hold the artifact's lock on a second
    // session, then ask this one to upload. A `busy` answer is the truth, and it
    // must not become a failure row the operator is told to retry.
    const held = await tryAcquireLock(LOCK_KEYS.platformCloudUpload(run.artifact));
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    try {
      const result = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
      expect(result).toEqual({ status: "busy", error: "upload_in_flight", retryAt: null });
      const rows = await scratch.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform_backup_runs WHERE kind = 'cloud' AND artifact = $1`,
        [run.artifact],
      );
      expect(Number(rows.rows[0].n)).toBe(0);
    } finally {
      await held.lock.release();
    }
    // …and with the lock released the same call goes through: `busy` is not a
    // permanent state.
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");
  });

  it("keeps retrying a spent ladder slowly instead of suppressing the artifact forever", async () => {
    await prepare();
    const run = await captureAndConfigure();
    // Eight finished failures inside the last minute: the ladder is spent.
    for (let i = 0; i < 8; i += 1) {
      await scratch.query(
        `INSERT INTO platform_backup_runs (kind, trigger, status, artifact, attempt, started_at, finished_at, error)
         VALUES ('cloud', 'scheduled', 'failed', $1, $2, now() - interval '2 minutes', now() - interval '2 minutes', 'NetworkError')`,
        [run.artifact, i + 1],
      );
    }
    const before = await svc.getPlatformBackupHealth();
    expect(before.cloud.retryExhausted).toBe(true);
    expect(before.cloud.state).toBe("failed");
    expect(before.cloud.nextAttemptAt).not.toBeNull();
    expect(before.alert.level).toBe("error");

    // The operator presses «تلاش دوباره»; the manual path ignores the backoff and
    // records a fresh attempt.
    const retried = await svc.retryPlatformCloudUpload(null, { artifact: run.artifact });
    expect(retried.status === "ok" ? "ok" : JSON.stringify(retried)).toBe("ok");
    const health = await svc.getPlatformBackupHealth();
    expect(health.cloud.state).toBe("current");
    // The ladder's counter is attempt *history*, not a verdict: a confirmed copy
    // is current no matter how many attempts it took, and the next artifact
    // starts from zero.
    expect(health.cloud.attempts).toBeGreaterThanOrEqual(8);
  });
});

describe("the historical object, the missing file, and the separate health lines", () => {
  it("labels a September object historical while the newest capture is local-only", async () => {
    await prepare();
    await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
    await setConfig({ cloud: cloudConfig() });
    const run = await svc.runPlatformLocalBackup("manual", null);
    if (run.status !== "ok") throw new Error("no artifact");
    // The live bucket's contents: a small old object from September, confirmed by
    // an old upload; today's capture never gets there because the destination
    // rejects it.
    const oldName = "pos-backup-20260913-094519.dump.enc";
    const oldBytes = Buffer.from("POSBKP1\\0september payload", "latin1");
    bucket.set(`${PREFIX}${oldName}`, oldBytes);
    await scratch.query(
      `INSERT INTO platform_backup_runs
         (kind, trigger, status, artifact, attempt, started_at, finished_at, size_bytes,
          cloud_verified_key, cloud_verified_at, cloud_verify_mode, cloud_verified_size)
       VALUES ('local', 'scheduled', 'success', $1, 1, now() - interval '55 days',
               now() - interval '55 days', $2, $3, now() - interval '55 days', 'size', $2)`,
      [oldName, oldBytes.byteLength, `${PREFIX}${oldName}`],
    );

    behavior.put403 = true;
    const failed = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(failed.status).toBe("failed");

    const health = await svc.getPlatformBackupHealth();
    expect(health.cloud.currentArtifact).toBe(run.artifact);
    expect(health.cloud.currentConfirmed).toBe(false);
    // One *deterministic* failure — a 403 is not transient — so the state is
    // terminal from the first attempt rather than "waiting to retry", while the
    // alert is red because the bucket holds September's copy, not today's.
    expect(health.cloud.state).toBe("failed");
    expect(health.cloud.latestConfirmedArtifact).toBe(oldName);
    expect(health.cloud.behindMs).toBeGreaterThan(50 * 24 * 60 * 60 * 1000);
    expect(health.cloud.historical.map((h) => h.artifact)).toContain(oldName);
    expect(health.cloud.retryExhausted).toBe(true);
    // The reason keeps the legacy vocabulary and tells the truth about the
    // failure: an upload was *attempted* and rejected. (How far behind the
    // confirmed copy is, is `behindMs` above — not a second reason code.)
    expect(health.alert).toEqual({ level: "error", reason: "cloud_failed" });
    expect(health.cloud.lastFailure?.message ?? "").toMatch(/403|SignatureDoesNotMatch/);
    // …and the old object is untouched: nothing prunes what we did not replace.
    expect(bucket.has(`${PREFIX}${oldName}`)).toBe(true);
  });

  it("shows a confirmed September copy as historical and keeps it after today's capture fails", async () => {
    await prepare();
    await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
    await setConfig({ cloud: cloudConfig() });
    // A confirmed copy, captured and verified 55 days ago, still in the bucket.
    const oldName = "pos-backup-20260913-094519.dump.enc";
    const oldBytes = Buffer.from("POSBKP1\\0september payload", "latin1");
    bucket.set(`${PREFIX}${oldName}`, oldBytes);
    await scratch.query(
      `INSERT INTO platform_backup_runs
         (kind, trigger, status, artifact, attempt, started_at, finished_at, size_bytes,
          cloud_verified_key, cloud_verified_at, cloud_verify_mode, cloud_verified_size)
       VALUES ('local', 'scheduled', 'success', $1, 1, now() - interval '55 days',
               now() - interval '55 days', $2, $3, now() - interval '55 days', 'size', $2)`,
      [oldName, oldBytes.byteLength, `${PREFIX}${oldName}`],
    );
    const run = await svc.runPlatformLocalBackup("manual", null);
    if (run.status !== "ok") throw new Error("no artifact");
    const uploaded = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(uploaded.status).toBe("ok");

    const health = await svc.getPlatformBackupHealth();
    // The newest capture is confirmed; September is history, listed as such and
    // not deleted by anything in this path.
    expect(health.cloud.state).toBe("current");
    expect(health.cloud.latestConfirmedArtifact).toBe(run.artifact);
    const historical = health.cloud.historical.map((h) => h.artifact);
    expect(historical).toContain(oldName);
    expect(historical).not.toContain(run.artifact);
    expect(bucket.has(`${PREFIX}${oldName}`)).toBe(true);
    expect(bucket.has(objectKeyFor(run.artifact))).toBe(true);
  });

  it("stops retrying an artifact whose file is gone, and keeps the older confirmed copy", async () => {
    await prepare();
    await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
    await setConfig({ cloud: cloudConfig() });
    // The older capture is on disk *and* confirmed off-site: the recovery point
    // that must survive everything below.
    const older = await svc.runPlatformLocalBackup("manual", null);
    if (older.status !== "ok") throw new Error("no artifact");
    expect((await svc.runPlatformCloudUpload(older.artifact, "manual", null)).status).toBe("ok");
    // Artifact names carry one-second resolution and a random run token, so two
    // captures in the same second could sort either way; a real capture cadence
    // never does this. Wait so "newest" is a fact, not a coin flip.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const newer = await svc.runPlatformLocalBackup("manual", null);
    if (newer.status !== "ok") throw new Error("no second artifact");
    expect(newer.artifact > older.artifact).toBe(true);

    // Today's capture exists in the history, then its file disappears — the
    // exact situation that produced a tight ENOENT retry loop.
    await fs.rm(path.join(svc.platformBackupDir(), newer.artifact), { force: true });
    const before = await svc.getPlatformBackupHealth();
    expect(before.cloud.localArtifactMissing).toBe(true);
    expect(before.cloud.missingArtifact).toBe(newer.artifact);
    expect(putCount).toBe(1);

    await svc.runPlatformBackupTick();
    const health = await svc.getPlatformBackupHealth();

    // Not retried: the artifact is honestly absent, and no PUT was made for it.
    expect(putCount).toBe(1);
    expect(health.cloud.localArtifactMissing).toBe(true);
    expect(health.cloud.state).toBe("pending");
    // An older confirmed copy exists, but it is not today's: the line stays red
    // and the gap is named rather than hidden.
    expect(health.alert.level).toBe("error");
    expect(health.cloud.currentArtifact).toBe(older.artifact);
    expect(health.cloud.currentConfirmed).toBe(true);
    expect(health.cloud.missingArtifact).toBe(newer.artifact);

    const missing = await scratch.query<{ local_missing_since: Date | null }>(
      `SELECT local_missing_since FROM platform_backup_runs WHERE kind = 'local' AND artifact = $1`,
      [newer.artifact],
    );
    expect(missing.rows[0].local_missing_since).toBeInstanceOf(Date);
    // The older artifact — and its confirmed object — survives untouched, and
    // the missing capture's own row is kept as history, not deleted.
    expect(bucket.has(objectKeyFor(older.artifact))).toBe(true);
    expect(await svc.listMissingLocalArtifacts()).toContain(newer.artifact);
    const kept = await scratch.query<{ status: string }>(
      `SELECT status FROM platform_backup_runs WHERE kind = 'local' AND artifact = $1`,
      [newer.artifact],
    );
    expect(kept.rows[0].status).toBe("success");
  });

  it("keeps the local, platform-cloud and tenant-managed lines apart in the MCP contract", async () => {
    await prepare();
    const run = await captureAndConfigure();
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");
    const mcp = await import("../src/lib/mcp/platform-mcp");
    const tools = new Map(mcp.PLATFORM_MCP_TOOLS.map((t) => [t.name, t]));
    // Both tools exist, with different capabilities: the platform-DR answer can
    // never be read as the fleet's per-business service (#903) or the reverse.
    expect(tools.get("get_backup_health")?.capability).toBe("backup.read");
    expect(tools.get("get_tenant_backup_service_health")?.capability).toBe("tenant_backup.read");
    expect(tools.get("get_backup_health")?.description).toContain("get_tenant_backup_service_health");

    const health = await svc.getPlatformBackupHealth();
    // The shape the split reads: local capture facts, cloud proof, reachability
    // and the alert are one answer; nothing about tenants is in it.
    expect(health.newestArtifact).toBe(run.artifact);
    expect(health.artifactsOnDisk).toBeGreaterThan(0);
    expect(health.cloud.state).toBe("current");
    expect(health.cloudReachable).toBe(true);
    expect(health.cloud.latestConfirmedAt).not.toBeNull();
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("test-secret");
    expect(serialized).not.toContain("correct horse battery");
  });

  it("never calls the bucket a success when it is unreachable", async () => {
    await prepare();
    const run = await captureAndConfigure();
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");
    // The endpoint is withdrawn (a wrong address, a firewall): the listing cannot
    // happen, and an empty list would read as "nothing is off-site" — the
    // opposite of the truth. `cloudReachable` is the distinction.
    await s3Server.close();
    const health = await svc.getPlatformBackupHealth();
    expect(health.cloudReachable).toBe(false);
    expect(health.cloud.state).not.toBe("current");
    expect(health.alert.level).toBe("error");
    // Back on the *same* port. `listen(0)` would hand out a fresh one and leave
    // the configured endpoint pointing at a dead address — every later test in
    // this file would then hang against it.
    s3Server = createServer(serveS3);
    const port = Number(new URL(endpoint).port);
    await new Promise<void>((resolve) => {
      s3Server.listen(port, "127.0.0.1", resolve);
    });
  }, 60_000);
});

/**
 * Issue #1296 P1 — "verify … a non-production restore drill" against the copy
 * that is actually off-site. Every other test in this file stops at "the bucket
 * holds the right bytes"; this one does the only thing that makes that claim mean
 * something: deletes the local file, restores *from the object*, into a scratch
 * database, and checks the rows came back.
 *
 * It is deliberately the harshest version of the drill — the source of truth is
 * gone from this server, so a passing run proves the bucket alone is a recovery
 * point. It writes to no production database: the restore engine builds
 * `<name>_restore_verify` and drops it (asserted), exactly as it does for a local
 * artifact in platform-system-backup.integration.test.ts.
 */
describe("a restore drill from the off-site copy", () => {
  it("restores from the bucket with the local file deleted, into a scratch database", async () => {
    await prepare();
    const run = await captureAndConfigure();
    const uploaded = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    expect(uploaded.status === "ok" ? "ok" : JSON.stringify(uploaded)).toBe("ok");
    if (uploaded.status !== "ok") return;

    // The one-machine failure this drill exists for: the artifact is only in the
    // bucket now. If the restore below passes, the off-site copy is a real
    // recovery point and not merely a 200 we once received.
    await fs.rm(path.join(svc.platformBackupDir(), run.artifact), { force: true });
    await expect(fs.stat(path.join(svc.platformBackupDir(), run.artifact))).rejects.toThrow();

    const live = await scratch.query<{ n: number }>("SELECT count(*)::int AS n FROM businesses");

    const res = await svc.restorePlatformFromPlan(
      {
        ok: true,
        source: "cloud",
        artifact: run.artifact,
        mode: "verify",
        objectKey: uploaded.key,
        peerId: null,
        url: null,
        // The stored passphrase is used when this is empty; passing it explicitly
        // proves the *object's* envelope is openable with the configured secret
        // and that nothing depended on the local file or sidecar.
        passphrase: "",
      },
      null,
    );
    expect(res.status === "verified" ? "verified" : JSON.stringify(res)).toBe("verified");
    if (res.status !== "verified") return;

    // The rows really came out of the bucket's object, and the scratch database
    // was dropped afterwards rather than left on the cluster.
    expect(res.summary.migrations).toBeGreaterThan(0);
    const businesses = res.summary.tables.find((t) => t.name === "businesses");
    expect(businesses?.rows).toBe(live.rows[0].n);

    const maintenance = new Client({ connectionString: urlFor("postgres") });
    await maintenance.connect();
    let leftovers: string[] = [];
    try {
      const q = await maintenance.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE $1",
        [`${databaseName}%`],
      );
      leftovers = q.rows.map((r) => r.datname).filter((name) => name !== databaseName);
    } finally {
      await maintenance.end();
    }
    expect(leftovers).toEqual([]);

    // …and the drill is recorded as a cloud-sourced verify, so an operator can
    // show an auditor which copy was proved and when.
    const restoreLog = await svc.listPlatformRestoreRuns(5);
    expect(restoreLog[0]?.status).toBe("success");
    expect(restoreLog[0]?.mode).toBe("verify");
    expect(restoreLog[0]?.source).toBe("cloud");
    expect(restoreLog[0]?.objectKey).toBe(uploaded.key);
  });

  it("refuses a bucket object that is not the bytes we confirmed, instead of restoring it", async () => {
    await prepare();
    const run = await captureAndConfigure();
    const uploaded = await svc.runPlatformCloudUpload(run.artifact, "manual", null);
    if (uploaded.status !== "ok") throw new Error("upload failed");
    // Something upstream rewrote the object after our confirmation (a bad
    // multipart join, an operator, another tool). A drill must fail, not restore
    // whatever happens to be at the key.
    bucket.set(uploaded.key, Buffer.from("POSBKP1\0tampered", "latin1"));

    const res = await svc.restorePlatformFromPlan(
      {
        ok: true,
        source: "cloud",
        artifact: run.artifact,
        mode: "verify",
        objectKey: uploaded.key,
        peerId: null,
        url: null,
        passphrase: "",
      },
      null,
    );
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    // Named, not generic: the operator has to know whether to re-upload or to
    // re-provision the bucket.
    expect(res.error).toMatch(/passphrase_required|decrypt|truncated|corrupt|invalid|bad_magic|checksum/i);
    const log = await svc.listPlatformRestoreRuns(3);
    expect(log[0]?.status).toBe("failed");
  });
});

/**
 * Issue #1296's first acceptance criterion is about *size*: the artifact that
 * failed was 319 067 831 bytes. Everything else in this file runs on a stub dump
 * of ~120 KB, which cannot show that the streaming path, the size-derived
 * timeout, or the lease arithmetic behave at the scale the incident actually hit.
 *
 * The file below is written directly (a deterministic 64 MiB body, gzip-skipped)
 * rather than through `pg_dump`, because the thing being proved is the transfer
 * and the proof-after-transfer, not the dump. 64 MiB is the largest artifact this
 * sandbox can stream a few times in a test without turning CI red for the wrong
 * reason; the bytes:timeout ratio it exercises is the same one that produced a
 * 320 s budget for the live upload.
 */
describe("a large artifact at the scale of the incident", () => {
  /**
   * Issue #1296's acceptance criterion names a 319 MB artifact. CI runs the
   * default 64 MiB because streaming 320 MB several times would dominate the
   * job; but the *criterion* is about size, so the size is a dial rather than a
   * constant:
   *
   *     LARGE_ARTIFACT_MIB=320 npm run test:db -- \
   *       integration/platform-backup-cloud.integration.test.ts
   *
   * runs the identical code path — the real 320 s size-derived timeout, the
   * lease arithmetic it feeds, the streaming hash and the post-upload proof — at
   * the scale the incident actually hit. That is the command to run on a host
   * with real object storage before calling the criterion met; it cannot be
   * satisfied by a mock alone.
   */
  const LARGE_MIB = Math.max(1, Number(process.env.LARGE_ARTIFACT_MIB) || 64);

  it(`streams ${LARGE_MIB} MiB, proves it by size and by sha256, and stays within one lease`, async () => {
    await prepare();
    await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
    await setConfig({ cloud: cloudConfig() });

    // Artifact-shaped name so every guard in the path accepts it; the body is
    // filler that the upload path treats exactly like a real ciphertext.
    const artifact = "pos-backup-20261107-060247-7e2e5bb6.dump.enc";
    const largePath = path.join(svc.platformBackupDir(), artifact);
    // The body starts with the backup envelope's magic, exactly as a real
    // `.dump.enc` does. That matters twice: the uploader must recognise an
    // already-encrypted artifact and stream it verbatim (a plaintext body would
    // be encrypted first, adding the ~52-byte envelope and making this test
    // measure the wrong thing), and it is the same first-bytes check that keeps
    // a plaintext dump out of the bucket.
    const CHUNK = 1024 * 1024;
    const handle = await fs.open(largePath, "w");
    try {
      let written = 0;
      for (let i = 0; i < LARGE_MIB; i += 1) {
        const chunk = Buffer.alloc(CHUNK, 0x5a);
        if (i === 0) Buffer.from("POSBKP1\0", "latin1").copy(chunk, 0);
        await handle.write(chunk);
        written += CHUNK;
      }
      expect(written).toBe(LARGE_MIB * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const bytes = await fs.stat(largePath);
    expect(bytes.size).toBe(LARGE_MIB * 1024 * 1024);
    const localHash = await (async () => {
      const hash = createHash("sha256");
      const h = await fs.open(largePath, "r");
      const buf = Buffer.alloc(1024 * 1024);
      try {
        for (;;) {
          const { bytesRead } = await h.read(buf, 0, buf.length, null);
          if (bytesRead === 0) break;
          hash.update(buf.subarray(0, bytesRead));
        }
      } finally {
        await h.close();
      }
      return hash.digest("hex");
    })();

    const startedAt = Date.now();
    const result = await svc.runPlatformCloudUpload(artifact, "manual", null, { verify: "sha256" });
    const elapsed = Date.now() - startedAt;

    expect(result.status === "ok" ? "ok" : JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sizeBytes).toBe(bytes.size);
    expect(result.verifyMode).toBe("sha256");

    // The bucket holds every byte, and the confirmation on the local row carries
    // the *whole-file* hash — the claim that matters when the artifact is
    // hundreds of megabytes and a size check alone would pass on a bad join.
    const stored = bucket.get(result.key);
    expect(stored?.byteLength).toBe(bytes.size);
    expect(sha(stored!)).toBe(localHash);
    const row = await scratch.query<{ cloud_verified_size: string; cloud_verified_sha256: string; lease_expires_at: Date | null }>(
      `SELECT cloud_verified_size, cloud_verified_sha256, lease_expires_at FROM platform_backup_runs
        WHERE kind = 'local' AND artifact = $1`,
      [artifact],
    );
    expect(Number(row.rows[0].cloud_verified_size)).toBe(bytes.size);
    expect(row.rows[0].cloud_verified_sha256).toBe(localHash);
    // The lease is released when the attempt finishes: a successful row must not
    // leave a future lease that would make the next tick think work is in flight.
    expect(row.rows[0].lease_expires_at).toBeNull();

    // And the tenant-wide claim the issue asks for: the 64 MiB capture is the
    // *current confirmed* one, not merely "an upload succeeded".
    const health = await svc.getPlatformBackupHealth();
    expect(health.cloud.state).toBe("current");
    expect(health.cloud.currentArtifact).toBe(artifact);
    expect(health.cloud.currentSizeBytes).toBe(bytes.size);
    expect(health.cloud.latestVerifyMode).toBe("sha256");

    // A generous ceiling: this is a loopback mock. What it catches is a path that
    // silently buffers or re-reads the file many times, not network slowness.
    expect(elapsed).toBeLessThan(120_000);
  }, 180_000);
});

/**
 * The identity gap the large-artifact test uncovered: an artifact can be on disk
 * with no run row — copied in from a USB stick, restored after a rebuild, or
 * written before `platform_backup_runs` existed. `listPlatformLocalArtifacts`
 * already calls such a file a real backup, so an upload that the provider proved
 * must be recorded *somewhere*, or the console reports "never off-site" about a
 * copy that is demonstrably off-site.
 */
describe("an artifact with no run row still earns its confirmation", () => {
  it("backfills an identity row for a verified upload, and says it is a backfill", async () => {
    await prepare();
    await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
    await setConfig({ cloud: cloudConfig() });

    // Put a valid encrypted artifact straight into the directory: no run, no
    // sidecar, nothing but bytes — exactly what an operator's USB restore leaves.
    const artifact = "pos-backup-20261001-030000-abcdef01.dump.enc";
    const body = Buffer.concat([Buffer.from("POSBKP1\0", "latin1"), Buffer.alloc(4096, 9)]);
    await fs.writeFile(path.join(svc.platformBackupDir(), artifact), body);

    const before = await svc.getPlatformBackupHealth();
    expect(before.cloud.state).not.toBe("current");

    const uploaded = await svc.runPlatformCloudUpload(artifact, "manual", null);
    expect(uploaded.status === "ok" ? "ok" : JSON.stringify(uploaded)).toBe("ok");

    const rows = await scratch.query<{
      kind: string;
      trigger: string;
      status: string;
      size_bytes: string;
      sha256: string;
      manifest: Record<string, unknown>;
      cloud_verified_at: Date | null;
      cloud_verified_size: string | null;
    }>(
      `SELECT kind, trigger, status, size_bytes, sha256, manifest, cloud_verified_at, cloud_verified_size
         FROM platform_backup_runs WHERE artifact = $1 ORDER BY started_at DESC`,
      [artifact],
    );
    const local = rows.rows.find((r) => r.kind === "local");
    expect(local?.status).toBe("success");
    expect(local?.trigger).toBe("manual");
    expect(Number(local?.size_bytes)).toBe(body.byteLength);
    expect(local?.sha256).toBe(sha(body));
    // Honest history: the row exists so the proof has a home, and it says so
    // rather than claiming a dump ran when none did.
    expect(local?.manifest.identityBackfilled).toBe(true);
    expect(local?.cloud_verified_at).toBeInstanceOf(Date);
    expect(Number(local?.cloud_verified_size)).toBe(body.byteLength);

    const after = await svc.getPlatformBackupHealth();
    expect(after.cloud.state).toBe("current");
    expect(after.cloud.currentConfirmed).toBe(true);
    expect(after.cloud.currentArtifact).toBe(artifact);
  });

  it("reuses the existing row instead of inventing a second identity", async () => {
    await prepare();
    await setConfig({ enabled: true, encryptLocal: true, passphrase: "correct horse battery", localRetention: 5 });
    await setConfig({ cloud: cloudConfig() });
    const run = await captureAndConfigure();
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");
    // A second verified upload of the same artifact (an operator pressing the
    // button again) must land on the same local row, not a duplicate.
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null, { verify: "sha256" })).status).toBe("ok");
    const rows = await scratch.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform_backup_runs WHERE kind = 'local' AND artifact = $1`,
      [run.artifact],
    );
    expect(Number(rows.rows[0].n)).toBe(1);
    const confirmations = await svc.listCloudConfirmations();
    expect(confirmations.filter((c) => c.artifact === run.artifact)).toHaveLength(1);
  });
});

describe("proving the off-site copy without uploading (issue #1296 follow-up)", () => {
  /**
   * The console's only way to ask "is the object still there, and is it still
   * ours?" used to be the retry button, which also *uploads*. That is the wrong
   * shape for an MCP tool: an assistant should be able to verify without
   * spending egress, and an operator checking a month-old artifact should not
   * re-send it. `verifyPlatformCloudObject` is the read-only half, and these
   * tests pin the three answers that matter — verified, missing, corrupt.
   */
  it("proves the newest capture by HEAD and by sha256, and writes no new row", async () => {
    await prepare();
    const run = await captureAndConfigure();
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");

    const countRuns = async () => {
      const { rows } = await scratch.query<{ n: string }>("SELECT count(*)::text AS n FROM platform_backup_runs");
      return Number(rows[0]!.n);
    };
    const before = await countRuns();

    const bySize = await svc.verifyPlatformCloudObject({ mode: "size" });
    expect(bySize.status).toBe("verified");
    expect(bySize.artifact).toBe(run.artifact);
    expect(bySize.verifyMode).toBe("size");
    expect(bySize.sizeBytes).toBeGreaterThan(0);
    expect(bySize.sha256).toBeNull();
    expect(bySize.reason).toBeNull();

    // sha256 downloads the object and compares it with the local file.
    const byHash = await svc.verifyPlatformCloudObject({ mode: "sha256" });
    expect(byHash.status).toBe("verified");
    expect(byHash.verifyMode).toBe("sha256");
    expect(byHash.sha256).toMatch(/^[0-9a-f]{64}$/);
    // …and it is the same digest the upload recorded, so the two proofs agree.
    const localPath = path.join(process.env.PLATFORM_BACKUP_DIR!, run.artifact);
    const local = sha(await fs.readFile(localPath));
    expect(byHash.sha256).toBe(local);

    // Neither call may change the history: verification is an observation, and a
    // row per glance would drown the attempts that matter.
    expect(await countRuns()).toBe(before);
  });

  it("separates a missing object from a corrupt one", async () => {
    await prepare();
    const run = await captureAndConfigure();
    expect((await svc.runPlatformCloudUpload(run.artifact, "manual", null)).status).toBe("ok");

    // Overwrite the object with different bytes of a different length: the HEAD
    // still finds it, so this is a mismatch, not a disappearance.
    const key = objectKeyFor(run.artifact);
    bucket.set(key, Buffer.from("not the artifact you uploaded"));

    const corrupt = await svc.verifyPlatformCloudObject({ artifact: run.artifact, mode: "sha256" });
    expect(corrupt.status).toBe("mismatch");
    expect(corrupt.reason).toBeTruthy();
    // Still redacted: no key, no endpoint, no credentials in the answer.
    const serialized = JSON.stringify(corrupt);
    expect(serialized).not.toContain("test-secret");
    expect(serialized).not.toContain("127.0.0.1");

    // Delete it outright: "no copy" is a different, less alarming answer.
    bucket.delete(key);
    const missing = await svc.verifyPlatformCloudObject({ artifact: run.artifact, mode: "size" });
    expect(missing.status).toBe("missing");
    expect(missing.reason).toBe("object_not_found");
  });

  it("says so plainly when the platform has no cloud destination or no artifact", async () => {
    await prepare();
    const noArtifact = await svc.verifyPlatformCloudObject({});
    expect(noArtifact.status).toBe("unavailable");
    expect(noArtifact.reason).toBe("no_local_artifact");

    await captureAndConfigure();
    const unknown = await svc.verifyPlatformCloudObject({ artifact: "pos-backup-19990101-000000-deadbeef.dump.enc" });
    expect(unknown.status).toBe("unavailable");
    expect(unknown.reason).toBe("artifact_not_found");
  });

  it("is exposed as a read-only MCP tool under backup.verify, not backup.run", async () => {
    const mcp = await import("../src/lib/mcp/platform-mcp");
    const tools = new Map(mcp.PLATFORM_MCP_TOOLS.map((t) => [t.name, t]));
    const tool = tools.get("verify_backup_cloud_object");
    expect(tool).toBeDefined();
    // The capability is the distinction that matters: `backup.run` may start a
    // transfer, `backup.verify` may only look.
    expect(tool!.capability).toBe("backup.verify");
    expect(tool!.bridged).toBe(false);
    // Not a step-up: looking at bytes we already own is not a destructive act.
    expect(tool!.stepUp).toBeFalsy();
    expect(tool!.inputSchema.properties.verify?.enum).toEqual(["size", "sha256"]);
    // The description has to say the retry stays console-side, or someone will
    // read this tool as "retry from the assistant".
    expect(tool!.description).toContain("never starts an upload");
  });
});
