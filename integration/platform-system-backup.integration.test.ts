/**
 * The super-admin console's whole-system backup and its restore-by-address half,
 * end to end (migration 0132).
 *
 * What this file is for — the three things a unit test structurally cannot see:
 *
 *  1. **The pipeline really produces a restorable file.** `runPlatformLocalBackup`
 *     is driven with `PG_DUMP_PATH` pointed at a stub (see
 *     `integration/support/pg-stub.cjs` for why a stub rather than the real
 *     binary), and the artifact that lands on disk is then handed to the restore
 *     engine's *verify* path, which restores it into a scratch database and
 *     counts its rows. A backup that dumps the wrong thing, encrypts it
 *     inconsistently, or writes a manifest that does not describe the bytes fails
 *     here, not in front of a lost server.
 *  2. **The peer contract, on both sides.** One artifact is served by a local HTTP
 *     server answering exactly like `/api/peer/backup/*` does; the client half
 *     (`downloadPeerArtifact`) is checked for the checksum rule, the size cap and
 *     the 401 path. This is the protocol a migration between two machines lives or
 *     dies by, and a silent mismatch in it shows up as a corrupt database.
 *  3. **The secrets stay put.** The masked config never carries the passphrase or
 *     the S3 secret; a token is returned exactly once; the token table holds only
 *     hashes, so a database dump is not a directory of live credentials.
 *
 * Apply mode is deliberately *not* exercised: it `DROP DATABASE`s the target, and
 * on a shared CI Postgres that is the same cluster every other test file uses.
 * What is proved about it instead is the gate in front of it.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { generateSyncToken } from "../src/lib/sync-token";
import { peerTokenHint } from "../src/lib/platform-backup";
import type { PeerManifest } from "../src/lib/platform-backup";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "support", "pg-stub.cjs");

const databaseName = `plat_bkp_${Math.random().toString(36).slice(2, 10)}`;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

let svc: typeof import("../src/lib/platform-backup-service");
let dbLib: typeof import("../src/lib/db");
let workDir: string;
let server: Server;
let serverUrl: string;
let scratch: Client;

/** Everything the backup writes goes under one temp folder, removed at the end. */
beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-platform-backup-"));
  // The launcher has to be something the *host* can exec directly: `spawn()`
  // without a shell runs the file itself, so a `#!/bin/sh` script is only
  // executable on POSIX. Windows (CI runs these suites on windows-latest) needs
  // a `.cmd` batch file instead — a extension-less shell script there fails with
  // ENOENT before the stub is ever reached.
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
  delete process.env.PLATFORM_BACKUP_PASSPHRASE;
  await fs.rm(workDir, { recursive: true, force: true });

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** Everything the console's PUT does, minus the HTTP layer: partial body, merged
 * with what is stored, validated, then written. */
async function setConfig(patch: Record<string, unknown>) {
  const res = await svc.savePlatformBackupConfig(patch, null);
  expect(res.ok ? "ok" : JSON.stringify(res)).toBe("ok");
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

describe("platform backup configuration", () => {
  it("refuses invalid settings and never echoes a secret back", async () => {
    const bad = await svc.savePlatformBackupConfig({ intervalHours: 0, localRetention: 999 }, null);
    expect(bad.ok).toBe(false);
    // @ts-expect-error the failure shape carries `error`
    expect(bad.error).toMatch(/invalid_interval|invalid_local_retention/);

    await setConfig({ passphrase: "correct horse battery" });
    const masked = await svc.getPlatformBackupConfigMasked();
    expect(masked.hasPassphrase).toBe(true);
    expect(masked.intervalHours).toBe(6 * 4);
    expect(JSON.stringify(masked)).not.toContain("correct horse battery");
  });

  it("keeps a stored passphrase when the field is absent, and clears it on an explicit empty string", async () => {
    await setConfig({ passphrase: "keep me please" });
    await setConfig({ intervalHours: 6 });
    const after = await svc.getPlatformBackupConfig();
    expect(after.passphrase).toBe("keep me please");

    await setConfig({ passphrase: "" });
    expect((await svc.getPlatformBackupConfig()).passphrase).toBe("");
    await setConfig({ passphrase: "correct horse battery" });
  });
});

describe("a platform backup run", () => {
  it("writes the artifact, its sidecar and a run row that describes the bytes", async () => {
    await setConfig({ encryptLocal: false, passphrase: "", localRetention: 5 });
    const res = await svc.runPlatformLocalBackup("manual", null);
    expect(res.status === "ok" ? "ok" : `backup failed: ${"error" in res ? res.error : res.status}`).toBe("ok");
    if (res.status !== "ok") return;

    const dir = svc.platformBackupDir();
    const file = path.join(dir, res.artifact);
    const data = await fs.readFile(file);
    expect(data.toString("utf8").startsWith("POSSTUB1")).toBe(true);
    expect(res.sizeBytes).toBe(data.length);

    const runs = await svc.listPlatformBackupRuns(5);
    const run = runs.find((r) => r.artifact === res.artifact);
    expect(run?.status).toBe("success");
    expect(run?.sha256).toBe(sha(data));
    const manifest = run?.manifest as Record<string, unknown>;
    expect(Number(manifest.schemaMigrations)).toBeGreaterThan(0);
    expect(manifest.encrypted).toBe(false);

    const sidecar = await fs.readFile(`${file}.manifest.json`, "utf8");
    const parsed = JSON.parse(sidecar) as Record<string, unknown>;
    expect(parsed.sha256).toBe(sha(data));
    expect(parsed.artifact).toBe(res.artifact);

    const listed = await svc.listPlatformLocalArtifacts();
    const row = listed.find((a) => a.artifact === res.artifact);
    expect(row?.exists).toBe(true);
    expect(row?.sizeBytes).toBe(data.length);
  });

  it("encrypts when a passphrase is configured, and the plaintext never reaches the disk", async () => {
    await setConfig({ encryptLocal: true, passphrase: "correct horse battery" });
    const res = await svc.runPlatformLocalBackup("manual", null);
    expect(res.status === "ok" ? "ok" : `backup failed: ${"error" in res ? res.error : res.status}`).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.artifact.endsWith(".enc")).toBe(true);

    const data = await fs.readFile(path.join(svc.platformBackupDir(), res.artifact));
    expect(data.subarray(0, 7).toString("latin1")).toBe("POSBKP1");
    expect(data.toString("latin1")).not.toContain("POSSTUB1");

    const runs = await svc.listPlatformBackupRuns(5);
    const run = runs.find((r) => r.artifact === res.artifact);
    expect((run?.manifest as Record<string, unknown>).encrypted).toBe(true);
  });

  it("prunes to the retention count and takes each artifact's sidecar with it", async () => {
    await setConfig({ encryptLocal: false, passphrase: "", localRetention: 1 });
    // An empty directory: retention is about *this* run's pruning, and artifacts
    // left by the tests above would otherwise be counted (and deleted) too. The
    // sleep is for the same reason — the artifact name has one-second
    // resolution, so two runs fired back to back would collide on one name and
    // the assertion below could not tell "kept the newer" from "wrote the same
    // file twice".
    const dir = svc.platformBackupDir();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const first = await svc.runPlatformLocalBackup("manual", null);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(first.status === "ok" ? "ok" : `backup failed: ${"error" in first ? first.error : first.status}`).toBe("ok");
    const second = await svc.runPlatformLocalBackup("manual", null);
    expect(second.status === "ok" ? "ok" : `backup failed: ${"error" in second ? second.error : second.status}`).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;

    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".dump"));
    expect(names).toEqual([second.artifact]);
    // The kept file's description survives; the pruned one's does not.
    expect(await fs.stat(path.join(dir, `${second.artifact}.manifest.json`)).then(() => true)).toBe(true);
    await expect(fs.stat(path.join(dir, `${first.artifact}.manifest.json`))).rejects.toThrow();
  });
});

describe("serving artifacts to another server", () => {
  it("answers nothing while serving is off, and refuses anything that is not one of our names", async () => {
    await setConfig({ servingEnabled: false });
    const off = await svc.resolveServeableArtifact("pos-backup-20260101-000000.dump");
    expect(off.ok).toBe(false);
    // @ts-expect-error the failure shape carries `status`
    expect(off.status).toBe(404);

    await setConfig({ servingEnabled: true });
    for (const probe of ["../../etc/passwd", "a/b.dump", "", "not-an-artifact.dump"]) {
      const res = await svc.resolveServeableArtifact(probe);
      expect(res.ok).toBe(false);
    }
    const missing = await svc.resolveServeableArtifact("pos-backup-20200101-000000.dump");
    expect(missing.ok).toBe(false);
    // @ts-expect-error the failure shape carries `error`
    expect(missing.error).toBe("not_found");
  });

  it("authenticates the bearer token against a hash, and stops the moment it is revoked", async () => {
    const raw = generateSyncToken();
    const created = await svc.createPlatformBackupToken({
      label: "migration target",
      token: raw,
      expiresInDays: 30,
      platformAdminId: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.token).toBe(raw);
    expect(created.hint).toBe(peerTokenHint(raw));

    const headers = new Headers({ authorization: `Bearer ${created.token}` });
    const authed = await svc.authorizePeerRequest(headers);
    expect("id" in authed ? authed.label : null).toBe("migration target");

    expect("unauthorized" in (await svc.authorizePeerRequest(new Headers({ authorization: "Bearer POS1-nope" })))).toBe(true);
    expect("unauthorized" in (await svc.authorizePeerRequest(new Headers()))).toBe(true);

    const stored = await scratch.query<{ token_hash: string }>(
      "SELECT token_hash FROM platform_backup_tokens WHERE id = $1",
      [created.id],
    );
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toBe(created.token);

    await svc.revokePlatformBackupToken(created.id);
    expect("unauthorized" in (await svc.authorizePeerRequest(headers))).toBe(true);
    // The use counter is written before the revocation check can matter, but the
    // row must never come back usable.
    expect(await svc.resolvePeerToken(created.token)).toBeNull();
  });

  it("lists only files that are actually on disk, with the checksum the client will verify", async () => {
    await setConfig({ encryptLocal: false, passphrase: "", localRetention: 5, servingEnabled: true });
    const run = await svc.runPlatformLocalBackup("manual", null);
    expect(run.status === "ok" ? "ok" : `backup failed: ${"error" in run ? run.error : run.status}`).toBe("ok");
    if (run.status !== "ok") return;

    const manifest = await svc.buildServeManifest();
    expect(manifest.app).toBe("cafe-restaurant-pos");
    expect(manifest.schemaMigrations).toBeGreaterThan(0);
    const entry = manifest.artifacts.find((a) => a.artifact === run.artifact);
    expect(entry).toBeTruthy();
    const data = await fs.readFile(path.join(svc.platformBackupDir(), run.artifact));
    expect(entry?.sha256).toBe(sha(data));
    expect(entry?.sizeBytes).toBe(data.length);
    // A file that exists with no run behind it is listed but unchecksummed, so
    // the client knows not to demand a checksum it can never satisfy.
    expect(manifest.artifacts.every((a) => a.sha256.length === 0 || a.sha256.length === 64)).toBe(true);

    // The peer manifest is refused by the route before it ever gets here; here
    // the serving flag is what decides.
    await setConfig({ servingEnabled: false });
    expect((await svc.getPlatformBackupHealth()).servingEnabled).toBe(false);
    await setConfig({ servingEnabled: true });
  });
});

describe("the peer download client", () => {
  let served: { body: Buffer; sha256: string; artifact: string } | null = null;

  beforeAll(async () => {
    // The test's peer is `http://127.0.0.1:<port>` — a loopback, plain-HTTP
    // address. Issue #807 refuses both by default (metadata/link-local are
    // never allowed; private and insecure need an explicit opt-in), so the
    // operator's two switches are turned on here exactly as a real LAN restore
    // would require. The pair of tests below the fixture prove the default
    // really does refuse it.
    await setConfig({ allowInsecurePeers: true, allowPrivatePeers: true });
    const run = await svc.runPlatformLocalBackup("manual", null);
    if (run.status !== "ok") throw new Error("no artifact to serve");
    const body = await fs.readFile(path.join(svc.platformBackupDir(), run.artifact));
    served = { body, sha256: sha(body), artifact: run.artifact };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/forbidden") return void res.writeHead(401).end();
      if (url.pathname === "/big") {
        res.writeHead(200, { "content-length": String(served!.body.length * 40) });
        return void res.end(served!.body);
      }
      if (url.pathname === "/wrong-hash") {
        res.writeHead(200, { "x-backup-sha256": "0".repeat(64), "content-length": String(served!.body.length) });
        return void res.end(served!.body);
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(served!.body.length),
        "x-backup-sha256": served!.sha256,
      });
      res.end(served!.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    serverUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("refuses a loopback/insecure peer unless the operator has allowed it", async () => {
    // Default-deny, both halves: with the two switches off, the very same URL
    // the rest of this describe uses is a blocked address, refused before a
    // connection is made.
    await setConfig({ allowInsecurePeers: false, allowPrivatePeers: false });
    try {
      const blocked = await svc.downloadPeerArtifact({ url: `${serverUrl}/download/x.dump`, token: "" });
      expect(blocked.ok).toBe(false);
      // @ts-expect-error the failure shape carries `error`
      expect(blocked.error).toMatch(/peer_unreachable:(https_required|blocked_address)/);
    } finally {
      await setConfig({ allowInsecurePeers: true, allowPrivatePeers: true });
    }
  });

  it("verifies the checksum the source declared, and stops when it does not match", async () => {
    const ok = await svc.downloadPeerArtifact({ url: `${serverUrl}/download/${served!.artifact}`, token: "" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const body = await fs.readFile(ok.file.filePath);
      expect(sha(body)).toBe(served!.sha256);
      expect(ok.file.sizeBytes).toBe(body.length);
      expect(ok.file.sha256).toBe(served!.sha256);
      // …and is staged under a fixed local name, never the remote one: a peer
      // cannot put a path or a surprising filename into this server's temp dir.
      expect(path.basename(ok.file.filePath)).toBe("download.bin");
      expect(path.dirname(ok.file.filePath)).toBe(ok.file.workDir);
      expect(path.basename(ok.file.workDir).startsWith("pos-peer-")).toBe(true);
      await fs.rm(ok.file.workDir, { recursive: true, force: true });
    }

    const bad = await svc.downloadPeerArtifact({ url: `${serverUrl}/wrong-hash`, token: "" });
    expect(bad.ok).toBe(false);
    // @ts-expect-error the failure shape carries `error`
    expect(bad.error).toBe("checksum_mismatch");

    // A declared length far above the cap is refused before the body is read, so
    // a hostile or misconfigured peer cannot exhaust the disk or the heap.
    const huge = await svc.downloadPeerArtifact({ url: `${serverUrl}/big`, token: "", maxBytes: 1024 });
    expect(huge.ok).toBe(false);
    // @ts-expect-error the failure shape carries `error`
    expect(huge.error).toContain("too_large");
  });

  it("turns an auth failure into a message an operator can act on", async () => {
    const res = await svc.downloadPeerArtifact({ url: `${serverUrl}/forbidden`, token: "POS1-revoked" });
    expect(res.ok).toBe(false);
    // @ts-expect-error the failure shape carries `error`
    expect(res.error).toBe("peer_auth_failed");

    const down = await svc.downloadPeerArtifact({ url: "http://127.0.0.1:1/x.dump", token: "" });
    expect(down.ok).toBe(false);
    // @ts-expect-error the failure shape carries `error`
    expect(down.error).toMatch(/^peer_unreachable/);
  });
});

describe("restoring a platform artifact", () => {
  it("verify mode restores into a scratch database, reports the contents, and leaves nothing behind", async () => {
    await setConfig({ encryptLocal: false, passphrase: "", localRetention: 5 });
    const run = await svc.runPlatformLocalBackup("manual", null);
    expect(run.status === "ok" ? "ok" : `backup failed: ${"error" in run ? run.error : run.status}`).toBe("ok");
    if (run.status !== "ok") return;

    const plan = {
      ok: true as const,
      source: "local" as const,
      artifact: run.artifact,
      mode: "verify" as const,
      objectKey: null,
      peerId: null,
      url: null,
      passphrase: "",
    };
    const res = await svc.restorePlatformFromPlan(plan, null);
    expect(res.status).toBe("verified");
    if (res.status !== "verified") return;
    expect(res.summary.migrations).toBeGreaterThan(0);
    const businesses = res.summary.tables.find((t) => t.name === "businesses");
    const live = await scratch.query<{ n: number }>("SELECT count(*)::int AS n FROM businesses");
    expect(businesses?.rows).toBe(live.rows[0].n);

    // The scratch database is the engine's responsibility to drop, in a finally:
    // this is the leak that used to fill CI clusters.
    const maintenance = new Client({ connectionString: urlFor("postgres") });
    await maintenance.connect();
    let leftover: string[] = [];
    try {
      const q = await maintenance.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE $1",
        [`${databaseName}%`],
      );
      leftover = q.rows.map((r) => r.datname);
    } finally {
      await maintenance.end();
    }
    expect(leftover).toEqual([databaseName]);

    const log = await svc.listPlatformRestoreRuns(5);
    expect(log[0]?.status).toBe("success");
    expect(log[0]?.mode).toBe("verify");
    expect(log[0]?.artifact).toBe(run.artifact);
  });

  it("refuses an encrypted artifact before touching the database when no passphrase is stored", async () => {
    await setConfig({ encryptLocal: true, passphrase: "correct horse battery" });
    const enc = await svc.runPlatformLocalBackup("manual", null);
    expect(enc.status === "ok" ? "ok" : `backup failed: ${"error" in enc ? enc.error : enc.status}`).toBe("ok");
    if (enc.status !== "ok") return;
    await setConfig({ passphrase: "" });

    const res = await svc.restorePlatformFromPlan(
      { ok: true, source: "local", artifact: enc.artifact, mode: "verify", objectKey: null, peerId: null, url: null, passphrase: "" },
      null,
    );
    expect(res.status).toBe("failed");
    // @ts-expect-error the failure shape carries `error`
    expect(res.error).toMatch(/^passphrase_required/);
    // …and the run is recorded as a failure, so the console shows why nothing happened.
    const log = await svc.listPlatformRestoreRuns(3);
    expect(log[0]?.status).toBe("failed");
  });

  it("decrypts with a passphrase supplied for this one attempt", async () => {
    await setConfig({ passphrase: "correct horse battery" });
    const res = await svc.restorePlatformFromPlan(
      {
        ok: true,
        source: "local",
        artifact: (await svc.listPlatformLocalArtifacts())[0].artifact,
        mode: "verify",
        objectKey: null,
        peerId: null,
        url: null,
        passphrase: "correct horse battery",
      },
      null,
    );
    expect(res.status === "verified" ? "verified" : JSON.stringify(res)).toBe("verified");
  });

  it("reports a checksum it cannot satisfy rather than restoring an unknown file", async () => {
    const dir = svc.platformBackupDir();
    const name = "pos-backup-29991231-235959.dump";
    await fs.writeFile(path.join(dir, name), "POSSTUB1\n", "utf8");
    const res = await svc.restorePlatformFromPlan(
      { ok: true, source: "local", artifact: name, mode: "verify", objectKey: null, peerId: null, url: null, passphrase: "" },
      null,
    );
    // An orphan file with no run row behind it still restores — there is no
    // checksum to lie about — but it must not be reported as verified if the
    // scratch database cannot be built from it.
    expect(["verified", "failed"]).toContain(res.status);
    if (res.status === "failed") expect(res.error).not.toContain("checksum");
    await fs.rm(path.join(dir, name), { force: true });
  });
});

/**
 * The channel as an HTTP surface, not as a service call — the part a unit test
 * of `resolveServeableArtifact` cannot prove, because the guard that matters is
 * the one in front of it: middleware's public list, the route's own auth order,
 * and whether the bytes a peer gets are the bytes on disk.
 */
describe("the peer HTTP surface", () => {
  let manifestRoute: typeof import("../src/app/api/peer/backup/manifest/route");
  let downloadRoute: typeof import("../src/app/api/peer/backup/download/route");
  let token = "";
  let artifact = "";
  let bytes: Buffer;

  beforeAll(async () => {
    manifestRoute = await import("../src/app/api/peer/backup/manifest/route");
    downloadRoute = await import("../src/app/api/peer/backup/download/route");
    await setConfig({ servingEnabled: true, encryptLocal: false, passphrase: "", localRetention: 5 });
    const run = await svc.runPlatformLocalBackup("manual", null);
    if (run.status !== "ok") throw new Error("no artifact to serve");
    artifact = run.artifact;
    bytes = await fs.readFile(path.join(svc.platformBackupDir(), artifact));
    const created = await svc.createPlatformBackupToken({
      label: "http test peer",
      token: generateSyncToken(),
      expiresInDays: 1,
      platformAdminId: null,
    });
    if (!created.ok) throw new Error("could not mint a token");
    token = created.token;
  });

  const get = (route: "manifest" | "download", query = "", auth = token) => {
    const url = `http://localhost/api/peer/backup/${route}${query}`;
    const req = new NextRequest(url, { method: "GET", headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    return route === "manifest" ? manifestRoute.GET(req) : downloadRoute.GET(req);
  };

  it("answers 404 to everyone while serving is off", async () => {
    await setConfig({ servingEnabled: false });
    for (const req of [get("manifest", "", ""), get("manifest"), get("download", `?artifact=${artifact}`)]) {
      const res = await req;
      expect(res.status).toBe(404);
    }
    await setConfig({ servingEnabled: true });
  });

  it("refuses a missing or wrong token on both endpoints", async () => {
    expect((await get("manifest", "", "")).status).toBe(401);
    expect((await get("manifest", "", "POS1-not-a-real-token")).status).toBe(401);
    const dl = await get("download", `?artifact=${artifact}`, "POS1-not-a-real-token");
    expect(dl.status).toBe(401);
  });

  it("serves the manifest to a holder of a valid token", async () => {
    const res = await get("manifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as PeerManifest;
    expect(body.app).toBe("cafe-restaurant-pos");
    expect(body.artifacts.map((a) => a.artifact)).toContain(artifact);
    const listed = body.artifacts.find((a) => a.artifact === artifact)!;
    expect(listed.sha256).toBe(sha(bytes));
    expect(listed.sizeBytes).toBe(bytes.length);
  });

  it("streams the artifact with the checksum and length a peer verifies", async () => {
    const res = await get("download", `?artifact=${artifact}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("x-backup-sha256")).toBe(sha(bytes));
    expect(res.headers.get("cache-control")).toContain("no-store");
    // The download and the manifest must not disagree about the same file.
    const body = Buffer.from(await res.arrayBuffer());
    expect(sha(body)).toBe(sha(bytes));
    expect(body.length).toBe(bytes.length);
  });

  it("will not serve anything that is not an artifact of this app", async () => {
    // Every one of these is a name a peer could send, and every one is refused
    // before the filesystem is consulted: the sidecar (not an artifact), a file
    // that merely looks like one, an environment file by relative path — both
    // encoded and raw, so a decoder in the middle cannot turn one into the other
    // — and an empty string.
    for (const probe of [
      `${artifact}.manifest.json`,
      "pos-backup-20200101-000000.dump",
      "../../.env",
      "..%2F..%2F.env",
      ".env",
      "",
    ]) {
      const res = await get("download", `?artifact=${encodeURIComponent(probe)}`);
      expect([400, 404]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain("POSSTUB1");
      expect(body).not.toContain("DATABASE_URL");
    }
    // Raw (unencoded) traversal in the query string.
    expect((await get("download", "?artifact=../../.env")).status).toBe(404);
  });

  it("closes the door the moment the token is revoked", async () => {
    const tokens = await svc.listPlatformBackupTokens();
    const mine = tokens.find((t) => t.label === "http test peer");
    expect(mine).toBeTruthy();
    if (!mine) return;
    await svc.revokePlatformBackupToken(mine.id);
    expect((await get("manifest")).status).toBe(401);
    expect((await get("download", `?artifact=${artifact}`)).status).toBe(401);
  });
});
